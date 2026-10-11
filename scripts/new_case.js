#!/usr/bin/env node
'use strict';
/**
 * new_case.js —— **一键开单**：把「建目录 + 写协议 + 建空表 + 备豁免」压成一条命令
 *
 * 为什么需要它（SKILL.md §18.2 / §18.8 / §18.11 的散装步骤收敛）：
 *   每开一台新机要手工做 6 件事 ——
 *     ① mkdir -p 十几个目录（少一个就得到处 `mkdir: no such file`）
 *     ② 写《填写协议.md》（频点顺序 / 图序 / 32 槽位表 / CF 期望值）
 *     ③ 写《截图清单.md》表头
 *     ④ 备份原件到 `批次/原件字节留档/` + 打 SHA256
 *     ⑤ clear_data + blank_formula_cache 造待填空表
 *     ⑥ 手写 keep_<N>_blank.json 与 审计豁免.json
 *   其中 ④⑤⑥ 三件最容易漏、也最伤（漏 ⑤ → 空表残留别人家的增益；
 *   漏 ⑥ 且写成有上限的区间 → 每个新批次都要人肉改一次，§16.5.1 踩过）。
 *   本脚本把 6 件事一次做完，**且模板/协议/豁免全部按当前 skill 规范生成**。
 *
 * 用法:
 *   node new_case.js --machine=37 --root=<工作区> [选项]
 *   node new_case.js --machine=37 --root=<工作区> --template=<公司下发模板.xlsx>
 *   node new_case.js --machine=37 --root=<工作区> --template=... --name=一体化信关站中星光电性能检测记录表
 *
 * 参数:
 *   --machine=<N>        机号（必填）。目录名 = "<N>号机"
 *   --root=<dir>         工作区根目录（必填）。实际建在 <root>/<N>号机/
 *   --template=<xlsx>    公司下发的记录表原件。给了就自动做 备份+清空+抹缓存
 *   --name=<表格名>      表格文件名主干（默认「一体化信关站中星光电性能检测记录表」）
 *   --date=<YYYY-MM-DD>  打单日期（默认今天）
 *   --set=<目录名>       追加一个自定义子目录（可重复，用逗号分隔）
 *   --force              目标已存在时先备份到 <root>/<N>号机_已存在_<ts>/，再重建（默认直接拒绝）
 *   --dry-run            只打印将要做什么，不落盘
 *
 * 产出（<root>/<N>号机/ 下）:
 *   截图/架标测试/{接收,发射}          截图/跟踪精度/
 *   截图/接收链路标定/{LNB到频谱仪,LNB到测控基带XS05,LNB到地基基站IN1,LNB到地基基站IN2}/
 *   截图/EIRP/                          截图/_待归档/     ← 收件箱（ingest.js 的入口）
 *   报告/{ocr,ocr2}/
 *   批次/{原件字节留档,判读,spec,日志,_中间}/
 *   填写协议.md   截图清单.md   说明.md
 *   <表格名>.xlsx                        （给了 --template 才有：待填空表）
 *   批次/keep_<N>_blank.json            批次/审计豁免.json
 *
 * 铁律:
 *   - **永不改原始文件**：--template 只被 `cp` 成留档副本，清空作用在副本上
 *   - **不假设模板是空表**（§18.1）：公司下发件常带上一台机的残留数据，
 *     所以一律走 clear_data + blank_formula_cache，且把"清空结果 SHA256"写进说明.md
 *
 * 退出码: 0 = 成功；1 = 失败；2 = 用法错误；3 = 目标已存在且未 --force
 */

const L = require('./_lib');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
if (flags.help || flags.h || (!flags.machine && !positional.length)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(flags.help || flags.h ? 0 : 2);
}

/* ---------------- 参数 ---------------- */
const machine = String(flags.machine || (positional[0] || '')).replace(/[^\d]/g, '');
if (!machine) {
  console.error(L.C.red('✗ 缺 --machine=<机号>（纯数字，如 37）'));
  process.exit(2);
}
if (!flags.root) {
  console.error(L.C.red('✗ 缺 --root=<工作区根目录>'));
  process.exit(2);
}

