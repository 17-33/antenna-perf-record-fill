#!/usr/bin/env node
'use strict';
/**
 * unpack_zip.js —— 压缩包「完整目录结构」解析 / 保层提取 / 逐条回验
 *
 * 为什么需要它（而不是系统 unzip）：
 *   1. **名称编码**：ZIP 不强制编码。中文 Windows 打包的包未置 UTF-8 标志位、
 *      名字是 GBK；macOS 自带 `unzip` 一律按 CP437 解 ⇒ 中文路径全变乱码，
 *      落盘后既看不懂也无法还原。本脚本读**中央目录**，按标志位 → UTF-8 / GBK / CP437
 *      顺序解码（`_lib.decodeZipName`）。
 *   2. **不遗漏、不压平**：明确统计「显式目录条目 + 由路径补出的目录」，
 *      校验 EOCD 声明的条目数与中央目录实际消耗字节，逐条 CRC32。
 *      Windows 打包常用 `\` 当分隔符 —— 直接按 `/` 切会把整棵树压成一层，
 *      本脚本识别并归一化，同时把这件事**报出来**。
 *   3. **提取后回验**：落盘文件集合必须与包内集合完全相等（不多不少），
 *      每个文件的 size + CRC32 必须等于中央目录记录值。
 *
 * 用法:
 *   node unpack_zip.js <archive.zip>                      # 只体检 + 打印完整目录树（不落盘）
 *   node unpack_zip.js <archive.zip> <outdir>             # 提取（严格保留相对路径）+ 逐文件回验
 *   node unpack_zip.js <archive.zip> <outdir> --json <结构.json>
 *   node unpack_zip.js <archive.zip> --list               # 显式"只看结构"
 *   node unpack_zip.js <archive.zip> --name-enc=gbk       # 自动判错时的逃生阀，强制名称编码
 *   node unpack_zip.js <archive.zip> <outdir> --force     # 目标目录已存在内容时仍继续
 *
 * 选项:
 *   --list            只看结构，不落盘（给了 outdir 时以 outdir 为准）
 *   --json <路径>     把完整结构清单（含每条相对路径）写成 JSON
 *   --name-enc <enc>  强制名称编码：utf8 | gbk | cp437
 *   --sha            为包内每个文件附 SHA256（大包会慢）
 *   --force           目标目录非空时不中止
 *   --quiet           少打印（树仍然打印）
 *
 * 退出码: 0 结构完好且（若有提取）回验通过；1 有结构问题或回验不通过；2 参数错误
 *
 * 可测性：纯函数 buildTree / analyzeStructure / normalizeName / planExtract 均已导出，
 * 供 tests/selftest.js 直接断言（见 §17.4 对"不可测脚本"的批评）。
 */

