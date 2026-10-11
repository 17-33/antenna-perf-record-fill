#!/usr/bin/env node
'use strict';
/**
 * selftest.js —— 移植后自证（SKILL.md §12.4 的四个步骤，全自动）
 *
 * 用法: node tests/selftest.js [--keep]      （--keep 保留临时目录，便于排查）
 *
 * 覆盖:
 *   ① dump 一张已知表 → 列/行与 §2 对得上
 *   ② fill 值+标记 → verify 回读：值对 / 红字加粗 / 原填充色未被破坏 / 公式格未被写
 *   ③ clear 后只剩预置 + keep 格，模板表头/序号/频率仍在；内嵌图公式受保护
 *   ④ audit / zipcheck 在正常样本上 0 问题；在人为破坏样本上必须报错并返回非 0
 *
 * 退出码: 0 全绿；1 有失败项
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const makeSample = require('./make_sample');
const L = require('../scripts/_lib');

const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'antenna-selftest-'));

let pass = 0, fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const msg = fn();
    pass++;
    console.log('  ' + L.C.green('PASS') + '  ' + name + (msg ? L.C.dim('  — ' + msg) : ''));
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + e.message);
    console.log('  ' + L.C.red('FAIL') + '  ' + name);
    console.log('        ' + L.C.red(e.message.split('\n')[0]));
  }
}

function must(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)].concat(args), {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 解析 --json 模式的 stdout：必须**只取 stdout**（人读信息走 stderr，否则 JSON.parse 必炸） */
function runJson(script, args) {
  const r = run(script, args.concat(['--json']));
  must(r.stdout.trim(), script + ' --json 的 stdout 是空的（应只输出 JSON，人读信息走 stderr）');
  return JSON.parse(r.stdout);
}

/* ---------------------------------------------------------------- */

console.log(L.C.bold('【自证】信关站电性能记录表 skill · 工具链'));
console.log(L.C.dim('  临时目录 ' + TMP));
console.log(L.C.dim('  Node ' + process.version));
console.log('');

const SAMPLE = path.join(TMP, 'sample.xlsx');
const FILLED = path.join(TMP, 'filled.xlsx');
const CLEARED = path.join(TMP, 'cleared.xlsx');
const BROKEN_XML = path.join(TMP, 'broken-xml.xlsx');
const BROKEN_BIN = path.join(TMP, 'broken-bin.xlsx');
const SPEC = path.join(TMP, 'spec.json');
const KEEPJ = path.join(TMP, 'keep.json');

const built = makeSample.build();
fs.writeFileSync(SAMPLE, built.buf);
const EXP = built.expect;

/* ============ ① 样本自身完整性 ============ */
console.log(L.C.bold('① 样本与读取'));
check('zipcheck 通过合成样本', () => {
  const r = run('zipcheck.js', [SAMPLE]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  return '结构 + CRC32 + XML 良构全通过';
});
check('dump 能读出 5 张表且值正确', () => {
  const r = run('dump_xlsx.js', [SAMPLE, '--csv']);
  must(r.code === 0, '退出码 ' + r.code);
  for (const n of makeSample.SHEET_NAMES) must(r.out.includes(n), '未列出工作表 ' + n);
  must(/方向图,J5,0\.14146/.test(r.out), '方向图 J5 值未读到（期望 0.14146）');
  must(/方向图,T5,/.test(r.out), '方向图 T5 未读到');
  must(/跟踪精度,B4,120\.015/.test(r.out), '跟踪精度 B4 未读到');
  return '共享字符串 / 内联字符串 / 公式格三条路径均命中';
});
check('dump 能识别蓝底待填格', () => {
  const r = run('dump_xlsx.js', [SAMPLE, '方向图', '--detail']);
  must(r.code === 0, '退出码 ' + r.code);
  must(r.out.includes('FF00B0F0'), '未识别出蓝底 FF00B0F0');
  return '蓝底识别正常';
});
check('check_claims 与 §2 映射完全一致', () => {
  const r = run('check_claims.js', [SAMPLE]);
  must(r.code === 0, '退出码 ' + r.code);
  const hits = (r.out.match(/✅ 与文档完全一致/g) || []).length;
  must(hits === 4, '仅 ' + hits + '/4 张有频点列的表与 §2 一致\n' + r.out.slice(-1500));
  must(/跟踪精度[\s\S]{0,200}?跳过频点对齐/.test(r.out), '跟踪精度未走"无频点列"分支');
  must(!/⚠️ 与文档不一致/.test(r.out), '存在与文档不一致的表');
  const sheetMatch = r.out.split('▸ 方向图')[0];
  must(!/✗/.test(sheetMatch), '工作表匹配存在 ✗：\n' + sheetMatch);
  return '4 张频点表行序全对 + 跟踪精度正确识别为无频点列';
});

/* ============ ② 填值 + 标记 + 回读 ============ */
console.log('');
console.log(L.C.bold('② 填值 → 标记 → 回读'));
const spec = {
  sheet: '方向图',
  mark: ['D5', 'E5', 'J5'],
  values: { D5: -13.3, E5: -16.61, J5: 0.1415, R5: 999 },
  texts: { U2: '数据来源截图', U5: '37.5方位.jpg' },
  notes: [{ cell: 'A25', text: '批次1｜selftest｜源文件 37.5方位.jpg' }],
};
fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2));

check('fill_mark 写入成功且拒绝公式格', () => {
  const r = run('fill_mark.js', [SAMPLE, FILLED, SPEC]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/skipped\s+R5/.test(r.out), '未拒绝写入公式格 R5\n' + r.out);
  must(r.out.includes('完整性校验通过'), '输出未通过自校验');
  return '写入 5 格，公式格 R5 被拒';
});
check('verify_mark 回读：值 / 红字 / 加粗 / 蓝底保留', () => {
  const r = run('verify_mark.js', [FILLED, '方向图', 'D5', 'E5', 'J5', 'R5']);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  const wb = L.Workbook.load(FILLED);
  const d5 = wb.cell('方向图', 'D5');
  must(Math.abs(d5.value - (-13.3)) < 1e-9, 'D5 值不对：' + d5.value);
  must(d5.fontRgb === L.RED, 'D5 字体色不是 FFFF0000：' + d5.fontRgb);
  must(d5.bold === true, 'D5 未加粗');
  must(d5.fillRgb === L.BLUE, 'D5 原蓝底被破坏：' + d5.fillRgb);
  const r5 = wb.cell('方向图', 'R5');
  must(r5.isFormula, 'R5 公式被覆盖了');
  must(!/999/.test(r5.vRaw || ''), 'R5 被写入了 999');
  return 'D5 红字加粗+蓝底保留；R5 公式完好';
});
check('fill_mark 未破坏其他条目（媒体/主题逐字节一致）', () => {
  const a = L.readZip(fs.readFileSync(SAMPLE));
  const b = L.readZip(fs.readFileSync(FILLED));
  must(a.length === b.length, '条目数变化 ' + a.length + ' → ' + b.length);
  const changed = [];
  for (let i = 0; i < a.length; i++) {
    must(a[i].name === b[i].name, '条目顺序/名称变化 @' + i);
    if (!a[i].data.equals(b[i].data)) changed.push(a[i].name);
  }
  // workbook.xml 只在「写了数据格 → 置 fullCalcOnLoad」时被改，属预期
  must(changed.every(n => /sheet\d+\.xml$|styles\.xml$|xl\/workbook\.xml$/.test(n)),
    '被改动的条目超出预期：' + changed.join(', '));
  return '仅改动 ' + changed.join(', ');
});

/* ============ ③ 清空 + 内嵌图保护 ============ */
console.log('');
console.log(L.C.bold('③ 只保留图数据'));
fs.writeFileSync(KEEPJ, JSON.stringify({
  defaults: { keepRows: [1, 2, 3], keepCols: ['A', 'B', 'C'], keepTextInLabelCols: true },
  sheets: { '方向图': { keepRows: [1, 2, 3, 4], keepCols: ['A', 'B', 'C'] } },
}, null, 2));

