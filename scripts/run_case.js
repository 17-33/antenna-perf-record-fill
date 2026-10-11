#!/usr/bin/env node
'use strict';
/**
 * run_case.js —— **一键流水线**：收件箱 → 归档 → 判读 → spec → 填表 → 七道校验
 *
 * 为什么需要它（把 §7 的 7 步 + §16.5 的七道校验压成一条命令）：
 *   上一轮交付了 new_case / ingest / judge_batch / make_spec 四个工具，
 *   但用户仍要手工敲 4~5 条命令、且**顺序不能错**（先归档才能判读、先判读才能生成 spec）。
 *   本脚本只做**编排**：每一步都 spawn 现有脚本，不重写任何判据（§17.2）。
 *
 * 用法:
 *   node run_case.js --case=<机器目录> --table=<待填空表.xlsx> --batch=批1
 *   node run_case.js --case=37号机 --table=37号机/一体化*.xlsx --batch=批1 --dry-run
 *   node run_case.js --case=37号机 --table=<xlsx> --batch=批1 --from-ingest      # 跳过归档
 *   node run_case.js --case=37号机 --table=<xlsx> --batch=批1 --to=spec           # 只跑到生成 spec
 *
 * 参数:
 *   --case=<dir>     机器目录（必填）
 *   --table=<xlsx>   待填/已填的记录表（必填）。默认取 <case>/<表格名>.xlsx
 *   --batch=<名>     批次名（默认 批<日期>）
 *   --from=<步骤>    起始步骤：ingest|judge|spec|fill|verify（默认 ingest）
 *   --to=<步骤>      结束步骤（同上，默认 verify）
 *   --only=方向图    只处理某张表的方向图部分（当前仅方向图走全链）
 *   --dry-run        全程不写盘（只打印将执行的命令）
 *   --keep-going     某步失败后继续（默认失败即停 —— 填表链路有依赖，停才是对的）
 *   --json           机器可读结果（stdout 只有 JSON，人读信息走 stderr）
 *
 * 步骤与产物:
 *   1) ingest     → 截图/ 按惯例落位 + 批次/日志/ingest_*.json
 *   2) judge      → 批次/判读/判读_<batch>_终值.json + _报告.md
 *   3) spec       → 批次/spec/spec_方向图.json
 *   4) fill       → 批次/_中间/批<batch>_输出.xlsx（**不覆盖输入表**）
 *   5) verify     → analyze / crosscheck / diff / audit / zipcheck 五道（§16.5 的 ②③④⑤ 加 zipcheck）
 *
 * ⚠️ 铁律:
 *   - **永不覆盖输入表**：fill 的输出永远是 `批次/_中间/批<batch>_输出.xlsx`
 *   - 归档默认先 `--dry-run` 给人看；加 --apply 才真落位（由 --apply-ingest 控制）
 *   - 任一步「有异常」→ 该步视为失败并停（不带着可疑数据往下填）
 *
 * 退出码: 0 = 全链通过；1 = 某步失败；2 = 用法错误；3 = 有待人工确认项
 */

const L = require('./_lib');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** 人读输出一律走 stderr：stdout 留给 --json（约定同 ingest/judge_batch/make_spec） */
const say = (...a) => console.error(...a);

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}
if (flags.help || flags.h || !flags.case) {
  // 取文件头注释：逐字符找 '*/'，不用正则（正则里含 \n 会被 split 误伤，实测踩过）
  const _src = fs.readFileSync(__filename, 'utf8');
  say(_src.slice(_src.indexOf('/**'), _src.indexOf('*/')).replace(/^\/\*\*\n/, '').replace(/\n \*\/$/, ''));
  process.exit(flags.help || flags.h ? 0 : 2);   // 显式 --help → 0；缺 --case → 2
}
const CASE = path.resolve(String(flags.case));
const SCRIPTS = path.join(__dirname);
const BATCH = String(flags.batch || '批' + new Date().toISOString().slice(5, 10).replace('-', ''));
const DRY = !!flags['dry-run'];
const JSON_OUT = !!flags.json;
const ONLY = flags.only ? String(flags.only) : null;

