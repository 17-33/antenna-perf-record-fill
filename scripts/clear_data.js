#!/usr/bin/env node
'use strict';
/**
 * clear_data.js —— 「只保留图里的数据」：清空一切非保留格（含公式格）
 *
 * 用法:
 *   node clear_data.js <in.xlsx> <out.xlsx> <keep.json> [--dry-run] [--no-validate] [--list] [--no-protect]
 *
 * keep.json 三种写法（自动识别）:
 *
 *   A) 单表简式
 *      { "sheet": "方向图", "keep": ["D5","E5","U5"], "keepRows": [1,2,3,4], "keepCols": ["A","B","C"] }
 *
 *   B) 多表简式
 *      { "方向图": ["D5","E5"], "EIRP-公式法": ["D4","E4"] }
 *
 *   C) 完整式（推荐）
 *      {
 *        "defaults": { "keepRows": [1,2,3], "keepCols": ["A","B","C"], "keepTextInLabelCols": true },
 *        "sheets": {
 *          "方向图":      { "keep": ["D5","E5","J5"], "keepRows": [1,2,3,4] },
 *          "EIRP-公式法": { "keep": ["D4","E4"] },
 *          "跟踪精度":    { "keep": ["B4","C4"] }
 *        }
 *      }
 *
 * 语义:
 *   - keep        : 精确保留的格（支持区间 "D5:F12"）
 *   - keepRows    : 整行保留
 *   - keepCols    : 整列保留（如 A/B/C = 序号/频率/LO/行标签）
 *   - keepTextInLabelCols（默认 true）: 在 keepCols 范围内、值为非纯数字文本的格一律保留（兜住各类行标签）
 *   - 其余格（含公式格）→ 变成 <c r="X" s="N"/>：保留样式、抹掉值/公式/文本
 *   - 每张表都会更新 <dimension>；模板预置的合并单元格 / 列宽 / 行高 / 批注 / 图片均不动
 *
 * ⚠️ 清空后公式会消失（SKILL.md §9.11）。最终定稿请从原始记录重建并回填全部批次，让公式自动长回来。
 *
 * 保护：默认跳过「单元格内嵌图」公式格（WPS 的 _xlfn.DISPIMG(...)）——
 *       这类格一旦清空，表里的插图就没了。用 --no-protect 可关闭保护。
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
  console.error('用法: node clear_data.js <in.xlsx> <out.xlsx> <keep.json> [--dry-run] [--list] [--no-validate] [--no-protect]');
  process.exit(2);
}
const [inFile, outFile, keepFile] = positional;

let wb;
try { wb = L.Workbook.load(inFile); }
catch (e) { console.error(L.C.red('✗ 打不开输入文件：' + e.message)); process.exit(1); }

let cfg;
try { cfg = L.readJson(keepFile); }
catch (e) { console.error(L.C.red('✗ ' + e.message)); process.exit(1); }

/** 把 keep.json 规整为 { defaults, sheets: {name: {keep,keepRows,keepCols,keepTextInLabelCols}} } */
function normalizeKeep(raw) {
  const out = { defaults: { keepRows: [1, 2, 3], keepCols: ['A', 'B', 'C'], keepTextInLabelCols: true }, sheets: {} };
  if (raw == null) return out;
  const keys = Object.keys(raw);
  const isSimpleMap = !Array.isArray(raw) && typeof raw === 'object'
    && !('sheets' in raw) && !('keep' in raw) && !('sheet' in raw) && !('defaults' in raw)
    && keys.length > 0 && keys.every(k => Array.isArray(raw[k]));
  if (isSimpleMap) {
    for (const k of keys) out.sheets[k] = { keep: raw[k] };
    return out;
  }
  if (Array.isArray(raw)) throw new Error('keep.json 顶层不能是数组');
  if (raw.defaults) out.defaults = Object.assign(out.defaults, raw.defaults);
  if (raw.sheets) {
    for (const k of Object.keys(raw.sheets)) out.sheets[k] = Object.assign({}, raw.sheets[k]);
  } else if (raw.sheet || raw.keep) {
    out.sheets[raw.sheet || '__ALL__'] = {
      keep: raw.keep, keepRows: raw.keepRows, keepCols: raw.keepCols,
      keepTextInLabelCols: raw.keepTextInLabelCols,
    };
  }
  return out;
}

const K = normalizeKeep(cfg);

function specFor(sheetName) {
  const d = K.defaults;
  const s = K.sheets[sheetName]
    || (Object.keys(K.sheets).length === 1 && K.sheets['__ALL__'] ? K.sheets['__ALL__'] : null)
    || null;
  return {
    keep: new Set((s && s.keep || []).flatMap(x => L.expandRange(x))),
    keepRows: new Set([].concat((s && s.keepRows != null) ? s.keepRows : d.keepRows).map(Number)),
    keepCols: new Set([].concat((s && s.keepCols != null) ? s.keepCols : d.keepCols).map(c => String(c).toUpperCase())),
    keepTextInLabelCols: (s && s.keepTextInLabelCols != null) ? s.keepTextInLabelCols : d.keepTextInLabelCols,
  };
}