const ROOT = path.resolve(String(flags.root));
const CASE = path.join(ROOT, machine + '号机');
const TABLE_BASE = String(flags['name'] || '一体化信关站中星光电性能检测记录表');
const DATE = String(flags.date || new Date().toISOString().slice(0, 10));
const DRY = !!flags['dry-run'];
const TEMPLATE = flags.template ? path.resolve(String(flags.template)) : null;

const RX = L.RX_FREQS;   // 37.5 … 40.05
const TX = L.TX_FREQS;   // 47.2 … 49.8
const LO = L.LO_RX;      // 34.5

/* ---------------- 目录骨架（照抄公司/前机惯例，SKILL.md §18.8） ---------------- */
const DIRS = [
  '截图/架标测试/接收',
  '截图/架标测试/发射',
  '截图/跟踪精度',
  '截图/接收链路标定/LNB到频谱仪',
  '截图/接收链路标定/LNB到测控基带XS05',
  '截图/接收链路标定/LNB到地基基站IN1',
  '截图/接收链路标定/LNB到地基基站IN2',
  '截图/EIRP',
  '截图/_待归档',            // 收件箱：图先扔这儿，ingest.js 认领
  '报告/ocr',
  '报告/ocr2',
  '批次/原件字节留档',
  '批次/判读',
  '批次/spec',
  '批次/日志',
  '批次/_中间',
];
if (flags.set) String(flags.set).split(',').map(s => s.trim()).filter(Boolean)
  .forEach(s => DIRS.push('截图/' + s.replace(/^截图[\\/]?/, '')));

/* ---------------- keep_<N>_blank.json（§18.2.1 的标准写法） ----------------
 * ⚠️ defaults.keepCols 必须置空数组：默认是 ["A","B","C"]，
 *    直接用会把「跟踪精度 B4:C13」「前向链路 B2:E2」这类恰好落在前 3 列的
 *    输入格顺手保留住，表就清不干净（§18.2.1 踩过）。
 */
function keepJson() {
  return {
    '_说明': 'new_case.js 生成。用于 clear_data.js 造「待填空表」。',
    '_注意': 'defaults.keepCols 必须是空数组——默认 ["A","B","C"] 会把落在前 3 列的输入格保留住，表清不干净（SKILL.md §18.2.1）。',
    defaults: { keepRows: [], keepCols: [], keepTextInLabelCols: false },
    sheets: {
      '方向图': { _注: '行 4 是列名表头必须保留；数据行 5-12=RX、13-20=TX', keep: ['A1:C21', 'D1:Q4', 'D21', 'R1:T21'] },
      'EIRP-公式法': { _注: 'D 实测增益/E 天线罩/F 波导/G4 标准偏差/J P 为输入；H、I、K 属公式结果', keep: ['A1:K3', 'A4:D11', 'H4:I11', 'K4:K11'] },
      'GT-公式法': { _注: 'D 实测增益/E 馈线波导/F4 标准偏差/J LNB噪声系数 为输入', keep: ['A1:M3', 'A4:D11', 'G4:G11', 'I4:I11', 'K4:M11'] },
      '跟踪精度': { _注: 'B/C 为姿态角读数；A14 零值 / A15 单轴 / B16 合成 / C17 指标 全是公式', keep: ['A1:A18', 'B1:E3', 'B14:D18'] },
      '前向链路（接收）标定': { _注: 'B/C/D/E 四列是输入格且【没有底色】,用 keep 显式罩住才不会漏清', keep: ['A1:A10', 'B1:E2'] },
    },
  };
}

/* ---------------- 审计豁免（§16.5.1：来源列按【整列】豁免，不给上限） ----------------
 * 原因：来源列是**随批次增长**的，每回写一次就在下一行加一条注记。
 * 写成 U2:U20 这类有上限的区间 → 每个新批次都会撞天花板、冒「漏标」，
 * 逼人肉改一次豁免文件。37 号机批次 5 为此专门修过。
 */
