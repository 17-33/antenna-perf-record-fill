#!/usr/bin/env node
'use strict';
/**
 * judge_batch.js —— **批量判读编排**：两遍 OCR → read_spectrum → merge_judge，出一条命令
 *
 * 为什么需要它（SKILL.md §18.12 三遍法的编排化 + §17.4 缺口 1 的已知缺陷）：
 *   「截图 → 判读终值」这段过去要人手工串 4 步：
 *     ① ocr_image 每张图跑一遍（基准）      ② 再跑一遍（--scale=2）
 *     ③ read_spectrum --ocr=<目录> --dir=接收|发射
 *     ④ merge_judge 底稿 补充 [--manual] → 终值
 *   而 ③ 有个**命名约定坑**：`read_spectrum --ocr` 是按 **OCR JSON 的文件名**判别
 *   接收/发射与方位/俯仰的（`/方位/`、`/接收/`），而归档惯例是
 *   `截图/架标测试/发射/47.2方位.jpg` —— **band 在父目录、方位在文件名**。
 *   直接把 ocr 目录丢给它会得到「0 张」。本脚本按归档目录树分派 band，绕开这个坑。
 *
 * 用法:
 *   node judge_batch.js --case=<机器目录> [--only=发射] [--passes=2] [--scale1=1] [--scale2=2]
 *   node judge_batch.js --case=<机器目录> --manual=补丁.json --batch=批4
 *
 * 参数:
 *   --case=<dir>     机器目录（必填），截图从 `<case>/截图` 取
 *   --only=发射|接收 只判一侧（默认两侧都判）
 *   --passes=N       OCR 遍数（默认 2 = 基准 + 二遍，§18.12）
 *   --scale1=N       基准遍放大倍数（默认 1）
 *   --scale2=N       二遍放大倍数（默认 2）
 *   --manual=<file>  merge_judge 的人工补丁（两遍都缺的 marker，§17.6）
 *   --batch=<名>     批次名（写进输出文件名）
 *   --ocr-dir=<dir>  OCR JSON 落盘目录（默认 `<case>/报告/ocr` 与 `ocr2`）
 *   --keep-ocr       不清空 OCR 目录（默认每次重建，避免旧图混入）
 *   --no-merge       跳过 merge_judge（只出单遍结果，用于排查）
 *
 * 产出（<case>/批次/判读/）:
 *   判读_<batch>_基准.json      单遍判读
 *   判读_<batch>_二遍.json      二遍判读
 *   判读_<batch>_终值.json      合并终值（可直接喂 crosscheck / make_spec）
 *   判读_<batch>_报告.md        缺项 / 警告摘要
 *
 * ⚠️ 本脚本**只做判读，不碰 xlsx**。填表是 make_spec + fill_mark 的事。
 *
 * 退出码: 0 = 完成；1 = 出错；2 = 用法错误
 */

const L = require('./_lib');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}
if (flags.help || flags.h || !flags.case) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(flags.help || flags.h ? 0 : 2);
}

const CASE = path.resolve(String(flags.case));
const SHOT = path.join(CASE, '截图');
const BATCH = String(flags.batch || '批' + new Date().toISOString().slice(5, 10).replace('-', ''));
const PASSES = Math.max(1, parseInt(flags.passes || '2', 10));
const OUT = path.join(CASE, '批次', '判读');
const EXTS = /\.(jpe?g|png)$/i;

function fail(m, c) { console.error(L.C.red('✗ ' + m)); process.exit(c === undefined ? 1 : c); }
/** 人读输出一律走 stderr，stdout 保持干净（便于被上层脚本捕获） */
const say = (...a) => console.error(...a);
function run(script, args) {
  return execFileSync(process.execPath, [path.join(__dirname, script)].concat(args),
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

if (!fs.existsSync(SHOT)) fail('找不到截图目录：' + SHOT + '\n  先跑 new_case.js 建目录，或用 ingest.js 落位。', 2);

// OCR 二进制（与 check_pairs 同一套：优先 skill 内 .bin，回落 /tmp）
function ensureOcrBin() {
  const local = path.join(__dirname, '.bin', 'ocr_image');
  if (fs.existsSync(local)) return local;
  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    execFileSync('swiftc', ['-O', path.join(__dirname, 'ocr_image.swift'), '-o', local],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    return local;
  } catch (e) { return null; }
}
const bin = ensureOcrBin();
if (!bin) fail('OCR 二进制不可用（需要 macOS + swiftc）。先跑一次 check_pairs.js --selftest 会自动编译。', 1);

/* ---------------- 1. 按 band 收集方向图 ---------------- */
const ONLY = flags.only ? String(flags.only) : null;
const groups = { 发射: [], 接收: [] };
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      // 这些目录不参与方向图判读
      if (/_待归档|_待人工确认|EIRP|跟踪精度|接收链路标定/.test(e.name)) continue;
      walk(p); continue;
    }
    if (!EXTS.test(e.name) || e.name.startsWith('._')) continue;
    if (/功率|八通道|ACLR/i.test(e.name)) continue;
    // band 由**直接父目录名**决定，且必须严格等于「接收」或「发射」
    // ⚠️ 不能用 /[\\/](接收|发射)[\\/]/ 去 match 整条路径 ——
    //    `截图/接收链路标定/LNB到频谱仪/…` 里也会命中「接收」，把标定图当方向图。
    const parent = path.basename(path.dirname(p));
    if (parent !== '接收' && parent !== '发射') continue;
    const band = parent;
    if (!/方位|俯仰/.test(e.name)) continue;   // 方向图必须带切面标识（归档惯例保证）
    if (ONLY && band !== ONLY) continue;
    groups[band].push(p);
  }
})(SHOT);

