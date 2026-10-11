#!/usr/bin/env node
'use strict';
/**
 * blank_formula_cache.js —— 建「待填空表」时用：清掉公式格的**缓存结果 <v>**，
 * 只留公式 <f>，并给工作簿打上 fullCalcOnLoad="1"。
 *
 * 为什么需要它（SKILL.md §17.5 的姊妹场景）：
 *   xlsx 的公式格 = <f>公式</f> + <v>上次计算结果</v>。
 *   `clear_data.js` 把输入格清空后，公式格的 <v> 仍是**旧机器**的数值 ——
 *   空表里于是残留一整套别人家的增益/EIRP/G-T，既不显示为空、又会骗过
 *   dump/analyze/diff 这些读缓存的人。
 *
 *   本脚本把 <v> 抹掉（<f> 保留），再置 fullCalcOnLoad：
 *     → Excel/WPS 一打开就重算，空表自然显示 #DIV/0! 之类，不会骗人；
 *     → 脚本侧读到的也是「无值」，而不是旧数据。
 *
 * 用法:
 *   node blank_formula_cache.js <in.xlsx> <out.xlsx> [--dry-run]
 *
 * 注意：这是「建空表」的收尾步骤，**不要在已填好数据的表上用** ——
 *       那会把正常计算结果一起抹掉（下一句 Excel 会重算回来，但非 Excel 读者会读到空）。
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
if (positional.length < 2) {
  console.error('用法: node blank_formula_cache.js <in.xlsx> <out.xlsx> [--dry-run]');
  process.exit(2);
}
const [inFile, outFile] = positional;

let wb;
try { wb = L.Workbook.load(inFile); }
catch (e) { console.error(L.C.red('✗ 打不开输入文件：' + e.message)); process.exit(1); }

console.log(L.C.bold('【清公式缓存 · 保留公式】'));
console.log('  输入  ' + inFile);
console.log('  输出  ' + outFile);
console.log('');

let total = 0, protectedN = 0;
for (const name of wb.sheetNames()) {
  let xml = wb.getXml(name);
  const parsed = L.parseSheet(xml);
  const edits = [];
  let pn = 0;
  for (const c of parsed.cells.values()) {
    if (!c.formula) continue;
    if (/DISPIMG/i.test(c.formula)) { pn++; continue; }   // 内嵌图公式：动了插图就没了
    const fm = /<f\b[^>]*\/>|<f\b[\s\S]*?<\/f>/.exec(c.full);
    if (!fm) continue;
    const om = /^<c\b[^>]*>/.exec(c.full);
    if (!om) continue;
    const open = om[0].replace(/\s+t="[^"]*"/, '');        // 结果类型由重算决定，去掉 t
    const neu = open + fm[0] + '</c>';
    if (neu !== c.full) edits.push([c.full, neu]);
  }
  for (const [a, b] of edits) {
    const at = xml.indexOf(a);
    if (at < 0) continue;
    xml = xml.slice(0, at) + b + xml.slice(at + a.length);
    total++;
  }
  wb.setXml(name, xml);
  protectedN += pn;
  console.log(L.C.bold('▸ ' + name) + L.C.dim('  抹掉缓存 ' + edits.length + (pn ? ' ｜ 保护内嵌图 ' + pn : '')));
}

console.log('');
if (flags['dry-run']) {
  console.log(L.C.yellow('--dry-run：未写出文件。'));
} else {
  const ok = wb.forceRecalc();
  wb.save(outFile);
  console.log(L.C.green('✓ 已写出 ' + outFile + '（' + require('fs').statSync(outFile).size + ' 字节）'));
  console.log(L.C.green('✓ 已置 fullCalcOnLoad="1"' + (ok ? '' : '（⚠ 未找到 <calcPr>，请人工确认）')));
  const r = L.zipValidate(require('fs').readFileSync(outFile));
  if (r.ok) console.log(L.C.green('✓ 输出文件完整性校验通过'));
  else {
    console.log(L.C.red('✗ 输出文件校验失败：'));
    for (const p of r.problems) console.log('  ' + L.C.red('- ' + p));
    process.exit(1);
  }
}
console.log('');
console.log(L.C.bold('汇总：') + '抹掉公式缓存 ' + total + ' 格' +
  (protectedN ? ' ｜ 保护内嵌图公式 ' + protectedN + ' 格' : ''));
