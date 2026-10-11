#!/usr/bin/env node
/**
 * refresh_cache.js —— 定点刷新公式缓存（只改 <v>，保留 <f>）
 *
 * 用法：node refresh_cache.js <xlsx> <cells.json>
 *   cells.json: { "跟踪精度": { "B14": 272.1713, "B15": 0.0026476 }, ... }
 *
 * ⚠️ 2026-10-11 修掉一个会「静默写坏 XML」的 bug（SKILL §20）：
 *   原实现 `xml.replace(re, m[1] + inner + m[3])` 用**字符串**做替换目标，
 *   而 JS 替换串里的 `$1`/`$&`/`$'` 有反向引用语义 —— 公式里凡有绝对引用
 *   （如 `SUMSQ(B4:B13-B$14)`），`$14` 会被展开成「捕获组 1 + 字面 4」，
 *   把单元格标签塞进公式体内，XML 直接不良构。
 *   修法：用**函数式替换** `xml.replace(re, () => m[1] + inner + m[3])`，杜绝 $ 语义。
 */
'use strict';
const fs = require('fs');
const L = require('./_lib');

const [file, specPath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const wb = L.Workbook.load(file);

let n = 0, bad = 0;
for (const [sheet, cells] of Object.entries(spec)) {
  let xml = wb.getXml(sheet);
  for (const [ref, val] of Object.entries(cells)) {
    const re = new RegExp('(<c r="' + ref + '"[^>]*>)([\\s\\S]*?)(</c>)');
    const m = re.exec(xml);
    if (!m) { console.log('  ✗ ' + sheet + '!' + ref + ' 未找到'); bad++; continue; }
    if (!/<f[\s>]/.test(m[2])) { console.log('  ✗ ' + sheet + '!' + ref + ' 不是公式格（拒绝）'); bad++; continue; }
    const inner = m[2].replace(/<v>[\s\S]*?<\/v>/, '') + '<v>' + L.fmtNum(val) + '</v>';
    // ⚠️ 必须函数式替换：字符串替换会把公式里的 $14 当反向引用
    xml = xml.replace(re, () => m[1] + inner + m[3]);
    n++;
    console.log('  ✓ ' + sheet + '!' + ref + '  缓存 → ' + L.fmtNum(val));
  }
  wb.setXml(sheet, xml);
}
wb.save(file);
console.log('已刷新 ' + n + ' 格公式缓存' + (bad ? '（异常 ' + bad + '）' : '') + ' → ' + file);