function exemptJson() {
  const col = c => c + '1:' + c + '1048576';
  return {
    '_说明': 'new_case.js 生成（整列豁免，SKILL.md §16.5.1）。键必须是工作簿里的精确表名，否则豁免静默失效。',
    '_来源': 'U=方向图 / L=EIRP / D=跟踪精度 / F=前向链路；A 行为批次日志区',
    '方向图': [col('U'), 'A23:A200'],
    'EIRP-公式法': [col('L'), 'A13:A200'],
    'GT-公式法': [col('N'), 'A13:A200'],
    '跟踪精度': [col('D'), 'A20:A200'],
    '前向链路（接收）标定': [col('F'), 'A12:A200'],
  };
}

/* ---------------- 《填写协议.md》 ---------------- */
function protocolMd() {
  const L_ = [];
  L_.push('# ' + machine + ' 号机 · 填写协议');
  L_.push('');
  L_.push('生成：`new_case.js` ｜ 打单日期：' + DATE);
  L_.push('');
  L_.push('> 本文件由脚本生成，**改完请在「修订」表里记一行**，别直接覆盖生成逻辑。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 一、总则');
  L_.push('');
  L_.push('1. **先填发射（TX），再填接收（RX）**。');
  L_.push('2. 每个频点 2 张：**第 1 张 = 方位，第 2 张 = 俯仰**（TX/RX 同规矩）。');
  L_.push('3. **发几张填几张** —— 不必等齐 32 张；一张也照收。');
  L_.push('4. **图统一丢进 `截图/_待归档/`**，由 `ingest.js` 认领落位（不要手工改名，见 §五）。');
  L_.push('5. 切面（方位/俯仰）**不能靠猜**：由 `check_pairs.js` 读仪器时间戳定时序判定。');
  L_.push('   判不出来 → `ingest.js` 停在「待人工确认」，**不写任何数据格**（§0.6 弃权规则）。');
  L_.push('6. 接收图的台面 **CF = 射频 − ' + LO + '**（本振），填表必须用**射频**频点找行。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 二、发射（TX）—— 8 频点 × 2 张 = 16 张');
  L_.push('');
  L_.push('频点顺序：`' + TX.join(' → ') + '`');
  L_.push('落行：' + TX.map((_, i) => 13 + i).join(' / ') + '（方向图行 13-20）');
  L_.push('');
  L_.push('## 三、接收（RX）—— 8 频点 × 2 张 = 16 张');
  L_.push('');
  L_.push('频点顺序：`' + RX.join(' → ') + '`');
  L_.push('落行：' + RX.map((_, i) => 5 + i).join(' / ') + '（方向图行 5-12）');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 四、核收清单（32 槽位，带 CF 自校验）');
  L_.push('');
  L_.push('| # | 段 | 频点(GHz) | 图 | 台面 CF 期望 | 落行 | 落格 | 状态 |');
  L_.push('|---|---|---|---|---|---|---|---|');
  let n = 0;
  for (const [seg, freqs, lo, baseRow, azCols, elCols] of [
    ['TX', TX, 0, 13, 'D E F J K L M', 'G H I N O P Q'],
    ['RX', RX, LO, 5, 'D E F J K L M', 'G H I N O P Q'],
  ]) {
    freqs.forEach((f, i) => {
      const row = baseRow + i;
      const cfExp = (f - lo).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      L_.push('| ' + (++n) + ' | ' + seg + ' | ' + f + ' | 方位 | ' + cfExp + ' | ' + row + ' | ' + azCols + row + ' | ☐ |');
      L_.push('| ' + (++n) + ' | ' + seg + ' | ' + f + ' | 俯仰 | ' + cfExp + ' | ' + row + ' | ' + elCols + row + ' | ☐ |');
    });
  }
  L_.push('');
  L_.push('> **CF 自校验**：台面 CF 与本表「期望」不一致 → **立即停下报警**，别硬填。');
  L_.push('> 仪表 CF 末位会取整（49.699997≈49.7、49.799981≈49.8），容差 0.005。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 五、传图怎么传（新版流程，替代手工整理）');
  L_.push('');
  L_.push('```bash');
  L_.push('# 1) 把图【原样】丢进收件箱，别改名、别分类、别管顺序');
  L_.push('cp <随手拿到的图> "' + machine + '号机/截图/_待归档/"');
  L_.push('');
  L_.push('# 2) 一条命令认领落位（读 CF 定频点、读时间戳定切面、SHA256 判重）');
  L_.push('node ingest.js --case="' + machine + '号机" --dry-run   # 先看它打算怎么放');
  L_.push('node ingest.js --case="' + machine + '号机" --apply     # 确认后落位');
  L_.push('');
  L_.push('# 3) 落位后跑校验（切面有据可依才继续）');
  L_.push('node check_pairs.js --dir="' + machine + '号机/截图"');
  L_.push('```');
  L_.push('');
  L_.push('`ingest.js` 的三条硬规矩：');
  L_.push('');
  L_.push('- **切面判不出来 → 停在「待人工确认」，不落位、不写表**（不是猜，是缺证据）；');
  L_.push('- 同名不同内容 → 报冲突并**保留两份**（不覆盖，§4.2 同名文件陷阱）；');
  L_.push('- 内容完全相同 → 判重跳过，在日志里注明「与第 N 张同一文件」。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 六、其余三类截图的落位约定');
  L_.push('');
  L_.push('| 类别 | 落位 | 命名 | 对应表 |');
  L_.push('|---|---|---|---|');
  L_.push('| 跟踪精度 | `截图/跟踪精度/` | `<n>.png`（n=1..10，截图编号 n → 表内行 n+3） | 跟踪精度 `B(n+3)` / `C(n+3)` |');
  L_.push('| 接收链路标定 | `截图/接收链路标定/<路径>/` | `<射频频点>.jpg` | 前向链路 `B/C/D/E` 列 |');
  L_.push('| BUC 功率页 | `截图/架标测试/发射/` | `<频点>功率.jpg` | EIRP `J` 行 = dBm−30 |');
  L_.push('| ACLR / 八通道 | `截图/EIRP/` | 原样 | **不入表**，仅旁证 |');
  L_.push('');
  L_.push('⚠️ 接收链路标定的**同名文件陷阱**：`39.95.jpg` 等在 `LNB到频谱仪` 与');
  L_.push('`LNB到测控基带XS05` 两个目录都有但内容不同。判据 = **电平**（−10~−12 → B 列；');
  L_.push('−20~−22 → C 列；−14~−16 → D 列）+ 仪表时间戳连续性。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 七、口径待确认清单（填表前必须逐条销账）');
  L_.push('');
  L_.push('| # | 事项 | 默认取法 | 是否已确认 |');
  L_.push('|---|---|---|---|');
  L_.push('| 1 | 跟踪精度取**姿态角**还是传感器/编码器角 | 姿态角（BAT Pro「ANT 状态」） | ☐ |');
  L_.push('| 2 | 天线罩/波导损耗是否在方向图实测时已扣 | 报告里显式注明，不重复扣 | ☐ |');
  L_.push('| 3 | 数值换算（射频=CF+' + LO + '、÷10、dBm−30） | 按 §1 定式，无需确认 | ✅ |');
  L_.push('| 4 | 切面偏移方向（L/R/U/D） | Δ时间负=左/下，正=右/上 | ✅ |');
  L_.push('');
  L_.push('> 第 1 项**换口径会翻转合格判定**（§0.5「必须问」那一档），必须书面确认。');
  L_.push('');
  L_.push('---');
  L_.push('');
  L_.push('## 修订');
  L_.push('');
  L_.push('| 日期 | 版本 | 改了什么 |');
  L_.push('|---|---|---|');
  L_.push('| ' + DATE + ' | v1 | new_case.js 生成 |');
  L_.push('');
  return L_.join('\n');
}

