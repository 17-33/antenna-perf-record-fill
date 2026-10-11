#!/usr/bin/env node
'use strict';
/**
 * fill_mark.js —— 填值 + 标记（写 xlsx 副本，不动原文件）
 *
 * 用法:
 *   node fill_mark.js <in.xlsx> <out.xlsx> <spec.json> [--dry-run] [--no-validate] [--no-recalc]
 *
 * 自动行为：只要往数据格写了值，就把 workbook.xml 的 <calcPr> 置 fullCalcOnLoad="1"，
 *           让 Excel/WPS 打开时重算引用这些格的公式（否则缓存值会过期，见 SKILL.md §17.5）。
 *           `--no-recalc` 可关闭。
 *
 * spec.json（单个作业）:
 * {
 *   "sheet": "方向图",
 *   "mark":   ["D5","E5","J5"],                 // 可选；缺省 = 所有本次写入的格
 *   "values": { "D5": -13.23, "J5": 0.14146 },  // 数值格
 *   "texts":  { "U2": "数据来源截图", "U5": "37.5方位.jpg" },
 *   "notes":  [ { "cell": "A25", "text": "批次1｜…｜源文件 37.5方位.jpg → 已填 D5 E5 J5" } ]
 * }
 *
 * spec.json（多作业，串行同一文件）: 顶层数组，或 { "jobs": [ {...}, {...} ] }
 *
 * 规则（对应 SKILL.md §6）:
 *   - mark 里的格：红字加粗 FF0000 + 保留原填充色（蓝底 FF00B0F0）
 *   - 公式格（含 <f>）拒绝写入，报告里列为 skipped
 *   - **合并区影子格**（如 EIRP G5:G11 属合并区 G4:G11）拒绝写入并列为 skipped：
 *     写进去 Excel 也不显示（只显示左上锚点），等于静默丢数据。
 *     确需强写时在该作业里加 "allowShadow": true。
 *   - 来源列位置：方向图 U、EIRP L、跟踪精度 D、前向链路 F（用 texts 写入即可）
 *   - 日志行写在表格下方空行（用 notes 写入即可）
 *   - 值可为数字或字符串；键支持区间（如 "D5:D12": [..12个值..]）
 */

const L = require('./_lib');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}

if (positional.length < 3) {
  console.error('用法: node fill_mark.js <in.xlsx> <out.xlsx> <spec.json> [--dry-run] [--no-validate]');
  process.exit(2);
}
const [inFile, outFile, specFile] = positional;

let wb;
try { wb = L.Workbook.load(inFile); }
catch (e) { console.error(L.C.red('✗ 打不开输入文件：' + e.message)); process.exit(1); }

let spec;
try { spec = L.readJson(specFile); }
catch (e) { console.error(L.C.red('✗ ' + e.message)); process.exit(1); }

let jobs;
if (Array.isArray(spec)) jobs = spec;
else if (spec && Array.isArray(spec.jobs)) jobs = spec.jobs;
else jobs = [spec];

const report = { filled: 0, texted: 0, noted: 0, marked: 0, skipped: [], errors: [], sheets: [] };

console.log(L.C.bold('【填值 + 标记】'));
console.log('  输入  ' + inFile);
console.log('  输出  ' + outFile);
console.log('  规格  ' + specFile + (jobs.length > 1 ? '（' + jobs.length + ' 个作业）' : ''));
console.log('');

function expandPairs(obj) {
  const out = [];
  if (!obj) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k.includes(':') && Array.isArray(v)) {
      const refs = L.expandRange(k);
      if (refs.length !== v.length) {
        report.errors.push('区间 ' + k + ' 展开得 ' + refs.length + ' 格，但给了 ' + v.length + ' 个值');
        continue;
      }
      refs.forEach((r, i) => out.push([r, v[i]]));
    } else if (k.includes(':')) {
      for (const r of L.expandRange(k)) out.push([r, v]);
    } else {
      out.push([k, v]);
    }
  }
  return out;
}

