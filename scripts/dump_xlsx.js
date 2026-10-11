#!/usr/bin/env node
'use strict';
/**
 * dump_xlsx.js —— 解包打印每张表的单元格值 + 公式 + 填充色
 *
 * 用法:
 *   node dump_xlsx.js <x.xlsx>                    # 全部工作表
 *   node dump_xlsx.js <x.xlsx> 方向图              # 只看某张表（支持前缀/别名）
 *   node dump_xlsx.js <x.xlsx> --detail           # 逐格详表（值/公式/样式索引/色）
 *   node dump_xlsx.js <x.xlsx> --csv              # 输出 CSV（ref,value,formula,fill,font,bold,s）
 *   node dump_xlsx.js <x.xlsx> --max-row=25 --max-col=U
 *
 * 图例: ● 有值+红字加粗(已按图填写)  ○ 有值  ƒ 公式  □ 蓝底待填
 *       ▫ 合并区影子格（按设计留空，非待填）  · 空格
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
  console.error('用法: node dump_xlsx.js <x.xlsx> [工作表名] [--detail] [--csv] [--max-row=N] [--max-col=X]');
  process.exit(2);
}

const file = positional[0];
const sheetArg = positional[1] || null;

let wb;
try { wb = L.Workbook.load(file); }
catch (e) { console.error(L.C.red('✗ 打开失败：' + e.message)); process.exit(1); }

const maxRow = flags['max-row'] ? parseInt(flags['max-row'], 10) : 0;
const maxCol = flags['max-col'] ? L.colToNum(flags['max-col']) : 0;

console.log(L.C.bold('文件: ') + file);
console.log(L.C.bold('工作表: ') + wb.sheetNames().join(' ｜ '));
if (wb.srcPath) console.log(L.C.dim('SHA256: ' + L.sha256File(file)));
console.log('');

const targets = sheetArg ? [wb.resolveSheet(sheetArg)] : wb.sheetNames();

if (flags.csv) {
  console.log('sheet,ref,value,formula,fill,fontRgb,bold,styleIdx');
}

/** CSV 字段：仅在含分隔符/引号/换行时加引号并转义 */
function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

for (const name of targets) {
  const xml = wb.getXml(name);
  const parsed = L.parseSheet(xml);
  const shadow = wb.shadowRefs(name);
  const dim = /<dimension\b[^>]*ref="([^"]*)"/.exec(xml);
  console.log(L.C.bold('=== 工作表：' + name + ' ==='));
  console.log(L.C.dim('  路径 ' + wb.sheetPathByName.get(name) +
    ' ｜ dimension ' + (dim ? dim[1] : '(无)') +
    ' ｜ 有内容格 ' + parsed.cells.size));

  if (parsed.cells.size === 0) { console.log(L.C.dim('  (空表)')); console.log(''); continue; }

  let minC = Infinity, maxC = 0, minR = Infinity, maxR = 0;
  const list = [];
  for (const c of parsed.cells.values()) {
    const d = wb.decorate(c);
    const p = L.parseRef(c.ref);
    if (p.col < minC) minC = p.col;
    if (p.col > maxC) maxC = p.col;
    if (p.row < minR) minR = p.row;
    if (p.row > maxR) maxR = p.row;
    list.push(d);
  }
  if (maxCol) maxC = Math.min(maxC, maxCol);
  if (maxRow) maxR = Math.min(maxR, maxRow);

  // 蓝底口径：区分「真·待填」与「合并区影子格（按设计留空）」
  const isEmpty = (d) => d.value === null || d.value === undefined || d.value === '';
  const blueAll = list.filter((d) => d.fillRgb === L.BLUE);
  const blueShadow = blueAll.filter((d) => shadow.has(d.ref));
  const blueTodo = blueAll.filter((d) => !shadow.has(d.ref) && isEmpty(d));
  if (blueAll.length) {
    const fmtRefs = (arr) => arr.slice(0, 24).map((d) => d.ref).join(' ') +
      (arr.length > 24 ? ' …(+' + (arr.length - 24) + ')' : '');
    console.log(L.C.dim('  蓝底格 ' + blueAll.length +
      ' ｜ 真·待填 ' + blueTodo.length +
      ' ｜ 合并区影子格（非待填）' + blueShadow.length));
    if (blueTodo.length) console.log(L.C.yellow('    □ 待填：') + L.C.dim(fmtRefs(blueTodo)));
    if (blueShadow.length) {
      console.log(L.C.magenta('    ▫ 影子格：') + L.C.dim(fmtRefs(blueShadow) +
        '  （合并区里除锚点外的格，写值不会显示）'));
    }
  }

  if (flags.csv) {
    list.sort((a, b) => {
      const pa = L.parseRef(a.ref), pb = L.parseRef(b.ref);
      return pa.row - pb.row || pa.col - pb.col;
    });
    for (const d of list) {
      const p = L.parseRef(d.ref);
      if (p.col > maxC || p.row > maxR) continue;
      console.log([csvField(name), csvField(d.ref), csvField(L.fmtVal(d.value)), d.formula ? 'Y' : '',
        csvField(d.fillRgb || ''), csvField(d.fontRgb || ''), d.bold ? 'Y' : '', d.s].join(','));
    }
    console.log('');
    continue;
  }

  if (flags.detail) {
    list.sort((a, b) => {
      const pa = L.parseRef(a.ref), pb = L.parseRef(b.ref);
      return pa.row - pb.row || pa.col - pb.col;
    });
    console.log('  ' + ['格', '值', '公式', '填充色', '字体色', '粗', '样式'].join('\t'));
    for (const d of list) {
      const p = L.parseRef(d.ref);
      if (p.col > maxC || p.row > maxR) continue;
      console.log('  ' + [
        d.ref,
        L.fmtVal(d.value) === '' ? L.C.dim('(空)') : L.fmtVal(d.value),
        d.formula ? d.formula.replace(/^<f[^>]*>|<\/f>$/g, '') : '',
        d.fillRgb || '', d.fontRgb || '', d.bold ? 'B' : '', d.s,
      ].join('\t'));
    }
    console.log('');
    continue;
  }

  // 网格视图
  const byRef = new Map(list.map(d => [d.ref, d]));
  const W = 11;
  const pad = s => {
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    const nb = visible.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
    const width = visible.length + (nb ? nb.length : 0);
    return s + ' '.repeat(Math.max(0, W - width));
  };
  const header = ['  '];
  for (let c = minC; c <= maxC; c++) header.push(pad(L.numToCol(c)));
  console.log(L.C.dim(header.join('')));
  for (let r = minR; r <= maxR; r++) {
    const cells = [];
    for (let c = minC; c <= maxC; c++) {
      const d = byRef.get(L.refOf(c, r));
      if (!d) { cells.push(pad('')); continue; }
      if (d.isFormula) { cells.push(pad(L.C.cyan('ƒ ') + L.fmtVal(d.value))); continue; }
      const g = L.cellGlyph(d, shadow.has(d.ref));
      let v = L.fmtVal(d.value);
      if (v.length > W - 3) v = v.slice(0, W - 4) + '…';
      cells.push(pad(g + v));
    }
    console.log(String(r).padStart(2) + '  ' + cells.join(''));
  }
  console.log('');
}

console.log(L.C.dim('图例: ● 有值+红字加粗(已按图填写)  ○ 有值  ƒ 公式  □ 蓝底待填  ▫ 合并影子格(按设计留空)  · 空格'));