const fs = require('fs');
const path = require('path');
const L = require('./_lib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;

/* ============================================================
 * 1. 纯函数：名称归一化 / 结构分析
 * ============================================================ */

/**
 * 归一化一个条目名 → 相对路径。**不压平**：分隔符先归一化成 '/'，再切层级。
 * 返回 { rel, sepFixed, isDir, unsafe }
 *   sepFixed = true 表示原名字用的是 `\`（Windows 打包），已改写为 `/`
 *   unsafe   = 'abs' | 'traversal' | 'nul' | null
 */
function normalizeName(rawName) {
  let name = rawName;
  const sepFixed = name.indexOf('\\') >= 0;
  if (sepFixed) name = name.split('\\').join('/');

  const out = { rel: '', sepFixed, isDir: false, unsafe: null };

  if (name.indexOf('\u0000') >= 0) { out.unsafe = 'nul'; out.rel = name; return out; }
  if (/^[A-Za-z]:/.test(name) || name.startsWith('/')) { out.unsafe = 'abs'; }
  const isDir = name.endsWith('/');
  const parts = name.split('/').filter(s => s.length > 0);
  if (parts.some(s => s === '..')) out.unsafe = 'traversal';
  out.rel = (isDir ? parts.concat('').join('/') : parts.join('/'));
  out.isDir = isDir;
  return out;
}

/**
 * 由条目列表构建层级树。
 * 返回 { root, dirCount, fileCount, synthesizedDirs, issues, byDepth, perDir }
 * issues 每项：{ level:'error'|'notice', type, msg, rel }
 */
function buildTree(entries) {
  const root = { name: '', dirs: new Map(), files: [], dirEntrySeen: false, bytes: 0, count: 0 };
  const issues = [];
  const seen = new Map();          // 小写相对路径 → 原相对路径（查大小写冲突）
  let sepFixedCount = 0;
  let dirCount = 0;
  let fileCount = 0;
  const synthesized = new Set();

  function nodeFor(relDir) {
    const parts = relDir.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      if (!cur.dirs.has(p)) {
        cur.dirs.set(p, { name: p, dirs: new Map(), files: [], dirEntrySeen: false, bytes: 0, count: 0 });
        synthesized.add(acc);       // 先记为"由路径补出"，遇到显式目录条目再撤销
      }
      cur = cur.dirs.get(p);
    }
    return cur;
  }

  for (const e of entries) {
    const n = normalizeName(e.name);

    if (n.unsafe === 'abs') {
      issues.push({ level: 'error', type: 'absolute-path', msg: '条目名是绝对路径（解压会逃出目标目录）', rel: e.name });
      continue;
    }
    if (n.unsafe === 'traversal') {
      issues.push({ level: 'error', type: 'traversal', msg: '条目名含 ".."（路径穿越，拒绝提取）', rel: e.name });
      continue;
    }
    if (n.unsafe === 'nul') {
      issues.push({ level: 'error', type: 'nul-byte', msg: '条目名含 NUL 字节', rel: e.name });
      continue;
    }
    if (n.sepFixed) sepFixedCount++;

    const low = n.rel.toLowerCase();
    const prev = seen.get(low);
    if (prev !== undefined && prev !== n.rel) {
      issues.push({
        level: 'error', type: 'case-collision',
        msg: '仅大小写不同的同名路径（macOS 默认大小写不敏感，会互相覆盖 → 静默丢文件）',
        rel: prev + '  vs  ' + n.rel,
      });
    } else if (prev === n.rel) {
      issues.push({ level: 'error', type: 'duplicate', msg: '同一条相对路径在包内出现两次', rel: n.rel });
    } else {
      seen.set(low, n.rel);
    }

    const depth = n.rel.split('/').filter(Boolean).length;
    if (n.isDir) {
      dirCount++;
      const d = nodeFor(n.rel.replace(/\/$/, ''));
      d.dirEntrySeen = true;
      synthesized.delete(n.rel.replace(/\/$/, ''));
      if (e.usize > 0) {
        issues.push({ level: 'notice', type: 'dir-with-data', msg: '目录条目却有数据（少见，按目录处理）', rel: n.rel });
      }
    } else {
      fileCount++;
      const idx = n.rel.lastIndexOf('/');
      const dirRel = idx < 0 ? '' : n.rel.slice(0, idx);
      const nd = nodeFor(dirRel);
      nd.files.push({ name: n.rel.slice(idx + 1), rel: n.rel, usize: e.usize, crc: e.crc, depth });
    }
  }

  // 累加目录统计（自底向上）
  (function acc(node) {
    for (const [, d] of node.dirs) {
      acc(d);
      node.count += d.count;
      node.bytes += d.bytes;
    }
    node.count += node.files.length;
    for (const f of node.files) node.bytes += f.usize;
    return node;
  })(root);

  const depthStat = {};
  (function walk(node, d) {
    depthStat[d] = depthStat[d] || { dirs: 0, files: 0, bytes: 0 };
    for (const f of node.files) { depthStat[d].files++; depthStat[d].bytes += f.usize; }
    for (const [, sub] of node.dirs) {
      depthStat[d + 1] = depthStat[d + 1] || { dirs: 0, files: 0, bytes: 0 };
      depthStat[d + 1].dirs++;
      walk(sub, d + 1);
    }
  })(root, 0);

  const synthesizedDirs = [...synthesized].filter(p => p.length > 0);

  const perDir = {};
  (function walk3(node, prefix) {
    const subCount = [...node.dirs.values()].reduce((a, b) => a + b.count, 0);
    perDir[prefix || '.'] = { 子目录: node.dirs.size, 直属文件: node.count - subCount, 文件总数: node.count, 字节: node.bytes };
    for (const [name, sub] of node.dirs) walk3(sub, prefix ? prefix + '/' + name : name);
  })(root, '');

  return {
    root, dirCount, fileCount, synthesizedDirs, issues,
    sepFixedCount, byDepth: depthStat, perDir,
  };
}