/* ---------------- 《截图清单.md》 ---------------- */
function shotsMd() {
  return [
    '# ' + machine + ' 号机 · 截图归档清单',
    '',
    '位置：`' + machine + '号机/截图/`（下称根）',
    '打单日期：' + DATE,
    '',
    '> 本表由 `ingest.js` 自动追加；手工补录请写清「源文件路径」与 SHA256。',
    '> 归档件与源文件的 SHA256 必须逐一对上（ingest 用 `cp` 不用 `mv`，源文件留着可回溯）。',
    '',
    '## 一、进度',
    '',
    '| 工作表 | 已填 / 应填 |',
    '|---|---|',
    '| 方向图 | 0 / 224 |',
    '| EIRP-公式法 | 0 / 25 |',
    '| GT-公式法 | 0 / 25 |',
    '| 跟踪精度 | 0 / 20 |',
    '| 前向链路（接收）标定 | 0 / 32 |',
    '',
    '## 二、已归档截图',
    '',
    '| 归档路径（相对根） | 类别 | 内容判读 | 落格 | 源文件路径 | SHA256（前16） |',
    '|---|---|---|---|---|---|',
    '',
    '## 三、待人工确认（切面判不出来 —— 不许硬填）',
    '',
    '| 文件 | 缺什么证据 |',
    '|---|---|',
    '',
    '## 四、留档',
    '',
    '每批交付后把整个 `' + machine + '号机/` 压成 `' + machine + '号机.zip` 放在**同级目录**。',
    '成本几秒，但它能在目录被误删/误移时救回全部原始证据（§18.9）。',
    '',
  ].join('\n');
}

