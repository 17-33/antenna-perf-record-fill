'use strict';
/**
 * zip_fixture.js —— 造 ZIP 字节，用于「目录结构解析」的回归测试
 *
 * 为什么要自己造包：真实交付包里不会同时出现「GBK 无标志位」「反斜杠分隔」
 * 「无目录条目」「路径穿越」「大小写冲突」「ZIP64」这些坏情形，
 * 而这些恰好是丢层级/丢文件的全部来源。造出来才能自动回归。
 *
 * 导出:
 *   buildZip(files, opts)  files: [{ name(Buffer|string), data, nameEnc?, flags?, store?, zip64? }]
 *   GBK                    常用中文的 GBK 字节表（Python 侧 `s.encode('gbk')` 生成后固化，
 *                          Node 无 GBK 编码器，故以常量形式内嵌）
 */

const zlib = require('zlib');
const { crc32 } = require('../scripts/_lib');

const SIG_LOC = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

/** 常用中文的 GBK 字节（由 `python3 -c "print('x'.encode('gbk').hex())"` 生成） */
const GBK = {
  '测试': 'b2e2cad4',
  '架标测试': 'bcdcb1eab2e2cad4',
  '接收': 'bdd3cad5',
  '号机': 'bac5bbfa',
  '俯仰': 'b8a9d1f6',
  '功率': 'b9a6c2ca',
  '方位': 'b7bdcebb',
};

/** 把 '35' + GBK('号机') + '/...' 这类混合名字拼成原始字节 */
function gbkPath(parts) {
  const bufs = [];
  for (const p of parts) {
    bufs.push(Buffer.from(GBK[p] !== undefined ? GBK[p] : p, GBK[p] !== undefined ? 'hex' : 'utf8'));
  }
  return Buffer.concat(bufs);
}

/**
 * 造一个合法 ZIP。
 * opts.zip64 = true 时额外写出 ZIP64 EOCD + 定位器，并把 EOCD 字段置哨兵值。
 */
function buildZip(files, opts) {
  const o = opts || {};
  const locals = [];
  const centrals = [];
  let offset = 0;
  let n = 0;

  for (const f of files) {
    const nameBuf = Buffer.isBuffer(f.name) ? f.name : Buffer.from(f.name, f.nameEnc || 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const usize = data.length;
    const store = f.store === true || f.method === 0;
    const method = store ? 0 : 8;
    const comp = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const csize = comp.length;
    const flags = f.flags !== undefined ? f.flags : 0x0800;

    // 条目扩展字段 0x0001（ZIP64）：usize / csize / lho，各 8 字节，按序
    let extra = Buffer.alloc(0);
    let wUsize = usize, wCsize = csize, wLho = offset;
    if (f.zip64) {
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(usize), 4);
      extra.writeBigUInt64LE(BigInt(csize), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      wUsize = 0xFFFFFFFF; wCsize = 0xFFFFFFFF; wLho = 0xFFFFFFFF;
    }

    const verNeed = f.zip64 ? 45 : 20;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOC, 0);
    lh.writeUInt16LE(verNeed, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.zip64 ? 0xFFFFFFFF : csize, 18);
    lh.writeUInt32LE(f.zip64 ? 0xFFFFFFFF : usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, nameBuf, extra, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CEN, 0);
    ch.writeUInt16LE(verNeed, 4);
    ch.writeUInt16LE(verNeed, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(wCsize, 20);
    ch.writeUInt32LE(wUsize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(wLho, 42);
    centrals.push(ch, nameBuf, extra);

    offset += 30 + nameBuf.length + extra.length + comp.length;
    n++;
  }

  const body = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;

  if (o.zip64) {
    const e64 = Buffer.alloc(56);
    e64.writeUInt32LE(SIG_EOCD64, 0);
    e64.writeBigUInt64LE(44n, 4);
    e64.writeUInt16LE(45, 12);
    e64.writeUInt16LE(45, 14);
    e64.writeUInt32LE(0, 16);
    e64.writeUInt32LE(0, 20);
    e64.writeBigUInt64LE(BigInt(n), 24);
    e64.writeBigUInt64LE(BigInt(n), 32);
    e64.writeBigUInt64LE(BigInt(cd.length), 40);
    e64.writeBigUInt64LE(BigInt(cdOffset), 48);

    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_EOCD64_LOC, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    loc.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(0xFFFF, 8);
    eocd.writeUInt16LE(0xFFFF, 10);
    eocd.writeUInt32LE(0xFFFFFFFF, 12);
    eocd.writeUInt32LE(0xFFFFFFFF, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([body, cd, e64, loc, eocd]);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([body, cd, eocd]);
}

module.exports = { buildZip, GBK, gbkPath };
