#!/usr/bin/env node
'use strict';
/**
 * analyze.js —— 全表公式复算 + 合格性判定
 *
 * 用法:
 *   node analyze.js <x.xlsx> [--tol=0.02] [--json]
 *
 * 复算内容（对照 SKILL.md §2 / §10）:
 *   方向图   R = 31000/((N+O)*(J+K))  S = 91000/((P+Q)*(L+M))  T = 10*log10((R+S)/2)
 *   EIRP     Lm = 685.81σ²/λ²，λ(mm)=300/f(GHz)；I(G) = D−(E+F+H)；K = J + I      门限 ≥ 69 dBW
 *   GT       Lm 同上；L(G) = D−(E+G+H)；Tr = 290(10^(NF/10)−1)；M = L−10log10(TA+Tr) 门限 ≥ 25 dB/K
 *   跟踪精度 δA/δE = 读数对零值的 RMS；δ = √(δA²+δE²)；指标 = (方向图!J5+K5+N5+O5)/2/10
 *   前向链路 只列示，不做判定
 *
 * 输出每项：计算值 / 表内值 / 差异 / 判定
 * 退出码: 0 全部合格或无法判定项为「仅列示」；1 存在不合格项；2 参数错误
 *
 * ⚠️ 表内布局认定基于 SKILL.md §2。换模板先跑 check_claims.js 核对行序。
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
if (positional.length < 1) {
  console.error('用法: node analyze.js <x.xlsx> [--tol=0.02]');
  process.exit(2);
}

const wb = L.Workbook.load(positional[0]);
const TOL = flags.tol != null ? Number(flags.tol) : 0.02;

const out = {};
let fail = 0, unknown = 0;

const num = (sheet, ref) => {
  if (!sheet) return null;
  let d;
  try { d = wb.cell(sheet, ref); } catch (e) { return null; }
  if (!d) return null;
  const v = d.value;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};
const r3 = v => v == null ? '—' : String(Math.round(v * 1000) / 1000);

const S = {};
for (const k of Object.keys(L.SHEET_ALIASES)) S[k] = wb.resolveSheetByKey(k);

console.log(L.C.bold('【公式复算 + 合格性判定】'));
console.log('  文件 ' + positional[0]);

// 若工作簿已置 fullCalcOnLoad，说明有人往公式的入参格写过值，
// 公式格的「缓存结果」可能仍是更正前的旧值 —— 此时「计算值 vs 表内值」的差异
// 是预期的，打开 Excel/WPS 会自动重算（SKILL.md §17.5）。
{
  const wbx = wb.map && wb.map.get('xl/workbook.xml');
  const fresh = wbx && /<calcPr\b[^>]*fullCalcOnLoad=/.test(wbx.data.toString('utf8'));
  if (fresh) {
    console.log(L.C.cyan('  ↻ 本工作簿已置 fullCalcOnLoad：公式缓存可能过期，' +
      '下表中「计算值 ≠ 表内值」若出现在依赖本批次改动格的公式上，属预期差异（打开即重算）'));
  }
}
console.log('  表  ' + Object.keys(S).map(k => k + '=' + (S[k] || L.C.red('未找到'))).join(' ｜ '));
console.log('  容差 ±' + TOL);
console.log('');

/* ============ 1. 方向图 ============ */
if (!S.pattern) { console.log(L.C.red('▸ 方向图：未找到该表，跳过')); unknown++; }
else {
  console.log(L.C.bold('▸ 方向图  ') + L.C.dim('R=31000/((N+O)*(J+K))  S=91000/((P+Q)*(L+M))  T=10log10((R+S)/2)'));
  console.log('  行  频点      计算R      表R   计算S      表S   计算T      表T  判定');
  const rows = [];
  const doRow = (r, f, band) => {
    const N_ = num(S.pattern, 'N' + r), O_ = num(S.pattern, 'O' + r);
    const J_ = num(S.pattern, 'J' + r), K_ = num(S.pattern, 'K' + r);
    const P_ = num(S.pattern, 'P' + r), Q_ = num(S.pattern, 'Q' + r);
    const L_ = num(S.pattern, 'L' + r), M_ = num(S.pattern, 'M' + r);
    const tS = num(S.pattern, 'T' + r);
    const rS = num(S.pattern, 'R' + r);
    const sS = num(S.pattern, 'S' + r);
    let calcR = null, calcS = null, calcT = null;
    if (N_ && O_ && J_ && K_ && (N_ + O_) && (J_ + K_)) calcR = 31000 / ((N_ + O_) * (J_ + K_));
    if (P_ && Q_ && L_ && M_ && (P_ + Q_) && (L_ + M_)) calcS = 91000 / ((P_ + Q_) * (L_ + M_));
    if (calcR != null && calcS != null && (calcR + calcS) > 0) calcT = 10 * Math.log10((calcR + calcS) / 2);
    const okT = calcT != null && tS != null ? Math.abs(calcT - tS) <= TOL : null;
    let judge;
    if (calcT == null) judge = L.C.dim('数据不全');
    else if (tS == null) judge = L.C.yellow('表内无值');
    else judge = okT ? L.C.green('一致 ✔') : L.C.red('不一致 ✗ 差 ' + r3(calcT - tS));
    if (okT === false) fail++;
    console.log('  ' + String(r).padStart(3) + ' ' + String(f).padEnd(9) +
      r3(calcR).padStart(9) + r3(rS).padStart(9) + r3(calcS).padStart(9) + r3(sS).padStart(9) +
      r3(calcT).padStart(9) + r3(tS).padStart(9) + '  ' + judge);
    rows.push({ band, row: r, f, calcR, sheetR: rS, calcS, sheetS: sS, calcT, sheetT: tS, ok: okT });
  };
  L.SHEET_STRUCT.pattern.rowsRX.forEach((r, i) => doRow(r, L.RX_FREQS[i], 'RX'));
  L.SHEET_STRUCT.pattern.rowsTX.forEach((r, i) => doRow(r, L.TX_FREQS[i], 'TX'));
  out.pattern = rows;
  console.log('');
}

