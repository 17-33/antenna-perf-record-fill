#!/usr/bin/env node
'use strict';
/**
 * make_sample.js —— 生成一份「结构合规」的合成样本 xlsx（5 张表，按 SKILL.md §2 布局）
 *
 * 用途：不依赖真实客户记录表，就能端到端验证全部脚本（tests/selftest.js 会自动调用）。
 * 用法: node make_sample.js <输出目录>         → 写出 <输出目录>/sample.xlsx
 *      require('./make_sample').build()        → 直接返回 Buffer
 *
 * 样本特性（刻意覆盖所有边界）:
 *   · 5 张表名与 SKILL.md §2 一致（方向图 / EIRP-公式法 / GT-公式法 / 跟踪精度 / 前向链路（接收）标定）
 *   · 方向图 D..Q 带蓝底 FF00B0F0（用来验"填完保留蓝底 + 红字加粗"）
 *   · 方向图 R/S/T 是真公式格（用来验"公式格拒绝写入"）
 *   · 方向图 AA1 放一条 _xlfn.DISPIMG 内嵌图公式（用来验清空时的保护逻辑）
 *   · 有一处 t="s" 共享字符串 + 一处 t="inlineStr"，覆盖两条字符串取值路径
 *   · EIRP 行 5 合格（≥69 dBW）、GT 行 4 合格（≥25 dB/K）、跟踪精度合格
 */

const path = require('path');
const fs = require('fs');
const L = require('../scripts/_lib');