check('clear_data 保留预置、清空数据、保护内嵌图', () => {
  const r = run('clear_data.js', [SAMPLE, CLEARED, KEEPJ]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/保护内嵌图/.test(r.out), '未识别并保护内嵌图公式\n' + r.out);
  const wb = L.Workbook.load(CLEARED);
  const aa1 = wb.cell('方向图', 'AA1');
  must(aa1 && aa1.isFormula, 'AA1 内嵌图公式被清掉了');
  const d5 = wb.cell('方向图', 'D5');
  must(d5 === null || d5.value === null || d5.value === '', 'D5 未被清空：' + (d5 && d5.value));
  const b1 = wb.cell('方向图', 'B1');
  must(b1 && b1.value === '频率/GHz', '表头 B1 被误清：' + (b1 && b1.value));
  const b5 = wb.cell('方向图', 'B5');
  must(b5 && Math.abs(b5.value - 37.5) < 1e-9, 'B5 频点标签被误清：' + (b5 && b5.value));
  const r5 = wb.cell('方向图', 'R5');
  must(r5 === null || !r5.isFormula, 'R5 公式应被清空（§9.11）');
  return 'AA1 公式保住；D5 清空；B5 频点与表头保留';
});
check('清空后 zipcheck 仍通过', () => {
  const r = run('zipcheck.js', [CLEARED]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  return '结构完好';
});

/* ============ ④ 公式复算与判定 ============ */
console.log('');
console.log(L.C.bold('④ 公式复算 + 合格性判定'));
check('analyze 复算出方向图增益并与表内一致', () => {
  const r = run('analyze.js', [SAMPLE]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/方向图[\s\S]*?5 37\.5[\s\S]*?一致 ✔/.test(r.out), '未复算出 T5 一致 ✔\n' + r.out.slice(0, 1500));
  return 'T5 = ' + EXP.calcT.toFixed(4) + ' 与表内一致';
});
check('analyze 判定 EIRP ≥ 69 dBW、G/T ≥ 25 dB/K', () => {
  const r = run('analyze.js', [SAMPLE]);
  const eirpOk = /合格 69\.4|合格 69\.[3-9]/.test(r.out);
  must(eirpOk, 'EIRP 未被判合格\n' + r.out.slice(0, 2500));
  must(/合格 2[5-9]\.|合格 2[6-9]/.test(r.out.slice(r.out.indexOf('▸ GT'))), 'G/T 未被判合格');
  return 'EIRP / G/T 均合格';
});
check('analyze 正确判定跟踪精度 δ ≤ 指标', () => {
  const r = run('analyze.js', [SAMPLE]);
  must(/跟踪精度[\s\S]*?合格 ✔/.test(r.out), '跟踪精度未判合格\n' + r.out.slice(-2500));
  return 'δ = ' + EXP.delta.toFixed(6) + '° ≤ 指标 ' + EXP.limit.toFixed(6) + '°';
});

/* ============ ⑤ diff / audit ============ */
console.log('');
console.log(L.C.bold('⑤ diff 与全表复检'));
check('diff_sheets 抓到值变化并以非 0 退出', () => {
  const r = run('diff_sheets.js', [SAMPLE, FILLED, '方向图']);
  must(r.code === 1, '存在值不同却退出码 ' + r.code);
  must(/值不同 = [1-9]/.test(r.out), '未报出值不同\n' + r.out);
  return '抓到 D5/E5/J5 等改动';
});
check('audit 在带豁免时问题归零', () => {
  const r = run('audit.js', [FILLED, SAMPLE, '--exempt=方向图!U2,方向图!U5,方向图!A25']);
  must(/问题 0 项 ✅/.test(r.out), '未归零\n' + r.out);
  return '漏标/错标/值不一致 全为无';
});
check('audit 能抓出"改值不留痕"（去掉豁免后必须报错）', () => {
  const r = run('audit.js', [FILLED, SAMPLE]);
  must(r.code === 1, '应报错却退出码 ' + r.code + '\n' + r.out);
  must(/问题 [1-9]\d* 项/.test(r.out), '未报出问题');
  return '未标红的 U2/U5/A25 被判定为漏标';
});

/* ============ ⑥ 反向测试：工具必须真的在校验 ============ */
console.log('');
console.log(L.C.bold('⑥ 反向测试（故意破坏，必须报错）'));
check('翻转一个字节 → zipcheck 报错并非 0 退出', () => {
  const buf = Buffer.from(fs.readFileSync(SAMPLE));
  const at = Math.floor(buf.length / 2);
  buf[at] = buf[at] ^ 0xFF;
  fs.writeFileSync(BROKEN_BIN, buf);
  const r = run('zipcheck.js', [BROKEN_BIN]);
  must(r.code === 1, '破坏样本未被发现，退出码 ' + r.code + '\n' + r.out);
  must(/问题|CRC32 不符|不良构|结构不可读/.test(r.out), '未给出具体问题');
  return '被拦下';
});
check('删掉 XML 闭标签 → zipcheck 报"XML 不良构"', () => {
  const wb = L.Workbook.load(SAMPLE);
  const xml = wb.getXml('方向图').replace('</sheetData>', '');
  wb.setXml('方向图', xml);
  wb.save(BROKEN_XML);           // 重打包，CRC 会被重算 → 只剩 XML 良构这一关能抓
  const r = run('zipcheck.js', [BROKEN_XML]);
  must(r.code === 1, '未发现不良构，退出码 ' + r.code + '\n' + r.out);
  must(/不良构/.test(r.out), '未报出"不良构"：\n' + r.out);
  return '被拦下（CRC 正确也没放过）';
});
check('verify_mark 对"标红却空"报异常并非 0 退出', () => {
  const wb = L.Workbook.load(SAMPLE);
  wb.markCell('方向图', 'D9');   // D9 原本是空蓝底格
  const p = path.join(TMP, 'badmark.xlsx');
  wb.save(p);
  const r = run('verify_mark.js', [p, '方向图', 'D9']);
  must(r.code === 1, '未报异常，退出码 ' + r.code + '\n' + r.out);
  return '被拦下';
});
check('fill_mark 对不存在的表名报错并非 0 退出', () => {
  const badSpec = path.join(TMP, 'bad.json');
  fs.writeFileSync(badSpec, JSON.stringify({ sheet: '不存在的表', values: { A1: 1 } }));
  const r = run('fill_mark.js', [SAMPLE, path.join(TMP, 'x.xlsx'), badSpec]);
  must(r.code === 1, '应失败却退出码 ' + r.code);
  return '被拦下';
});
check('BOM / UTF-16 的 spec.json 也能读', () => {
  const withBom = path.join(TMP, 'spec-bom.json');
  fs.writeFileSync(withBom, '\uFEFF' + JSON.stringify({ sheet: '方向图', values: { D6: 1.5 }, mark: ['D6'] }));
  const out = path.join(TMP, 'bom-out.xlsx');
  const r = run('fill_mark.js', [SAMPLE, out, withBom]);
  must(r.code === 0, 'BOM 样例失败：\n' + r.out);
  const utf16 = path.join(TMP, 'spec-u16.json');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify({ sheet: '方向图', values: { D7: 2.5 } }), 'utf16le')]));
  const r2 = run('fill_mark.js', [SAMPLE, path.join(TMP, 'u16-out.xlsx'), utf16]);
  must(r2.code === 0, 'UTF-16 样例失败：\n' + r2.out);
  return 'UTF-8 BOM 与 UTF-16LE 均可';
});

/* ============ ⑦ 合并区影子格 & 坏输入（2026-10-02 新增） ============ */
console.log('');
console.log(L.C.bold('⑦ 合并区影子格与坏输入'));

