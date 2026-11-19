import { requestHttp } from './http.js';
import { loadBaigeCookie, saveBaigeCookie } from './credentials.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';

export const BAIGE_HOSTS = {
  test: {
    protocol: 'http:',
    hostname: 'life-fe-baige-node.offline-beta.ttb.test.ke.com',
    port: 80,
    portalUrl: 'http://life-fe-baige-node.offline-beta.ttb.test.ke.com',
    label: '测试环境 (life-fe-baige-node.offline-beta.ttb.test.ke.com)'
  },
  preview: {
    protocol: 'http:',
    hostname: 'preview.baige.ke.com',
    port: 80,
    portalUrl: 'http://preview.baige.ke.com',
    label: '预发环境 (preview.baige.ke.com)'
  },
  prod: {
    protocol: 'https:',
    hostname: 'baige.ke.com',
    port: 443,
    portalUrl: 'https://baige.ke.com',
    label: '线上生产环境 (baige.ke.com)'
  }
};

export function normalizeEnv(env) {
  const norm = (env || 'prod').toLowerCase();
  if (norm === 'test' || norm === 'dev' || norm === 'offline-beta' || norm === 'qa') return 'test';
  if (norm === 'preview' || norm === 'prev' || norm === 'pre') return 'preview';
  return 'prod';
}

export function getBaigeHost(env) {
  const norm = normalizeEnv(env);
  return BAIGE_HOSTS[norm] || BAIGE_HOSTS.prod;
}

export function generatePortalUrl(env = 'prod', subPath = '') {
  const host = getBaigeHost(env);
  const cleanPath = subPath ? (subPath.startsWith('/') ? subPath : `/${subPath}`) : '';
  return `${host.portalUrl}${cleanPath}`;
}

export const isBaigeAuthFailure = res => {
  if (isLoginFailure(res)) return true;
  const status = res?.statusCode;
  if (status === 401) return true;
  if (status >= 300 && status < 400) {
    const loc = res?.headers?.location || '';
    if (/login\.ke\.com/i.test(loc)) return true;
  }
  if (res?.statusCode === 200 && typeof res?.raw === 'string' && /<html|<!doctype/i.test(res.raw)) {
    if (/login\.ke\.com|passport|统一登录|扫码登录|KOL/i.test(res.raw)) return true;
  }
  const body = res?.json || res?.data;
  if (body && typeof body === 'object') {
    if (body.code === 401 || body.status === 401) return true;
    if (body.code === 40301 || /未登录|请先登录|token.*invalid/i.test(body.message || '')) return true;
  }
  return false;
};

export const isBaigeSuccess = res => {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) return false;
  if (isBaigeAuthFailure(res)) return false;
  const body = res.json || res.data;
  if (body && typeof body === 'object') {
    if (body.success === true || body.code === 2000 || body.code === 200 || body.code === 0) return true;
  }
  return true;
};

const credentialSessions = new Map();

function getCredentialSession(env, explicitCookie) {
  const envKey = normalizeEnv(env);
  if (explicitCookie) {
    return createCredentialSession({
      load: () => explicitCookie,
      save: () => {},
      explicit: true,
      isAuthFailure: isBaigeAuthFailure,
      isSuccess: isBaigeSuccess
    });
  }
  let session = credentialSessions.get(envKey);
  if (!session) {
    const hostInfo = getBaigeHost(envKey);
    const envVar = envKey === 'test' ? 'BAIGE_TEST_COOKIE' : (envKey === 'preview' ? 'BAIGE_PREVIEW_COOKIE' : 'BAIGE_PROD_COOKIE');
    session = createCredentialSession({
      load: () => loadBaigeCookie({ env: envKey }),
      save: cookieStr => saveBaigeCookie({ env: envKey, cookieStr }),
      explicit: Boolean(process.env[envVar]),
      isAuthFailure: isBaigeAuthFailure,
      isSuccess: isBaigeSuccess,
      names: ['security_ticket', 'security_ticket_test', 'login_ucid', 'lianjia_uuid', 'lianjia_ssid', 'crosSdkDT2019DeviceId']
    });
    credentialSessions.set(envKey, session);
  }
  return session;
}

/**
 * 执行白鸽网关 REST API 请求
 */
export async function executeBaigeApi({
  path,
  method = 'GET',
  params = {},
  postBody = null,
  cookie = null,
  setCookie = null,
  env = 'prod',
  isReadOnly = true
} = {}) {
  const envKey = normalizeEnv(env);
  const hostInfo = getBaigeHost(envKey);

  // 🛡️ 风控物理拦截：预发与生产环境绝对禁止任何写操作与路由变更
  if (!isReadOnly) {
    if (envKey === 'prod' || envKey === 'preview') {
      throw new Error(`[风控物理拦截] 预发环境 (preview) 与生产环境 (prod) 严格物理禁止任何写操作与路由操作！所有网关配置/路由修改仅允许在测试环境 (test) 进行。`);
    }
  }

  if (setCookie) {
    saveBaigeCookie({ env: envKey, cookieStr: setCookie });
  }

  // 拼接 query string
  let fullPath = path;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        qs.append(k, String(v));
      }
    }
    const queryString = qs.toString();
    if (queryString) {
      fullPath += (fullPath.includes('?') ? '&' : '?') + queryString;
    }
  }

  const session = getCredentialSession(envKey, cookie || setCookie);
  const targetUrl = `${hostInfo.protocol}//${hostInfo.hostname}${fullPath}`;

  const res = await session.run(targetUrl, async (activeCookie) => {
    return requestHttp({
      protocol: hostInfo.protocol,
      hostname: hostInfo.hostname,
      port: hostInfo.port,
      path: fullPath,
      method: method.toUpperCase(),
      headers: {
        'Cookie': activeCookie,
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      }
    }, postBody);
  }, { readOnly: isReadOnly });

  if (isBaigeAuthFailure(res)) {
    throw new Error(`白鸽网关 ${hostInfo.label} 认证失败 (HTTP ${res.statusCode})，登录态已失效或未登录，请在浏览器中登录 ${hostInfo.portalUrl}。`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`白鸽网关 ${hostInfo.label} API 请求失败 (HTTP ${res.statusCode}): ${res.raw || res.error || '未知网络错误'}`);
  }

  const json = res.json || {};
  if (json.code !== undefined && json.code !== 2000 && json.code !== 200 && json.code !== 0 && !json.success) {
    throw new Error(`白鸽网关 ${hostInfo.label} 业务错误 [${json.code}]: ${json.message || '未知业务异常'}`);
  }

  return json.data !== undefined ? json.data : json;
}

