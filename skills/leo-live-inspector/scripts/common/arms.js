import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { URL } from 'node:url';
import { requestHttp } from './http.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';
import {
  SHRIMP_LIVE_DIR,
  loadArmsCookie,
  saveArmsCookie,
  loadArmsApiKey,
  saveArmsApiKey,
  writeCredentialJson
} from './credentials.js';

export const DEFAULT_ARMS_HOST = 'http://arms.fee.lianjia.com';
export const ARMS_PROJECTS_CACHE_FILE = path.join(SHRIMP_LIVE_DIR, 'arms_projects.json');
export const ARMS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUERY_WINDOW_SEC = 7 * 24 * 3600;

export const ARMS_DATA_TYPES = {
  error: 'error',
  错误: 'error',
  pvuv: 'product',
  product: 'product',
  perf: 'perf',
  性能: 'perf',
  custom: 'info',
  info: 'info',
  自定义: 'info'
};

export const ARMS_ENVS = {
  prod: 'production',
  production: 'production',
  online: 'production',
  生产: 'production',
  preview: 'preview',
  prev: 'preview',
  pre: 'preview',
  预发: 'preview',
  test: 'testing',
  testing: 'testing',
  qa: 'testing',
  dev: 'testing',
  development: 'development',
  测试: 'testing'
};

export const ARMS_FILTER_FIELDS = {
  time: { key: 'time', type: 'range' },
  type: { key: 'type', type: 'keyword' },
  env: { key: 'common.env', type: 'text' },
  'common.env': { key: 'common.env', type: 'text' },
  subtype: { key: 'detail.subType', type: 'text' },
  'detail.subtype': { key: 'detail.subType', type: 'text' },
  ucid: { key: 'common.ucid', type: 'text' },
  'common.ucid': { key: 'common.ucid', type: 'text' },
  ip: { key: 'ip', type: 'text' },
  isp: { key: 'common.isp', type: 'text' },
  'common.isp': { key: 'common.isp', type: 'text' },
  width: { key: 'common.dsp_w', type: 'number' },
  'common.dsp_w': { key: 'common.dsp_w', type: 'number' },
  height: { key: 'common.dsp_h', type: 'number' },
  'common.dsp_h': { key: 'common.dsp_h', type: 'number' },
  country: { key: 'country', type: 'text' },
  province: { key: 'province', type: 'text' },
  city: { key: 'city', type: 'text' },
  url: { key: 'detail.url', type: 'text' },
  'detail.url': { key: 'detail.url', type: 'text' },
  pagetype: { key: 'common.page_type', type: 'text' },
  page_type: { key: 'common.page_type', type: 'text' },
  'common.page_type': { key: 'common.page_type', type: 'text' },
  os: { key: 'ua.os.name', type: 'text' },
  'ua.os.name': { key: 'ua.os.name', type: 'text' },
  osversion: { key: 'ua.os.version', type: 'text' },
  'ua.os.version': { key: 'ua.os.version', type: 'text' },
  browser: { key: 'ua.browser.name', type: 'text' },
  client: { key: 'ua.browser.name', type: 'text' },
  'ua.browser.name': { key: 'ua.browser.name', type: 'text' },
  browserversion: { key: 'ua.browser.version', type: 'text' },
  'ua.browser.version': { key: 'ua.browser.version', type: 'text' },
  device: { key: 'ua.device.vendor', type: 'text' },
  vendor: { key: 'ua.device.vendor', type: 'text' },
  'ua.device.vendor': { key: 'ua.device.vendor', type: 'text' },
  model: { key: 'ua.device.model', type: 'text' },
  'ua.device.model': { key: 'ua.device.model', type: 'text' },
  ua: { key: 'ua.ua', type: 'text' },
  'ua.ua': { key: 'ua.ua', type: 'text' },
  errortype: { key: 'detail.error_no', type: 'text' },
  error_no: { key: 'detail.error_no', type: 'text' },
  'detail.error_no': { key: 'detail.error_no', type: 'text' },
  extra: { key: 'extra', type: 'text' },
  content: { key: 'extra', type: 'text' },
  msg: { key: 'extra', type: 'text' },
  message: { key: 'extra', type: 'text' }
};

export const ARMS_OPERATORS = {
  '=': '=',
  eq: '=',
  等于: '=',
  '!=': '!=',
  ne: '!=',
  不等于: '!=',
  include: 'include',
  contains: 'include',
  like: 'include',
  '~': 'include',
  包含: 'include',
  exclude: 'exclude',
  not_include: 'exclude',
  '!~': 'exclude',
  不包含: 'exclude',
  in: 'in',
  'not in': 'not in',
  notin: 'not in',
  prefix: 'prefix',
  startswith: 'prefix',
  'not prefix': 'not prefix',
  notprefix: 'not prefix'
};