const STEPS = ['ingest', 'judge', 'spec', 'fill', 'verify'];
const FROM = STEPS.includes(flags.from) ? flags.from : 'ingest';
const TO = STEPS.includes(flags.to) ? flags.to : 'verify';
if (flags.from && !STEPS.includes(flags.from)) {
  console.error(L.C.red('✗ --from 只能是 ' + STEPS.join(' / ')));
  process.exit(2);
}
if (flags.to && !STEPS.includes(flags.to)) {
  console.error(L.C.red('✗ --to 只能是 ' + STEPS.join(' / ')));
  process.exit(2);
}
const RUN = STEPS.slice(STEPS.indexOf(FROM), STEPS.indexOf(TO) + 1);

// 表：显式 --table 优先，否则取 <case>/<表格名>.xlsx
function findTable() {
  if (flags.table) return path.resolve(String(flags.table));
  const cands = fs.existsSync(CASE)
    ? fs.readdirSync(CASE).filter(n => /\.xlsx$/i.test(n))
    : [];
  // 优先非「原件/留档/模板」类的正式表
  const real = cands.filter(n => !/原件|留档|待填|输出|中间|备份/.test(n));
  return real.length ? path.join(CASE, real[0]) : (cands[0] ? path.join(CASE, cands[0]) : null);
}
const TABLE = findTable();

say(L.C.bold('【一键流水线】'));
say('  机器  ' + CASE);
say('  批次  ' + BATCH);
say('  步骤  ' + RUN.join(' → ') + L.C.dim(DRY ? '（dry-run，不写盘）' : ''));
say('');

if (!fs.existsSync(CASE)) {
  console.error(L.C.red('✗ 机器目录不存在：' + CASE + '\n  先跑 new_case.js 开单。'));
  process.exit(2);
}
if (RUN.includes('fill') || RUN.includes('verify')) {
  if (!TABLE || !fs.existsSync(TABLE)) {
    console.error(L.C.red('✗ 找不到记录表：' + (TABLE || '(目录里没有 .xlsx)') +
      '\n  用 --table=<路径> 指定，或先跑 new_case.js --template=...'));
    process.exit(2);
  }
  say('  记录表 ' + TABLE);
  say('  ⚠ 输出写到 批次/_中间/批<batch>_输出.xlsx，**不覆盖输入表**');
  say('');
}

/* ---------------- 执行器 ---------------- */
const results = [];
let failed = null;

function step(name, script, args, opts = {}) {
  if (failed) return null;
  say(L.C.bold('▸ 步骤 ' + (STEPS.indexOf(name) + 1) + '/5 · ' + name));
  if (DRY) {
    say('  [dry-run] node ' + script + ' ' + args.map(a => (/[^\w./一-龥=-]/.test(a) ? JSON.stringify(a) : a)).join(' '));
    results.push({ step: name, ok: true, dry: true });
    say('');
    return null;
  }
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)].concat(args),
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  // 子脚本把人读输出写 stderr（约定），这里透传给用户看
  if (out.trim()) say(out.replace(/^/gm, '    ').trimEnd());
  const ok = r.status === 0;
  results.push({ step: name, ok, code: r.status, script, args });
  say('  → ' + (ok ? L.C.green('OK') : L.C.red('失败（退出码 ' + r.status + '）')));
  say('');
  if (!ok) {
    failed = name;
    if (!flags['keep-going']) {
      say(L.C.red(L.C.bold('⛔ 停在 ' + name + '。修好后用 --from=' + STEPS[STEPS.indexOf(name)] + ' 续跑。')));
    }
  }
  return out;
}

