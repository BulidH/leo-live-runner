#!/usr/bin/env node

/**
 * 🖥️ Leo Live Inspector - 本地控制台启动器（幂等）
 *
 * 解决的问题：「打开控制台 / 启动服务」这类口令，在端口已被占用时
 * deploy_web.js 会直接报 EADDRINUSE 退出，用户看到一次报错还得自己判断。
 *
 * 本脚本的行为：
 *   1. 探测目标端口是否已有控制台在跑
 *      - 是 → 不再启动第二个，直接把页面打开（或只打印地址）
 *      - 否 → 后台拉起 deploy_web.js（脱离当前进程组），等它就绪后打开页面
 *   2. 输出可直接使用的信息：URL、PID、日志路径、停止方法
 *
 * 用法：
 *   node scripts/console.js                # 默认端口 6886
 *   node scripts/console.js --port 6901
 *   node scripts/console.js --no-open      # 只启动，不打开浏览器
 *   node scripts/console.js --restart      # 用磁盘上的最新代码重启（自动识别旧版本实例）
 *   node scripts/console.js --stop         # 停止本脚本启动的实例
 *   node scripts/console.js --json
 *
 * 版本自检：每次启动会比对「端口上正在跑的代码指纹」与「磁盘上的代码指纹」。
 * 不一致说明进程是改代码之前启动的，页面不会反映最新改动——此时会明确提示
 * 并拒绝静默复用，避免出现「打开控制台看不到新功能」。
 *
 * 说明：这是按需启动，不注册任何开机自启 / 守护进程；进程随系统重启消失。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeBuildId } from './common/build_id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');

const DEFAULT_PORT = 6886;
const HOST = '127.0.0.1';
const STATE_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');
const LOG_FILE = path.join(STATE_DIR, 'console.log');
// PID 按端口分开记：同时开 6886 和 6901 时，同一个 pid 文件会互相覆盖，
// --stop --port 6886 就可能去停 6901 的进程。
const pidFileFor = port =>
  port === DEFAULT_PORT
    ? path.join(STATE_DIR, 'console.pid')
    : path.join(STATE_DIR, `console-${port}.pid`);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { port: DEFAULT_PORT, open: true, stop: false, restart: false, json: false, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--port' || a === '-p') opts.port = Number(next()) || DEFAULT_PORT;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--open') opts.open = true;
    else if (a === '--stop') opts.stop = true;
    else if (a === '--restart') opts.restart = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout') opts.timeoutMs = Number(next()) || opts.timeoutMs;
  }
  return opts;
}

/** 端口上是不是已经在跑我们的控制台，以及它跑的是哪一版代码 */
function probeConsole(port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const req = http.request(
      { host: HOST, port, path: '/api/initial', method: 'GET', timeout: timeoutMs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          // /api/initial 是这个控制台独有的接口，能返回 JSON 说明就是它
          let j = null;
          try { j = JSON.parse(body); } catch { j = null; }
          resolve({
            listening: true,
            isConsole: Boolean(j && typeof j === 'object'),
            buildId: j?.buildId || null,
            pid: j?.pid || null,
            statusCode: res.statusCode
          });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ listening: true, isConsole: false, timeout: true }); });
    req.on('error', () => resolve({ listening: false, isConsole: false }));
    req.end();
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function readPid(port) {
  try {
    const pid = Number(fs.readFileSync(pidFileFor(port), 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确认这个 PID 确实是本控制台（deploy_web.js），再动手。
 *
 * 只凭端口探测拿到的 PID 就 kill 是不安全的：探测结果来自 HTTP 响应，
 * 虽然 /api/initial 是我们独有的，但多一层进程级校验能避免 PID 复用
 * （旧进程退出、系统把同一 PID 分给了别的程序）导致的误杀。
 */
function isOurConsoleProcess(pid) {
  const cmd = readProcessCommand(pid);
  return Boolean(cmd && /deploy_web\.js/.test(cmd) && /node/.test(cmd));
}

function readProcessCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * 反查监听该端口的进程 PID。
 *
 * 用途：早期版本的 deploy_web.js 不会在 /api/initial 里报 pid，探测拿不到，
 * 只能从系统层面反查。拿到 PID 后仍要过 isOurConsoleProcess 校验。
 */
function findPidOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pids = out.split('\n').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    return pids[0] || null;
  } catch {
    return null;
  }
}

async function stopPid(pid, timeoutMs = 5000) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise(r => setTimeout(r, 150));
  }
  // 优雅退出没成功才强杀，且仍是我们自己的控制台进程
  if (pidAlive(pid) && isOurConsoleProcess(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    await new Promise(r => setTimeout(r, 300));
  }
}

function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tick = async () => {
      const p = await probeConsole(port);
      if (p.isConsole) return resolve({ ready: true });
      if (Date.now() > deadline) return resolve({ ready: false });
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function main() {
  const opts = parseArgs();
  const url = `http://${HOST}:${opts.port}`;

  // ---- stop ----
  if (opts.stop) {
    let pid = readPid(opts.port);
    // 记录丢失（旧版本启动 / 手工启动 / 文件被删）时，退化为反查端口，
    // 但同样要求进程确实是 deploy_web.js，绝不按端口盲杀
    if (!pid || !pidAlive(pid)) {
      const found = findPidOnPort(opts.port);
      pid = found && isOurConsoleProcess(found) ? found : null;
    }
    if (!pid) {
      const p = await probeConsole(opts.port);
      const msg = p.isConsole
        ? `端口 ${opts.port} 上有控制台在运行，但无法确认其进程是本控制台，未做处理。\n  请手动确认：lsof -nP -iTCP:${opts.port} -sTCP:LISTEN`
        : '没有由本脚本启动的控制台实例。';
      if (opts.json) console.log(JSON.stringify({ ok: !p.isConsole, action: 'stop', message: msg }, null, 2));
      else console.log(`\n${msg}\n`);
      return;
    }
    try {
      await stopPid(pid);
      fs.rmSync(pidFileFor(opts.port), { force: true });
      if (opts.json) console.log(JSON.stringify({ ok: true, action: 'stop', pid, message: '已停止' }, null, 2));
      else console.log(`\n✅ 已停止控制台（PID ${pid}）\n`);
    } catch (err) {
      if (opts.json) console.log(JSON.stringify({ ok: false, action: 'stop', pid, error: err.message }, null, 2));
      else console.error(`\n❌ 停止失败：${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // 先按记录判断是不是本脚本启动的实例（用来判断「能不能安全停掉」）
  const recordPID = readPid(opts.port);
  const recordValid = pidAlive(recordPID) ? recordPID : null;

  // ---- 已在运行？----
  const existing = await probeConsole(opts.port);
  if (existing.isConsole) {
    const diskId = computeBuildId(__dirname);
    const runningId = existing.buildId;
    // 老版本进程没有 buildId 字段 → 一定不是当前代码
    const stale = !runningId || runningId !== diskId;

    if (stale && !opts.restart) {
      const msg =
        `端口 ${opts.port} 上有一个控制台在跑，但它是旧代码（运行中 ${runningId || '无版本信息'} / 磁盘 ${diskId}）。\n` +
        `  重启即可加载新版本：node scripts/console.js --restart\n` +
        `  或者换个端口：node scripts/console.js --port 6901`;
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, action: 'stale', url, port: opts.port, runningBuildId: runningId, diskBuildId: diskId, pid: existing.pid, error: msg }, null, 2));
      } else {
        console.error(`\n⚠️  ${msg}\n`);
      }
      process.exitCode = 2;
      return;
    }

    if (opts.restart) {
      // 依次尝试：探测返回的 pid → 记录的 pid → 反查端口。任一路径都要过进程校验
      const candidates = [existing.pid, recordValid, findPidOnPort(opts.port)].filter(Boolean);
      const targetPid = candidates.find(p => isOurConsoleProcess(p));
      if (!targetPid) {
        const msg =
          `检测到旧版本实例，但无法确认哪个进程是本控制台（端口上的进程不是 deploy_web.js）。未做处理。\n` +
          `  请手动确认后停止：lsof -nP -iTCP:${opts.port} -sTCP:LISTEN`;
        if (opts.json) console.log(JSON.stringify({ ok: false, action: 'restart', error: msg }, null, 2));
        else console.error(`\n❌ ${msg}\n`);
        process.exitCode = 1;
        return;
      }
      await stopPid(targetPid);
      fs.rmSync(pidFileFor(opts.port), { force: true });
    } else {
      // 版本一致 → 直接复用
      if (opts.open) openBrowser(url);
      const out = {
        ok: true,
        action: 'reuse',
        url,
        port: opts.port,
        pid: existing.pid,
        buildId: runningId,
        message: `控制台已在 ${opts.port} 端口运行（${runningId}），直接打开页面`,
        opened: opts.open,
        stop: `node scripts/console.js --stop --port ${opts.port}`
      };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`\n♻️  控制台已在运行：${url}`);
        console.log(`   版本: ${runningId}`);
        if (opts.open) console.log('   已在浏览器中打开。');
        console.log('');
      }
      return;
    }
  }

  if (existing.listening && !existing.isConsole) {
    const msg = `端口 ${opts.port} 被其它程序占用（不是本控制台的接口）。请换端口：node scripts/console.js --port 6901`;
    if (opts.json) console.log(JSON.stringify({ ok: false, action: 'start', error: msg }, null, 2));
    else console.error(`\n❌ ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // ---- 启动 ----
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const buildId = computeBuildId(__dirname);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'deploy_web.js'), '--port', String(opts.port)],
    {
      cwd: SKILL_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    }
  );
  child.unref();

  const ready = await waitReady(opts.port, opts.timeoutMs);
  if (!ready.ready) {
    const msg = `服务在 ${opts.timeoutMs}ms 内未就绪，请查看日志：${LOG_FILE}`;
    if (opts.json) console.log(JSON.stringify({ ok: false, action: 'start', pid: child.pid, error: msg, log: LOG_FILE }, null, 2));
    else console.error(`\n❌ ${msg}\n   PID: ${child.pid}\n`);
    process.exitCode = 1;
    return;
  }
  try { fs.writeFileSync(pidFileFor(opts.port), String(child.pid)); } catch { /* 记录 PID 失败不影响启动 */ }
  fs.closeSync(logFd);

  if (opts.open) openBrowser(url);

  const out = {
    ok: true,
    action: 'start',
    url,
    port: opts.port,
    pid: child.pid,
    buildId,
    log: LOG_FILE,
    pidFile: pidFileFor(opts.port),
    opened: opts.open,
    stop: `node scripts/console.js --stop --port ${opts.port}`,
    message: '控制台已启动（按需启动，不随开机自启）'
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n🌐 控制台已启动：${url}`);
    console.log(`   PID : ${child.pid}`);
    console.log(`   版本: ${buildId}`);
    console.log(`   日志: ${LOG_FILE}`);
    console.log(`   停止: node scripts/console.js --stop --port ${opts.port}`);
    if (opts.open) console.log('   已在浏览器中打开。');
    console.log('');
  }
}

main().catch(err => {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  } else {
    console.error(`\n❌ ${err.message}\n`);
  }
  process.exit(1);
});
