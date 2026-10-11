#!/usr/bin/env node
/**
 * check_pairs.js —— **填表前置闸门**：用「仪器时间戳」验证方向图的切面（方位/俯仰）归属
 *
 * 为什么需要它（2026-10-05 用户指出）：
 *   CF 能唯一确定**频点**（TX: CF=频点；RX: 频点=CF+34.5），但**切面**在单张图里
 *   没有任何可读标识 —— 同一频点的方位图和俯仰图，标题、坐标轴、marker 编号完全一样。
 *   旧协议只能靠"发图顺序"（第 1 张方位、第 2 张俯仰）来认，**顺序一旦发反就是整行错列，
 *   而且 audit / diff / analyze 三道校验全都抓不出来**（数值本身完全正常）。
 *
 * 本脚本给出的硬证据：
 *   每张 FSW 截图的**右下角状态栏**都有仪器实时时钟（`2026-10-01` + `14:05:29`，秒级）。
 *   同一频点的两张图，**先测的那张是方位、后测的是俯仰**（协议约定）。
 *   → 于是"切面"从"按顺序猜"变成"按时序验"。
 *
 * ⚠️ 已验证的**反面结论**（别再走这条弯路）：
 *   试图用"旁瓣对称性 |D3−D2|"当切面指纹 —— **不成立**。三台机器实测：
 *   35 号机 RX 段 AZ 反而比 EL 不对称（AZ 1.3~2.1 / EL 0.06~0.39），
 *   而 32 号机、37 号机 TX 段却是 EL 更不对称。**machine/band 相关，不能当判据。**
 *   另：marker 的绝对时刻（M1 时间）也分不出切面（§18.7 已证）。
 *
 * 用法:
 *   node check_pairs.js --img=a.jpg,b.jpg [--json]
 *   node check_pairs.js --dir=<截图目录> [--exclude=功率,八通道,跟踪]
 *   node check_pairs.js <file1> <file2> ...
 *
 *   --min-gap=15        同一频点两张的最小时间间隔（秒），低于此值判"可疑"
 *   --bin=<path>        指定 OCR 二进制（默认自动编译到 <skill>/.bin/ocr_image）
 *   --assign-out=<file> 写出「文件 → 频点/行/切面」映射，供 fill_mark 前使用
 *
 * 退出码: 0 = 无异常；1 = 有异常（必须停下来问人，不许硬填）；2 = 用法错误
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* ---------------- 常量（与 read_spectrum.js / SKILL.md §2 对齐） ---------------- */
const RX_FREQS = [37.5, 37.75, 38, 39.95, 39.975, 40, 40.025, 40.05];
const TX_FREQS = [47.2, 48, 49.2, 49.7, 49.72, 49.75, 49.78, 49.8];
const RX_LO = 34.5;
const FREQ_TOL = 0.005;
const ROW_RX = i => 5 + i;
const ROW_TX = i => 13 + i;
const BAND_SPLIT = 6.5;   // CF ≥ 6.5 → 发射；否则接收

const C = {
  b: s => '\x1b[1m' + s + '\x1b[0m',
  dim: s => '\x1b[2m' + s + '\x1b[0m',
  red: s => '\x1b[31m' + s + '\x1b[0m',
  grn: s => '\x1b[32m' + s + '\x1b[0m',
  yel: s => '\x1b[33m' + s + '\x1b[0m',
  cya: s => '\x1b[36m' + s + '\x1b[0m',
};

/* ---------------- OCR 二进制：自动编译到 skill 内的稳定位置 ----------------
 * ⚠️ 旧做法把二进制编译到 /tmp/ocr_image —— **重启即丢**，read_spectrum.js 就会报错找不到。
 *    这里改为落在 <skill>/scripts/.bin/，并保留 /tmp 的兼容查找。
 */
function ensureOcrBin(flags) {
  if (flags.bin) {
    if (!fs.existsSync(flags.bin)) fail('--bin 指定的文件不存在：' + flags.bin, 2);
    return flags.bin;
  }
  const local = path.join(__dirname, '.bin', 'ocr_image');
  if (fs.existsSync(local)) return local;
  const src = path.join(__dirname, 'ocr_image.swift');
  if (!fs.existsSync(src)) fail('找不到 ocr_image.swift，无法编译 OCR', 2);
  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', local], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (fs.existsSync(local)) {
      console.error(C.dim('（首次运行：已编译 OCR → ' + local + '）'));
      return local;
    }
  } catch (e) { /* 落到 /tmp 兼容 */ }
  if (fs.existsSync('/tmp/ocr_image')) return '/tmp/ocr_image';
  fail('无法获得 OCR 二进制：请在 ' + __dirname + ' 下执行  swiftc -O ocr_image.swift -o .bin/ocr_image', 2);
}

