#!/usr/bin/env node
'use strict';
/**
 * ingest.js —— **收件箱归档器**：把「随手一堆图」变成「按惯例命名、已分类、可直接填表」的归档件
 *
 * 为什么需要它（SKILL.md §18.8 + §0.6 的散装步骤收敛）：
 *   「传图填表」这一步过去全靠人脑，而它有**四个静默出错点**：
 *     ① 分类错（接收/发射、跟踪精度、链路标定 4 条路径）
 *     ② 频点错（RX 图的台面 CF 是中频，必须 +34.5 才是射电频点）
 *     ③ **切面错**（方位/俯仰）—— 整行错列，且 audit/diff/analyze 三道校验全都抓不出来
 *     ④ 同名不同内容被覆盖（`39.95.jpg` 在两个目录都有但内容不同，§4.2）
 *   本脚本把这四件事一次做完，**且判不出来就停手，绝不猜**。
 *
 * 用法:
 *   node ingest.js --case=<机器目录> [--dry-run] [--apply]
 *   node ingest.js --case=<机器目录> --from=<别的目录> --apply
 *   node ingest.js --case=<机器目录> --only=方向图 --apply
 *   node ingest.js --case=<机器目录> --json
 *
 * 参数:
 *   --case=<dir>     机器目录（含 截图/），必填。可直接传 new_case.js 建出来的目录
 *   --from=<dir>     图的来源目录（默认 `<case>/截图/_待归档`）
 *   --apply          真正落盘（默认只 dry-run 打印计划 —— 归档是不可逆动作，先看再动）
 *   --only=<类别>    只处理某一类：方向图|功率|跟踪精度|链路标定（可逗号分隔）
 *   --min-gap=15     同频两张的最小时间间隔（秒），透传给 check_pairs
 *   --clean-dup      把判重（内容与已归档完全相同）的图从收件箱删掉
 *                    —— 默认**保留**在原地供复查，否则每次重跑都会命中判重形成死循环
 *   --json           机器可读输出（供上层编排）
 *   --force          目标同名文件已存在且内容不同时，仍然并存（默认：报冲突并跳过）
 *
 * 分类判定（每一步都有据可依，不靠猜）:
 *   方向图   → 有 CF + 有 marker 表（X-Value）→ check_pairs 的 isDirection
 *            频点: TX 用 CF；RX 用 CF+34.5  → 16 频点表对齐 → 落行
 *            切面: **spawn check_pairs.js 复用其「仪器时间戳定时序」判定**（不重写逻辑）
 *   功率页   → 文件名/内容含「功率」，无 marker 表
 *   跟踪精度 → 文件名形如 1..10.png，或内容是 BAT Pro「ANT 状态」面板
 *   链路标定 → 扫频图但无 marker 表；靠**电平**分 4 条路径（§4.2）：
 *              −10~−12 → B 列(LNB到频谱仪) ｜ −20~−22 → C 列(LNB到测控基带XS05)
 *              −14~−16 → D 列(LNB到地基基站IN1)
 *
 * 三条硬规矩（对应 §0.6 弃权规则）:
 *   - **切面判不出来 → 不落位**（进「待人工确认」区，报告里点名缺哪一项证据）
 *   - **同名不同内容 → 报冲突并跳过**，绝不覆盖（覆盖＝静默丢证据）
 *   - **内容完全相同 → 判重跳过**，日志注明「与第 N 张同一文件」（§4.4）
 *
 * 退出码: 0 = 无异常完成；1 = 有异常（须人工处理）；2 = 用法错误
 */

const L = require('./_lib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
if (flags.help || flags.h || !flags.case) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(flags.help || flags.h ? 0 : 2);
}

const CASE = path.resolve(String(flags.case));
const SHOT = path.join(CASE, '截图');
const INBOX = path.resolve(String(flags['from'] || path.join(SHOT, '_待归档')));
const APPLY = !!flags.apply;
const AS_JSON = !!flags.json;
const MIN_GAP = String(flags['min-gap'] || '15');
const ONLY = flags.only ? String(flags.only).split(',').map(s => s.trim()).filter(Boolean) : null;

const RX = L.RX_FREQS, TX = L.TX_FREQS, LO = L.LO_RX, TOL = 0.005;
const PENDING_DIR = path.join(SHOT, '_待人工确认');
const LIST_MD = path.join(SHOT, '截图清单.md');
const LOG_DIR = path.join(CASE, '批次', '日志');

function fail(msg, code) { console.error(L.C.red('✗ ' + msg)); process.exit(code === undefined ? 1 : code); }

/* ---------------- 1. 收集收件箱里的图 ---------------- */
const EXTS = /\.(jpe?g|png|bmp|tiff?|webp)$/i;
if (!fs.existsSync(INBOX)) fail('收件箱不存在：' + INBOX + '\n  先跑 new_case.js 建目录，或用 --from=<目录> 指定来源。', 2);

