#!/usr/bin/env node
'use strict';
/**
 * diff_sheets.js —— 逐格 diff 两张工作簿
 *
 * 用法:
 *   node diff_sheets.js <A.xlsx> <B.xlsx> <表名前缀> [--max=N] [--soft] [--only=diff] [--json]
 *
 * 输出四类:
 *   只在 A 有值   （被清空了）
 *   只在 B 有值   （新增）
 *   两表都有但值不同（★ 关键：SKILL.md §8.1 要求重建/回填场景下这一项必须为"无"）
 *   两表都有且值相同（默认折叠）
 *
 * 退出码:
 *   默认 1（存在"值不同"时）—— 便于当校验门用
 *   --soft  则恒为 0
 *
 * 注: A 通常放"原始记录"，B 放"填报/清空版"。做重建对比时会天然出现大量差异，
 *     此时用 --soft 或 --only=diff 只为看清单。
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
  console.error('用法: node diff_sheets.js <A.xlsx> <B.xlsx> <表名前缀> [--max=N] [--soft] [--only=diff]');
  process.exit(2);
}
const [fileA, fileB, sheetArg] = positional;

const wa = L.Workbook.load(fileA);
const wb2 = L.Workbook.load(fileB);

let sheetA, sheetB;
try { sheetA = wa.resolveSheet(sheetArg); } catch (e) { console.error(L.C.red('✗ A：' + e.message)); process.exit(1); }
try { sheetB = wb2.resolveSheet(sheetArg); } catch (e) { console.error(L.C.red('✗ B：' + e.message)); process.exit(1); }

const cellsA = new Map([...wa.parsedSheet(sheetA).cells.values()].map(c => [c.ref, wa.decorate(c)]));
const cellsB = new Map([...wb2.parsedSheet(sheetB).cells.values()].map(c => [c.ref, wb2.decorate(c)]));

const all = new Set([...cellsA.keys(), ...cellsB.keys()]);
const sortRefs = a => a.sort((x, y) => {
  const p = L.parseRef(x), q = L.parseRef(y);
  return p.row - q.row || p.col - q.col;
});
const refs = sortRefs([...all]);

const onlyA = [], onlyB = [], differ = [], same = [];

for (const ref of refs) {
  const a = cellsA.get(ref);
  const b = cellsB.get(ref);
  const va = a ? a.value : null;
  const vb = b ? b.value : null;
  const emptyA = va === null || va === undefined || va === '';
  const emptyB = vb === null || vb === undefined || vb === '';
  if (emptyA && emptyB) continue;
  if (!emptyA && emptyB) onlyA.push({ ref, a: va, fa: a.formula });
  else if (emptyA && !emptyB) onlyB.push({ ref, b: vb });
  else if (String(va) !== String(vb)) differ.push({ ref, a: va, b: vb });
  else same.push({ ref, v: va });
}

const max = flags.max ? parseInt(flags.max, 10) : 40;
const show = arr => {
  const n = Math.min(arr.length, max);
  for (let i = 0; i < n; i++) arr[i]();
  if (arr.length > n) console.log(L.C.dim('   … 还有 ' + (arr.length - n) + ' 项'));
};

console.log(L.C.bold('【逐格 diff】'));
console.log('  A  ' + fileA + L.C.dim('  [' + sheetA + ']'));
console.log('  B  ' + fileB + L.C.dim('  [' + sheetB + ']'));
console.log('');

if (!flags['only'] || flags['only'] === 'diff' || flags.only === 'all') {
  console.log(L.C.bold('▸ 只在 A 有值（B 中为空）= ') + onlyA.length + (onlyA.length ? L.C.dim('  即被清空/删除') : ''));
  show(onlyA.map(x => () => console.log('   - ' + x.ref + '  A=' + L.fmtVal(x.a) + (x.fa ? L.C.dim(' (公式)') : ''))));
  console.log('');

  console.log(L.C.bold('▸ 只在 B 有值（A 中为空）= ') + onlyB.length + (onlyB.length ? L.C.dim('  即新增') : ''));
  show(onlyB.map(x => () => console.log('   + ' + x.ref + '  B=' + L.fmtVal(x.b))));
  console.log('');
}

console.log(L.C.bold('▸ 两表都有但值不同 = ') + differ.length +
  (differ.length ? L.C.red('  ★ 需要核查') : L.C.green('  ✅ 无')));
show(differ.map(x => () => console.log('   ' + L.C.red('≠') + ' ' + x.ref +
  '  A=' + L.fmtVal(x.a) + '   B=' + L.fmtVal(x.b))));
console.log('');

if (flags.all || flags['only'] === 'all') {
  console.log(L.C.bold('▸ 两表都有且值相同 = ') + same.length);
  show(same.map(x => () => console.log('   = ' + x.ref + '  ' + L.fmtVal(x.v))));
  console.log('');
}

if (flags.json) {
  console.log(JSON.stringify({ sheetA, sheetB, onlyA, onlyB, differ, sameCount: same.length }, null, 2));
}

if (differ.length === 0) {
  console.log(L.C.green('结论: 无"值不同"项 ✅'));
  process.exit(0);
} else {
  console.log(L.C.red('结论: ' + differ.length + ' 处值不同 ✗') +
    L.C.dim('（重建/清空场景属正常，可用 --soft）'));
  process.exit(flags.soft ? 0 : 1);
}