function fail(msg, code) { console.error(C.red('✗ ' + msg)); process.exit(code || 1); }

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flags = {}; const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2]; else positional.push(a);
}
const minGap = flags['min-gap'] !== undefined ? Number(flags['min-gap']) : 15;
const asJSON = !!flags.json;

/* ---------------- 自检（不需要图片，纯逻辑回归） ----------------
 * node check_pairs.js --selftest
 */
if (flags.selftest) {
  let pass = 0, bad = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? C.grn('  PASS ') : C.red('  FAIL ')) + name +
      (ok ? '' : C.dim('  得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want))));
    ok ? pass++ : bad++;
  };
  const L = arr => arr.map((text, i) => ({ text, x0: 0.01, y0: i / 100, x1: 0.2, y1: i / 100 + 0.02 }));

  console.log(C.b('【check_pairs 自检】'));
  // ① extract：CF / 状态栏日期时间 / marker 表
  const e1 = extract(L(['CF 48.0 GHZ', 'X-Value', 'Type', '2026-10-05', '2026-10-01', '14:05:29', '2026-10-01']));
  t('extract: CF', e1.cf, 48);
  t('extract: 取最底部日期', e1.date, '2026-10-01');
  t('extract: 时间', e1.time, '14:05:29');
  t('extract: marker 表存在', e1.hasMarkerTable, true);
  const e2 = extract(L(['Ref Level 0.00 dBm', '0.0 dB']));
  t('extract: 无 CF 时为 null', e2.cf, null);
  t('extract: 无 marker 表', e2.hasMarkerTable, false);

  // ② toEpoch 与排序
  const a = toEpoch('2026-10-01', '14:05:29'), b = toEpoch('2026-10-01', '14:07:10');
  t('toEpoch: 秒级可比', b - a, 101000);
  t('toEpoch: 非法输入返回 null', toEpoch('', ''), null);

  // ③ 波段判定 + 频点→行（含仪表末位取整）
  const map = cf => {
    const isTX = cf >= BAND_SPLIT;
    const list = isTX ? TX_FREQS : RX_FREQS;
    const rf = isTX ? cf : Number((cf + RX_LO).toFixed(4));
    const i = list.findIndex(f => Math.abs(f - rf) < FREQ_TOL);
    return i < 0 ? null : (isTX ? ROW_TX(i) : ROW_RX(i));
  };
  t('CF 48 → TX 行14', map(48), 14);
  t('CF 3.0 → RX 行5（37.5）', map(3.0), 5);
  t('CF 5.5 → RX 行10（40）', map(5.5), 10);
  t('CF 49.699997 → 行16（末位取整）', map(49.699997), 16);
  t('CF 49.799981 → 行20', map(49.799981), 20);
  t('CF 5.475 → 行9（39.975）', map(5.475), 9);
  t('CF 12 → 不在 16 频点内 → null', map(12), null);

  console.log('');
  console.log(C.b('结果：') + C.grn(pass + ' 通过') + ' ｜ ' + (bad ? C.red(bad + ' 失败') : '0 失败'));
  process.exit(bad ? 1 : 0);
}

/* ---------------- 收集待检图片 ---------------- */
function collect() {
  const exts = /\.(jpe?g|png)$/i;
  const exclude = flags.exclude ? String(flags.exclude).split(',') : ['功率', '八通道', '跟踪'];
  const out = [];
  const push = p => { if (exts.test(p)) out.push(path.resolve(p)); };
  if (flags.img) String(flags.img).split(',').forEach(push);
  positional.forEach(push);
  if (flags.dir) {
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (exts.test(e.name)) {
          if (e.name.startsWith('._') || e.name === '.DS_Store') continue;
          if (exclude.some(k => e.name.includes(k))) continue;
          out.push(path.resolve(p));
        }
      }
    };
    walk(path.resolve(flags.dir));
  }
  return [...new Set(out)];
}
const files = collect();
if (!files.length) fail('没有待检查的图片。用法见文件头注释。', 2);