check('shadowRefs 认出样表合并区（EIRP G5:G11 / GT F5:F11，锚点不误列）', () => {
  const wb = L.Workbook.load(SAMPLE);
  const se = wb.shadowRefs(wb.resolveSheetByKey('eirp'));
  const sg = wb.shadowRefs(wb.resolveSheetByKey('gt'));
  must(se.size === 7, 'EIRP 影子格 ' + se.size + ' 个：' + [...se].join(','));
  must(sg.size === 7, 'GT 影子格 ' + sg.size + ' 个：' + [...sg].join(','));
  must(!se.has('G4') && !sg.has('F4'), '锚点被误当成影子格');
  must(wb.shadowRefs(wb.resolveSheetByKey('pattern')).size === 0, '方向图无合并区，应为 0');
  return 'EIRP 7 + GT 7，锚点未误列';
});

check('dump_xlsx 的蓝底口径区分「真·待填」与「合并影子格」', () => {
  const r = run('dump_xlsx.js', [SAMPLE]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/真·待填 0 ｜ 合并区影子格（非待填）7/.test(r.out),
    '未见影子格口径行：\n' + r.out);
  return '影子格单列，不再计入待填';
});

check('fill_mark 拒绝写入合并区影子格（且不落值）', () => {
  const spec = path.join(TMP, 'shadow.json');
  fs.writeFileSync(spec, JSON.stringify({ sheet: 'EIRP', values: { G5: 123.456 } }));
  const out = path.join(TMP, 'shadow-out.xlsx');
  const r = run('fill_mark.js', [SAMPLE, out, spec]);
  must(r.code === 0, '不应整体失败，退出码 ' + r.code + '\n' + r.out);
  must(/合并区影子格/.test(r.out), '未提示影子格：\n' + r.out);
  must(/跳过 1/.test(r.out), '未计入跳过计数：\n' + r.out);
  const wb = L.Workbook.load(out);
  const c = wb.cell('EIRP', 'G5');
  must(!c || c.value == null || c.value === '', '值竟然被写进去了');
  return '被拒、退出码仍 0、值未落';
});

check('allowShadow: true 可强行写入（逃生阀）', () => {
  const spec = path.join(TMP, 'shadow2.json');
  fs.writeFileSync(spec, JSON.stringify({ sheet: 'EIRP', allowShadow: true, values: { G5: 123.456 } }));
  const out = path.join(TMP, 'shadow2-out.xlsx');
  const r = run('fill_mark.js', [SAMPLE, out, spec]);
  must(r.code === 0 && /数值 1/.test(r.out), '逃生阀未生效：\n' + r.out);
  const wb = L.Workbook.load(out);
  must(Number(wb.cell('EIRP', 'G5').value) === 123.456, '值未写入');
  return '已放行并落值';
});

check('坏输入（.xls / 非 xlsx）友好报错、退出码 1、无裸栈', () => {
  const xls = path.join(TMP, 'fake.xls');
  fs.writeFileSync(xls, Buffer.concat([
    Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.from('ole2 body')]));
  const r = run('dump_xlsx.js', [xls]);
  must(r.code === 1, '退出码 ' + r.code + '\n' + r.out);
  must(/\.xls/.test(r.out) && /\.xlsx/.test(r.out), '未给出可操作提示：\n' + r.out);
  must(!/\n\s+at /.test(r.out), '仍在打印裸栈：\n' + r.out);

  const junk = path.join(TMP, 'junk.xlsx');
  fs.writeFileSync(junk, 'not a zip at all');
  const r2 = run('dump_xlsx.js', [junk]);
  must(r2.code === 1 && /另存为/.test(r2.out), '非 ZIP 未友好报错：\n' + r2.out);
  return '两种坏输入均给出「另存为 .xlsx」指引';
});

check('写数据格后自动置 fullCalcOnLoad（公式缓存不残留旧值）', () => {
  const spec = path.join(TMP, 'recalc.json');
  // 写一个被公式引用的入参格
  fs.writeFileSync(spec, JSON.stringify({ sheet: '方向图', values: { Q5: 0.29999 } }));
  const out = path.join(TMP, 'recalc-out.xlsx');
  const r = run('fill_mark.js', [SAMPLE, out, spec]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/fullCalcOnLoad/.test(r.out), '未提示已置 fullCalcOnLoad：\n' + r.out);

  const wb = L.Workbook.load(out);
  const xml = wb.map.get('xl/workbook.xml').data.toString('utf8');
  must(/<calcPr\b[^>]*fullCalcOnLoad="1"/.test(xml), 'calcPr 未置位：\n' + /<calcPr[^>]*>/.exec(xml));

  // 只写文本/日志时不该动 calcPr
  const spec2 = path.join(TMP, 'noteonly.json');
  fs.writeFileSync(spec2, JSON.stringify({ sheet: '方向图', texts: { U2: '来源' } }));
  const out2 = path.join(TMP, 'noteonly-out.xlsx');
  run('fill_mark.js', [SAMPLE, out2, spec2]);
  const xml2 = L.Workbook.load(out2).map.get('xl/workbook.xml').data.toString('utf8');
  must(!/fullCalcOnLoad/.test(xml2), '未写数据格却置了 fullCalcOnLoad');

  // --no-recalc 可关闭
  const out3 = path.join(TMP, 'recalc-off.xlsx');
  run('fill_mark.js', [SAMPLE, out3, spec, '--no-recalc']);
  const xml3 = L.Workbook.load(out3).map.get('xl/workbook.xml').data.toString('utf8');
  must(!/fullCalcOnLoad/.test(xml3), '--no-recalc 未生效');
  return '写值→置位；只写文本→不置位；--no-recalc 可关';
});

check('analyze 在 fullCalcOnLoad 工作簿上提示「缓存可能过期」', () => {
  const out = path.join(TMP, 'recalc-out.xlsx');
  const r = run('analyze.js', [out]);
  must(/已置 fullCalcOnLoad/.test(r.out) && /缓存可能过期/.test(r.out),
    '未给出缓存过期提示：\n' + r.out.slice(0, 600));
  return '避免把「缓存过期」误读成「填错了」';
});

check('merge_judge 把「补充遍」的 marker 并集补入终值（§17.6）', () => {
  const base = path.join(TMP, 'mj-base.json');
  const supp = path.join(TMP, 'mj-supp.json');
  const out = path.join(TMP, 'mj-out.json');
  const mk = (mks) => ({ results: [{ rf: 38, row: 7, name: '38俯仰.jpg', mks }] });
  const M = (type, kind, side, x, yv) => ({ type, kind, side, x, xs: [String(x)], xMs: false, yv, delta: yv });
  // 底稿：像 read_spectrum 一样丢掉了 D4 / D7
  fs.writeFileSync(base, JSON.stringify(mk([
    M('M1', 'main', 'C', 9.62, -13.79), M('D2', 'sidelobe', 'neg', -4.3286, -16.19),
  ])));
  // 补充遍：有 D4 / D7
  fs.writeFileSync(supp, JSON.stringify(mk([
    M('M1', 'main', 'C', 9.62, -13.79), M('D2', 'sidelobe', 'neg', -4.3286, -16.19),
    M('D4', '3dB', 'neg', -1.4088, -3.04), M('D7', '10dB', 'pos', 2.2774, -10.01),
  ])));

  const r = run('merge_judge.js', [base, supp, out]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/补入 marker 2 个/.test(r.out), '补入计数不对：\n' + r.out);

  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const types = j.results[0].mks.map((m) => m.type);
  must(types.join(',') === 'M1,D2,D4,D7', 'marker 顺序/并集不对：' + types.join(','));

  // --help 与缺参
  const h = run('merge_judge.js', ['--help']);
  must(h.code === 0 && /用法/.test(h.out), '--help 未给用法：\n' + h.out);
  const bad = run('merge_judge.js', []);
  must(bad.code === 1 && /用法/.test(bad.out), '缺参未报错：\n' + bad.out);
  return '并集 + 自然序 + --help/缺参均可';
});