export const ARMS_AGGS_FIELDS = {
  no: 'no',
  none: 'no',
  errortype: 'detail.error_no.keyword',
  error_no: 'detail.error_no.keyword',
  'detail.error_no.keyword': 'detail.error_no.keyword',
  ip: 'ip',
  isp: 'common.isp.keyword',
  'common.isp.keyword': 'common.isp.keyword',
  ucid: 'common.ucid.keyword',
  'common.ucid.keyword': 'common.ucid.keyword',
  country: 'country',
  province: 'province',
  city: 'city',
  url: 'detail.url',
  'detail.url': 'detail.url',
  pagetype: 'common.page_type.keyword',
  page_type: 'common.page_type.keyword',
  'common.page_type.keyword': 'common.page_type.keyword',
  os: 'ua.os.name',
  'ua.os.name': 'ua.os.name',
  osversion: 'ua.os.version',
  'ua.os.version': 'ua.os.version',
  browser: 'ua.browser.name',
  client: 'ua.browser.name',
  'ua.browser.name': 'ua.browser.name',
  browserversion: 'ua.browser.version',
  'ua.browser.version': 'ua.browser.version',
  ua: 'ua.ua',
  'ua.ua': 'ua.ua',
  device: 'ua.device.vendor',
  vendor: 'ua.device.vendor',
  'ua.device.vendor': 'ua.device.vendor',
  model: 'ua.device.model',
  'ua.device.model': 'ua.device.model',
  version: 'common.runtime_version',
  runtime_version: 'common.runtime_version',
  'common.runtime_version': 'common.runtime_version'
};

export const ARMS_PERF_METRICS = {
  LCP: 20004,
  INP: 20015,
  CLS: 20005,
  TBT: 20014,
  TTFB: 20008,
  FCP: 20013
};

export const DEFAULT_RUNTIME_ERROR_TYPES = [
  '页面报错_JS_RUNTIME_ERROR',
  'JS错误_Unhandled_Rejection',
  '页面报错_CONSOLE_ERROR'
];

export function getArmsHost(hostOverride = null) {
  const raw = (hostOverride || process.env.ARMS_HOST || DEFAULT_ARMS_HOST).trim();
  return raw.replace(/\/+$/, '');
}

export function normalizeArmsEnv(env) {
  const key = String(env || 'production').trim().toLowerCase();
  return ARMS_ENVS[key] || 'production';
}

export function normalizeArmsDataType(dataType) {
  const key = String(dataType || 'error').trim().toLowerCase();
  return ARMS_DATA_TYPES[key] || 'error';
}

export function normalizeAggsField(aggs) {
  if (!aggs) return 'no';
  const raw = String(aggs).trim();
  return ARMS_AGGS_FIELDS[raw.toLowerCase()] || raw;
}

export function isArmsAuthFailure(res) {
  if (!res) return false;
  if (isLoginFailure(res)) return true;
  if (res.statusCode === 401 || res.statusCode === 403) return true;
  if (res.statusCode === 200 && typeof res.raw === 'string' && /<html|<!doctype/i.test(res.raw)) {
    if (/login\.ke\.com|passport|统一登录|扫码登录/i.test(res.raw)) return true;
  }
  const body = res.json || res.data;
  if (body && typeof body === 'object') {
    if (body.code === 10000 && body.action === 'login') return true;
    if (/请先登录|未登录|未授权|unauthorized|invalid.*key|api.?key|无效.*key|key.*无效|key.*过期/i.test(String(body.msg || body.message || ''))) {
      return body.code !== 0;
    }
  }
  return false;
}

export function isArmsSuccess(res) {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300 || res.error) {
    return false;
  }
  if (isArmsAuthFailure(res)) return false;
  const body = res.json || res.data;
  if (body && typeof body === 'object') {
    if (body.code !== undefined && body.code !== 0) return false;
  }
  return true;
}

let cachedCookieSession = null;

function getArmsCookieSession({ host, explicitCookie = null, transport = requestHttp } = {}) {
  if (explicitCookie) {
    return createCredentialSession({
      load: () => explicitCookie,
      save: () => {},
      explicit: true,
      isAuthFailure: isArmsAuthFailure,
      isSuccess: isArmsSuccess
    });
  }
  if (!cachedCookieSession) {
    cachedCookieSession = createCredentialSession({
      load: loadArmsCookie,
      save: saveArmsCookie,
      explicit: Boolean(process.env.ARMS_COOKIE),
      isAuthFailure: isArmsAuthFailure,
      isSuccess: isArmsSuccess,
      names: ['security_ticket', 'login_ucid', 'lianjia_uuid', 'lianjia_ssid', 'connect.sid', 'egg_session', 'token']
    });
  }
  return cachedCookieSession;
}

async function sendArmsHttp({ host, apiPath, method = 'GET', postBody = null, headers = {}, timeout = 15000, transport = requestHttp }) {
  const fullUrl = new URL(apiPath.startsWith('http') ? apiPath : `${host}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`);
  return transport({
    protocol: fullUrl.protocol,
    hostname: fullUrl.hostname,
    port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
    path: fullUrl.pathname + fullUrl.search,
    method,
    timeout,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      ...headers
    }
  }, postBody);
}

/**
 * 执行灯塔 ARMS REST API 请求（支持：免鉴权 / x-api-key / Chrome Cookie 自动中继 双轨鉴权）
 */