/* ---------------- OCR → 结构化 ---------------- */
function ocrJson(bin, img, scale) {
  const out = execFileSync(bin, [img, '--json', '--scale=' + scale], { maxBuffer: 64 * 1024 * 1024 }).toString();
  return JSON.parse(out).results[0];
}

/** 从 OCR 行里取 CF / 仪器日期时间 / 是否含 marker 表 */
function extract(lines) {
  const norm = lines.map(l => ({ ...l, n: String(l.text).replace(/\s+/g, '') }));
  const res = { cf: null, date: null, time: null, hasMarkerTable: false, warn: [] };

  for (const l of norm) {
    const m = /^CF(\d+(?:\.\d+)?)GH[Zz]$/i.exec(l.n);
    if (m && res.cf === null) res.cf = Number(m[1]);
    if (/^X-Value$/i.test(l.n)) res.hasMarkerTable = true;
    if (/Temperaturedeviation|Alimitreached|UNCAL|IFOVL/i.test(l.n)) res.warn.push(String(l.text).trim());
  }
  // 状态栏在屏幕最底部 → 取 y0 最大的那个日期 / 时间，避免抓到别处的字段
  const dts = norm.filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l.n)).sort((a, b) => b.y0 - a.y0);
  const tms = norm.filter(l => /^\d{1,2}:\d{2}:\d{2}$/.test(l.n)).sort((a, b) => b.y0 - a.y0);
  if (dts[0]) res.date = dts[0].n;
  if (tms[0]) res.time = tms[0].n;
  return res;
}

const bin = ensureOcrBin(flags);
const records = [];
for (const f of files) {
  const rec = { file: f, name: path.basename(f), err: [], notes: [], issues: [] };
  try {
    rec.sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  } catch (e) { rec.sha = '?'; }
  try {
    const r = ocrJson(bin, f, 1);
    let ex = extract(r.lines || []);
    // 兜底：整图没读到时间戳 → 裁右下角状态栏高倍重试
    if (!ex.date || !ex.time) ex = retryStatusBar(bin, f, ex);
    Object.assign(rec, ex);
    rec.isDirection = rec.cf !== null && rec.hasMarkerTable;
  } catch (e) {
    rec.err.push('OCR 失败：' + e.message);
  }
  records.push(rec);
}

/** 状态栏兜底 OCR：region = x0,y0,w,h（比例），与 ocr_image.swift 的参数一致 */
function retryStatusBar(bin, img, ex) {
  const regions = [
    ['0.68,0.90,0.28,0.10', 8],
    ['0.70,0.92,0.26,0.08', 10],
  ];
  for (const [region, scale] of regions) {
    try {
      const out = execFileSync(bin, [img, '--json', '--region=' + region, '--scale=' + scale],
        { maxBuffer: 64 * 1024 * 1024 }).toString();
      const r = JSON.parse(out).results[0];
      const got = extract(r.lines || []);
      if (got.date) ex.date = ex.date || got.date;
      if (got.time) ex.time = ex.time || got.time;
      if (ex.date && ex.time) break;
    } catch (e) { /* try next */ }
  }
  return ex;
}

/* ---------------- 组装：频点 → 行 / 波段 ---------------- */
function toEpoch(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time || '');
  if (!d || !t) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +t[3]);
}

for (const r of records) {
  r.epoch = toEpoch(r.date, r.time);
  if (r.cf === null || r.cf === undefined) { r.band = null; continue; }
  const isTX = r.cf >= BAND_SPLIT;
  r.band = isTX ? 'TX' : 'RX';
  r.rf = isTX ? r.cf : Number((r.cf + RX_LO).toFixed(4));
  const list = isTX ? TX_FREQS : RX_FREQS;
  const idx = list.findIndex(f => Math.abs(f - r.rf) < FREQ_TOL);
  r.rawRf = r.rf;
  if (idx >= 0) r.rf = list[idx];          // 归到标准频点（仪表末位取整：49.699997 → 49.7）
  r.idx = idx; r.row = idx >= 0 ? (isTX ? ROW_TX(idx) : ROW_RX(idx)) : null;
  if (idx < 0) r.err.push('CF ' + r.cf + ' GHz → 射频 ' + r.rf + ' GHz 不在 16 个频点内');
  if (r.name.includes('方位') || r.name.includes('俯仰')) r.namePlane = r.name.includes('方位') ? 'az' : 'el';
}