/* ============ 2. EIRP ============ */
if (!S.eirp) { console.log(L.C.red('▸ EIRP：未找到该表，跳过')); unknown++; }
else {
  console.log(L.C.bold('▸ EIRP  ') + L.C.dim('门限 ≥ 69 dBW（含天线罩）  Lm=685.81σ²/λ²  I=D−(E+F+H)  K=J+I'));
  const sigma = num(S.eirp, 'G4');
  // 不写死合并范围：按实际 XML 判定 G5 是否为 G4 所在合并区的影子格
  const sigmaMerged = wb.shadowRefs(S.eirp).has('G5');
  console.log('  面型标准偏差 σ = ' + r3(sigma) + ' mm' +
    L.C.dim(sigmaMerged ? '（G4 为合并单元格锚点，一台天线一个值）' : '（单格取值）'));
  console.log('  行  频点(TX)   D实测    E罩    F波导    H面损    I计算    I表内    J=P     K计算    K表内  判定(≥69)');
  const rows = [];
  L.SHEET_STRUCT.eirp.rows.forEach((r, i) => {
    const f = L.TX_FREQS[i];
    const D = num(S.eirp, 'D' + r), E = num(S.eirp, 'E' + r), F = num(S.eirp, 'F' + r);
    const H = num(S.eirp, 'H' + r), I = num(S.eirp, 'I' + r), J = num(S.eirp, 'J' + r), K = num(S.eirp, 'K' + r);
    const calcH = sigma != null ? L.faceLoss(sigma, f) : null;
    const calcI = (D != null && E != null && F != null) ? D - (E + F + (calcH != null ? calcH : (H || 0))) : null;
    const calcK = (calcI != null && J != null) ? J + calcI : null;
    let judge = L.C.dim('数据不全');
    if (calcK != null) {
      judge = calcK >= 69 ? L.C.green('合格 ' + r3(calcK)) : L.C.red('不合格 ' + r3(calcK) + ' < 69');
      if (calcK < 69) fail++;
    }
    console.log('  ' + String(r).padStart(3) + ' ' + String(f).padEnd(9) +
      r3(D).padStart(7) + r3(E).padStart(7) + r3(F).padStart(8) + r3(H != null ? H : calcH).padStart(8) +
      r3(calcI).padStart(8) + r3(I).padStart(8) + r3(J).padStart(7) +
      r3(calcK).padStart(9) + r3(K).padStart(8) + '  ' + judge);
    rows.push({ row: r, f, D, E, F, sigma, calcH, sheetH: H, calcI, sheetI: I, J, calcK, sheetK: K,
      pass: calcK != null ? calcK >= 69 : null });
  });
  out.eirp = rows;
  console.log('');
}

