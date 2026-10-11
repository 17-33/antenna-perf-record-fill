#!/usr/bin/env node
'use strict';
/**
 * audit.js —— 全表复检（SKILL.md §8.0）
 *
 * 用法:
 *   node audit.js <填报版.xlsx> <原始记录.xlsx> [--max=N] [--json] [--quiet]
 *   node audit.js <填报版.xlsx> <原始记录.xlsx> --exempt=U2,U5,A25:A30
 *   node audit.js <填报版.xlsx> <原始记录.xlsx> --exempt-file=exempt.json
 *
 *   exempt.json 形如: { "*": ["U2","U3"], "方向图": ["A25:A30"] }
 *
 * 四类问题（前 3 类 + 待填计数）:
 *   1. 漏标      —— 原始记录该格为空、填报版有值，但未红字加粗（填了没留痕）
 *   2. 错标      —— 红字加粗，但值为空且非公式
 *   3. 值不一致  —— 两表都有值且不同，但填报版未红字加粗（无痕改动，最危险）
 *   4. 待填计数  —— 输入格仍为空（分"蓝底待填"与"已知输入区待填"两类，仅统计不判错）
 *
 * ⚠️ 审计口径（SKILL.md §8.0 明确点名的两个坑）:
 *   - 不能只用"蓝底"当判据：前向链路标定表的输入格没有底色，只认蓝底会漏掉整张表
 *   - 不能跳过空格：否则"蓝底仍待填"永远显示 0，看不出还缺什么
 *   本脚本因此同时统计「蓝底待填」和「已知输入区待填」，并逐格列出。
 *
 * 退出码: 0 = 问题 0 项；1 = 有问题
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
  console.error('用法: node audit.js <填报版.xlsx> <原始记录.xlsx> [--max=N] [--json]');
  process.exit(2);
}
const [fillFile, origFile] = positional;

/* 已知输入区（SKILL.md §2 / §3 落格表）—— 用于「输入区待填」统计 */
const INPUT_ZONES = {
  pattern: {
    // D..Q 为手填列（R/S/T 是公式结果列，不算输入）
    cols: ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'],
    rows: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  },
  eirp: { cols: ['D', 'E', 'F', 'J'], rows: [4, 5, 6, 7, 8, 9, 10, 11], extra: ['G4'] },
  gt: { cols: ['D', 'E', 'J'], rows: [4, 5, 6, 7, 8, 9, 10, 11], extra: ['F4'] },
  tracking: { cols: ['B', 'C'], rows: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  forward: { cols: ['B', 'C', 'D', 'E'], rows: [3, 4, 5, 6, 7, 8, 9, 10] },
};

let work;
try { work = L.Workbook.load(fillFile); }
catch (e) { console.error(L.C.red('✗ 打不开填报版：' + e.message)); process.exit(1); }
let orig;
try { orig = L.Workbook.load(origFile); }
catch (e) { console.error(L.C.red('✗ 打不开原始记录：' + e.message)); process.exit(1); }

const maxList = flags.max ? parseInt(flags.max, 10) : 30;

/* 豁免清单：来源列、批次日志行等"元信息格"不该计入漏标/错标/值不一致
   用法 --exempt=U2,U5,A25:A30        （对所有表生效）
        --exempt=方向图!U2,方向图!A25:A30  （只对指定表生效）
        --exempt-file=exempt.json      （{"方向图":["U2","A25:A30"], "*":["U2"]}）  */
const exemptAll = new Set();
const exemptPerSheet = new Map();
function addExempt(token) {
  const t = String(token).trim();
  if (!t) return;
  let sheet = null, spec = t;
  const i = t.indexOf('!');
  if (i >= 0) { sheet = t.slice(0, i); spec = t.slice(i + 1); }
  const refs = L.expandRange(spec);
  if (sheet) {
    if (!exemptPerSheet.has(sheet)) exemptPerSheet.set(sheet, new Set());
    for (const r of refs) exemptPerSheet.get(sheet).add(r);
  } else {
    for (const r of refs) exemptAll.add(r);
  }
}
if (flags.exempt) for (const t of String(flags.exempt).split(',')) addExempt(t);
if (flags['exempt-file']) {
  const ex = L.readJson(flags['exempt-file']);
  for (const k of Object.keys(ex)) {
    if (String(k).startsWith('_')) continue;            // 文档键（_说明/_注…）不是表名，跳过
    const specs = [].concat(ex[k] == null ? [] : ex[k]);
    for (const spec of specs) {
      if (typeof spec !== 'string' || !spec.trim()) continue;
      // 单个坏条目不应让整轮复检崩在裸栈上（§17.1 第 3 条同类问题）
      try { addExempt(k === '*' ? spec : k + '!' + spec); }
      catch (e) { console.log(L.C.yellow('⚠ 豁免项已跳过（' + k + ' → ' + spec + '）：' + e.message)); }
    }
  }
}
const isExempt = (sheet, ref) => exemptAll.has(ref) || (exemptPerSheet.has(sheet) && exemptPerSheet.get(sheet).has(ref));

console.log(L.C.bold('【全表复检】'));
console.log('  填报版    ' + fillFile);
console.log('  原始记录  ' + origFile);
if (exemptAll.size || exemptPerSheet.size) {
  // ⚠️ 按「原始区间」折叠显示，不要展开成格列表 ——
  //    整列豁免（U1:U1048576，§16.5.1 要求的写法）展开后是 100 万行，
  //    会把真正的审计结论整个淹没（实测踩过）。
  const parts = [];
  const fold = (set) => {
    const rows = [], cols = new Set(), odd = [];
    for (const ref of set) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) { odd.push(ref); continue; }
      cols.add(m[1]);
      if (m[2] !== '1') rows.push(Number(m[2]));   // 行 1 是「整列」的标记，不计入
    }
    // ⚠️ 不用 Math.min(...rows) / [...rows] —— 整列豁免会让数组有 100 万个元素，
    //    展开运算直接爆栈（RangeError: Maximum call stack size exceeded，实测踩过）
    rows.sort((a, b) => a - b);
    const lo = rows[0], hi = rows[rows.length - 1];
    const out = [];
    for (const c of cols) {
      if (rows.length === 0) { out.push(c + '1:' + c + '1048576'); continue; }
      if (hi - lo > 3) out.push(c + lo + ':' + c + hi);
      else for (let i = lo; i <= hi; i++) out.push(c + i);
    }
    return out.concat(odd).join(' ');
  };
  if (exemptAll.size) parts.push('全局 ' + fold(exemptAll));
  for (const [s, set] of exemptPerSheet) parts.push(s + '! ' + fold(set));
  console.log('  豁免(不计漏标) ' + parts.join(' ｜ ') +
    (parts.join('').length > 100 ? L.C.dim('（共 ' + (exemptAll.size + [...exemptPerSheet.values()].reduce((s, v) => s + v.size, 0)) + ' 格，已折叠）') : ''));
}
console.log('');

