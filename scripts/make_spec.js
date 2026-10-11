#!/usr/bin/env node
'use strict';
/**
 * make_spec.js —— 判读结果 + 落位计划 → `fill_mark.js` 能吃的 `spec.json`
 *
 * 为什么需要它（SKILL.md §17.4 缺口 2 / §18.5）：
 *   「判读 JSON → spec.json」这一段过去靠临时脚本粘合（32 号机批次手写 make_spec.js、
 *   37 号机挂在批次目录下），每台机重写一次，且字段名每次都可能对不上。
 *   本脚本把它固化：**读得懂 read_spectrum / merge_judge 的产物，也读得懂 ingest 的落位计划**，
 *   输出一份字段名与 `fill_mark.js` 严格对齐的 spec。
 *
 * 用法:
 *   node make_spec.js --judge=判读_终值.json --out=spec_方向图.json [选项]
 *   node make_spec.js --judge=终值.json --plan=ingest落位计划.json --out=spec_方向图.json
 *   node make_spec.js --judge=终值.json --out-dir=批次/spec/ [--sheet=方向图]
 *
 * 参数:
 *   --judge=<file>   判读终值 JSON（read_spectrum.js / merge_judge.js 的产物，{results:[...]}）
 *   --plan=<file>    ingest.js 的 --json 产物，提供「哪个文件对应哪行哪切面」的权威落位
 *                    —— 给了它就以 plan 为准；不给则从判读 JSON 的 orient 字段推
 *   --out=<file>     输出 spec 路径（单文件）
 *   --out-dir=<dir>  输出目录（每张表一个 spec_<表名>.json）
 *   --sheet=<表名>   只处理某张表（默认 方向图）
 *   --batch=<批号>   批次号，写进日志行（默认取时间戳）
 *   --src-col=<列>   来源列（默认：方向图 U / EIRP L / GT N / 跟踪精度 D / 前向链路 F）
 *   --no-mark        不打红字（反向核对时用 —— §16.6：红字语义=「本批次写入」，
 *                    纯核对不该打红字，否则 audit 的「错标」口径会失效）
 *   --dry-run        只打印将要写入的格与值，不落盘
 *
 * 判读 JSON 的字段约定（与 read_spectrum.js 的 judgeOne 输出一致）:
 *   { results: [ { name, orient: 'az'|'el', dirName: '接收'|'发射',
 *                  cf, rf, row, cells: { D: {value, note}, E: {...}, ... },
 *                  mks: [...], issues: [...], ts } ] }
 *   ⚠️ `cells` 的列字母**已经按 orient 选好了**（az→D E F J K L M，el→G H I N O P Q），
 *      所以本脚本不重算列，只负责「按行号拼成 spec + 补来源列 + 补日志行」。
 *
 * 安全护栏（与 fill_mark.js 的拒绝规则对齐）:
 *   - 只写 `cells` 里**确实有值**的格
 *   - `issues` 非空（该图有缺项）→ 该图进 `skipped` 并在报告里点名，不硬填半张
 *   - 行号为空的（频点没对上）→ 跳过
 *
 * 退出码: 0 = 成功；1 = 出错；2 = 用法错误
 */

const L = require('./_lib');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
if (flags.help || flags.h || !flags.judge) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(flags.help || flags.h ? 0 : 2);
}
if (!flags.out && !flags['out-dir']) {
  console.error(L.C.red('✗ 缺 --out=<文件> 或 --out-dir=<目录>'));
  process.exit(2);
}
function fail(msg) { console.error(L.C.red('✗ ' + msg)); process.exit(1); }

const JUDGE = path.resolve(String(flags.judge));
if (!fs.existsSync(JUDGE)) fail('判读文件不存在：' + JUDGE);
const SHEET = String(flags.sheet || '方向图');
const BATCH = String(flags.batch || new Date().toISOString().slice(0, 10));
const NO_MARK = !!flags['no-mark'];
const DRY = !!flags['dry-run'];
const SRC_COL = flags['src-col'] || { '方向图': 'U', 'EIRP-公式法': 'L', 'GT-公式法': 'N', '跟踪精度': 'D', '前向链路（接收）标定': 'F' }[SHEET] || 'U';