export async function executeArmsApi({
  path: apiPath,
  method = 'GET',
  params = {},
  postBody = null,
  authMode = 'auto', // 'public' | 'auto'
  apiKey = null,
  cookie = null,
  useCookie = false,
  host = null,
  timeout = 15000,
  transport = requestHttp,
  apiKeyLoader = loadArmsApiKey,
  cookieSessionFactory = getArmsCookieSession
} = {}) {
  const baseHost = getArmsHost(host);
  const queryEntries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const qs = queryEntries.length
    ? `?${new URLSearchParams(queryEntries.map(([k, v]) => [k, String(v)])).toString()}`
    : '';
  const targetPath = `${apiPath}${qs}`;
  const fullUrl = `${baseHost}${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`;

  if (authMode === 'public') {
    const res = await sendArmsHttp({ host: baseHost, apiPath: targetPath, method, postBody, timeout, transport });
    if (!isArmsSuccess(res)) {
      const msg = res.json?.msg || res.error || `HTTP ${res.statusCode}`;
      throw Object.assign(new Error(`ARMS 接口请求失败 (${targetPath}): ${msg}`), { code: 'ARMS_API_ERROR', response: res });
    }
    return { data: res.json?.data ?? res.data, authUsed: 'public' };
  }

  const explicitApiKey = apiKey ? String(apiKey).trim() : '';
  const resolvedApiKey = !useCookie && !cookie ? (explicitApiKey || apiKeyLoader()) : '';

  if (resolvedApiKey) {
    const res = await sendArmsHttp({
      host: baseHost,
      apiPath: targetPath,
      method,
      postBody,
      timeout,
      transport,
      headers: { 'x-api-key': resolvedApiKey }
    });
    if (isArmsSuccess(res)) {
      return { data: res.json?.data ?? res.data, authUsed: 'api-key' };
    }
    const msg = String(res.json?.msg || res.error || `HTTP ${res.statusCode}`);
    const isPermDenied = /没有权限|无权限|permission|forbidden/i.test(msg);
    if (!isArmsAuthFailure(res) && !(isPermDenied && !explicitApiKey)) {
      throw Object.assign(new Error(`ARMS 接口请求失败 (${targetPath}): ${msg}`), { code: 'ARMS_API_ERROR', response: res });
    }
    if (explicitApiKey) {
      throw Object.assign(new Error('提供的 x-api-key 鉴权失败，请检查 Key 是否有效或已启用'), { code: 'ARMS_API_KEY_INVALID', response: res });
    }
  }

  const session = cookieSessionFactory({ host: baseHost, explicitCookie: cookie, transport });
  const res = await session.run(
    fullUrl,
    (cookieHeader) => sendArmsHttp({
      host: baseHost,
      apiPath: targetPath,
      method,
      postBody,
      timeout,
      transport,
      headers: cookieHeader ? { Cookie: cookieHeader } : {}
    }),
    { readOnly: true }
  );

  if (!isArmsSuccess(res)) {
    const msg = res.json?.msg || res.error || `HTTP ${res.statusCode}`;
    throw Object.assign(new Error(`ARMS 接口请求失败 (${targetPath}): ${msg}`), {
      code: isArmsAuthFailure(res) ? 'ARMS_AUTH_REQUIRED' : 'ARMS_API_ERROR',
      response: res
    });
  }
  return { data: res.json?.data ?? res.data, authUsed: 'cookie' };
}

export function pad2(num) {
  return String(num).padStart(2, '0');
}