/* ---------------- XML 片段 ---------------- */

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
${[1, 2, 3, 4, 5].map(i => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const SHEET_NAMES = ['方向图', 'EIRP-公式法', 'GT-公式法', '跟踪精度', '前向链路（接收）标定'];

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${SHEET_NAMES.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
</workbook>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${SHEET_NAMES.map((n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${SHEET_NAMES.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId${SHEET_NAMES.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>序号</t></si>
<si><t>频率/GHz</t></si>
<si><t xml:space="preserve">LO </t></si>
</sst>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><scheme val="minor"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* 样式索引 */
const S_DEF = 0, S_BOLD = 1, S_BLUE = 2;

/* ---------------- 单元格构造 ---------------- */

const ref = L.refOf;

function numCell(r, s, v) { return `<c r="${r}" s="${s}"><v>${L.fmtNum(v)}</v></c>`; }
function intCell(r, s, v) { return `<c r="${r}" s="${s}"><v>${v}</v></c>`; }
function strCell(r, s, t) {
  const sp = /^\s|\s$/.test(t) ? ' xml:space="preserve"' : '';
  return `<c r="${r}" s="${s}" t="inlineStr"><is><t${sp}>${L.escXml(t)}</t></is></c>`;
}
function sharedCell(r, s, i) { return `<c r="${r}" s="${s}" t="s"><v>${i}</v></c>`; }
function fmlCell(r, s, f, v) { return `<c r="${r}" s="${s}"><f>${L.escXml(f)}</f><v>${L.fmtNum(v)}</v></c>`; }

function sheetXml(rowsXml, dimension, mergeRefs) {
  // mergeCells 在 OOXML 里必须排在 <sheetData> 之后
  const mc = (mergeRefs && mergeRefs.length)
    ? '<mergeCells count="' + mergeRefs.length + '">' +
      mergeRefs.map(r => '<mergeCell ref="' + r + '"/>').join('') + '</mergeCells>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dimension}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="14.25"/>
<sheetData>
${rowsXml.join('\n')}
</sheetData>${mc}
</worksheet>`;
}
function row(r, cells) { return `<row r="${r}">${cells.join('')}</row>`; }

/* ---------------- 各表数据（同时算出公式的缓存值） ---------------- */

function buildSheets() {
  /* ---- 方向图 ---- */
  const rowsP = [];
  rowsP.push(row(1, [sharedCell('A1', S_BOLD, 0), sharedCell('B1', S_BOLD, 1), sharedCell('C1', S_BOLD, 2),
    fmlCell('AA1', S_DEF, '_xlfn.DISPIMG("ID_SAMPLE123",1)', 0)]));
  rowsP.push(row(4, ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T']
    .map(c => strCell(c + '4', S_BOLD, c))));

  // 行 5：完整填满，让 R/S/T 有得算
  const full = {
    D: -13.23, E: -16.58, F: -12.87,
    G: -13.05, H: -17.02, I: -12.61,
    J: 0.14146, K: 0.13872,
    L: 0.41259, M: 0.42881,
    N: 0.14503, O: 0.14018,
    P: 0.41977, Q: 0.43512,
  };
  const calcR = 31000 / ((full.N + full.O) * (full.J + full.K));
  const calcS = 91000 / ((full.P + full.Q) * (full.L + full.M));
  const calcT = 10 * Math.log10((calcR + calcS) / 2);

  const RXr = L.SHEET_STRUCT.pattern.rowsRX;
  const TXr = L.SHEET_STRUCT.pattern.rowsTX;
  RXr.forEach((r, i) => {
    const cells = [intCell('A' + r, S_DEF, i + 1), numCell('B' + r, S_DEF, L.RX_FREQS[i]),
      numCell('C' + r, S_DEF, L.LO_RX)];
    for (const c of ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) {
      cells.push(r === 5 && full[c] != null ? numCell(c + r, S_BLUE, full[c]) : `<c r="${c}${r}" s="${S_BLUE}"/>`);
    }
    cells.push(
      r === 5 ? fmlCell('R' + r, S_DEF, `31000/((N${r}+O${r})*(J${r}+K${r}))`, calcR) : `<c r="R${r}" s="${S_DEF}"/>`,
      r === 5 ? fmlCell('S' + r, S_DEF, `91000/((P${r}+Q${r})*(L${r}+M${r}))`, calcS) : `<c r="S${r}" s="${S_DEF}"/>`,
      r === 5 ? fmlCell('T' + r, S_DEF, `10*LOG10((R${r}+S${r})/2)`, calcT) : `<c r="T${r}" s="${S_DEF}"/>`);
    rowsP.push(row(r, cells));
  });
  TXr.forEach((r, i) => {
    const cells = [intCell('A' + r, S_DEF, i + 9), numCell('B' + r, S_DEF, L.TX_FREQS[i]),
      numCell('C' + r, S_DEF, L.LO_TX)];
    for (const c of ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) {
      cells.push(`<c r="${c}${r}" s="${S_BLUE}"/>`);
    }
    cells.push(`<c r="R${r}" s="${S_DEF}"/>`, `<c r="S${r}" s="${S_DEF}"/>`, `<c r="T${r}" s="${S_DEF}"/>`);
    rowsP.push(row(r, cells));
  });

  /* ---- EIRP-公式法 ---- */
  const rowsE = [];
  rowsE.push(row(1, [sharedCell('A1', S_BOLD, 0), strCell('B1', S_BOLD, '频率/GHz')]));
  const SIGMA_E = 0.35;
  L.SHEET_STRUCT.eirp.rows.forEach((r, i) => {
    const f = L.TX_FREQS[i];
    const D = 54.1, E = 0.30, F = 0.50, J = 18.2;
    const H = L.faceLoss(SIGMA_E, f);
    const I = D - (E + F + H);
    const K = J + I;
    const cells = [
      intCell('A' + r, S_DEF, i + 1), numCell('B' + r, S_DEF, f),
      numCell('C' + r, S_DEF, L.LO_TX),
      numCell('D' + r, S_BLUE, D), numCell('E' + r, S_BLUE, E), numCell('F' + r, S_BLUE, F),
    ];
    if (r === 4) cells.push(numCell('G4', S_BLUE, SIGMA_E)); else cells.push(`<c r="G${r}" s="${S_BLUE}"/>`);
    cells.push(`<c r="H${r}" s="${S_DEF}"/>`, `<c r="I${r}" s="${S_DEF}"/>`,
      numCell('J' + r, S_BLUE, J),
      fmlCell('K' + r, S_DEF, `J${r}+I${r}`, K));
    rowsE.push(row(r, cells));
  });

  /* ---- GT-公式法 ---- */
  const rowsG = [];
  rowsG.push(row(1, [sharedCell('A1', S_BOLD, 0), strCell('B1', S_BOLD, '频率/GHz')]));
  const SIGMA_G = 0.35;
  L.SHEET_STRUCT.gt.rows.forEach((r, i) => {
    const f = L.RX_FREQS[i];
    const D = 54.35, E = 0.40, H = 0.25, I = L.TANT, J = 2.0;
    const G = L.faceLoss(SIGMA_G, f);
    const Lv = D - (E + G + H);
    const Tr = 290 * (Math.pow(10, J / 10) - 1);
    const M = Lv - 10 * Math.log10(I + Tr);
    const cells = [
      intCell('A' + r, S_DEF, i + 1), numCell('B' + r, S_DEF, f),
      numCell('C' + r, S_DEF, L.LO_RX),
      numCell('D' + r, S_BLUE, D), numCell('E' + r, S_BLUE, E),
    ];
    if (r === 4) cells.push(numCell('F4', S_BLUE, SIGMA_G)); else cells.push(`<c r="F${r}" s="${S_BLUE}"/>`);
    cells.push(`<c r="G${r}" s="${S_DEF}"/>`, numCell('H' + r, S_BLUE, H), intCell('I' + r, S_DEF, I),
      numCell('J' + r, S_BLUE, J),
      fmlCell('K' + r, S_DEF, `290*(10^(J${r}/10)-1)`, Tr),
      `<c r="L${r}" s="${S_DEF}"/>`,
      fmlCell('M' + r, S_DEF, `L${r}-10*LOG10(I${r}+K${r})`, M));
    rowsG.push(row(r, cells));
  });

  /* ---- 跟踪精度 ---- */
  const rowsT = [];
  rowsT.push(row(1, [sharedCell('A1', S_BOLD, 0)]));
  const ZERO_A = 120.0, ZERO_E = 35.0;
  const offs = [0.015, -0.012, 0.008, -0.018, 0.003, 0.011, -0.009, 0.014, -0.004, -0.010];
  L.SHEET_STRUCT.tracking.rows.forEach((r, i) => {
    rowsT.push(row(r, [
      strCell('A' + r, S_DEF, '第' + (i + 1) + '次'),
      numCell('B' + r, S_BLUE, ZERO_A + offs[i]),
      numCell('C' + r, S_BLUE, ZERO_E - offs[i]),
    ]));
  });
  const rmsOf = arr => Math.sqrt(arr.reduce((a, x) => a + x * x, 0) / arr.length);
  const dA = rmsOf(offs);
  const dE = rmsOf(offs.map(x => -x));
  const delta = Math.sqrt(dA * dA + dE * dE);
  const limit = (full.J + full.K + full.N + full.O) / 2 / 10;
  rowsT.push(row(14, [strCell('A14', S_DEF, '零值'), numCell('B14', S_BLUE, ZERO_A), numCell('C14', S_BLUE, ZERO_E)]));
  rowsT.push(row(15, [strCell('A15', S_DEF, '单轴'), fmlCell('B15', S_DEF, `SQRT(SUMSQ(B4:B13)/10)`, dA),
    fmlCell('C15', S_DEF, `SQRT(SUMSQ(C4:C13)/10)`, dE)]));
  rowsT.push(row(16, [strCell('A16', S_DEF, '合成'), fmlCell('B16', S_DEF, 'SQRT(B15^2+C15^2)', delta)]));
  rowsT.push(row(17, [strCell('A17', S_DEF, '指标'), fmlCell('C17', S_DEF, '(方向图!J5+K5+N5+O5)/2/10', limit)]));

  /* ---- 前向链路（接收）标定 ---- */
  const rowsF = [];
  rowsF.push(row(1, [sharedCell('A1', S_BOLD, 0)]));
  rowsF.push(row(2, [strCell('A2', S_BOLD, '频点/GHz'), strCell('B2', S_BOLD, 'LNB输出'),
    strCell('C2', S_BOLD, 'LNB-测控基带XS05'), strCell('D2', S_BOLD, 'LNB-地基基站IN1'),
    strCell('E2', S_BOLD, 'LNB-地基基站IN2')]));
  L.SHEET_STRUCT.forward.rows.forEach((r, i) => {
    rowsF.push(row(r, [
      numCell('A' + r, S_DEF, L.RX_FREQS[i]),
      numCell('B' + r, S_BLUE, -10.80 - i * 0.05),
      numCell('C' + r, S_BLUE, -20.90 - i * 0.05),
      numCell('D' + r, S_BLUE, -14.60 - i * 0.05),
      i % 3 === 2 ? strCell('E' + r, S_BLUE, '\\') : numCell('E' + r, S_BLUE, -15.10 - i * 0.05),
    ]));
  });

  return {
    'xl/worksheets/sheet1.xml': sheetXml(rowsP, 'A1:T20'),
    // 真实模板里 σ（面型标准偏差）是一台天线一个值 —— 写成合并单元格，
    // G5:G11 / F5:F11 是"影子格"（按设计留空，写值不显示）。样表保持一致。
    'xl/worksheets/sheet2.xml': sheetXml(rowsE, 'A1:K11', ['G4:G11']),
    'xl/worksheets/sheet3.xml': sheetXml(rowsG, 'A1:M11', ['F4:F11']),
    'xl/worksheets/sheet4.xml': sheetXml(rowsT, 'A1:C17'),
    'xl/worksheets/sheet5.xml': sheetXml(rowsF, 'A1:E10'),
    _expect: { calcT, calcR, calcS, limit, delta, dA, dE },
  };
}

/* ---------------- 打包 ---------------- */

function build() {
  const sheets = buildSheets();
  const order = [
    '[Content_Types].xml', CT,
    '_rels/.rels', ROOT_RELS,
    'xl/workbook.xml', WORKBOOK,
    'xl/_rels/workbook.xml.rels', WB_RELS,
    'xl/styles.xml', STYLES,
    'xl/sharedStrings.xml', SHARED,
  ];
  for (const k of Object.keys(sheets)) {
    if (k.startsWith('_')) continue;
    order.push(k, sheets[k]);
  }
  const entries = [];
  for (let i = 0; i < order.length; i += 2) {
    entries.push({
      name: order[i],
      method: 8,
      modTime: 0, modDate: 0x21,
      data: Buffer.from(order[i + 1], 'utf8'),
      dirty: true,
    });
  }
  return { buf: L.writeZip(entries), expect: sheets._expect };
}

module.exports = { build, SHEET_NAMES };

if (require.main === module) {
  const dir = process.argv[2] || '.';
  const out = path.join(dir, 'sample.xlsx');
  const { buf, expect } = build();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, buf);
  console.log('已写出 ' + out + '（' + buf.length + ' 字节）');
  console.log('期望值: T=' + expect.calcT.toFixed(6) + '  指标=' + expect.limit.toFixed(6) +
    '  δ=' + expect.delta.toFixed(6));
}
