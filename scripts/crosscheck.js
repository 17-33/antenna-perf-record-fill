#!/usr/bin/env node
/**
 * crosscheck.js —— 用"截图判读结果"独立复核"已填电性能记录表"
 *
 * 场景：手上有 (a) 一批原始截图的判读结果 JSON（read_spectrum.js 的产物），
 *      (b) 一份已经填好值的记录表 xlsx。
 *      本工具**不写任何文件**，只逐格比对，输出"一致 / 不一致 / 表内为空 / 缺判读"清单。
 *
 * 为什么需要它：audit.js 是"填报版 vs 原始记录"的**自比**；
 *      本工具是"截图证据 vs 表内数值"的**他证** —— 用来判定表内数值是否真的
 *      来自这批截图。归档前的最强交叉验证。
 *
 * 判读结果 JSON 格式（来自 read_spectrum.js；数组或 {results:[...]}）：
 *   { "rf": 47.2, "row": 13, "name": "47.2方位.jpg", "orient": "方位"|"俯仰",
 *     "mks": [ { "x": 1.1761, "yv": -2.97, "kind": "main|sidelobe|3dB|10dB", "side": "neg|pos|C" } ] }
 *   约定：x = 扫描相对时间；表内角度(°) = x / 10。仪器切到 ms 档时 x 会 >100，
 *        本工具按 --ms-threshold 自动 ms→s 归一（默认 100）。
 *
 * 表内列映射（SKILL.md §3）：
 *   方位图 → D=主瓣dB  E=负旁瓣dB  F=正旁瓣dB  J=3dB负  K=3dB正  L=10dB负  M=10dB正
 *   俯仰图 → G=主瓣dB  H=负旁瓣dB  I=正旁瓣dB  N=3dB负  O=3dB正  P=10dB负  Q=10dB正
 *
 * 两种模式：
 *   A) 方向图（吃 read_spectrum.js 的判读 JSON）：
 *      node crosscheck.js <记录表.xlsx> <判读.json> [--sheet=方向图] [--csv=out.csv]
 *                         [--json=out.json] [--db-tol=0.02] [--ang-tol=0.00002]
 *                         [--ms-threshold=100] [--quiet]
 *   B) 任意表（吃显式证据 JSON：格 → 截图读数值）：
 *      node crosscheck.js <记录表.xlsx> --evidence=<证据.json> [--csv=out.csv] [--json=out.json]
 *      证据 JSON 格式：{ "sheet": "跟踪精度", "rows": [ { "ref": "B4", "evidence": 273.660,
 *                       "source": "跟踪精度/1.png", "note": "天线方位角-姿态" } ] }
 *
 * 退出码：0 = 全部一致；1 = 存在不一致/缺失；2 = 用法或文件错误
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '_lib.js'));

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const pos = [];
const opt = {};
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2];
  else pos.push(a);
}
if (opt.help || pos.length < 1 || (!opt.evidence && pos.length < 2)) {
  console.error('用法:');
  console.error('  A) 方向图：node crosscheck.js <记录表.xlsx> <判读.json> [--sheet=方向图] [--csv=out.csv] [--json=out.json]');
  console.error('  B) 任意表：node crosscheck.js <记录表.xlsx> --evidence=<证据.json> [--csv=out.csv] [--json=out.json]');
  process.exit(2);
}
const XLSX = pos[0];
const JUDGE = pos[1];
const SHEET = opt.sheet || '方向图';
const DBTOL = opt['db-tol'] !== undefined ? Number(opt['db-tol']) : 0.02;
const ANGTOL = opt['ang-tol'] !== undefined ? Number(opt['ang-tol']) : 0.00002;
const MSTHRESH = opt['ms-threshold'] !== undefined ? Number(opt['ms-threshold']) : 100;
const QUIET = !!opt.quiet;

for (const p of [XLSX, JUDGE].filter(Boolean)) {
  if (!fs.existsSync(p)) { console.error('找不到文件：' + p); process.exit(2); }
}

/* ---------- 读表 ---------- */
let wb;
try { wb = L.Workbook.load(XLSX); }
catch (e) { console.error('✗ 打开记录表失败：' + e.message); process.exit(2); }

const sheetName = wb.resolveSheet(SHEET);
if (!sheetName) {
  console.error('✗ 找不到工作表（含前缀「' + SHEET + '」）：' + wb.sheetNames().join(' / '));
  process.exit(2);
}
const parsed = L.parseSheet(wb.getXml(sheetName));
const cellMap = new Map();
for (const c of parsed.cells.values()) cellMap.set(c.ref, wb.decorate(c));