for (let ji = 0; ji < jobs.length; ji++) {
  const job = jobs[ji] || {};
  const sheetName = job.sheet;
  let real;
  try { real = wb.resolveSheet(sheetName); }
  catch (e) { report.errors.push('作业' + (ji + 1) + '：' + e.message); continue; }

  const valuePairs = expandPairs(job.values);
  const textPairs = expandPairs(job.texts);
  const allPairs = valuePairs.concat(textPairs);

  const markSet = (() => {
    if (job.mark == null) return new Set(allPairs.map(p => L.parseRef(p[0]).ref));
    const s = new Set();
    for (const m of [].concat(job.mark)) for (const r of L.expandRange(m)) s.add(r);
    return s;
  })();

  report.sheets.push(real);
  const wrote = new Set();
  console.log(L.C.bold('▸ 工作表「' + real + '」') +
    L.C.dim('  写入 ' + allPairs.length + ' 格，标记 ' + markSet.size + ' 格'));

  for (const [refRaw, val] of allPairs) {
    const ref = L.parseRef(refRaw).ref;
    wrote.add(ref);
    const wantMark = markSet.has(ref);
    const before = wb.cell(real, ref);
    const res = wb.writeCell(real, ref, val, {
      mark: wantMark,
      allowShadow: !!job.allowShadow,
    });
    if (!res.ok) {
      report.skipped.push({ sheet: real, ref, reason: res.reason });
      const why = res.reason === 'formula' ? '公式格，拒绝写入'
        : res.reason === 'merged-shadow' ? '合并区影子格（写值不会显示），拒绝写入'
        : res.reason;
      console.log('  ' + L.C.yellow('⤫ skipped') + ' ' + ref + '  ' + L.C.dim(why) +
        (before && before.formula ? L.C.dim('  ' + before.formula) : ''));
      continue;
    }
    const isNum = typeof val === 'number';
    if (isNum) report.filled++; else report.texted++;
    if (wantMark) report.marked++;
    const oldV = before ? L.fmtVal(before.value) : null;
    const oldTag = before && before.value != null
      ? L.C.dim('  (原 ' + oldV + ')')
      : L.C.dim('  (原空)');
    console.log('  ' + (wantMark ? L.C.red('●') : '○') + ' ' + ref.padEnd(5) + ' = ' +
      L.fmtVal(val) + oldTag +
      (wantMark ? L.C.red('  [红字加粗]') : '') +
      (before && before.fillRgb === L.BLUE ? L.C.dim('  [蓝底保留]') : ''));
  }

  if (Array.isArray(job.notes)) {
    for (const n of job.notes) {
      if (!n || !n.cell) continue;
      const ref = L.parseRef(n.cell).ref;
      wrote.add(ref);
      const res = wb.writeCell(real, ref, String(n.text == null ? '' : n.text),
        { allowShadow: !!job.allowShadow });
      if (res.ok) {
        report.noted++;
        console.log('  ' + L.C.dim('✎ 日志 ') + ref + ' ← ' + String(n.text).slice(0, 90));
      } else {
        report.skipped.push({ sheet: real, ref, reason: res.reason });
        console.log('  ' + L.C.yellow('⤫ skipped') + ' ' + ref + L.C.dim('  ' + res.reason));
      }
    }
  }

  // mark 里列出、但本次没写值的格：只上标记，不动值
  const markOnly = [...markSet].filter(r => !wrote.has(r));
  for (const ref of markOnly) {
    const res = wb.markCell(real, ref, { allowShadow: !!job.allowShadow });
    if (res.ok) {
      report.marked++;
      const d = wb.cell(real, ref);
      console.log('  ' + L.C.red('●') + ' ' + ref.padEnd(5) + ' = ' +
        (d && d.value != null && d.value !== '' ? L.fmtVal(d.value) : L.C.dim('(空)')) +
        L.C.red('  [仅上标记，未改值]'));
    } else {
      report.skipped.push({ sheet: real, ref, reason: res.reason });
      console.log('  ' + L.C.yellow('⤫ skipped') + ' ' + ref + L.C.dim('  ' + res.reason));
    }
  }
  console.log('');
}

if (flags['dry-run']) {
  console.log(L.C.yellow('--dry-run：未写出文件。'));
} else {
  L.ensureDirFor(outFile);
  // 只要往「数据格」写了值，公式的缓存结果就可能过期 → 强制打开时全表重算（SKILL.md §17.5）
  if (report.filled > 0 && !flags['no-recalc']) {
    if (wb.forceRecalc()) {
      console.log('');
      console.log(L.C.cyan('↻ 已置 fullCalcOnLoad：本次写了 ' + report.filled +
        ' 个数据格，打开时 Excel/WPS 会自动重算引用它们的公式'));
    }
  }
  try {
    wb.save(outFile);
    console.log(L.C.green('✓ 已写出 ' + outFile + '（' + require('fs').statSync(outFile).size + ' 字节）'));
  } catch (e) {
    console.error(L.C.red('✗ 写出失败：' + e.message));
    process.exit(1);
  }
  if (!flags['no-validate']) {
    const r = L.zipValidate(require('fs').readFileSync(outFile));
    if (r.ok) console.log(L.C.green('✓ 输出文件完整性校验通过（结构 + CRC32 + XML 良构）'));
    else {
      console.log(L.C.red('✗ 输出文件校验失败：'));
      for (const p of r.problems) console.log('  ' + L.C.red('- ' + p));
      process.exit(1);
    }
  }
}

console.log('');
console.log(L.C.bold('汇总：') +
  '数值 ' + report.filled + ' ｜ 文本 ' + report.texted +
  ' ｜ 日志 ' + report.noted + ' ｜ 标记 ' + report.marked +
  ' ｜ 跳过 ' + report.skipped.length + ' ｜ 错误 ' + report.errors.length);

if (report.skipped.length) {
  const REASON_LABEL = {
    formula: '公式格（含 <f>，拒绝写入）',
    'merged-shadow': '合并区影子格（写值 Excel 不显示，已拒绝；确需强写 → 该作业加 "allowShadow": true）',
    'anchor-not-found': '未在原 XML 里找到单元格锚点',
  };
  const byReason = new Map();
  for (const s of report.skipped) {
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason).push(s.sheet + '!' + s.ref);
  }
  console.log('');
  console.log(L.C.yellow('⤫ 跳过 ' + report.skipped.length + ' 格，按原因：'));
  for (const [r, refs] of byReason) {
    console.log('  ' + L.C.yellow('▸ ' + (REASON_LABEL[r] || r)) +
      L.C.dim('  — ' + refs.slice(0, 12).join(' ') + (refs.length > 12 ? ' …(+' + (refs.length - 12) + ')' : '')));
  }
}

if (report.errors.length) {
  for (const e of report.errors) console.log('  ' + L.C.red('! ' + e));
  process.exit(1);
}