console.log(L.C.bold('【只保留图数据 · 清空其余】'));
console.log('  输入  ' + inFile);
console.log('  输出  ' + outFile);
console.log('  保留规则  ' + keepFile);
console.log('  默认保留  行 ' + [...K.defaults.keepRows].join(',') +
  ' ｜ 列 ' + [...K.defaults.keepCols].join(',') +
  ' ｜ 标签列文本全留 ' + (K.defaults.keepTextInLabelCols ? '是' : '否'));
console.log('');

const unknown = Object.keys(K.sheets).filter(k => k !== '__ALL__' && !wb.sheetNames().some(n => n.includes(k)));
if (unknown.length) {
  console.log(L.C.yellow('⚠ keep.json 里这些表名在工作簿中找不到（将被忽略）：' + unknown.join(' / ')));
  console.log('');
}

let totKept = 0, totCleared = 0, totProtected = 0;
const protectImages = !flags['no-protect'];

for (const name of wb.sheetNames()) {
  const sp = specFor(name);
  const parsed = wb.parsedSheet(name);
  const kept = [];
  const cleared = [];
  const protectedRefs = [];

  for (const c of parsed.cells.values()) {
    const p = L.parseRef(c.ref);
    const info = wb.decorate(c);
    // 单元格内嵌图：清掉就会丢插图，直接保护
    if (protectImages && c.formula && /DISPIMG/i.test(c.formula)) {
      protectedRefs.push(c.ref);
      continue;
    }
    let keep = false;
    if (sp.keep.has(c.ref)) keep = true;
    else if (sp.keepRows.has(p.row)) keep = true;
    else if (sp.keepCols.has(p.colName)) keep = true;
    else if (sp.keepTextInLabelCols && p.col <= 3
      && info.value != null && typeof info.value === 'string'
      && info.value.trim() !== '' && isNaN(Number(info.value))) {
      // 兜底：前三列里的非纯数字文本一律当行标签保留
      keep = true;
    }
    if (keep) kept.push(c.ref); else cleared.push(c.ref);
  }

  console.log(L.C.bold('▸ ' + name) + L.C.dim('  保留 ' + kept.length + ' ｜ 清空 ' + cleared.length +
    (protectedRefs.length ? ' ｜ 保护内嵌图 ' + protectedRefs.length : '')));
  if (flags.list) {
    if (kept.length) console.log(L.C.dim('   保留: ' + kept.join(' ')));
    if (cleared.length) console.log(L.C.dim('   清空: ' + cleared.join(' ')));
    if (protectedRefs.length) console.log(L.C.dim('   保护内嵌图: ' + protectedRefs.join(' ')));
  } else {
    const show = a => a.length > 24 ? a.slice(0, 24).join(' ') + ' …(+' + (a.length - 24) + ')' : a.join(' ');
    if (kept.length) console.log(L.C.dim('   保留: ' + show(kept)));
    if (cleared.length) console.log(L.C.dim('   清空: ' + show(cleared)));
    if (protectedRefs.length) console.log(L.C.yellow('   保护内嵌图: ' + show(protectedRefs)));
  }

  if (!flags['dry-run']) {
    for (const ref of cleared) wb.blankCell(name, ref);
    // 清空后统一刷一次 dimension
    const xml = wb.getXml(name);
    wb.setXml(name, L.updateDimension(xml));
  }
  totKept += kept.length;
  totCleared += cleared.length;
  totProtected += protectedRefs.length;
}

console.log('');
if (flags['dry-run']) {
  console.log(L.C.yellow('--dry-run：未写出文件。'));
} else {
  L.ensureDirFor(outFile);
  try {
    wb.save(outFile);
    console.log(L.C.green('✓ 已写出 ' + outFile + '（' + require('fs').statSync(outFile).size + ' 字节）'));
  } catch (e) {
    console.error(L.C.red('✗ 写出失败：' + e.message));
    process.exit(1);
  }
  if (!flags['no-validate']) {
    const r = L.zipValidate(require('fs').readFileSync(outFile));
    if (r.ok) console.log(L.C.green('✓ 输出文件完整性校验通过'));
    else {
      console.log(L.C.red('✗ 输出文件校验失败：'));
      for (const p of r.problems) console.log('  ' + L.C.red('- ' + p));
      process.exit(1);
    }
  }
}

console.log('');
console.log(L.C.bold('汇总：') + '保留 ' + totKept + ' ｜ 清空 ' + totCleared +
  (totProtected ? ' ｜ 保护内嵌图 ' + totProtected + L.C.yellow('（--no-protect 可关闭）') : ''));
console.log(L.C.yellow('提醒：清空后公式格已无公式。最终定稿建议从原始记录重建并回填全部批次（SKILL.md §9.11）。'));