const picked = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXTS.test(e.name)) continue;
    if (e.name.startsWith('._') || e.name === '.DS_Store') continue;
    picked.push(p);
  }
})(INBOX);

if (!picked.length) {
  if (AS_JSON) {
    // --json 契约：任何情况下都输出合法 JSON（空 plans），否则调用方解析必炸
    console.log(JSON.stringify({
      case: CASE, inbox: INBOX, applied: false,
      counts: { dir: 0, power: 0, tracking: 0, forward: 0, pending: 0, dup: 0, conflict: 0 },
      plans: [],
    }, null, 2));
    process.exit(0);
  }
  console.log(L.C.dim('收件箱是空的：' + INBOX));
  console.log(L.C.dim('  把图原样丢进去（别改名、别分类），再跑一次。'));
  process.exit(0);
}
picked.sort();

// ⚠️ 人读的 banner / 计划表一律走 **stderr** —— stdout 只留给 --json 的机器输出，
//    否则调用方 `JSON.parse(stdout)` 会被这些行炸掉（实测踩过）。
const say = (...a) => console.error(...a);
say(L.C.bold('【收件箱归档】'));
say('  机器  ' + CASE);
say('  来源  ' + INBOX + L.C.dim('（' + picked.length + ' 张）'));
say('  模式  ' + (APPLY ? L.C.yellow('落盘') : L.C.dim('试运行（加 --apply 才真动）')));
say('');
/* ---------------- 2. 方向图：spawn check_pairs 复用切面判定 ----------------
 * ⚠️ 为什么不自己再实现一遍 CF/时间戳逻辑：
 *    check_pairs 是全 skill 唯一的「仪器时间戳定时序」实现（§19.4），
 *    重写第二份 = 两个判据迟早分叉。§17.2 的原则：判据下沉到一处，所有消费者共用。
 */
let pairInfo = new Map();     // basename → check_pairs 的 record
let pairFatal = null;

try {
  const out = execFileSync(process.execPath, [
    path.join(__dirname, 'check_pairs.js'),
    '--img=' + picked.map(p => path.resolve(p)).join(','),
    '--json', '--min-gap=' + MIN_GAP,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const j = JSON.parse(out);
  for (const r of j.records || []) pairInfo.set(path.basename(r.file), r);
} catch (e) {
  // check_pairs 退出码 1 = 有异常码（CONFLICT/DUP/GAP_TIGHT…），但 stdout 仍是合法 JSON
  const out = (e.stdout || '').toString();
  try {
    const j = JSON.parse(out);
    for (const r of j.records || []) pairInfo.set(path.basename(r.file), r);
    pairFatal = j.records.filter(r => r.flag);
  } catch (_) {
    fail('check_pairs 未能解析方向图证据（这是硬证据，缺了不能猜）：\n' +
      ((e.stderr || '') + (e.message || '')).toString().slice(0, 800));
  }
}

/* ---------------- 2b. 非方向图：轻量 OCR 探测 ----------------
 * 为什么单独探一次：check_pairs 只关心「有没有 CF + marker 表」，
 * 对网页截图（BUC 功率页、链路标定页）它一律给 isDirection=false 就走开了。
 * 而「这是功率页吗」「正向功率是多少 dBm」只能看内容 —— 文件名是乱的。
 * 只对**非方向图**探测，方向图的路已经由 check_pairs 走完，不重复 OCR。
 */
function ensureOcrBin() {
  const local = path.join(__dirname, '.bin', 'ocr_image');
  if (fs.existsSync(local)) return local;
  const src = path.join(__dirname, 'ocr_image.swift');
  if (!fs.existsSync(src)) return null;
  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', local], { stdio: ['ignore', 'ignore', 'pipe'] });
    return local;
  } catch (e) { return null; }
}
const ocrBin = ensureOcrBin();
if (ocrBin) {
  for (const p of picked) {
    const name = path.basename(p);
    const rec = pairInfo.get(name);
    if (rec && rec.isDirection) continue;       // 方向图已由 check_pairs 判过
    try {
      const out = execFileSync(ocrBin, [p, '--json', '--scale=2'],
        { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
      const j = JSON.parse(out);
      const txt = (j.results && j.results[0] && j.results[0].lines || [])
        .map(l => String(l.text)).join(' ');
      if (rec) rec.__ocrText = txt;
      else {
        // check_pairs 没收录（可能是非图片或 OCR 失败），仍留一份文本供分类
        const fake = { name, isDirection: false, cf: null, __ocrText: txt };
        pairInfo.set(name, fake);
      }
    } catch (e) { /* 探测失败不致命：后面的分类会把它归「待确认」 */ }
  }
}

/** 全量哈希一次已归档区，之后按 sha 反查「这张图是不是已经归档过了」 */
const archiveIndex = new Map();
(function indexArchive() {
  if (!fs.existsSync(SHOT)) return;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (path.resolve(p) === path.resolve(INBOX) || path.resolve(p) === path.resolve(PENDING_DIR)) continue;
        walk(p); continue;
      }
      if (!EXTS.test(e.name) || e.name.startsWith('._')) continue;
      const s = sha16(p);
      if (s && s !== '?') archiveIndex.set(s, p);
    }
  })(SHOT);
})();