/** 打印层级树（不压平：每一层都缩进，含目录汇总与文件大小） */
function printTree(root, opts) {
  const o = opts || {};
  const human = b => {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };
  const lines = [];

  function emitChildren(node, lead) {
    const dirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const total = dirs.length + files.length;
    let i = 0;
    for (const k of dirs) {
      const d = node.dirs.get(k);
      const last = (++i === total);
      lines.push('  ' + lead + (last ? '└── ' : '├── ') + L.C.bold(k + '/') +
        '  ' + L.C.dim('(' + d.count + ' 文件, ' + human(d.bytes) + ')'));
      emitChildren(d, lead + (last ? '    ' : '│   '));
    }
    for (const f of files) {
      const last = (++i === total);
      lines.push('  ' + lead + (last ? '└── ' : '├── ') + f.name + L.C.dim('  ' + human(f.usize)));
    }
  }

  emitChildren(root, '');
  return o.plain ? lines.map(s => s.replace(/\x1b\[[0-9;]*m/g, '')) : lines;
}

/** 从 EOCD 独立读出声明值，用于和逐条解析结果对账 */
function eocdDeclared(buf) {
  const L0 = L;
  const eocd = L0.findEOCD(buf);
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    const e64 = L0.findEOCD64(buf, eocd);
    if (e64 >= 0) {
      count = Number(buf.readBigUInt64LE(e64 + 32));
      cdSize = Number(buf.readBigUInt64LE(e64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(e64 + 48));
    }
  }
  return { count, cdSize, cdOffset, eocd };
}

/* ============================================================
 * 2. 提取（严格保层）+ 回验
 * ============================================================ */

/** 生成落盘计划：{ dirs:[rel...], files:[{rel, entry}] }；不做 IO，便于测试 */
function planExtract(entries) {
  const dirs = new Set();
  const files = [];
  const reusable = {};   // rel -> entry（同名后者覆盖前者会在这里暴露）
  for (const e of entries) {
    const n = normalizeName(e.name);
    if (n.unsafe) continue;
    if (n.isDir) { dirs.add(n.rel.replace(/\/$/, '')); continue; }
    const idx = n.rel.lastIndexOf('/');
    let d = idx < 0 ? '' : n.rel.slice(0, idx);
    const parts = d.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) { acc = acc ? acc + '/' + p : p; dirs.add(acc); }
    files.push({ rel: n.rel, entry: e });
    reusable[n.rel] = e;
  }
  return { dirs: [...dirs].filter(Boolean).sort(), files };
}

function extractAll(entries, outdir, opts) {
  const o = opts || {};
  const plan = planExtract(entries);
  const out = path.resolve(outdir);
  const created = [];
  const written = [];

  fs.mkdirSync(out, { recursive: true });
  for (const d of plan.dirs) {
    const abs = path.join(out, d);
    if (path.resolve(abs) !== abs || !abs.startsWith(out + path.sep)) {
      throw new Error('拒绝写越界目录：' + d);
    }
    fs.mkdirSync(abs, { recursive: true });
    created.push(d);
  }
  for (const f of plan.files) {
    const abs = path.join(out, f.rel);
    if (!path.resolve(abs).startsWith(out + path.sep)) {
      throw new Error('拒绝写越界文件：' + f.rel);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.entry.data);
    written.push(f.rel);
  }
  return { out, created, written, plan };
}

