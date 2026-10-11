#!/usr/bin/env node
/**
 * read_spectrum.js —— 频谱仪零扫方向图截图 → 方向图表 7 个单元格
 *
 * 输入：ocr_image.swift 产出的 OCR JSON（或直接给图片路径，脚本会自己调 OCR）
 * 输出：每张图的 CF / 射频 / marker 明细 / 按 §1–§4 规则判读出的 7 个格
 *
 * 判读规则（严格照 SKILL.md §1、§3、§4）：
 *   ① 时间→角度：|Δ时间(s)| ÷ 10 = 角度(°)
 *   ② 按 ΔdB 语义认列，不按 marker 编号：≈−3→3dB 列；≈−10→10dB 列；−12~−20→旁瓣；−20 以下→不填
 *   ③ 符号定方向：Δ 负 = 左 L / 下 D；Δ 正 = 右 R / 上 U
 *   ④ 接收类射频 = CF + 34.5；发射类 CF 即射频
 *
 * 用法:
 *   node read_spectrum.js --ocr=<dir> --dir=接收|发射            # 批量：从 OCR JSON 目录读
 *   node read_spectrum.js --img=<a.jpg> --dir=接收 [--json]      # 单张：现调 OCR（需 macOS + swiftc 产物）
 *   node read_spectrum.js --ocr=... --dir=发射 --loose           # 放宽判据，输出可疑项
 *
 * ⚠️ 本脚本只做"读数→候选格"，**不做决策**：结果供人工/上层复核后再进 fill_mark.js。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const C = {
  b: s => '\x1b[1m' + s + '\x1b[0m',
  dim: s => '\x1b[2m' + s + '\x1b[0m',
  red: s => '\x1b[31m' + s + '\x1b[0m',
  grn: s => '\x1b[32m' + s + '\x1b[0m',
  yel: s => '\x1b[33m' + s + '\x1b[0m',
  cya: s => '\x1b[36m' + s + '\x1b[0m',
};

/* ---------------- 常量（来自 SKILL.md §2 / §4） ---------------- */
const RX_FREQS = [37.5, 37.75, 38, 39.95, 39.975, 40, 40.025, 40.05];
const TX_FREQS = [47.2, 48, 49.2, 49.7, 49.72, 49.75, 49.78, 49.8];
const RX_LO = 34.5;
const ROW = { rx: i => 5 + i, tx: i => 13 + i };

// 列语义（方位图 / 俯仰图）
const COLS_AZ = { main: 'D', slNeg: 'E', slPos: 'F', lo3Neg: 'J', lo3Pos: 'K', lo10Neg: 'L', lo10Pos: 'M' };
const COLS_EL = { main: 'G', slNeg: 'H', slPos: 'I', lo3Neg: 'N', lo3Pos: 'O', lo10Neg: 'P', lo10Pos: 'Q' };

/* ---------------- 小工具 ---------------- */
/** 去掉空格与单位字母，返回纯数字串（保留小数点的才认）
 *  ⚠️ OCR 偶发伪影：X-Value 列的 4 位小数读数，末尾单位 s/S 有时被额外识别成数字 5，
 *     表现为「4 位小数 + 空格 + 5」（如 "1.8919 5"、被切成三段的 "3.620 2 5"）。
 *  ⚠️ 但不能一律剥末尾 5——"-2.333 5" 的真值就是 -2.3335（4 位小数被 OCR 拆开）。
 *  判据：**去掉空格后恰好是 5 位小数**才剥，正好 4 位则保留。
 */
function toNum(t) {
  let s = String(t == null ? '' : t).trim();
  const flat = s.replace(/\s+/g, '');
  if (/\s5$/.test(s) && /^-?\d+\.\d{4}5$/.test(flat)) s = s.slice(0, -1).trim();
  s = s.replace(/\s+/g, '');
  s = s.replace(/^[A-Za-z$]+/, '').replace(/[A-Za-z$]+$/, '');
  return /^-?\d+\.\d+$/.test(s) ? s : null;
}
/** 十进制「移位」，避免浮点误差：shiftDec('1.4146',1) → '0.14146'；shiftDec('976.1',3) → '0.9761' */
function shiftDec(s, digits) {
  const neg = String(s).startsWith('-');
  let body = neg ? String(s).slice(1) : String(s);
  let [i, f = ''] = body.split('.');
  body = i + f;
  let point = i.length - digits;
  if (point < 0) { body = '0'.repeat(-point) + body; point = 0; }
  let out = (body.slice(0, point) || '0') + (body.slice(point) ? '.' + body.slice(point) : '');
  out = out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return (neg ? '-' : '') + out;
}
const numOf = s => Number(s);

