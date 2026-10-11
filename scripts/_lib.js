'use strict';
/**
 * _lib.js —— 「信关站电性能记录表 · 截图判读与填写」skill 的公共内核
 *
 * 设计约束（对应 SKILL.md §12.3 实现规范）：
 *   1. 零 npm 依赖、纯离线：只用 Node 内置 fs / path / zlib
 *   2. CRC32 自带查表法实现，不依赖 zlib.crc32
 *   3. 不硬编码任何绝对路径；所有路径由命令行显式传入
 *   4. xlsx 视作 zip：直接定点改写 xl/worksheets/sheet*.xml 与 xl/styles.xml
 *   5. 未修改的条目原样复用其压缩字节 —— 大文件（含图片）重打包既快又逐字节保真
 *
 * 兼容：Node >= 12
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ============================================================
 * 0. CRC32（自带查表法）
 * ============================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ============================================================
 * 1. ZIP 读
 * ============================================================ */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

/** CP437 高位（0x80–0xFF）码表 —— 未置 UTF-8 标志位且解不出 GBK 时的最后兜底 */
const CP437_HIGH =
  '\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5' +
  '\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9\u00FF\u00D6\u00DC\u00A2\u00A3\u00A5\u20A7\u0192\u00E1' +
  '\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA\u00BF\u2310\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB\u2591' +
  '\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510\u2514' +
  '\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567\u2568' +
  '\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580\u03B1' +
  '\u00DF\u0393\u03C0\u03A3\u03C3\u00B5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229\u2261' +
  '\u00B1\u2265\u2264\u2320\u2321\u00F7\u2248\u00B0\u2219\u00B7\u221A\u207F\u00B2\u25A0\u00A0';

/**
 * 解码 ZIP 条目名。
 *
 * ZIP 规范里名字是「原始字节 + 一个编码标志位」，**没有强制编码**：
 *   - 通用标志位 bit 11（0x0800）置位 → 必定 UTF-8（APPNOTE 6.3.0 起）
 *   - 未置位 → 规范只说"原始 ZIP 字符集"，实际是打包工具的本地代码页：
 *     中文 Windows（资源管理器 / 好压 / Bandizip / WinRAR 默认）用 **GBK**；
 *     欧美工具多为 CP437。macOS 自带 `unzip` 一律按 CP437 解 ⇒ **中文名必乱码**。
 *
 * 结论：**绝不能无条件 `toString('utf8')`** —— 那会把 GBK 包解成一串乱码名，
 * 而乱码名一旦落盘或被 writeZip 回写，就再也无法还原原始层级。
 * 返回 { name, enc }，enc ∈ 'utf8' | 'gbk' | 'cp437'。
 */
function decodeZipName(raw, flags) {
  if (flags & 0x0800) return { name: raw.toString('utf8'), enc: 'utf8' };
  let ascii = true;
  for (let i = 0; i < raw.length; i++) if (raw[i] > 0x7f) { ascii = false; break; }
  if (ascii) return { name: raw.toString('latin1'), enc: 'utf8' }; // 纯 ASCII 不必猜码页
  if (typeof TextDecoder === 'function') {
    try {
      // fatal:true ⇒ 非法字节序列直接抛错，避免把非 GBK 的字节悄悄解成替换符
      return { name: new TextDecoder('gbk', { fatal: true }).decode(raw), enc: 'gbk' };
    } catch (_) { /* 不是合法 GBK，退 CP437 */ }
  }
  return { name: cp437Decode(raw), enc: 'cp437' };
}

function cp437Decode(raw) {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  }
  return s;
}