/** 若该图已在归档区，返回一条「幂等跳过」计划；否则 null */
function findExisting(src) {
  const s = sha16(src);
  if (!s || s === '?') return null;
  const hit = archiveIndex.get(s);
  if (!hit) return null;
  return {
    src, status: 'dup', kind: '已归档',
    destRel: path.relative(SHOT, hit),
    note: '内容与已归档的 ' + path.relative(SHOT, hit) + ' 完全相同（SHA256 一致）→ 幂等跳过，不重复落位（§4.4）',
  };
}

/* ---------------- 3. 逐张分类 → 落位计划 ---------------- */
function sha16(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
  catch (e) { return '?'; }
}
function freqOf(cf) {
  if (cf == null) return null;
  if (cf >= 6.5) {
    const i = TX.findIndex(f => Math.abs(f - cf) < TOL);
    return i >= 0 ? { band: 'TX', rf: cf, row: 13 + i, f: TX[i] } : null;
  }
  const rf = Number((cf + LO).toFixed(4));
  const i = RX.findIndex(f => Math.abs(f - rf) < TOL);
  return i >= 0 ? { band: 'RX', rf, row: 5 + i, f: RX[i] } : null;
}
const pad2 = n => String(n).padStart(2, '0');

/** 方向图的切面判定 —— 三级证据，逐级降级（§0.6 / §19） */
function planeOf(name, rec) {
  // ① 用户明说（文件名带标识）—— 最高优先级，但与时序矛盾时报 CONFLICT 而非压过去
  if (/方位/.test(name)) return { plane: 'az', via: '文件名' };
  if (/俯仰/.test(name)) return { plane: 'el', via: '文件名' };
  // ② 时序推断（check_pairs）
  if (rec && rec.plane) return { plane: rec.plane, via: '仪器时间戳时序' };
  // ③ 判不了
  return { plane: null, via: null };
}

const plans = [];   // { src, destRel, kind, why, cells, plane, status, note }
const seenSha = new Map();
let nDir = 0, nPow = 0, nTrk = 0, nFwd = 0, nAclr = 0, nPend = 0, nDup = 0, nConflict = 0;

// 收件箱内先做一遍 sha 判重（同一批内）
for (const p of picked) {
  const s = sha16(p);
  if (seenSha.has(s)) {
    plans.push({ src: p, status: 'dup', note: '与本批 ' + path.basename(seenSha.get(s)) + ' 内容完全相同（SHA256 一致）→ 判重跳过' });
    nDup++;
  } else seenSha.set(s, p);
}