/* ============ 3. GT ============ */
if (!S.gt) { console.log(L.C.red('▸ GT：未找到该表，跳过')); unknown++; }
else {
  console.log(L.C.bold('▸ GT  ') + L.C.dim('门限 ≥ 25 dB/K（含天线罩）  L=D−(E+G+H)  Tr=290(10^(NF/10)−1)  M=L−10log10(TA+Tr)'));
  const sigma = num(S.gt, 'F4');
  const TA = num(S.gt, 'I4') != null ? num(S.gt, 'I4') : L.TANT;
  console.log('  面型标准偏差 σ = ' + r3(sigma) + ' mm ｜ TA = ' + r3(TA) + ' K');
  console.log('  行  频点(RX)   D实测    E馈线    G面损    H罩    J=NF   K=Tr计算  L=G计算   L表内   M=G/T计算  M表内  判定(≥25)');
  const rows = [];
  L.SHEET_STRUCT.gt.rows.forEach((r, i) => {
    const f = L.RX_FREQS[i];
    const D = num(S.gt, 'D' + r), E = num(S.gt, 'E' + r), G = num(S.gt, 'G' + r), H = num(S.gt, 'H' + r);
    const I = num(S.gt, 'I' + r) != null ? num(S.gt, 'I' + r) : TA;
    const J = num(S.gt, 'J' + r);
    const K = num(S.gt, 'K' + r), Lv = num(S.gt, 'L' + r), M = num(S.gt, 'M' + r);
    const calcG = sigma != null ? L.faceLoss(sigma, f) : (G != null ? G : null);
    const calcL = (D != null && E != null) ? D - (E + (calcG || 0) + (H || 0)) : null;
    const calcTr = J != null ? 290 * (Math.pow(10, J / 10) - 1) : null;
    const calcM = (calcL != null && calcTr != null) ? calcL - 10 * Math.log10(I + calcTr) : null;
    let judge = L.C.dim('数据不全');
    if (calcM != null) {
      judge = calcM >= 25 ? L.C.green('合格 ' + r3(calcM)) : L.C.red('不合格 ' + r3(calcM) + ' < 25');
      if (calcM < 25) fail++;
    }
    console.log('  ' + String(r).padStart(3) + ' ' + String(f).padEnd(9) +
      r3(D).padStart(7) + r3(E).padStart(8) + r3(G != null ? G : calcG).padStart(8) + r3(H).padStart(6) +
      r3(J).padStart(7) + r3(calcTr).padStart(10) + r3(calcL).padStart(9) + r3(Lv).padStart(8) +
      r3(calcM).padStart(11) + r3(M).padStart(8) + '  ' + judge);
    rows.push({ row: r, f, D, E, sigma, calcG, sheetG: G, H, J, calcTr, sheetTr: K,
      calcL, sheetL: Lv, calcM, sheetM: M, pass: calcM != null ? calcM >= 25 : null });
  });
  out.gt = rows;
  console.log('');
}