function findEOCD(buf) {
  const min = 22;
  const maxBack = Math.min(buf.length, 22 + 65535);
  for (let i = buf.length - min; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * ZIP64 EOCD 定位器（固定 20 字节，紧贴 EOCD 之前）。
 * 结构：sig(4) 所在分卷(4) ZIP64-EOCD 偏移(8) 分卷总数(4)。
 * 返回 ZIP64 EOCD 记录偏移，找不到返回 -1。
 */
function findEOCD64(buf, eocd) {
  const loc = eocd - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) return -1;
  const off = Number(buf.readBigUInt64LE(loc + 8));
  if (off + 56 > buf.length || buf.readUInt32LE(off) !== SIG_EOCD64) return -1;
  return off;
}

/**
 * 解包 zip。返回条目数组（保持原始顺序），每个条目：
 * { name, nameRaw(Buffer), nameEnc, flags, method, modTime, modDate,
 *   crc, csize, usize, zip64, data(Buffer), comp(Buffer), dirty:false }
 *
 * 与旧版的区别（都是「完整保留目录结构」的前提）：
 *   1. 名称按 `decodeZipName` 解（标志位 → UTF-8 / GBK / CP437），不再无条件 UTF-8；
 *   2. 支持 ZIP64（条目数 / 中央目录偏移 / 单条目大小溢出），不再直接抛错；
 *   3. 保留 `nameRaw` 原始字节，便于上游做编码复核与结构比对。
 */
function readZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是合法 ZIP（未找到 EOCD 记录尾）');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let zip64 = false;

  // EOCD 里这两个字段一旦是哨兵值，真实值就在 ZIP64 EOCD 记录里
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    const e64 = findEOCD64(buf, eocd);
    if (e64 < 0) {
      throw new Error('EOCD 记录数/偏移为 ZIP64 哨兵值，但找不到 ZIP64 EOCD 定位器（文件可能被截断）');
    }
    count = Number(buf.readBigUInt64LE(e64 + 32));   // 总条目数
    cdOffset = Number(buf.readBigUInt64LE(e64 + 48)); // 中央目录偏移
    zip64 = true;
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error('中央目录损坏，偏移 ' + p + '（已解析 ' + i + '/' + count + ' 条）');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    let lho = buf.readUInt32LE(p + 42);
    const nameRaw = buf.slice(p + 46, p + 46 + nameLen);

    // ZIP64 条目扩展字段 0x0001：按 usize → csize → lho → diskStart 顺序排列，
    // 且**只写那些溢出成 0xFFFFFFFF 的**，所以必须按序逐个取，不能跳位。
    if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      let found = false;
      while (q + 4 <= qEnd) {
        const id = buf.readUInt16LE(q);
        const sz = buf.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(buf.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(buf.readBigUInt64LE(r)); r += 8; }
          if (lho === 0xFFFFFFFF) { lho = Number(buf.readBigUInt64LE(r)); r += 8; }
          found = true;
          break;
        }
        q += 4 + sz;
      }
      if (!found) throw new Error('ZIP64 条目缺 0x0001 扩展字段：' + nameRaw.toString('latin1'));
    }

    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOC) {
      throw new Error('本地文件头损坏：' + nameRaw.toString('latin1'));
    }
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方法 ' + method + '：' + nameRaw.toString('latin1'));
    if (data.length !== usize) {
      throw new Error('解压长度不符（期望 ' + usize + '，实得 ' + data.length + '）：' +
        nameRaw.toString('latin1'));
    }

    const dec = decodeZipName(nameRaw, flags);
    entries.push({
      name: dec.name, nameRaw, nameEnc: dec.enc, flags,
      method, modTime, modDate, crc, csize, usize, zip64,
      data, comp: Buffer.from(comp), dirty: false,
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/**
 * 打包 zip。未标脏的条目复用原压缩字节；标脏的重压缩（deflate，压不小就 store）。
 *
 * 名称策略：**统一按 UTF-8 重写并把标志位置 1**（规范化）。
 * 对读入时被识别为 GBK/CP437 的条目，`e.name` 已是正确 Unicode，
 * 重写后 Excel / 资源管理器 / macOS 三方都能正确显示（编码升级，不是丢失）。
 * 本 skill 只重写 xlsx（条目名全 ASCII），故不影响既有产物。
 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    let method, comp, crc, usize;

    if (e.dirty !== true && e.comp) {
      method = e.method; comp = e.comp; crc = e.crc; usize = e.usize;
    } else {
      const data = e.data;
      crc = crc32(data);
      usize = data.length;
      if (e.method === 0) {
        method = 0; comp = data;
      } else {
        const d = zlib.deflateRawSync(data, { level: 9 });
        if (d.length < data.length) { method = 8; comp = d; } else { method = 0; comp = data; }
      }
    }

    const modTime = e.modTime || 0;
    const modDate = e.modDate || 0x21; // 1980-01-01
    const flags = 0x0800; // UTF-8 名称

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOC, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(modTime, 10);
    lh.writeUInt16LE(modDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CEN, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(modTime, 12);
    ch.writeUInt16LE(modDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(locals.concat([cd, eocd]));
}

/** zipcheck 核心：结构 + 每条目 CRC32 + XML/RELS 良构 */
/**
 * ZIP / xlsx 完整性校验。
 * opts.strict = true 时，把「显式目录条目」升级为问题（默认仅作提示）。
 * 目录条目说明：Excel/WPS 写出的 xlsx 不含目录条目，但 Java/Python 等 zip 库
 * 常会写入（`xl/`、`_rels/`、`docProps/` …）。它们**不影响可读性**，
 * 仅提示"此文件不是 Excel 原生写出"，故默认不计入问题 —— 否则对这类
 * 交付文件会永远报错、把真正的 CRC/XML 问题淹没。
 */
function zipValidate(buf, opts) {
  const strict = !!(opts && opts.strict);
  const problems = [];
  const notices = [];
  let entries = [];
  try {
    entries = readZip(buf);
  } catch (e) {
    return { ok: false, problems: ['ZIP 结构不可读：' + e.message], notices, entries: [] };
  }
  for (const e of entries) {
    const c = crc32(e.data);
    if (c !== e.crc) {
      problems.push('CRC32 不符：' + e.name +
        '（头 ' + e.crc.toString(16) + ' / 实算 ' + c.toString(16) + '）');
    }
    if (/\.(xml|rels|vml)$/i.test(e.name) || e.name === '[Content_Types].xml') {
      const s = e.data.toString('utf8');
      if (!isWellFormedXml(s)) problems.push('XML 不良构：' + e.name + '（标签未配对或非法字符）');
    }
    if (e.name.endsWith('/')) {
      const msg = '显式目录条目（非 Excel 惯例，Excel/WPS 可正常打开，无害）：' + e.name;
      if (strict) problems.push(msg); else notices.push(msg);
    }
  }
  const names = entries.map(e => e.name);
  if (!names.includes('xl/workbook.xml')) problems.push('缺少 xl/workbook.xml');
  if (!names.includes('[Content_Types].xml')) problems.push('缺少 [Content_Types].xml');
  return { ok: problems.length === 0, problems, notices, entries };
}

/** 手写标签栈式良构检查（不引第三方 XML 解析器） */
function isWellFormedXml(src) {
  let s = src;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m, last = 0;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    if (/[<>]/.test(between)) {
      // 标签之间出现裸 < 或 >
      if (between.replace(/\s/g, '') !== '') return false;
    }
    last = m.index + m[0].length;
    if (m[1] === '/') {
      if (stack.length === 0 || stack[stack.length - 1] !== m[2]) return false;
      stack.pop();
    } else if (m[4] !== '/') {
      stack.push(m[2]);
    }
  }
  if (/[<>]/.test(s.slice(last))) return false;
  return stack.length === 0;
}

/* ============================================================
 * 2. XML 小工具
 * ============================================================ */

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attrOf(xml, name) {
  const re = new RegExp('(?:^|\\s)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]*)"');
  const m = re.exec(xml || '');
  return m ? m[1] : null;
}

function numAttr(xml, name) {
  const v = attrOf(xml, name);
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** 取 <tag ...> ... </tag> 的内部（第一个匹配） */
function sectionInner(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>');
  const m = re.exec(xml || '');
  return m ? m[1] : null;
}

/** 列出容器的直接子元素原文（含标签） */
function children(inner, tag) {
  const out = [];
  if (inner == null) return out;
  const re = new RegExp('<' + tag + '\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/' + tag + '>)', 'g');
  let m;
  while ((m = re.exec(inner))) out.push(m[0]);
  return out;
}

/** 在开标签上设置属性（保持其余属性不变） */
function setAttrOnOpenTag(xml, name, value) {
  const m = /^<([A-Za-z_][\w.:-]*)((?:"[^"]*"|[^>])*?)(\/?)>/.exec(xml);
  if (!m) return xml;
  const tag = m[1];
  let attrs = m[2] || '';
  const re = new RegExp('\\b' + name + '="[^"]*"');
  if (re.test(attrs)) attrs = attrs.replace(re, name + '="' + value + '"');
  else attrs = attrs.replace(/\s+$/, '') + ' ' + name + '="' + value + '"';
  return '<' + tag + attrs + (m[3] || '') + '>' + xml.slice(m[0].length);
}

function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }

function normXml(s) { return String(s).replace(/\s+/g, ''); }

/* ============================================================
 * 3. 单元格引用换算
 * ============================================================ */

function colToNum(col) {
  let n = 0;
  for (const ch of String(col).toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) throw new Error('非法列名：' + col);
    n = n * 26 + (c - 64);
  }
  return n;
}

function numToCol(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = (x - 1 - r) / 26;
  }
  return s;
}