/* ---------------- OCR JSON 解析 ---------------- */
function parseOcr(json) {
  const lines = (json.lines || []).map(l => ({ ...l, n: String(l.text).replace(/\s+/g, '') }));
  const out = { cf: null, ts: [], warn: [], markers: [], raw: lines };

  // CF：形如 "CF3.0GHz"
  for (const l of lines) {
    const m = /^CF(\d+(?:\.\d+)?)GHz$/i.exec(l.n);
    if (m) { out.cf = Number(m[1]); break; }
  }
  // 时间戳 / 告警
  for (const l of lines) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(l.n)) out.ts.push(l.n);
    else if (/^\d{1,2}:\d{2}:\d{2}$/.test(l.n)) out.ts.push(l.n);
    if (/Temperaturedeviation/i.test(l.n)) out.warn.push(String(l.text).trim());
    if (/Alimitreached|UNCAL|IFOVL/i.test(l.n)) out.warn.push(String(l.text).trim());
  }

  // 定位 marker 表：找表头 "Type / X-Value"
  const hdrIdx = lines.findIndex(l => /^X-Value$/i.test(l.n));
  let yTop = 0, xMin = 1;
  if (hdrIdx >= 0) {
    yTop = lines[hdrIdx].y0;
    for (const l of lines) if (l.n === 'Type') xMin = Math.min(xMin, l.x0);
  } else {
    // 退化：按 "Marker Table" 标题
    const mt = lines.find(l => /MarkerTable/i.test(l.n));
    if (mt) yTop = mt.y1;
  }

  // 表体行：y 在表头之下；Type 标签在最左列
  const typeRe = /^(M1|D[1-9])$/;
  const body = lines.filter(l => l.y0 >= yTop - 0.005);
  // 候选 Type 标签：只取最左列，排除图上的 D2/D3 标注
  let cand = body.filter(l => typeRe.test(l.n) && l.x0 <= xMin + 0.05)
    .map(l => ({ type: l.n, y: l.y0, x: l.x0 }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  // 同一行里 Type 列（x≈0.025）与 Ref 列（x≈0.065）各有一个标签，
  // 行内 y 差 ≤0.004，行间 y 差 ≥0.021 → 容差取 0.010，且**只与簇锚点比较**（不可链式，否则相邻行会被吞）
  const rows = [];
  for (const c of cand) {
    const last = rows[rows.length - 1];
    if (last && (c.y - last.y) <= 0.010) {
      if (c.x < last.x) { last.type = c.type; last.x = c.x; }   // 取更靠左的（Type 列）
      continue;
    }
    rows.push({ type: c.type, y: c.y, x: c.x, xs: [] });
  }

  // 把同一 y 带的数值塞进对应行（容差 0.014）
  // ⚠️ X-Value 的时间单位会随量程在 s / ms 之间自动切换（实测有 976.1 ms），必须记录单位
  const nums = body
    .map(l => {
      const raw = String(l.text).replace(/\s+/g, '');
      return { x: l.x0, y: l.y0, v: toNum(l.text), ms: /^m[sS$]$/.test((raw.match(/[a-zA-Z$]+$/) || [''])[0]) };
    })
    .filter(o => o.v !== null)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  for (const r of rows) {
    const near = nums.filter(o => Math.abs(o.y - r.y) <= 0.014);
    near.sort((a, b) => a.x - b.x);
    r.xs = near.map(o => o.v);
    if (near.length >= 1) { r.x = Number(near[0].v); r.xMs = !!near[0].ms; }
    if (near.length >= 2) r.yv = Number(near[1].v);
  }
  out.markers = rows.filter(r => r.x !== undefined && r.yv !== undefined);
  return out;
}

/* ---------------- 语义分类（§1 总则二） ---------------- */
function classify(mk) {
  const isMain = mk.type === 'M1';
  const d = isMain ? null : mk.yv;                 // ΔdB
  let kind;
  if (isMain) kind = 'main';
  else if (Math.abs(d + 3) <= 1.5) kind = '3dB';
  else if (Math.abs(d + 10) <= 2.0) kind = '10dB';
  else if (d > -20) kind = 'sidelobe';
  else kind = 'far';
  const side = isMain ? 'C' : (mk.x < 0 ? 'neg' : (mk.x > 0 ? 'pos' : 'C'));
  return { ...mk, kind, side, delta: d };
}

/* ---------------- 单张图 → 单元格 ---------------- */
function judgeOne(parsed, orient, dirName) {
  const isRX = dirName === '接收';
  const rf = parsed.cf == null ? null : (isRX ? Number((parsed.cf + RX_LO).toFixed(4)) : parsed.cf);
  const freqs = isRX ? RX_FREQS : TX_FREQS;
  // 频点→行：TX 相邻频点最小间隔仅 0.02 GHz（49.7 / 49.72 / 49.78 / 49.8），
  // 且浮点减法会得出 0.019999999999996 这类值 → 容差必须取 0.005，否则会串行。
  const FREQ_TOL = 0.005;
  const idx = (rf == null) ? -1 : freqs.findIndex(f => Math.abs(f - rf) < FREQ_TOL);
  const row = idx >= 0 ? ROW[isRX ? 'rx' : 'tx'](idx) : null;

  const mks = parsed.markers.map(classify);
  const main = mks.find(m => m.kind === 'main');
  const pick = (kind, side) => {
    const c = mks.filter(m => m.kind === kind && m.side === side);
    // 同侧多个 → 取最靠近主瓣的（|Δ时间| 最小）
    c.sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
    return c[0] || null;
  };
  const C3a = pick('3dB', 'neg'), C3b = pick('3dB', 'pos');
  const C10a = pick('10dB', 'neg'), C10b = pick('10dB', 'pos');
  const SLa = pick('sidelobe', 'neg'), SLb = pick('sidelobe', 'pos');

  const COLS = orient === 'az' ? COLS_AZ : COLS_EL;
  const cells = {}, issues = [];
  const put = (col, val, note) => { cells[col] = { value: val, note }; };

  if (main) put(COLS.main, main.yv, 'M1 绝对电平 ' + main.x + ' s');
  else issues.push('缺 M1（主瓣绝对电平）');

  if (SLa) put(COLS.slNeg, SLa.yv, '左/下第一旁瓣 ' + SLa.type);
  else issues.push('缺 ' + (orient === 'az' ? '左' : '下') + '侧旁瓣');
  if (SLb) put(COLS.slPos, SLb.yv, '右/上第一旁瓣 ' + SLb.type);
  else issues.push('缺 ' + (orient === 'az' ? '右' : '上') + '侧旁瓣');

  // 角度列写「绝对值」——符号已由列位置（L/R、D/U）表达，见 §1 总则一「|Δ时间(s)| ÷ 10」
  // ⚠️ 单位可能是 s 或 ms，先归一到秒再 ÷10
  const ang = m => shiftDec(String(shiftDec(String(Math.abs(m.x)), m.xMs ? 3 : 0)), 1);
  const tag = m => m.type + (m.xMs ? ' ' + m.x + 'ms' : ' ' + m.x + 's');
  if (C3a) put(COLS.lo3Neg, ang(C3a), '左/下 3dB ' + tag(C3a) + ' ÷10');
  else issues.push('缺负端 3dB 点（左/下）');
  if (C3b) put(COLS.lo3Pos, ang(C3b), '右/上 3dB ' + tag(C3b) + ' ÷10');
  else issues.push('缺正端 3dB 点（右/上）');

  if (C10a) put(COLS.lo10Neg, ang(C10a), '左/下 10dB ' + tag(C10a) + ' ÷10');
  else issues.push('缺负端 10dB 点（左/下）');
  if (C10b) put(COLS.lo10Pos, ang(C10b), '右/上 10dB ' + tag(C10b) + ' ÷10');
  else issues.push('缺正端 10dB 点（右/上）');

  const far = mks.filter(m => m.kind === 'far');
  return { rf, row, mks, cells, issues, far, warn: parsed.warn, ts: parsed.ts };
}

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const flags = {}; const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2]; else positional.push(a);
}
const orient = (flags.orient || 'auto');
const asJSON = !!flags.json;

