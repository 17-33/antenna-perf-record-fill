#!/usr/bin/env node
'use strict';
/**
 * check_claims.js —— 打印各表「行 ↔ 频点 / 标签」的实际映射，用于换模板或换机型时核对
 *
 * 用法:
 *   node check_claims.js <x.xlsx> [--rows=N]
 *
 * 做三件事：
 *   1. 列出工作簿的所有工作表名，并按 SKILL.md §2 的语义键做匹配，报告命中/未命中
 *   2. 对每张表打印前 N 行的 A/B/C 列内容（即"序号 / 频率 / LO"一类的行标签）
 *   3. 把实际出现的频点与 §2 的期望频点列表逐一对齐，列出「行 → 频点」映射并标出与文档不符之处
 *
 * 换模板 / 换机型时先跑它，再决定 spec.json 里的单元格。
 */

const L = require('./_lib');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(?:(.*)))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
if (positional.length < 1) {
  console.error('用法: node check_claims.js <x.xlsx> [--rows=N]');
  process.exit(2);
}

const wb = L.Workbook.load(positional[0]);
const N = flags.rows ? parseInt(flags.rows, 10) : 24;

console.log(L.C.bold('【行 ↔ 频点/标签 映射核对】'));
console.log('  文件 ' + positional[0]);
console.log('');

/* ---------- 1. 工作表匹配 ---------- */
console.log(L.C.bold('▸ 工作表匹配（按 SKILL.md §2 的语义键）'));
const names = wb.sheetNames();
console.log('  实际工作表：' + names.join(' ｜ '));
for (const key of Object.keys(L.SHEET_ALIASES)) {
  const hit = wb.resolveSheetByKey(key);
  console.log('  ' + (hit ? L.C.green('✔') : L.C.red('✗')) + ' ' +
    key.padEnd(9) + ' 别名 [' + L.SHEET_ALIASES[key].join(', ') + ']' +
    (hit ? '  →  ' + L.C.bold(hit) : L.C.red('  →  未找到')));
}
console.log('');

/* ---------- 2/3. 逐表打印行标签 + 频点对齐 ---------- */
const expectRows = {
  pattern: L.SHEET_STRUCT.pattern.rowsRX.map((r, i) => [r, L.RX_FREQS[i]]).concat(
    L.SHEET_STRUCT.pattern.rowsTX.map((r, i) => [r, L.TX_FREQS[i]])),
  eirp: L.SHEET_STRUCT.eirp.rows.map((r, i) => [r, L.TX_FREQS[i]]),
  gt: L.SHEET_STRUCT.gt.rows.map((r, i) => [r, L.RX_FREQS[i]]),
  tracking: [],   // 跟踪精度表没有频点列（行 4-13 是第 1~10 次），不做频点对齐
  forward: L.SHEET_STRUCT.forward.rows.map((r, i) => [r, L.RX_FREQS[i]]),
};
const expectHead = {
  pattern: 'RX 行5-12 / TX 行13-20',
  eirp: '行4-11 ↔ TX 47.2…49.8',
  gt: '行4-11 ↔ RX 37.5…40.05',
  tracking: '行4-13 ↔ 第1~10次',
  forward: '行3-10 ↔ RX 37.5…40.05',
};

for (const key of Object.keys(L.SHEET_ALIASES)) {
  const name = wb.resolveSheetByKey(key);
  if (!name) continue;
  const parsed = wb.parsedSheet(name);
  const byRef = new Map([...parsed.cells.values()].map(c => [c.ref, wb.decorate(c)]));

  console.log(L.C.bold('▸ ' + name + '  ') + L.C.dim('（' + key + '｜期望 ' + expectHead[key] + '）'));

  // 找出哪一列是"频点/标签"列：在期望行范围内，A/B/C 里数值匹配率最高的那一列
  const expRows = expectRows[key].map(x => x[0]);
  if (expRows.length === 0) {
    console.log('  ' + L.C.dim('该表没有频点列（行序即"第 N 次"），跳过频点对齐。'));
    console.log('  行  A列            B列            C列');
    for (let r = 1; r <= Math.min(N, 20); r++) {
      const a = byRef.get('A' + r), b = byRef.get('B' + r), c = byRef.get('C' + r);
      const get = d => (d && d.value != null && d.value !== '') ? L.fmtVal(d.value) : '';
      if (!get(a) && !get(b) && !get(c)) continue;
      console.log('  ' + String(r).padStart(3) + ' ' + get(a).padEnd(14) + ' ' +
        get(b).padEnd(14) + ' ' + get(c));
    }
    console.log('');
    continue;
  }
  let bestCol = null, bestScore = -1;
  for (const colName of ['A', 'B', 'C']) {
    let score = 0;
    for (const [r, f] of expectRows[key]) {
      const d = byRef.get(colName + r);
      if (!d || d.value == null) continue;
      const v = Number(d.value);
      if (!isNaN(v) && Math.abs(v - f) < 0.02) score++;
    }
    if (score > bestScore) { bestScore = score; bestCol = colName; }
  }

  console.log('  行  A列            B列            C列            期望频点');
  const rowSet = new Set(expRows);
  for (let r = 1; r <= Math.max(N, Math.max(...expRows) + 2); r++) {
    const a = byRef.get('A' + r), b = byRef.get('B' + r), c = byRef.get('C' + r);
    const only3 = r <= N || rowSet.has(r);
    if (!only3) continue;
    const vend = expectRows[key].find(x => x[0] === r);
    const get = d => (d && d.value != null && d.value !== '') ? L.fmtVal(d.value) : '';
    const mismatch = vend && bestCol ? (() => {
      const d = byRef.get(bestCol + r);
      if (!d || d.value == null) return L.C.yellow('（空）');
      const v = Number(d.value);
      if (isNaN(v)) return '';
      return Math.abs(v - vend[1]) < 0.02 ? L.C.green('=' + L.fmtVal(vend[1]))
        : L.C.red('≠ 实为 ' + v + '，期望 ' + L.fmtVal(vend[1]));
    })() : '';
    const mark = rowSet.has(r) ? L.C.bold(String(r).padStart(3)) : String(r).padStart(3);
    console.log('  ' + mark + ' ' + get(a).padEnd(14) + ' ' + get(b).padEnd(14) + ' ' +
      get(c).padEnd(14) + '  ' + mismatch);
  }
  console.log('  ' + L.C.dim('最匹配的频点列：' + (bestCol || '未识别') +
    '（匹配 ' + bestScore + ' / ' + expectRows[key].length + ' 行）' +
    (bestScore === expectRows[key].length ? '  ✅ 与文档完全一致' : '  ⚠️ 与文档不一致，请据实调整 spec')));
  console.log('');
}

console.log(L.C.dim('提示：若某表的频点列匹配数 < 期望行数，说明模板行序与 SKILL.md §2 不同，' +
  '填表前必须按本输出重定行号。'));