for (const p of picked) {
  if (plans.some(x => x.src === p)) continue;
  const name = path.basename(p);
  const rec = pairInfo.get(name) || null;

  /* --- 3.0 幂等前置：这张图是否已经归档过了？ ---
   * ⚠️ 顺序很重要：必须在**切面判定之前**做。
   *  否则「重发一张已归档过的图」会因为本次只有它一张、缺对偶图无法时序互证，
   *  被误判成「切面待确认」—— 而它其实早已归档，正确的结论是**幂等跳过**。
   */
  {
    const dup = findExisting(p);
    if (dup) { plans.push(dup); nDup++; continue; }
  }

  /* --- 3.1 方向图（有 CF + marker 表） --- */
  if (rec && rec.isDirection) {
    if (ONLY && !ONLY.includes('方向图')) continue;
    const fq = freqOf(rec.cf);
    const pl = planeOf(name, rec);
    const dirCn = rec.band === 'TX' ? '发射' : '接收';

    if (!fq) {
      plans.push({ src: p, status: 'pending', kind: '方向图', destRel: '_待人工确认/' + name,
        note: 'CF ' + rec.cf + ' GHz → 射频 ' + (rec.cf >= 6.5 ? rec.cf : (rec.cf + LO).toFixed(4)) + ' GHz 不在 16 个频点内（异常码 BAD_CF）' });
      nPend++; continue;
    }
    if (!pl.plane) {
      plans.push({ src: p, status: 'pending', kind: '方向图', destRel: '_待人工确认/' + name,
        note: '切面判不出来 —— ' + (rec.time ? '本频点只收到 1 张，缺对偶图无法时序互证' : '读不到仪器时间戳（异常码 NO_TS）') + '。请补对偶图，或书面指定切面' });
      nPend++; continue;
    }
    // 文件名与时序矛盾 → 停手（§0.6：两者都是证据，冲突说明证据链断了）
    const named = /方位/.test(name) ? 'az' : /俯仰/.test(name) ? 'el' : null;
    if (named && rec.plane && named !== rec.plane) {
      plans.push({ src: p, status: 'pending', kind: '方向图', destRel: '_待人工确认/' + name,
        note: 'CONFLICT：文件名标「' + (named === 'az' ? '方位' : '俯仰') + '」但时序推断为「' + (rec.plane === 'az' ? '方位' : '俯仰') + '」—— 证据冲突，须人裁决' });
      nPend++; continue;
    }

    const destName = String(fq.f) + (pl.plane === 'az' ? '方位' : '俯仰') + path.extname(p).toLowerCase().replace('.jpeg', '.jpg');
    const destRel = path.join('架标测试', dirCn, destName);
    const COLS = pl.plane === 'az' ? ['D', 'E', 'F', 'J', 'K', 'L', 'M'] : ['G', 'H', 'I', 'N', 'O', 'P', 'Q'];
    plans.push({
      src: p, kind: '方向图', status: 'ok', destRel, destName,
      sheet: '方向图', row: fq.row, rf: fq.rf, band: fq.band, plane: pl.plane, planeVia: pl.via,
      cells: COLS.map(c => c + fq.row).join(' '),
      cfSeen: rec.cf, ts: (rec.date || '') + ' ' + (rec.time || ''),
      why: dirCn + ' ' + fq.f + 'GHz ' + (pl.plane === 'az' ? '方位' : '俯仰') + '（CF ' + rec.cf + ' → 射频 ' + fq.rf + '，落行 ' + fq.row + '，切面依据：' + pl.via + '）',
    });
    nDir++;
    continue;
  }

  /* --- 3.2 跟踪精度（1..10.png / BAT Pro 面板） --- */
  if (/^\d{1,2}\.(png|jpg|jpeg)$/i.test(name) && !/架标|频谱|功率/.test(name)) {
    const n = parseInt(name, 10);
    if (n >= 1 && n <= 10) {
      if (ONLY && !ONLY.includes('跟踪精度')) continue;
      plans.push({
        src: p, kind: '跟踪精度', status: 'ok', destRel: path.join('跟踪精度', n + '.png'),
        sheet: '跟踪精度', row: n + 3, cells: 'B' + (n + 3) + ' C' + (n + 3),
        why: '截图编号 ' + n + ' → 表内行 ' + (n + 3) + '（姿态角，§2.4）',
      });
      nTrk++; continue;
    }
  }

  /* --- 3.3 接收链路标定（扫频但无 marker 表 → 靠电平分 4 条路径，§4.2） --- */
  if (/LNB|链路|标定|频谱仪|测控基带|基站/i.test(name) || (rec && rec.cf == null && rec.hasMarkerTable === false && /[\\/](接收链路标定)[\\/]/.test(p))) {
    if (ONLY && !ONLY.includes('链路标定')) continue;
    // 电平读数：check_pairs 不采，这里只做「路径名优先 + 留待人工确认」
    const byName = /频谱仪/.test(name) ? 'LNB到频谱仪'
      : /测控基带|XS05/i.test(name) ? 'LNB到测控基带XS05'
      : /IN1/i.test(name) ? 'LNB到地基基站IN1'
      : /IN2/i.test(name) ? 'LNB到地基基站IN2' : null;
    // 频点同样只按 RX 频点表反查（避免 IMG_0008 之类误读，见功率分支的注释）
    const fkey = RX.find(f => new RegExp('(^|[^\\d.])' + f + '(?![\\d])').test(name)) || null;
    const fInRx = fkey != null;
    if (!byName) {
      plans.push({ src: p, status: 'pending', kind: '链路标定', destRel: path.join('_待人工确认', name),
        note: '同名文件陷阱（§4.2）：`39.95.jpg` 等在「LNB到频谱仪」与「LNB到测控基带XS05」都有但内容不同。判据是**电平**（−10~−12→B / −20~−22→C / −14~−16→D）+ 仪表时间戳连续性 —— 请在消息里说明这条图走哪条路径' });
      nPend++; continue;
    }
    if (!fInRx) {
      plans.push({ src: p, status: 'pending', kind: '链路标定', destRel: path.join('_待人工确认', name),
        note: '「' + name + '」里读不到 8 个接收频点之一 —— 可能是中频(CF) 被误当射频写进了文件名。落格要的是**射频频点**（RX 台面 CF 还要 +' + LO + '，§4.1）' });
      nPend++; continue;
    }
    plans.push({
      src: p, kind: '链路标定', status: 'ok', destRel: path.join('接收链路标定', byName, fkey + '.jpg'),
      sheet: '前向链路（接收）标定', row: RX.indexOf(fkey) + 3,
      cells: (/频谱仪/.test(byName) ? 'B' : /XS05/.test(byName) ? 'C' : 'IN1'.test(byName) ? 'D' : 'E') + (RX.indexOf(fkey) + 3),
      why: '接收链路 ' + byName + ' ' + fkey + 'GHz（落行 ' + (RX.indexOf(fkey) + 3) + '，填扫频峰值游标）',
    });
    nFwd++; continue;
  }

  /* --- 3.3b ACLR / 八通道（旁证截图，**不入表**，§3） ---
   * 必须排在 3.4 功率分支**之前**：ACLR 图同样是频谱仪截图、也带 dBm，
   * 若先落进功率分支会被误当成 BUC 正向功率页 → 错填 EIRP 的 J 列。
   * 判据（实测 ACLR 页特征）：仪器界面有 `ACLR` / `Center Frequency <f> GHz` / 多条 -dBm- 门限线。
   * 落位到 截图/EIRP/，只作旁证、不产生任何 cells。
   */
  {
    const t = (rec && rec.__ocrText) || '';
    const isAclr = /ACLR/i.test(t) || /八通道/i.test(name);
    if (isAclr) {
      if (ONLY && !ONLY.includes('ACLR')) continue;
      const cfM = /Center Frequency\s*([\d.]+)\s*GHz/i.exec(t);
      const destName = '八通道功率' + (cfM ? '_' + cfM[1] + 'GHz' : '') + '.png';
      plans.push({
        src: p, kind: 'ACLR', status: 'ok', destRel: path.join('EIRP', destName),
        sheet: null, row: null, cells: null,
        why: 'ACLR / 八通道功率（**旁证，不入表**' + (cfM ? '；读到中心频率 ' + cfM[1] + ' GHz' : '') + '）',
      });
      nAclr++; continue;
    }
  }

  /* --- 3.4 功率页 --- */
  // 判据分两层：
  //  a) 文件名带「功率 / 八通道 / ACLR」—— 可靠，直接认
  //  b) 文件名无线索时，靠**内容弱信号**兜底：BUC 后台页/VNC 远程截屏的特征是
  //     「有 dBm 读数 + 有 BUC 字样（常被 OCR 读成 BUCH/BUCEF）+ 有电压/电流/温度」
  //     ⚠️ 实测（37 号机 VNC 截屏）：中文标签 OCR 全是乱码，**认不出「正向功率」四字**，
  //     所以只能认到「这是一张 BUC 后台页」；**具体是哪路功率、哪个频点仍须人工/文件名给**。
  //     绝不在这里猜 dBm 值 —— 认错参数名 = 填错 EIRP 表 J 列。
  let looksPower = /功率|八通道|ACLR/i.test(name);
  if (!looksPower) {
    const t = (rec && rec.__ocrText) || '';
    const sig = {
      dbm: /dBm/i.test(t),
      buc: /BUC|BUCH|BUCEF/i.test(t),
      vnc: /noVNC|192\.168\.\d+\.\d+/i.test(t),
      volts: /\d+\s*V\b/.test(t),
    };
    const score = (sig.dbm ? 2 : 0) + (sig.buc ? 2 : 0) + (sig.vnc ? 1 : 0) + (sig.volts ? 1 : 0);
    looksPower = score >= 4;
    if (looksPower) {
      looksPower = { weak: true, sig, score };
    }
  }
  if (looksPower) {
    if (ONLY && !ONLY.includes('功率')) continue;
    // 频点只从「像频点的数字」里取：TX 频点都是 47.2…49.8，
    // ⚠️ 必须先按已知 TX 频点表反查，不能盲取文件名里的数字 ——
    //    `IMG_0008.png` 会把「0008」读成频点 8、`47.2功率.png` 才读得到 47.2。
    const fkey = TX.find(f => new RegExp('(^|[^\\d.])' + f + '(?![\\d])').test(name)) || null;
    const fInTx = fkey != null;
    // 功率网页**不显示频率**（§4.3）→ 频点只能来自文件名。
    // ⚠️ 中文标签 OCR 不可靠（VNC 截屏全是乱码），因此这里**不自动读 dBm 值**，
    //    只把「疑似正向功率读数」作为参考列出，落格值仍要求人工确认（EIRP J = dBm−30）。
    const txt = (rec && rec.__ocrText) || '';
    const dbmAll = [...txt.matchAll(/(-?\d+(?:\.\d+)?)\s*dBm/gi)].map(m => Number(m[1]));
    const weak = looksPower && typeof looksPower === 'object';
    const refTxt = weak
      ? '｜ 内容弱信号认出这是 BUC 后台页（' +
        Object.entries(looksPower.sig).filter(([, v]) => v).map(([k]) => k).join('+') +
        '），但**中文标签 OCR 不可靠、图上也不显示频率** → 频点与功率值都须人工给' +
        (dbmAll.length ? '（页面上读到 dBm 数：' + dbmAll.join(' / ') + '，**未确认是哪一路，不作数**）' : '')
      : '';
    if (!fInTx) {
      plans.push({ src: p, status: 'pending', kind: '功率', destRel: path.join('_待人工确认', name),
        note: '认得出是功率页，但**功率网页不显示频率**（§4.3），频点只能来自文件名 —— ' +
          '而「' + name + '」里读不到 8 个 TX 频点之一' + refTxt +
          '。请改名为「<频点>功率.png」（如 47.2功率.png）再收一次' });
      nPend++; continue;
    }
    plans.push({
      src: p, kind: '功率', status: 'ok', destRel: path.join('架标测试', '发射', fkey + '功率.jpg'),
      sheet: 'EIRP-公式法', row: TX.indexOf(fkey) + 4, cells: 'J' + (TX.indexOf(fkey) + 4),
      dbmCandidates: dbmAll,
      why: 'BUC 正向功率 ' + fkey + 'GHz（落行 ' + (TX.indexOf(fkey) + 4) + '，落格值 = 正向功率 dBm − 30，§2.2）' +
        (weak ? refTxt : (dbmAll.length ? '｜页面上读到 dBm：' + dbmAll.join(' / ') + '（请核是哪一路）' : '')),
    });
    nPow++; continue;
  }

  /* --- 3.5 认不出来 --- */
  plans.push({ src: p, status: 'pending', kind: '未知', destRel: path.join('_待人工确认', name),
    note: '既无 CF/marker 表（不是频谱方向图），文件名也无类别线索，图上也没读到功率/链路字样' +
      ' —— 归不了类。多半不是本单截图（误发），或是不属于这 5 类表的其它材料' });
  nPend++;
}