check('merge_judge 的 --manual 补丁：已存在则不覆盖、缺 note 要警告', () => {
  const base = path.join(TMP, 'mj-base.json');
  const supp = path.join(TMP, 'mj-supp.json');
  const out = path.join(TMP, 'mj-man.json');
  const patch = path.join(TMP, 'mj-patch.json');
  fs.writeFileSync(patch, JSON.stringify({
    overrides: [
      // D2 已存在 → 跳过；无 note → 警告
      { name: '38俯仰.jpg', type: 'D2', kind: 'sidelobe', side: 'neg', x: 9.9, yv: -99 },
      // D6 不存在 → 补入
      { name: '38俯仰.jpg', type: 'D6', kind: '10dB', side: 'neg', x: -2.3253, yv: -10.03, note: 'OCR 两遍均读出' },
    ],
  }));
  const r = run('merge_judge.js', [base, supp, out, '--manual=' + patch]);
  must(r.code === 0, '退出码 ' + r.code + '\n' + r.out);
  must(/已有 D2，跳过/.test(r.out), '重复项未跳过：\n' + r.out);
  must(/未写 note/.test(r.out), '缺 note 未警告：\n' + r.out);
  must(/人工定论补入 1 个/.test(r.out), '补丁计数不对：\n' + r.out);

  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const m = j.results[0].mks;
  const d2 = m.find((x) => x.type === 'D2');
  const d6 = m.find((x) => x.type === 'D6');
  must(Number(d2.x) === -4.3286, 'D2 被补丁覆盖了：' + d2.x);
  must(d6 && d6.manual === true && /OCR/.test(d6.note), 'D6 未带 manual/note：' + JSON.stringify(d6));
  return '重复项不覆盖；补丁项留 manual+note 凭据';
});

/* ---------------------------------------------------------------- */
/* ⑧ 压缩包「完整目录结构」：编码 / 分隔符 / 补层 / 逃逸 / 大小写 / ZIP64 */

console.log('');
console.log(L.C.bold('⑧ 压缩包目录结构（unpack_zip + _lib.readZip）'));

const FIX = require('./zip_fixture');
const UZ = require('../scripts/unpack_zip');

check('zip：无 UTF-8 标志位的 GBK 条目名正确解码（不按 UTF-8 猜）', () => {
  // 整条路径都必须编码成 GBK 字节，否则就不是"无标志位的 GBK 包"了
  const name = FIX.gbkPath(['架标测试', '/', '接收', '/38', '俯仰', '.jpg']);
  const es = L.readZip(FIX.buildZip([{ name, data: 'x', flags: 0 }]));
  must(es.length === 1, '条目数不对');
  must(es[0].nameEnc === 'gbk', '未识别为 gbk，实为 ' + es[0].nameEnc);
  must(es[0].name === '架标测试/接收/38俯仰.jpg', 'GBK 解码错误：' + JSON.stringify(es[0].name));
  return 'utf8 标志位缺失 → GBK 回退，中文层级完整还原';
});

check('zip：置 UTF-8 标志位时严格按 UTF-8 解，不回退 GBK', () => {
  const name = Buffer.from(FIX.GBK['测试'], 'hex');
  const es = L.readZip(FIX.buildZip([{ name, data: 'x', flags: 0x0800 }]));
  must(es[0].nameEnc === 'utf8', '编码判定错：' + es[0].nameEnc);
  must(es[0].name !== '测试', '标志位置位时不该解成「测试」——那说明发生了 GBK 猜测');
  return '标志位为唯一判据，两条解码路径互不干扰';
});

check('zip：反斜杠分隔符被归一化，层级不被压平', () => {
  const es = L.readZip(FIX.buildZip([
    { name: 'A\\B\\c.jpg', data: '1' },
    { name: 'A\\B\\d.jpg', data: '2' },
  ]));
  const t = UZ.buildTree(es);
  must(t.sepFixedCount === 2, '反斜杠条目数不对：' + t.sepFixedCount);
  must(t.fileCount === 2, '文件数不对：' + t.fileCount);
  const tops = [...t.root.dirs.keys()];
  must(tops.length === 1 && tops[0] === 'A', '顶层目录应为 A，实为 ' + JSON.stringify(tops));
  const b = t.root.dirs.get('A').dirs.get('B');
  must(b && b.files.length === 2, 'A/B 下应有 2 个文件（被压平时这里会为空）');
  return 'A\\B\\c.jpg → A/B/c.jpg，深层不丢';
});

check('zip：无显式目录条目时由路径补层', () => {
  const t = UZ.buildTree(L.readZip(FIX.buildZip([{ name: 'a/b/c/1.jpg', data: 'x' }])));
  must(t.dirCount === 0, '本夹具不应有显式目录条目');
  must(t.synthesizedDirs.slice().sort().join(',') === 'a,a/b,a/b/c',
    '补层目录不对：' + JSON.stringify(t.synthesizedDirs));
  return '缺目录条目也能还原 3 级目录，提取时自动建';
});

check('zip：../ 路径穿越被标 error 且不进入落盘计划', () => {
  const es = L.readZip(FIX.buildZip([
    { name: 'ok/1.jpg', data: 'x' },
    { name: '../evil.txt', data: 'x' },
  ]));
  const errs = UZ.buildTree(es).issues.filter((i) => i.level === 'error');
  must(errs.length === 1 && errs[0].type === 'traversal', '未拦下穿越：' + JSON.stringify(errs));
  const plan = UZ.planExtract(es);
  must(plan.files.length === 1 && plan.files[0].rel === 'ok/1.jpg', '穿越条目进了落盘计划');
  return '穿越条目被剔除，正常文件不受影响';
});

check('zip：仅大小写不同的同名路径被标 error（macOS 会静默覆盖）', () => {
  const t = UZ.buildTree(L.readZip(FIX.buildZip([
    { name: 'A/x.jpg', data: '1' },
    { name: 'a/x.jpg', data: '2' },
  ])));
  const errs = t.issues.filter((i) => i.type === 'case-collision');
  must(errs.length === 1, '未检出大小写冲突：' + JSON.stringify(t.issues));
  return '避免后写覆盖先写造成静默丢文件';
});

check('zip：ZIP64 条目扩展字段 + ZIP64 EOCD 均能解析', () => {
  const big = Buffer.alloc(70000, 7);
  const es = L.readZip(FIX.buildZip([
    { name: 'p/小.jpg', data: 'ok' },
    { name: 'p/大.jpg', data: big, zip64: true },
  ], { zip64: true }));
  must(es.length === 2, '条目数不对：' + es.length);
  must(es[1].zip64 === true, 'zip64 标记未置');
  must(es[1].usize === 70000, '未从 0x0001 扩展字段取到 usize：' + es[1].usize);
  must(es[1].data.length === 70000 && es[1].data[69999] === 7, 'ZIP64 数据不完整');
  return '不再「暂不支持 ZIP64」直接抛错';
});