/** 回验：落盘集合 == 包内集合；size + CRC32 逐条相等 */
function verifyExtraction(outdir, entries) {
  const out = path.resolve(outdir);
  const expect = new Map();
  const dirsExpect = new Set();
  for (const e of entries) {
    const n = normalizeName(e.name);
    if (n.unsafe) continue;
    if (n.isDir) { dirsExpect.add(n.rel.replace(/\/$/, '')); continue; }
    expect.set(n.rel, e);
  }

  const onDisk = [];
  const missingDirs = [];
  (function walk(dir, prefix) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { missingDirs.push(prefix || '.'); return; }
    for (const it of items) {
      const rel = prefix ? prefix + '/' + it.name : it.name;
      if (it.isDirectory()) walk(path.join(dir, it.name), rel);
      else onDisk.push(rel);
    }
  })(out, '');

  const onDiskSet = new Set(onDisk);
  const problems = [];
  for (const rel of onDisk) {
    if (!expect.has(rel)) problems.push({ type: 'extra', msg: '落盘多出包内没有的文件（可能与旧内容混在一起）', rel });
  }
  for (const rel of dirsExpect) {
    if (!fs.existsSync(path.join(out, rel))) missingDirs.push(rel);
  }
  let sizeBad = 0, crcBad = 0, missing = 0;
  for (const [rel, e] of expect) {
    const abs = path.join(out, rel);
    if (!onDiskSet.has(rel)) { missing++; problems.push({ type: 'missing', msg: '包内有但落盘缺失', rel }); continue; }
    const st = fs.statSync(abs);
    if (st.size !== e.usize) { sizeBad++; problems.push({ type: 'size', msg: 'size 不符（包 ' + e.usize + ' / 盘 ' + st.size + '）', rel }); continue; }
    const crc = L.crc32(fs.readFileSync(abs));
    if (crc !== e.crc) { crcBad++; problems.push({ type: 'crc', msg: 'CRC32 不符', rel }); }
  }
  return {
    expectedFiles: expect.size, onDiskFiles: onDisk.length,
    missing, sizeBad, crcBad, missingDirs, problems,
    ok: problems.length === 0,
  };
}