/* ---------------- 《说明.md》 ---------------- */
function readmeMd(blankSha) {
  return [
    '# ' + machine + ' 号机 · 作业说明',
    '',
    '打单日期：' + DATE + ' ｜ 由 `new_case.js` 生成',
    '',
    '## 目录一览',
    '',
    '```',
    machine + '号机/',
    '├── 填写协议.md              ← 频点顺序 / 32 槽位 / CF 期望值 / 口径待确认',
    '├── 截图清单.md              ← 归档台账（ingest.js 自动追加）',
    '├── 截图/',
    '│   ├── _待归档/            ← 【收件箱】图先扔这儿，别改名别分类',
    '│   ├── 架标测试/接收/      ← 8 频点 × 方位/俯仰（射频频点命名）',
    '│   ├── 架标测试/发射/      ← 同上 + <频点>功率.jpg',
    '│   ├── 跟踪精度/           ← 1.png … 10.png（n → 表内行 n+3）',
    '│   ├── 接收链路标定/       ← 4 条路径分子目录，靠电平区分',
    '│   └── EIRP/               ← ACLR/八通道，仅旁证不入表',
    '├── 报告/ocr, ocr2/         ← 两遍 OCR 原始 JSON（判读证据）',
    '└── 批次/',
    '    ├── 原件字节留档/        ← 公司下发原件副本 + .sha256（永不改原件）',
    '    ├── 判读/              ← read_spectrum.js 产物',
    '    ├── spec/              ← make_spec.js 产物（喂 fill_mark.js）',
    '    ├── 日志/              ← 批次日志 JSON',
    '    └── _中间/             ← 批N_输入快照/批N_输出.xlsx',
    '```',
    '',
    '## 标准动作（照做，别跳步）',
    '',
    '1. **传图**：图原样丢进 `截图/_待归档/`，不手工改名。',
    '2. **落位**：`node ingest.js --case="' + machine + '号机" --dry-run` → 确认后 `--apply`。',
    '   - 切面判不出来会停在「待人工确认」，**这是设计如此**，补齐证据或书面指定即可。',
    '3. **判读**：OCR 两遍（`报告/ocr`、`报告/ocr2`）→ `read_spectrum.js` → `merge_judge.js` 合成终值。',
    '4. **填表**：`make_spec.js` 生成 spec → `fill_mark.js` 写副本（红字+来源列+批次日志）。',
    '5. **校验**：七道校验（SKILL.md §16.5），`audit.js` 必须「问题 0 项 ✅」。',
    '6. **交付**：`zipcheck` → 同步素材库（先 `lsof` 查写句柄，§18.10）→ 打 zip 留档。',
    '',
    '## 待填空表',
    '',
    TEMPLATE
      ? ('已生成：**' + TABLE_BASE + '.xlsx**' +
        (blankSha ? '\n清空结果 SHA256：`' + blankSha + '`\n\n> 同一模板 + 同一 keep.json 的清空结果是**确定性**的，' +
          '这个哈希可以直接与别处空表比对，不必逐格 diff（§18.2）。' : ''))
      : '未提供 `--template`，本单**没有待填空表**。\n\n' +
      '拿到公司下发件后补跑：\n\n```bash\n' +
      'cp "<下发件>.xlsx" "' + machine + '号机/批次/原件字节留档/公司下发原件_未改动.xlsx"\n' +
      'shasum -a 256 "' + machine + '号机/批次/原件字节留档/公司下发原件_未改动.xlsx"\n' +
      'node clear_data.js "' + machine + '号机/批次/原件字节留档/公司下发原件_未改动.xlsx" \\\n' +
      '     "' + machine + '号机/' + TABLE_BASE + '.xlsx" "' + machine + '号机/批次/keep_' + machine + '_blank.json"\n' +
      'node blank_formula_cache.js "' + machine + '号机/' + TABLE_BASE + '.xlsx" "' + machine + '号机/' + TABLE_BASE + '.xlsx"\n' +
      '```',
    '',
    '> ⚠️ **别假设模板是空的**（§18.1）：公司下发件里常装着上一台机的完整数据，',
    '> 文件名的 `XX号机` 只是占位。所以一定要走 `clear_data` + `blank_formula_cache`。',
    '',
  ].join('\n');
}