for (const k of Object.keys(groups)) groups[k].sort();
const total = groups.发射.length + groups.接收.length;
if (!total) fail('没找到方向图（需 截图/架标测试/{接收,发射}/<频点>{方位,俯仰}.jpg）\n  ' + SHOT);

say(L.C.bold('【批量判读】'));
say('  机器  ' + CASE);
say('  批次  ' + BATCH + L.C.dim('（输出到 批次/判读/）'));
say('  图片  发射 ' + groups.发射.length + ' 张 ｜ 接收 ' + groups.接收.length + ' 张');
say('  OCR   ' + PASSES + ' 遍（scale ' + (flags.scale1 || 1) + ' / ' + (flags.scale2 || 2) + '）');
say('');

/* ---------------- 2. 两遍 OCR ----------------
 * §18.12 三遍法：① 解析器打底 ② 窄列高倍 OCR 补缺 ③ 异常目视。
 * 本脚本负责 ①②，③（放大目视）仍需人眼 —— 但会把异常项单独列出来引导去看。
 */
const ocrDirs = [];
const perBand = {};   // band → [{name, json: <OCR JSON 文件路径>}]

for (let pass = 1; pass <= PASSES; pass++) {
  const scale = String(pass === 1 ? (flags.scale1 || 1) : (flags.scale2 || 2));
  const odir = path.resolve(String(flags['ocr-dir'] || path.join(CASE, '报告', pass === 1 ? 'ocr' : 'ocr2')));
  if (pass === 1 && !flags['keep-ocr'] && fs.existsSync(odir)) {
    try { fs.rmSync(odir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  fs.mkdirSync(odir, { recursive: true });
  ocrDirs.push(odir);

  say(L.C.bold('▸ 第 ' + pass + ' 遍 OCR（scale=' + scale + '）'));
  const items = [];
  for (const band of Object.keys(groups)) {
    for (const img of groups[band]) {
      const base = path.basename(img).replace(/\.(jpe?g|png)$/i, '');
      const out = path.join(odir, base + '.json');
      try {
        const raw = execFileSync(bin, [img, '--json', '--scale=' + scale],
          { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
        fs.writeFileSync(out, raw, 'utf8');
        items.push({ name: base, band, json: out, src: img });
      } catch (e) {
        say('  ' + L.C.red('✗') + ' ' + path.basename(img) + ' —— OCR 失败：' + e.message);
      }
    }
  }
  if (pass === 1) {
    perBand['发射'] = items.filter(i => i.band === '发射');
    perBand['接收'] = items.filter(i => i.band === '接收');
  }
  say('  ' + L.C.green('完成') + ' ' + items.length + ' 张 → ' + odir);
}
say('');

/* ---------------- 3. read_spectrum 判读 ---------------- */
/* ⚠️ 命名约定的桥接：read_spectrum --ocr 按 OCR JSON 的**文件名**判别 接收/发射 + 方位/俯仰，
 *   而归档惯例把 band 放在父目录里。所以这里为每个 band 单独跑一次 --dir，
 *   并把 JSON 复制到一个带 band 前缀的临时目录（`__发射__47.2方位.json`），
 *   让 read_spectrum 能认出来。判读完删掉临时目录，不污染原始 OCR 证据。
 */
const judgeFiles = [];
for (let pass = 1; pass <= PASSES; pass++) {
  const odir = ocrDirs[pass - 1];
  const outFile = path.join(OUT, '判读_' + BATCH + (pass === 1 ? '_基准' : '_' + (pass === 2 ? '二遍' : '遍' + pass)) + '.json');
  const bandResults = [];

  for (const band of Object.keys(perBand)) {
    const items = (pass === 1 ? perBand[band] : []).filter(Boolean);
    const list = pass === 1 ? items : (function () {
      return perBand[band].map(i => ({ ...i, json: path.join(odir, i.name + '.json') }))
        .filter(i => fs.existsSync(i.json));
    })();
    if (!list.length) continue;

    // 建带 band 前缀的临时目录
    // ⚠️ read_spectrum --ocr 的三重文件名约定（实测）：
    //     ① `only` 默认 ['架标测试'] → 文件名必须含「架标测试」
    //     ② band 从文件名认：含「接收」/「发射」
    //     ③ 切面从文件名认：含「方位」/「俯仰」
    //   而归档惯例把 band 放在**父目录**、切面在文件名、且不带「架标测试」字样。
    //   → 必须在临时目录里改名成 `架标测试__<band>__<原名>.json` 才能被认出来。
    //   这是**只读适配层**：临时目录判完即删，原始 OCR 证据（报告/ocr*/）不动。
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'judge_'));
    try {
      for (const it of list) {
        fs.copyFileSync(it.json, path.join(tmp, '架标测试__' + band + '__' + it.name + '.json'));
      }
      const stdout = execFileSync(process.execPath,
        [path.join(__dirname, 'read_spectrum.js'), '--ocr=' + tmp, '--dir=' + band, '--json'],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const j = JSON.parse(stdout);
      for (const r of (j.results || [])) {
        // 去掉临时前缀，还原成归档名
        r.name = String(r.name || '').replace(/^架标测试__[^_]+__/, '');
        bandResults.push(r);
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ results: bandResults }, null, 2), 'utf8');
  judgeFiles.push(outFile);
  const withIssues = bandResults.filter(r => r.issues && r.issues.length);
  say(L.C.bold('▸ 第 ' + pass + ' 遍判读：') + ' 共 ' + bandResults.length + ' 张' +
    (withIssues.length ? L.C.yellow('，其中 ' + withIssues.length + ' 张有缺项') : L.C.green('，全部完整')));
  for (const r of withIssues) {
    say(L.C.yellow('   ⚠ ' + r.name + ' —— 缺: ' + r.issues.join(' / ')));
  }
  judgeFiles.push(outFile);
}
say('');

/* ---------------- 4. merge_judge 合成终值 ---------------- */
let finalFile = judgeFiles[0];
if (PASSES >= 2 && !flags['no-merge']) {
  finalFile = path.join(OUT, '判读_' + BATCH + '_终值.json');
  const margs = [judgeFiles[0], judgeFiles[1], finalFile];
  if (flags.manual) margs.push('--manual=' + path.resolve(String(flags.manual)));
  try {
    run('merge_judge.js', margs);
    say(L.C.bold('▸ 合并终值：') + ' ' + finalFile);
  } catch (e) {
    console.error(L.C.yellow('⚠ merge_judge 失败：' + ((e.stdout || '') + (e.stderr || '')).toString().slice(0, 300)));
    console.error(L.C.dim('  改用基准遍结果继续。'));
    finalFile = judgeFiles[0];
  }
}
say('');

/* ---------------- 5. 报告 ---------------- */
const final = L.readJson(finalFile);
const results = final.results || [];
const needEye = results.filter(r => r.issues && r.issues.length);
const rep = [
  '# ' + CASE.split('/').pop() + ' · ' + BATCH + ' 判读报告',
  '',
  '生成：`judge_batch.js` ｜ ' + new Date().toISOString().slice(0, 19).replace('T', ' '),
  '',
  '## 一、结果',
  '',
  '- 判读张数：**' + results.length + '**',
  '- 完整：**' + (results.length - needEye.length) + '** ｜ 有缺项：**' + needEye.length + '**',
  '- 终值文件：`' + path.relative(CASE, finalFile) + '`',
  '',
  '## 二、需人工核对（三遍法第 ③ 遍：放大目视）',
  '',
  needEye.length
    ? '| 图 | 缺什么 | 建议动作 |'
      + '\n|---|---|---|'
      + needEye.map(r => '| ' + r.name + ' | ' + r.issues.join(' / ') + ' | 6× 裁 marker 表目视，或补 --manual 补丁 |').join('\n')
    : '（无 —— 全部 marker 都解析到了）',
  '',
  '## 三、⚠ read_spectrum 的已知丢 marker 缺陷（§17.6）',
  '',
  '「有缺项」不一定代表截图里没有该 marker，也可能是解析器丢的。**判别口诀**：',
  '回 `报告/ocr/` 与 `报告/ocr2/` 原始 OCR 查该数字 —',
  '  - 两遍 OCR **有** → 解析层丢的（表大概率是对的，用 --manual 补）',
  '  - 两遍 OCR **也没有** → 截图本身可能没这个 marker',
  '',
];
fs.mkdirSync(OUT, { recursive: true });
const repFile = path.join(OUT, '判读_' + BATCH + '_报告.md');
fs.writeFileSync(repFile, rep.join('\n'), 'utf8');

say(L.C.bold('完成：'));
say('  终值    ' + L.C.cyan(path.relative(CASE, finalFile)));
say('  报告    ' + L.C.cyan(path.relative(CASE, repFile)));
if (needEye.length) say(L.C.yellow('  ⚠ ' + needEye.length + ' 张有缺项 → 看报告「需人工核对」小节，§17.6 判别口诀'));
say('');
say(L.C.bold('下一步：'));
say('  生成 spec  ' + L.C.cyan('node make_spec.js --judge="' + finalFile + '" --out-dir=批次/spec'));
say('  填表      ' + L.C.cyan('node fill_mark.js <in.xlsx> <out.xlsx> 批次/spec/spec_方向图.json'));
process.exit(0);