function cellNum(ref) {
  const c = cellMap.get(ref);
  if (!c) return { v: null, formula: false, fillRgb: null, fontRgb: null, bold: false };
  const formula = !!c.formula;
  const meta = { formula, fillRgb: c.fillRgb || null, fontRgb: c.fontRgb || null, bold: !!c.bold };
  if (c.value === null || c.value === undefined || c.value === '') return Object.assign({ v: null }, meta);
  const n = Number(c.value);
  return Object.assign({ v: Number.isFinite(n) ? n : null, txt: String(c.value) }, meta);
}

/* ---------- 模式 B：通用证据对照（--evidence=<json>） ----------
 * 适用于方向图以外的表（跟踪精度 / 前向链路 / EIRP 正向功率 …）：
 * 显式给出「单元格 → 截图判读值」，逐格与表内比对。
 * 证据文件格式：
 *   { "sheet": "跟踪精度", "tol": 0.0005,
 *     "entries": [ { "ref": "B4", "judged": 273.660, "src": "1.png" }, ... ] }
 *   entries 项可用 "tol" 单独覆盖；"judged": null 表示截图中未定位到。
 */
if (opt.evidence) {
  const evFile = String(opt.evidence);
  if (!fs.existsSync(evFile)) { console.error('找不到证据文件：' + evFile); process.exit(2); }
  const ev = L.readJson(evFile);
  const evSheet = ev.sheet || SHEET;
  const evName = wb.resolveSheet(evSheet);
  if (!evName) { console.error('✗ 找不到工作表：' + evSheet); process.exit(2); }
  const evParsed = L.parseSheet(wb.getXml(evName));
  const evMap = new Map();
  for (const c of evParsed.cells.values()) evMap.set(c.ref, wb.decorate(c));
  const defTol = ev.tol !== undefined ? Number(ev.tol) : 0.02;

  const outRows = [];
  const probs = [];
  let okN = 0;
  const entries = ev.entries || [];
  for (const e of entries) {
    const ref = L.parseRef(e.ref).ref;
    const c = evMap.get(ref);
    const actual = (c && c.value !== null && c.value !== undefined && c.value !== '' && Number.isFinite(Number(c.value)))
      ? Number(c.value) : null;
    const tol = e.tol !== undefined ? Number(e.tol) : defTol;
    let verdict;
    if (e.judged === null || e.judged === undefined) verdict = '缺判读';
    else if (actual === null) verdict = '表内为空';
    else if (Math.abs(actual - Number(e.judged)) <= tol) verdict = '一致';
    else verdict = '不一致';
    if (verdict === '一致') okN++;
    else probs.push({ ref, kind: verdict, judged: e.judged, actual, src: e.src || '',
      note: verdict === '缺判读' ? '截图中未定位到（如该路径本次未接线）'
        : verdict === '表内为空' ? '截图判读 ' + L.fmtNum(e.judged) + '，表内为空'
        : '截图判读 ' + L.fmtNum(e.judged) + ' vs 表内 ' + L.fmtNum(actual) +
          '（差 ' + L.fmtNum(actual - Number(e.judged)) + '）' });
    outRows.push({ ref, judged: e.judged, actual, tol, verdict, src: e.src || '' });
  }

  if (opt.csv) {
    const o = ['工作表,格,判读值,表内值,容差,结论,来源截图'];
    for (const r of outRows) o.push([evName, r.ref, r.judged === null ? '' : r.judged,
      r.actual === null ? '' : r.actual, r.tol, r.verdict, r.src].join(','));
    L.ensureDirFor(opt.csv);
    fs.writeFileSync(opt.csv, '\ufeff' + o.join('\n') + '\n', 'utf8');
  }
  if (opt.json) {
    L.ensureDirFor(opt.json);
    fs.writeFileSync(opt.json, JSON.stringify({ xlsx: XLSX, evidence: evFile, sheet: evName, rows: outRows, problems: probs, okCount: okN }, null, 2), 'utf8');
  }

  if (!QUIET) {
    console.log('记录表 : ' + XLSX + '  →  工作表「' + evName + '」');
    console.log('证据源 : ' + evFile + '（' + entries.length + ' 格）｜ 默认容差 ±' + defTol);
    console.log('');
    console.log(L.C.bold('格     | 判读值      | 表内值      | 结论   | 来源'));
    for (const r of outRows) {
      console.log([
        r.ref.padEnd(5), '|',
        String(r.judged === null ? '—' : L.fmtNum(r.judged)).padEnd(11), '|',
        String(r.actual === null ? '∅' : L.fmtNum(r.actual)).padEnd(11), '|',
        r.verdict.padEnd(6), '|', r.src,
      ].join(' '));
    }
    console.log('');
    console.log('逐格比对：共 ' + entries.length + ' 格，一致 ' + okN + ' 格，问题 ' + probs.length + ' 项');
    for (const p of probs) console.log('  ' + p.ref + ' ' + p.kind + '  ' + p.note);
    console.log(probs.length ? L.C.red('\n问题 ' + probs.length + ' 项') : L.C.green('\n问题 0 项 ✅'));
  }
  process.exit(probs.length ? 1 : 0);
}