const result = { 漏标: [], 错标: [], 值不一致: [], 蓝底待填: [], 输入区待填: [], 合并影子格: [], notes: [] };

const sheetKeys = Object.keys(L.SHEET_ALIASES);
const pairs = [];
for (const key of sheetKeys) {
  const a = work.resolveSheetByKey(key);
  const b = orig.resolveSheetByKey(key);
  if (a) pairs.push([key, a, b]);
}
// 填报版里其他未识别的表也一并查一遍（只查与原始记录同名的表）
for (const n of work.sheetNames()) {
  if (pairs.some(p => p[1] === n)) continue;
  let hit = null;
  try { hit = orig.resolveSheet(n); } catch (e) { hit = null; }
  if (hit) pairs.push(['?' + n, n, hit]);
}

for (const [key, nameW, nameO] of pairs) {
  const cellsW = new Map([...work.parsedSheet(nameW).cells.values()].map(c => [c.ref, work.decorate(c)]));
  const cellsO = nameO
    ? new Map([...orig.parsedSheet(nameO).cells.values()].map(c => [c.ref, orig.decorate(c)]))
    : new Map();

  const semKey = key.startsWith('?') ? null : key;
  // 合并区的"影子格"（非左上锚点）：按模板设计应为空，不计入待填
  const shadowW = L.mergedShadowRefs(work.getXml(nameW));
  const shadowHit = [];
  console.log(L.C.bold('▸ ' + nameW + (nameO && nameO !== nameW ? L.C.dim('  ↔ 原始「' + nameO + '」') : '')) +
    L.C.dim('  填报版格 ' + cellsW.size + ' ｜ 原始格 ' + cellsO.size +
      (shadowW.size ? ' ｜ 合并影子格 ' + shadowW.size + '（不计待填）' : '')));

  const all = new Set([...cellsW.keys(), ...cellsO.keys()]);
  for (const ref of all) {
    const w = cellsW.get(ref);
    const o = cellsO.get(ref);
    const wv = w ? w.value : null;
    const ov = o ? o.value : null;
    const wEmpty = wv === null || wv === undefined || wv === '';
    const oEmpty = ov === null || ov === undefined || ov === '';

    if (w && w.isFormula) continue;                     // 公式格不参与
    const wRed = !!(w && w.fontRgb === L.RED && w.bold);
    if (isExempt(nameW, ref)) continue;                 // 来源列 / 日志行等元信息格

    if (!wEmpty && !wRed) {
      if (oEmpty) result.漏标.push({ sheet: nameW, ref, value: wv, note: '原表为空，本版有值' });
      else if (String(wv) !== String(ov)) result.值不一致.push({ sheet: nameW, ref, a: wv, b: ov, note: '两版都有值且不同，未标红' });
    }
    if (wRed && wEmpty && !(w && w.isFormula)) {
      result.错标.push({ sheet: nameW, ref, note: '标红了但值为空' });
    }
    if (wEmpty && w && w.fillRgb === L.BLUE) {
      if (shadowW.has(ref)) shadowHit.push(ref);
      else result.蓝底待填.push({ sheet: nameW, ref });
    }
  }

  if (shadowHit.length) result.合并影子格.push({ sheet: nameW, refs: shadowHit });

  // 已知输入区待填（即使格不存在也要点出来）
  if (semKey && INPUT_ZONES[semKey]) {
    const z = INPUT_ZONES[semKey];
    const refs = [];
    for (const r of z.rows) for (const c of z.cols) refs.push(L.refOf(L.colToNum(c), r));
    for (const e of (z.extra || [])) refs.push(L.parseRef(e).ref);
    for (const ref of refs) {
      const w = cellsW.get(ref);
      const wv = w ? w.value : null;
      const empty = wv === null || wv === undefined || wv === '';
      const isFormula = !!(w && w.isFormula);
      if (empty && !isFormula && !(w && w.fillRgb === L.BLUE) && !shadowW.has(ref)) {
        result.输入区待填.push({ sheet: nameW, ref, zone: semKey });
      }
    }
    if (!nameO) result.notes.push(nameW + '：原始记录中没有对应表，跳过值比对');
  }
  console.log('');
}