/* ============================================================
 * 3. CLI
 * ============================================================ */

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const pos = [];
  const VALUED = { json: 1, 'name-enc': 1 };   // 需要跟一个值的选项
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([A-Za-z0-9_-]+)=(.*)$/.exec(a);
    if (eq) { flags[eq[1]] = eq[2]; continue; }
    const bare = /^--([A-Za-z0-9_-]+)$/.exec(a);
    if (bare) {
      const k = bare[1];
      // 带值选项必须在通用分支之前处理，否则 `--json x.json` 的 x.json 会被当成位置参数
      if (VALUED[k]) { flags[k] = argv[++i]; continue; }
      flags[k] = true;
      continue;
    }
    if (a === '-h') { flags.help = true; continue; }
    pos.push(a);
  }

  if (flags.help || pos.length === 0) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim()
      .split('\n').map(s => s.replace(/^\s*\*?\s?/, '')).join('\n'));
    process.exit(pos.length === 0 && !flags.help ? 2 : 0);
  }

  const archive = pos[0];
  const outdir = pos[1] || null;
  const doExtract = !!outdir && !flags.list;

  if (!fs.existsSync(archive)) { console.error(L.C.red('✗ 文件不存在：' + archive)); process.exit(2); }
  const buf = fs.readFileSync(archive);
  const sha = L.sha256File(archive);

  console.log(L.C.bold('■ ' + archive));
  console.log(L.C.dim('  ' + buf.length + ' 字节 ｜ SHA256 ' + sha.slice(0, 16) + '…'));

  let entries;
  try {
    entries = L.readZip(buf);
  } catch (e) {
    console.log('  ' + L.C.red('✗ 解析失败：' + e.message));
    process.exit(1);
  }

  // 名称编码逃生阀：强制按指定编码重解
  if (flags['name-enc']) {
    const enc = String(flags['name-enc']).toLowerCase();
    const dec = r => {
      if (enc === 'utf8') return r.toString('utf8');
      if (enc === 'gbk') return new TextDecoder('gbk').decode(r);
      if (enc === 'cp437') return L.cp437Decode(r);
      throw new Error('未知编码：' + enc);
    };
    for (const e of entries) { e.name = dec(e.nameRaw); e.nameEnc = enc; }
    console.log(L.C.yellow('  ⚠ 已强制按 ' + enc + ' 重解条目名'));
  }

  // ---- 结构自证 ----
  const decl = eocdDeclared(buf);
  const t = buildTree(entries);
  const encCount = {};
  for (const e of entries) encCount[e.nameEnc] = (encCount[e.nameEnc] || 0) + 1;
  const encStr = Object.keys(encCount).map(k => k + '×' + encCount[k]).join(' ');

  console.log('');
  console.log(L.C.bold('  层级完整性自证'));
  const countOk = decl && decl.count === entries.length;
  console.log('    条目总数        ' + entries.length + '（EOCD 声明 ' + (decl ? decl.count : '?') + '）' +
    (countOk ? L.C.green(' ✓ 一致') : L.C.red(' ✗ 不一致')));
  console.log('    目录条目        ' + t.dirCount + ' 显式' +
    (t.synthesizedDirs.length ? ' ＋ ' + t.synthesizedDirs.length + ' 由路径补层' : '') );
  console.log('    文件条目        ' + t.fileCount);
  const maxDepth = Math.max(...entries.map(e => normalizeName(e.name).rel.split('/').filter(Boolean).length));
  console.log('    最大层级        ' + maxDepth + ' 层（相对包根）');
  console.log('    名称编码        ' + encStr +
    (t.sepFixedCount ? ' ｜ ' + L.C.yellow(t.sepFixedCount + ' 条用 \\\\ 作分隔符（已归一化为 /）') : ''));
  console.log('    声明压缩包类型  ' + (entries[0] && entries[0].zip64 ? 'ZIP64' : 'ZIP'));

  // ---- 逐条 CRC ----
  let crcBad = 0;
  for (const e of entries) if (L.crc32(e.data) !== e.crc) { crcBad++; }
  console.log('    条目 CRC32      ' + (crcBad === 0
    ? L.C.green(entries.length + '/' + entries.length + ' 全部通过')
    : L.C.red(crcBad + ' 条不符')));

  // ---- 完整目录树 ----
  console.log('');
  console.log(L.C.bold('  完整目录树（每一层都保留，无压平）'));
  for (const line of printTree(t.root)) console.log(line);

  // ---- 相对路径清单（前若干条）----
  const rels = entries.map(e => normalizeName(e.name).rel).filter(Boolean);
  console.log('');
  console.log(L.C.dim('  相对路径清单：' + rels.length + ' 条' +
    (flags.json ? '（完整清单已写入 ' + flags.json + '）' : '（--json 可导出完整清单）')));

  // ---- 结构问题 ----
  const errs = t.issues.filter(i => i.level === 'error');
  const notes = t.issues.filter(i => i.level === 'notice');
  console.log('');
  if (notes.length) {
    console.log(L.C.dim('  提示 ' + notes.length + ' 项：'));
    for (const n of notes.slice(0, 8)) console.log(L.C.dim('    · [' + n.type + '] ' + n.rel + ' — ' + n.msg));
  }
  if (errs.length === 0) {
    console.log('  ' + L.C.green('结构问题 0 项 ✅'));
  } else {
    console.log('  ' + L.C.red('结构问题 ' + errs.length + ' 项：'));
    for (const e of errs) console.log('    ' + L.C.red('✗ [' + e.type + '] ' + e.rel + ' — ' + e.msg));
  }

  // ---- 提取 + 回验 ----
  let extracted = null;
  let vres = null;
  if (doExtract) {
    console.log('');
    if (fs.existsSync(outdir) && fs.readdirSync(outdir).length && !flags.force) {
      console.log('  ' + L.C.red('✗ 目标目录已存在且非空：' + outdir));
      console.log('    ' + L.C.dim('先清空，或加 --force 与既有内容合并（合并会带来"多出文件"风险）'));
      process.exit(1);
    }
    if (errs.length) {
      console.log('  ' + L.C.red('✗ 存在结构问题（路径穿越/重名/大小写冲突），拒绝提取'));
      process.exit(1);
    }
    try {
      extracted = extractAll(entries, outdir, {});
    } catch (e) {
      console.log('  ' + L.C.red('✗ 提取失败：' + e.message));
      process.exit(1);
    }
    console.log('  ' + L.C.cyan('↳ 已提取到 ' + extracted.out));
    console.log('    创建目录 ' + extracted.created.length + ' 个 ｜ 写出文件 ' + extracted.written.length + ' 个');
    vres = verifyExtraction(outdir, entries);
    console.log('    回验：包内 ' + vres.expectedFiles + ' 文件 vs 落盘 ' + vres.onDiskFiles + ' 文件 ｜ ' +
      '缺失 ' + vres.missing + ' ｜ size 不符 ' + vres.sizeBad + ' ｜ CRC 不符 ' + vres.crcBad);
    if (vres.ok) console.log('    ' + L.C.green('逐文件回验全部通过 ✅（集合、大小、CRC32 与中央目录完全一致）'));
    else {
      console.log('    ' + L.C.red('回验不通过：'));
      for (const p of vres.problems.slice(0, 15)) console.log('      ' + L.C.red('✗ [' + p.type + '] ' + p.rel + ' — ' + p.msg));
    }
  }

  // ---- JSON 结构清单 ----
  if (flags.json) {
    const manifest = {
      生成时间: new Date().toISOString(),
      压缩包: path.resolve(archive),
      字节数: buf.length,
      SHA256: sha,
      条目总数: entries.length,
      EOCD声明条目数: decl ? decl.count : null,
      目录条目数: t.dirCount,
      由路径补层目录数: t.synthesizedDirs.length,
      文件条目数: t.fileCount,
      最大层级: maxDepth,
      名称编码分布: encCount,
      反斜杠分隔条目数: t.sepFixedCount,
      ZIP64: !!(entries[0] && entries[0].zip64),
      条目CRC32: { 通过: entries.length - crcBad, 不符: crcBad },
      层级统计: t.byDepth,
      目录明细: t.perDir,
      结构问题: t.issues,
      相对路径: rels,
      每文件: entries.filter(e => !normalizeName(e.name).isDir).map(e => {
        const n = normalizeName(e.name);
        const rec = { 相对路径: n.rel, 深度: n.rel.split('/').filter(Boolean).length, 字节: e.usize, CRC32: e.crc >>> 0 };
        if (flags.sha) rec.SHA256 = require('crypto').createHash('sha256').update(e.data).digest('hex');
        return rec;
      }),
      提取: extracted ? { 目标目录: extracted.out, 创建目录数: extracted.created.length, 写出文件数: extracted.written.length, 回验: vres } : null,
    };
    L.ensureDirFor(flags.json);
    fs.writeFileSync(flags.json, JSON.stringify(manifest, null, 2), 'utf8');
    console.log('');
    console.log(L.C.dim('  结构清单已写入 ' + flags.json));
  }

  console.log('');
  const bad = errs.length + crcBad + (vres && !vres.ok ? 1 : 0);
  if (bad === 0) console.log(L.C.green('结论：目录结构完整，未发现遗漏或压平 ✅'));
  else console.log(L.C.red('结论：存在 ' + bad + ' 类问题，请先处置再使用 ❌'));
  process.exit(bad === 0 ? 0 : 1);
}

module.exports = {
  normalizeName, buildTree, planExtract, extractAll, verifyExtraction, eocdDeclared, printTree,
};

if (require.main === module) main();