/* ---------------- 4. 检查目标冲突（绝不覆盖） ---------------- */
for (const pl of plans) {
  if (pl.status !== 'ok') continue;
  const dest = path.join(SHOT, pl.destRel);
  if (!fs.existsSync(dest)) continue;
  const a = sha16(pl.src), b = sha16(dest);
  if (a && a === b) {
    pl.status = 'dup';
    pl.note = '目标已存在且内容完全相同 → 幂等跳过';
    nDup++;
  } else {
    pl.status = 'conflict';
    pl.note = '目标已存在但内容不同（源 ' + a + ' / 已有 ' + b + '）→ **不覆盖**，请人工裁决（§4.2 同名文件陷阱）';
    nConflict++;
  }
}

/* ---------------- 5. 输出计划 ---------------- */
const okPlans = plans.filter(p => p.status === 'ok');
const P = 14;
const pad = (s, w) => { s = String(s); let n = 0; for (const c of s) n += c.charCodeAt(0) > 255 ? 2 : 1; return s + ' '.repeat(Math.max(0, w - n)); };

say(L.C.bold('▸ 落位计划（' + okPlans.length + ' 张可落）'));
for (const p of plans) {
  const tag = p.status === 'ok' ? L.C.green('落位')
    : p.status === 'dup' ? L.C.dim('判重')
    : p.status === 'conflict' ? L.C.red('冲突')
    : L.C.yellow('待确认');
  say('  ' + tag + '  ' + pad(p.kind || '—', 10) + pad(p.destRel || '—', 42) + L.C.dim(p.why || p.note || ''));
}
say('');