// 来源列下一行的落点（批次日志写在表格下方空行）
const LOG_ROW = { '方向图': 25, 'EIRP-公式法': 13, 'GT-公式法': 13, '跟踪精度': 20, '前向链路（接收）标定': 12 }[SHEET] || 25;

let judge;
try { judge = L.readJson(JUDGE); } catch (e) { fail('判读文件读不出来：' + e.message); }
const results = Array.isArray(judge) ? judge : (judge.results || judge.images || []);
if (!Array.isArray(results) || !results.length) fail('判读文件里没有 results 数组（期望 read_spectrum.js / merge_judge.js 的产物）');

// 可选：ingest 的落位计划（文件名 → 行/切面 的权威来源）
let plan = null;
if (flags.plan) {
  const pp = path.resolve(String(flags.plan));
  if (fs.existsSync(pp)) {
    try { plan = L.readJson(pp); } catch (e) { console.error(L.C.yellow('⚠ 落位计划读不了，忽略：' + e.message)); }
  } else {
    console.error(L.C.yellow('⚠ 落位计划不存在，忽略：' + pp));
  }
}
const planByName = new Map();
if (plan && Array.isArray(plan.plans)) {
  for (const p of plan.plans) {
    if (p && p.src && p.status === 'ok' && p.row) planByName.set(path.basename(p.src), p);
  }
}

/* ---------------- 类型归一 ----------------
 * ⚠️ 实测坑（必须在这里修，否则整批数据静默失效）：
 *   `read_spectrum.js` 的角度列（J/K/L/M/N/O/P/Q）经 shiftDec 处理后是**字符串**
 *   （如 "0.11425"），而主瓣/旁瓣列（D/E/F/G/H/I）是**数字**。
 *   若原样写进 xlsx，角度格会变成**文本型单元格** →
 *   方向图 T 列的 `10*LOG10((R+S)/2)` 与 GT 表引用 `方向图!T` 全部拿不到数，
 *   而 dump/analyze 只看「有没有值」，**照样显示正常** —— 静默失效，最难发现。
 *   → 统一转成 number 再写。
 */
