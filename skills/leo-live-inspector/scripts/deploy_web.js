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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const CI_DEPLOY = path.join(__dirname, 'ci_deploy.js');
const SHRIMP_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');
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

async function probeCredential(file, url, init = {}) {
  let cred;
  try {
    cred = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, message: '未保存凭据' };
  }
  const cookie = cred.cookie || '';
  if (!cookie) return { ok: false, message: '未保存凭据', updatedAt: cred.updated_at || null };
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `登录态已失效 (HTTP ${res.status})`, updatedAt: cred.updated_at || null };
    }
    if (/ke-passport/i.test(text) || /<title>[^<]*(登录|login)/i.test(text)) {
      return { ok: false, message: '登录态已失效（被重定向到登录页）', updatedAt: cred.updated_at || null };
    }
    if (!res.ok) return { ok: false, message: `请求异常 HTTP ${res.status}`, updatedAt: cred.updated_at || null };
    return { ok: true, message: '正常', updatedAt: cred.updated_at || null };
  } catch (err) {
    return { ok: false, message: '请求失败: ' + err.message, updatedAt: cred.updated_at || null };
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

function buildPage(projects) {
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
<title>测试环境 · 合并 QA 并部署</title>
<style>
  :root { --bg:#0e1116; --panel:#171b22; --panel2:#1e242d; --border:#2b333f; --fg:#e6edf3; --muted:#8b97a7; --accent:#3b82f6; --accent2:#2563eb; --ok:#22c55e; --err:#ef4444; --warn:#f59e0b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:1080px; margin:0 auto; padding:28px 20px 60px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
  header h1 { font-size:19px; margin:0; font-weight:650; letter-spacing:.3px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 22px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px var(--ok); display:inline-block; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px 18px 20px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label { font-size:12px; color:var(--muted); letter-spacing:.4px; }
  input, select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); color:var(--fg); font-size:14px; outline:none; }
  input:focus, select:focus { border-color:var(--accent); }
  input[readonly] { color:var(--muted); }
  .row { display:flex; gap:8px; align-items:flex-end; }
  .row input { flex:1; }
  .combo { position:relative; }
  .combo-list { position:absolute; z-index:30; left:0; right:0; top:calc(100% + 4px); max-height:280px; overflow:auto; background:var(--panel2); border:1px solid var(--border); border-radius:8px; box-shadow:0 14px 34px rgba(0,0,0,.5); }
  .combo-item { padding:8px 12px; font-size:13.5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .combo-item:hover, .combo-item.active { background:var(--accent); color:#fff; }
  .combo-empty { padding:10px 12px; color:var(--muted); font-size:13px; }
  button { padding:10px 16px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); color:var(--fg); font-size:14px; cursor:pointer; white-space:nowrap; }
  button:hover { border-color:var(--accent); }
  button.primary { background:linear-gradient(180deg,var(--accent),var(--accent2)); border:none; font-weight:600; padding:12px 26px; font-size:15px; }
  button.primary:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:transparent; }
  .hint { font-size:12px; color:var(--muted); margin-top:8px; line-height:1.6; }
  .actions { display:flex; align-items:center; gap:14px; margin-top:4px; }
  .status { font-size:13px; }
  .status.running { color:var(--warn); }
  .status.success { color:var(--ok); }
  .status.error { color:var(--err); }
  #log { margin:0; padding:16px; height:360px; overflow:auto; background:#0a0d12; border:1px solid var(--border); border-radius:10px; font-family:"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; color:#c9d4e0; }
  .muted { color:var(--muted); }
  @media (max-width:720px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <header><span class="dot" id="liveDot"></span><h1>测试环境 · 合并 QA 分支并部署</h1></header>
  <p class="sub">开发分支 → 合并进 QA 分支 → 推送到远程 → 触发 Shipwright 构建 → 下发测试环境部署。仅限 test 环境。</p>

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
      <span class="status" id="status">就绪</span>
    </div>
    <div class="hint" id="credHint"></div>
    <div class="hint">⚠️ 合并会创建隔离的临时工作区执行，不会影响你当前正在编辑的工作目录。生产环境不会被自动部署。</div>
  </div>

  <div class="card">
    <div class="field" style="margin-bottom:10px"><label>执行日志</label></div>
    <pre id="log">等待操作…</pre>
  </div>
</div>

<script>
const PROJECT_ITEMS = ${JSON.stringify(projectItems).replace(/</g, '\\u003c')};
let currentProject = '';
let pollTimer = null;
let lastJobId = null;

const $ = id => document.getElementById(id);
const modeLabel = { merge_deploy:'合并并部署', merge_only:'仅合并', deploy_dev:'直接部署开发分支', build_deploy:'仅构建部署', build_only:'仅构建', preview:'仅预演合并' };

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
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

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let branchOptions = [];
const comboRegistry = [];

function setupCombo(inputId, listId) {
  const input = $(inputId);
  const list = $(listId);
  let items = [];
  let active = -1;

  function highlight() {
    list.querySelectorAll('.combo-item').forEach((el, i) => el.classList.toggle('active', i === active));
    const el = list.querySelector('.combo-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function render(filter) {
    const f = (filter || '').toLowerCase().trim();
    items = branchOptions.filter(b => !f || b.toLowerCase().includes(f)).slice(0, 400);
    if (!items.length) {
      list.innerHTML = '<div class="combo-empty">' + (branchOptions.length ? '无匹配分支' : '暂无分支，请先选择项目或刷新分支') + '</div>';
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
  // 点击时全选「记住的上次分支」，直接输入关键字即可整段替换（否则会拼在旧值后面导致搜不到）
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
    else if (e.key === 'Enter') { if (active >= 0 && items[active]) { e.preventDefault(); input.value = items[active]; hide(); saveSelection(); } }
    else if (e.key === 'Escape') { hide(); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  list.addEventListener('mousedown', e => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault();
    input.value = items[Number(it.dataset.i)];
    hide();
    saveSelection();
  });

  comboRegistry.push({ input, list, hide });
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
    $('repoHint').textContent = repoText + ($('repoHint').textContent ? '　|　' + $('repoHint').textContent : '');
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
    await api('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: currentProject,
        devBranch: $('devBranch').value.trim(),
        qaBranch: $('qaBranch').value.trim()
      })
    });
  } catch {}
}

setupCombo('devBranch', 'devList');
setupCombo('qaBranch', 'qaList');

// 项目下拉：与分支下拉不同的策略 —— 不做搜索过滤。
// 点击/输入都直接展开「已登记项目」全量清单，输入文字不会把清单过滤掉。
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
  // 点击时全选「记住的上次项目」，直接输入即可整段替换（避免追加到旧值后面）
  input.addEventListener('mousedown', e => {
    const v = input.value.trim();
    const known = PROJECT_ITEMS.some(p => p.id === v);
    if (!known) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  input.addEventListener('input', () => {
    // 输入时清单仍然全量展开（不过滤），输入完整项目名则立即联动
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
    } catch {
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

setupProjectCombo();

// 测试环境实际使用的是最新的 qa-YYYY-MM 分支，给出提示避免选错
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
}

$('btnRepo').addEventListener('click', async () => {
  if (!currentProject) return setStatus('请先选择项目', 'error');
  try {
    await api('/api/repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: currentProject, path: $('repoPath').value.trim() })
    });
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
      '。失效会导致「无法获取构建器」。修复：加载 Leo Chrome 插件（scripts/setup_chrome_ext.sh）后重试，或手动执行 node scripts/ci_deploy.js --set-shipwright-cookie "<cookie>" / --set-cookie "<cookie>"。');
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
  $('log').textContent = '任务提交中…';
  let job;
  try {
    job = await api('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, devBranch: dev, qaBranch: qa, mode, conflict })
    });
  } catch (e) {
    setStatus(e.message, 'error');
    $('log').textContent = '❌ ' + e.message;
    return;
  }
  lastJobId = job.id;
  setStatus('执行中…', 'running');
  $('btnDeploy').disabled = true;
  startPolling(job.id);
});

function startPolling(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    try {
      const job = await api('/api/job?id=' + encodeURIComponent(jobId));
      $('log').textContent = job.log || '';
      $('log').scrollTop = $('log').scrollHeight;
      if (job.status === 'running') {
        setStatus('执行中…', 'running');
      } else {
        clearInterval(pollTimer);
        pollTimer = null;
        $('btnDeploy').disabled = false;
        if (job.status === 'success') {
          setStatus(job.result && job.result.imageAddress ? '部署成功 · ' + job.result.imageAddress : '执行成功', 'success');
        } else {
          setStatus('执行失败', 'error');
        }
      }
    } catch (e) {
      // 忽略轮询瞬时错误
    }
  };
  tick();
  pollTimer = setInterval(tick, 1200);
}

async function init() {
  try {
    const data = await api('/api/initial');
    if (data.lastProject) {
      $('project').value = data.lastProject;
      currentProject = data.lastProject;
      await loadState(currentProject);
    }
  } catch {}
  refreshCredentialStatus();
  // 恢复最近一次任务日志（服务重启后仍可回看失败原因）
  try {
    const { jobs } = await api('/api/jobs');
    if (jobs && jobs.length) {
      const last = jobs[0];
      const job = await api('/api/job?id=' + encodeURIComponent(last.id));
      $('log').textContent = '最近任务 [' + last.project + '] ' + last.devBranch + ' → ' + last.qaBranch + ' (' + (last.modeLabel || last.mode) + ') · ' + last.status + String.fromCharCode(10, 10) + (job.log || '');
      setStatus(last.status === 'success' ? '上次执行成功' : (last.status === 'running' ? '上次任务仍在执行' : '上次执行失败'), last.status === 'success' ? 'success' : (last.status === 'running' ? 'running' : 'error'));
    }
  } catch {}
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
      const html = buildPage(listProjects());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && route === '/api/initial') {
      const lastProject = state.lastProject || Object.keys(state.branches)[0] || '';
      return json(res, 200, { lastProject });
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
    const html = buildPage([]);
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