/* ---------- 模式 A：方向图判读 JSON ---------- *
 * 读判读结果 */
const raw = L.readJson(JUDGE);
const list = Array.isArray(raw) ? raw : raw.results || raw.items || [];
if (!list.length) { console.error('✗ 判读结果为空：' + JUDGE); process.exit(2); }

/* ---------- 极性判定 ---------- */
const idxByRf = new Map();
list.forEach((r, i) => {
  if (!idxByRf.has(r.rf)) idxByRf.set(r.rf, []);
  idxByRf.get(r.rf).push(i);
});
function orientOf(rec, i) {
  const s = String(rec.orient || rec.dirName || rec.name || '');
  if (/俯仰|EL|elevation/i.test(s)) return 'EL';
  if (/方位|AZ|azimuth/i.test(s)) return 'AZ';
  const peers = idxByRf.get(rec.rf) || [];
  return peers.indexOf(i) === 0 ? 'AZ' : 'EL';
}

const COLS = {
  AZ: { main: 'D', slNeg: 'E', slPos: 'F', lo3Neg: 'J', lo3Pos: 'K', lo10Neg: 'L', lo10Pos: 'M' },
  EL: { main: 'G', slNeg: 'H', slPos: 'I', lo3Neg: 'N', lo3Pos: 'O', lo10Neg: 'P', lo10Pos: 'Q' },
};
const KEYS = ['main', 'slNeg', 'slPos', 'lo3Neg', 'lo3Pos', 'lo10Neg', 'lo10Pos'];
const DB_KEYS = { main: 1, slNeg: 1, slPos: 1 };

/** x → 表内角度（°）：取绝对值（表内只记宽度），ms 档位先归一到 s，再 ÷10 */
function toAngle(x) {
  let t = Math.abs(Number(x));
  if (!Number.isFinite(t)) return null;
  if (t > MSTHRESH) t = t / 1000;  // 仪器切 ms 档
  return t / 10;
}

function cellsOf(rec) {
  const mks = rec.mks || [];
  const pick1 = (kind, side) => { const a = mks.filter((m) => m.kind === kind && m.side === side); return a.length ? a[0] : null; };
  const main = mks.filter((m) => m.kind === 'main');
  const slN = pick1('sidelobe', 'neg'), slP = pick1('sidelobe', 'pos');
  const n3 = pick1('3dB', 'neg'), p3 = pick1('3dB', 'pos');
  const n10 = pick1('10dB', 'neg'), p10 = pick1('10dB', 'pos');
  return {
    main: main.length === 1 ? main[0].yv : null,
    slNeg: slN ? slN.yv : null,
    slPos: slP ? slP.yv : null,
    lo3Neg: n3 ? toAngle(n3.x) : null,
    lo3Pos: p3 ? toAngle(p3.x) : null,
    lo10Neg: n10 ? toAngle(n10.x) : null,
    lo10Pos: p10 ? toAngle(p10.x) : null,
  };
}

/* ---------- 逐格比对 ---------- */
/* ---------- 模式 A：方向图判读 JSON ---------- */
const rows = [];
const problems = [];
let okCount = 0, totalCount = 0;