/* ---------------- 分组：按行（=频点）时序定切面 ---------------- */
const groups = new Map();
for (const r of records) {
  if (r.row == null) continue;
  if (!groups.has(r.row)) groups.set(r.row, []);
  groups.get(r.row).push(r);
}

const PROBLEM = new Set(['NO_TS', 'EXTRA', 'CONFLICT', 'GAP_TIGHT', 'BAD_CF', 'DUP']);
// 严重度优先级：一个记录可能同时命中多条（如同一张图既重复投喂又与命名矛盾），全部列出
const PRI = ['CONFLICT', 'EXTRA', 'BAD_CF', 'DUP', 'GAP_TIGHT', 'NO_TS'];
const addIssue = (r, code, msg) => { if (!r.issues.some(x => x.code === code && x.msg === msg)) r.issues.push({ code, msg }); };

for (const [row, arr] of groups) {
  arr.sort((a, b) => (a.epoch || 0) - (b.epoch || 0));
  arr.forEach((r, i) => {
    if (r.epoch == null) { r.plane = null; addIssue(r, 'NO_TS', '读不到仪器时间戳 → 无法判切面'); return; }
    r.plane = i === 0 ? 'az' : 'el';
    r.order = i + 1;
  });
  // 同频 > 2 张
  if (arr.length > 2) for (const r of arr) { r.plane = null; addIssue(r, 'EXTRA', '同一频点 ' + arr.length + ' 张（应 2 张）'); }
  // 时间间隔过近（epoch 是 ms，统一换算成秒）
  if (arr.length >= 2 && arr[0].epoch != null && arr[1].epoch != null) {
    const gap = Math.round((arr[1].epoch - arr[0].epoch) / 1000);
    arr[0].gap = arr[1].gap = gap;
    if (gap < minGap) for (const r of arr) addIssue(r, 'GAP_TIGHT', '同频两张仅隔 ' + gap + 's（<' + minGap + 's），疑似同一张重复投喂');
  }
}

// 文件名标注 vs 时序推断 矛盾（最强告警）
for (const r of records) {
  if (r.namePlane && r.plane && r.namePlane !== r.plane) {
    addIssue(r, 'CONFLICT', '文件名标「' + (r.namePlane === 'az' ? '方位' : '俯仰') + '」但时序推断为「' + (r.plane === 'az' ? '方位' : '俯仰') + '」');
  }
}
// 批次内重复文件
const byHash = new Map();
for (const r of records) {
  if (!r.sha || r.sha === '?') continue;
  if (byHash.has(r.sha)) {
    const first = byHash.get(r.sha);
    addIssue(r, 'DUP', '与本批 ' + first.name + ' 内容完全相同（同一文件重复投喂）');
    addIssue(first, 'DUP', '与本批 ' + r.name + ' 内容完全相同（同一文件重复投喂）');
  } else byHash.set(r.sha, r);
}
// 汇总 flag / msg
for (const r of records) {
  if (!r.issues.length) { r.flag = null; r.msg = null; continue; }
  r.flag = PRI.find(c => r.issues.some(x => x.code === c)) || r.issues[0].code;
  r.msg = r.issues.map(x => x.msg).join('；');
}
// 散件（同频只有 1 张）—— 提示，不算问题
for (const [, arr] of groups) {
  if (arr.length === 1 && arr[0].epoch != null && !arr[0].issues.length) {
    arr[0].plane = null;
    arr[0].msg = '本频点只收到 1 张 → 需结合协议判切面（缺对偶图，无法时序互证）';
  }
}

/* ---------------- 输出 ---------------- */
const dirRecs = records.filter(r => r.isDirection);
const otherRecs = records.filter(r => !r.isDirection);