function numify(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return null;   // 纯数字才转
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const NON_NUMERIC = [];   // 转不了的（真有文本值）——记下来报给用户

/** 人读输出一律走 stderr：stdout 保持干净，便于 `--judge=x | jq` 或被上层脚本捕获 */
const say = (...a) => console.error(...a);

say(L.C.bold('【make_spec】'));
say('  判读  ' + JUDGE + L.C.dim('（' + results.length + ' 张）'));
say('  计划  ' + (plan ? path.resolve(String(flags.plan)) : L.C.dim('（未提供，按判读的 orient 推切面）')));
say('  工作表 ' + SHEET + ' ｜ 来源列 ' + SRC_COL + ' ｜ 批次 ' + BATCH + (NO_MARK ? L.C.yellow(' ｜ 不打红字（核对模式）') : ''));
say('');

/* ---------------- 逐张组装 ---------------- */
const values = {}, marks = [], texts = {}, notes = [];
const filled = [], skipped = [], partial = [];

for (const r of results) {
  const name = String(r.name || '');
  const base = name.replace(/\.(jpe?g|png)$/i, '');
  const p = planByName.get(path.basename(name));

  // 行号：优先取 ingest 落位计划（那是「图片↔行」的权威），否则用判读 JSON 自带的
  const row = (p && p.row) || r.row;
  if (!row) {
    skipped.push({ name, why: '行号为空（频点没对上 16 频点表，异常码 BAD_CF）' });
    continue;
  }
  // 切面冲突检查：plan 与判读的 orient 不一致 → 停下报告（§0.6 证据冲突）
  if (p && p.plane && r.orient && p.plane !== r.orient) {
    skipped.push({ name, why: '切面冲突：ingest 落位为「' + (p.plane === 'az' ? '方位' : '俯仰') +
      '」而判读 JSON 为「' + (r.orient === 'az' ? '方位' : '俯仰') + '」—— 须人裁决' });
    continue;
  }

  const cells = r.cells || {};
  const keys = Object.keys(cells).filter(c => cells[c] && cells[c].value !== null && cells[c].value !== undefined);
  if (!keys.length) {
    skipped.push({ name, why: 'cells 里没有可写值' });
    continue;
  }
  const got = [];
  const conflicts = [];
  for (const col of keys) {
    const ref = col + row;
    if (values[ref] !== undefined) {
      conflicts.push(ref + '（另一张是 ' + ((filled.find(f => f.cols.includes(ref)) || {}).name || '?') + '）');
      continue;
    }
    const n = numify(cells[col].value);
    if (n === null) {
      NON_NUMERIC.push({ ref, name, raw: cells[col].value });
      continue;
    }
    values[ref] = n;
    got.push(ref);
  }
  // 整张一格都没写进去 → 这张图**完全无效**（要么全被冲突、要么全是非数值），
  // 逐格报一堆冲突会淹没真正的原因；归成一条「整图未写入」并说明冲突点。
  if (!got.length && conflicts.length) {
    skipped.push({
      name,
      why: '整图未写入任何格 —— ' + conflicts.length + ' 个格都已被先到的图写入，属**证据冲突**，须人裁决：' +
        conflicts.join('、'),
    });
    continue;
  }
  for (const c of conflicts) {
    skipped.push({ name, why: '格 ' + c + ' 已被先到的图写入 —— 同一格两张图都有值，属**证据冲突**，须人裁决（本 spec 以先到者为准）' });
  }
  marks.push(...got);
  filled.push({ name, row, cols: got, cells });

  // 有缺项的图：**写已解析出的格，缺的格列进 skipped**。
  // ⚠️ 为什么不整张拒填（初版曾那么做，已改）：
  //    `缺 左侧旁瓣` 的正确处置是「E13 留空、其余 6 格照填」——
  //    整张拒填会把半张表留空，而留空格在下一步（crosscheck/analyze）里
  //    表现为「待填」，看不出「本来就没有这个 marker」。
  //    这不违反 §0.6 弃权规则：我们**没有猜**任何值，只是没写没有证据的那一格。
  if (Array.isArray(r.issues) && r.issues.length) {
    const ALL = { az: ['D', 'E', 'F', 'J', 'K', 'L', 'M'], el: ['G', 'H', 'I', 'N', 'O', 'P', 'Q'] };
    const want = ALL[r.orient] || [];
    const missingCols = want.filter(c => !got.includes(c + row))
      .map(c => c + row + '(' + ({ D: 'M1 主瓣', E: '左/下旁瓣', F: '右/上旁瓣', G: 'M1 主瓣', H: '下旁瓣', I: '上旁瓣',
        J: '3dB 负', K: '3dB 正', L: '10dB 负', M: '10dB 正', N: '3dB 负', O: '3dB 正', P: '10dB 负', Q: '10dB 正' }[c] || '') + ')');
    partial.push({
      name, row,
      note: '本图缺 ' + r.issues.join(' / ') + ' → 已填 ' + got.length + ' 格，留空 ' +
        (missingCols.join('、') || '（无）') +
        '。若截图上其实有该 marker，多半是解析器丢的（§17.6）—— 回 报告/ocr/ 与 ocr2/ 查原图，' +
        '有则用 merge_judge --manual 补；无则保持留空',
    });
  }

  // 来源列：方位/俯仰是**同一行**，两条注记要合并成一条（否则后者覆盖前者）
  const note = p
    ? base + '（' + path.relative(path.dirname(JUDGE), p.src || '') + '）'
    : base + (r.ts ? '（仪器时间 ' + r.ts + '）' : '');
  texts[SRC_COL + row] = texts[SRC_COL + row] ? texts[SRC_COL + row] + '；' + note : note;
}

// 批次日志行
notes.push({
  cell: 'A' + LOG_ROW,
  text: '批次 ' + BATCH + '｜' + SHEET + '｜由 make_spec.js 依据 ingest 落位 + 判读终值生成｜' +
    '已填 ' + filled.length + ' 张（' + filled.reduce((s, f) => s + f.cols.length, 0) + ' 格）' +
    (partial.length ? '｜其中 ' + partial.length + ' 张有缺项、已填能判的格并留空其余' : '') +
    (skipped.length ? '｜跳过 ' + skipped.length + ' 张' : ''),
});

/* ---------------- 组装 spec ---------------- */
const spec = { sheet: SHEET };
if (marks.length) spec.mark = marks;
spec.values = values;
if (Object.keys(texts).length) spec.texts = texts;
if (notes.length) spec.notes = notes;

/* ---------------- 输出 ---------------- */
const totalCells = Object.keys(values).length;
say(L.C.bold('▸ 将写入的格（' + totalCells + ' 个，来自 ' + filled.length + ' 张）'));
for (const f of filled) {
  const pairs = f.cols.map(c => c + '=' + f.cells[c.replace(/\d+$/, '')].value);
  say('  ' + L.C.green(String(f.name).slice(0, 26).padEnd(28)) + '行 ' + String(f.row).padEnd(3) + L.C.dim(pairs.join('  ')));
}
if (skipped.length) {
  say('');
  say(L.C.yellow(L.C.bold('▸ 跳过 ' + skipped.length + ' 张（未写入任何格）：')));
  for (const s of skipped) say(L.C.yellow('   • ' + s.name + ' —— ' + s.why));
}
if (partial.length) {
  say('');
  say(L.C.yellow(L.C.bold('▸ 部分填写 ' + partial.length + ' 张（有缺项，但已把能判的格填了）：')));
  for (const s of partial) say(L.C.yellow('   • ' + s.name + ' —— ' + s.note));
}
say('');
say('  来源列 ' + L.C.cyan(SRC_COL) + ' ← 图注记 ' + Object.keys(texts).length + ' 条');
say('  日志行 ' + L.C.cyan('A' + LOG_ROW) + ' ← 批次 ' + BATCH);
if (NON_NUMERIC.length) {
  say(L.C.yellow('  ⚠ ' + NON_NUMERIC.length + ' 个值不是数字，已跳过：' +
    NON_NUMERIC.slice(0, 5).map(x => x.ref + '=' + JSON.stringify(x.raw)).join(' ')));
}
// ⚠️ 一格都没写 → **拒绝写出 spec**。
//    拿一个空 spec 去跑 fill_mark，只会产出一份「什么都没填、却显示成功」的表 ——
//    这是最坏的一种失败（静默），比报错糟得多。
if (!totalCells) {
  say('');
  say(L.C.red(L.C.bold('✗ 一格都没写 —— 拒绝写出 spec。')));
  say(L.C.dim('  请按上面的跳过原因处理后重跑。'));
  process.exit(1);
}
// 有跳过/部分填写时显式标明覆盖范围，别让人误以为全填了
if (skipped.length || partial.length) {
  say('');
  say(L.C.yellow('⚠ 本 spec **只覆盖部分数据**：' +
    (skipped.length ? '跳过 ' + skipped.length + ' 张' : '') +
    (partial.length ? (skipped.length ? '，' : '') + '部分填写 ' + partial.length + ' 张' : '') +
    '。填表后请以 analyze / audit 的结论为准，别默认全表都填了。'));
}

const outFile = flags.out
  ? path.resolve(String(flags.out))
  : path.join(path.resolve(String(flags['out-dir'])), 'spec_' + SHEET + '.json');
if (DRY) {
  say('');
  say(L.C.dim('[dry-run] 将写出 ' + outFile));
  say(L.C.dim(JSON.stringify(spec, null, 1).slice(0, 600) + ' …'));
  process.exit(0);
}
// 写盘前最后一道断言：spec 里绝不能有字符串型数值（会静默毁掉公式链）
for (const k of Object.keys(spec.values)) {
  if (typeof spec.values[k] !== 'number') {
    console.error(L.C.red('✗ 内部错误：spec.values.' + k + ' 不是 number（' + JSON.stringify(spec.values[k]) + '）'));
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(spec, null, 1) + '\n', 'utf8');
say('');
say('  写出 ' + L.C.green(outFile));
say('');
say(L.C.bold('下一步：'));
say('  填表  ' + L.C.cyan('node fill_mark.js <in.xlsx> <out.xlsx> ' + outFile));
say('  回读  ' + L.C.cyan('node verify_mark.js <out.xlsx> ' + SHEET + ' ' + Object.keys(values).slice(0, 3).join(' ') + ' …'));
process.exit(0);

