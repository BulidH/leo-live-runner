#!/usr/bin/env node

/**
 * 🌐 Leo Live Inspector - 测试环境「合并 QA 分支 + 构建部署」本地可视化控制台
 *
 * 用法:
 *   node scripts/deploy_web.js [--port 6886] [--open]
 *
 * 打开 http://127.0.0.1:6886 后:
 *   1. 选择项目 (如 iot-platform)
 *   2. 选择开发分支 (自动记忆上次选择)
 *   3. 选择 QA 分支 (自动记忆上次选择)
 *   4. 点击「合并并部署」→ 把开发分支合并进 QA 分支并推送 → 触发 Shipwright 构建 → 下发测试环境部署
 *
 * 记忆与本地仓库映射持久化在 ~/.shrimp/skills/live-inspector/deploy_ui_state.json
 * 仅在测试环境 (test) 生效；生产环境不会提供自动化部署。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAppId, loadServiceCatalog } from './common/services.js';
import {
  saveApolloTestCookie,
  saveApolloProdCookie,
  saveLukeCookie,
  saveBaigeCookie,
  savePaodingCookie,
  saveCloudCookie,
  saveFeciCookie,
  saveShipwrightCookie,
  saveSearchCookie,
  saveFastCookie,
  saveUcCookie,
  saveArmsCookie,
  saveArmsApiKey,
  saveOnesCookie
} from './common/credentials.js';
import { saveDinsightCredentials } from './common/dinsight.js';
import { computeBuildId } from './common/build_id.js';
import { getBrowserCookies, cookiesToHeader } from './credential_relay.js';
import { ensureBridge, executeCommand } from './cli/lib/cli.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const CI_DEPLOY = path.join(__dirname, 'ci_deploy.js');
const SHRIMP_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');
// 本次进程加载的代码指纹：只在启动时算一次，改文件后不重启就不会变。
// 启动器拿它和磁盘上的指纹比对，用来识别「进程活着但跑的是旧代码」。
const BUILD_ID = computeBuildId(__dirname);
const STATE_FILE = path.join(SHRIMP_DIR, 'deploy_ui_state.json');
const JOB_DIR = path.join(SHRIMP_DIR, 'deploy_jobs');
const HOME = os.homedir();
// 临时工作区放在固定目录下，避免 macOS 清理 TMPDIR 导致中途失败
const WORKTREE_BASE = path.join(HOME, '.leo-live-inspector', 'worktrees');

const REPO_ROOTS = [
  path.join(HOME, 'IdeaProjects'),
  path.join(HOME, 'dev'),
  path.join(HOME, 'WebstormProjects'),
  path.join(HOME, 'Documents'),
  process.cwd()
];

// ---------------------------------------------------------------- state ----

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { branches: {}, repos: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(SHRIMP_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let state = loadState();
if (!state.branches) state.branches = {};
if (!state.repos) state.repos = {};

// ------------------------------------------------------------- projects ----

// 项目列表只来自「已登记 git 地址」的清单（skill 内置 + 用户自配）
function listProjects() {
  const catalog = loadServiceCatalog();
  const out = [];
  for (const [key, val] of projectRepos) {
    const serviceId = resolveAppId(key) || key;
    const meta = catalog[key] || catalog[serviceId] || {};
    const ci = Boolean(meta.ci && meta.ci.workflowId);
    const deploy = Boolean(meta.deploy && meta.deploy.test && meta.deploy.test.workloadId);
    out.push({
      id: serviceId,
      label: key,
      git: val.git,
      note: val.note || '',
      ci,
      deploy
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// --------------------------------------------------------------- repo -----

function git(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      ...opts
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function remoteBasename(project) {
  return (project || '').split('/').pop();
}

const PREFIXES = ['zulin-', 'beijia-', 'huiju-', 'utopia-scs-', 'utopia-', 'iot-'];

function stripPrefixes(name) {
  const out = new Set();
  const lower = (name || '').toLowerCase();
  if (!lower) return out;
  out.add(lower);
  for (const p of PREFIXES) {
    if (lower.startsWith(p)) out.add(lower.slice(p.length));
  }
  return out;
}

function projectAliases(project) {
  const serviceId = resolveAppId(project);
  const wanted = new Set();
  for (const n of [project, serviceId, remoteBasename(project)]) {
    for (const v of stripPrefixes(n)) wanted.add(v);
  }
  // 把注册表中指向同一服务的别名也纳入匹配 (如 iot-platform -> zulin-iot-platform)
  try {
    const catalog = loadServiceCatalog();
    for (const [key, val] of Object.entries(catalog)) {
      if (val && val.realAppId === serviceId) {
        for (const v of stripPrefixes(key)) wanted.add(v);
      }
    }
  } catch {}
  return wanted;
}

async function repoMatchesProject(repoPath, project) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return false;
  const wanted = projectAliases(project);
  const name = path.basename(repoPath).toLowerCase();
  if (wanted.has(name)) return true;
  const res = await git(repoPath, ['remote', 'get-url', 'origin']);
  if (res.code !== 0) return false;
  const base = path.basename(res.stdout.trim().replace(/\.git$/, ''));
  return wanted.has(base.toLowerCase());
}

// --------------------------------------------------------- 项目仓库登记 ----
// skill 内置 resources/project_repos.json + 用户可扩展 ~/.shrimp/skills/live-inspector/project_repos.json
// 登记了 git 地址的项目，无需本地检出：自动克隆到托管目录后再操作

const PROJECT_REPO_FILES = [
  path.join(SKILL_ROOT, 'resources', 'project_repos.json'),
  path.join(SHRIMP_DIR, 'project_repos.json')
];

function loadProjectRepos() {
  const map = new Map();
  for (const file of PROJECT_REPO_FILES) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, val] of Object.entries(data || {})) {
        const git = typeof val === 'string' ? val : val && val.git;
        if (!git) continue;
        map.set(String(key).toLowerCase(), { git: String(git).trim(), note: (val && val.note) || '' });
      }
    } catch {}
  }
  return map;
}

const projectRepos = loadProjectRepos();
let lastCloneError = null;

function registeredGitUrl(project) {
  const aliases = projectAliases(project || '');
  for (const [key, val] of projectRepos) {
    if (aliases.has(key) || key === String(project || '').toLowerCase()) return val.git;
  }
  // 兜底：仓库名精确匹配
  const base = remoteBasename(project || '').toLowerCase();
  for (const [key, val] of projectRepos) {
    if (key === base || key.endsWith(base)) return val.git;
  }
  return null;
}

// 托管克隆目录：只克隆对象库，不检出工作区（省空间，合并时再用 worktree 检出）
const CLONE_BASE = path.join(HOME, '.leo-live-inspector', 'clones');

function cloneDirFor(project) {
  const key = String(project || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(CLONE_BASE, key);
}

async function ensureClone(project, gitUrl) {
  const dir = cloneDirFor(project);
  const isRepo = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'HEAD'));
  if (!isRepo) {
    fs.mkdirSync(CLONE_BASE, { recursive: true });
    const res = await new Promise(resolve => {
      const child = spawn('git', ['clone', '--no-checkout', '--quiet', gitUrl, dir], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
      let err = '';
      child.stderr.on('data', d => err += d.toString());
      child.on('error', e => resolve({ code: -1, stderr: err + e.message }));
      child.on('close', code => resolve({ code: code ?? -1, stderr: err }));
    });
    if (res.code !== 0) throw new Error(`克隆仓库失败 [${gitUrl}]:\n${res.stderr.trim()}`);
    return dir;
  }
  // 已存在：确保 remote 指向登记的地址
  const remote = await git(dir, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0 || remote.stdout.trim() !== gitUrl) {
    await git(dir, ['remote', 'set-url', 'origin', gitUrl]);
  }
  return dir;
}

async function detectRepo(project) {
  if (!project) return null;
  const override = state.repos[project];
  if (override && fs.existsSync(path.join(override, '.git'))) return override;

  // 登记了 git 地址 → 直接用托管克隆，不依赖本地检出
  const gitUrl = registeredGitUrl(project);
  if (gitUrl) {
    try {
      return await ensureClone(project, gitUrl);
    } catch (err) {
      lastCloneError = err.message;
      return null;
    }
  }

  for (const root of REPO_ROOTS) {
    const direct = path.join(root, remoteBasename(project));
    if (await repoMatchesProject(direct, project)) return direct;
  }
  // 扫描一级子目录
  for (const root of REPO_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      if (await repoMatchesProject(full, project)) return full;
    }
  }
  return null;
}

// ------------------------------------------------------------ branches ----

const branchCache = new Map(); // repoPath -> { at, branches }

// 月度 QA 分支（qa-YYYY-MM）才是测试环境实际使用的分支，最新的排最前
function monthlyKey(b) {
  const m = /^qa[-_]?(\d{4})[-_](\d{1,2})(?:[-_](\d{1,2}))?$/i.exec(String(b || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y * 10000 + mo * 100 + d;
}

async function listBranches(repoPath, force = false) {
  const cached = branchCache.get(repoPath);
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.branches;

  let branches = [];
  const lsRemote = await git(repoPath, ['ls-remote', '--heads', 'origin']);
  if (lsRemote.code === 0) {
    branches = lsRemote.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);
  }
  if (branches.length === 0) {
    const local = await git(repoPath, ['branch', '-r', '--format=%(refname:short)']);
    if (local.code === 0) {
      branches = local.stdout.split('\n').map(s => s.replace(/^origin\//, '').trim()).filter(Boolean);
    }
  }
  branches = [...new Set(branches)];

  const rank = b => {
    if (monthlyKey(b)) return 0;          // qa-YYYY-MM
    if (/^qa$/i.test(b)) return 2;        // 旧的固定 qa
    if (/^qa[-_]/i.test(b)) return 1;     // 其它 qa-* 分支
    if (/^master$/i.test(b)) return 3;
    if (/^main$/i.test(b)) return 4;
    return 5;
  };
  branches.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {                       // 月度分支按时间倒序
      const ka = monthlyKey(a), kb = monthlyKey(b);
      if (ka !== kb) return kb - ka;
    }
    return a.localeCompare(b);
  });

  branchCache.set(repoPath, { at: Date.now(), branches });
  return branches;
}

// 最新的远端开发分支（按提交时间倒序，排除 qa-* / master / main）
async function latestRemoteBranch(repoPath) {
  const res = await git(repoPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']);
  if (res.code !== 0) return '';
  return res.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/^origin\//, ''))
    .filter(n => n !== 'HEAD' && !/^qa/i.test(n) && !/^master$/i.test(n) && !/^main$/i.test(n))[0] || '';
}

async function currentBranch(repoPath) {
  const res = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (res.code !== 0) return '';
  const name = res.stdout.trim();
  return name && name !== 'HEAD' ? name : '';
}

async function remoteBranchExists(repoPath, branch) {
  const res = await git(repoPath, ['ls-remote', '--heads', 'origin', branch]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

// ---------------------------------------------------------------- jobs -----

let activeJob = null;
const jobs = new Map();

// ------------------------------------------------------------ 任务持久化 ----
// 任务日志落盘，服务重启后仍可查看历史执行结果（排查失败原因必备）

function jobFile(id) {
  return path.join(JOB_DIR, `${id}.json`);
}

function persistJob(job, force = false) {
  const now = Date.now();
  if (!force && job._lastPersist && now - job._lastPersist < 1500) return;
  job._lastPersist = now;
  try {
    fs.mkdirSync(JOB_DIR, { recursive: true });
    const data = { ...job };
    delete data._lastPersist;
    const tmp = `${jobFile(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, jobFile(job.id));
  } catch {}
}

function loadPersistedJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
}

const MODE_LABEL = {
  merge_deploy: '合并并部署',
  merge_only: '仅合并',
  deploy_dev: '直接部署开发分支（不合并）',
  build_deploy: '仅构建部署',
  build_only: '仅构建',
  preview: '仅预演合并'
};

function listPersistedJobs(limit = 20) {
  let names = [];
  try { names = fs.readdirSync(JOB_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOB_DIR, name), 'utf8'));
      out.push({
        id: j.id,
        project: j.project,
        devBranch: j.devBranch,
        qaBranch: j.qaBranch,
        mode: j.mode,
        modeLabel: MODE_LABEL[j.mode] || j.mode,
        status: j.status,
        error: j.error,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt
      });
    } catch {}
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return out.slice(0, limit);
}

function newJob(payload) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    ...payload,
    status: 'running',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null
  };
  jobs.set(id, job);
  activeJob = job;
  persistJob(job, true);
  // 保留最近 20 个任务
  if (jobs.size > 20) {
    const oldest = [...jobs.keys()][0];
    if (jobs.get(oldest)?.status !== 'running') jobs.delete(oldest);
  }
  return job;
}

function log(job, text) {
  job.log += text.endsWith('\n') ? text : text + '\n';
  if (job.log.length > 300_000) job.log = job.log.slice(-300_000);
  persistJob(job);
}

function runStreaming(job, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    log(job, `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { const s = d.toString(); stdout += s; log(job, s.replace(/\n$/, '')); });
    child.stderr.on('data', d => { const s = d.toString(); stderr += s; log(job, s.replace(/\n$/, '')); });
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const CONFLICT_STRATEGY = 'strict';
const CONFLICT_STRATEGY_LABEL = { strict: '严格失败（冲突时中止并列出冲突文件）' };

// 创建隔离工作区：清理残留登记 → 校验远程引用 → 创建（失败重试一次）
async function createWorktree(job, repoPath, remoteRef) {
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });
  await git(repoPath, ['worktree', 'prune']);

  const refCheck = await git(repoPath, ['rev-parse', '--verify', `refs/remotes/${remoteRef}`]);
  if (refCheck.code !== 0) {
    throw new Error(`本地缺少远程分支引用 ${remoteRef}\n请先在仓库目录执行: git fetch origin`);
  }

  const worktree = path.join(WORKTREE_BASE, `merge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const args = ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--force', worktree, remoteRef];

  let res = await runStreaming(job, 'git', args, { cwd: repoPath });
  if (res.code !== 0) {
    log(job, '\n⚠️ 创建工作区失败，清理残留后重试一次…');
    await git(repoPath, ['worktree', 'prune']);
    res = await runStreaming(job, 'git', args, { cwd: repoPath });
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(
      `创建临时工作区失败:\n${detail || '(git 未输出错误信息)'}\n` +
      `(临时路径: ${worktree})\n` +
      '排查建议: git worktree prune 清理残留; 确认磁盘空间与仓库权限; 确认没有同名路径被占用。'
    );
  }
  return worktree;
}

async function mergeAndDeploy(job, project, devBranch, qaBranch, mode, conflictStrategy = 'strict') {
  const repoPath = await detectRepo(project);
  if (!repoPath) throw new Error(`未找到项目 [${project}] 的本地 Git 仓库，请先在页面上设置仓库路径`);

  log(job, `📁 本地仓库: ${repoPath}`);
  log(job, `🌿 开发分支: ${devBranch}`);
  log(job, `🎯 QA 分支: ${qaBranch}`);
  log(job, `🧭 执行模式: ${mode}`);
  log(job, `🧩 冲突策略: ${CONFLICT_STRATEGY_LABEL[conflictStrategy] || CONFLICT_STRATEGY_LABEL.strict}`);

  const serviceId = resolveAppId(project);

  const needMerge = mode === 'merge_deploy' || mode === 'merge_only' || mode === 'preview';
  if (needMerge) {
    if (devBranch === qaBranch) throw new Error('开发分支与 QA 分支不能相同');
    if (!(await remoteBranchExists(repoPath, devBranch))) throw new Error(`远程不存在开发分支: ${devBranch}`);
    if (!(await remoteBranchExists(repoPath, qaBranch))) throw new Error(`远程不存在 QA 分支: ${qaBranch}`);

    log(job, '\n========== 步骤 1: 拉取最新远程分支 ==========');
    const fetch = await runStreaming(job, 'git', [
      'fetch', '--prune', 'origin',
      `+refs/heads/${devBranch}:refs/remotes/origin/${devBranch}`,
      `+refs/heads/${qaBranch}:refs/remotes/origin/${qaBranch}`
    ], { cwd: repoPath });
    if (fetch.code !== 0) throw new Error('git fetch 失败:\n' + (fetch.stderr || '').trim());

    // 开发分支已经包含在 QA 分支里 → 无需重复合并
    const ancestor = await git(repoPath, ['merge-base', '--is-ancestor', `refs/remotes/origin/${devBranch}`, `refs/remotes/origin/${qaBranch}`]);
    const alreadyMerged = ancestor.code === 0;

    if (alreadyMerged) {
      log(job, '\n✅ 开发分支已包含在 QA 分支中，跳过合并步骤，直接进入构建部署。');
      if (mode === 'preview') {
        log(job, '\n🔍 预演模式：开发分支已合入 QA，未推送、未部署。');
        return { serviceId, repoPath, preview: true };
      }
    } else {
      const worktree = await createWorktree(job, repoPath, `origin/${qaBranch}`);
      try {
        log(job, '\n========== 步骤 2: 创建隔离工作区并检出 QA 分支 ==========');
        log(job, `工作区: ${worktree}`);

        log(job, '\n========== 步骤 3: 合并开发分支到 QA 分支 ==========');
        const mergeArgs = [
          '-c', 'core.hooksPath=/dev/null',
          'merge', '--no-ff', '--no-edit',
          '-m', `chore(deploy): merge ${devBranch} into ${qaBranch}`
        ];
        mergeArgs.push(`origin/${devBranch}`);

        const merge = await runStreaming(job, 'git', mergeArgs, { cwd: worktree });

        if (merge.code !== 0) {
          const conflictFiles = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
          if (!conflictFiles) {
            await runStreaming(job, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--abort'], { cwd: worktree });
            throw new Error('合并失败（非冲突问题），已回滚合并。\n' + (merge.stderr || '').trim());
          }
          log(job, '\n⚠️ 合并发生冲突，正在回滚合并...');
          await runStreaming(job, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--abort'], { cwd: worktree });
          throw new Error(
            `合并冲突（策略：严格失败），已回滚，未推送、未部署。冲突文件:\n${conflictFiles}\n` +
            '请先解决冲突后重试。'
          );
        }

        const head = await git(worktree, ['rev-parse', '--short', 'HEAD']);
        log(job, `\n✅ 合并完成，新提交: ${head.stdout.trim()}`);
        const stat = await git(worktree, ['diff', '--stat', `origin/${qaBranch}..HEAD`]);
        if (stat.stdout.trim()) log(job, '\n本次合并涉及的改动:\n' + stat.stdout.trim());

        if (mode === 'preview') {
          log(job, '\n🔍 预演模式：合并成功，未推送、未部署。');
          return { serviceId, repoPath, preview: true };
        }

        log(job, '\n========== 步骤 4: 推送 QA 分支到远程 ==========');
        const push = await runStreaming(job, 'git', ['push', 'origin', `HEAD:refs/heads/${qaBranch}`], { cwd: worktree });
        if (push.code !== 0) {
          const errText = `${push.stderr || ''}\n${push.stdout || ''}`;
          if (/protected branch/i.test(errText)) {
            // QA 等分支受保护 → 把合并结果落到临时分支，方便走 GitLab MR 合入
            const remoteUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
            const webBase = remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
            const tmpBranch = `auto/merge-${qaBranch}-${String(Date.now()).slice(-6)}`;
            log(job, `\n⚠️ ${qaBranch} 是受保护分支，不能直接推送（需要 MR 合入）`);
            const tmpPush = await runStreaming(job, 'git', ['push', 'origin', `HEAD:refs/heads/${tmpBranch}`], { cwd: worktree });
            if (tmpPush.code === 0) {
              log(job, `✅ 合并结果已推送到临时分支: ${tmpBranch}`);
              log(job, `   创建 MR: ${webBase}/-/compare/${qaBranch}...${tmpBranch}`);
              throw new Error(
                `${qaBranch} 是受保护分支，无法直接推送。\n` +
                `合并结果已推送到临时分支: ${tmpBranch}\n` +
                `请在 GitLab 发起 MR 合入 ${qaBranch}:\n${webBase}/-/compare/${qaBranch}...${tmpBranch}\n` +
                `（或改用「直接部署开发分支」模式跳过合并，先把代码发布到测试环境）`
              );
            }
            throw new Error(
              `${qaBranch} 是受保护分支，无法直接推送；临时分支 ${tmpBranch} 推送也失败。\n${errText.trim()}`
            );
          }
          throw new Error('推送 QA 分支失败（请检查 Git 凭据）:\n' + (push.stderr || '').trim());
        }
        log(job, `✅ 已推送 ${qaBranch} 分支`);
      } finally {
        await git(repoPath, ['worktree', 'remove', '--force', worktree]);
        await git(repoPath, ['worktree', 'prune']);
      }
    }
  }

  if (mode === 'merge_only') {
    log(job, '\n✅ 仅合并模式完成，未触发构建部署。');
    return { serviceId, repoPath, imageAddress: null, recordId: null };
  }

  log(job, '\n========== 步骤 5: 触发 CI 构建并部署测试环境 ==========');
  const buildBranch = mode === 'deploy_dev' ? devBranch : qaBranch;
  if (mode === 'deploy_dev') log(job, `ℹ️ 直接构建部署开发分支（不合并到 ${qaBranch}）: ${buildBranch}`);
  const args = [CI_DEPLOY, serviceId, '-b', buildBranch];
  if (mode === 'build_only') args.push('--build-only');
  const res = await runStreaming(job, process.execPath, args, { cwd: SKILL_ROOT });
  if (res.code !== 0) throw new Error('CI 构建或部署失败，请查看上方日志。\n若日志出现「无法获取构建器」，通常是 shipwright.ke.com 登录态过期，可点击页面「检查凭据」确认并刷新登录态。');

  const imageMatch = res.stdout.match(/产物镜像[:：]\s*(\S+)/) || res.stdout.match(/上线镜像[:：]\s*(\S+)/);
  return {
    serviceId,
    repoPath,
    imageAddress: imageMatch ? imageMatch[1] : null
  };
}

async function startJob({ project, devBranch, qaBranch, mode, conflict }) {
  if (!project || !qaBranch) throw new Error('缺少项目或 QA 分支参数');
  if (activeJob && activeJob.status === 'running') throw new Error('已有部署任务正在执行，请等待完成');

  const conflictStrategy = CONFLICT_STRATEGY;
  const job = newJob({ project, devBranch, qaBranch, mode, conflictStrategy });
  saveState(state);

  mergeAndDeploy(job, project, devBranch, qaBranch, mode, conflictStrategy)
    .then(result => {
      job.status = 'success';
      job.result = result;
      job.finishedAt = new Date().toISOString();
      log(job, '\n🎉 全部完成！');
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      log(job, `\n❌ 执行失败: ${err.message}`);
    })
    .finally(() => { activeJob = null; persistJob(job, true); });

  return job;
}

// ------------------------------------------------------------ credentials ----
// CI 构建与部署依赖内网站点的登录态，过期时给出明确提示而不是让用户猜

async function probeCredential(file, url, init = {}, cookieOverride = null) {
  let cred;
  let cookie = String(cookieOverride || '').trim();
  if (!cookie) {
    try {
      cred = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, message: '未保存凭据' };
    }
    cookie = cred.cookie || '';
  }
  const updatedAt = (cred && cred.updated_at) || null;
  if (!cookie) return { ok: false, message: '未保存凭据', updatedAt };
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `登录态已失效 (HTTP ${res.status})`, updatedAt };
    }
    // 302 到统一登录页时 fetch 会跟随到底，用最终 URL 判断比看页面内容可靠
    if (/\/login|passport|\/sso/i.test(res.url || '')) {
      return { ok: false, message: '登录态已失效（被重定向到登录页）', updatedAt };
    }
    if (/"code"\s*:\s*(401|403)\b/.test(text)) {
      return { ok: false, message: '登录态已失效（接口返回未登录）', updatedAt };
    }
    // 部分站点用 200 + JS 跳转登录页，既不换 URL 也不报错
    if (/location\.(replace|href)\s*[=(]\s*["'][^"']*(login|passport|sso)/i.test(text) || /not_authenticated/i.test(text)) {
      return { ok: false, message: '登录态已失效（页面跳转登录）', updatedAt };
    }
    if (/ke-passport/i.test(text) || /<title>[^<]*(登录|login)/i.test(text)) {
      return { ok: false, message: '登录态已失效（被重定向到登录页）', updatedAt };
    }
    if (!res.ok) return { ok: false, message: `请求异常 HTTP ${res.status}`, updatedAt };
    return { ok: true, message: '正常', updatedAt };
  } catch (err) {
    return { ok: false, message: '请求失败: ' + err.message, updatedAt };
  }
}

async function checkCredentials() {
  const [shipwright, cloud] = await Promise.all([
    probeCredential(
      path.join(SHRIMP_DIR, 'shipwright_cookie.json'),
      'https://shipwright.ke.com/workflow-context/v1/workflows/query?pageNumber=1&pageSize=1',
      { method: 'POST', body: JSON.stringify({ pageNumber: 1, pageSize: 1 }) }
    ),
    probeCredential(
      path.join(SHRIMP_DIR, 'cloud_token.json'),
      'https://cloud.intra.ke.com/apis/ci/v1/deployment/images/self-check?pageNumber=1&pageSize=1',
      { method: 'GET' }
    )
  ]);
  return { shipwright, cloud };
}

// ------------------------------------------------------- 凭据台账 (Tab) ----
// 页面只展示「有没有 / 什么时候更新的 / 有哪些 cookie 名」，绝不把 cookie 值渲染到页面上。
// 刷新时通过本地桥接让 Chrome 打开目标站点（没登录就是登录页），登录完成后自动回读落盘。

const CREDENTIALS = [
  {
    id: 'shipwright', label: 'Shipwright 构建平台', group: '构建部署',
    file: 'shipwright_cookie.json', env: 'SHIPWRIGHT_COOKIE', url: 'https://shipwright.ke.com/',
    save: header => saveShipwrightCookie(header),
    probe: { url: 'https://shipwright.ke.com/workflow-context/v1/workflows/query?pageNumber=1&pageSize=1', init: { method: 'POST', body: JSON.stringify({ pageNumber: 1, pageSize: 1 }) } },
    note: '失效表现：部署时报「无法获取构建器」'
  },
  {
    id: 'cloud', label: '服务云 / CI 平台', group: '构建部署',
    file: 'cloud_token.json', env: 'CLOUD_COOKIE', url: 'https://cloud.intra.ke.com/',
    save: header => saveCloudCookie(header),
    probe: { url: 'https://cloud.intra.ke.com/apis/ci/v1/deployment/images/self-check?pageNumber=1&pageSize=1', init: { method: 'GET' } },
    note: '失效表现：镜像自检查询、下发部署失败'
  },
  {
    id: 'feci', label: 'FeCI 前端流水线', group: '构建部署',
    file: 'feci_cookie.json', env: 'FECI_COOKIE', url: 'https://feci-next.ke.com/',
    save: header => saveFeciCookie(header),
    probe: { url: 'https://feci-next.ke.com/', init: { method: 'GET' } },
    note: '失效表现：feci_deploy.js 触发前端构建失败'
  },
  {
    id: 'apollo_test', label: 'Apollo Portal（测试）', group: '配置中心',
    file: 'test_apollo_cookie.json', env: 'APOLLO_TEST_COOKIE', url: 'http://test-apollo.portal.life.ke.com/',
    save: header => saveApolloTestCookie(header),
    probe: { url: 'http://test-apollo.portal.life.ke.com/', init: { method: 'GET' } },
    note: '失效表现：测试环境配置查询 / 改值发布报登录失败'
  },
  {
    id: 'apollo_prod', label: 'Apollo Portal（生产）', group: '配置中心',
    file: 'apollo_cookie.json', env: 'APOLLO_PROD_COOKIE', url: 'http://apollo.portal.life.ke.com/',
    save: header => saveApolloProdCookie(header),
    probe: { url: 'http://apollo.portal.life.ke.com/', init: { method: 'GET' } },
    note: '仅用于生产配置只读速查'
  },
  {
    id: 'luke_test', label: 'Luke 权限中心（测试）', group: '权限与网关',
    file: 'test_luke_cookie.json', env: 'LUKE_TEST_COOKIE', url: 'https://test-luke.ke.com',
    save: header => saveLukeCookie({ env: 'test', cookieStr: header }),
    probe: { url: 'https://test-luke.ke.com', init: { method: 'GET' } },
    note: '失效表现：luke_query.js / luke_modify.js 报无权限或登录失败'
  },
  {
    id: 'luke_prod', label: 'Luke 权限中心（生产）', group: '权限与网关',
    file: 'luke_cookie.json', env: 'LUKE_PROD_COOKIE', url: 'https://luke.ke.com',
    save: header => saveLukeCookie({ env: 'prod', cookieStr: header }),
    probe: { url: 'https://luke.ke.com', init: { method: 'GET' } },
    note: '仅用于生产权限只读排查'
  },
  {
    id: 'baige_test', label: '白鸽网关（测试）', group: '权限与网关',
    file: 'test_baige_cookie.json', env: 'BAIGE_TEST_COOKIE', url: 'http://life-fe-baige-node.offline-beta.ttb.test.ke.com',
    save: header => saveBaigeCookie({ env: 'test', cookieStr: header }),
    probe: { url: 'http://life-fe-baige-node.offline-beta.ttb.test.ke.com', init: { method: 'GET' } },
    note: '失效表现：网关服务 / 路由查询失败'
  },
  {
    id: 'baige_preview', label: '白鸽网关（预发）', group: '权限与网关',
    file: 'prev_baige_cookie.json', env: 'BAIGE_PREVIEW_COOKIE', url: 'http://preview.baige.ke.com',
    save: header => saveBaigeCookie({ env: 'preview', cookieStr: header }),
    probe: { url: 'http://preview.baige.ke.com', init: { method: 'GET' } },
    note: '三环境对照时的预发侧登录态'
  },
  {
    id: 'baige_prod', label: '白鸽网关（生产）', group: '权限与网关',
    file: 'baige_cookie.json', env: 'BAIGE_PROD_COOKIE', url: 'https://baige.ke.com',
    save: header => saveBaigeCookie({ env: 'prod', cookieStr: header }),
    probe: { url: 'https://baige.ke.com', init: { method: 'GET' } },
    note: '仅用于生产网关只读排查'
  },
  {
    id: 'uc_test', label: 'UC 组织管理中心（测试）', group: '权限与网关',
    file: 'test_uc_cookie.json', env: 'UC_TEST_COOKIE', url: 'http://test3-uc.admin.ke.com/',
    save: header => saveUcCookie({ env: 'test', cookieStr: header }),
    probe: {
      url: 'http://test3-uc.admin.ke.com/graphql',
      init: { method: 'POST', body: JSON.stringify({ query: '{__typename}' }) }
    },
    note: 'UC 线上暂未接入，只有测试环境'
  },
  {
    id: 'search', label: '搜索云 ES 平台', group: '数据查询',
    file: 'search_cookie.json', env: 'SEARCH_COOKIE', url: 'https://search.ke.com/',
    save: header => saveSearchCookie(header),
    probe: {
      url: 'https://search.ke.com/ajax/createApp/getAppList',
      init: { method: 'POST', body: JSON.stringify({ page: 1, size: 1, auth: true, serviceId: '' }) }
    },
    note: '失效表现：es_query.js 查索引/文档失败'
  },
  {
    id: 'fast', label: 'FAST 日志平台', group: '数据查询',
    file: 'fast_cookie.json', env: 'FAST_COOKIE', url: 'https://fast.ke.com/',
    save: header => saveFastCookie(header),
    probe: { url: 'https://fast.ke.com/', init: { method: 'GET' } },
    note: '失效表现：生产日志检索 / TraceId 回溯失败'
  },
  {
    id: 'paoding', label: 'Paoding Loki 日志', group: '数据查询',
    file: 'paoding_cookie.json', env: 'PAODING_COOKIE', url: 'https://paoding.ke.com/',
    save: header => savePaodingCookie(header),
    probe: {
      url: 'https://paoding.ke.com/api/ds/query?ds_type=loki',
      init: { method: 'POST', body: JSON.stringify({ queries: [], from: 'now-1m', to: 'now' }) }
    },
    note: '失效表现：测试环境容器日志查不到'
  },
  {
    id: 'arms', label: '灯塔 ARMS（Cookie）', group: '数据查询',
    file: 'arms_cookie.json', env: 'ARMS_COOKIE', url: 'http://arms.fee.lianjia.com/',
    save: header => saveArmsCookie(header),
    probe: { url: 'http://arms.fee.lianjia.com/', init: { method: 'GET' } },
    note: '前端监控异常榜 / ViewId 还原用'
  },
  {
    id: 'dinsight', label: 'Dinsight 查数', group: '数据查询',
    file: 'dinsight_cookie.json', env: 'DINSIGHT_COOKIE', url: 'https://api-dinsight.ke.com',
    // url 是 API 域，浏览器打开只会是空白页；登录入口在前端门户
    loginUrl: 'https://dinsight.ke.com/',
    names: ['prd-assistant-token-prod', 'csrf_token', 'access_token', 'login_ucid', 'security_ticket'],
    save: header => saveDinsightCredentials(header),
    probe: { url: 'https://api-dinsight.ke.com/api/v1/auth/me', init: { method: 'GET' } },
    note: '只保留 token / csrf 等关键字段'
  },
  {
    id: 'arms_api_key', label: '灯塔 ARMS（API Key）', group: '数据查询',
    file: 'arms_api_key.json', env: 'ARMS_API_KEY', url: '', kind: 'apikey',
    save: value => saveArmsApiKey(value),
    note: 'API Key 无法从浏览器读取，只能手动粘贴'
  },
  {
    id: 'ones', label: 'ONES 研发管理平台', group: '研发协作',
    file: 'ones_cookie.json', env: 'ONES_COOKIE', url: 'https://ones.ke.com/',
    names: ['ones_ke_token', 'session_id', 'csrfSecret', 'login_ucid', 'ucid', 'lianjia_ssid', 'lianjia_uuid'],
    save: header => saveOnesCookie(header),
    probe: { url: 'https://ones.ke.com/api/minepage/get_counts?quick_check=allaboutme', init: { method: 'GET' } },
    note: '失效表现：ones_query.js 报登录态失效 / 返回前端页面；需求、缺陷、排期查询全部不可用'
  }
];

function credentialById(id) {
  return CREDENTIALS.find(c => c.id === id) || null;
}

// 只读元信息：文件是否存在、更新时间、cookie 名与数量（不返回任何 cookie 值）
function describeCredential(def) {
  const file = path.join(SHRIMP_DIR, def.file);
  const out = {
    id: def.id, label: def.label, group: def.group, file: def.file,
    url: def.url, note: def.note || '', kind: def.kind || 'cookie',
    env: def.env, exists: false, updatedAt: null, names: [], count: 0,
    envOverride: Boolean(def.env && process.env[def.env]), probeSupported: Boolean(def.probe)
  };
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  out.exists = true;
  try {
    const stat = fs.statSync(file);
    out.bytes = stat.size;
    out.updatedAt = stat.mtime.toISOString();
  } catch {}
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (data && typeof data === 'object') {
    if (data.updated_at) out.updatedAt = data.updated_at;
    const header = [];
    if (typeof data.cookie === 'string' && data.cookie.trim()) header.push(data.cookie);
    if (typeof data.token === 'string') header.push(`token=${data.token}`);
    if (typeof data.apiKey === 'string') header.push(`apiKey=${data.apiKey}`);
    const names = new Set();
    for (const chunk of header) {
      for (const part of chunk.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) names.add(part.slice(0, eq).trim());
      }
    }
    out.names = [...names].filter(Boolean);
    out.count = out.names.length;
  }
  return out;
}

function listCredentials() {
  const groups = [...new Set(CREDENTIALS.map(c => c.group))];
  return {
    items: CREDENTIALS.map(describeCredential),
    groups,
    dir: SHRIMP_DIR
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------ 可见打开站点 ----
// 登录页直接开在用户自己的浏览器窗口里，就是一个普通标签页 ——
// 不建任务标签分组、不开独立窗口，和用户自己点 + 号开页没区别。
// （任务分组只用于 Agent 自己测试跑自动化，不该拿它挡在用户面前干活。）

// 打开站点：优先在用户当前窗口新建/复用同源标签页。
// 返回 {ok, url, method, reused, message}
async function openInUserBrowser(url) {
  const health = await ensureBridge({ startTimeoutMs: 15000 });
  if (!health || !health.extensionOnline) {
    throw new Error('Chrome 扩展「Leo cookie.txt Locally」未在线，请先在 chrome://extensions 启用');
  }
  // 老版本扩展没有 tabs.open，重新加载扩展后才能用普通标签页方式打开
  try {
    const res = await executeCommand('open-tab', { url, focus: true });
    const out = res && res.result ? res.result : res || {};
    return { ok: true, url, method: 'user-tab', reused: Boolean(out.reused) };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/Unsupported task type|invalid_request/i.test(msg)) {
      throw new Error('Chrome 扩展版本过旧（缺少「普通标签页」能力），请在 chrome://extensions 重新加载 Leo cookie.txt Locally 后重试');
    }
    throw err;
  }
}

async function openSiteVisible(url) {
  try {
    const r = await openInUserBrowser(url);
    return { ...r, message: `已在你的浏览器里打开标签页 ${url}` };
  } catch (err) {
    return { ok: false, url, method: 'user-tab', message: err.message };
  }
}

// 刷新：静默读一次浏览器 Cookie → 探活通过直接落盘；不通过就把站点真正打开到用户面前，
// 然后在 waitMs 内反复重读，用户登录完成后自动落盘，不用再点第二次。
async function refreshCredential({ id, waitMs = 120000 }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  if (def.kind === 'apikey') throw Object.assign(new Error('API Key 无法从浏览器读取，请手动粘贴保存'), { status: 400 });
  if (!def.url) throw Object.assign(new Error('该凭据没有可访问的站点地址'), { status: 400 });

  const budgetMs = Math.max(15000, Number(waitMs) || 120000);
  const deadline = Date.now() + budgetMs;
  let cookies = null;
  let lastError = null;
  let opened = null;
  let readAttempted = false;

  const silentRead = async timeoutMs => {
    try {
      cookies = await getBrowserCookies({ url: def.url, names: def.names, timeoutMs });
    } catch (err) {
      lastError = err;
      cookies = null;
    }
  };

  // 浏览器里可能只剩埋点 cookie：拿读到的 cookie 先探活，通过后才落盘，
  // 避免把原本有效的凭据覆盖成无效值。
  const commitIfVerified = async () => {
    if (!cookies || !cookies.length) return null;
    const header = cookiesToHeader(cookies);
    let ok = true;
    if (def.probe) {
      try { ok = Boolean((await probeCredentialById({ id: def.id, cookieOverride: header })).ok); } catch { ok = true; }
    }
    if (!ok) return null;
    if (!def.save(header)) throw Object.assign(new Error('读取成功但写入本地凭据文件失败'), { status: 500 });
    return {
      ok: true,
      verified: def.probe ? true : null,
      message: `已同步 ${cookies.length} 个 Cookie 并落盘${def.probe ? '，探活正常' : ''}`,
      def: describeCredential(def)
    };
  };

  // ① 静默读：已是登录态时完全不打扰用户
  await silentRead(25000);
  const firstDone = await commitIfVerified();
  if (firstDone) return { ...firstDone, opened: false };

  // ② 没登录 → 把站点真正打开（可见标签页），让用户能完成登录
  const target = `${new URL(def.loginUrl || def.url).origin}/`;
  opened = await openSiteVisible(target);
  if (!opened.ok) {
    return {
      ok: false,
      code: 'OPEN_FAILED',
      message: `${opened.message}。可先手动在 Chrome 打开 ${target} 登录后再点「刷新」。`,
      def: describeCredential(def)
    };
  }

  // ③ 轮询重读直到拿到有效登录态或超时
  for (;;) {
    if (Date.now() >= deadline) break;
    if (readAttempted && lastError && !['LOGIN_REQUIRED', 'COOKIE_NOT_FOUND'].includes(lastError.code)) break;
    readAttempted = true;
    await sleep(3000);
    await silentRead(10000);
    const done = await commitIfVerified();
    if (done) return { ...done, opened: true };
  }

  return {
    ok: false,
    code: (lastError && lastError.code) || 'LOGIN_TIMEOUT',
    message: `已在你的浏览器标签页打开 ${target}，但 ${Math.round(budgetMs / 1000)} 秒内未确认到有效登录态（原有凭据未改动）。完成登录后再点一次「刷新」即可。`,
    def: describeCredential(def)
  };
}

// 仅打开站点（用于「打开登录页」按钮），不写入任何凭据。
// 用真实可见的 Chrome 标签页，而不是扩展那个开完就关的隐藏窗口。
async function openCredentialSite({ id }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  if (!def.url && !def.loginUrl) throw Object.assign(new Error('该凭据没有可访问的站点地址'), { status: 400 });
  const target = `${new URL(def.loginUrl || def.url).origin}/`;
  const opened = await openSiteVisible(target);
  return { ...opened, target, finalUrl: opened.url };
}

function saveCredentialManually({ id, value }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error('凭据内容为空'), { status: 400 });
  if (def.kind === 'apikey') {
    if (!def.save(text)) throw Object.assign(new Error('写入失败'), { status: 500 });
    return { ok: true, message: 'API Key 已保存', def: describeCredential(def) };
  }
  // 手动粘贴可能是 Cookie 头、Netscape cookies.txt 或 JSON：统一交给 dinsight 的解析器归一化
  let header = text;
  if (def.id === 'dinsight') {
    if (!def.save(text)) throw Object.assign(new Error('内容里没有可识别的 token / cookie'), { status: 400 });
    return { ok: true, message: 'Dinsight 凭据已保存', def: describeCredential(def) };
  }
  if (text.includes('\t')) {
    const kvs = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
      const parts = line.replace(/^#HttpOnly_/, '').trimEnd().split('\t');
      if (parts.length === 7) kvs.push(`${parts[5]}=${parts[6]}`);
    }
    if (!kvs.length) throw Object.assign(new Error('没能从 cookies.txt 里解析出 cookie'), { status: 400 });
    header = kvs.join('; ');
  } else if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      header = String(data.cookie || data.token || '').trim();
    } catch {}
    if (!header) throw Object.assign(new Error('JSON 里没有 cookie 或 token 字段'), { status: 400 });
  }
  if (!def.save(header)) throw Object.assign(new Error('写入本地凭据文件失败'), { status: 500 });
  return { ok: true, message: '凭据已保存', def: describeCredential(def) };
}

function clearCredential({ id }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  const file = path.join(SHRIMP_DIR, def.file);
  try { fs.unlinkSync(file); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: true, message: '已清除本地凭据文件', def: describeCredential(def) };
}

async function probeCredentialById({ id, cookieOverride = null }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  if (!def.probe) return { ok: false, message: '该凭据不支持探活' };
  return probeCredential(path.join(SHRIMP_DIR, def.file), def.probe.url, def.probe.init, cookieOverride);
}

// ---------------------------------------------------------------- http -----

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ----------------------------------------------------- 脚本执行与结果解析 ----
// 页面上的「日志检索 / Apollo / 写操作」都复用 skill 既有脚本，
// 统一以 --json 输出结构化结果，避免在页面里重建一套接口。

const SCRIPTS = {
  testLog: path.join(__dirname, 'test_log_query.js'),
  fastLog: path.join(__dirname, 'fast_query.js'),
  apolloQuery: path.join(__dirname, 'apollo_query.js'),
  apolloHistory: path.join(__dirname, 'apollo_history.js'),
  apolloModify: path.join(__dirname, 'apollo_modify.js'),
  esModify: path.join(__dirname, 'es_modify.js'),
  kafkaSend: path.join(__dirname, 'kafka_send.js'),
  mysqlQuery: path.join(__dirname, 'test_mysql_query.js'),
  onesQuery: path.join(__dirname, 'ones_query.js'),
  onesModify: path.join(__dirname, 'ones_modify.js')
};

// 跑一个脚本，返回 {ok, code, stdout, stderr, json}
// timeoutMs 兜底，避免内网接口卡住把页面请求一起挂死
function runScript(script, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: SKILL_ROOT,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr + `\n[超时 ${Math.round(timeoutMs / 1000)}s，已终止]`, json: null });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + err.message, json: null });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr, json: extractJson(stdout) });
    });
  });
}

// 脚本会把提示信息混在 stdout 里，这里挑出第一段可解析的 JSON
function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== '{' && s[start] !== '[') continue;
    // 从候选起点做括号配对，配对不上说明这段不是完整 JSON，跳到下一个起点
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

// 服务名候选清单：catalog 里的主键与别名都可直接作为脚本入参，
// 因此全部列出（去掉 `xxx:prod` 这类索引变体），让页面里能按习惯写法搜索
function listAppItems() {
  const catalog = loadServiceCatalog();
  const out = [];
  for (const key of Object.keys(catalog)) {
    if (key.includes(':')) continue;
    out.push(key);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

// 写操作统一返回体：既给前端 JSON，也保留原文便于排查
function scriptResult(res, r, okText) {
  if (!r.ok && !r.json) {
    return json(res, 200, {
      ok: false,
      error: (r.stderr || r.stdout || '').trim() || `脚本退出码 ${r.code}`,
      stdout: r.stdout,
      stderr: r.stderr
    });
  }
  // 脚本自己判定失败时也会打 JSON（如 error 字段），这里统一透传
  const failed = r.json && (r.json.error || r.json.success === false);
  return json(res, 200, {
    ok: !failed && r.ok,
    json: r.json,
    stdout: r.stdout,
    stderr: r.stderr,
    message: okText || ''
  });
}

function buildPage(projects, appItems) {
  // 项目清单内嵌到页面：下拉永远展开全量，不做输入过滤
  const projectItems = projects.map(p => {
    const repo = String(p.git || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
    const tag = p.ci ? (p.deploy ? '· 可构建部署' : '· 仅构建') : '· 无 CI 配置';
    return { id: p.id, display: `${p.id}　${repo}　${tag}`, git: p.git || '', note: p.note || '' };
  });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Leo Live Inspector 控制台</title>
<style>
  :root { --bg:#0e1116; --panel:#171b22; --panel2:#1e242d; --border:#2b333f; --fg:#e6edf3; --muted:#8b97a7; --accent:#3b82f6; --accent2:#2563eb; --ok:#22c55e; --err:#ef4444; --warn:#f59e0b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:1180px; margin:0 auto; padding:24px 20px 70px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  header h1 { font-size:19px; margin:0; font-weight:650; letter-spacing:.3px; }
  .badge { font-size:11px; color:var(--warn); border:1px solid rgba(245,158,11,.4); background:rgba(245,158,11,.1); border-radius:20px; padding:2px 10px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px var(--ok); display:inline-block; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:20px; overflow-x:auto; position:sticky; top:0; z-index:20; background:var(--bg); }
  .tabs button { padding:10px 18px; font-size:14px; color:var(--muted); background:transparent; border:none; border-radius:0; border-bottom:2px solid transparent; white-space:nowrap; }
  .tabs button:hover { color:var(--fg); border-color:transparent; border-bottom-color:var(--border); }
  .tabs button.active { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .page { display:none; }
  .page.active { display:block; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px 18px 20px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 14px; font-weight:650; }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  .split { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:16px; align-items:start; }
  .field { display:flex; flex-direction:column; gap:6px; min-width:0; }
  .field label { font-size:12px; color:var(--muted); letter-spacing:.4px; }
  input, select, textarea { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); color:var(--fg); font-size:14px; outline:none; font-family:inherit; }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); }
  input[readonly] { color:var(--muted); }
  textarea { resize:vertical; min-height:70px; font-family:"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; }
  .row { display:flex; gap:8px; align-items:flex-end; }
  .row > input { flex:1; }
  .combo { position:relative; }
  .combo-list { position:absolute; z-index:30; left:0; right:0; top:calc(100% + 4px); max-height:280px; overflow:auto; background:var(--panel2); border:1px solid var(--border); border-radius:8px; box-shadow:0 14px 34px rgba(0,0,0,.5); }
  .combo-item { padding:8px 12px; font-size:13.5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .combo-item:hover, .combo-item.active { background:var(--accent); color:#fff; }
  .combo-empty { padding:10px 12px; color:var(--muted); font-size:13px; }
  button { padding:9px 15px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); color:var(--fg); font-size:14px; cursor:pointer; white-space:nowrap; font-family:inherit; }
  button:hover { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:linear-gradient(180deg,var(--accent),var(--accent2)); border:none; font-weight:600; padding:11px 24px; font-size:15px; }
  button.danger { background:linear-gradient(180deg,#dc2626,#b91c1c); border:none; font-weight:600; }
  button.ghost { background:transparent; }
  button.sm { padding:5px 10px; font-size:12.5px; }
  .hint { font-size:12px; color:var(--muted); margin-top:8px; line-height:1.6; }
  .actions { display:flex; align-items:center; gap:14px; margin-top:14px; flex-wrap:wrap; }
  .status { font-size:13px; }
  .status.running { color:var(--warn); }
  .status.success { color:var(--ok); }
  .status.error { color:var(--err); }
  pre.out { margin:0; padding:14px; height:340px; overflow:auto; background:#0a0d12; border:1px solid var(--border); border-radius:10px; font-family:"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; color:#c9d4e0; }
  pre#log { height:400px; }
  .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:8px 10px; color:var(--muted); font-weight:500; border-bottom:1px solid var(--border); white-space:nowrap; font-size:12px; }
  td { padding:8px 10px; border-bottom:1px solid rgba(43,51,63,.55); vertical-align:top; word-break:break-word; }
  tr:hover td { background:rgba(255,255,255,.02); }
  .mono { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:12px; }
  /* 凭据表格：cookie 名可能有十几个，必须 fixed 布局 + 百分比列宽 + 单行省略，
     否则名字会把「操作」列顶出卡片；窄窗口下操作按钮自动折行，不横向溢出 */
  table.cred { table-layout:fixed; }
  table.cred td, table.cred th { word-break:break-word; }
  .cred-ops { display:flex; gap:6px; flex-wrap:wrap; }
  .cred-line { margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:help; }
  .cred-line b { color:var(--fg); font-weight:600; }
  .tag { display:inline-block; font-size:11px; padding:1px 8px; border-radius:20px; border:1px solid var(--border); color:var(--muted); white-space:nowrap; }
  .tag.ok { color:var(--ok); border-color:rgba(34,197,94,.4); }
  .tag.err { color:var(--err); border-color:rgba(239,68,68,.4); }
  .tag.warn { color:var(--warn); border-color:rgba(245,158,11,.4); }
  .joblist { display:flex; flex-direction:column; gap:8px; max-height:520px; overflow:auto; }
  .jobitem { border:1px solid var(--border); border-radius:9px; padding:9px 11px; cursor:pointer; background:var(--panel2); }
  .jobitem:hover { border-color:var(--accent); }
  .jobitem.sel { border-color:var(--accent); background:rgba(59,130,246,.1); }
  .jobitem .t1 { font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .jobitem .t2 { font-size:11px; color:var(--muted); margin-top:4px; }
  .homecard { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px 18px; display:flex; flex-direction:column; gap:8px; }
  .homecard h3 { font-size:14px; margin:0; font-weight:650; }
  .homecard p { margin:0; font-size:12.5px; color:var(--muted); line-height:1.65; }
  .homecard .kw { font-size:11px; color:var(--muted); }
  .homecard button { align-self:flex-start; margin-top:4px; }
  .subtabs { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; }
  .subtabs button.on { border-color:var(--accent); color:#fff; background:rgba(59,130,246,.18); }
  .warnbox { border:1px solid rgba(239,68,68,.4); background:rgba(239,68,68,.08); border-radius:9px; padding:11px 13px; font-size:12.5px; color:#fca5a5; line-height:1.6; margin-bottom:16px; }
  .okbox { border:1px solid rgba(34,197,94,.35); background:rgba(34,197,94,.07); border-radius:9px; padding:11px 13px; font-size:12.5px; color:#86efac; line-height:1.6; }
  .toast { position:fixed; right:20px; bottom:20px; background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:12px 16px; font-size:13px; box-shadow:0 14px 40px rgba(0,0,0,.5); opacity:0; transform:translateY(8px); transition:.2s; pointer-events:none; max-width:420px; z-index:100; }
  .toast.show { opacity:1; transform:none; }
  .toast.err { border-color:rgba(239,68,68,.5); color:#fca5a5; }
  .toast.ok { border-color:rgba(34,197,94,.5); color:#86efac; }
  @media (max-width:860px) { .grid, .split { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="dot" id="liveDot"></span>
    <h1>Leo Live Inspector · 测试环境控制台</h1>
    <span class="badge">仅测试环境 · 生产只读</span>
  </header>

  <nav class="tabs" id="tabs" role="tablist">
    <button role="tab" class="active" data-tab="home" aria-selected="true">首页</button>
    <button role="tab" data-tab="deploy" aria-selected="false">部署</button>
    <button role="tab" data-tab="logs" aria-selected="false">日志检索</button>
    <button role="tab" data-tab="apollo" aria-selected="false">Apollo 配置</button>
    <button role="tab" data-tab="ones" aria-selected="false">ONES 研发</button>
    <button role="tab" data-tab="write" aria-selected="false">写操作</button>
    <button role="tab" data-tab="credentials" aria-selected="false">凭据</button>
  </nav>

  <!-- ============================ 首页 ============================ -->
  <section class="page active" id="page-home">
    <div class="card">
      <h2>这个控制台能做什么</h2>
      <p class="hint" style="margin-top:0">
        本页面把 leo-live-inspector 里最适合「手上要立刻动手」的能力做成了可视化入口。
        部署与写操作只作用于<b>测试环境</b>；线上环境一律只读，写入需要走官方审批流，页面不会提供入口。
      </p>
    </div>
    <div class="grid">
      <div class="homecard">
        <h3>🚀 合并 QA 分支并部署</h3>
        <p>选项目 → 选开发分支 → 合并进 QA 分支 → 推送 → 触发 Shipwright 构建 → 下发测试环境工作负载。合并全程在隔离 worktree 执行，不动你正在编辑的目录。</p>
        <div class="kw">对应脚本：deploy_web.js + ci_deploy.js</div>
        <button class="ghost" data-goto="deploy">进入部署 →</button>
      </div>
      <div class="homecard">
        <h3>🩺 部署后自动验活</h3>
        <p>部署成功后自动拉取该服务近 10 分钟的测试环境容器日志，抓 <code>ERROR</code> 级别条目，一眼看出「部署完了服务到底活没活」。</p>
        <div class="kw">对应脚本：test_log_query.js</div>
        <button class="ghost" data-goto="logs">去日志检索 →</button>
      </div>
      <div class="homecard">
        <h3>🔍 日志检索（测试 / 生产）</h3>
        <p>按服务 + 关键词 + 时间窗 + 日志级别查日志。测试环境走大禹泳道容器日志，生产环境走 FAST/Kibana（严格只读）。</p>
        <div class="kw">对应脚本：test_log_query.js / fast_query.js</div>
        <button class="ghost" data-goto="logs">进入日志检索 →</button>
      </div>
      <div class="homecard">
        <h3>⚙️ Apollo 配置速查与发布轨迹</h3>
        <p>查某服务在某环境的全量配置或按 key 关键字模糊搜；再按配置项追溯历次发布是谁、什么时候、把值从什么改成了什么。</p>
        <div class="kw">对应脚本：apollo_query.js / apollo_history.js</div>
        <button class="ghost" data-goto="apollo">进入 Apollo →</button>
      </div>
      <div class="homecard">
        <h3>🛠️ 测试环境写操作</h3>
        <p>Apollo 配置改值与发布、ES 文档改/删、Kafka 模拟投递、测试库 DML。全部强制「预检 → 确认」两步，未确认不写入。</p>
        <div class="kw">对应脚本：apollo_modify.js / es_modify.js / kafka_send.js / test_mysql_query.js</div>
        <button class="ghost" data-goto="write">进入写操作 →</button>
      </div>
      <div class="homecard">
        <h3>🔑 凭据台账</h3>
        <p>一页看全 skill 依赖的全部 Cookie / Token：是否有、上次更新时间、包含哪些 Cookie 名。点「刷新」会在需要登录时在你当前浏览器窗口打开对应站点标签页，你登录完凭据自动回读落盘。</p>
        <div class="kw">对应脚本：credential_relay.js（本地桥接 127.0.0.1:19526）</div>
        <button class="ghost" data-goto="credentials">管理凭据 →</button>
      </div>
      <div class="homecard">
        <h3>📜 历史任务回看</h3>
        <p>每次部署的完整日志都落盘在 <code>~/.shrimp/skills/live-inspector/deploy_jobs/</code>，服务重启后仍能点开看失败原因。</p>
        <div class="kw">入口：部署页右侧「最近任务」</div>
        <button class="ghost" data-goto="deploy">查看任务 →</button>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>安全边界</h2>
      <p class="hint" style="margin-top:0">
        · <b>生产环境物理只读</b>：任何写操作在后端就被拦截，页面不提供生产写入入口；<br />
        · <b>测试环境两步确认</b>：所有写操作必须先「预检」看到 Diff，再点「确认提交」才真正写入；<br />
        · <b>部署合并隔离</b>：合并冲突时严格失败并列出冲突文件，绝不自动改代码；QA 分支受保护时改走临时分支 + MR。
      </p>
    </div>
  </section>

  <!-- ============================ 部署 ============================ -->
  <section class="page" id="page-deploy">
    <div class="split">
      <div>
        <div class="card">
          <div class="grid">
            <div class="field">
              <label>项目（已登记 git 地址清单 · 展开即全量，不做搜索过滤）</label>
              <div class="combo">
                <input id="project" autocomplete="off" spellcheck="false" placeholder="点击展开项目清单，或直接输入服务名" />
                <div class="combo-list" id="projectList" hidden></div>
              </div>
              <div class="hint">登记位置：skill 的 resources/project_repos.json，或 ~/.shrimp/skills/live-inspector/project_repos.json</div>
            </div>
            <div class="field">
              <label>执行模式</label>
              <select id="mode">
                <option value="merge_deploy">合并 + 构建部署（QA 受保护时会在推送处提示改走 MR）</option>
                <option value="deploy_dev">直接部署开发分支（不合并、不推 QA，最快）</option>
                <option value="merge_only">仅合并到 QA 分支</option>
                <option value="build_deploy">仅构建部署（不合并）</option>
                <option value="build_only">仅构建（不部署）</option>
                <option value="preview">仅预演合并（不推送不部署）</option>
              </select>
            </div>
            <div class="field">
              <label>冲突处理策略</label>
              <div class="hint" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
                严格失败：出现冲突立即中止并列出冲突文件，不自动改代码、不推送、不部署。
              </div>
            </div>
            <div class="field">
              <label>开发分支（可输入搜索 · 自动记忆）</label>
              <div class="combo">
                <input id="devBranch" autocomplete="off" spellcheck="false" placeholder="点击选择，或输入关键字搜索" />
                <div class="combo-list" id="devList" hidden></div>
              </div>
            </div>
            <div class="field">
              <label>QA 分支（可输入搜索 · 自动记忆）</label>
              <div class="combo">
                <input id="qaBranch" autocomplete="off" spellcheck="false" placeholder="点击选择，或输入关键字搜索" />
                <div class="combo-list" id="qaList" hidden></div>
              </div>
              <div class="hint" id="qaHint"></div>
            </div>
            <div class="field" style="grid-column:1/-1">
              <label>仓库来源（已登记 git 地址则无需填写）</label>
              <div class="row">
                <input id="repoPath" placeholder="可选：手动指定本地仓库路径，如 /Users/you/IdeaProjects/iot-platform" />
                <button class="ghost" id="btnRepo">设置仓库</button>
                <button class="ghost" id="btnBranches">刷新分支</button>
              </div>
              <div class="hint" id="repoHint"></div>
            </div>
          </div>
          <div class="actions">
            <button class="primary" id="btnDeploy">合并并部署</button>
            <button class="ghost" id="btnCred">检查凭据</button>
            <label class="hint" style="display:flex;align-items:center;gap:6px;margin:0">
              <input type="checkbox" id="autoVerify" checked style="width:auto" /> 部署成功后自动验活
            </label>
            <span class="status" id="status">就绪</span>
          </div>
          <div class="hint" id="credHint"></div>
          <div class="hint">⚠️ 合并会创建隔离的临时工作区执行，不会影响你当前正在编辑的工作目录。生产环境不会被自动部署。</div>
        </div>

        <div class="card">
          <div class="field" style="margin-bottom:10px;flex-direction:row;align-items:center;justify-content:space-between">
            <label>执行日志</label>
            <span class="hint" id="logFollow" style="margin:0;display:none">已暂停自动跟随 · <a href="#" id="btnFollow" style="color:var(--accent)">回到最新</a></span>
          </div>
          <pre class="out" id="log">等待操作…</pre>
        </div>

        <div class="card" id="verifyCard" style="display:none">
          <h2>部署后验活（近 10 分钟测试环境 ERROR 日志）</h2>
          <div id="verifyBody"></div>
        </div>
      </div>

      <div class="card">
        <h2>最近任务</h2>
        <div class="hint" style="margin:0 0 10px">点击任意一条回看完整日志</div>
        <div class="joblist" id="jobList"><div class="combo-empty">加载中…</div></div>
        <button class="ghost sm" id="btnJobs" style="margin-top:10px;width:100%">刷新列表</button>
      </div>
    </div>
  </section>

  <!-- ============================ 日志检索 ============================ -->
  <section class="page" id="page-logs">
    <div class="card">
      <div class="grid">
        <div class="field">
          <label>日志来源</label>
          <select id="logSource">
            <option value="test">测试环境容器日志（大禹泳道 · Loki）</option>
            <option value="prod">生产环境 FAST / Kibana（只读）</option>
          </select>
        </div>
        <div class="field">
          <label>服务</label>
          <div class="combo">
            <input id="logApp" autocomplete="off" spellcheck="false" placeholder="输入服务名或别名，如 iot-platform / warehouse" />
            <div class="combo-list" id="logAppList" hidden></div>
          </div>
        </div>
        <div class="field">
          <label>关键词（可选）</label>
          <input id="logQuery" placeholder="如 Exception / orderCode / 接口路径" />
        </div>
        <div class="field">
          <label>日志级别</label>
          <select id="logLevel">
            <option value="">全部</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </div>
        <div class="field">
          <label>时间窗</label>
          <select id="logTime">
            <option value="15m">最近 15 分钟</option>
            <option value="1h" selected>最近 1 小时</option>
            <option value="6h">最近 6 小时</option>
            <option value="24h">最近 24 小时</option>
          </select>
        </div>
        <div class="field">
          <label>条数</label>
          <input id="logSize" value="20" />
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="btnLogQuery">查询日志</button>
        <button class="ghost" id="btnLogError">只看 ERROR</button>
        <span class="status" id="logStatus">就绪</span>
      </div>
      <div class="hint" id="logHint"></div>
    </div>
    <div class="card">
      <h2>结果</h2>
      <div id="logResult"><div class="combo-empty">尚未查询</div></div>
    </div>
  </section>

  <!-- ============================ Apollo ============================ -->
  <section class="page" id="page-apollo">
    <div class="card">
      <div class="grid">
        <div class="field">
          <label>服务</label>
          <div class="combo">
            <input id="apApp" autocomplete="off" spellcheck="false" placeholder="如 iot / saas / warehouse" />
            <div class="combo-list" id="apAppList" hidden></div>
          </div>
        </div>
        <div class="field">
          <label>环境</label>
          <select id="apEnv">
            <option value="test" selected>测试环境 (TEST)</option>
            <option value="preview">预发环境 (PREVIEW · 只读)</option>
            <option value="prod">生产环境 (PROD · 只读)</option>
          </select>
        </div>
        <div class="field">
          <label>命名空间 或 key 关键字</label>
          <input id="apKeyword" placeholder="如 application / timeout（留空=全量概览）" />
        </div>
        <div class="field">
          <label>发布轨迹：配置项 key</label>
          <input id="apHistoryKey" placeholder="填写后点「查发布轨迹」，如 personless.closeDoorTimeoutSecond" />
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="btnApQuery">查配置</button>
        <button class="ghost" id="btnApHistory">查发布轨迹</button>
        <span class="status" id="apStatus">就绪</span>
      </div>
      <div class="hint" id="apHint"></div>
    </div>
    <div class="card">
      <h2 id="apResultTitle">结果</h2>
      <div id="apResult"><div class="combo-empty">尚未查询</div></div>
    </div>
  </section>

  <!-- ============================ ONES 研发 ============================ -->
  <section class="page" id="page-ones">
    <div class="warnbox" style="border-color:rgba(59,130,246,.45)">
      ℹ️ <b>ONES 是协作系统，不受「生产只读」约束</b>。查询直接返回；新建需求 / 缺陷、改排期属于真实研发数据，
      必须先在「写入」子页预检看到 Diff，再点「确认提交」。
    </div>

    <div class="subtabs" id="onesTabs">
      <button class="on" data-o="schedule">我的排期</button>
      <button data-o="req">需求详情</button>
      <button data-o="reqs">需求检索</button>
      <button data-o="bugs">缺陷检索</button>
      <button data-o="meta">迭代 / 项目</button>
      <button data-o="write">写入</button>
    </div>

    <div class="card osec" id="o-schedule">
      <div class="grid">
        <div class="field">
          <label>起始日期</label>
          <input id="oSchedFrom" type="date" />
        </div>
        <div class="field">
          <label>结束日期</label>
          <input id="oSchedTo" type="date" />
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="oSchedQuery">查询排期</button>
        <button class="ghost" id="oSchedPrev">上一周</button>
        <button class="ghost" id="oSchedNext">下一周</button>
        <span class="status" id="oSchedStatus">就绪</span>
      </div>
      <div class="hint">按时间窗过滤估时条目，并按需求聚合交付窗口与总人天。只能查当前登录人（ONES 服务端限制）。</div>
    </div>

    <div class="card osec" id="o-req" style="display:none">
      <div class="grid">
        <div class="field" style="grid-column:1/-1">
          <label>需求 ID 或标题关键词</label>
          <input id="oReqKey" placeholder="如 50564297 / 钥匙箱" />
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="oReqQuery">查询需求</button>
        <span class="status" id="oReqStatus">就绪</span>
      </div>
      <div class="hint">状态、优先级、PM、迭代、层级、排期、全员估时、关联缺陷、可流转事件。</div>
    </div>

    <div class="card osec" id="o-reqs" style="display:none">
      <div class="grid">
        <div class="field"><label>迭代（ID 或标题，可空）</label><input id="oReqsSprint" placeholder="如 IoT-2026-11-24" /></div>
        <div class="field"><label>PM 账号（可空）</label><input id="oReqsPm" placeholder="如 sunzehao003" /></div>
        <div class="field"><label>标题关键词（可空）</label><input id="oReqsTitle" placeholder="如 钥匙箱" /></div>
        <div class="field"><label>层级（可空）</label><input id="oReqsLevel" placeholder="方向/业务线/系统/子系统" /></div>
      </div>
      <div class="actions">
        <button class="primary" id="oReqsQuery">查询需求列表</button>
        <span class="status" id="oReqsStatus">就绪</span>
      </div>
      <div class="hint">不传过滤条件会返回全库 44 万+ 条，至少填一项。</div>
    </div>

    <div class="card osec" id="o-bugs" style="display:none">
      <div class="grid">
        <div class="field"><label>缺陷 ID（可空）</label><input id="oBugsId" placeholder="如 10413977" /></div>
        <div class="field"><label>处理人（姓名 / 账号，可空）</label><input id="oBugsResolver" placeholder="如 孙泽浩" /></div>
        <div class="field"><label>标题关键词（可空）</label><input id="oBugsSummary" placeholder="如 钥匙" /></div>
        <div class="field"><label>关联需求 ID（可空）</label><input id="oBugsReq" placeholder="如 50564297" /></div>
        <div class="field"><label>条数</label><input id="oBugsLimit" value="10" /></div>
      </div>
      <div class="actions">
        <button class="primary" id="oBugsQuery">查询缺陷</button>
        <span class="status" id="oBugsStatus">就绪</span>
      </div>
    </div>

    <div class="card osec" id="o-meta" style="display:none">
      <div class="grid">
        <div class="field"><label>迭代关键词（可空）</label><input id="oMetaIter" placeholder="如 IoT-2026-11" /></div>
        <div class="field"><label>项目关键词（可空）</label><input id="oMetaProj" placeholder="如 惠居" /></div>
      </div>
      <div class="actions">
        <button class="primary" id="oMetaQuery">查询迭代 / 项目</button>
        <span class="status" id="oMetaStatus">就绪</span>
      </div>
    </div>

    <div class="card osec" id="o-write" style="display:none">
      <div class="hint" style="color:#fbbf24;margin-top:0">
        ⚠️ ONES 没有测试环境，这里的写入直接作用于<b>真实研发数据</b>。两步走：预检只算 Diff 不落库 → 确认提交才写入。
      </div>
      <div class="subtabs" id="onesWriteTabs">
        <button class="on" data-ow="req">新建需求</button>
        <button data-ow="bug">新建缺陷</button>
        <button data-ow="sched">调整排期</button>
        <button data-ow="move">移入迭代</button>
        <button data-ow="adv">状态流转</button>
      </div>

      <div class="card wsec2" id="ow-req" style="margin-bottom:0;padding:0;border:none;background:transparent">
        <div class="grid">
          <div class="field" style="grid-column:1/-1"><label>需求标题</label><input id="owReqTitle" placeholder="如 【钥匙箱三期】扫码开门" /></div>
          <div class="field"><label>层级</label><input id="owReqLevel" value="惠居技术中心/惠居B端/惠居IoT/IoT系统" /></div>
          <div class="field"><label>关联项目</label><input id="owReqProject" placeholder="如 惠居IoT项目" /></div>
          <div class="field"><label>产品经理</label><input id="owReqPm" placeholder="姓名或账号，如 孙泽浩" /></div>
          <div class="field"><label>迭代（可空）</label><input id="owReqSprint" placeholder="如 IoT-2026-11-24" /></div>
          <div class="field"><label>优先级</label><select id="owReqPriority"><option>P2</option><option>P1</option><option>P0</option></select></div>
          <div class="field"><label>需求类型</label><select id="owReqType"><option>产品需求</option><option>技术需求</option><option>埋点类需求</option><option>事务型需求</option><option>线上问题</option></select></div>
          <div class="field" style="grid-column:1/-1"><label>描述（可空）</label><textarea id="owReqDesc" placeholder="需求背景与目标"></textarea></div>
          <div class="field" style="grid-column:1/-1;flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="owReqSafety" checked style="width:auto" />
            <label style="margin:0">声明不涉及安全风险业务功能（新建需求的必填项）</label>
          </div>
        </div>
        <div class="actions">
          <button class="ghost" id="owReqPre">预检（不写入）</button>
          <button class="danger" id="owReqCommit" disabled>确认创建</button>
          <span class="status" id="owReqStatus">就绪</span>
        </div>
      </div>

      <div class="card wsec2" id="ow-bug" style="display:none;margin-bottom:0;padding:0;border:none;background:transparent">
        <div class="grid">
          <div class="field" style="grid-column:1/-1"><label>缺陷标题</label><input id="owBugSummary" placeholder="如 OTA 升级后设备离线" /></div>
          <div class="field"><label>处理人</label><input id="owBugResolver" placeholder="姓名或账号，如 孙泽浩" /></div>
          <div class="field"><label>关联需求 ID（可空）</label><input id="owBugReq" placeholder="如 50564297" /></div>
          <div class="field"><label>优先级</label><select id="owBugPriority"><option>P2</option><option>P1</option><option>P0</option></select></div>
          <div class="field"><label>缺陷类型</label><select id="owBugType"><option>测试阶段</option><option>开发阶段</option><option>产品阶段</option><option>showcase阶段</option><option>用户验收阶段（UAT)</option></select></div>
          <div class="field"><label>发现方式</label><select id="owBugFindWay"><option>手工测试</option><option>自动化测试</option><option>CR</option><option>监控报警</option><option>流量回放</option></select></div>
          <div class="field"><label>工时（天，可空）</label><input id="owBugHours" placeholder="如 0.2" /></div>
          <div class="field"><label>层级（可空，缺省用 IoT 默认）</label><input id="owBugLevel" placeholder="方向/业务线/系统/子系统" /></div>
          <div class="field" style="grid-column:1/-1"><label>描述（可空）</label><textarea id="owBugDesc" placeholder="复现步骤 / 期望结果"></textarea></div>
        </div>
        <div class="actions">
          <button class="ghost" id="owBugPre">预检（不写入）</button>
          <button class="danger" id="owBugCommit" disabled>确认创建</button>
          <span class="status" id="owBugStatus">就绪</span>
        </div>
      </div>

      <div class="card wsec2" id="ow-sched" style="display:none;margin-bottom:0;padding:0;border:none;background:transparent">
        <div class="grid">
          <div class="field"><label>需求 ID</label><input id="owSchedId" placeholder="如 50564297" /></div>
          <div class="field"><label>计划上线</label><input id="owSchedOnline" placeholder="2026-12-20 23:59:59" /></div>
          <div class="field"><label>开发开始</label><input id="owSchedDevStart" placeholder="2026-12-01" /></div>
          <div class="field"><label>开发结束</label><input id="owSchedDevEnd" placeholder="2026-12-05" /></div>
          <div class="field"><label>测试开始</label><input id="owSchedTestStart" placeholder="2026-12-08" /></div>
          <div class="field"><label>测试结束</label><input id="owSchedTestEnd" placeholder="2026-12-12" /></div>
          <div class="field"><label>计划提测</label><input id="owSchedSubmitTest" placeholder="2026-12-06 23:59:59" /></div>
        </div>
        <div class="actions">
          <button class="ghost" id="owSchedPre">预检（Diff）</button>
          <button class="danger" id="owSchedCommit" disabled>确认提交</button>
          <span class="status" id="owSchedStatus">就绪</span>
        </div>
      </div>

      <div class="card wsec2" id="ow-move" style="display:none;margin-bottom:0;padding:0;border:none;background:transparent">
        <div class="grid">
          <div class="field"><label>需求 ID（多个用逗号分隔）</label><input id="owMoveIds" placeholder="如 50564297,50566423" /></div>
          <div class="field"><label>目标迭代</label><input id="owMoveSprint" placeholder="如 IoT-2026-11-24" /></div>
        </div>
        <div class="actions">
          <button class="ghost" id="owMovePre">预检</button>
          <button class="danger" id="owMoveCommit" disabled>确认迁移</button>
          <span class="status" id="owMoveStatus">就绪</span>
        </div>
      </div>

      <div class="card wsec2" id="ow-adv" style="display:none;margin-bottom:0;padding:0;border:none;background:transparent">
        <div class="grid">
          <div class="field"><label>对象类型</label><select id="owAdvKind"><option value="requirement">需求</option><option value="bug">缺陷</option></select></div>
          <div class="field"><label>ID</label><input id="owAdvId" placeholder="如 50565445" /></div>
          <div class="field"><label>流转事件</label><input id="owAdvEvent" placeholder="如 评审 / 提测 / 已处理 / 关闭 / 删除" /></div>
        </div>
        <div class="hint">可用事件取决于对象当前状态，预检时会列出来。删除 / 取消标红为高危，需额外确认。</div>
        <div class="actions">
          <button class="ghost" id="owAdvPre">预检</button>
          <button class="danger" id="owAdvCommit" disabled>确认流转</button>
          <span class="status" id="owAdvStatus">就绪</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 id="oResultTitle">结果</h2>
      <div id="oResult"><div class="combo-empty">尚未查询</div></div>
      <pre class="out" id="oRaw" style="display:none"></pre>
    </div>
  </section>

  <!-- ============================ 写操作 ============================ -->
  <section class="page" id="page-write">
    <div class="warnbox">
      🚨 <b>仅测试环境</b>。所有写操作必须先「预检」看到变更 Diff，再点「确认提交」才会真正写入。
      生产环境写入在后端被物理拦截，本页面不提供入口。
    </div>
    <div class="subtabs" id="writeTabs">
      <button class="on" data-w="apollo">Apollo 配置</button>
      <button data-w="es">ES 文档</button>
      <button data-w="kafka">Kafka 投递</button>
      <button data-w="mysql">测试库 SQL</button>
    </div>

    <div class="card wsec" id="w-apollo">
      <div class="grid">
        <div class="field">
          <label>服务</label>
          <div class="combo">
            <input id="wApApp" autocomplete="off" spellcheck="false" placeholder="如 iot / saas / warehouse" />
            <div class="combo-list" id="wApAppList" hidden></div>
          </div>
        </div>
        <div class="field">
          <label>配置项 Key</label>
          <input id="wApKey" placeholder="如 liveRunner.access.ucIdWhitelist" />
        </div>
        <div class="field">
          <label>命名空间（可留空，自动嗅探）</label>
          <input id="wApNs" placeholder="如 application" />
        </div>
        <div class="field">
          <label>发布属性</label>
          <select id="wApType">
            <option value="switch">业务开关 (SWITCH)</option>
            <option value="change">业务变更 (CHANGE)</option>
            <option value="degrade">业务降级 (DEGRADE)</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>新的值（支持 JSON）</label>
          <textarea id="wApValue" placeholder='如 [31534062,12] 或 {"enabled":true}'></textarea>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>发布备注</label>
          <input id="wApComment" placeholder="可选，会写入 Apollo 发布记录" />
        </div>
      </div>
      <div class="actions">
        <button class="ghost" id="wApPre">预检（不写入）</button>
        <button class="danger" id="wApCommit" disabled>确认提交</button>
        <span class="status" id="wApStatus">就绪</span>
      </div>
    </div>

    <div class="card wsec" id="w-es" style="display:none">
      <div class="grid">
        <div class="field">
          <label>索引（Service ID 或名称关键词）</label>
          <input id="wEsApp" placeholder="如 门锁 / 1036710001" />
        </div>
        <div class="field">
          <label>动作</label>
          <select id="wEsAction">
            <option value="update-part">更新部分字段 (update-part)</option>
            <option value="update">整条覆盖更新 (update)</option>
            <option value="insert">新增 (insert)</option>
            <option value="delete">删除 (delete)</option>
          </select>
        </div>
        <div class="field">
          <label>文档 ID</label>
          <input id="wEsId" placeholder="如 10001" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>写入数据（JSON，删除时可留空）</label>
          <textarea id="wEsData" placeholder='{"battery": 95}'></textarea>
        </div>
      </div>
      <div class="actions">
        <button class="ghost" id="wEsPre">预检（Dry-Run Diff）</button>
        <button class="danger" id="wEsCommit" disabled>确认提交</button>
        <span class="status" id="wEsStatus">就绪</span>
      </div>
    </div>

    <div class="card wsec" id="w-kafka" style="display:none">
      <div class="grid">
        <div class="field">
          <label>Topic（名称 / 中文别名 / 关键词）</label>
          <input id="wKfTopic" placeholder="如 工单 / beijia-reach-event" />
        </div>
        <div class="field">
          <label>消息 Key（可选）</label>
          <input id="wKfKey" placeholder="用于固定分区路由" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>消息体（JSON）</label>
          <textarea id="wKfData" placeholder='{"orderCode":"TEST-001","status":"已接单"}'></textarea>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>基于 Sample 模板覆盖字段（可选，每行 k=v；填了则使用 --use-sample）</label>
          <textarea id="wKfSets" placeholder="status=已完成"></textarea>
        </div>
      </div>
      <div class="actions">
        <button class="ghost" id="wKfPre">预检（不投递）</button>
        <button class="danger" id="wKfCommit" disabled>确认投递</button>
        <span class="status" id="wKfStatus">就绪</span>
      </div>
      <div class="hint">Kafka 无原生 Dry-Run：预检只做参数校验与消息体回显，点「确认投递」才真正发送到测试集群。</div>
    </div>

    <div class="card wsec" id="w-mysql" style="display:none">
      <div class="grid">
        <div class="field">
          <label>服务（测试库）</label>
          <div class="combo">
            <input id="wDbApp" autocomplete="off" spellcheck="false" placeholder="如 saas / recorder / iot" />
            <div class="combo-list" id="wDbAppList" hidden></div>
          </div>
        </div>
        <div class="field">
          <label>数据源（可留空，使用默认主库）</label>
          <input id="wDbDs" placeholder="如 tenant0" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>SQL</label>
          <textarea id="wDbSql" placeholder="SELECT * FROM algo_detect_report ORDER BY id DESC LIMIT 5" style="min-height:100px"></textarea>
        </div>
      </div>
      <div class="actions">
        <button class="ghost" id="wDbPre">预检 / 查询</button>
        <button class="danger" id="wDbCommit" disabled>确认执行</button>
        <span class="status" id="wDbStatus">就绪</span>
      </div>
      <div class="hint">SELECT/SHOW/DESC/EXPLAIN 点「预检 / 查询」即直接返回结果；INSERT/UPDATE/DELETE 需要再点「确认执行」。无 WHERE 的 UPDATE/DELETE 由脚本层拦截。</div>
    </div>

    <div class="card">
      <h2 id="wOutTitle">执行输出</h2>
      <pre class="out" id="wOut">等待操作…</pre>
    </div>
  </section>

  <!-- ============================ 凭据 ============================ -->
  <section class="page" id="page-credentials">
    <div class="card">
      <h2>凭据台账</h2>
      <p class="hint" style="margin-top:0">
        这里只展示「有没有、什么时候更新的、包含哪些 Cookie 名」，<b>不会把 Cookie / Token 的值显示在页面上</b>。
        本机凭据目录：<code id="credDir">~/.shrimp/skills/live-inspector/</code>
      </p>
      <div class="actions" style="margin-top:0">
        <button id="credReload">重新扫描</button>
        <button id="credRefreshAll" class="ghost">刷新全部已登录站点</button>
        <label class="hint" style="display:flex;align-items:center;gap:6px;margin:0">
          等待登录最长
          <select id="credWait" style="width:auto;padding:6px 8px">
            <option value="45000">45 秒</option>
            <option value="120000" selected>2 分钟</option>
            <option value="300000">5 分钟</option>
          </select>
        </label>
        <span class="status" id="credStatus"></span>
      </div>
      <div class="hint">
        刷新流程：点「刷新」→ 先用浏览器里的现有 Cookie 探活，通过即一步落盘（不打扰你）→
        不通过才会在<b>你自己的浏览器窗口</b>里打开该站点的一个普通标签页（不建标签组、不另开窗口），你在那里登录 →
        页面每 3 秒重读一次 Cookie，读到有效登录态就自动写入本机凭据文件并刷新下面的状态，不用再点第二次。
        「登录页」按钮只负责打开这个标签页，不写任何文件。
      </div>
    </div>
    <div class="card">
      <h2>凭据明细</h2>
      <div id="credBody" class="muted">加载中…</div>
    </div>
  </section>
</div>

<div class="toast" id="toast"></div>

<script>
const PROJECT_ITEMS = ${JSON.stringify(projectItems).replace(/</g, '\\u003c')};
const APP_ITEMS = ${JSON.stringify(appItems).replace(/</g, '\\u003c')};
let currentProject = '';
let pollTimer = null;
let lastJobId = null;

const $ = id => document.getElementById(id);
const modeLabel = { merge_deploy:'合并并部署', merge_only:'仅合并', deploy_dev:'直接部署开发分支', build_deploy:'仅构建部署', build_only:'仅构建', preview:'仅预演合并' };

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast' + (type ? ' ' + type : ''); }, 3200);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function post(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ---------------------------------------------------------------- tabs ----
const TABS = ['home', 'deploy', 'logs', 'apollo', 'ones', 'write', 'credentials'];

function showTab(name) {
  if (!TABS.includes(name)) name = 'home';
  document.querySelectorAll('#tabs button').forEach(a => {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    a.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  try { localStorage.setItem('leo.tab', name); } catch (e) {}
  // #credentials 这类锚点可直接分享 / 收藏到具体 Tab
  try {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', name === 'home' ? location.pathname + location.search : '#' + name);
    }
  } catch (e) {}
  // 页面隐藏时 scrollHeight 为 0，轮询期间贴底会失效；切回部署页时补一次贴底
  if (name === 'deploy') {
    setTimeout(() => {
      if (!logStick) return;
      const el = $('log');
      if (el) el.scrollTop = el.scrollHeight;
    }, 30);
  }
  // 凭据台账每次进入都重新扫描，保证看到的是磁盘上的最新状态
  if (name === 'credentials') loadCredentials();
  // ONES 首次进入自动查本周排期
  if (name === 'ones') onesOnEnter();
}
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
document.querySelectorAll('button[data-goto]').forEach(b => {
  b.addEventListener('click', () => showTab(b.dataset.goto));
});

// -------------------------------------------------------------- combos ----
let branchOptions = [];

// 通用搜索型下拉：输入即过滤（用于分支与各类服务名）
function makeCombo(inputId, listId, itemsFn, onPick) {
  const input = $(inputId);
  const list = $(listId);
  if (!input || !list) return null;
  let items = [];
  let active = -1;

  function highlight() {
    list.querySelectorAll('.combo-item').forEach((el, i) => el.classList.toggle('active', i === active));
    const el = list.querySelector('.combo-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function render(filter) {
    const all = itemsFn() || [];
    const f = (filter || '').toLowerCase().trim();
    items = all.filter(b => !f || String(b).toLowerCase().includes(f)).slice(0, 400);
    if (!items.length) {
      list.innerHTML = '<div class="combo-empty">' + (all.length ? '无匹配项' : '暂无可选项') + '</div>';
      list.hidden = false;
      return;
    }
    list.innerHTML = items.map((b, i) => '<div class="combo-item" data-i="' + i + '">' + escHtml(b) + '</div>').join('');
    list.hidden = false;
    active = -1;
  }

  function hide() { list.hidden = true; active = -1; }

  input.addEventListener('focus', () => render(''));
  input.addEventListener('click', () => render(''));
  // 点击时全选旧值，直接输入关键字即可整段替换
  input.addEventListener('mousedown', e => {
    if (!input.value) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', e => {
    if (list.hidden) { if (e.key === 'ArrowDown') render(''); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') {
      if (active >= 0 && items[active]) { e.preventDefault(); input.value = items[active]; hide(); if (onPick) onPick(); }
      else hide();
    } else if (e.key === 'Escape') { hide(); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  list.addEventListener('mousedown', e => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault();
    input.value = items[Number(it.dataset.i)];
    hide();
    if (onPick) onPick();
  });
  return { input, list, hide };
}

// 项目下拉：不做搜索过滤 —— 点击/输入都直接展开「已登记项目」全量清单
function setupProjectCombo() {
  const input = $('project');
  const list = $('projectList');
  let active = -1;

  function render() {
    if (!PROJECT_ITEMS.length) {
      list.innerHTML = '<div class="combo-empty">未登记任何项目：请在 resources/project_repos.json 登记 git 地址，或直接输入服务名</div>';
      list.hidden = false;
      return;
    }
    list.innerHTML = PROJECT_ITEMS.map((p, i) =>
      '<div class="combo-item" data-i="' + i + '" title="' + escHtml(p.display) + '">' + escHtml(p.display) + '</div>'
    ).join('');
    list.hidden = false;
    active = -1;
  }

  function hide() { list.hidden = true; active = -1; }

  function highlight() {
    list.querySelectorAll('.combo-item').forEach((el, i) => el.classList.toggle('active', i === active));
    const el = list.querySelector('.combo-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const p = PROJECT_ITEMS[i];
    if (!p) return;
    input.value = p.id;
    hide();
    onProjectChanged(p.id);
  }

  input.addEventListener('focus', render);
  input.addEventListener('click', render);
  input.addEventListener('mousedown', e => {
    const v = input.value.trim();
    const known = PROJECT_ITEMS.some(p => p.id === v);
    if (!known) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  input.addEventListener('input', () => {
    render();
    const v = input.value.trim();
    const hit = PROJECT_ITEMS.find(p => p.id.toLowerCase() === v.toLowerCase());
    if (hit && hit.id !== currentProject) onProjectChanged(hit.id);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) render();
      active = Math.min(active + 1, PROJECT_ITEMS.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) pick(active);
      else { hide(); onProjectChanged(input.value.trim()); }
    } else if (e.key === 'Escape') {
      hide();
    }
  });
  input.addEventListener('blur', () => setTimeout(async () => {
    hide();
    const v = input.value.trim();
    if (!v || v === currentProject) return;
    const known = PROJECT_ITEMS.some(p => p.id.toLowerCase() === v.toLowerCase());
    if (known) { onProjectChanged(v); return; }
    // 未登记的服务名：确认本机能找到仓库才切换，避免敲了一半就切走、把分支列表清空
    try {
      const st = await api('/api/state?project=' + encodeURIComponent(v));
      if (st.repoPath) onProjectChanged(v);
      else input.value = currentProject;
    } catch (e) {
      input.value = currentProject;
    }
  }, 120));
  list.addEventListener('mousedown', e => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault();
    pick(Number(it.dataset.i));
  });
}

// ============================================================ 部署 Tab ====
function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function loadState(project) {
  if (!project) return;
  try {
    const st = await api('/api/state?project=' + encodeURIComponent(project));
    $('repoPath').value = st.repoMode === 'manual' ? (st.repoPath || '') : '';
    let repoText;
    if (st.cloneError) {
      repoText = '❌ 克隆失败: ' + st.cloneError;
    } else if (st.gitUrl && st.repoMode === 'clone') {
      repoText = '已登记仓库 ' + st.gitUrl + '，托管克隆 ' + (st.repoPath || '') + '（无需本地检出）';
    } else if (st.repoPath) {
      repoText = '本地仓库: ' + st.repoPath;
    } else {
      repoText = '未登记 git 地址，也未找到本地仓库：请在 skill 的 resources/project_repos.json 登记，或手动填写路径后点「设置仓库」。';
    }
    await loadBranches(project);
    $('repoHint').textContent = repoText;
    $('devBranch').value = st.devBranch || '';
    $('qaBranch').value = st.qaBranch || '';
    checkQaConvention();
  } catch (e) {
    setStatus('读取记忆失败: ' + e.message, 'error');
  }
}

async function loadBranches(project, force) {
  const hint = $('repoHint');
  if (!project) { hint.textContent = '请先在上方选择项目。'; return; }
  hint.textContent = '正在加载分支列表…';
  try {
    const data = await api('/api/branches?project=' + encodeURIComponent(project) + (force ? '&force=1' : ''));
    branchOptions = data.branches || [];
    hint.textContent = data.repoPath
      ? '共 ' + branchOptions.length + ' 个远程分支，点击分支框可搜索选择'
      : '未找到本地仓库，请手动填写路径后点击「设置仓库」。';
  } catch (e) {
    branchOptions = [];
    hint.textContent = '加载分支失败: ' + e.message;
  }
}

async function saveSelection() {
  if (!currentProject) return;
  try {
    await post('/api/state', {
      project: currentProject,
      devBranch: $('devBranch').value.trim(),
      qaBranch: $('qaBranch').value.trim()
    });
  } catch (e) {}
}

makeCombo('devBranch', 'devList', () => branchOptions, saveSelection);
makeCombo('qaBranch', 'qaList', () => branchOptions, saveSelection);
setupProjectCombo();

function checkQaConvention() {
  const qa = ($('qaBranch').value || '').trim();
  const hint = $('qaHint');
  if (!qa) { hint.textContent = ''; return; }
  if (/^qa[-_]?\\d{4}[-_]\\d{1,2}(?:[-_]\\d{1,2})?$/i.test(qa)) {
    hint.textContent = '✅ 月度 QA 分支（测试环境当前使用的分支形式）';
  } else if (/^qa$/i.test(qa)) {
    hint.textContent = '⚠️ 固定的 qa 分支通常不是测试环境当前使用的分支，建议改用最新的 qa-YYYY-MM（如 qa-2026-11）';
  } else {
    hint.textContent = '⚠️ 该分支不是 qa-YYYY-MM 形式，确认测试环境是否部署的是它';
  }
}
$('qaBranch').addEventListener('input', checkQaConvention);
$('qaBranch').addEventListener('blur', checkQaConvention);

function onProjectChanged(value) {
  const project = (value || '').trim();
  if (!project) return;
  currentProject = project;
  $('status').textContent = '就绪';
  branchOptions = [];
  loadState(project);
  // 其他 Tab 的服务名输入框跟着联动，减少重复输入
  ['logApp', 'apApp', 'wApApp', 'wDbApp'].forEach(id => { if ($(id) && !$(id).value) $(id).value = project; });
}

$('btnRepo').addEventListener('click', async () => {
  if (!currentProject) return setStatus('请先选择项目', 'error');
  try {
    await post('/api/repo', { project: currentProject, path: $('repoPath').value.trim() });
    await loadBranches(currentProject, true);
    setStatus('仓库路径已保存', 'success');
  } catch (e) {
    setStatus(e.message, 'error');
  }
});

$('btnBranches').addEventListener('click', () => currentProject && loadBranches(currentProject, true));

async function refreshCredentialStatus() {
  const hint = $('credHint');
  try {
    const c = await api('/api/credentials');
    const s = c.shipwright, cl = c.cloud;
    const line = '内网站点登录态 · Shipwright(构建): ' + (s.ok ? '✅ ' + s.message : '❌ ' + s.message) +
      ' ｜ Cloud(部署): ' + (cl.ok ? '✅ ' + cl.message : '❌ ' + cl.message);
    hint.textContent = line + (s.ok && cl.ok ? '' :
      '。失效会导致「无法获取构建器」。修复：到「凭据」Tab 点对应条目的「刷新」，Chrome 会打开该站点，登录完自动回读落盘。');
  } catch (e) {
    hint.textContent = '凭据检查失败: ' + e.message;
  }
}

$('btnCred').addEventListener('click', refreshCredentialStatus);

$('btnDeploy').addEventListener('click', async () => {
  const project = $('project').value.trim();
  const dev = $('devBranch').value.trim();
  const qa = $('qaBranch').value.trim();
  const mode = $('mode').value;
  const conflict = 'strict';
  if (!project) return setStatus('请选择项目', 'error');
  if (!qa) return setStatus('请选择 QA 分支', 'error');
  if ((mode === 'merge_deploy' || mode === 'merge_only' || mode === 'preview' || mode === 'deploy_dev') && !dev) return setStatus('请选择开发分支', 'error');
  if (!confirm('即将把 [' + dev + '] 合并到 [' + qa + '] 并执行「' + modeLabel[mode] + '」，确认继续？')) return;

  currentProject = project;
  await saveSelection();
  $('verifyCard').style.display = 'none';
  logStick = true;
  updateFollowHint();
  $('log').textContent = '任务提交中…';
  let job;
  try {
    job = await post('/api/deploy', { project, devBranch: dev, qaBranch: qa, mode, conflict });
  } catch (e) {
    setStatus(e.message, 'error');
    $('log').textContent = '❌ ' + e.message;
    return;
  }
  lastJobId = job.id;
  setStatus('执行中…', 'running');
  $('btnDeploy').disabled = true;
  startPolling(job.id);
  loadJobs();
});

// 日志区「智能跟随」：只有用户停留在底部时才自动滚到底。
const STICK_THRESHOLD = 48;
let logStick = true;

function isLogAtBottom() {
  const el = $('log');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
}

function updateFollowHint() {
  const tip = $('logFollow');
  if (!tip) return;
  tip.style.display = logStick ? 'none' : 'inline';
}

$('log').addEventListener('scroll', () => {
  const stick = isLogAtBottom();
  if (stick !== logStick) {
    logStick = stick;
    updateFollowHint();
  }
});

$('btnFollow').addEventListener('click', e => {
  e.preventDefault();
  logStick = true;
  updateFollowHint();
  const el = $('log');
  el.scrollTop = el.scrollHeight;
});

// 用 textContent 整体重写会重置滚动位置与选区，改为仅在有变化时更新并保留视口
function setLogText(el, text) {
  if (el.textContent === text) return false;
  if (logStick) {
    el.textContent = text;
    el.scrollTop = el.scrollHeight;
  } else {
    const keep = el.scrollTop;
    el.textContent = text;
    el.scrollTop = keep;
  }
  return true;
}

function startPolling(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    try {
      const job = await api('/api/job?id=' + encodeURIComponent(jobId));
      setLogText($('log'), job.log || '');
      if (job.status === 'running') {
        setStatus('执行中…', 'running');
      } else {
        clearInterval(pollTimer);
        pollTimer = null;
        $('btnDeploy').disabled = false;
        if (job.status === 'success') {
          setStatus(job.result && job.result.imageAddress ? '部署成功 · ' + job.result.imageAddress : '执行成功', 'success');
          if ($('autoVerify').checked && job.project) verifyDeploy(job.project, job.mode);
        } else {
          setStatus('执行失败', 'error');
        }
        loadJobs();
      }
    } catch (e) {
      // 忽略轮询瞬时错误
    }
  };
  tick();
  pollTimer = setInterval(tick, 1200);
}

// ---------------------------------------------------------- 部署后验活 ----
async function verifyDeploy(project, mode) {
  const card = $('verifyCard');
  const body = $('verifyBody');
  card.style.display = 'block';
  if (mode === 'merge_only' || mode === 'preview') {
    body.innerHTML = '<div class="hint" style="margin:0">本次模式未触发构建部署，跳过验活。</div>';
    return;
  }
  body.innerHTML = '<div class="hint" style="margin:0">正在拉取 ' + escHtml(project) + ' 近 10 分钟测试环境 ERROR 日志…</div>';
  try {
    const r = await post('/api/verify', { project, minutes: '10m' });
    body.innerHTML = renderVerify(r, project);
  } catch (e) {
    body.innerHTML = '<div class="warnbox" style="margin:0">验活失败：' + escHtml(e.message) + '</div>';
  }
}

function renderVerify(r, project) {
  if (!r.ok) {
    return '<div class="warnbox" style="margin:0">未能获取日志：' + escHtml(r.error || r.stderr || '未知错误') + '</div>';
  }
  const j = r.json || {};
  const logs = j.logs || [];
  if (!logs.length) {
    return '<div class="okbox">✅ 近 10 分钟未发现 ERROR 日志（' + escHtml(project) + '），服务看起来已经起来了。</div>';
  }
  let html = '<div class="warnbox" style="margin:0 0 12px">⚠️ 近 10 分钟有 ' + logs.length + ' 条 ERROR 日志，请确认是否为本次部署引入。</div>';
  html += '<table><thead><tr><th style="width:150px">时间</th><th>日志</th></tr></thead><tbody>';
  logs.forEach(l => {
    const ts = l.timestamp ? new Date(l.timestamp).toLocaleString('zh-CN') : '-';
    const line = (l.line || '').replace(/^.*?stdout F /, '');
    html += '<tr><td class="mono muted">' + escHtml(ts) + '</td><td class="mono" title="' + escHtml(line) + '">' + escHtml(line.slice(0, 400)) + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

// ------------------------------------------------------------ 历史任务 ----
async function loadJobs() {
  const box = $('jobList');
  try {
    const data = await api('/api/jobs');
    const jobs = data.jobs || [];
    if (!jobs.length) {
      box.innerHTML = '<div class="combo-empty">暂无历史任务</div>';
      return;
    }
    box.innerHTML = jobs.map(j => {
      const cls = j.status === 'success' ? 'ok' : (j.status === 'running' ? 'warn' : 'err');
      const t = j.startedAt ? new Date(j.startedAt).toLocaleString('zh-CN') : '';
      return '<div class="jobitem' + (j.id === lastJobId ? ' sel' : '') + '" data-id="' + escHtml(j.id) + '">' +
        '<div class="t1">' + escHtml(j.project || '-') + ' <span class="tag ' + cls + '">' + escHtml(j.status) + '</span></div>' +
        '<div class="t2">' + escHtml(j.modeLabel || j.mode || '') + ' · ' + escHtml(t) + '</div>' +
        '</div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="combo-empty">加载失败: ' + escHtml(e.message) + '</div>';
  }
}

$('jobList').addEventListener('click', async e => {
  const it = e.target.closest('.jobitem');
  if (!it) return;
  lastJobId = it.dataset.id;
  document.querySelectorAll('.jobitem').forEach(x => x.classList.toggle('sel', x === it));
  try {
    const job = await api('/api/job?id=' + encodeURIComponent(lastJobId));
    const head = '历史任务 [' + (job.project || '-') + '] ' + (job.devBranch || '-') + ' → ' + (job.qaBranch || '-') +
      ' (' + (modeLabel[job.mode] || job.mode) + ') · ' + job.status + String.fromCharCode(10, 10);
    logStick = true;
    updateFollowHint();
    $('log').textContent = head + (job.log || '');
    $('log').scrollTop = $('log').scrollHeight;
    if (job.status === 'running') {
      setStatus('该任务仍在执行…', 'running');
      $('btnDeploy').disabled = true;
      startPolling(job.id);
    } else {
      setStatus(job.status === 'success' ? '历史任务：执行成功' : '历史任务：执行失败', job.status === 'success' ? 'success' : 'error');
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      $('btnDeploy').disabled = false;
    }
    showTab('deploy');
  } catch (err) {
    toast('读取任务失败: ' + err.message, 'err');
  }
});
$('btnJobs').addEventListener('click', loadJobs);

// ========================================================== 日志检索 Tab ====
makeCombo('logApp', 'logAppList', () => APP_ITEMS);
makeCombo('apApp', 'apAppList', () => APP_ITEMS);
makeCombo('wApApp', 'wApAppList', () => APP_ITEMS);
makeCombo('wDbApp', 'wDbAppList', () => APP_ITEMS);

function setLogStatus(text, cls) {
  const el = $('logStatus');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function runLogQuery() {
  const app = $('logApp').value.trim();
  const source = $('logSource').value;
  if (!app) { setLogStatus('请填写服务名', 'error'); return; }
  setLogStatus('查询中…', 'running');
  $('logResult').innerHTML = '<div class="combo-empty">查询中…</div>';
  try {
    const r = await post('/api/logs', {
      source,
      app,
      query: $('logQuery').value.trim(),
      level: $('logLevel').value,
      time: $('logTime').value,
      size: $('logSize').value
    });
    $('logResult').innerHTML = renderLogs(r, source);
    setLogStatus(r.ok ? '完成' : '失败', r.ok ? 'success' : 'error');
  } catch (e) {
    $('logResult').innerHTML = '<div class="warnbox" style="margin:0">' + escHtml(e.message) + '</div>';
    setLogStatus('失败', 'error');
  }
}

function renderLogs(r, source) {
  if (!r.ok) {
    return '<div class="warnbox" style="margin:0">' + escHtml(r.error || r.stderr || r.stdout || '查询失败') + '</div>';
  }
  const j = r.json || {};
  const logs = j.logs || [];
  const meta = source === 'test'
    ? 'Loki 表达式 ' + (j.expr || '-') + ' · 时间窗 ' + (j.timeRange || '-') + ' · 耗时 ' + (j.costMs || '-') + 'ms'
    : '索引 ' + ((j.summary || {}).indexPattern || '-') + ' · 时间窗 ' + ((j.summary || {}).timeRange || '-') + ' · 命中 ' + ((j.summary || {}).totalHits || 0) + ' · 耗时 ' + ((j.summary || {}).totalCostMs || '-') + 'ms';
  let html = '<div class="hint" style="margin:0 0 10px">' + escHtml(meta) + '　|　返回 ' + logs.length + ' 条</div>';
  if (!logs.length) return html + '<div class="combo-empty">无匹配日志</div>';
  html += '<table><thead><tr><th style="width:150px">时间</th><th style="width:60px">级别</th><th>内容</th></tr></thead><tbody>';
  logs.forEach(l => {
    let ts = '-', level = '', text = '';
    if (source === 'test') {
      ts = l.timestamp ? new Date(l.timestamp).toLocaleString('zh-CN') : '-';
      text = (l.line || '').replace(/^.*?stdout F /, '');
      const m = text.match(/\\b(ERROR|WARN|INFO|DEBUG)\\b/);
      level = m ? m[1] : '';
    } else {
      ts = l.timestamp ? String(l.timestamp).replace('T', ' ').slice(0, 23) : '-';
      level = l.logLevel || '';
      text = (l.uri ? '[' + l.uri + '] ' : '') + (l.message || '');
    }
    const lvlCls = level === 'ERROR' ? 'err' : (level === 'WARN' ? 'warn' : '');
    html += '<tr><td class="mono muted">' + escHtml(ts) + '</td>' +
      '<td>' + (level ? '<span class="tag ' + lvlCls + '">' + escHtml(level) + '</span>' : '') + '</td>' +
      '<td class="mono" title="' + escHtml(text) + '">' + escHtml(text.slice(0, 500)) + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

$('btnLogQuery').addEventListener('click', runLogQuery);
$('btnLogError').addEventListener('click', () => { $('logLevel').value = 'ERROR'; runLogQuery(); });

// ============================================================ Apollo Tab ====
function setApStatus(text, cls) {
  const el = $('apStatus');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

$('btnApQuery').addEventListener('click', async () => {
  const app = $('apApp').value.trim();
  if (!app) { setApStatus('请填写服务名', 'error'); return; }
  setApStatus('查询中…', 'running');
  $('apResultTitle').textContent = '配置明细';
  $('apResult').innerHTML = '<div class="combo-empty">查询中…</div>';
  try {
    const r = await post('/api/apollo/query', { app, keyword: $('apKeyword').value.trim(), env: $('apEnv').value });
    $('apResult').innerHTML = renderApolloQuery(r);
    setApStatus(r.ok ? '完成' : '失败', r.ok ? 'success' : 'error');
  } catch (e) {
    $('apResult').innerHTML = '<div class="warnbox" style="margin:0">' + escHtml(e.message) + '</div>';
    setApStatus('失败', 'error');
  }
});

function renderApolloQuery(r) {
  if (!r.ok) return '<div class="warnbox" style="margin:0">' + escHtml(r.error || r.stderr || r.stdout || '查询失败') + '</div>';
  const j = r.json || {};
  const results = j.results || {};
  const namespaces = Object.keys(results);
  let html = '<div class="hint" style="margin:0 0 10px">' + escHtml(j.resolvedAppId || '') + ' · ' + escHtml(j.envLabel || j.env || '') +
    ' · 扫描 ' + (j.totalKeysScanned || 0) + ' 个 key，命中 ' + (j.totalMatched || 0) + ' 个 · 耗时 ' + (j.costMs || '-') + 'ms</div>';
  if (!namespaces.length) return html + '<div class="combo-empty">无匹配配置</div>';
  namespaces.forEach(ns => {
    const kv = results[ns] || {};
    const keys = Object.keys(kv);
    html += '<h2 style="font-size:13px;margin:16px 0 8px">命名空间：' + escHtml(ns) + ' <span class="tag">' + keys.length + ' 项</span></h2>';
    html += '<table><thead><tr><th style="width:38%">Key</th><th>Value</th></tr></thead><tbody>';
    keys.forEach(k => {
      const v = kv[k];
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      html += '<tr><td class="mono">' + escHtml(k) + '</td><td class="mono" title="' + escHtml(s) + '">' + escHtml(s.length > 600 ? s.slice(0, 600) + ' …' : s) + '</td></tr>';
    });
    html += '</tbody></table>';
  });
  return html;
}

$('btnApHistory').addEventListener('click', async () => {
  const app = $('apApp').value.trim();
  const key = $('apHistoryKey').value.trim();
  if (!app) { setApStatus('请填写服务名', 'error'); return; }
  if (!key) { setApStatus('请填写要追溯的配置项 key', 'error'); return; }
  setApStatus('追踪发布轨迹…', 'running');
  $('apResultTitle').textContent = '发布轨迹';
  $('apResult').innerHTML = '<div class="combo-empty">追踪中…</div>';
  try {
    const r = await post('/api/apollo/history', { app, key, env: $('apEnv').value });
    $('apResult').innerHTML = renderApolloHistory(r);
    setApStatus(r.ok ? '完成' : '失败', r.ok ? 'success' : 'error');
  } catch (e) {
    $('apResult').innerHTML = '<div class="warnbox" style="margin:0">' + escHtml(e.message) + '</div>';
    setApStatus('失败', 'error');
  }
});

function renderApolloHistory(r) {
  if (!r.ok) return '<div class="warnbox" style="margin:0">' + escHtml(r.error || r.stderr || r.stdout || '查询失败') + '</div>';
  const j = r.json || {};
  const hist = j.history || [];
  let html = '<div class="hint" style="margin:0 0 10px">' + escHtml(j.appId || '') + ' · ' + escHtml(j.envLabel || j.env || '') +
    ' · 命名空间 ' + escHtml(j.namespace || '-') + ' · 扫描 ' + (j.scannedReleasesCount || 0) + ' 个版本，变更 ' + (j.changesCount || 0) + ' 次</div>';
  const live = j.liveVerifiedValue;
  html += '<div class="okbox" style="margin:0 0 12px">当前实时生效值：<span class="mono">' +
    escHtml(live === null || live === undefined ? '（未在生效配置中）' : String(live)) + '</span></div>';
  if (!hist.length) return html + '<div class="combo-empty">扫描范围内该配置项未发生变更</div>';
  html += '<table><thead><tr><th style="width:120px">类型</th><th style="width:160px">发布时间</th><th style="width:110px">操作人</th><th>变更</th></tr></thead><tbody>';
  hist.forEach(h => {
    const cls = h.type === 'CREATE' ? 'ok' : (h.type === 'DELETE' ? 'err' : 'warn');
    const before = h.oldValue === null || h.oldValue === undefined ? '（无）' : String(h.oldValue);
    const after = h.newValue === null || h.newValue === undefined ? '（无）' : String(h.newValue);
    html += '<tr><td><span class="tag ' + cls + '">' + escHtml(h.typeLabel || h.type) + '</span></td>' +
      '<td class="mono muted">' + escHtml(String(h.releaseTime || '').replace('T', ' ')) + '</td>' +
      '<td>' + escHtml(h.operator || '-') + '</td>' +
      '<td class="mono"><span class="muted">' + escHtml(before.slice(0, 200)) + '</span> → ' + escHtml(after.slice(0, 300)) +
      (h.comment ? '<div class="hint" style="margin-top:4px">备注：' + escHtml(h.comment) + '</div>' : '') + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

// ============================================================ 写操作 Tab ====
let writeOut = '';
function wOut(text) {
  writeOut = text;
  $('wOut').textContent = text;
}
function setWStatus(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function wResult(r, title) {
  $('wOutTitle').textContent = title;
  const parts = [];
  if (r.json) parts.push(JSON.stringify(r.json, null, 2));
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push('--- stderr ---' + String.fromCharCode(10) + r.stderr);
  wOut(parts.filter(Boolean).join(String.fromCharCode(10, 10)) || '（无输出）');
}

$('writeTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-w]');
  if (!b) return;
  document.querySelectorAll('#writeTabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.wsec').forEach(s => { s.style.display = s.id === 'w-' + b.dataset.w ? '' : 'none'; });
});

// ---- Apollo 写 ----
$('wApPre').addEventListener('click', async () => {
  const app = $('wApApp').value.trim(), key = $('wApKey').value.trim(), value = $('wApValue').value;
  if (!app || !key) { setWStatus('wApStatus', '请填写服务名与 key', 'error'); return; }
  if (value === '') { setWStatus('wApStatus', '请填写新的值', 'error'); return; }
  setWStatus('wApStatus', '预检中…', 'running');
  $('wApCommit').disabled = true;
  try {
    const r = await post('/api/write/apollo', {
      app, key, value, namespace: $('wApNs').value.trim(),
      type: $('wApType').value, comment: $('wApComment').value.trim(), confirm: false
    });
    wResult(r, 'Apollo 变更预检');
    if (r.ok) { setWStatus('wApStatus', '预检通过，请核对 Diff 后确认提交', 'success'); $('wApCommit').disabled = false; }
    else setWStatus('wApStatus', '预检失败', 'error');
  } catch (e) {
    wOut(e.message); setWStatus('wApStatus', '预检失败', 'error');
  }
});

$('wApCommit').addEventListener('click', async () => {
  if (!confirm('确认把 Apollo 配置 [' + $('wApKey').value.trim() + '] 写入测试环境并发布？')) return;
  setWStatus('wApStatus', '提交中…', 'running');
  $('wApCommit').disabled = true;
  try {
    const r = await post('/api/write/apollo', {
      app: $('wApApp').value.trim(), key: $('wApKey').value.trim(), value: $('wApValue').value,
      namespace: $('wApNs').value.trim(), type: $('wApType').value,
      comment: $('wApComment').value.trim(), confirm: true
    });
    wResult(r, 'Apollo 变更提交结果');
    setWStatus('wApStatus', r.ok ? '已提交并发布' : '提交失败', r.ok ? 'success' : 'error');
    toast(r.ok ? 'Apollo 配置已发布' : 'Apollo 提交失败', r.ok ? 'ok' : 'err');
  } catch (e) {
    wOut(e.message); setWStatus('wApStatus', '提交失败', 'error');
  }
});

// ---- ES 写 ----
$('wEsPre').addEventListener('click', async () => {
  const svc = $('wEsApp').value.trim(), id = $('wEsId').value.trim(), action = $('wEsAction').value;
  if (!svc || !id) { setWStatus('wEsStatus', '请填写索引与文档 ID', 'error'); return; }
  setWStatus('wEsStatus', '预检中…', 'running');
  $('wEsCommit').disabled = true;
  try {
    const r = await post('/api/write/es', { service: svc, action, id, data: $('wEsData').value.trim(), confirm: false });
    wResult(r, 'ES 变更预检 (Dry-Run Diff)');
    if (r.ok) { setWStatus('wEsStatus', '预检通过，请核对 Diff 后确认提交', 'success'); $('wEsCommit').disabled = false; }
    else setWStatus('wEsStatus', '预检失败', 'error');
  } catch (e) {
    wOut(e.message); setWStatus('wEsStatus', '预检失败', 'error');
  }
});

$('wEsCommit').addEventListener('click', async () => {
  if (!confirm('确认对测试环境 ES 执行 ' + $('wEsAction').value + '（ID: ' + $('wEsId').value.trim() + '）？')) return;
  setWStatus('wEsStatus', '提交中…', 'running');
  $('wEsCommit').disabled = true;
  try {
    const r = await post('/api/write/es', {
      service: $('wEsApp').value.trim(), action: $('wEsAction').value,
      id: $('wEsId').value.trim(), data: $('wEsData').value.trim(), confirm: true
    });
    wResult(r, 'ES 写入结果');
    setWStatus('wEsStatus', r.ok ? '已写入' : '写入失败', r.ok ? 'success' : 'error');
    toast(r.ok ? 'ES 写入完成' : 'ES 写入失败', r.ok ? 'ok' : 'err');
  } catch (e) {
    wOut(e.message); setWStatus('wEsStatus', '写入失败', 'error');
  }
});

// ---- Kafka 投递 ----
function kafkaSets() {
  return $('wKfSets').value.split(String.fromCharCode(10)).map(s => s.trim()).filter(Boolean);
}

$('wKfPre').addEventListener('click', async () => {
  const topic = $('wKfTopic').value.trim();
  if (!topic) { setWStatus('wKfStatus', '请填写 Topic', 'error'); return; }
  setWStatus('wKfStatus', '预检中…', 'running');
  $('wKfCommit').disabled = true;
  try {
    const r = await post('/api/write/kafka', {
      topic, data: $('wKfData').value.trim(), key: $('wKfKey').value.trim(),
      sets: kafkaSets(), confirm: false
    });
    wResult(r, 'Kafka 投递预检');
    if (r.ok) { setWStatus('wKfStatus', '预检通过，请核对消息体后确认投递', 'success'); $('wKfCommit').disabled = false; }
    else setWStatus('wKfStatus', '预检失败', 'error');
  } catch (e) {
    wOut(e.message); setWStatus('wKfStatus', '预检失败', 'error');
  }
});

$('wKfCommit').addEventListener('click', async () => {
  if (!confirm('确认向测试环境 Kafka Topic [' + $('wKfTopic').value.trim() + '] 投递这条消息？')) return;
  setWStatus('wKfStatus', '投递中…', 'running');
  $('wKfCommit').disabled = true;
  try {
    const r = await post('/api/write/kafka', {
      topic: $('wKfTopic').value.trim(), data: $('wKfData').value.trim(),
      key: $('wKfKey').value.trim(), sets: kafkaSets(), confirm: true
    });
    wResult(r, 'Kafka 投递结果');
    setWStatus('wKfStatus', r.ok ? '投递完成' : '投递失败', r.ok ? 'success' : 'error');
    toast(r.ok ? 'Kafka 消息已投递' : 'Kafka 投递失败', r.ok ? 'ok' : 'err');
  } catch (e) {
    wOut(e.message); setWStatus('wKfStatus', '投递失败', 'error');
  }
});

// ---- 测试库 SQL ----
const SQL_READ = /^\\s*(select|show|desc|describe|explain)\\b/i;

$('wDbPre').addEventListener('click', async () => {
  const svc = $('wDbApp').value.trim(), sql = $('wDbSql').value.trim();
  if (!svc || !sql) { setWStatus('wDbStatus', '请填写服务与 SQL', 'error'); return; }
  const isRead = SQL_READ.test(sql);
  setWStatus('wDbStatus', isRead ? '查询中…' : '预检中…', 'running');
  $('wDbCommit').disabled = true;
  try {
    const r = await post('/api/write/mysql', { service: svc, datasource: $('wDbDs').value.trim(), sql, confirm: false });
    wResult(r, isRead ? 'SQL 查询结果' : 'SQL 预检');
    if (isRead) {
      setWStatus('wDbStatus', r.ok ? '查询完成' : '查询失败', r.ok ? 'success' : 'error');
      $('wDbCommit').disabled = true;
    } else if (r.ok) {
      setWStatus('wDbStatus', '预检通过，确认后才会执行写入', 'success');
      $('wDbCommit').disabled = false;
    } else {
      setWStatus('wDbStatus', '预检失败', 'error');
    }
  } catch (e) {
    wOut(e.message); setWStatus('wDbStatus', '预检失败', 'error');
  }
});

$('wDbCommit').addEventListener('click', async () => {
  const sql = $('wDbSql').value.trim();
  if (SQL_READ.test(sql)) { toast('这条是只读语句，已直接执行，无需确认', 'err'); return; }
  if (!confirm('确认在测试库执行这条写入 SQL？' + String.fromCharCode(10, 10) + sql.slice(0, 300))) return;
  setWStatus('wDbStatus', '执行中…', 'running');
  $('wDbCommit').disabled = true;
  try {
    const r = await post('/api/write/mysql', {
      service: $('wDbApp').value.trim(), datasource: $('wDbDs').value.trim(), sql, confirm: true
    });
    wResult(r, 'SQL 执行结果');
    setWStatus('wDbStatus', r.ok ? '执行完成' : '执行失败', r.ok ? 'success' : 'error');
    toast(r.ok ? 'SQL 已执行' : 'SQL 执行失败', r.ok ? 'ok' : 'err');
  } catch (e) {
    wOut(e.message); setWStatus('wDbStatus', '执行失败', 'error');
  }
});

// ================================================================== ONES ====
// 协作系统，不受「生产只读」约束；查询直接返回，写入仍两阶段（预检 → 确认）。

let onesEntered = false;

function onesDate(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function onesWeekRange(offsetWeeks) {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;            // 周一为一周起点
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + offsetWeeks * 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: onesDate(monday), to: onesDate(sunday) };
}

let onesWeekOffset = 0;

function onesOnEnter() {
  if (!onesEntered) {
    onesEntered = true;
    $('onesTabs').querySelector('button[data-o="schedule"]').click();
  }
  if (!$('oSchedFrom').value) onesApplyWeek(0);
}

function onesApplyWeek(offset) {
  onesWeekOffset = offset;
  const r = onesWeekRange(offset);
  $('oSchedFrom').value = r.from;
  $('oSchedTo').value = r.to;
}

function onesOut(html) {
  const el = $('oResult');
  el.innerHTML = html;
}

function onesRaw(obj) {
  const el = $('oRaw');
  if (!obj) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  el.textContent = JSON.stringify(obj, null, 2);
}

function onesStatus(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function onesTable(headers, rows) {
  if (!rows.length) return '<div class="combo-empty">无数据</div>';
  let h = '<table><thead><tr>';
  headers.forEach(x => { h += '<th' + (x.w ? ' style="width:' + x.w + '"' : '') + '>' + escHtml(x.t) + '</th>'; });
  h += '</tr></thead><tbody>';
  rows.forEach(r => {
    h += '<tr>';
    r.forEach(c => { h += '<td>' + (c === null || c === undefined ? '—' : String(c)) + '</td>'; });
    h += '</tr>';
  });
  return h + '</tbody></table>';
}

function onesLink(url, text) {
  if (!url) return escHtml(text || '—');
  return '<a href="' + escHtml(url) + '" target="_blank" rel="noopener">' + escHtml(text || url) + '</a>';
}

// ---- 子页切换 ----
$('onesTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-o]');
  if (!b) return;
  document.querySelectorAll('#onesTabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('#page-ones .osec').forEach(s => {
    s.style.display = s.id === 'o-' + b.dataset.o ? '' : 'none';
  });
});

// ---- 我的排期 ----
// 单次查询要 3~5 秒（要过 ONES 接口）。连点或改完日期马上再点时，晚到的旧响应会覆盖
// 新结果，看起来就像「改了日期没变化」。用递增序号丢弃过期响应。
let onesSchedSeq = 0;
$('oSchedPrev').addEventListener('click', () => { onesApplyWeek(onesWeekOffset - 1); $('oSchedQuery').click(); });
$('oSchedNext').addEventListener('click', () => { onesApplyWeek(onesWeekOffset + 1); $('oSchedQuery').click(); });
$('oSchedQuery').addEventListener('click', async () => {
  const from = $('oSchedFrom').value, to = $('oSchedTo').value;
  if (!from || !to) { onesStatus('oSchedStatus', '请选择起止日期', 'error'); return; }
  const seq = ++onesSchedSeq;
  $('oSchedQuery').disabled = true;
  onesStatus('oSchedStatus', '查询中… ' + from + ' ~ ' + to, 'running');
  try {
    const r = await post('/api/ones/query', { cmd: 'schedule', from, to });
    if (seq !== onesSchedSeq) return;   // 已有更新的一次查询，丢弃本次结果
    if (!r.ok) throw new Error(r.error || '查询失败');
    const d = (r.json && r.json.data) || {};
    const items = d.items || [];
    $('oResultTitle').textContent = '我的排期 · ' + from + ' ~ ' + to;
    if (!items.length) { onesOut('<div class="combo-empty">该时间窗内没有排期（' + from + ' ~ ' + to + '）</div>'); onesStatus('oSchedStatus', '无数据', 'success'); onesRaw(null); return; }

    // 按需求聚合
    const agg = {};
    items.forEach(it => {
      const k = it.requireId;
      if (!agg[k]) agg[k] = { requireId: k, title: it.title, sprintTitle: it.sprintTitle, url: it.url, hours: 0, actions: new Set(), start: it.start, end: it.end };
      agg[k].hours += Number(it.manHours) || 0;
      if (it.action) agg[k].actions.add(it.action);
      if (it.start && (!agg[k].start || it.start < agg[k].start)) agg[k].start = it.start;
      if (it.end && (!agg[k].end || it.end > agg[k].end)) agg[k].end = it.end;
    });
    const aggRows = Object.values(agg).sort((a, b) => b.hours - a.hours);

    let html = '<div class="hint" style="margin:0 0 10px">共 ' + items.length + ' 条估时 / ' + aggRows.length + ' 个需求</div>';
    html += onesTable(
      [{ t: '需求 ID', w: '90px' }, { t: '迭代', w: '130px' }, { t: '角色' }, { t: '动作' }, { t: '工期', w: '180px' }, { t: '人天', w: '60px' }, { t: '需求标题' }],
      items.map(it => [
        onesLink(it.url, it.requireId),
        escHtml(it.sprintTitle || '—'),
        escHtml(it.role || '—'),
        escHtml(it.action || '—'),
        escHtml((it.start || '—') + ' ~ ' + (it.end || '—')),
        escHtml(it.manHours),
        escHtml(it.title || '')
      ])
    );
    html += '<h2 style="margin:22px 0 10px">按需求汇总</h2>';
    html += onesTable(
      [{ t: '需求 ID', w: '90px' }, { t: '迭代', w: '130px' }, { t: '窗口', w: '180px' }, { t: '总人天', w: '70px' }, { t: '动作' }, { t: '需求标题' }],
      aggRows.map(a => [
        onesLink(a.url, a.requireId),
        escHtml(a.sprintTitle || '—'),
        escHtml((a.start || '—') + ' ~ ' + (a.end || '—')),
        escHtml(a.hours),
        escHtml([...a.actions].join(' / ')),
        escHtml(a.title || '')
      ])
    );
    onesOut(html);
    onesRaw(r.json);
    onesStatus('oSchedStatus', '完成', 'success');
  } catch (e) {
    if (seq !== onesSchedSeq) return;
    onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
    onesStatus('oSchedStatus', '失败', 'error');
  } finally {
    if (seq === onesSchedSeq) $('oSchedQuery').disabled = false;
  }
});

// ---- 需求详情 ----
$('oReqQuery').addEventListener('click', async () => {
  const key = $('oReqKey').value.trim();
  if (!key) { onesStatus('oReqStatus', '请输入需求 ID 或关键词', 'error'); return; }
  onesStatus('oReqStatus', '查询中…', 'running');
  try {
    const r = await post('/api/ones/query', { cmd: 'req', key });
    if (!r.ok) throw new Error(r.error || '查询失败');
    const d = (r.json && r.json.data) || {};
    const q = d.requirement || {};
    const sc = d.schedule || {};
    const est = (d.estimates && d.estimates.estimates) || [];
    const bugs = d.bugs || [];
    $('oResultTitle').textContent = '需求 ' + (q.id || '') + (q.title ? ' · ' + q.title : '');

    const info = [
      ['状态', q.status], ['优先级', q.priority], ['类型', (q.type || '—') + ' / ' + (q.label || '—')],
      ['迭代', (q.sprintTitle || '—') + (q.sprintId ? ' (' + q.sprintId + ')' : '')],
      ['层级', [q.level && q.level.businessDirection, q.level && q.level.businessLine, q.level && q.level.system, q.level && q.level.subSystem].filter(Boolean).join(' / ') || '—'],
      ['产品经理', (q.pm || []).join('、') || '—'],
      ['RD / QA / FE', [(q.rd || []).join('、'), (q.qa || []).join('、'), (q.fe || []).join('、')].map(x => x || '—').join(' / ')],
      ['链接', onesLink(q.url, q.url)]
    ];
    let html = '<table><tbody>';
    info.forEach(([k, v]) => { html += '<tr><th style="width:130px">' + escHtml(k) + '</th><td>' + (k === '链接' ? v : escHtml(v)) + '</td></tr>'; });
    html += '</tbody></table>';

    html += '<h2 style="margin:22px 0 10px">排期</h2>';
    html += onesTable([{ t: '阶段' }, { t: '时间' }], [
      ['开发', (sc.developStart || '—') + ' ~ ' + (sc.developEnd || '—')],
      ['测试', (sc.testStart || '—') + ' ~ ' + (sc.testEnd || '—')],
      ['计划提测', sc.submitTest || '—'],
      ['计划上线', sc.online || '—'],
      ['实际提测', sc.realSubmitTest || '—'],
      ['实际上线', sc.realOnline || '—']
    ]);

    if (est.length) {
      html += '<h2 style="margin:22px 0 10px">估时明细（' + est.length + ' 条）</h2>';
      html += onesTable([{ t: '角色' }, { t: '成员' }, { t: '动作' }, { t: '人天' }, { t: '起止' }, { t: '完成' }],
        est.map(e => [escHtml(e.role || '—'), escHtml(e.member || '—'), escHtml(e.action || '—'), escHtml(e.manHours), escHtml((e.start || '—') + ' ~ ' + (e.end || '—')), e.finished ? '✅' : '—']));
    }

    if (bugs.length) {
      html += '<h2 style="margin:22px 0 10px">关联缺陷（' + bugs.length + ' 条）</h2>';
      html += onesTable([{ t: 'ID', w: '90px' }, { t: '状态' }, { t: '优先级' }, { t: '处理人' }, { t: '标题' }],
        bugs.map(b => [onesLink(b.url, b.id), escHtml(b.status || '—'), escHtml(b.priority || '—'), escHtml(b.resolver || '—'), escHtml(b.summary || '')]));
    }

    const tr = q.transitions || [];
    if (tr.length) {
      html += '<h2 style="margin:22px 0 10px">当前可流转事件</h2>';
      html += onesTable([{ t: '事件' }, { t: '目标状态' }, { t: '类型' }],
        tr.map(t => [escHtml(t.event), escHtml(t.target || '—'), escHtml(t.type || '—')]));
    }

    onesOut(html);
    onesRaw(r.json);
    onesStatus('oReqStatus', '完成', 'success');
  } catch (e) {
    onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
    onesStatus('oReqStatus', '失败', 'error');
  }
});

// ---- 需求检索 ----
$('oReqsQuery').addEventListener('click', async () => {
  const body = {
    cmd: 'reqs',
    sprint: $('oReqsSprint').value.trim(),
    pm: $('oReqsPm').value.trim(),
    title: $('oReqsTitle').value.trim(),
    level: $('oReqsLevel').value.trim(),
    limit: 50
  };
  if (!body.sprint && !body.pm && !body.title && !body.level) {
    onesStatus('oReqsStatus', '至少填一个过滤条件', 'error'); return;
  }
  onesStatus('oReqsStatus', '查询中…', 'running');
  try {
    const r = await post('/api/ones/query', body);
    if (!r.ok) throw new Error(r.error || '查询失败');
    const d = (r.json && r.json.data) || {};
    const items = d.items || [];
    $('oResultTitle').textContent = '需求检索（命中 ' + (d.total || items.length) + ' 条，展示 ' + items.length + ' 条）';
    onesOut(onesTable(
      [{ t: 'ID', w: '90px' }, { t: '状态' }, { t: '优先级' }, { t: '迭代', w: '130px' }, { t: 'PM' }, { t: '标题' }],
      items.map(it => [
        onesLink(it.url, it.id),
        escHtml(it.status || '—'),
        escHtml(it.priority || '—'),
        escHtml(it.sprintTitle || '—'),
        escHtml((it.pm || []).join('、') || '—'),
        escHtml(it.title || '')
      ])
    ));
    onesRaw(r.json);
    onesStatus('oReqsStatus', '完成', 'success');
  } catch (e) {
    onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
    onesStatus('oReqsStatus', '失败', 'error');
  }
});

// ---- 缺陷检索 ----
$('oBugsQuery').addEventListener('click', async () => {
  const body = {
    cmd: 'bugs',
    id: $('oBugsId').value.trim(),
    resolver: $('oBugsResolver').value.trim(),
    summary: $('oBugsSummary').value.trim(),
    requireId: $('oBugsReq').value.trim(),
    limit: Number($('oBugsLimit').value) || 10
  };
  onesStatus('oBugsStatus', '查询中…', 'running');
  try {
    const r = await post('/api/ones/query', body);
    if (!r.ok) throw new Error(r.error || '查询失败');
    const d = (r.json && r.json.data) || {};
    const items = d.items || [];
    $('oResultTitle').textContent = '缺陷检索（命中 ' + (d.total || items.length) + ' 条，展示 ' + items.length + ' 条）';
    onesOut(onesTable(
      [{ t: 'ID', w: '90px' }, { t: '状态' }, { t: '优先级' }, { t: '类型' }, { t: '处理人' }, { t: '关联需求' }, { t: '标题' }],
      items.map(it => [
        onesLink(it.url, it.id),
        escHtml(it.status || '—'),
        escHtml(it.priority || '—'),
        escHtml(it.category || '—'),
        escHtml(it.resolver || '—'),
        it.requireId ? onesLink('https://ones.ke.com/project/requirement/' + it.requireId, it.requireId) : '—',
        escHtml(it.summary || '')
      ])
    ));
    onesRaw(r.json);
    onesStatus('oBugsStatus', '完成', 'success');
  } catch (e) {
    onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
    onesStatus('oBugsStatus', '失败', 'error');
  }
});

// ---- 迭代 / 项目 ----
$('oMetaQuery').addEventListener('click', async () => {
  onesStatus('oMetaStatus', '查询中…', 'running');
  try {
    const [ri, rp] = await Promise.all([
      post('/api/ones/query', { cmd: 'iterations', keyword: $('oMetaIter').value.trim() }),
      post('/api/ones/query', { cmd: 'projects', keyword: $('oMetaProj').value.trim() })
    ]);
    const iters = (ri.json && ri.json.data && ri.json.data.items) || [];
    const projs = (rp.json && rp.json.data && rp.json.data.items) || [];
    $('oResultTitle').textContent = '迭代 / 项目';
    let html = '<h2 style="margin:0 0 10px">迭代（' + iters.length + '）</h2>';
    html += onesTable([{ t: 'ID', w: '100px' }, { t: '状态' }, { t: '标题' }],
      iters.map(i => [onesLink(i.url, i.id), escHtml(i.statusLabel || '—'), escHtml(i.title || '')]));
    html += '<h2 style="margin:22px 0 10px">项目（' + projs.length + '）</h2>';
    html += onesTable([{ t: 'm_project_id', w: '110px' }, { t: 'ID' }, { t: '状态' }, { t: '标题' }],
      projs.map(p => [escHtml(p.mProjectId), onesLink(p.url, p.id), escHtml(p.status || '—'), escHtml(p.title || '')]));
    onesOut(html);
    onesRaw({ iterations: ri.json, projects: rp.json });
    onesStatus('oMetaStatus', '完成', 'success');
  } catch (e) {
    onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
    onesStatus('oMetaStatus', '失败', 'error');
  }
});

// ---- 写入子页切换 ----
$('onesWriteTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-ow]');
  if (!b) return;
  document.querySelectorAll('#onesWriteTabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('#o-write .wsec2').forEach(s => {
    s.style.display = s.id === 'ow-' + b.dataset.ow ? '' : 'none';
  });
});

// 统一的 ONES 写入执行：pre = 预检按钮 id，commit = 确认按钮 id，status = 状态 id
function onesWrite({ cmd, payload, pre, commit, status, title }) {
  const run = async (confirm) => {
    const b = typeof payload === 'function' ? payload() : payload;
    if (b === null) return;
    onesStatus(status, confirm ? '提交中…' : '预检中…', 'running');
    $(commit).disabled = true;
    try {
      const r = await post('/api/ones/write', { cmd, ...b, confirm });
      const out = (r.stdout || '').trim() || (r.error || '');
      $('oResultTitle').textContent = title + (confirm ? ' · 提交结果' : ' · 预检');
      onesOut('<pre class="out" style="margin:0">' + escHtml(out) + '</pre>');
      onesRaw(r.json);
      if (!r.ok) {
        onesStatus(status, confirm ? '提交失败' : '预检失败', 'error');
        // 预检失败时也要解锁，方便改参数重试
        $(commit).disabled = true;
        return;
      }
      if (confirm) {
        onesStatus(status, '已提交', 'success');
        toast('已提交到 ONES', 'ok');
      } else {
        onesStatus(status, '预检完成，请核对上面的预审单', 'success');
        $(commit).disabled = false;
      }
    } catch (e) {
      onesOut('<div class="combo-empty">' + escHtml(e.message) + '</div>');
      onesStatus(status, '失败', 'error');
      $(commit).disabled = true;
    }
  };
  $(pre).addEventListener('click', () => run(false));
  $(commit).addEventListener('click', () => run(true));
}

onesWrite({
  cmd: 'create-req', pre: 'owReqPre', commit: 'owReqCommit', status: 'owReqStatus', title: '新建需求',
  payload: () => ({
    title: $('owReqTitle').value.trim(), level: $('owReqLevel').value.trim(),
    project: $('owReqProject').value.trim(), pm: $('owReqPm').value.trim(),
    sprint: $('owReqSprint').value.trim(), priority: $('owReqPriority').value,
    type: $('owReqType').value, desc: $('owReqDesc').value.trim(),
    withSafetyFunc: $('owReqSafety').checked
  })
});

onesWrite({
  cmd: 'create-bug', pre: 'owBugPre', commit: 'owBugCommit', status: 'owBugStatus', title: '新建缺陷',
  payload: () => ({
    summary: $('owBugSummary').value.trim(), resolver: $('owBugResolver').value.trim(),
    requireId: $('owBugReq').value.trim(), priority: $('owBugPriority').value,
    type: $('owBugType').value, findWay: $('owBugFindWay').value,
    manHour: $('owBugHours').value.trim(), level: $('owBugLevel').value.trim(),
    desc: $('owBugDesc').value.trim()
  })
});

onesWrite({
  cmd: 'schedule', pre: 'owSchedPre', commit: 'owSchedCommit', status: 'owSchedStatus', title: '调整排期',
  payload: () => ({
    id: $('owSchedId').value.trim(), online: $('owSchedOnline').value.trim(),
    developStart: $('owSchedDevStart').value.trim(), developEnd: $('owSchedDevEnd').value.trim(),
    testStart: $('owSchedTestStart').value.trim(), testEnd: $('owSchedTestEnd').value.trim(),
    submitTest: $('owSchedSubmitTest').value.trim()
  })
});

onesWrite({
  cmd: 'move', pre: 'owMovePre', commit: 'owMoveCommit', status: 'owMoveStatus', title: '移入迭代',
  payload: () => ({ ids: $('owMoveIds').value.trim(), sprint: $('owMoveSprint').value.trim() })
});

onesWrite({
  cmd: 'advance', pre: 'owAdvPre', commit: 'owAdvCommit', status: 'owAdvStatus', title: '状态流转',
  payload: () => ({
    id: $('owAdvId').value.trim(), event: $('owAdvEvent').value.trim(),
    kind: $('owAdvKind').value
  })
});

// ============================================================== credentials ====
// 凭据台账：只渲染元信息（有无 / 更新时间 / cookie 名），cookie 值永不出后端
let credItems = [];
let credBusy = {};
let credProbe = {};
let credDir = '~/.shrimp/skills/live-inspector/';
let credLoading = false;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  let ago;
  if (mins < 1) ago = '刚刚';
  else if (mins < 60) ago = mins + ' 分钟前';
  else if (mins < 1440) ago = Math.floor(mins / 60) + ' 小时前';
  else ago = Math.floor(mins / 1440) + ' 天前';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + ago;
}

// 凭据台账专用的两行时间：绝对时间一行、相对时间一行，避免单行撑破列宽
function fmtTimeParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { abs: String(iso), rel: '' };
  const pad = n => String(n).padStart(2, '0');
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  let rel;
  if (mins < 1) rel = '刚刚';
  else if (mins < 60) rel = mins + ' 分钟前';
  else if (mins < 1440) rel = Math.floor(mins / 60) + ' 小时前';
  else rel = Math.floor(mins / 1440) + ' 天前';
  return { abs: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), rel };
}

function setCredStatus(text, cls) {
  const el = $('credStatus');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function renderCredentials() {
  const body = $('credBody');
  if (!credItems.length) { body.className = 'muted'; body.textContent = '暂无凭据登记'; return; }
  body.className = '';
  const byGroup = new Map();
  for (const it of credItems) {
    if (!byGroup.has(it.group)) byGroup.set(it.group, []);
    byGroup.get(it.group).push(it);
  }
  let html = '';
  for (const [group, items] of byGroup) {
    html += '<h3 style="font-size:13px;margin:4px 0 8px;color:var(--muted);font-weight:600">' + escHtml(group) + '</h3>' +
      '<table class="cred" style="margin-bottom:20px"><thead><tr><th style="width:20%">平台</th><th style="width:27%">凭据文件</th>' +
      '<th style="width:9%">状态</th><th style="width:11%">上次更新</th><th style="width:33%">操作</th></tr></thead><tbody>';
    for (const it of items) {
      const busy = credBusy[it.id];
      const dot = it.exists ? '<span class="tag ok">已保存</span>' : '<span class="tag err">缺失</span>';
      const envTip = it.envOverride ? '<span class="tag warn" title="环境变量优先于本地文件">ENV 覆盖</span>' : '';
      const pr = credProbe[it.id];
      const probeTag = !pr ? '' : (pr.busy ? ' <span class="tag">探活中…</span>'
        : (pr.ok ? ' <span class="tag ok" title="' + escHtml(pr.message) + '">登录态正常</span>'
          : ' <span class="tag err" title="' + escHtml(pr.message) + '">需重新登录</span>'));
      // 十几个 cookie 名排成一行必然撑爆表格，改单行省略：数量打头 + 前两个名字示意，完整清单放悬停提示
      const allNames = it.names || [];
      const preview = allNames.slice(0, 2).join(', ');
      const names = allNames.length
        ? '<div class="cred-line mono muted" title="' + escHtml(allNames.join(', ')) + '">' +
          '<b>' + allNames.length + ' 个</b> · ' + escHtml(preview) + (allNames.length > 2 ? ' …' : '') + '</div>'
        : '';
      html += '<tr><td><b>' + escHtml(it.label) + '</b>' +
        (it.url ? '<div class="mono muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escHtml(it.url) + '">' + escHtml(it.url) + '</div>' : '') +
        (it.note ? '<div class="hint" style="margin-top:4px">' + escHtml(it.note) + '</div>' : '') + '</td>' +
        '<td class="mono">' + escHtml(it.file) + (it.kind === 'apikey' ? ' <span class="tag">API Key</span>' : '') + names + '</td>' +
        '<td>' + dot + probeTag + ' ' + envTip + '</td>' +
        '<td class="hint" style="margin:0">' + (() => {
          const t = fmtTimeParts(it.updatedAt);
          return t ? escHtml(t.abs) + (t.rel ? '<div style="font-size:11px">' + escHtml(t.rel) + '</div>' : '') : '—';
        })() + '</td>' +
        '<td><div class="cred-ops">' +
        (it.probeSupported ? '<button class="sm" data-cred-probe="' + it.id + '"' + (busy ? ' disabled' : '') + '>探活</button>' : '') +
        (it.kind === 'apikey' ? '' :
          '<button class="sm" data-cred-refresh="' + it.id + '"' + (busy ? ' disabled' : '') + '>' + (busy ? '等待中…' : '刷新') + '</button>' +
          '<button class="sm ghost" data-cred-open="' + it.id + '" title="在 Chrome 打开站点登录页，不写入凭据">登录页</button>') +
        '<button class="sm ghost" data-cred-save="' + it.id + '" title="手动粘贴 Cookie / cookies.txt / JSON">粘贴</button>' +
        '<button class="sm ghost" data-cred-clear="' + it.id + '"' + (it.exists ? '' : ' disabled') + '>清除</button>' +
        '</div></td></tr>';
    }
    html += '</tbody></table>';
  }
  html += '<div class="hint">凭据目录：<code>' + escHtml(credDir) + '</code>　·　值为空说明浏览器里没读到该站点登录态。</div>';
  body.innerHTML = html;
}

async function loadCredentials() {
  if (credLoading) return;
  credLoading = true;
  setCredStatus('扫描中…', 'running');
  try {
    const r = await api('/api/credential-list');
    credItems = r.items || [];
    credDir = r.dir || credDir;
    $('credDir').textContent = credDir;
    renderCredentials();
    const missing = credItems.filter(x => !x.exists).length;
    setCredStatus(missing ? missing + ' 项缺失 / ' + credItems.length + ' 项 · 刷新即自动落盘' : '全部已保存', missing ? 'running' : 'success');
  } catch (e) {
    setCredStatus('扫描失败: ' + e.message, 'error');
  } finally {
    credLoading = false;
  }
}

function patchCred(def) {
  if (!def) return;
  const i = credItems.findIndex(x => x.id === def.id);
  if (i >= 0) credItems[i] = def;
  renderCredentials();
}

async function refreshOne(id) {
  if (credBusy[id]) return;
  const it = credItems.find(x => x.id === id);
  credBusy[id] = true;
  delete credProbe[id];
  renderCredentials();
  setCredStatus('正在读取 ' + (it ? it.label : id) + ' 的登录态…', 'running');
  try {
    const r = await post('/api/credential/refresh', { id, waitMs: Number($('credWait').value) || 120000 });
    patchCred(r.def);
    if (r.ok) {
      setCredStatus((it ? it.label : id) + ' 已刷新：' + r.message, 'success');
      toast('凭据已刷新', 'ok');
    } else {
      setCredStatus((it ? it.label : id) + ' 未刷新：' + r.message, 'running');
      toast(r.message, 'err');
    }
  } catch (e) {
    setCredStatus('刷新失败: ' + e.message, 'error');
    toast(e.message, 'err');
  } finally {
    credBusy[id] = false;
    renderCredentials();
  }
}

$('credReload').addEventListener('click', loadCredentials);

$('credRefreshAll').addEventListener('click', async () => {
  const targets = credItems.filter(x => x.exists && x.kind !== 'apikey').map(x => x.id);
  if (!targets.length) { toast('没有已保存的 Cookie 凭据可刷新', 'err'); return; }
  if (!confirm('将依次刷新 ' + targets.length + ' 个站点的登录态，过程中 Chrome 会不断打开页面，确认继续？')) return;
  for (const id of targets) await refreshOne(id);
  setCredStatus('批量刷新完成', 'success');
});

$('credBody').addEventListener('click', async e => {
  const probe = e.target.closest('[data-cred-probe]');
  if (probe) {
    const id = probe.dataset.credProbe;
    credProbe[id] = { busy: true };
    renderCredentials();
    try {
      const r = await post('/api/credential/probe', { id });
      credProbe[id] = { ok: Boolean(r.ok), message: r.message || '' };
      toast((r.ok ? '✅ ' : '❌ ') + (r.message || ''), r.ok ? 'ok' : 'err');
    } catch (err) {
      credProbe[id] = { ok: false, message: err.message };
      toast(err.message, 'err');
    }
    renderCredentials();
    return;
  }
  const refresh = e.target.closest('[data-cred-refresh]');
  if (refresh) return refreshOne(refresh.dataset.credRefresh);

  const open = e.target.closest('[data-cred-open]');
  if (open) {
    const id = open.dataset.credOpen;
    const it = credItems.find(x => x.id === id) || {};
    setCredStatus('正在打开 ' + (it.label || id) + ' …', 'running');
    try {
      const r = await post('/api/credential/open', { id });
      if (r.ok) {
        setCredStatus('已在浏览器标签页打开 ' + (r.url || it.url || id) + '，请完成登录后点「刷新」', 'success');
        toast('已打开登录页', 'ok');
      } else {
        setCredStatus('打开失败: ' + (r.message || ''), 'error');
        toast(r.message || '打开失败', 'err');
      }
    } catch (err) { setCredStatus('打开失败: ' + err.message, 'error'); }
    return;
  }

  const save = e.target.closest('[data-cred-save]');
  if (save) {
    const id = save.dataset.credSave;
    const it = credItems.find(x => x.id === id) || {};
    const label = it.label || id;
    const tip = it.kind === 'apikey'
      ? '粘贴 ARMS API Key：'
      : '粘贴 ' + label + ' 的凭据（Cookie 头 / cookies.txt / JSON 均可）：';
    const value = prompt(tip + String.fromCharCode(10) + '注意：内容只写入本机文件，不会经过网络。', '');
    if (value === null || !value.trim()) return;
    try {
      const r = await post('/api/credential/save', { id, value });
      patchCred(r.def);
      toast('已保存', 'ok');
      setCredStatus(label + ' ' + (r.message || '已保存'), 'success');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const clear = e.target.closest('[data-cred-clear]');
  if (clear) {
    const id = clear.dataset.credClear;
    const it = credItems.find(x => x.id === id) || {};
    if (!confirm('确定清除本机凭据文件 ' + (it.file || id) + '？清除后相关功能会提示未登录。')) return;
    try {
      const r = await post('/api/credential/clear', { id });
      patchCred(r.def);
      toast('已清除', 'ok');
      setCredStatus((it.label || id) + ' ' + (r.message || '已清除'), 'success');
    } catch (err) { toast(err.message, 'err'); }
  }
});

// ================================================================== init ====
async function init() {
  try {
    // 地址栏 hash 优先于上次记忆：/ 或 #home 也能显式回首页
    const hash = (location.hash || '').replace(/^#/, '');
    const saved = hash || localStorage.getItem('leo.tab');
    if (saved) showTab(saved);
  } catch (e) {}
  window.addEventListener('hashchange', () => {
    const name = (location.hash || '').replace(/^#/, '');
    if (name) showTab(name);
  });
  try {
    const data = await api('/api/initial');
    if (data.lastProject) {
      $('project').value = data.lastProject;
      currentProject = data.lastProject;
      await loadState(currentProject);
    }
  } catch (e) {}
  refreshCredentialStatus();
  loadJobs();
  // 恢复最近一次任务日志（服务重启后仍可回看失败原因）
  try {
    const { jobs } = await api('/api/jobs');
    if (jobs && jobs.length) {
      const last = jobs[0];
      lastJobId = last.id;
      const job = await api('/api/job?id=' + encodeURIComponent(last.id));
      $('log').textContent = '最近任务 [' + last.project + '] ' + last.devBranch + ' → ' + last.qaBranch + ' (' + (last.modeLabel || last.mode) + ') · ' + last.status + String.fromCharCode(10, 10) + (job.log || '');
      // 恢复历史日志后重置为跟随并贴底，便于直接看到最新进度
      logStick = true;
      updateFollowHint();
      $('log').scrollTop = $('log').scrollHeight;
      setStatus(last.status === 'success' ? '上次执行成功' : (last.status === 'running' ? '上次任务仍在执行' : '上次执行失败'), last.status === 'success' ? 'success' : (last.status === 'running' ? 'running' : 'error'));
    }
  } catch (e) {}
}
init();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = url.pathname;

    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = buildPage(listProjects(), listAppItems());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && route === '/api/initial') {
      const lastProject = state.lastProject || Object.keys(state.branches)[0] || '';
      // buildId 让启动器能判断这个进程跑的是不是当前磁盘上的代码
      return json(res, 200, { lastProject, buildId: BUILD_ID, pid: process.pid });
    }

    if (req.method === 'GET' && route === '/api/apps') {
      return json(res, 200, { apps: listAppItems() });
    }

    if (req.method === 'GET' && route === '/api/projects') {
      return json(res, 200, { projects: listProjects() });
    }

    if (req.method === 'GET' && route === '/api/state') {
      const project = url.searchParams.get('project') || '';
      lastCloneError = null;
      const repoPath = await detectRepo(project);
      const branches = repoPath ? await listBranches(repoPath).catch(() => []) : [];
      const remembered = state.branches[project] || {};
      const cur = repoPath ? await currentBranch(repoPath) : '';
      const gitUrl = registeredGitUrl(project);
      const repoMode = state.repos[project] ? 'manual' : (gitUrl ? 'clone' : 'local');
      // 测试环境实际使用最新的 qa-YYYY-MM 分支；记忆值优先
      const monthly = branches.filter(b => monthlyKey(b)).sort((a, b) => monthlyKey(b) - monthlyKey(a));
      const qaDefault = remembered.qaBranch || monthly[0] || branches.find(b => /^qa$/i.test(b)) || branches.find(b => /^qa[-_]/i.test(b)) || '';
      const curUsable = cur && !/^(master|main)$/i.test(cur) ? cur : '';
      const devDefault = remembered.devBranch || curUsable || (repoPath ? await latestRemoteBranch(repoPath) : '') || '';
      return json(res, 200, {
        project,
        repoPath,
        gitUrl,
        repoMode,
        cloneError: lastCloneError,
        currentBranch: cur,
        devBranch: devDefault,
        qaBranch: qaDefault,
        branches
      });
    }

    if (req.method === 'POST' && route === '/api/state') {
      const body = await readBody(req);
      const project = (body.project || '').trim();
      if (!project) return json(res, 400, { error: '缺少 project' });
      state.branches[project] = {
        devBranch: (body.devBranch || '').trim(),
        qaBranch: (body.qaBranch || '').trim()
      };
      state.lastProject = project;
      saveState(state);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/api/repo') {
      const body = await readBody(req);
      const project = (body.project || '').trim();
      const repoPath = (body.path || '').trim();
      if (!project) return json(res, 400, { error: '缺少 project' });
      if (!repoPath) {
        delete state.repos[project];
        saveState(state);
        return json(res, 200, { ok: true, repoPath: await detectRepo(project) });
      }
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        return json(res, 400, { error: '该路径不是有效的 Git 仓库（缺少 .git）' });
      }
      state.repos[project] = repoPath;
      saveState(state);
      branchCache.delete(repoPath);
      return json(res, 200, { ok: true, repoPath });
    }

    if (req.method === 'GET' && route === '/api/branches') {
      const project = url.searchParams.get('project') || '';
      const force = url.searchParams.get('force') === '1';
      const repoPath = await detectRepo(project);
      if (!repoPath) return json(res, 200, { project, repoPath: null, branches: [] });
      const branches = await listBranches(repoPath, force);
      return json(res, 200, { project, repoPath, branches });
    }

    if (req.method === 'POST' && route === '/api/deploy') {
      const body = await readBody(req);
      const project = (body.project || '').trim();
      const devBranch = (body.devBranch || '').trim();
      const qaBranch = (body.qaBranch || '').trim();
      const mode = body.mode || 'merge_deploy';
      const conflict = body.conflict || 'strict';

      if (project) {
        state.branches[project] = { devBranch, qaBranch };
        state.lastProject = project;
        saveState(state);
      }
      const job = await startJob({ project, devBranch, qaBranch, mode, conflict });
      return json(res, 200, { id: job.id, status: job.status });
    }

    if (req.method === 'GET' && route === '/api/jobs') {
      return json(res, 200, { jobs: listPersistedJobs() });
    }

    if (req.method === 'GET' && route === '/api/credential-list') {
      return json(res, 200, listCredentials());
    }

    if (req.method === 'POST' && route === '/api/credential/open') {
      const b = await readBody(req);
      return json(res, 200, await openCredentialSite({ id: b.id }));
    }

    if (req.method === 'POST' && route === '/api/credential/refresh') {
      const b = await readBody(req);
      const r = await refreshCredential({ id: b.id, waitMs: b.waitMs });
      return json(res, 200, r);
    }

    if (req.method === 'POST' && route === '/api/credential/save') {
      const b = await readBody(req);
      return json(res, 200, saveCredentialManually({ id: b.id, value: b.value }));
    }

    if (req.method === 'POST' && route === '/api/credential/clear') {
      const b = await readBody(req);
      return json(res, 200, clearCredential({ id: b.id }));
    }

    if (req.method === 'POST' && route === '/api/credential/probe') {
      const b = await readBody(req);
      return json(res, 200, await probeCredentialById({ id: b.id }));
    }

    if (req.method === 'GET' && route === '/api/credentials') {
      return json(res, 200, await checkCredentials());
    }

    if (req.method === 'GET' && route === '/api/job') {
      const id = url.searchParams.get('id');
      const job = jobs.get(id) || loadPersistedJob(id);
      if (!job) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, {
        id: job.id,
        project: job.project,
        devBranch: job.devBranch,
        qaBranch: job.qaBranch,
        mode: job.mode,
        conflictStrategy: job.conflictStrategy,
        status: job.status,
        log: job.log,
        error: job.error,
        result: job.result,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
      });
    }

    // ---------------------------------------------------------- 部署后验活 ----
    // 部署成功后在测试环境容器日志里抓 ERROR，回答「这次部署服务活没活」
    if (req.method === 'POST' && route === '/api/verify') {
      const b = await readBody(req);
      const project = (b.project || '').trim();
      const minutes = (b.minutes || '10m').trim();
      if (!project) return json(res, 400, { error: '缺少 project' });
      if (!/^\d{1,3}[mh]$/.test(minutes)) return json(res, 400, { error: '时间窗格式应为 15m / 1h' });
      const r = await runScript(SCRIPTS.testLog, [project, '--level', 'ERROR', '-t', minutes, '-n', '30', '--format', 'json']);
      return scriptResult(res, r);
    }

    // ------------------------------------------------------------ 日志检索 ----
    if (req.method === 'POST' && route === '/api/logs') {
      const b = await readBody(req);
      const source = b.source === 'prod' ? 'prod' : 'test';
      const app = (b.app || '').trim();
      if (!app) return json(res, 400, { error: '缺少服务名' });
      const time = (b.time || '1h').trim();
      if (!/^\d{1,3}[mhd]$/.test(time)) return json(res, 400, { error: '时间窗格式应为 15m / 1h / 7d' });
      const size = String(Math.min(Math.max(parseInt(b.size, 10) || 20, 1), 200));
      const level = (b.level || '').toUpperCase();
      const query = (b.query || '').trim();

      if (source === 'test') {
        if (level && !['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level)) return json(res, 400, { error: '日志级别不合法' });
        const args = [app, '-t', time, '-n', size, '--format', 'json'];
        if (level) args.push('--level', level);
        if (query) args.push('-q', query);
        return scriptResult(res, await runScript(SCRIPTS.testLog, args));
      }
      // 生产环境：FAST/Kibana 严格只读，不带任何写参数
      if (level && !['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level)) return json(res, 400, { error: '日志级别不合法' });
      const args = ['-a', app, '-t', time, '-n', size, '--format', 'json', '-e', 'prod'];
      if (level) args.push('--level', level);
      if (query) args.push('-q', query);
      return scriptResult(res, await runScript(SCRIPTS.fastLog, args));
    }

    // ---------------------------------------------------------- Apollo 只读 ----
    if (req.method === 'POST' && route === '/api/apollo/query') {
      const b = await readBody(req);
      const app = (b.app || '').trim();
      const env = (b.env || 'test').toLowerCase();
      if (!app) return json(res, 400, { error: '缺少服务名' });
      if (!['test', 'preview', 'pre', 'prod'].includes(env)) return json(res, 400, { error: '环境不合法' });
      const keyword = (b.keyword || '').trim();
      const args = [app];
      if (keyword) args.push(keyword);
      args.push('-e', env, '--json');
      return scriptResult(res, await runScript(SCRIPTS.apolloQuery, args));
    }

    if (req.method === 'POST' && route === '/api/apollo/history') {
      const b = await readBody(req);
      const app = (b.app || '').trim();
      const key = (b.key || '').trim();
      const env = (b.env || 'test').toLowerCase();
      if (!app || !key) return json(res, 400, { error: '缺少服务名或配置项 key' });
      if (!['test', 'preview', 'pre', 'prod'].includes(env)) return json(res, 400, { error: '环境不合法' });
      return scriptResult(res, await runScript(SCRIPTS.apolloHistory, [app, key, '-e', env, '--json']));
    }

    // -------------------------------------------------------------- 写操作 ----
    // 统一契约：confirm=false 只做预检，confirm=true 才真正写入。
    // 每个分支都硬钉测试环境，不接受前端传入其他环境。
    if (req.method === 'POST' && route === '/api/write/apollo') {
      const b = await readBody(req);
      const app = (b.app || '').trim();
      const key = (b.key || '').trim();
      const value = b.value === undefined || b.value === null ? '' : String(b.value);
      if (!app || !key) return json(res, 400, { error: '缺少服务名或配置项 key' });
      if (value === '') return json(res, 400, { error: '缺少新的值' });
      const type = ['switch', 'change', 'degrade'].includes(b.type) ? b.type : 'switch';
      const args = [app];
      const ns = (b.namespace || '').trim();
      if (ns) args.push(ns);
      args.push(key, value, '--env', 'TEST', '--type', type);
      const comment = (b.comment || '').trim();
      if (comment) args.push('--comment', comment);
      if (b.confirm === true) args.push('--confirm');
      const r = await runScript(SCRIPTS.apolloModify, args, 180_000);
      return scriptResult(res, r, b.confirm === true ? '已提交并发布' : '预检完成');
    }

    // ------------------------------------------------------- ONES 研发协作 ----
    // ONES 是协作系统（无测试环境），不受「生产只读」约束；但写入仍走两阶段：
    // confirm=false 只跑 Dry-Run 出 Diff，confirm=true 才带 --confirm 落库。
    if (req.method === 'POST' && route === '/api/ones/query') {
      const b = await readBody(req);
      const cmd = (b.cmd || '').trim();
      const args = [];
      if (cmd === 'schedule') {
        args.push('schedule');
        if (b.from) args.push('--from', String(b.from));
        if (b.to) args.push('--to', String(b.to));
      } else if (cmd === 'req') {
        const key = (b.key || '').trim();
        if (!key) return json(res, 400, { error: '缺少需求 ID 或标题关键词' });
        args.push('req', key);
        if (b.limit) args.push('--limit', String(b.limit));
      } else if (cmd === 'reqs') {
        args.push('reqs');
        const sprint = (b.sprint || '').trim();
        const pm = (b.pm || '').trim();
        const title = (b.title || '').trim();
        const level = (b.level || '').trim();
        if (!sprint && !pm && !title && !level) return json(res, 400, { error: '至少填一个过滤条件' });
        if (sprint) args.push('--sprint', sprint);
        if (pm) args.push('--pm', pm);
        if (title) args.push('--title', title);
        if (level) args.push('--level', level);
        if (b.limit) args.push('--limit', String(b.limit));
      } else if (cmd === 'bugs') {
        args.push('bugs');
        if (b.id) args.push('--id', String(b.id));
        if (b.resolver) args.push('--resolver', String(b.resolver));
        if (b.summary) args.push('--summary', String(b.summary));
        if (b.requireId) args.push('--require-id', String(b.requireId));
        args.push('--limit', String(b.limit || 10));
      } else if (cmd === 'iterations') {
        args.push('iterations');
        if (b.keyword) args.push(String(b.keyword));
      } else if (cmd === 'projects') {
        args.push('projects');
        if (b.keyword) args.push(String(b.keyword));
      } else {
        return json(res, 400, { error: '不支持的 ONES 查询命令' });
      }
      args.push('--json');
      return scriptResult(res, await runScript(SCRIPTS.onesQuery, args));
    }

    if (req.method === 'POST' && route === '/api/ones/write') {
      const b = await readBody(req);
      const cmd = (b.cmd || '').trim();
      const confirm = b.confirm === true;
      const args = [];
      const push = (flag, val) => { if (val !== undefined && val !== null && String(val).trim() !== '') args.push(flag, String(val).trim()); };

      if (cmd === 'create-req') {
        if (!String(b.title || '').trim()) return json(res, 400, { error: '缺少需求标题' });
        if (!String(b.level || '').trim()) return json(res, 400, { error: '缺少层级' });
        if (!String(b.pm || '').trim()) return json(res, 400, { error: '缺少产品经理' });
        args.push('create-req');
        push('--title', b.title);
        push('--level', b.level);
        push('--project', b.project);
        push('--pm', b.pm);
        push('--sprint', b.sprint);
        push('--priority', b.priority);
        push('--type', b.type);
        push('--desc', b.desc);
        if (b.withSafetyFunc !== false) args.push('--with-safety-func');
      } else if (cmd === 'create-bug') {
        if (!String(b.summary || '').trim()) return json(res, 400, { error: '缺少缺陷标题' });
        if (!String(b.resolver || '').trim()) return json(res, 400, { error: '缺少处理人' });
        args.push('create-bug');
        push('--summary', b.summary);
        push('--resolver', b.resolver);
        push('--require-id', b.requireId);
        push('--priority', b.priority);
        push('--type', b.type);
        push('--find-way', b.findWay);
        push('--desc', b.desc);
        push('--man-hour', b.manHour);
        push('--level', b.level);
      } else if (cmd === 'schedule') {
        if (!String(b.id || '').trim()) return json(res, 400, { error: '缺少需求 ID' });
        args.push('schedule', String(b.id).trim());
        push('--develop-start', b.developStart);
        push('--develop-end', b.developEnd);
        push('--test-start', b.testStart);
        push('--test-end', b.testEnd);
        push('--submit-test', b.submitTest);
        push('--online', b.online);
      } else if (cmd === 'move') {
        if (!String(b.ids || '').trim()) return json(res, 400, { error: '缺少需求 ID' });
        if (!String(b.sprint || '').trim()) return json(res, 400, { error: '缺少目标迭代' });
        args.push('move', String(b.ids).trim());
        push('--sprint', b.sprint);
      } else if (cmd === 'advance') {
        if (!String(b.id || '').trim()) return json(res, 400, { error: '缺少 ID' });
        if (!String(b.event || '').trim()) return json(res, 400, { error: '缺少流转事件' });
        args.push('advance', String(b.id).trim());
        push('--event', b.event);
        if (b.kind === 'bug') args.push('--kind', 'bug');
      } else {
        return json(res, 400, { error: '不支持的 ONES 写命令' });
      }

      if (confirm) args.push('--confirm');
      const r = await runScript(SCRIPTS.onesModify, args, 180_000);
      return scriptResult(res, r, confirm ? '已提交' : '预检完成');
    }

    if (req.method === 'POST' && route === '/api/write/es') {
      const b = await readBody(req);
      const service = (b.service || '').trim();
      const action = (b.action || '').trim();
      const id = String(b.id || '').trim();
      if (!service || !id) return json(res, 400, { error: '缺少索引或文档 ID' });
      if (!['update-part', 'update', 'insert', 'delete'].includes(action)) return json(res, 400, { error: '动作不合法' });
      const args = [service, '--action', action, '--id', id, '-e', 'test'];
      const data = b.data === undefined || b.data === null ? '' : String(b.data).trim();
      if (action !== 'delete') {
        if (!data) return json(res, 400, { error: '缺少写入数据 JSON' });
        try { JSON.parse(data); } catch { return json(res, 400, { error: '写入数据不是合法 JSON' }); }
        args.push('--data', data);
      }
      if (b.confirm === true) args.push('--confirm');
      const r = await runScript(SCRIPTS.esModify, args, 180_000);
      return scriptResult(res, r, b.confirm === true ? '已写入' : '预检完成');
    }

    if (req.method === 'POST' && route === '/api/write/kafka') {
      const b = await readBody(req);
      const topic = (b.topic || '').trim();
      if (!topic) return json(res, 400, { error: '缺少 topic' });
      const data = b.data === undefined || b.data === null ? '' : String(b.data).trim();
      const sets = Array.isArray(b.sets) ? b.sets.map(s => String(s).trim()).filter(Boolean) : [];
      if (!data && !sets.length) return json(res, 400, { error: '缺少消息体，或填写 sample 覆盖字段' });
      if (data) {
        try { JSON.parse(data); } catch { return json(res, 400, { error: '消息体不是合法 JSON' }); }
      }
      // 预检不投递：只回显将要发送的内容，避免「点了下按钮就真发消息」
      if (b.confirm !== true) {
        return json(res, 200, {
          ok: true,
          json: {
            mode: 'preflight',
            env: 'test',
            topic,
            key: (b.key || '').trim() || null,
            useSample: sets.length > 0,
            sets,
            messageBody: data ? JSON.parse(data) : null,
            note: 'Kafka 无原生 Dry-Run：确认后才会真正投递到测试集群'
          },
          stdout: '',
          stderr: ''
        });
      }
      const args = ['-t', topic, '-e', 'test'];
      if (data) args.push('-d', data);
      if (sets.length) args.push('--use-sample');
      for (const s of sets) args.push('-s', s);
      const key = (b.key || '').trim();
      if (key) args.push('-k', key);
      const r = await runScript(SCRIPTS.kafkaSend, args, 120_000);
      return scriptResult(res, r, '已投递');
    }

    if (req.method === 'POST' && route === '/api/write/mysql') {
      const b = await readBody(req);
      const service = (b.service || '').trim();
      const sql = (b.sql || '').trim();
      if (!service || !sql) return json(res, 400, { error: '缺少服务或 SQL' });
      // 只允许单条语句，避免一次提交塞进多段写入绕过确认
      if (/;\s*\S/.test(sql.replace(/;\s*$/, ''))) return json(res, 400, { error: '一次只能执行一条 SQL 语句' });
      const isRead = /^(select|show|desc|describe|explain)\b/i.test(sql);
      const ds = (b.datasource || '').trim();
      const args = [service];
      if (ds) args.push(ds);
      args.push(sql, '--json');
      // 只读语句直接执行；写语句必须显式 confirm
      if (!isRead && b.confirm !== true) {
        return json(res, 200, {
          ok: true,
          json: {
            mode: 'preflight',
            env: 'test',
            operationType: /^(insert|replace)\b/i.test(sql) ? 'INSERT' : (/^(delete)\b/i.test(sql) ? 'DELETE' : 'UPDATE'),
            sql,
            note: '预检只做语法与参数确认，不会执行；确认后才会真正写入测试库'
          },
          stdout: '',
          stderr: ''
        });
      }
      const r = await runScript(SCRIPTS.mysqlQuery, args, 120_000);
      return scriptResult(res, r, isRead ? '查询完成' : '已执行');
    }

    json(res, 404, { error: 'Not Found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// --------------------------------------------------------------- start -----

const argv = process.argv.slice(2);
const portIdx = argv.findIndex(a => a === '--port' || a === '-p');
const port = portIdx !== -1 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 6886;
const host = '127.0.0.1';

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${port} 已被占用。可能控制台已在运行，或使用 --port <其它端口>。\n`);
    process.exit(1);
  }
  console.error('服务异常:', err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  // 启动自检：确保页面内联脚本能被解析，避免「页面打开但没反应」
  try {
    const html = buildPage([], listAppItems());
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
    new Function(script); // eslint-disable-line no-new-func
    console.log(`\n✅ 页面脚本自检通过`);
  } catch (err) {
    console.error(`\n❌ 页面脚本自检失败（页面可能无法正常使用）: ${err.message}`);
  }
  console.log(`\n🌐 Leo Live Inspector 测试环境部署控制台已启动`);
  console.log(`   URL: ${url}`);
  console.log(`   提示: 仅在测试环境执行「合并 QA 分支 + 构建部署」，生产环境不会被自动部署。`);
  console.log(`   按 Ctrl+C 停止服务。\n`);
  if (argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      const child = spawn(opener, process.platform === 'win32' ? ['', url] : [url], { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch {}
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