if (asJSON) {
  const payload = {
    generatedAt: new Date().toISOString(),
    minGap,
    records: records.map(r => ({
      file: r.file, name: r.name, sha: r.sha,
      cf: r.cf, rf: r.rf, rawRf: r.rawRf, band: r.band, row: r.row,
      date: r.date, time: r.time,
      order: r.order, plane: r.plane, gap: r.gap,
      flag: r.flag || null, msg: r.msg || null, issues: r.issues,
      err: r.err, notes: r.notes, isDirection: !!r.isDirection,
    })),
  };
  if (flags['assign-out']) {
    const assign = {};
    for (const r of records) if (r.row != null && r.plane) assign[r.name] = { sheet: '方向图', row: r.row, rf: r.rf, plane: r.plane, order: r.order };
    fs.writeFileSync(flags['assign-out'], JSON.stringify(assign, null, 1), 'utf8');
    console.error('已写出切面映射 ' + flags['assign-out']);
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(records.some(r => PROBLEM.has(r.flag)) ? 1 : 0);
}

console.log(C.b('【方向图切面核验】') + C.dim('  判据 = 仪器时间戳时序（先方位、后俯仰）'));
console.log(C.dim('  共 ' + records.length + ' 张（方向图 ' + dirRecs.length + '，非方向图 ' + otherRecs.length + '） ｜ min-gap=' + minGap + 's'));
console.log('');

const pad = (s, n) => {
  const w = String(s).replace(/[\u4e00-\u9fa5]/g, 'xx').length;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
console.log(C.dim(pad('文件', 26) + pad('CF', 11) + pad('射频', 9) + pad('行', 5) + pad('仪器时间', 22) + pad('切面', 7) + '状态'));
console.log(C.dim('─'.repeat(94)));

let problems = [];
for (const r of records.slice().sort((a, b) => (a.row || 99) - (b.row || 99) || (a.epoch || 0) - (b.epoch || 0))) {
  const planeTxt = r.plane === 'az' ? '方位' : r.plane === 'el' ? '俯仰' : '—';
  const hasProb = PROBLEM.has(r.flag);
  const stateTxt = r.err.length ? r.err.join('；')
    : r.flag ? (hasProb ? C.red('✗ ' + r.msg) : C.yel('⚠ ' + (r.msg || r.flag)))
      : C.grn('✓') + (r.gap != null ? C.dim(' 间隔 ' + r.gap + 's') : '');
  if (hasProb) problems.push(r);
  console.log(pad(r.name, 26) +
    pad(r.cf == null ? '—' : r.cf, 11) +
    pad(r.rf == null ? '—' : r.rf, 9) +
    pad(r.row == null ? '—' : r.row, 5) +
    pad(r.date && r.time ? r.date + ' ' + r.time : '—', 22) +
    pad(planeTxt, 7) + stateTxt);
}

console.log('');
const ok = dirRecs.filter(r => !PROBLEM.has(r.flag) && !r.err.length).length;
const unpaired = dirRecs.filter(r => r.plane === null && !r.err.length).length;
console.log(C.b('汇总：') + '方向图 ' + dirRecs.length + ' 张 ｜ ' +
  C.grn('通过 ' + ok) + ' ｜ ' + (problems.length ? C.red('异常 ' + problems.length) : '异常 0') +
  (unpaired ? C.yel(' ｜ 未配对 ' + unpaired + '（需人工确认切面）') : '') +
  (otherRecs.length ? C.dim(' ｜ 已跳过非方向图 ' + otherRecs.length + ' 张') : ''));

if (problems.length) {
  console.log('');
  console.log(C.red(C.b('⛔ 以下条目必须停下来问人，不许硬填：')));
  for (const r of problems) console.log(C.red('   • ' + r.name + ' —— ' + r.msg));
} else if (unpaired) {
  console.log('');
  console.log(C.yel(C.b('⚠ 有 ' + unpaired + ' 张未能与对偶图配对（同频只有 1 张）：')));
  for (const r of dirRecs.filter(x => x.plane === null && !x.err.length)) {
    console.log(C.yel('   • ' + r.name + '（射频 ' + r.rf + ' GHz，落行 ' + r.row + '）—— 时序无从互证，切面按协议/命名确认'));
  }
} else {
  console.log(C.grn('✓ 切面判定有据可依：同频两张时序互证，均为「先方位、后俯仰」'));
}

if (flags['assign-out'] && !asJSON) {
  const assign = {};
  for (const r of records) if (r.row != null && r.plane) assign[r.name] = { sheet: '方向图', row: r.row, rf: r.rf, plane: r.plane, order: r.order };
  fs.writeFileSync(flags['assign-out'], JSON.stringify(assign, null, 1), 'utf8');
  console.log(C.dim('已写出切面映射 ' + flags['assign-out']));
}

process.exit(problems.length ? 1 : 0);