for (let i = 0; i < list.length; i++) {
  const rec = list[i];
  const orient = orientOf(rec, i);
  const cols = COLS[orient];
  const rowNo = Number(rec.row);
  const got = cellsOf(rec);
  const detail = [];
  for (const key of KEYS) {
    const ref = cols[key] + rowNo;
    const expect = got[key];
    const actual = cellNum(ref);
    totalCount++;
    if (expect === null || expect === undefined || !Number.isFinite(expect)) {
      detail.push({ ref, key, expect: null, actual: actual.v, verdict: '缺判读' });
      problems.push({ ref, kind: '缺判读', note: '截图中该列未定位到（如远区旁瓣无对应列）' });
      continue;
    }
    if (actual.v === null) {
      detail.push({ ref, key, expect, actual: null, verdict: '表内为空' });
      problems.push({ ref, kind: '表内为空', note: '截图判读 ' + L.fmtNum(expect) + '，表内该格为空' });
      continue;
    }
    const tol = DB_KEYS[key] ? DBTOL : ANGTOL;
    const diff = actual.v - expect;
    if (Math.abs(diff) <= tol) {
      okCount++;
      detail.push({ ref, key, expect, actual: actual.v, verdict: '一致' });
    } else {
      detail.push({ ref, key, expect, actual: actual.v, verdict: '不一致' });
      problems.push({ ref, kind: '值不一致',
        note: '截图判读 ' + L.fmtNum(expect) + ' vs 表内 ' + L.fmtNum(actual.v) + '（差 ' + L.fmtNum(diff) + '）' });
    }
  }
  rows.push({ rf: rec.rf, row: rowNo, orient, name: rec.name || '', detail,
    issues: rec.issues || null, warn: rec.warn || null });
}

/* ---------- 输出 CSV / JSON（可选） ---------- */
if (opt.csv) {
  const out = ['频点,行,极性,源图,格,列义,判读值,表内值,结论'];
  for (const r of rows) for (const d of r.detail) {
    out.push([r.rf, r.row, r.orient === 'AZ' ? '方位' : '俯仰', r.name, d.ref, d.key,
      d.expect === null ? '' : d.expect,
      d.actual === null ? '' : d.actual, d.verdict].join(','));
  }
  L.ensureDirFor(opt.csv);
  fs.writeFileSync(opt.csv, '\ufeff' + out.join('\n') + '\n', 'utf8');
}
if (opt.json) {
  L.ensureDirFor(opt.json);
  fs.writeFileSync(opt.json, JSON.stringify(
    { xlsx: XLSX, judge: JUDGE, sheet: sheetName, okCount, totalCount, rows, problems }, null, 2), 'utf8');
}

/* ---------- 控制台 ---------- */
if (!QUIET) {
  console.log('记录表 : ' + XLSX + '  →  工作表「' + sheetName + '」');
  console.log('判读源 : ' + JUDGE + '（' + list.length + ' 条）');
  console.log('容差   : dB ±' + DBTOL + ' ｜ 角度 ±' + ANGTOL + ' ｜ ms 阈值 ' + MSTHRESH);
  console.log('');
  const head = ['频点', '行', '极性', '源图', '主瓣', '旁瓣(负/正)', '3dB(负/正)', '10dB(负/正)', '结论'];
  console.log(L.C.bold(head.join(' | ')));
  for (const r of rows) {
    const get = (k) => r.detail.find((d) => d.key === k);
    const f = (k) => { const d = get(k); return d.ref + '=' + (d.actual === null ? '∅' : L.fmtNum(d.actual)); };
    const bad = r.detail.filter((d) => d.verdict === '不一致' || d.verdict === '表内为空');
    const miss = r.detail.filter((d) => d.verdict === '缺判读');
    let tag = '✓ 一致';
    if (bad.length) tag = '✗ ' + bad.map((d) => d.ref).join(',');
    else if (miss.length) tag = '△ 缺 ' + miss.map((d) => d.ref).join(',');
    console.log([
      String(r.rf).padEnd(6),
      String(r.row).padStart(3),
      (r.orient === 'AZ' ? '方位' : '俯仰'),
      String(r.name || '').slice(0, 20).padEnd(20),
      f('main').padEnd(13),
      (f('slNeg') + ' ' + f('slPos')).padEnd(26),
      (f('lo3Neg') + ' ' + f('lo3Pos')).padEnd(26),
      (f('lo10Neg') + ' ' + f('lo10Pos')).padEnd(26),
      tag,
    ].join(' | '));
  }
  console.log('');
  console.log('逐格比对：共 ' + totalCount + ' 格，一致 ' + okCount + ' 格，问题 ' + problems.length + ' 项');
  if (problems.length) {
    console.log('');
    console.log(L.C.bold('▸ 问题清单'));
    const shown = problems.slice(0, 60);
    for (const p of shown) console.log('  ' + p.ref.padEnd(5) + ' ' + p.kind + '  ' + p.note);
    if (problems.length > shown.length) console.log('  … 其余 ' + (problems.length - shown.length) + ' 项');
  }
  console.log(problems.length ? L.C.red('\n问题 ' + problems.length + ' 项') : L.C.green('\n问题 0 项 ✅'));
}
process.exit(problems.length ? 1 : 0);