/* ---------------- 落盘 ---------------- */
function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function run(script, args) {
  return sh(process.execPath, [path.join(__dirname, script)].concat(args));
}
function write(rel, content) {
  const p = path.join(CASE, rel);
  if (DRY) { console.log(L.C.dim('  [dry-run] 将写入 ' + rel)); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

console.log(L.C.bold('【一键开单】'));
console.log('  机号    ' + machine + ' 号机');
console.log('  落点    ' + CASE);
console.log('  模板    ' + (TEMPLATE || L.C.dim('（未提供，本单不建空表）')));
console.log('');

if (fs.existsSync(CASE)) {
  if (!flags.force) {
    console.error(L.C.red('✗ 目标已存在：' + CASE));
    console.error(L.C.dim('  加 --force 可先把它备份到 _已存在_<时间戳>/ 再重建'));
    process.exit(3);
  }
  // ⚠️ 备份必须落在 **ROOT 下的同级**，不能放进 CASE 自己的子目录 ——
  //    那等于把目录移进它自己的子目录，fs.renameSync 直接 EINVAL（实测踩过）。
  const stash = path.join(ROOT, machine + '号机_已存在_' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15));
  if (!DRY) {
    fs.renameSync(CASE, stash);
    console.log(L.C.yellow('  原有目录已备份到 ' + path.relative(ROOT, stash)));
  } else {
    console.log(L.C.dim('  [dry-run] 将把原有目录备份到 ' + path.relative(ROOT, stash)));
  }
}

/* 1) 目录骨架 */
console.log(L.C.bold('① 建目录骨架（' + DIRS.length + ' 个）'));
for (const d of DIRS) {
  const p = path.join(CASE, d);
  const existed = fs.existsSync(p);
  if (!DRY && !existed) fs.mkdirSync(p, { recursive: true });
  console.log('   ' + (existed ? L.C.dim('· 已有 ') : L.C.green('+ 新建 ')) + L.C.dim(d));
}

/* 2) 文档 */
console.log('');
console.log(L.C.bold('② 生成文档'));
const doc = [['填写协议.md', protocolMd()], ['截图/截图清单.md', shotsMd()]];
for (const [rel, content] of doc) {
  write(rel, content);
  console.log('   ' + L.C.green('+ ') + rel + L.C.dim('（' + content.split('\n').length + ' 行）'));
}
write('批次/keep_' + machine + '_blank.json', JSON.stringify(keepJson(), null, 1) + '\n');
write('批次/审计豁免.json', JSON.stringify(exemptJson(), null, 1) + '\n');
console.log('   ' + L.C.green('+ ') + '批次/keep_' + machine + '_blank.json' + L.C.dim('（clear_data 用）'));
console.log('   ' + L.C.green('+ ') + '批次/审计豁免.json' + L.C.dim('（audit 用，整列豁免）'));

/* 3) 模板 → 留档 + 待填空表 */
let blankSha = null;
if (TEMPLATE) {
  console.log('');
  console.log(L.C.bold('③ 备份原件 + 造待填空表'));
  if (!fs.existsSync(TEMPLATE)) {
    console.error(L.C.red('   ✗ 模板不存在：' + TEMPLATE));
    process.exit(1);
  }
  const archName = '公司下发原件_未改动.xlsx';
  const arch = path.join(CASE, '批次/原件字节留档', archName);
  const work = path.join(CASE, TABLE_BASE + '.xlsx');
  if (DRY) {
    console.log('   ' + L.C.dim('[dry-run] 将 cp → 批次/原件字节留档/' + archName));
  } else {
    // ⚠️ 永不改原始文件：只 cp 一份留档，清空作用在副本上（铁律）
    fs.copyFileSync(TEMPLATE, arch);
    const sha = L.sha256File(arch);
    fs.writeFileSync(arch + '.sha256', sha + '  ' + archName + '\n', 'utf8');
    console.log('   ' + L.C.green('+ ') + '批次/原件字节留档/' + archName + L.C.dim('（未改动）'));
    console.log('     SHA256 ' + L.C.cyan(sha));
  }

  // 空表：clear_data → blank_formula_cache（§18.2 三步）
  try {
    if (DRY) {
      console.log('   ' + L.C.dim('[dry-run] 将跑 clear_data.js + blank_formula_cache.js → ' + work));
    } else {
      run('clear_data.js', [arch, work, path.join(CASE, '批次/keep_' + machine + '_blank.json')]);
      run('blank_formula_cache.js', [work, work]);
      blankSha = L.sha256File(work);
      console.log('   ' + L.C.green('+ ') + TABLE_BASE + '.xlsx' + L.C.dim('（待填空表）'));
      console.log('     清空结果 SHA256 ' + L.C.cyan(blankSha));
      const zc = run('zipcheck.js', [work]);
      const zok = /通过|✅|OK/.test(zc);
      console.log('     zipcheck ' + (zok ? L.C.green('通过 ✅') : L.C.yellow('见上方输出')));
    }
  } catch (e) {
    console.error(L.C.red('   ✗ 造空表失败：' + (e.stdout || '') + (e.stderr || e.message)));
    process.exit(1);
  }
}

write('说明.md', readmeMd(blankSha));
console.log('   ' + L.C.green('+ ') + '说明.md');

/* 4) 收尾 */
console.log('');
console.log(L.C.bold('完成。下一步：'));
if (!DRY) {
  console.log('  1) 图原样丢进  ' + L.C.cyan(path.join(CASE, '截图/_待归档')) + '  （别改名、别分类）');
  console.log('  2) 落位        ' + L.C.cyan('node ingest.js --case="' + CASE + '" --dry-run'));
  console.log('  3) 确认后落位  ' + L.C.cyan('node ingest.js --case="' + CASE + '" --apply'));
} else {
  console.log('  [dry-run] 去掉 --dry-run 即真正落盘');
}
process.exit(0);