function parseRef(ref) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error('非法单元格引用：' + ref);
  const col = colToNum(m[1]);
  const row = parseInt(m[2], 10);
  return { col, row, colName: numToCol(col), ref: numToCol(col) + row };
}

function refOf(col, row) { return numToCol(col) + row; }

/** 展开 "D5" / "D5:F12" / "A1:C20" 为单元格列表 */
function expandRange(spec) {
  const s = String(spec).trim().replace(/\$/g, '');
  const i = s.indexOf(':');
  if (i < 0) return [parseRef(s).ref];
  const a = parseRef(s.slice(0, i));
  const b = parseRef(s.slice(i + 1));
  const out = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push(refOf(c, r));
  }
  return out;
}

/**
 * 从工作表 XML 中取出合并区（<mergeCell ref="G4:G11"/>）。
 *
 * 为什么重要：模板里「一台天线一个值」的参数（面型标准偏差 σ、天线罩损耗…）
 * 会写成**合并单元格**。合并区里除左上锚点外的格在 XML 中仍然存在，
 * 并且继承了锚点的蓝底 FF00B0F0，但**按模板设计就是空的**——
 * 填进去反而破坏合并结构。dump/audit 若把蓝底当"待填"判据，
 * 就会把这批影子格误报成待填（本次 32 号机实测误报 14 格）。
 */
function parseMergeCells(xml) {
  const out = [];
  const blk = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml);
  const body = blk ? blk[1] : xml;
  const re = /<mergeCell\b[^>]*?\bref="([^"]+)"/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

/** 合并区里的"影子格"（非左上锚点）集合 —— 这些格应为空，不计入待填 */
function mergedShadowRefs(xml) {
  const set = new Set();
  for (const r of parseMergeCells(xml)) {
    const refs = expandRange(r);
    for (let i = 1; i < refs.length; i++) set.add(refs[i]);
  }
  return set;
}

/* ============================================================
 * 4. sheet XML 解析
 * ============================================================ */

const C_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