if (pairFatal && pairFatal.length) {
  say(L.C.yellow(L.C.bold('⚠ check_pairs 报出以下异常码（已在上表体现，未硬填）：')));
  for (const r of pairFatal) say(L.C.yellow('   • ' + r.name + ' [' + r.flag + '] ' + (r.msg || '')));
  say('');
}

say(L.C.bold('汇总：') +
  L.C.green('方向图 ' + nDir) + L.C.dim(' ｜ ') +
  L.C.green('功率 ' + nPow) + L.C.dim(' ｜ ') +
  L.C.green('跟踪精度 ' + nTrk) + L.C.dim(' ｜ ') +
  L.C.green('链路标定 ' + nFwd) + L.C.dim(' ｜ ') +
  (nAclr ? L.C.dim('ACLR旁证 ' + nAclr + ' ') + L.C.dim(' ｜ ') : '') +
  (nPend ? L.C.yellow('待人工确认 ' + nPend) : L.C.dim('待确认 0')) + L.C.dim(' ｜ ') +
  (nDup ? L.C.dim('判重 ' + nDup) + L.C.dim(' ｜ ') : '') +
  (nConflict ? L.C.red('冲突 ' + nConflict) : ''));

if (nPend) {
  say('');
  say(L.C.yellow(L.C.bold('以下 ' + nPend + ' 张缺少证据，已停下不落位（§0.6 弃权规则）：')));
  // 一行式摘要（完整原因见 计划表 与 批次/日志/ingest_*.json）
  const short = p => p.note
    .replace(/\*\*[^*]*\*\*/g, m => m.slice(2, -2))       // 去掉 Markdown 强调
    .replace(/（[^（）]*§[^（）]*）/g, '')                // 去掉括号里的 § 引用
    .replace(/[｜|]{1,2}\s*/g, ' ｜ ')                    // 统一分隔符
    .split('——')[0].trim();
  for (const p of plans.filter(x => x.status === 'pending')) {
    say(L.C.yellow('   • ' + path.basename(p.src).padEnd(18) + ' ' + short(p)));
  }
  say(L.C.dim('   补齐证据（补对偶图 / 改文件名带频点 / 书面指定口径）后重跑本命令即可。'));
}

