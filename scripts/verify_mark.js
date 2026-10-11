#!/usr/bin/env node
'use strict';
/**
 * verify_mark.js —— 回读校验：值 / 字体色 / 是否加粗 / 填充色
 *
 * 用法:
 *   node verify_mark.js <x.xlsx> <表名前缀或别名> <格...>
 *   node verify_mark.js <x.xlsx> 方向图 D5 E5 J5
 *   node verify_mark.js <x.xlsx> 方向图 D5:F12 --json
 *
 * 判定:
 *   ● 已标记 = 值非空 + 字体 FFFF0000 + 加粗              → 通过
 *   □ 蓝底待填 = 无值 + 填充 FF00B0F0                     → 提示
 *   ƒ 公式                                                → 提示（不应被写）
 *   ✗ 异常：写入了值但未标红 / 标红了但没值 / 红字但没加粗
 *
 * 退出码: 0 无异常；1 有异常
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
  console.error('用法: node verify_mark.js <x.xlsx> <表名前缀> <格...>  例: node verify_mark.js a.xlsx 方向图 D5:E6 J5');
  process.exit(2);
}
const file = positional[0];
const sheetArg = positional[1];
const refArgs = positional.slice(2);

let wb;
try { wb = L.Workbook.load(file); }
catch (e) { console.error(L.C.red('✗ 打不开文件：' + e.message)); process.exit(1); }

let sheet;
try { sheet = wb.resolveSheet(sheetArg); }
catch (e) { console.error(L.C.red('✗ ' + e.message)); process.exit(1); }

const refs = [].concat(...refArgs.map(r => L.expandRange(r)));

console.log(L.C.bold('【回读校验】'));
console.log('  文件  ' + file);
console.log('  工作表 ' + sheet + L.C.dim('（查询参数：' + sheetArg + '）'));
console.log('  格数  ' + refs.length);
console.log('');

const rows = [];
let anomalies = 0;

for (const ref of refs) {
  const d = wb.cell(sheet, ref);
  if (!d) {
    rows.push({ ref, state: '空(格不存在)', value: '', font: '', bold: '', fill: '', bad: false });
    continue;
  }
  const hasVal = d.value !== null && d.value !== undefined && d.value !== '';
  const isRed = d.fontRgb === L.RED;
  const isBlue = d.fillRgb === L.BLUE;
  let state, bad = false;
  if (d.isFormula) { state = 'ƒ 公式（未写入，符合预期）'; }
  else if (hasVal && isRed && d.bold) { state = '● 已标记（红字加粗）'; }
  else if (hasVal && isRed && !d.bold) { state = '✗ 红字但未加粗'; bad = true; }
  else if (hasVal && !isRed) { state = isBlue ? '○ 有值·未标红（蓝底）' : '○ 有值·未标红'; }
  else if (!hasVal && isRed) { state = '✗ 标红了但无值'; bad = true; }
  else if (!hasVal && isBlue) { state = '□ 蓝底待填'; }
  else { state = '· 空'; }
  if (bad) anomalies++;
  rows.push({
    ref,
    state,
    value: L.fmtVal(d.value),
    font: d.fontRgb || '',
    bold: d.bold ? 'B' : '',
    fill: d.fillRgb || '',
    styleIdx: d.s,
    bad,
  });
}

if (flags.json) {
  console.log(JSON.stringify({ file, sheet, rows }, null, 2));
} else {
  console.log('  ' + ['格', '值', '字体色', '粗', '填充色', '样式', '判定'].join('\t'));
  for (const r of rows) {
    const line = '  ' + [
      r.ref.padEnd(5),
      (r.value === '' ? L.C.dim('(空)') : r.value),
      r.font || L.C.dim('-'),
      r.bold || '-',
      r.fill || L.C.dim('-'),
      r.styleIdx == null ? '-' : r.styleIdx,
      r.bad ? L.C.red(r.state) : r.state,
    ].join('\t');
    console.log(line);
  }
}

console.log('');
const nMarked = rows.filter(r => r.state.startsWith('●')).length;
const nBlue = rows.filter(r => r.state.startsWith('□')).length;
const nFormula = rows.filter(r => r.state.startsWith('ƒ')).length;

if (anomalies === 0) {
  console.log(L.C.green('结论: 无异常 ✅') + L.C.dim('（已标记 ' + nMarked + ' ｜ 蓝底待填 ' + nBlue + ' ｜ 公式 ' + nFormula + '）'));
  process.exit(0);
} else {
  console.log(L.C.red('结论: ' + anomalies + ' 项异常 ✗'));
  process.exit(1);
}