export function formatLocalMinute(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatArmsTimestamp(ts) {
  if (ts === undefined || ts === null || ts === '') return '';
  if (typeof ts === 'string' && !/^\d{10,13}$/.test(ts.trim())) {
    return ts.trim();
  }
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return String(ts);
  const ms = num < 1e12 ? num * 1000 : num;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function parseRelativeDurationMs(timeStr) {
  const match = String(timeStr || '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day)$/i);
  if (!match) return null;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('m')) return val * 60 * 1000;
  if (unit.startsWith('h')) return val * 3600 * 1000;
  if (unit.startsWith('d')) return val * 86400 * 1000;
  return null;
}

export function parseTimeBoundary(input, fallbackDate) {
  if (!input) return fallbackDate;
  const raw = String(input).trim();
  if (raw === 'now') return new Date();
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));
  const relNow = raw.match(/^now-(\d+(?:\.\d+)?)(m|h|d)$/i);
  if (relNow) {
    const ms = parseRelativeDurationMs(`${relNow[1]}${relNow[2]}`);
    return new Date(Date.now() - ms);
  }
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析时间格式: "${input}" (请使用 YYYY-MM-DD HH:mm 或 1h/24h/7d)`);
  }
  return parsed;
}

export function resolveTimeRange({ time = '2h', from = null, to = null, now = new Date() } = {}) {
  let endDate = to ? parseTimeBoundary(to, now) : new Date(now.getTime());
  let startDate;
  if (from) {
    startDate = parseTimeBoundary(from, now);
  } else if (String(time).toLowerCase() === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    endDate = to ? endDate : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else {
    const ms = parseRelativeDurationMs(time);
    if (!ms) {
      throw new Error(`不支持的相对时间范围: "${time}" (支持如 15m, 1h, 2h, 24h, 3d, 7d, today)`);
    }
    startDate = new Date(endDate.getTime() - ms);
  }
  const spanSec = Math.floor((endDate.getTime() - startDate.getTime()) / 1000);
  if (spanSec < 0) {
    throw new Error('起始时间不能晚于结束时间');
  }
  if (spanSec > MAX_QUERY_WINDOW_SEC) {
    throw new Error('灯塔数据检索时间跨度最大支持 7 天，请缩小时间范围');
  }
  return {
    startDate,
    endDate,
    startStr: formatLocalMinute(startDate),
    endStr: formatLocalMinute(endDate),
    startAt: Math.floor(startDate.getTime() / 1000),
    endAt: Math.floor(endDate.getTime() / 1000)
  };
}

/**
 * 解析单条筛选表达式，支持 `field=val`, `field!=val`, `field~val`, `field:op:val`
 */
export function parseFilterExpression(expr) {
  const raw = String(expr || '').trim();
  if (!raw) throw new Error('空筛选条件');

  const colonOpMatch = raw.match(/^([^:=!~]+):([^:]+):(.*)$/);
  if (colonOpMatch) {
    return buildFilterItem(colonOpMatch[1], colonOpMatch[2], colonOpMatch[3]);
  }
  const opMatch = raw.match(/^([^=!~]+?)(!=|=|!~|~)(.*)$/);
  if (opMatch) {
    return buildFilterItem(opMatch[1], opMatch[2], opMatch[3]);
  }
  throw new Error(`无法解析筛选条件 "${expr}"，请使用格式: field=value, field~value 或 field:op:value`);
}

export function buildFilterItem(fieldInput, opInput = '=', valueInput = '') {
  const fieldNorm = String(fieldInput || '').trim().toLowerCase();
  const fieldDef = ARMS_FILTER_FIELDS[fieldNorm] || { key: String(fieldInput).trim(), type: 'text' };
  const opNorm = String(opInput || '=').trim().toLowerCase();
  const condition = ARMS_OPERATORS[opNorm] || opInput;
  const value = fieldDef.type === 'number' && !Number.isNaN(Number(valueInput))
    ? Number(valueInput)
    : String(valueInput);
  return {
    key: fieldDef.key,
    condition,
    value,
    type: fieldDef.type
  };
}

export function buildQueryDataItems({
  startStr,
  endStr,
  dataType = 'error',
  env = 'production',
  query = null,
  pageType = null,
  url = null,
  errorType = null,
  ucid = null,
  ip = null,
  os = null,
  browser = null,
  device = null,
  isp = null,
  province = null,
  city = null,
  filters = []
} = {}) {
  const items = [
    { key: 'time', condition: '=', value: [startStr, endStr], type: 'range', disabled: true },
    { key: 'type', condition: '=', value: normalizeArmsDataType(dataType), type: 'keyword', disabled: true },
    { key: 'common.env', condition: '=', value: normalizeArmsEnv(env), type: 'text', disabled: true }
  ];

  if (query && query !== '*') items.push(buildFilterItem('extra', 'include', query));
  if (pageType) items.push(buildFilterItem('common.page_type', '=', pageType));
  if (url) items.push(buildFilterItem('detail.url', 'include', url));
  if (errorType) items.push(buildFilterItem('detail.error_no', '=', errorType));
  if (ucid) items.push(buildFilterItem('common.ucid', '=', ucid));
  if (ip) items.push(buildFilterItem('ip', '=', ip));
  if (os) items.push(buildFilterItem('ua.os.name', 'include', os));
  if (browser) items.push(buildFilterItem('ua.browser.name', 'include', browser));
  if (device) items.push(buildFilterItem('ua.device.model', 'include', device));
  if (isp) items.push(buildFilterItem('common.isp', '=', isp));
  if (province) items.push(buildFilterItem('province', '=', province));
  if (city) items.push(buildFilterItem('city', '=', city));

  for (const expr of filters || []) {
    if (typeof expr === 'string') {
      items.push(parseFilterExpression(expr));
    } else if (expr && expr.key) {
      items.push(expr);
    }
  }
  return items;
}

export function detectLocalFrontendHint(cwd = process.cwd()) {
  let repoName = null;
  let remoteUrl = null;
  try {
    remoteUrl = execSync('git remote get-url origin 2>/dev/null', { cwd, encoding: 'utf8' }).trim();
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) repoName = match[1];
  } catch {}
  let pkgName = null;
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkgName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name || null;
    }
  } catch {}
  return {
    repoName,
    remoteUrl,
    pkgName,
    dirName: path.basename(cwd)
  };
}

function readProjectsCache(cacheFile = ARMS_PROJECTS_CACHE_FILE) {
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!Array.isArray(data?.list)) return null;
    const age = Date.now() - new Date(data.updated_at || 0).getTime();
    return { list: data.list, expired: !Number.isFinite(age) || age > ARMS_CACHE_TTL_MS };
  } catch {
    return null;
  }
}

export async function listArmsProjects({ refresh = false, cacheFile = ARMS_PROJECTS_CACHE_FILE, ...apiOpts } = {}) {
  const cached = !refresh ? readProjectsCache(cacheFile) : null;
  if (cached && !cached.expired) {
    return cached.list;
  }
  try {
    const { data } = await executeArmsApi({
      path: '/api/aiMcp/project/list',
      method: 'GET',
      authMode: 'public',
      ...apiOpts
    });
    const list = Array.isArray(data?.list) ? data.list : (Array.isArray(data) ? data : []);
    try {
      writeCredentialJson(cacheFile, { updated_at: new Date().toISOString(), total: list.length, list });
    } catch {}
    return list;
  } catch (err) {
    if (cached?.list?.length) return cached.list;
    throw err;
  }
}

function extractGitRepoSlug(gitUrl) {
  if (!gitUrl) return '';
  const clean = String(gitUrl).trim().replace(/\.git$/i, '');
  const parts = clean.split('/');
  return (parts[parts.length - 1] || '').toLowerCase();
}

export async function resolveArmsProject(target = null, options = {}) {
  const trimmed = target ? String(target).trim() : '';
  if (/^\d+$/.test(trimmed)) {
    const projects = await listArmsProjects(options).catch(() => []);
    const hit = projects.find(p => String(p.project_id) === trimmed);
    return hit || { project_id: Number(trimmed), project_name: `project-${trimmed}`, display_name: `项目 ${trimmed}` };
  }

  const projects = await listArmsProjects(options);
  let hint = trimmed;
  if (!hint) {
    const local = detectLocalFrontendHint();
    hint = local.repoName || local.pkgName || local.dirName;
  }
  if (!hint) {
    throw new Error('请指定灯塔项目 ID、项目名或 Git 仓库名（如 1737 或 life-fe-intelligentize）');
  }
  const q = hint.toLowerCase();

  // 1. 精确匹配 project_name / git repo slug / display_name
  const exact = projects.find(p =>
    String(p.project_name || '').toLowerCase() === q ||
    extractGitRepoSlug(p.git_url) === q ||
    String(p.display_name || '').toLowerCase() === q
  );
  if (exact) return exact;

  // 2. 模糊匹配（project_name / git_url / display_name / home_page）
  const matches = projects.filter(p =>
    String(p.project_name || '').toLowerCase().includes(q) ||
    String(p.display_name || '').toLowerCase().includes(q) ||
    String(p.git_url || '').toLowerCase().includes(q) ||
    String(p.home_page || '').toLowerCase().includes(q)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // 若同时存在精确子串命中的 H5/Web 主项目优先返回或抛消歧提示
    const preview = matches.slice(0, 8).map(p => `${p.project_id} (${p.display_name} / ${p.project_name})`).join(', ');
    throw new Error(`匹配到多个灯塔项目 "${hint}": ${preview}，请使用具体项目 ID 或完整 project_name`);
  }
  throw new Error(`未在灯塔平台找到匹配 "${hint}" 的项目`);
}

export function parseExtraPayload(rawExtra) {
  if (!rawExtra) return {};
  if (typeof rawExtra === 'object') return rawExtra;
  try {
    return JSON.parse(rawExtra);
  } catch {
    return { desc: String(rawExtra) };
  }
}

export function normalizeQueryLogItem(item, slim = false) {
  const common = item.common || {};
  const detail = item.detail || {};
  const ua = item.ua || {};
  const extraObj = parseExtraPayload(item.extra);
  const desc = extraObj.desc || extraObj.message || (typeof item.extra === 'string' ? item.extra : '');
  const stack = extraObj.stack || '';
  return {
    time: formatArmsTimestamp(item.time_ms || item.time || ''),
    type: item.type || '',
    errorType: detail.error_no || detail.subType || '',
    pageType: common.page_type || '',
    url: slim && detail.url ? String(detail.url).slice(0, 140) : (detail.url || ''),
    desc: slim && desc ? String(desc).slice(0, 220) : desc,
    stack: slim && stack ? String(stack).slice(0, 300) : stack,
    viewId: item.viewId || item.view_id || '',
    uuid: common.uuid || '',
    ucid: common.ucid || '',
    region: [item.country, item.province, item.city].filter(Boolean).join('-') || '-',
    isp: common.isp || '',
    ip: item.ip || '',
    os: ua.os ? `${ua.os.name || ''}-${ua.os.version || ''}` : '',
    browser: ua.browser ? `${ua.browser.name || ''}-${ua.browser.version || ''}` : '',
    device: ua.device ? `${ua.device.vendor || ''}-${ua.device.model || ''}` : '',
    version: common.runtime_version || common.version || ''
  };
}

export async function queryArmsLogs(projectId, {
  time = '2h',
  from = null,
  to = null,
  dataType = 'error',
  env = 'production',
  query = null,
  pageType = null,
  url = null,
  errorType = null,
  ucid = null,
  ip = null,
  os = null,
  browser = null,
  device = null,
  isp = null,
  province = null,
  city = null,
  filters = [],
  aggs = 'no',
  size = 20,
  page = 1,
  slim = false,
  ...apiOpts
} = {}) {
  const range = resolveTimeRange({ time, from, to });
  const aggsField = normalizeAggsField(aggs);
  const items = buildQueryDataItems({
    startStr: range.startStr,
    endStr: range.endStr,
    dataType,
    env,
    query,
    pageType,
    url,
    errorType,
    ucid,
    ip,
    os,
    browser,
    device,
    isp,
    province,
    city,
    filters
  });

  const { data, authUsed } = await executeArmsApi({
    path: `/project/${projectId}/api/data/query/list`,
    method: 'POST',
    postBody: {
      aggs: aggsField,
      items,
      size: Number(size) || 20,
      curPage: Number(page) || 1
    },
    ...apiOpts
  });

  const recordList = Array.isArray(data?.recordList) ? data.recordList : [];
  return {
    authUsed,
    timeRange: { start: range.startStr, end: range.endStr },
    aggs: aggsField,
    total: Number(data?.total ?? recordList.length),
    count: Number(data?.count ?? 0),
    totalUv: Number(data?.totalUv ?? 0),
    records: aggsField === 'no' ? recordList.map(r => normalizeQueryLogItem(r, slim)) : recordList
  };
}

export async function getArmsErrorsSummary(projectId, {
  date = new Date().toISOString(),
  env = 'production',
  kind = 'all', // 'all' | 'runtime' | 'resource' | 'white-screen'
  errorId = null,
  sourceType = '',
  page = 1,
  size = 20,
  time = '3d',
  from = null,
  to = null,
  ...apiOpts
} = {}) {
  const normEnv = normalizeArmsEnv(env);
  const result = { env: normEnv, kind };

  if (errorId) {
    const { data, authUsed } = await executeArmsApi({
      path: `/project/${projectId}/api/error/v2/error/detail`,
      method: 'POST',
      postBody: { date, env: normEnv, errorId },
      ...apiOpts
    });
    result.authUsed = authUsed;
    result.errorDetail = data;
    return result;
  }

  if (kind === 'all' || kind === 'runtime') {
    const [totalRes, typeRes, ...ispList] = await Promise.all([
      executeArmsApi({
        path: `/project/${projectId}/api/error/v2/distribution/total`,
        method: 'POST',
        postBody: { date, env: normEnv, typeList: DEFAULT_RUNTIME_ERROR_TYPES },
        ...apiOpts
      }),
      executeArmsApi({
        path: `/project/${projectId}/api/error/v2/distribution/type`,
        method: 'POST',
        postBody: { date, env: normEnv, typeList: DEFAULT_RUNTIME_ERROR_TYPES },
        ...apiOpts
      }),
      ...DEFAULT_RUNTIME_ERROR_TYPES.map(errType =>
        executeArmsApi({
          path: `/project/${projectId}/api/error/v2/distribution/isp`,
          method: 'POST',
          postBody: { date, type: errType, env: normEnv },
          ...apiOpts
        }).then(r => ({ errorType: errType, items: Array.isArray(r.data) ? r.data : [], authUsed: r.authUsed }))
      )
    ]);
    result.authUsed = totalRes.authUsed;
    result.runtime = {
      overview: totalRes.data || {},
      byType: Array.isArray(typeRes.data) ? typeRes.data : [],
      topByCategory: ispList.map(g => ({
        errorType: g.errorType,
        items: g.items.slice(0, Number(size) || 20)
      }))
    };
  }

  if (kind === 'all' || kind === 'resource') {
    const resErr = await executeArmsApi({
      path: `/project/${projectId}/api/resource/error/day`,
      method: 'POST',
      postBody: { date: '', sourceType: sourceType || '', env: normEnv },
      ...apiOpts
    });
    result.authUsed = result.authUsed || resErr.authUsed;
    result.resource = {
      total: resErr.data?.total ?? 0,
      pvTotal: resErr.data?.pvTotal ?? 0,
      uvTotal: resErr.data?.uvTotal ?? 0,
      list: (resErr.data?.list || []).slice(0, Number(size) || 20)
    };
  }

  if (kind === 'all' || kind === 'white-screen') {
    const range = resolveTimeRange({ time, from, to });
    const wsRes = await executeArmsApi({
      path: `/project/${projectId}/api/white_screen/log/list`,
      method: 'POST',
      postBody: {
        projectId: String(projectId),
        current_page: Number(page) || 1,
        pageSize: Number(size) || 20,
        start_at: range.startAt,
        end_at: range.endAt,
        env: normEnv,
        scence: ''
      },
      ...apiOpts
    });
    result.authUsed = result.authUsed || wsRes.authUsed;
    const list = Array.isArray(wsRes.data?.list) ? wsRes.data.list : [];
    result.whiteScreen = {
      total: wsRes.data?.pager?.total ?? list.length,
      list: list.map(item => {
        const extra = parseExtraPayload(item.extra);
        return {
          time: formatArmsTimestamp(item.time_ms || item.time || ''),
          url: item.detail?.url || '',
          reason: extra.reasonText || extra.scence || '',
          loadTimeMs: extra.loadTime ?? null,
          detectTimeMs: extra.detectTime ?? null,
          viewId: item.viewId || ''
        };
      })
    };
  }

  return result;
}

export function normalizeTraceEvents(rawList = []) {
  const sorted = [...rawList].sort((a, b) => {
    const ta = new Date(String(a.time_ms || a.time || 0)).getTime() || Number(a.time_ms || a.time || 0);
    const tb = new Date(String(b.time_ms || b.time || 0)).getTime() || Number(b.time_ms || b.time || 0);
    return ta - tb;
  });

  const events = [];
  for (const item of sorted) {
    const common = item.common || {};
    const detail = item.detail || {};
    const extra = parseExtraPayload(item.extra);
    const rawDesc = extra.desc || extra.message || (typeof item.extra === 'string' && item.extra !== '{}' ? item.extra : '');
    const cleanDesc = rawDesc === '{"param":"","msg":"OK","body":"","resp":""}' ? '' : rawDesc;
    const event = {
      time: formatArmsTimestamp(item.time_ms || item.time || ''),
      type: item.type || '',
      code: item.code,
      subType: detail.error_no || detail.subType || '',
      url: detail.url || '',
      httpCode: detail.http_code ?? null,
      duringMs: detail.during_ms ?? null,
      desc: cleanDesc,
      value: extra.value ?? extra.duration ?? detail.during_ms ?? null,
      pageType: common.page_type || '',
      viewId: item.viewId || '',
      uuid: common.uuid || '',
      ucid: common.ucid || ''
    };
    const prev = events[events.length - 1];
    if (
      prev &&
      prev.time === event.time &&
      prev.type === event.type &&
      prev.subType === event.subType &&
      prev.url === event.url &&
      prev.desc === event.desc &&
      prev.httpCode === event.httpCode
    ) {
      prev.repeatCount = (prev.repeatCount || 1) + 1;
    } else {
      events.push({ ...event, repeatCount: 1 });
    }
  }

  const first = sorted[0] || {};
  const firstCommon = first.common || {};
  const firstUa = first.ua || {};
  return {
    meta: {
      viewId: first.viewId || '',
      uuid: firstCommon.uuid || '',
      ucid: firstCommon.ucid || '',
      sessionId: firstCommon.sid || '',
      pageType: firstCommon.page_type || '',
      url: first.detail?.url || '',
      version: firstCommon.runtime_version || firstCommon.version || '',
      sdkVersion: firstCommon.sdk_version || '',
      ip: first.ip || '',
      isp: firstCommon.isp || '',
      region: [first.country, first.province, first.city].filter(Boolean).join('-') || '-',
      os: firstUa.os ? `${firstUa.os.name || ''}-${firstUa.os.version || ''}` : '',
      browser: firstUa.browser ? `${firstUa.browser.name || ''}-${firstUa.browser.version || ''}` : '',
      device: firstUa.device ? `${firstUa.device.vendor || ''}-${firstUa.device.model || ''}` : ''
    },
    rawCount: rawList.length,
    events,
    errors: events.filter(e => e.type === 'error' || (e.httpCode !== null && e.httpCode >= 400) || (e.httpCode === 0 && e.url && e.duringMs > 0)),
    slowOrFailedApis: events.filter(e => e.url && (e.duringMs > 1000 || (e.httpCode !== null && e.httpCode !== 200 && e.httpCode !== 0) || (e.type === 'api' && e.httpCode === 0)))
  };
}

export async function traceArmsViewId(projectId, {
  viewId,
  time = '7d',
  from = null,
  to = null,
  type = 'ViewId',
  page = 1,
  size = 1000,
  ...apiOpts
} = {}) {
  if (!viewId) throw new Error('请提供要追踪的 viewId');
  const range = resolveTimeRange({ time, from, to });
  const { data, authUsed } = await executeArmsApi({
    path: `/project/${projectId}/api/white_screen/view_id/log/list`,
    method: 'POST',
    postBody: {
      start_at: range.startAt,
      end_at: range.endAt,
      currentPage: Number(page) || 1,
      pageSize: Number(size) || 1000,
      type,
      id: String(viewId).trim()
    },
    ...apiOpts
  });
  const list = Array.isArray(data?.list) ? data.list : [];
  return {
    authUsed,
    total: data?.pager?.total ?? list.length,
    ...normalizeTraceEvents(list)
  };
}

export async function getArmsOverview(projectId, { projectType = 'h5', date = null, ...apiOpts } = {}) {
  const yesterday = new Date(Date.now() - 86400000);
  const targetDate = date || formatLocalDate(yesterday);
  const [aiOverview, scoreRes] = await Promise.all([
    executeArmsApi({
      path: '/api/aiMcp/project/overview',
      method: 'GET',
      params: { projectKey: projectId },
      authMode: 'public',
      ...apiOpts
    }).catch(() => ({ data: null })),
    executeArmsApi({
      path: '/api/dashboard/score',
      method: 'GET',
      params: { projectId, projectType, date: targetDate },
      ...apiOpts
    }).catch(() => ({ data: null }))
  ]);

  return {
    authUsed: scoreRes.authUsed || 'public',
    date: targetDate,
    overview: aiOverview.data || null,
    healthScore: scoreRes.data || null
  };
}

export async function getArmsPerformance(projectId, {
  days = 7,
  metric = 'LCP',
  env = 'production',
  date = new Date().toISOString(),
  size = 15,
  ...apiOpts
} = {}) {
  const metricUpper = String(metric || 'LCP').toUpperCase();
  const metricCode = ARMS_PERF_METRICS[metricUpper] || ARMS_PERF_METRICS.LCP;
  const normEnv = normalizeArmsEnv(env);

  const [avgRes, trendRes, pageCodeRes] = await Promise.all([
    executeArmsApi({
      path: `/project/${projectId}/api/summary/days/all/avg`,
      method: 'POST',
      postBody: { start_at: Math.max(1, Number(days) - 1) },
      ...apiOpts
    }),
    executeArmsApi({
      path: `/project/${projectId}/api/summary/perfect/per75/list`,
      method: 'POST',
      postBody: { start_at: Number(days) || 7, code: metricCode },
      ...apiOpts
    }),
    executeArmsApi({
      path: `/project/${projectId}/api/summary/perfect/percent/code`,
      method: 'POST',
      postBody: { start_at: date, env: normEnv, code: metricCode },
      ...apiOpts
    })
  ]);

  const scaleDown = v => (Number.isFinite(Number(v)) ? Number((Number(v) / 1000).toFixed(3)) : v);
  const rawSummary = avgRes.data || {};
  const summary = {
    ...rawSummary,
    tbtAvg: scaleDown(rawSummary.tbtAvg),
    ttfbAvg: scaleDown(rawSummary.ttfbAvg),
    clsAvg: scaleDown(rawSummary.clsAvg),
    lcpAvg: scaleDown(rawSummary.lcpAvg),
    fidAvg: scaleDown(rawSummary.fidAvg),
    fcpAvg: scaleDown(rawSummary.fcpAvg),
    inpAvg: scaleDown(rawSummary.inpAvg)
  };
  const per75Trend = (Array.isArray(trendRes.data) ? trendRes.data : []).map(row => {
    const valKey = Object.keys(row).find(k => k.endsWith('_avg'));
    return {
      ...row,
      ...(valKey ? { [valKey]: scaleDown(row[valKey]) } : {})
    };
  });
  const pageList = Array.isArray(pageCodeRes.data) ? pageCodeRes.data.slice(0, Number(size) || 15) : [];
  return {
    authUsed: avgRes.authUsed,
    metric: metricUpper,
    metricCode,
    env: normEnv,
    summary,
    per75Trend,
    topPages: pageList.map(p => ({
      pageType: p.key,
      count: p.doc_count,
      pv: p.pv?.value ?? 0,
      uv: p.uv?.value ?? 0,
      p50: p.percent?.values?.['50.0'] ?? null,
      p75: p.percent?.values?.['75.0'] ?? null,
      p90: p.percent?.values?.['90.0'] ?? null
    }))
  };
}

export async function getArmsApiMetrics(projectId, {
  time = '24h',
  from = null,
  to = null,
  url = '',
  env = 'production',
  failedOnly = false,
  minSpent = 0,
  page = 1,
  size = 30,
  ...apiOpts
} = {}) {
  const range = resolveTimeRange({ time: time === '2h' ? '24h' : time, from, to });
  const normEnv = normalizeArmsEnv(env);

  const [distRes, rawRes] = await Promise.all([
    executeArmsApi({
      path: `/project/${projectId}/api/interface/url/distribution`,
      method: 'GET',
      params: { startAt: range.startAt, endAt: range.endAt, url, env: normEnv },
      ...apiOpts
    }),
    executeArmsApi({
      path: `/project/${projectId}/api/interface/raw/log`,
      method: 'GET',
      params: {
        size: (failedOnly || minSpent > 0) ? Math.max((Number(size) || 30) * 5, 100) : (Number(size) || 30),
        page: Number(page) || 1,
        startAt: range.startAt,
        endAt: range.endAt,
        url,
        env: normEnv
      },
      ...apiOpts
    })
  ]);

  let distribution = Array.isArray(distRes.data) ? distRes.data : [];
  if (failedOnly) {
    distribution = distribution.filter(d => Number(d.failedCount || 0) > 0);
  }
  if (minSpent > 0) {
    distribution = distribution.filter(d => Number(d.spent || 0) >= minSpent);
  }

  let rawLogs = Array.isArray(rawRes.data?.result) ? rawRes.data.result : [];
  if (failedOnly) {
    rawLogs = rawLogs.filter(r => {
      const code = Number(r.detail?.http_code ?? 200);
      return code === 0 || code >= 400;
    });
  }
  if (minSpent > 0) {
    rawLogs = rawLogs.filter(r => Number(r.detail?.during_ms || 0) >= minSpent);
  }

  return {
    authUsed: distRes.authUsed,
    timeRange: { start: range.startStr, end: range.endStr },
    distribution: distribution.slice(0, Number(size) || 30),
    rawTotal: rawRes.data?.total ?? rawLogs.length,
    rawLogs: rawLogs.slice(0, Number(size) || 30).map(r => ({
      time: formatArmsTimestamp(r.time_ms || r.time || ''),
      apiUrl: r.detail?.url || '',
      httpCode: r.detail?.http_code ?? null,
      duringMs: r.detail?.during_ms ?? null,
      pageType: r.common?.page_type || '',
      viewId: r.viewId || '',
      ucid: r.common?.ucid || '',
      isp: r.common?.isp || ''
    }))
  };
}

export async function getArmsPvuv(projectId, { startAt = null, endAt = null, size = 20, ...apiOpts } = {}) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const start = startAt || formatLocalDate(yesterday);
  const end = endAt || formatLocalDate(now);

  const [pagesRes, dailyRes] = await Promise.all([
    executeArmsApi({
      path: `/project/${projectId}/api/data/query/pv/pages`,
      method: 'GET',
      params: { start_at: start, end_at: end },
      ...apiOpts
    }),
    executeArmsApi({
      path: `/project/${projectId}/api/data/query/dailySummary`,
      method: 'GET',
      ...apiOpts
    }).catch(() => ({ data: null }))
  ]);

  const pages = Array.isArray(pagesRes.data?.page) ? pagesRes.data.page : [];
  return {
    authUsed: pagesRes.authUsed,
    startAt: start,
    endAt: end,
    dailySummary: dailyRes.data || null,
    pages: pages.slice(0, Number(size) || 20)
  };
}

export { saveArmsApiKey, saveArmsCookie, loadArmsApiKey, loadArmsCookie };