function parseSheet(xml) {
  const cells = new Map();
  const rows = [];
  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rowAttrs = m[1] || '';
    const rowInner = m[3] || '';
    const rm = /\br="(\d+)"/.exec(rowAttrs);
    const rowNum = rm ? parseInt(rm[1], 10)
      : (rows.length ? rows[rows.length - 1].row + 1 : 1);
    const rowRec = {
      row: rowNum,
      start: m.index,
      end: m.index + m[0].length,
      attrs: rowAttrs,
      inner: rowInner,
      selfClosing: m[2] === '/>',
      full: m[0],
    };
    rows.push(rowRec);

    C_RE.lastIndex = 0;
    let cm;
    let prevCol = 0;
    while ((cm = C_RE.exec(rowInner))) {
      const attrs = cm[1] || '';
      const inner = cm[3] == null ? null : cm[3];
      const rAttr = /(?:^|\s)r="([A-Za-z]+\d+)"/.exec(attrs);
      let ref;
      if (rAttr) {
        ref = rAttr[1].toUpperCase();
        prevCol = colToNum(/^[A-Z]+/.exec(ref)[0]);
      } else {
        prevCol += 1;
        ref = refOf(prevCol, rowNum);
      }
      const sAttr = /(?:^|\s)s="(-?\d+)"/.exec(attrs);
      const tAttr = /(?:^|\s)t="([^"]+)"/.exec(attrs);
      const fM = inner == null ? null : /<f\b[\s\S]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(inner);
      const vM = inner == null ? null : /<v>([\s\S]*?)<\/v>/.exec(inner);
      const isM = inner == null ? null : /<is>([\s\S]*?)<\/is>/.exec(inner);
      cells.set(ref, {
        ref,
        row: rowNum,
        attrs,
        s: sAttr ? parseInt(sAttr[1], 10) : 0,
        t: tAttr ? tAttr[1] : null,
        formula: fM ? fM[0] : null,
        vRaw: vM ? vM[1] : null,
        isRaw: isM ? isM[1] : null,
        inner,
        selfClosing: cm[2] === '/>',
        full: cm[0],
        rowIndex: rows.length - 1,
      });
    }
  }
  return { cells, rows };
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b(?:\s*\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1] || '';
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let tm;
    while ((tm = tRe.exec(inner))) text += tm[1] == null ? '' : tm[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

function parseStyles(xml) {
  const empty = { fonts: [], fills: [], borders: [], cellXfs: [], raw: xml || '' };
  if (!xml) return empty;
  const fontsInner = sectionInner(xml, 'fonts');
  const fillsInner = sectionInner(xml, 'fills');
  const bordersInner = sectionInner(xml, 'borders');
  const xfsInner = sectionInner(xml, 'cellXfs');
  return {
    fonts: children(fontsInner, 'font'),
    fills: children(fillsInner, 'fill'),
    borders: children(bordersInner, 'border'),
    cellXfs: children(xfsInner, 'xf'),
    raw: xml,
  };
}

/** 取单元格的填充色（fgColor）。无填充 / patternType=none 返回 null */
function extractFillRgb(fillXml) {
  if (!fillXml) return null;
  const pm = /<patternFill\b([^>]*)>/.exec(fillXml);
  if (!pm) return null;
  const pt = attrOf(pm[1] || '', 'patternType');
  if (!pt || pt === 'none') return null;
  const fg = /<fgColor\b([^>]*)\/?>/.exec(fillXml);
  if (fg) {
    const rgb = attrOf(fg[1], 'rgb');
    if (rgb) return rgb.toUpperCase();
    const th = attrOf(fg[1], 'theme');
    if (th != null) return 'theme:' + th;
    const ix = attrOf(fg[1], 'indexed');
    if (ix != null) return 'indexed:' + ix;
  }
  return 'pattern:' + pt;
}

/** 生成「红字加粗」字体 XML：保留原字体其余属性，仅置 <b/> 与 <color rgb="FFFF0000"/> */
function makeRedBoldFont(origFontXml) {
  const src = origFontXml || '<font><sz val="11"/><name val="等线"/></font>';
  const m = /^<font\b[^>]*>/.exec(src);
  const openTag = m ? m[0] : '<font>';
  let inner = src.slice(openTag.length).replace(/<\/font>\s*$/, '');
  inner = inner
    .replace(/<b\b[^>]*\/>/g, '')
    .replace(/<b\b[^>]*>[\s\S]*?<\/b>/g, '')
    .replace(/<color\b[^>]*\/>/g, '')
    .replace(/<color\b[^>]*>[\s\S]*?<\/color>/g, '');
  const nameM = /<(name|family|charset|scheme|sz)\b/.exec(inner);
  let withColor;
  if (nameM) withColor = inner.slice(0, nameM.index) + '<color rgb="FFFF0000"/>' + inner.slice(nameM.index);
  else withColor = inner + '<color rgb="FFFF0000"/>';
  return '<font><b/>' + withColor + '</font>';
}

function setContainerCount(xml, container, n) {
  const has = new RegExp('<' + container + '\\b[^>]*?count="\\d+"');
  if (has.test(xml)) return xml.replace(new RegExp('(<' + container + '\\b[^>]*?)count="\\d+"'), '$1count="' + n + '"');
  return xml.replace(new RegExp('<' + container + '\\b'), '<' + container + ' count="' + n + '"');
}

function appendChildTo(xml, container, childXml) {
  const close = '</' + container + '>';
  const i = xml.indexOf(close);
  if (i < 0) throw new Error('styles.xml 缺少 ' + close);
  return xml.slice(0, i) + childXml + xml.slice(i);
}

function fmtNum(v) {
  if (!isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const r = Number(v.toPrecision(12));
  return String(r);
}

/* ============================================================
 * 5. Sheet 结构常量（对应 SKILL.md §2 / §10）
 * ============================================================ */

const RX_FREQS = [37.5, 37.75, 38, 39.95, 39.975, 40, 40.025, 40.05];
const TX_FREQS = [47.2, 48, 49.2, 49.7, 49.72, 49.75, 49.78, 49.8];
const LO_RX = 34.5;
const LO_TX = 44.2;

const SHEET_ALIASES = {
  pattern: ['方向图'],
  eirp: ['EIRP', 'EIRP-公式法', 'EIRP公式法'],
  gt: ['GT', 'G/T', 'GT-公式法', 'GT公式法', 'G-T'],
  tracking: ['跟踪精度'],
  forward: ['前向链路', '前向链路（接收）标定', '前向链路(接收)标定'],
};

const SHEET_STRUCT = {
  pattern: { rowsRX: [5, 6, 7, 8, 9, 10, 11, 12], rowsTX: [13, 14, 15, 16, 17, 18, 19, 20] },
  eirp: { rows: [4, 5, 6, 7, 8, 9, 10, 11] },
  gt: { rows: [4, 5, 6, 7, 8, 9, 10, 11] },
  tracking: { rows: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  forward: { rows: [3, 4, 5, 6, 7, 8, 9, 10] },
};

const BLUE = 'FF00B0F0';
const RED = 'FFFF0000';
const TANT = 230; // K

/** 面精度损耗 Lm = 685.81 * σ² / λ²，λ(mm) = 300/f(GHz) */
function faceLoss( sigma, fGHz ) {
  const lambda = 300 / fGHz; // mm
  return 685.81 * sigma * sigma / (lambda * lambda);
}

/* ============================================================
 * 6. Workbook
 * ============================================================ */

class Workbook {
  constructor(entries, srcPath) {
    this.entries = entries;
    this.srcPath = srcPath || null;
    this.map = new Map();
    for (const e of entries) this.map.set(e.name, e);
    this._parse();
  }

  static load(p) {
    if (!fs.existsSync(p)) throw new Error('文件不存在：' + p);
    const buf = fs.readFileSync(p);
    // OLE2 复合文档魔数 D0CF11E0A1B1 1AE1 —— 即 Excel 97-2003(.xls)/老 .doc/.ppt
    if (buf.length >= 8 && buf.readUInt32LE(0) === 0xE011CFD0 && buf.readUInt32LE(4) === 0xE11AB1A1) {
      throw new Error('这是 Excel 97-2003 老格式（.xls），本工具只认 .xlsx。\n' +
        '    请用 Excel / WPS 打开后「另存为 → Excel 工作簿(*.xlsx)」再重试：' + p);
    }
    try {
      return new Workbook(readZip(buf), p);
    } catch (e) {
      throw new Error('无法按 xlsx 解析「' + p + '」：' + e.message + '\n' +
        '    （.xlsx 本质是 ZIP 包；若该文件实为 .xls 或已损坏，请先另存为 .xlsx）');
    }
  }

  _parse() {
    const dec = n => {
      const e = this.map.get(n);
      return e ? e.data.toString('utf8') : null;
    };
    this.wbXml = dec('xl/workbook.xml');
    if (!this.wbXml) throw new Error('不是合法 xlsx：缺少 xl/workbook.xml');
    this.relsXml = dec('xl/_rels/workbook.xml.rels');
    this.shared = parseSharedStrings(dec('xl/sharedStrings.xml'));
    this.stylesXml = dec('xl/styles.xml') || '';
    this.styles = parseStyles(this.stylesXml);

    const rels = new Map();
    if (this.relsXml) {
      const re = /<Relationship\b[^>]*\/?>/g;
      let m;
      while ((m = re.exec(this.relsXml))) {
        const id = attrOf(m[0], 'Id');
        const tgt = attrOf(m[0], 'Target');
        if (id && tgt) rels.set(id, tgt);
      }
    }

    this.sheetPathByName = new Map();
    const sre = /<sheet\b[^>]*\/?>/g;
    let sm;
    while ((sm = sre.exec(this.wbXml))) {
      const nm = attrOf(sm[0], 'name');
      if (!nm) continue;
      const rid = attrOf(sm[0], 'r:id') || attrOf(sm[0], 'id');
      const tgt = rels.get(rid);
      let p = null;
      if (tgt) {
        p = tgt.replace(/^\/+/, '');
        if (!/^xl\//.test(p)) p = 'xl/' + p;
      }
      if (p && this.map.has(p)) this.sheetPathByName.set(nm, p);
    }
    if (this.sheetPathByName.size === 0) {
      for (const e of this.entries) {
        const m = /^xl\/worksheets\/sheet\d+\.xml$/.exec(e.name);
        if (m) this.sheetPathByName.set(m[0].replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), e.name);
      }
    }
    this._sheetXmlCache = new Map();
  }

  sheetNames() { return [...this.sheetPathByName.keys()]; }

  /** 名称解析：精确 → 别名 → 前缀/包含 */
  resolveSheet(name) {
    const names = this.sheetNames();
    if (names.includes(name)) return name;
    for (const key of Object.keys(SHEET_ALIASES)) {
      if (!SHEET_ALIASES[key].includes(name) && key !== name) continue;
      for (const cand of SHEET_ALIASES[key]) {
        const hit = names.find(n => n === cand || n.startsWith(cand) || n.includes(cand));
        if (hit) return hit;
      }
    }
    const hit = names.find(n => n.includes(name) || name.includes(n));
    if (hit) return hit;
    throw new Error('找不到工作表「' + name + '」。现有：' + names.join(' / '));
  }

  /** 按语义键（pattern/eirp/gt/tracking/forward）找表名 */
  resolveSheetByKey(key) {
    const names = this.sheetNames();
    const cands = SHEET_ALIASES[key];
    if (!cands) throw new Error('未知表键：' + key);
    for (const cand of cands) {
      const hit = names.find(n => n === cand);
      if (hit) return hit;
    }
    for (const cand of cands) {
      const hit = names.find(n => n.startsWith(cand) || n.includes(cand));
      if (hit) return hit;
    }
    return null;
  }

  getXml(name) {
    const real = this.resolveSheet(name);
    const p = this.sheetPathByName.get(real);
    if (!this._sheetXmlCache.has(p)) this._sheetXmlCache.set(p, this.map.get(p).data.toString('utf8'));
    return this._sheetXmlCache.get(p);
  }

  setXml(name, xml) {
    const real = this.resolveSheet(name);
    const p = this.sheetPathByName.get(real);
    const e = this.map.get(p);
    e.data = Buffer.from(xml, 'utf8');
    e.dirty = true;
    this._sheetXmlCache.set(p, xml);
    if (this._shadowCache) this._shadowCache.delete(real);
  }

  /**
   * 该表的合并区「影子格」集合（合并区内除左上锚点外的格）。
   *
   * 为什么单独抽出来：模板把「一台天线一个值」的参数（面型标准偏差 σ、
   * 天线罩损耗…）写成合并单元格，影子格在 XML 里仍然存在、还继承了锚点蓝底，
   * 但**按设计就该是空的**。若把「蓝底 + 空值」一律当待填，会误报；
   * 若往里写值，Excel 也**不会显示**（只显示锚点），是静默丢数据。
   */
  shadowRefs(name) {
    const real = this.resolveSheet(name);
    if (!this._shadowCache) this._shadowCache = new Map();
    if (!this._shadowCache.has(real)) {
      this._shadowCache.set(real, mergedShadowRefs(this.getXml(real)));
    }
    return this._shadowCache.get(real);
  }

  parsedSheet(name) { return parseSheet(this.getXml(name)); }

  /* ---- 读单元格 ---- */

  cell(name, ref) {
    const cells = this.parsedSheet(name).cells;
    const c = cells.get(parseRef(ref).ref);
    return c ? this.decorate(c) : null;
  }

  decorate(c) {
    const xf = this.styles.cellXfs[c.s] || '';
    const fontId = numAttr(xf, 'fontId');
    const fillId = numAttr(xf, 'fillId');
    const font = fontId != null ? (this.styles.fonts[fontId] || '') : '';
    const fill = fillId != null ? (this.styles.fills[fillId] || '') : '';
    const cm = /<color\b[^>]*rgb="([0-9A-Fa-f]{8})"/.exec(font);
    return {
      ref: c.ref, s: c.s, t: c.t,
      formula: c.formula,
      isFormula: !!c.formula,
      value: this.cellValue(c),
      bold: /<b\b[^>]*\/>|<b\b[^>]*>/.test(font),
      fontRgb: cm ? cm[1].toUpperCase() : null,
      fillRgb: extractFillRgb(fill),
      raw: c,
    };
  }

  cellValue(c) {
    if (c.isRaw != null) return decodeXmlEntities(stripTags(c.isRaw));
    if (c.vRaw != null) {
      if (c.t === 's') {
        const i = parseInt(c.vRaw, 10);
        return this.shared[i] != null ? this.shared[i] : '#' + c.vRaw;
      }
      if (c.t === 'str' || c.t === 'inlineStr') return decodeXmlEntities(c.vRaw);
      if (c.t === 'b') return c.vRaw === '1';
      const n = Number(c.vRaw);
      return isNaN(n) ? c.vRaw : n;
    }
    return null;
  }

  /* ---- 样式：追加"红字加粗"变体 ---- */

  addRedBoldVariant(xfIndex) {
    const origXf = this.styles.cellXfs[xfIndex] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const fontId = numAttr(origXf, 'fontId');
    const origFont = fontId != null ? (this.styles.fonts[fontId] || '') : (this.styles.fonts[0] || '');
    const wantFont = normXml(makeRedBoldFont(origFont));

    let newFontId = this.styles.fonts.findIndex(f => normXml(f) === wantFont);
    let sx = this.stylesXml;
    if (newFontId < 0) {
      newFontId = this.styles.fonts.length;
      const fontXml = makeRedBoldFont(origFont);
      sx = appendChildTo(sx, 'fonts', fontXml);
      this.styles.fonts.push(fontXml);
      sx = setContainerCount(sx, 'fonts', this.styles.fonts.length);
    }

    let newXf = origXf;
    newXf = setAttrOnOpenTag(newXf, 'fontId', String(newFontId));
    newXf = setAttrOnOpenTag(newXf, 'applyFont', '1');
    const wantXf = normXml(newXf);

    let newXfId = this.styles.cellXfs.findIndex((x, i) => i !== xfIndex && normXml(x) === wantXf);
    if (newXfId < 0) {
      newXfId = this.styles.cellXfs.length;
      sx = appendChildTo(sx, 'cellXfs', newXf);
      this.styles.cellXfs.push(newXf);
      sx = setContainerCount(sx, 'cellXfs', this.styles.cellXfs.length);
    }

    if (sx !== this.stylesXml) {
      this.stylesXml = sx;
      this.styles.raw = sx;
      const e = this.map.get('xl/styles.xml');
      e.data = Buffer.from(sx, 'utf8');
      e.dirty = true;
    }
    return newXfId;
  }

  /* ---- 写单元格 ---- */

  /**
   * @returns {{ok:boolean, ref:string, reason?:string}}
   */
  writeCell(name, ref, value, opts) {
    opts = opts || {};
    const key = parseRef(ref).ref;
    let xml = this.getXml(name);
    const parsed = parseSheet(xml);
    const c = parsed.cells.get(key);

    if (c && c.formula) return { ok: false, ref: key, reason: 'formula' };
    // 合并区影子格：写进去 Excel 也不显示（只显示锚点），等于静默丢数据 → 默认拒绝
    if (!opts.allowShadow && this.shadowRefs(name).has(key)) {
      return { ok: false, ref: key, reason: 'merged-shadow' };
    }

    let sIdx;
    if (opts.mark) sIdx = this.addRedBoldVariant(c ? c.s : 0);
    else sIdx = opts.style != null ? opts.style : (c ? c.s : 0);

    const cellXml = buildCellXml(key, value, sIdx);

    if (c) {
      const at = xml.indexOf(c.full);
      if (at < 0) return { ok: false, ref: key, reason: 'anchor-not-found' };
      xml = xml.slice(0, at) + cellXml + xml.slice(at + c.full.length);
    } else {
      xml = insertCellXml(xml, key, cellXml);
    }
    xml = updateDimension(xml);
    this.setXml(name, xml);
    return { ok: true, ref: key };
  }

  /** 只上标记（红字加粗）、不改值。用于 mark 里列出了但本次没写值的格。 */
  markCell(name, ref, opts) {
    opts = opts || {};
    const key = parseRef(ref).ref;
    let xml = this.getXml(name);
    const parsed = parseSheet(xml);
    const c = parsed.cells.get(key);
    if (c && c.formula) return { ok: false, ref: key, reason: 'formula' };
    if (!opts.allowShadow && this.shadowRefs(name).has(key)) {
      return { ok: false, ref: key, reason: 'merged-shadow' };
    }
    const sIdx = this.addRedBoldVariant(c ? c.s : 0);
    let cellXml;
    if (!c) {
      cellXml = '<c r="' + key + '" s="' + sIdx + '"/>';
      xml = insertCellXml(xml, key, cellXml);
    } else {
      const inner = c.inner == null ? null : c.inner;
      const tAttr = c.t ? ' t="' + c.t + '"' : '';
      cellXml = inner == null
        ? '<c r="' + key + '" s="' + sIdx + '"' + tAttr + '/>'
        : '<c r="' + key + '" s="' + sIdx + '"' + tAttr + '>' + inner + '</c>';
      const at = xml.indexOf(c.full);
      if (at < 0) return { ok: false, ref: key, reason: 'anchor-not-found' };
      xml = xml.slice(0, at) + cellXml + xml.slice(at + c.full.length);
    }
    xml = updateDimension(xml);
    this.setXml(name, xml);
    return { ok: true, ref: key };
  }

  /** 清空一个格：保留样式、去掉值/公式/文本 */
  blankCell(name, ref) {
    const key = parseRef(ref).ref;
    let xml = this.getXml(name);
    const parsed = parseSheet(xml);
    const c = parsed.cells.get(key);
    if (!c) return false;
    const stub = '<c r="' + key + '" s="' + c.s + '"/>';
    const at = xml.indexOf(c.full);
    if (at < 0) return false;
    xml = xml.slice(0, at) + stub + xml.slice(at + c.full.length);
    this.setXml(name, xml);
    return true;
  }

  /**
   * 把 <calcPr> 标上 fullCalcOnLoad="1"，强制 Excel/WPS 打开时全表重算。
   *
   * 为什么必须有：xlsx 的公式格同时存「公式」和「上一次的缓存结果 <v>」。
   * 一旦本工具往公式的**入参格**写了新值，缓存结果就过期了 ——
   * 文件里仍显示旧数字，直到有人真的打开并重算。更糟的是 `analyze.js`
   * 会把「重算值 vs 缓存值」的差异报成「不一致」，看起来像填错了。
   * 见 SKILL.md §17.5。
   */
  forceRecalc() {
    const e = this.map.get('xl/workbook.xml');
    if (!e) return false;
    let s = e.data.toString('utf8');
    if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(s)) return true;
    if (/<calcPr\b[^>]*\/>/.test(s)) {
      s = s.replace(/<calcPr\b([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
    } else {
      // 无 <calcPr> → 补一个，位置须在 <sheets> 之后（schema 顺序要求）
      s = s.replace(/(<\/sheets>)/, '$1<calcPr fullCalcOnLoad="1"/>');
    }
    e.data = Buffer.from(s, 'utf8');
    e.dirty = true;
    return true;
  }

  save(p) {
    fs.writeFileSync(p, writeZip(this.entries));
  }
}

function buildCellXml(ref, value, s) {
  const sAttr = ' s="' + s + '"';
  if (value === null || value === undefined || value === '') {
    return '<c r="' + ref + '"' + sAttr + '/>';
  }
  if (typeof value === 'number' && isFinite(value)) {
    return '<c r="' + ref + '"' + sAttr + '><v>' + fmtNum(value) + '</v></c>';
  }
  const text = String(value);
  const sp = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t' + sp + '>' + escXml(text) + '</t></is></c>';
}

function insertCellXml(xml, ref, cellXml) {
  const { col, row } = parseRef(ref);
  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  let target = null;
  while ((m = rowRe.exec(xml))) {
    const rm = /\br="(\d+)"/.exec(m[1] || '');
    const rn = rm ? parseInt(rm[1], 10) : null;
    if (rn === row) { target = m; break; }
    if (rn != null && rn > row) break;
  }
  if (target) {
    const attrs = target[1] || '';
    const inner = target[3] || '';
    const cRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let insertAt = inner.length;
    while ((cm = cRe.exec(inner))) {
      const rAttr = /(?:^|\s)r="([A-Za-z]+\d+)"/.exec(cm[1] || '');
      if (!rAttr) continue;
      const cCol = colToNum(/^[A-Z]+/i.exec(rAttr[1])[0]);
      if (cCol > col) { insertAt = cm.index; break; }
    }
    const newRow = '<row' + attrs + '>' + inner.slice(0, insertAt) + cellXml + inner.slice(insertAt) + '</row>';
    return xml.slice(0, target.index) + newRow + xml.slice(target.index + target[0].length);
  }
  const newRow = '<row r="' + row + '">' + cellXml + '</row>';
  const re2 = /<row\b([^>]*?)(\/>|>[\s\S]*?<\/row>)/g;
  let mm;
  let pos = -1;
  while ((mm = re2.exec(xml))) {
    const rm = /\br="(\d+)"/.exec(mm[1] || '');
    const rn = rm ? parseInt(rm[1], 10) : null;
    if (rn != null && rn > row) { pos = mm.index; break; }
  }
  if (pos < 0) {
    const e = xml.indexOf('</sheetData>');
    pos = e < 0 ? xml.length : e;
  }
  return xml.slice(0, pos) + newRow + xml.slice(pos);
}

function updateDimension(xml) {
  const parsed = parseSheet(xml);
  let minC = Infinity, maxC = 0, minR = Infinity, maxR = 0;
  for (const c of parsed.cells.values()) {
    const p = parseRef(c.ref);
    if (p.col < minC) minC = p.col;
    if (p.col > maxC) maxC = p.col;
    if (p.row < minR) minR = p.row;
    if (p.row > maxR) maxR = p.row;
  }
  if (maxC === 0) return xml;
  const ref = refOf(minC, minR) + ':' + refOf(maxC, maxR);
  if (/<dimension\b/.test(xml)) return xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="' + ref + '"/>');
  const anchors = ['<sheetViews', '<sheetFormatPr', '<cols', '<sheetData'];
  for (const a of anchors) {
    const i = xml.indexOf(a);
    if (i >= 0) return xml.slice(0, i) + '<dimension ref="' + ref + '"/>' + xml.slice(i);
  }
  return xml;
}

/* ============================================================
 * 7. 文件 / 输入工具
 * ============================================================ */

function readTextFile(p) {
  const buf = fs.readFileSync(p);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const b = Buffer.from(buf.slice(2));
    if (b.length % 2 === 0) b.swap16();
    return b.toString('utf16le');
  }
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}

function readJson(p) {
  const s = readTextFile(p).replace(/^\uFEFF/, '').trim();
  if (!s) throw new Error('JSON 文件为空：' + p);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error('JSON 解析失败（' + p + '）：' + e.message);
  }
}

function ensureDirFor(p) {
  const d = path.dirname(path.resolve(p));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function sha256File(p) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/* ---- 终端色彩（无依赖，尊重 NO_COLOR / 非 TTY） ---- */
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  red: s => USE_COLOR ? '\x1b[31m' + s + '\x1b[0m' : s,
  green: s => USE_COLOR ? '\x1b[32m' + s + '\x1b[0m' : s,
  yellow: s => USE_COLOR ? '\x1b[33m' + s + '\x1b[0m' : s,
  cyan: s => USE_COLOR ? '\x1b[36m' + s + '\x1b[0m' : s,
  magenta: s => USE_COLOR ? '\x1b[35m' + s + '\x1b[0m' : s,
  dim: s => USE_COLOR ? '\x1b[2m' + s + '\x1b[0m' : s,
  bold: s => USE_COLOR ? '\x1b[1m' + s + '\x1b[0m' : s,
};

/* ---- 单元格显示 ---- */
/**
 * 单格图例（网格视图用）。
 * @param {object} info  decorate() 的返回
 * @param {boolean} shadow 该格是否属于合并区影子格（属则蓝底≠待填）
 */
function cellGlyph(info, shadow) {
  if (!info) return C.dim('·');
  if (info.isFormula) return C.cyan('ƒ');
  const hasVal = info.value !== null && info.value !== undefined && info.value !== '';
  const isBlue = info.fillRgb === BLUE;
  const isRedBold = info.fontRgb === RED && info.bold;
  if (hasVal && isRedBold) return C.red('●');   // 已按图填写
  if (hasVal) return '○';
  if (isBlue) return shadow ? C.magenta('▫') : C.yellow('□');  // ▫ 影子格（按设计留空）｜□ 待填
  return C.dim('·');
}

function fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/* ============================================================
 * 导出
 * ============================================================ */

module.exports = {
  // zip
  crc32, readZip, writeZip, zipValidate, isWellFormedXml,
  decodeZipName, cp437Decode, findEOCD, findEOCD64,
  // xml
  escXml, decodeXmlEntities, attrOf, numAttr, sectionInner, children,
  setAttrOnOpenTag, stripTags, normXml, setContainerCount, appendChildTo,
  // ref
  colToNum, numToCol, parseRef, refOf, expandRange,
  parseMergeCells, mergedShadowRefs,
  // xlsx
  parseSheet, parseSharedStrings, parseStyles, extractFillRgb, makeRedBoldFont,
  buildCellXml, insertCellXml, updateDimension,
  Workbook,
  // consts
  RX_FREQS, TX_FREQS, LO_RX, LO_TX, SHEET_ALIASES, SHEET_STRUCT, BLUE, RED, TANT, faceLoss,
  // io
  readTextFile, readJson, ensureDirFor, sha256File, fmtNum, fmtVal, cellGlyph, C,
};
