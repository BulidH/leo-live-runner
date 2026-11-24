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
 *   node scripts/console.js --stop         # 停止本脚本启动的实例
 *   node scripts/console.js --json
 *
 * 说明：这是按需启动，不注册任何开机自启 / 守护进程；进程随系统重启消失。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');

const DEFAULT_PORT = 6886;
const HOST = '127.0.0.1';
const STATE_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');
const LOG_FILE = path.join(STATE_DIR, 'console.log');
const PID_FILE = path.join(STATE_DIR, 'console.pid');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { port: DEFAULT_PORT, open: true, stop: false, json: false, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--port' || a === '-p') opts.port = Number(next()) || DEFAULT_PORT;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--open') opts.open = true;
    else if (a === '--stop') opts.stop = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout') opts.timeoutMs = Number(next()) || opts.timeoutMs;
  }
  return opts;
}

/** 端口上是不是已经在跑我们的控制台（校验返回的页面确实是本控制台） */
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
          let ok = false;
          try {
            const j = JSON.parse(body);
            ok = Boolean(j && typeof j === 'object');
          } catch { ok = false; }
          resolve({ listening: true, isConsole: ok, statusCode: res.statusCode });
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

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
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
    const pid = readPid();
    if (!pid || !pidAlive(pid)) {
      const p = await probeConsole(opts.port);
      const msg = p.isConsole
        ? `端口 ${opts.port} 上有控制台在运行，但不是本脚本启动的（没有记录 PID），未做处理。请手动停止该进程。`
        : '没有由本脚本启动的控制台实例。';
      if (opts.json) console.log(JSON.stringify({ ok: !p.isConsole, action: 'stop', message: msg }, null, 2));
      else console.log(`\n${msg}\n`);
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      fs.rmSync(PID_FILE, { force: true });
      if (opts.json) console.log(JSON.stringify({ ok: true, action: 'stop', pid, message: '已停止' }, null, 2));
      else console.log(`\n✅ 已停止控制台（PID ${pid}）\n`);
    } catch (err) {
      if (opts.json) console.log(JSON.stringify({ ok: false, action: 'stop', pid, error: err.message }, null, 2));
      else console.error(`\n❌ 停止失败：${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // ---- 已在运行？----
  const existing = await probeConsole(opts.port);
  if (existing.isConsole) {
    if (opts.open) openBrowser(url);
    const out = {
      ok: true,
      action: 'reuse',
      url,
      port: opts.port,
      message: `控制台已在 ${opts.port} 端口运行，直接打开页面`,
      opened: opts.open
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`\n♻️  控制台已在运行：${url}`);
      if (opts.open) console.log('   已在浏览器中打开。');
      console.log('');
    }
    return;
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
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* 记录 PID 失败不影响启动 */ }

  const ready = await waitReady(opts.port, opts.timeoutMs);
  if (!ready.ready) {
    const msg = `服务在 ${opts.timeoutMs}ms 内未就绪，请查看日志：${LOG_FILE}`;
    if (opts.json) console.log(JSON.stringify({ ok: false, action: 'start', pid: child.pid, error: msg, log: LOG_FILE }, null, 2));
    else console.error(`\n❌ ${msg}\n   PID: ${child.pid}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.open) openBrowser(url);

  const out = {
    ok: true,
    action: 'start',
    url,
    port: opts.port,
    pid: child.pid,
    log: LOG_FILE,
    pidFile: PID_FILE,
    opened: opts.open,
    stop: `node scripts/console.js --stop --port ${opts.port}`,
    message: '控制台已启动（按需启动，不随开机自启）'
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n🌐 控制台已启动：${url}`);
    console.log(`   PID : ${child.pid}`);
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