/* ---------------- 1) ingest ---------------- */
let ingestJson = null;
if (RUN.includes('ingest')) {
  const inbox = path.join(CASE, '截图', '_待归档');
  const has = fs.existsSync(inbox) && fs.readdirSync(inbox).some(n => /\.(jpe?g|png)$/i.test(n));
  if (!has) {
    say(L.C.dim('  （收件箱为空，跳过归档）'));
    say('');
  } else {
    // 先试运行给人看（除非已 --apply-ingest），这是不可逆动作
    if (!flags['apply-ingest']) {
      say(L.C.dim('  收件箱有图，先试运行（加 --apply-ingest 才真落位）：'));
      say('');
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'ingest.js'), '--case=' + CASE],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      say(((r.stdout || '') + (r.stderr || '')).replace(/^/gm, '    ').trimEnd());
      const code = r.status;
      if (code === 3) {
        say(L.C.yellow('⛔ 归档器报「待人工确认」或「冲突」—— 这些图缺证据，未落位。'));
        say(L.C.dim('   看上方清单里的理由；补齐证据后重跑，或先继续后面的步骤（--from=judge）。'));
        results.push({ step: 'ingest', ok: false, code, reason: 'pending-or-conflict' });
        if (!flags['keep-going']) {
          if (JSON_OUT) console.log(JSON.stringify({ case: CASE, batch: BATCH, steps: results }, null, 2));
          process.exit(3);
        }
      } else {
        step('ingest', 'ingest.js', ['--case=' + CASE, '--apply', '--json', '--clean-dup']);
        // 取 plans 供后续 spec 参照
        const logDir = path.join(CASE, '批次', '日志');
        if (fs.existsSync(logDir)) {
          const logs = fs.readdirSync(logDir).filter(n => /^ingest_.*\.json$/.test(n)).sort();
          if (logs.length) {
            try {
              const lg = L.readJson(path.join(logDir, logs[logs.length - 1]));
              ingestJson = { plans: (lg.items || []).map(i => ({
                src: i.src, status: i.status, row: i.row, plane: i.plane, kind: i.kind,
              })) };
            } catch (e) { /* 读不了不影响主流程 */ }
          }
        }
      }
    } else {
      step('ingest', 'ingest.js', ['--case=' + CASE, '--apply', '--json', '--clean-dup']);
    }
  }
}

/* ---------------- 2) judge ---------------- */
let judgeFile = null;
if (RUN.includes('judge') && !failed) {
  step('judge', 'judge_batch.js', ['--case=' + CASE, '--batch=' + BATCH]);
  const f = path.join(CASE, '批次', '判读', '判读_' + BATCH + '_终值.json');
  if (fs.existsSync(f)) judgeFile = f;
  else {
    const alt = path.join(CASE, '批次', '判读', '判读_' + BATCH + '_基准.json');
    if (fs.existsSync(alt)) judgeFile = alt;
  }
  if (!judgeFile && !failed) {
    say(L.C.yellow('  ⚠ 没找到判读产物（可能一张方向图都没有）'));
    say('');
  }
}

/* ---------------- 3) spec ---------------- */
let specFile = null;
if (RUN.includes('spec') && !failed && judgeFile) {
  const planFile = path.join(CASE, '批次', '日志', 'plan_' + BATCH + '.json');
  if (ingestJson) {
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, JSON.stringify(ingestJson, null, 1) + '\n', 'utf8');
  }
  const args = ['--judge=' + judgeFile, '--out-dir=' + path.join(CASE, '批次', 'spec'), '--batch=' + BATCH];
  if (ingestJson) args.splice(1, 0, '--plan=' + planFile);
  step('spec', 'make_spec.js', args);
  const cand = ONLY
    ? path.join(CASE, '批次', 'spec', 'spec_' + ONLY + '.json')
    : path.join(CASE, '批次', 'spec', 'spec_方向图.json');
  if (fs.existsSync(cand)) specFile = cand;
  else say(L.C.yellow('  ⚠ 没有生成 spec（可能判读全被跳过）'));
  say('');
}