/* ============ 4. 跟踪精度 ============ */
if (!S.tracking) { console.log(L.C.red('▸ 跟踪精度：未找到该表，跳过')); unknown++; }
else {
  console.log(L.C.bold('▸ 跟踪精度  ') + L.C.dim('δA/δE = 读数对零值 RMS；δ=√(δA²+δE²)；指标=(方向图!J5+K5+N5+O5)/2/10'));
  const zeroA = num(S.tracking, 'B14');
  const zeroE = num(S.tracking, 'C14');
  const list = [];
  L.SHEET_STRUCT.tracking.rows.forEach((r, i) => {
    const b = num(S.tracking, 'B' + r), c = num(S.tracking, 'C' + r);
    list.push({ n: i + 1, row: r, az: b, el: c,
      dAz: (b != null && zeroA != null) ? b - zeroA : null,
      dEl: (c != null && zeroE != null) ? c - zeroE : null });
  });
  const rms = arr => {
    const v = arr.filter(x => x != null);
    if (!v.length || v.length !== arr.length) return null;
    return Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
  };
  const dA = rms(list.map(x => x.dAz));
  const dE = rms(list.map(x => x.dEl));
  const delta = (dA != null && dE != null) ? Math.sqrt(dA * dA + dE * dE) : null;

  let limit = (() => {
    if (!S.pattern) return null;
    const J = num(S.pattern, 'J5'), K = num(S.pattern, 'K5'), N = num(S.pattern, 'N5'), O = num(S.pattern, 'O5');
    if (J == null || K == null || N == null || O == null) return null;
    return (J + K + N + O) / 2 / 10;
  })();

  console.log('  零值：方位 ' + r3(zeroA) + '°  俯仰 ' + r3(zeroE) + '°');
  console.log('  次  行   方位读数    俯仰读数   Δ方位       Δ俯仰');
  for (const x of list) {
    console.log('  ' + String(x.n).padStart(2) + ' ' + String(x.row).padStart(3) +
      r3(x.az).padStart(11) + r3(x.el).padStart(11) + r3(x.dAz).padStart(11) + r3(x.dEl).padStart(11));
  }
  console.log('  ' + L.C.bold('δA(RMS) = ' + r3(dA) + '°   δE(RMS) = ' + r3(dE) + '°   δ(合成) = ' + r3(delta) + '°'));
  console.log('  ' + L.C.bold('指标(1/10 × 3dB 波束宽度) = ' + r3(limit) + '°'));
  if (delta != null && limit != null) {
    if (delta <= limit) console.log('  ' + L.C.green('判定：合格 ✔  δ ≤ 指标'));
    else { console.log('  ' + L.C.red('判定：不合格 ✗  δ > 指标')); fail++; }
  } else console.log('  ' + L.C.yellow('判定：数据不全，无法判定'));
  console.log('  ' + L.C.yellow('⚠ 口径提醒：本表取 BAT Pro「ANT 状态」面板的【姿态】角。改用"传感器/编码器"角会从合格变不合格（SKILL.md §9.5），必须让用户书面确认口径。'));
  out.tracking = { zeroA, zeroE, list, dA, dE, delta, limit };
  console.log('');
}

/* ============ 5. 前向链路 ============ */
if (!S.forward) { console.log(L.C.red('▸ 前向链路（接收）标定：未找到该表，跳过')); unknown++; }
else {
  console.log(L.C.bold('▸ 前向链路（接收）标定  ') + L.C.dim('只列示，不判定。B=LNB输出  C=测控基带XS05  D=地基基站IN1  E=地基基站IN2'));
  console.log('  行  频点(RX)   B LNB输出   C 基带XS05   D 基站IN1   E 基站IN2');
  const rows = [];
  L.SHEET_STRUCT.forward.rows.forEach((r, i) => {
    const B = num(S.forward, 'B' + r), C_ = num(S.forward, 'C' + r);
    const D = num(S.forward, 'D' + r), E = num(S.forward, 'E' + r);
    console.log('  ' + String(r).padStart(3) + ' ' + String(L.RX_FREQS[i]).padEnd(9) +
      r3(B).padStart(10) + r3(C_).padStart(12) + r3(D).padStart(12) + r3(E).padStart(12));
    rows.push({ row: r, f: L.RX_FREQS[i], B, C: C_, D, E });
  });
  console.log('  ' + L.C.dim('参考电平区间：B ≈ −10~−12 dBm ｜ C ≈ −20~−22 dBm ｜ D ≈ −14~−16 dBm ｜ E 视接线'));
  out.forward = rows;
  console.log('');
}

console.log(L.C.bold('汇总：') + (fail === 0
  ? L.C.green('未发现不合格项 ✅')
  : L.C.red(fail + ' 项不合格 ✗')) +
  (unknown ? L.C.yellow('  ｜  ' + unknown + ' 张表未找到') : ''));

if (flags.json) { console.log(''); console.log(JSON.stringify(out, null, 2)); }
process.exit(fail === 0 ? 0 : 1);