/* ---------------- 6. 执行 ---------------- */
if (AS_JSON) {
  // ⚠️ --json 的 stdout **只输出这一个 JSON**，人读信息全在 stderr（用 say）。
  //    APPLY 时同样要把 JSON 打到 stdout —— 调用方需要知道落位结果。
  const payload = {
    case: CASE, inbox: INBOX, applied: APPLY,
    counts: { dir: nDir, power: nPow, tracking: nTrk, forward: nFwd, aclr: nAclr, pending: nPend, dup: nDup, conflict: nConflict },
    plans: plans.map(p => ({
      src: p.srcOrigin || p.src, status: p.status, kind: p.kind || null, dest: p.destRel || null,
      sheet: p.sheet || null, row: p.row || null, cells: p.cells || null,
      plane: p.plane || null, planeVia: p.planeVia || null, cfSeen: p.cfSeen || null,
      dbmCandidates: p.dbmCandidates || null,
      note: p.note || null, why: p.why || null,
    })),
  };
  if (APPLY) {
    applyAll();                       // 人读输出走 stderr
    console.log(JSON.stringify(payload, null, 2));   // ← 唯一的 stdout
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  process.exit(0);
}

if (!APPLY) {
  say('');
  say(L.C.dim('试运行结束 —— 未动任何文件。确认无误后加 --apply 落位。'));
  process.exit(nPend || nConflict ? 1 : 0);
}

applyAll();
process.exit(nPend || nConflict ? 1 : 0);

/* ================= 落位 + 写清单 + 写日志 ================= */
function applyAll() {
  say('');
  say(L.C.bold('▸ 执行落位'));

  // 6.1 移动文件
  // 用法约定：
  //  - **成功落位 / 待人工确认** 的用 `mv` 收进归档区 → 收件箱清空，不会重复处理；
  //  - **判重** 的默认**留在原地**（让人能复查"我确实又发了一遍"），加 `--clean-dup` 才清掉；
  //  - **冲突** 永远留在原地（那是需要人裁决的，不能搬走）。
  // ⚠️ 这里用 mv 不违反「cp 不用 mv」（§18.8）：那条针对的是**原始素材目录**，
  //    目的是保住源头证据；而收件箱的源头是用户手里的微信/剪贴板副本。
  let n = 0, nPendMoved = 0, nDupCleaned = 0;
  for (const p of plans) {
    if (p.status === 'conflict') continue;
    if (p.status === 'dup') {
      if (flags['clean-dup']) {
        if (fs.existsSync(p.src)) { fs.unlinkSync(p.src); nDupCleaned++; }
      }
      continue;
    }
    const dest = path.join(SHOT, p.destRel);
    if (!DRY_SAFE(dest, p.src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    p.srcOrigin = p.srcOrigin || path.relative(CASE, p.src);   // 移动前记下
    // 目标已存在（同内容）时不重复写
    if (fs.existsSync(dest)) { try { fs.unlinkSync(dest); } catch (e) { /* ignore */ } }
    fs.renameSync(p.src, dest);
    p.destAbs = dest;
    p.sha = sha16(dest);
    if (p.status === 'ok') n++; else nPendMoved++;
  }
  say('  落位 ' + L.C.green(n) + ' 张' +
    (nPendMoved ? L.C.yellow('，待确认暂存 ' + nPendMoved + ' 张') : '') +
    (nDupCleaned ? L.C.dim('，判重清理 ' + nDupCleaned + ' 张') : '') +
    L.C.dim('（判重/冲突留在原地待裁决，判重可加 --clean-dup 清掉）'));

  // 6.2 追加截图清单台账
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let md = '';
  if (fs.existsSync(LIST_MD)) md = fs.readFileSync(LIST_MD, 'utf8');
  else md = '# 截图归档清单\n\n| 归档路径（相对根） | 类别 | 内容判读 | 落格 | 源文件路径 | SHA256（前16） |\n|---|---|---|---|---|---|\n';

  const appended = [];
  for (const p of plans) {
    if (p.status !== 'ok' || !p.destAbs) continue;
    const rel = path.relative(SHOT, p.destAbs);
    const cells = p.sheet && p.cells ? p.sheet + ' ' + p.cells : '—';
    // 源路径记「归档前的落点」—— 收件箱用 mv 清空了，记它没意义；
    // 有价值的是「这张图是哪次 ingest、从哪儿收进来的」→ 记收件箱绝对路径 + SHA。
    appended.push('| ' + rel + ' | ' + (p.kind || '') + ' | ' + (p.why || '') +
      ' | ' + cells + ' | ' + (p.srcOrigin || path.relative(CASE, p.src)) + ' | ' + (p.sha || sha16(p.destAbs)) + ' |');
  }
  const pend = plans.filter(p => p.status === 'pending');
  if (appended.length || pend.length) {
    let out = md.replace(/\s*$/, '\n');
    out += '\n## ' + stamp + ' 批次（ingest.js ' + (APPLY ? '落盘' : '试运行') + '）\n\n';
    if (appended.length) {
      out += appended.join('\n') + '\n';
    } else {
      out += '| （本批无新归档） | | | | | |\n';
    }
    if (pend.length) {
      out += '\n### 待人工确认（不许硬填）\n\n| 文件 | 缺什么证据 |\n|---|---|\n' +
        pend.map(p => '| ' + path.basename(p.src) + ' | ' + p.note + ' |').join('\n') + '\n';
    }
    fs.mkdirSync(path.dirname(LIST_MD), { recursive: true });
    fs.writeFileSync(LIST_MD, out, 'utf8');
    say('  清单 ' + L.C.green('截图清单.md') + L.C.dim('（+' + appended.length + ' 行' + (pend.length ? '，待确认 ' + pend.length : '') + '）'));
  }

  // 6.3 批次日志 JSON（可追溯：每张图的判读依据 + SHA）
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logName = 'ingest_' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + '.json';
  fs.writeFileSync(path.join(LOG_DIR, logName), JSON.stringify({
    tool: 'ingest.js', at: new Date().toISOString(), case: CASE, inbox: INBOX,
    minGap: Number(MIN_GAP),
    counts: { dir: nDir, power: nPow, tracking: nTrk, forward: nFwd, aclr: nAclr, pending: nPend, dup: nDup, conflict: nConflict },
    items: plans.map(p => ({
      src: p.srcOrigin || p.src, dest: p.destRel || null, status: p.status, kind: p.kind || null,
      sheet: p.sheet || null, row: p.row || null, cells: p.cells || null,
      plane: p.plane || null, planeVia: p.planeVia || null,
      cf: p.cfSeen ?? null, rf: p.rf ?? null, instrumentTs: p.ts || null,
      dbmCandidates: p.dbmCandidates || null,
      sha256_16: p.sha || sha16(p.src), note: p.note || null, why: p.why || null,
    })),
  }, null, 1) + '\n', 'utf8');
  say('  日志 ' + L.C.green('批次/日志/' + logName));

  // 6.4 下一步命令
  say('');
  say(L.C.bold('下一步：'));
  say('  1) 校验切面  ' + L.C.cyan('node check_pairs.js --dir="' + SHOT + '"'));
  say('  2) 两遍 OCR  ' + L.C.cyan('node ocr_image.swift <图…> --json --scale=1 > 批次/判读/…'));
  say('  3) 判读终值  ' + L.C.cyan('node read_spectrum.js --ocr=报告/ocr --dir=发射 --json --out=批次/判读/基准.json'));
  say('  4) 合成 spec  ' + L.C.cyan('node make_spec.js --judge=批次/判读/终值.json --assign=批次/切面映射.json --out=批次/spec/'));
  say('  5) 填表      ' + L.C.cyan('node fill_mark.js <表> <表_新> 批次/spec/spec_方向图.json'));
  say('');
  say(L.C.dim('（第 2–5 步的完整编排见 SKILL.md §16.5 的七道校验；ingest 只负责把图理顺，不碰表。）'));

}

function DRY_SAFE(dest, src) {
  if (path.resolve(dest) === path.resolve(src)) return false;
  return true;
}
