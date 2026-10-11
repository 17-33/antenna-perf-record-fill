#!/usr/bin/env node
'use strict';
/**
 * zipcheck.js —— xlsx/ZIP 完整性校验
 *
 * 校验内容：
 *   1. ZIP 结构（EOCD / 中央目录 / 每个本地头）可解析
 *   2. 每个条目的 CRC32 与实际解压数据一致
 *   3. 每个 XML / RELS / VML 条目良构（标签配对、无裸 <> ）
 *   4. xlsx 必备部件存在（xl/workbook.xml、[Content_Types].xml、样式、工作表）
 *
 * 用法:
 *   node zipcheck.js <a.xlsx> [b.xlsx ...]
 *   node zipcheck.js <a.xlsx> --list        # 附带条目清单
 *   node zipcheck.js <a.xlsx> --strict      # 把「显式目录条目」也当作问题
 *
 * 退出码: 0 全部通过；1 有文件不通过；2 参数错误
 */

const L = require('./_lib');
const fs = require('fs');

const argv = process.argv.slice(2);
const flags = {};
const files = [];
for (const a of argv) {
  const m = /^--(.+)$/.exec(a);
  if (m) flags[m[1]] = true;
  else files.push(a);
}

if (files.length === 0) {
  console.error('用法: node zipcheck.js <a.xlsx> [b.xlsx ...] [--list]');
  process.exit(2);
}

let bad = 0;

for (const f of files) {
  console.log(L.C.bold('■ ' + f));
  if (!fs.existsSync(f)) {
    console.log('  ' + L.C.red('✗ 文件不存在'));
    bad++;
    continue;
  }
  const buf = fs.readFileSync(f);
  console.log(L.C.dim('  大小 ' + buf.length + ' 字节 ｜ SHA256 ' + L.sha256File(f).slice(0, 16) + '…'));

  const r = L.zipValidate(buf, { strict: !!flags.strict });
  const entries = r.entries || [];
  console.log('  ZIP 条目 ' + entries.length + ' 个');

  if (flags.list) {
    for (const e of entries) {
      console.log(L.C.dim('    ' + (e.method === 0 ? 'store ' : 'deflate') +
        '  ' + String(e.usize).padStart(9) + '  ' + e.name));
    }
  }

  if (r.notices && r.notices.length) {
    console.log('  ' + L.C.yellow('△ ' + r.notices.length + ' 项提示（不影响可读性）：'));
    for (const n of r.notices) console.log('    ' + L.C.yellow('- ' + n));
    console.log(L.C.dim('    （加 --strict 可把提示升级为问题）'));
  }

  if (r.ok) {
    console.log('  ' + L.C.green('✅ 全部校验通过（结构 + CRC32 + XML 良构 + 必备部件）'));
  } else {
    bad++;
    console.log('  ' + L.C.red('✗ 发现 ' + r.problems.length + ' 项问题：'));
    for (const p of r.problems) console.log('    ' + L.C.red('- ' + p));
  }
  console.log('');
}

if (bad === 0) {
  console.log(L.C.green('结论: ' + files.length + ' 个文件全部通过 ✅'));
  process.exit(0);
} else {
  console.log(L.C.red('结论: ' + bad + ' / ' + files.length + ' 个文件未通过 ✗'));
  process.exit(1);
}
