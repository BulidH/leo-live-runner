import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 计算「当前磁盘上的控制台代码」指纹。
 *
 * 为什么需要它：deploy_web.js 的页面 HTML 与路由处理函数都在模块加载时
 * 固化到内存里，改完文件后**必须重启进程**才会生效。而端口上可能还挂着
 * 一个更早启动的实例——只探测「端口通不通」无法发现这种「进程活着但跑的是旧代码」。
 *
 * 因此把 deploy_web.js 及 common/ 下所有 .js 的内容做一次摘要：
 * 服务端启动时算一份挂在 /api/initial 上，启动器探测时按磁盘再算一份，
 * 两者不一致就说明该重启了。
 *
 * 用文件内容而不是 mtime：同步/拷贝文件会刷新 mtime 但内容可能不变，
 * 用 mtime 会产生无意义的重启。
 */

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

export function buildIdFiles(scriptsDir) {
  return [path.join(scriptsDir, 'deploy_web.js'), ...walk(path.join(scriptsDir, 'common'))];
}

export function computeBuildId(scriptsDir) {
  const hash = crypto.createHash('sha1');
  for (const f of buildIdFiles(scriptsDir)) {
    hash.update(path.relative(scriptsDir, f));
    try {
      hash.update(fs.readFileSync(f));
    } catch {
      hash.update(':missing');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 10);
}