function orientOfName(f) {
  if (/方位/.test(f)) return 'az';
  if (/俯仰/.test(f)) return 'el';
  return orient === 'auto' ? null : orient;
}

let jobs = [];
if (flags.ocr) {
  const dir = flags.ocr;
  // 只处理架标测试的方向图截图；跟踪精度目录里混入的同名方向图按「重复投喂」排除
  const only = flags.only ? String(flags.only).split(',') : ['架标测试'];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const base = f.replace(/\.json$/, '');
    if (only.length && !only.some(k => base.includes(k))) continue;
    const o = /方位/.test(base) ? 'az' : /俯仰/.test(base) ? 'el' : null;
    const d = /接收/.test(base) ? '接收' : /发射/.test(base) ? '发射' : null;
    if (!o || !d) continue;
    jobs.push({ name: base, orient: o, dirName: d, json: path.join(dir, f) });
  }
  jobs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
} else if (flags.img) {
  const img = flags.img;
  const o = orientOfName(img);
  const d = /接收/.test(img) ? '接收' : '发射';
  const bin = flags.bin || '/tmp/ocr_image';
  const out = execFileSync(bin, [img, '--json', '--scale=' + (flags.scale || '1')], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const j = JSON.parse(out).results[0];
  jobs.push({ name: path.basename(img), orient: o, dirName: d, parsed: parseOcr(j) });
} else {
  console.error('用法: node read_spectrum.js --ocr=<OCR JSON 目录> | --img=<图片> [--orient=az|el] [--json]');
  process.exit(2);
}

const results = [];
// 人工核对覆盖：OCR 漏行/误读时，用放大图人眼核对后的结果覆盖（SOP 的标准动作）
let overrides = {};
if (flags.override) {
  overrides = JSON.parse(fs.readFileSync(flags.override, 'utf8'));
  if (overrides.images) overrides = overrides.images;
}
for (const job of jobs) {
  const parsed = job.parsed || parseOcr(JSON.parse(fs.readFileSync(job.json, 'utf8')).results[0]);
  const ov = overrides[job.name] || overrides[job.name.replace(/\.json$/, '')];
  if (ov && Array.isArray(ov.markers)) {
    parsed.markers = ov.markers.map(m => ({
      type: m.type, x: Number(m.x), yv: Number(m.yv),
      y: m.y, x0: m.x0, y0: m.y0, xMs: !!m.xMs, overridden: true,
    }));
    if (ov.rf != null) parsed.cf = job.dirName === '接收' ? Number((ov.rf - RX_LO).toFixed(4)) : Number(ov.rf);
    job.overridden = true;
  }
  const r = judgeOne(parsed, job.orient, job.dirName);
  r.name = job.name; r.orient = job.orient; r.dirName = job.dirName; r.cf = parsed.cf;
  r.overridden = !!job.overridden;
  results.push(r);
}

if (asJSON) {
  const payload = JSON.stringify({ results }, null, 2);
  if (flags.out) { fs.writeFileSync(flags.out, payload); console.error('已写出 ' + flags.out + '（' + results.length + ' 张）'); }
  else console.log(payload);
  process.exit(0);
}

/* ---------------- 打印 ---------------- */
let ok = 0, bad = 0;
for (const r of results.sort((a, b) => (a.rf || 0) - (b.rf || 0) || (a.orient === 'az' ? -1 : 1))) {
  const head = '▸ ' + r.name + C.dim('  CF ' + (r.cf == null ? '?' : r.cf) + ' GHz → 射频 ' +
    (r.rf == null ? '?' : r.rf) + ' GHz') + (r.row ? C.cya('  落行 ' + r.row) : C.red('  ✗ 频点无法匹配行'));
  console.log(C.b(head));
  const fmt = m => m.type + '(' + (m.x > 0 ? '+' : '') + m.x + 's, ' + m.yv + 'dB)';
  console.log('   ' + C.dim('marker: ') + r.mks.map(fmt).join('  '));
  const line = Object.keys(r.cells).sort().map(c => c + '=' + r.cells[c].value).join('  ');
  console.log('   ' + C.grn('候选格: ') + line);
  if (r.far.length) console.log('   ' + C.dim('远区(不填): ' + r.far.map(fmt).join(' ')));
  if (r.warn.length) console.log('   ' + C.yel('告警: ' + r.warn[0]));
  if (r.issues.length) { bad++; console.log('   ' + C.red('缺项: ' + r.issues.join(' / '))); }
  else ok++;
  console.log('');
}
console.log(C.b('汇总：') + C.grn('完整 ' + ok) + '  ｜ ' + (bad ? C.red('有缺项 ' + bad) : '无缺项') + '  ｜ 共 ' + results.length + ' 张');
