#!/usr/bin/env node
/**
 * merge_judge.js —— 把多遍 OCR 判读结果合并为自洽的「判读终值」（SKILL.md §17.6）
 *
 * 为什么需要：`read_spectrum.js` 会在某些图/某些列上**丢掉 marker**（§17.6 实测 RX 段
 * 稳定丢 3dB/10dB 单侧 marker），而原始 OCR 往往是有值的。单遍判读结果因此
 * 不可作为最终证据 —— 直接喂给 `crosscheck.js` 会报一堆假的「缺判读」。
 *
 * 合并规则：
 *   1. 以「底稿遍」为基准（实测取第 2 遍更稳：两遍分歧处第 2 遍全部与表内吻合）；
 *   2. 从「补充遍」补入底稿缺的 marker（按 `type` 判重）—— 可挽回大部分解析丢失；
 *   3. 两遍都缺的，用 `--manual=<补丁.json>` 从**原始 OCR** 定论补入，
 *      补丁项必须写 `note` 注明凭据（如「ocr/ 与 ocr2/ 两遍均读出 2.2974」）。
 *
 * 用法:
 *   node merge_judge.js <底稿.json> <补充遍.json> <输出.json> [--manual=补丁.json]
 *   node merge_judge.js --help
 *
 * 补丁 JSON:
 *   { "overrides": [ { "name": "架标测试__接收__37.75俯仰.jpg", "type": "D7",
 *                      "kind": "10dB", "side": "pos", "x": 2.2974,
 *                      "yv": -10.08, "delta": -10.08, "note": "原始 OCR 两遍均读出" } ] }
 *
 * 输出格式与 `read_spectrum.js` 一致（{ results: [...] }），可直接喂 `crosscheck.js`。
 * 退出码：0 = 成功；1 = 参数/文件错误
 */
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('用法: node merge_judge.js <底稿.json> <补充遍.json> <输出.json> [--manual=补丁.json]');
  console.log('');
  console.log('  底稿.json    作为基准的判读结果（实测取第 2 遍更稳）');
  console.log('  补充遍.json  用于补入底稿缺失 marker 的另一次判读结果');
  console.log('  输出.json    合并后的判读终值（格式同 read_spectrum.js 产物）');
  console.log('  --manual=    两遍都缺的 marker 的人工补丁（须注明 note 出处）');
  console.log('');
  console.log('合并后务必跑 crosscheck.js 闭环；对「原始表」与「归档版」各跑一次，');
  console.log('两者的「问题数之差」应恰好等于本批次改动格数。');
  process.exit(args.length ? 0 : 1);
}

const pos = args.filter((a) => !a.startsWith('--'));
const opt = {};
for (const a of args) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) opt[m[1]] = m[2]; }

const [BASE, SUPP, OUT] = pos;
if (!BASE || !SUPP || !OUT) {
  console.error('✗ 缺少位置参数。用法: node merge_judge.js <底稿.json> <补充遍.json> <输出.json> [--manual=补丁.json]');
  process.exit(1);
}
for (const p of [BASE, SUPP]) {
  if (!fs.existsSync(p)) { console.error('✗ 找不到文件：' + p); process.exit(1); }
}

const load = (p) => {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.results || j.items || []);
};

const base = load(BASE);
const supp = load(SUPP);
if (!base.length) { console.error('✗ 底稿判读结果为空：' + BASE); process.exit(1); }

/* 条目对齐键：文件名 + 行号（同一格的方位/俯仰两条不会撞） */
const keyOf = (r) => String(r.name || r.file || '') + '|' + r.row;
const suppMap = new Map(supp.map((r) => [keyOf(r), r]));

/* marker 自然序（M1 在前，其后按 D 编号） */
const markNo = (t) => (t === 'M1' ? 1 : Number(String(t).replace(/\D/g, '')) || 99);

let added = 0;
const addedFrom = [];
const out = base.map((rb) => {
  const rs = suppMap.get(keyOf(rb));
  const have = new Set((rb.mks || []).map((m) => m.type));
  const mks = (rb.mks || []).slice();
  if (rs) {
    for (const m of (rs.mks || [])) {
      if (have.has(m.type)) continue;
      mks.push(m);
      have.add(m.type);
      added++;
      addedFrom.push((rb.name || '') + ' ' + m.type);
    }
  }
  mks.sort((x, y) => markNo(x.type) - markNo(y.type));
  return Object.assign({}, rb, { mks });
});

let manN = 0;
const manList = [];
if (opt.manual) {
  if (!fs.existsSync(opt.manual)) { console.error('✗ 找不到补丁文件：' + opt.manual); process.exit(1); }
  const man = JSON.parse(fs.readFileSync(opt.manual, 'utf8')).overrides || [];
  for (const o of man) {
    const rec = out.find((r) => String(r.name) === String(o.name));
    if (!rec) { console.error('✗ 补丁指向的条目不存在：' + o.name); process.exit(1); }
    if (!o.note) console.error('⚠ ' + o.name + ' ' + o.type + ' 的补丁未写 note —— 人工定论必须留出处凭据');
    const have = new Set((rec.mks || []).map((m) => m.type));
    if (have.has(o.type)) {
      console.error('⚠ ' + o.name + ' 已有 ' + o.type + '，跳过（删除该 --manual 项或核对该格）');
      continue;
    }
    rec.mks.push({
      type: o.type, y: o.y === undefined ? null : o.y, x: o.x,
      xs: o.xs || [String(o.x)], xMs: !!o.xMs,
      yv: o.yv === undefined ? null : o.yv,
      kind: o.kind, side: o.side, delta: o.delta === undefined ? null : o.delta,
      manual: true, note: o.note || '',
    });
    rec.mks.sort((x, y) => markNo(x.type) - markNo(y.type));
    rec.overridden = true;
    manN++;
    manList.push(o.name + ' ' + o.type + '=' + o.x);
  }
}

fs.writeFileSync(OUT, JSON.stringify({ results: out, mergedFrom: [BASE, SUPP], manualOverrides: manN }, null, 1), 'utf8');
console.log('✓ ' + OUT);
console.log('  条目 ' + out.length + ' ｜ 从补充遍补入 marker ' + added + ' 个 ｜ 人工定论补入 ' + manN + ' 个');
if (addedFrom.length) console.log('  补入明细：' + addedFrom.join('、'));
if (manList.length) console.log('  人工定论：' + manList.join('、'));
console.log('  → 下一步：node crosscheck.js <表.xlsx> ' + OUT + ' --sheet=方向图');