/* ---------------- 4) fill ---------------- */
let outTable = null;
if (RUN.includes('fill') && !failed && specFile) {
  const mid = path.join(CASE, '批次', '_中间');
  fs.mkdirSync(mid, { recursive: true });
  outTable = path.join(mid, BATCH + '_输出.xlsx');
  step('fill', 'fill_mark.js', [TABLE, outTable, specFile]);
}

/* ---------------- 5) verify（七道校验的 ②③④⑤ + zipcheck） ---------------- */
if (RUN.includes('verify') && !failed && outTable) {
  const ex = path.join(CASE, '批次', '审计豁免.json');
  const V = [
    ['analyze.js', [outTable], '② 公式复算 + 合格判定（必须「未发现不合格项」）'],
    ['crosscheck.js', judgeFile ? [outTable, judgeFile, '--sheet=方向图'] : null, '① 逐表他证（截图判读 vs 表内数值）'],
    ['zipcheck.js', [outTable], '⑤ 文件完整性（结构 + CRC32 + XML 良构）'],
  ].filter(v => v[1]);
  say(L.C.bold('▸ 步骤 5/5 · verify（七道校验）'));
  for (const [script, args, desc] of V) {
    if (DRY) { say('  [dry-run] ' + script); continue; }
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)].concat(args),
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    say('  ' + (ok ? L.C.green('✓') : L.C.red('✗')) + ' ' + script + L.C.dim('  ' + desc));
    const last = out.trim().split('\n').filter(Boolean).slice(-2);
    for (const ln of last) say('      ' + L.C.dim(ln.trim()));
    results.push({ step: 'verify:' + script, ok, code: r.status });
    if (!ok) failed = failed || 'verify';
  }
  // audit 需要「原始记录」——用本单留档的原件；没有就跳过并说明
  const arch = path.join(CASE, '批次', '原件字节留档', '公司下发原件_未改动.xlsx');
  if (fs.existsSync(arch) && fs.existsSync(ex)) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'audit.js'), outTable, arch, '--exempt-file=' + ex],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    say('  ' + (r.status === 0 ? L.C.green('✓') : L.C.red('✗')) + ' audit.js' + L.C.dim('  ④ 全表复检（漏标/错标/值不一致）'));
    say('      ' + L.C.dim(last.trim()));
    results.push({ step: 'verify:audit', ok: r.status === 0, code: r.status });
    if (r.status !== 0) failed = failed || 'verify';
  } else {
    say('  ' + L.C.yellow('○') + ' audit.js ' + L.C.dim('  跳过：本单没有「批次/原件字节留档/公司下发原件_未改动.xlsx」作比对基准'));
  }
  say('');
}

/* ---------------- 收尾 ---------------- */
const allOk = !failed && results.every(r => r.ok !== false);
if (JSON_OUT) {
  console.log(JSON.stringify({
    case: CASE, batch: BATCH, table: TABLE, output: outTable,
    judge: judgeFile, spec: specFile, steps: results, ok: allOk,
  }, null, 2));
} else {
  say(L.C.bold('结果：') + (allOk ? L.C.green('全链通过 ✅') : L.C.red('停在 ' + failed)));
  if (outTable) {
    say('');
    say('  产物    ' + L.C.cyan(outTable));
    say('  下一步  ' + L.C.dim('人工核对后，若认可就把它作为归档版（覆盖前先查写句柄，§18.10）'));
    say('          ' + L.C.dim('lsof "' + outTable + '" | awk \'NR>1 && $4 ~ /w/\'   # 有写句柄=被占用'));
  }
  say('');
  say('  续跑    ' + L.C.cyan('node run_case.js --case="' + CASE + '" --batch=' + BATCH +
    (failed ? ' --from=' + STEPS[Math.min(STEPS.indexOf(failed), STEPS.length - 1)] : '')));
}
process.exit(allOk ? 0 : (failed ? 1 : 0));