check('unpack_zip：提取后集合/大小/CRC32 与中央目录一致（含空目录），反向也灵', () => {
  const z = FIX.buildZip([
    { name: 'X/', data: '' },            // 空目录：只解文件的工具会丢掉它
    { name: 'X/sub/a.jpg', data: 'aaa' },
    { name: 'X/sub/b.jpg', data: 'bbbb' },
  ]);
  const f = path.join(TMP, 'unz.zip');
  fs.writeFileSync(f, z);
  const outdir = path.join(TMP, 'unz-out');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'unpack_zip.js'), f, outdir], { encoding: 'utf8' });
  must(r.status === 0, '退出码应为 0，实为 ' + r.status + '\n' + r.stdout + r.stderr);
  must(/逐文件回验全部通过/.test(r.stdout), '未见回验通过：\n' + r.stdout);
  must(fs.existsSync(path.join(outdir, 'X')), '空目录 X/ 被丢了');
  must(fs.readFileSync(path.join(outdir, 'X/sub/b.jpg'), 'utf8') === 'bbbb', '文件内容不对');

  const entries = L.readZip(z);
  const v1 = UZ.verifyExtraction(outdir, entries);
  must(v1.ok, '初始回验应通过：' + JSON.stringify(v1.problems));

  fs.writeFileSync(path.join(outdir, 'X/sub/a.jpg'), 'XXX'); // 同长度 → 只有 CRC 会变
  const v2 = UZ.verifyExtraction(outdir, entries);
  must(!v2.ok && v2.problems.some((p) => p.type === 'crc' && /a\.jpg$/.test(p.rel)),
    '同长度改坏应被 CRC 抓出：' + JSON.stringify(v2.problems));

  fs.writeFileSync(path.join(outdir, 'X/sub/stray.txt'), 'z');
  const v3 = UZ.verifyExtraction(outdir, entries);
  must(v3.problems.some((p) => p.type === 'extra'), '多出的文件应被检出：' + JSON.stringify(v3.problems));
  return '集合/大小/CRC 三路回验，正反都灵';
});

/* ═══════════════════════ ⑨ 开单/归档/判读编排（new_case + ingest + make_spec + judge_batch） ═══════════════════════ */
console.log(L.C.bold('⑨ 一键开单 → 收图归档 → 判读 → spec（new_case / ingest / judge_batch / make_spec）'));

const CASE_DIR = path.join(TMP, 'nc');
const NC_INBOX = path.join(CASE_DIR, '99号机', '截图', '_待归档');
const NC_SHOT = path.join(CASE_DIR, '99号机', '截图');
const NC_BLANK = path.join(CASE_DIR, '99号机', '一体化信关站电性能检测记录表.xlsx');

check('new_case：--help 打印用法且退出码 0；缺 --machine 退出码 2', () => {
  const h = run('new_case.js', ['--help']);
  must(h.code === 0, '退出码应 0，实为 ' + h.code);
  must(/--machine/.test(h.out) && /--template/.test(h.out), '用法里应含 --machine 与 --template');
  const bad = run('new_case.js', ['--root=/tmp/x']);
  must(bad.code === 2, '缺 --machine 应退出码 2，实为 ' + bad.code);
  return '用法自解释 + 参数校验';
});

check('new_case：--dry-run 不落盘', () => {
  const r = run('new_case.js', ['--machine=99', '--root=' + CASE_DIR, '--dry-run']);
  must(r.code === 0, '退出码应 0，实为 ' + r.code);
  must(!fs.existsSync(path.join(CASE_DIR, '99号机')), 'dry-run 竟创建了目录');
  return '无副作用';
});

check('new_case：建全套目录骨架 + 4 份文档', () => {
  const r = run('new_case.js', ['--machine=99', '--root=' + CASE_DIR]);
  must(r.code === 0, '退出码应 0，实为 ' + r.code + '\n' + r.out);
  for (const d of ['截图/架标测试/接收', '截图/架标测试/发射', '截图/跟踪精度',
    '截图/接收链路标定/LNB到频谱仪', '截图/接收链路标定/LNB到测控基带XS05',
    '截图/接收链路标定/LNB到地基基站IN1', '截图/接收链路标定/LNB到地基基站IN2',
    '截图/EIRP', '截图/_待归档', '报告/ocr', '批次/原件字节留档', '批次/判读', '批次/spec']) {
    must(fs.existsSync(path.join(CASE_DIR, '99号机', d)), '缺目录 ' + d);
  }
  for (const f of ['填写协议.md', '说明.md', '截图/截图清单.md', '批次/keep_99_blank.json', '批次/审计豁免.json']) {
    must(fs.existsSync(path.join(CASE_DIR, '99号机', f)), '缺文件 ' + f);
  }
  return '16 目录 + 5 文档';
});

check('new_case：填写协议含 32 槽位与 16 频点（TX 8 + RX 8）', () => {
  const md = fs.readFileSync(path.join(CASE_DIR, '99号机', '填写协议.md'), 'utf8');
  for (const f of ['47.2', '49.8', '37.5', '40.05']) must(md.includes(f), '协议缺频点 ' + f);
  // 32 行槽位（| n | TX/RX | …）
  const slots = (md.match(/^\| \d+ \| (TX|RX) \|/gm) || []).length;
  must(slots === 32, '槽位数应 32，实为 ' + slots);
  must(md.includes('落行 13') || md.includes('13 / 14'), '协议未给 TX 落行');
  must(/34\.5/.test(md), '协议未写本振换算');
  return '32 槽位 + CF 自校验 + 落行';
});

check('new_case：keep.json 的 defaults.keepCols 必须是空数组（§18.2.1 踩过的坑）', () => {
  const k = JSON.parse(fs.readFileSync(path.join(CASE_DIR, '99号机', '批次', 'keep_99_blank.json'), 'utf8'));
  must(Array.isArray(k.defaults.keepCols) && k.defaults.keepCols.length === 0,
    'keepCols 必须为空数组，实为 ' + JSON.stringify(k.defaults.keepCols));
  // 前向链路 B/C/D/E 是无底色输入格，必须被 keep 显式罩住
  must((k.sheets['前向链路（接收）标定'].keep || []).includes('B1:E2'),
    '前向链路输入区未被 keep 罩住 → 清空时会漏清');
  return '防漏清';
});

check('new_case：审计豁免按【整列】豁免、不给行号上限（§16.5.1 踩过的坑）', () => {
  const e = JSON.parse(fs.readFileSync(path.join(CASE_DIR, '99号机', '批次', '审计豁免.json'), 'utf8'));
  must(/U1:U1048576/.test(e['方向图'][0]),
    '方向图来源列应整列豁免，实为 ' + e['方向图'][0]);
  // 逐个 sheet 检查：来源列豁免必须以 1048576 结尾（= 整列）
  for (const [sheet, ranges] of Object.entries(e)) {
    if (sheet.startsWith('_')) continue;
    must(ranges.some(r => /1048576$/.test(r)), sheet + ' 的来源列未整列豁免');
  }
  return '5 表全整列豁免';
});

check('new_case：--template 造出的待填空表是干净的、且清空结果确定', () => {
  const r = run('new_case.js', ['--machine=88', '--root=' + CASE_DIR, '--template=' + SAMPLE, '--dry-run']);
  must(r.code === 0, 'dry-run 应 0，实为 ' + r.code);
  const r2 = run('new_case.js', ['--machine=88', '--root=' + CASE_DIR, '--template=' + SAMPLE]);
  must(r2.code === 0, '退出码应 0，实为 ' + r2.code + '\n' + r2.out);
  const blank = path.join(CASE_DIR, '88号机', '一体化信关站电性能检测记录表.xlsx');
  must(fs.existsSync(blank), '未生成待填空表');
  // 原件留档必须在，且与源文件字节一致（永不改原始文件）
  const arch = path.join(CASE_DIR, '88号机', '批次', '原件字节留档', '公司下发原件_未改动.xlsx');
  must(fs.existsSync(arch), '未留原件副本');
  must(L.sha256File(arch) === L.sha256File(SAMPLE), '留档副本与原件字节不一致');
  must(fs.existsSync(arch + '.sha256'), '未写 .sha256');
  // 二次开单到另一目录，哈希应相同（清空流水线确定性，§18.2）
  run('new_case.js', ['--machine=88', '--root=' + path.join(TMP, 'nc2'), '--template=' + SAMPLE]);
  const blank2 = path.join(TMP, 'nc2', '88号机', '一体化信关站电性能检测记录表.xlsx');
  must(fs.existsSync(blank2) && L.sha256File(blank2) === L.sha256File(blank),
    '清空结果不确定：同输入两次 SHA 不同');
  // 空表里不该残留测量数据：dump 出的待填数应等于蓝底数
  const d = run('dump_xlsx.js', [blank, '方向图']);
  must(/蓝底格 224 ｜ 真·待填 224/.test(d.out), '空表待填统计异常：' + d.out.split('\n').slice(0, 8).join(' / '));
  return '原件零改动 + 哈希恒定 + 224 蓝底全待填';
});