const C = L.C;
const dump = (title, arr, fmt, isErr) => {
  console.log(C.bold('▸ ' + title + ' = ') + (arr.length === 0
    ? C.green('无 ✅')
    : (isErr ? C.red(String(arr.length)) : C.yellow(String(arr.length)))));
  const n = Math.min(arr.length, maxList);
  for (let i = 0; i < n; i++) console.log('   ' + fmt(arr[i]));
  if (arr.length > n) console.log(C.dim('   … 还有 ' + (arr.length - n) + ' 项（用 --max=N 调大）'));
  console.log('');
};

dump('漏标（有值未标红）', result.漏标,
  x => x.sheet + '  ' + x.ref + ' = ' + L.fmtVal(x.value) + C.dim('  （' + x.note + '）'), true);
dump('错标（标红却空）', result.错标,
  x => x.sheet + '  ' + x.ref + C.dim('  （' + x.note + '）'), true);
dump('值不一致（与原表不同且未标红）', result.值不一致,
  x => x.sheet + '  ' + x.ref + '  原=' + L.fmtVal(x.b) + '  现=' + L.fmtVal(x.a), true);
dump('蓝底待填计数', result.蓝底待填,
  x => x.sheet + '  ' + x.ref + C.dim('  （蓝底 FF00B0F0，仍为空）'), false);
if (result.合并影子格.length) {
  const tot = result.合并影子格.reduce((n, x) => n + x.refs.length, 0);
  console.log(C.bold('▸ 蓝底但属合并区影子格（按模板设计留空，非待填） = ') + C.dim(String(tot)));
  for (const g of result.合并影子格) {
    console.log('   ' + g.sheet + '  ' + C.dim(g.refs.join(' ')));
  }
}
dump('已知输入区待填计数', result.输入区待填,
  x => x.sheet + '  ' + x.ref + C.dim('  （' + (x.zone || '') + ' 输入格，无底色也算）'), false);

for (const n of result.notes) console.log(C.yellow('⚠ ' + n));
if (result.notes.length) console.log('');

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
  console.log('');
}

const issues = result.漏标.length + result.错标.length + result.值不一致.length;

if (issues === 0) {
  console.log(C.green(C.bold('问题 0 项 ✅')));
  if (!flags.quiet) {
    console.log(C.dim('（待填提示：蓝底 ' + result.蓝底待填.length + ' 格，已知输入区 ' +
      result.输入区待填.length + ' 格 —— 属"还没填"，不计入问题）'));
  }
  process.exit(0);
} else {
  console.log(C.red(C.bold('问题 ' + issues + ' 项')));
  console.log(C.dim('  漏标 ' + result.漏标.length + ' ｜ 错标 ' + result.错标.length +
    ' ｜ 值不一致 ' + result.值不一致.length));
  if (result.漏标.length || result.值不一致.length) {
    console.log(C.dim('  提示：来源列（方向图 U / EIRP L / 跟踪精度 D / 前向链路 F）与批次日志行属元信息格，' +
      '用 --exempt=U2,U5,A25:A30 或 --exempt-file 排除后可让"问题"归零。'));
  }
  process.exit(1);
}