// ==================== 应用/服务管理 API ====================

/**
 * 分页与关键词检索服务列表
 */
export async function listApplications({
  keyWord = '',
  currentPage = 1,
  pageSize = 20,
  env = 'prod',
  cookie = null
} = {}) {
  const params = {
    currentPage,
    pageSize
  };
  if (keyWord) {
    params.keyWord = keyWord;
  }
  return executeBaigeApi({
    path: '/api/gatewayConfig/application/list',
    method: 'GET',
    params,
    env,
    cookie,
    isReadOnly: true
  });
}

/**
 * 查询服务详情
 */
export async function getApplicationDetail(id, { env = 'prod', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/application/detail',
    method: 'GET',
    params: { id },
    env,
    cookie,
    isReadOnly: true
  });
}

/**
 * 智能解析应用 ID：既支持纯数字 ID，也支持按 serviceId 自动反查
 */
export async function resolveApplication(idOrServiceId, { env = 'prod', cookie = null } = {}) {
  const str = String(idOrServiceId).trim();
  if (/^\d+$/.test(str)) {
    const detail = await getApplicationDetail(Number(str), { env, cookie });
    return detail;
  }
  // 按 serviceId 搜索
  const result = await listApplications({ keyWord: str, currentPage: 1, pageSize: 10, env, cookie });
  const list = result?.list || [];
  const exact = list.find(item => item.serviceId === str);
  if (exact) {
    return getApplicationDetail(exact.id, { env, cookie });
  }
  if (list.length === 1) {
    return getApplicationDetail(list[0].id, { env, cookie });
  }
  if (list.length > 1) {
    const candidates = list.map(item => `${item.serviceId} (ID: ${item.id}, 名称: ${item.serviceName})`).join('; ');
    throw new Error(`匹配到多个候选服务，请指定具体的 serviceId 或应用 ID：${candidates}`);
  }
  throw new Error(`未找到 serviceId 或 ID 为 "${str}" 的网关服务登记信息 (环境: ${env})`);
}

/**
 * 获取可登记的 serviceId 列表
 */
export async function listServiceIds({ env = 'prod', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/application/serviceIdList',
    method: 'GET',
    env,
    cookie,
    isReadOnly: true
  });
}

// ==================== 路由与路由组 API ====================

/**
 * 查询服务的路由组列表及关联子路由
 */
export async function listRouteGroups(applicationId, {
  currentPage = 1,
  pageSize = 50,
  env = 'prod',
  cookie = null
} = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/routeGroup/list',
    method: 'GET',
    params: {
      applicationId,
      currentPage,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

// ==================== 权限管理 API ====================

/**
 * 查询服务的已授权管理员列表
 */
export async function listAuthedUsers(serviceId, { env = 'prod', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/permission/authedUserList',
    method: 'GET',
    params: { serviceId },
    env,
    cookie,
    isReadOnly: true
  });
}

/**
 * 查询当前登录账号在目标服务上的权限状态
 */
export async function getAuthStatus(serviceId, { env = 'prod', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/permission/authStatus',
    method: 'GET',
    params: { serviceId },
    env,
    cookie,
    isReadOnly: true
  });
}

// ==================== 变更与维护 API (测试/预发修改，生产参谋) ====================

/**
 * 添加服务授权管理员
 */
export async function addAuthedUser(serviceId, ucid, { env = 'test', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/permission/addAuthedUser',
    method: 'POST',
    postBody: {
      serviceId,
      ucid: Number(ucid)
    },
    env,
    cookie,
    isReadOnly: false
  });
}

/**
 * 删除服务授权管理员
 */
export async function deleteAuthedUser(serviceId, ucid, { env = 'test', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/permission/deleteAuthedUser',
    method: 'POST',
    postBody: {
      serviceId,
      ucid: Number(ucid)
    },
    env,
    cookie,
    isReadOnly: false
  });
}

/**
 * 更新服务域名列表
 */
export async function updateDomain(id, domainList = [], { env = 'test', cookie = null } = {}) {
  return executeBaigeApi({
    path: '/api/gatewayConfig/application/updateDomain',
    method: 'POST',
    postBody: {
      id: Number(id),
      domainList
    },
    env,
    cookie,
    isReadOnly: false
  });
}