check('new_case：目录已存在时拒绝（退出码 3），--force 才重建并备份', () => {
  const again = run('new_case.js', ['--machine=99', '--root=' + CASE_DIR]);
  must(again.code === 3, '重开应退出码 3，实为 ' + again.code);
  must(/--force/.test(again.out), '未提示 --force');
  // --force 不应丢数据：原目录被备份到 ROOT 下的同级
  // ⚠️ 不能放进 CASE 自己的子目录（fs.renameSync 会 EINVAL）—— 这条断言就是守它
  const f = run('new_case.js', ['--machine=99', '--root=' + CASE_DIR, '--force']);
  must(f.code === 0, '--force 应成功，实为 ' + f.code + '\n' + f.out);
  const bk = fs.readdirSync(CASE_DIR).find(n => n.startsWith('99号机_已存在_'));
  must(bk, '--force 未在同级目录留下备份：' + fs.readdirSync(CASE_DIR).join(', '));
  must(fs.existsSync(path.join(CASE_DIR, bk, '填写协议.md')), '备份内容不完整');
  return '拒绝重开 + force 备份到同级';
});

check('ingest：收件箱为空时友好提示、退出码 0', () => {
  const r = run('ingest.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  must(r.code === 0, '空收件箱应退出 0，实为 ' + r.code);
  must(/收件箱是空的/.test(r.out), '未给友好提示');
  return '不报错';
});

check('ingest：缺 --case / 收件箱不存在 → 退出码 2 且提示怎么建目录', () => {
  const a = run('ingest.js', []);
  must(a.code === 2, '缺 --case 应 2，实为 ' + a.code);
  const b = run('ingest.js', ['--case=' + path.join(CASE_DIR, '99号机'), '--from=/tmp/绝对不存在的目录xyz']);
  must(b.code === 2, '收件箱不存在应 2，实为 ' + b.code);
  must(/new_case/.test(b.out), '未提示先跑 new_case');
  return '参数错误可行动';
});

check('ingest --json：stdout 纯净（人读信息走 stderr）、且默认不落盘', () => {
  const j = runJson('ingest.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  must(Array.isArray(j.plans), 'plans 应是数组');
  must(j.applied === false, '默认 applied 应为 false');
  must(typeof j.counts === 'object', '缺 counts');
  return '机器可读契约 + stdout 无污染';
});

/* --- ingest 的分类逻辑：不依赖真实图片也能测的部分 --- */
check('ingest：频点必须按频点表反查，`IMG_0008` 不能被读成频点 8', () => {
  // 走 --json 拿到 plans；用不存在的图名不行，故直接验证 freqOf 的行为：
  // 造一张同名不同内容的图，检查它被归 pending 且理由指向「读不到频点」而不是「频点 8」
  fs.mkdirSync(NC_INBOX, { recursive: true });
  fs.writeFileSync(path.join(NC_INBOX, 'IMG_0008.png'), 'not-a-real-png');
  const j = runJson('ingest.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  const it = j.plans.find(p => /IMG_0008/.test(p.src || ''));
  must(it, '未处理 IMG_0008');
  must(!/频点 8\b/.test(it.note || ''), '把文件名 0008 误当频点：' + it.note);
  return '不盲取文件名数字';
});

check('ingest：切面判不出来 → 停在「待人工确认」而非猜测落位（§0.6 弃权规则）', () => {
  const j0 = runJson('ingest.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  for (const p of j0.plans) {
    if (p.status === 'pending' && /切面/.test(p.note || '')) {
      must(p.dest && /_待人工确认/.test(p.dest), '待确认项应落 _待人工确认/，实为 ' + p.dest);
      must(!p.cells, '待确认项不得带落格信息（会诱发硬填）');
      return '不猜、不给格';
    }
  }
  return '（本批无待确认项）';
});

/* --- make_spec 的类型归一：这是会导致公式静默失效的真 bug，必须锁住 --- */
check('make_spec：字符串型数值必须转成 number（否则公式链静默失效）', () => {
  const judge = path.join(TMP, 'judge_str.json');
  fs.writeFileSync(judge, JSON.stringify({
    results: [{
      name: '47.2方位.jpg', orient: 'az', dirName: '发射', row: 13, rf: 47.2,
      cells: {
        D: { value: -29.23 }, E: { value: -15.98 }, F: { value: -17.56 },
        J: { value: '0.11425' },   // ← read_spectrum 的角度列就是字符串
        K: { value: '0.11463' }, L: { value: '0.18958' }, M: { value: '0.19613' },
      },
      issues: [], mks: [],
    }],
  }));
  const out = path.join(TMP, 'spec_str.json');
  const r = run('make_spec.js', ['--judge=' + judge, '--out=' + out, '--batch=T']);
  must(r.code === 0, '退出码应 0，实为 ' + r.code + '\n' + r.out);
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const k of Object.keys(s.values)) {
    must(typeof s.values[k] === 'number',
      k + ' 仍是 ' + typeof s.values[k] + '（' + JSON.stringify(s.values[k]) + '）→ 写进 xlsx 会成文本格，公式全部失效');
  }
  must(s.values.J13 === 0.11425, 'J13 值错：' + s.values.J13);
  return '7 格全为 number';
});

check('make_spec：频点重复（两张图写同一行）→ 跳过后来的，不静默覆盖', () => {
  const judge = path.join(TMP, 'judge_dup.json');
  const cell = { D: { value: -1 }, E: { value: -2 }, F: { value: -3 }, J: { value: 0.1 }, K: { value: 0.1 }, L: { value: 0.2 }, M: { value: 0.2 } };
  fs.writeFileSync(judge, JSON.stringify({
    results: [
      { name: 'a.jpg', orient: 'az', dirName: '发射', row: 13, cells: cell, issues: [] },
      { name: 'b.jpg', orient: 'az', dirName: '发射', row: 13, cells: cell, issues: [] },
    ],
  }));
  const out = path.join(TMP, 'spec_dup.json');
  const r = run('make_spec.js', ['--judge=' + judge, '--out=' + out]);
  must(/须人裁决/.test(r.out), '未报「须人裁决」：\n' + r.out);
  must(/跳过 1 张/.test(r.out), '未跳过重复项');
  return '不静默覆盖';
});

check('make_spec：切面冲突（plan 说方位 / 判读说俯仰）→ 该张被拒写，其他张照写', () => {
  const judge = path.join(TMP, 'judge_pc.json');
  const cellAz = { D: { value: -1 }, E: { value: -2 }, F: { value: -3 }, J: { value: 0.1 }, K: { value: 0.1 }, L: { value: 0.2 }, M: { value: 0.2 } };
  const cellEl = { G: { value: -1 }, H: { value: -2 }, I: { value: -3 }, N: { value: 0.1 }, O: { value: 0.1 }, P: { value: 0.2 }, Q: { value: 0.2 } };
  fs.writeFileSync(judge, JSON.stringify({
    results: [
      // 判读说是俯仰（el），而 plan 说方位 → 证据冲突
      { name: '47.2俯仰.jpg', orient: 'el', dirName: '发射', row: 13, cells: cellEl, issues: [] },
      // 另一张无冲突，用于验证「冲突只影响该张、不牵连其他」
      { name: '48方位.jpg', orient: 'az', dirName: '发射', row: 14, cells: cellAz, issues: [] },
    ],
  }));
  const plan = path.join(TMP, 'plan_pc.json');
  fs.writeFileSync(plan, JSON.stringify({
    plans: [{ src: '/x/47.2俯仰.jpg', status: 'ok', row: 13, plane: 'az' }],
  }));
  const out = path.join(TMP, 'spec_pc.json');
  const r = run('make_spec.js', ['--judge=' + judge, '--plan=' + plan, '--out=' + out]);
  must(/切面冲突/.test(r.out), '未检出切面冲突：\n' + r.out);
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  must(!Object.keys(s.values).some(k => k.endsWith('13')), '冲突那张（行13）仍被写入：' + JSON.stringify(s.values));
  must(Object.keys(s.values).some(k => k.endsWith('14')), '无冲突那张（行14）被误伤');
  return '逐张隔离，证据冲突交人裁决';
});

check('make_spec：一格都没写出来时拒绝出文件（防「空 spec 伪装成成功」）', () => {
  const judge = path.join(TMP, 'judge_allbad.json');
  fs.writeFileSync(judge, JSON.stringify({
    results: [{ name: 'x.jpg', orient: 'az', dirName: '发射', row: null, cells: { D: { value: -1 } }, issues: [] }],
  }));
  const out = path.join(TMP, 'spec_allbad.json');
  const r = run('make_spec.js', ['--judge=' + judge, '--out=' + out]);
  must(r.code === 1, '应退出码 1，实为 ' + r.code);
  must(/拒绝写出 spec/.test(r.out), '未明确拒绝：\n' + r.out);
  must(!fs.existsSync(out), '仍写出了空 spec');
  return '宁可报错，不静默成功';
});

check('make_spec：缺项的图 → 填能判的格、留空缺的格（不是整张拒填）', () => {
  const judge = path.join(TMP, 'judge_part.json');
  fs.writeFileSync(judge, JSON.stringify({
    results: [{
      name: '49.8方位.jpg', orient: 'az', dirName: '发射', row: 20,
      cells: { D: { value: -30.35 }, F: { value: -15.63 }, J: { value: 0.1 }, K: { value: 0.1 }, L: { value: 0.2 }, M: { value: 0.2 } },
      issues: ['缺 左侧旁瓣'],
    }],
  }));
  const out = path.join(TMP, 'spec_part.json');
  const r = run('make_spec.js', ['--judge=' + judge, '--out=' + out]);
  must(r.code === 0, '应成功（部分填写），实为 ' + r.code + '\n' + r.out);
  must(/部分填写 1 张/.test(r.out), '未报「部分填写」');
  must(/E20\(左\/下旁瓣\)/.test(r.out), '未点名缺失的格 E20：\n' + r.out);
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  must(s.values.D20 === -30.35, 'D20 应已填');
  must(!('E20' in s.values), 'E20 不该被填（无证据）');
  return '填 6 留 1 + 点名到格';
});

check('make_spec：方位/俯仰同行的来源列注记要合并成一条（不能互相覆盖）', () => {
  const judge = path.join(TMP, 'judge_mergetxt.json');
  const az = { D: { value: -1 }, E: { value: -2 }, F: { value: -3 }, J: { value: 0.1 }, K: { value: 0.1 }, L: { value: 0.2 }, M: { value: 0.2 } };
  const el = { G: { value: -1 }, H: { value: -2 }, I: { value: -3 }, N: { value: 0.1 }, O: { value: 0.1 }, P: { value: 0.2 }, Q: { value: 0.2 } };
  fs.writeFileSync(judge, JSON.stringify({
    results: [
      { name: '47.2方位.jpg', orient: 'az', dirName: '发射', row: 13, cells: az, issues: [], ts: '2026-10-01,13:56:30' },
      { name: '47.2俯仰.jpg', orient: 'el', dirName: '发射', row: 13, cells: el, issues: [], ts: '2026-10-01,13:59:36' },
    ],
  }));
  const out = path.join(TMP, 'spec_mergetxt.json');
  run('make_spec.js', ['--judge=' + judge, '--out=' + out]);
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  must(/方位/.test(s.texts.U13) && /俯仰/.test(s.texts.U13),
    'U13 应同时含方位与俯仰注记，实为 ' + s.texts.U13);
  return '一行两注记';
});

check('make_spec：生成的 spec 喂 fill_mark 后增益反算通过（analyze 判合格）', () => {
  const judge = path.join(TMP, 'judge_e2e.json');
  // 造一对对称的方位/俯仰（3dB 0.1°、10dB 0.2°），让 R/S/T 公式算得出合理增益
  const az = { D: { value: -29.23 }, E: { value: -15.98 }, F: { value: -17.56 }, J: { value: 0.1 }, K: { value: 0.1 }, L: { value: 0.2 }, M: { value: 0.2 } };
  const el = { G: { value: -29.3 }, H: { value: -15.41 }, I: { value: -18.07 }, N: { value: 0.1 }, O: { value: 0.1 }, P: { value: 0.2 }, Q: { value: 0.2 } };
  fs.writeFileSync(judge, JSON.stringify({
    results: [
      { name: '48方位.jpg', orient: 'az', dirName: '发射', row: 14, cells: az, issues: [] },
      { name: '48俯仰.jpg', orient: 'el', dirName: '发射', row: 14, cells: el, issues: [] },
    ],
  }));
  const spec = path.join(TMP, 'spec_e2e.json');
  must(run('make_spec.js', ['--judge=' + judge, '--out=' + spec, '--batch=T']).code === 0, 'make_spec 失败');
  const outX = path.join(TMP, 'e2e_filled.xlsx');
  const fr = run('fill_mark.js', [CLEARED, outX, spec]);
  must(fr.code === 0, 'fill_mark 失败：\n' + fr.out);
  must(/数值 14/.test(fr.out), '应写入 14 个数值，实为：\n' + fr.out.split('\n').slice(-3).join(' / '));
  must(!/文本 1[0-9]/.test(fr.out.replace(/文本 3 /, '')), '数值被当成文本写了（类型归一失效？）');
  const an = run('analyze.js', [outX]);
  must(/未发现不合格项/.test(an.out), 'analyze 判出不合格：\n' + an.out);
  // 值必须回读一致
  const vf = run('verify_mark.js', [outX, '方向图', 'D14', 'N14']);
  must(vf.code === 0, 'verify_mark 失败：\n' + vf.out);
  must(/-29\.23/.test(vf.out), 'D14 回读不到 -29.23：\n' + vf.out);
  return '14 格数值 + analyze 合格 + 回读一致';
});

check('judge_batch：--help 打印用法；缺 --case 退出码 2', () => {
  const h = run('judge_batch.js', ['--help']);
  must(h.code === 0, '退出码应 0，实为 ' + h.code);
  must(/--case/.test(h.out) && /--manual/.test(h.out), '用法不完整');
  must(run('judge_batch.js', []).code === 2, '缺 --case 应 2');
  return '用法自解释';
});

check('judge_batch：截图目录不存在时提示先跑 new_case/ingest', () => {
  const r = run('judge_batch.js', ['--case=' + path.join(TMP, '根本不存在')]);
  must(r.code === 2, '应退出码 2，实为 ' + r.code);
  must(/new_case|ingest/.test(r.out), '未提示前置动作：' + r.out);
  return '前置可行动';
});

check('judge_batch：空截图目录（无方向图）时明确报出期望的目录形态', () => {
  fs.mkdirSync(path.join(CASE_DIR, '99号机', '截图', '架标测试', '发射'), { recursive: true });
  const r = run('judge_batch.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  must(r.code === 1, '应退出码 1，实为 ' + r.code);
  must(/架标测试/.test(r.out), '未打印期望的目录形态：' + r.out);
  return '说清要什么';
});

check('judge_batch：band 只认直接父目录名（`接收链路标定` 不得被当成方向图目录）', () => {
  // 造一张位于 截图/接收链路标定/LNB到频谱仪/ 下的「方位」图 —— 名字像方向图，
  // 但它属于标定表，判读器必须不收（否则会把标定图当方向图判）
  const fakeDir = path.join(CASE_DIR, '99号机', '截图', '接收链路标定', 'LNB到频谱仪');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.copyFileSync(SAMPLE, path.join(fakeDir, '40方位.jpg'));   // 任意内容，只要文件名像
  const r = run('judge_batch.js', ['--case=' + path.join(CASE_DIR, '99号机')]);
  must(!/40方位/.test(r.out.replace(/[\s\S]*?找到方向图|[\s\S]*/, m => m)) || /共 0 张|没找到方向图/.test(r.out),
    '标定目录下的图被当方向图收了：\n' + r.out);
  return '按父目录名严格判 band';
});

check('新脚本：只用 _lib 真实存在的 C.* 方法（防 L.C.yel/b/grn 这类不存在的别名）', () => {
  // _lib.C 实际导出：red/green/yellow/cyan/magenta/dim/bold
  // 历史上 new_case/ingest 各写过一次不存在的别名 → 运行时才炸。此处静态拦。
  const real = new Set(Object.keys(L.C));
  const NEW = ['new_case.js', 'ingest.js', 'make_spec.js', 'judge_batch.js'];
  for (const s of NEW) {
    const src = fs.readFileSync(path.join(SCRIPTS, s), 'utf8');
    const used = [...src.matchAll(/\bL\.C\.([a-zA-Z_$][\w$]*)/g)].map(m => m[1]);
    const bad = [...new Set(used)].filter(u => !real.has(u));
    must(bad.length === 0, s + ' 用了不存在的 C.' + bad.join(' / C.') +
      '（_lib.C 实际有：' + [...real].join('/') + '）');
  }
  return '4 个脚本的 C.* 全部合法';
});

check('新脚本：一律 require 共享内核 _lib，不自带 ZIP/XML 实现（避免判据分叉）', () => {
  for (const s of ['new_case.js', 'ingest.js', 'make_spec.js', 'judge_batch.js']) {
    const src = fs.readFileSync(path.join(SCRIPTS, s), 'utf8');
    must(/require\('\.\/_lib'\)/.test(src), s + ' 未复用 _lib.js');
    // 不该自己实现 CRC32 / ZIP 解析
    must(!/function\s+crc32|function\s+readZip|function\s+writeZip/.test(src),
      s + ' 自带 ZIP 实现 → 与 _lib 分叉（§17.2）');
  }
  return '4 个脚本共用内核';
});

check('新脚本：--help 输出不含 ANSI 转义（便于直接贴给人看）', () => {
  for (const s of ['new_case.js', 'ingest.js', 'make_spec.js', 'judge_batch.js']) {
    const r = run(s, ['--help']);
    must(r.code === 0, s + ' --help 退出码 ' + r.code);
    must(!/\x1b\[/.test(r.out), s + ' --help 里混进了 ANSI 转义');
    must(r.out.split('\n').length > 10, s + ' --help 输出过短，可能没打印用法');
  }
  return '4 个脚本用法可读';
});

check('README 与 SKILL.md 是否需要同步新脚本（文档漂移检查）', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const s of ['new_case.js', 'ingest.js', 'make_spec.js', 'judge_batch.js']) {
    must(readme.includes(s), 'README 未提及新脚本 ' + s + '（§17.2：一个知识点必须贯通到每个消费者）');
  }
  return 'README 已收录 4 个新脚本';
});

/* ---- ⑩ refresh_cache 的 $ 反向引用回归（SKILL §18.14） ---- */

check('§20 回归：refresh_cache 不得因公式含 $ 绝对引用而写坏 XML', () => {
  // 造一份「公式里带 $」的样本 —— 真实触发场景是跟踪精度的数组公式
  //   SQRT(SUMSQ(B4:B13-B$14)/COUNTA(B4:B13))  → 原实现把 $14 当反向引用展开成 <c …>4
  const SRC = path.join(TMP, 'dollar_src.xlsx');
  const SPECJ = path.join(TMP, 'dollar_spec.json');
  fs.copyFileSync(SAMPLE, SRC);

  const wb = L.Workbook.load(SRC);
  const sn = makeSample.SHEET_NAMES.find(n => n.startsWith('跟踪精度')) || makeSample.SHEET_NAMES[0];
  let xml = wb.getXml(sn);
  const m = /<c r="([A-Z]+\d+)"([^>]*)>(<f[^>]*>[\s\S]*?<\/f>)(<v>[\s\S]*?<\/v>)?<\/c>/.exec(xml);
  must(!!m, '样本里找不到公式格，无法构造回归用例');
  const ref = m[1];
  const injected = m[0].replace(/(<f[^>]*>)([\s\S]*?)(<\/f>)/, (s, a, b, c) => a + 'SUMSQ(' + b + '-A$2)' + c);
  xml = xml.replace(m[0], injected);
  wb.setXml(sn, xml);
  wb.save(SRC);
  must(wb.getXml(sn).includes('A$2'), '注入后公式里应含 A$2');

  const cells = {}; cells[sn] = {}; cells[sn][ref] = 1.2345;
  fs.writeFileSync(SPECJ, JSON.stringify(cells));
  const r = run('refresh_cache.js', [SRC, SPECJ]);
  must(r.code === 0, 'refresh_cache 退出码 ' + r.code + '\n' + r.out);

  const wb2 = L.Workbook.load(SRC);
  const cellXml = new RegExp('<c r="' + ref + '"[^>]*>[\\s\\S]*?</c>').exec(wb2.getXml(sn))[0];
  must(cellXml.includes('A$2'), '$ 被吞掉了：' + cellXml.slice(0, 160));
  const openTags = (cellXml.match(/<c[\s>]/g) || []).length;
  must(openTags === 1, '公式体内被塞进了单元格标签（$ 反向引用未修）：' + cellXml.slice(0, 160));
  must(/<v>1\.2345<\/v>/.test(cellXml), '缓存 <v> 未写入：' + cellXml.slice(0, 160));

  const zc = run('zipcheck.js', [SRC]);
  must(zc.code === 0, 'zipcheck 未通过 → XML 被写坏\n' + zc.out);
  return '含 $ 公式刷缓存后 XML 仍良构（' + sn + '!' + ref + '）';
});

check('§20 回归（反向）：故意用字符串替换必须能复现炸裂 —— 证明本用例真的抓得住', () => {
  // 若把修法回退成 xml.replace(re, m[1]+inner+m[3])，同一输入必须产生「公式体内出现 <c」
  const s = '<c r="B9" s="11"><f t="array" ref="B9">SQRT(SUMSQ(B4:B13-B$14))</f><v>1</v></c>';
  const re = /(<c r="B9"[^>]*>)([\s\S]*?)(<\/c>)/;
  const m = re.exec(s);
  const inner = m[2].replace(/<v>[\s\S]*?<\/v>/, '') + '<v>2</v>';
  const broken = s.replace(re, m[1] + inner + m[3]);      // ← 旧写法
  const fixed  = s.replace(re, () => m[1] + inner + m[3]); // ← 新写法
  must((broken.match(/<c[\s>]/g) || []).length > 1, '预期旧写法会炸，但它没炸 —— 本回归用例失效，请重写');
  must((fixed.match(/<c[\s>]/g) || []).length === 1, '新写法仍炸，说明修复无效');
  must(fixed.includes('B$14'), '新写法把公式改坏了');
  return '旧写法复现炸裂 / 新写法保持良构';
});

/* ---------------------------------------------------------------- */

console.log('');
console.log(''.padEnd(64, '─'));
console.log(L.C.bold('结果：') + L.C.green(pass + ' 通过') +
  (fail ? ' ｜ ' + L.C.red(fail + ' 失败') : ' ｜ 0 失败'));

if (fail) {
  console.log('');
  for (const f of failures) console.log(L.C.red('  ✗ ' + f));
}

if (!KEEP) {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
} else {
  console.log(L.C.dim('  临时目录保留在 ' + TMP));
}

process.exit(fail ? 1 : 0);
