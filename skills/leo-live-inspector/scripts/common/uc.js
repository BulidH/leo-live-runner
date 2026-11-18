import { requestHttp } from './http.js';
import { loadUcCookie, saveUcCookie } from './credentials.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';

export const UC_HOSTS = {
  test: {
    protocol: 'http:',
    adminHost: 'test3-uc.admin.ke.com',
    relationHost: 'test-uc-relation-admin.ke.com',
    manageOrigin: 'https://test3-manage.lianjia.com',
    port: 80,
    portalUrl: 'http://test3-uc.admin.ke.com',
    relationUrl: 'http://test-uc-relation-admin.ke.com',
    label: '测试环境 (test3-uc.admin.ke.com)'
  }
};

export const EVENT_REASON_TYPES = {
  ROLE_ASSIGN: ['TEM', 'HIR', 'RHIR', 'SEC', 'PJA'],
  ROLE_TRANSFER: ['OTF', 'FTO', 'WIO', 'WIF']
};

export function normalizeEnv(env) {
  const norm = String(env || 'test').toLowerCase().trim();
  if (norm === 'prod' || norm === 'production' || norm === 'online') return 'prod';
  return 'test';
}

export function getUcHost(env = 'test') {
  const norm = normalizeEnv(env);
  if (!UC_HOSTS[norm]) {
    throw new Error(`UC 暂未配置 [${norm}] 环境地址，当前仅支持测试环境 (-e test)`);
  }
  return UC_HOSTS[norm];
}

export function generateUcPortalUrl(env = 'test', subPath = '/memberMessage', queryParams = {}) {
  const host = getUcHost(env);
  const cleanPath = subPath ? (subPath.startsWith('/') ? subPath : `/${subPath}`) : '/memberMessage';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams || {})) {
    if (v !== undefined && v !== null && v !== '') {
      qs.append(k, String(v));
    }
  }
  const qsStr = qs.toString();
  return `${host.portalUrl}${cleanPath}${qsStr ? `?${qsStr}` : ''}`;
}

export const isUcAuthFailure = (res) => {
  if (isLoginFailure(res)) return true;
  const status = res?.statusCode;
  if (status === 401 || status === 910000) return true;
  if (status >= 300 && status < 400) {
    const loc = res?.headers?.location || '';
    if (/login\.ke\.com|\/login/i.test(loc)) return true;
  }
  const body = res?.json || res?.data;
  if (body && typeof body === 'object') {
    if (body.code === 401 || body.code === 910000 || body.status === 401) return true;
    const msg = decodeURIComponent(String(body.msg || body.message || '')).toLowerCase();
    if (/未登陆|未登录|请先登录|登录信息失效|登陆已过期/.test(msg)) return true;
    if (Array.isArray(body.errors) && body.errors.some(e => /401|未登录|未登陆|login/i.test(e.message || ''))) {
      return true;
    }
  }
  return false;
};

export const isUcSuccess = (res) => {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) return false;
  if (isUcAuthFailure(res)) return false;
  const body = res.json || res.data;
  if (body && typeof body === 'object') {
    if (body.data !== undefined && !body.code) return true; // GraphQL response
    if (body.code === 0 || body.code === 200 || body.code === 100000 || body.errno === 0) return true;
    if (body.code !== undefined && body.code !== 0 && body.code !== 200 && body.code !== 100000) return false;
  }
  return true;
};

const credentialSessions = new Map();
const operatorCache = new Map();

function getCredentialSession(env = 'test', explicitCookie = null) {
  const envKey = normalizeEnv(env);
  const hostInfo = getUcHost(envKey);
  if (explicitCookie) {
    return createCredentialSession({
      load: () => explicitCookie,
      save: () => {},
      explicit: true,
      isAuthFailure: isUcAuthFailure,
      isSuccess: isUcSuccess,
      preflight: async ({ run }) => {
        await run(`${hostInfo.portalUrl}/graphql`, async (ck) => requestHttp({
          protocol: hostInfo.protocol,
          hostname: hostInfo.adminHost,
          port: hostInfo.port,
          path: '/graphql',
          method: 'POST',
          headers: {
            Cookie: ck,
            'Content-Type': 'application/json;charset=UTF-8',
            Accept: 'application/json'
          }
        }, { query: '{ getAllUcCity { cityCode } }' }), { readOnly: true });
      }
    });
  }

  let session = credentialSessions.get(envKey);
  if (!session) {
    const envVar = envKey === 'prod' ? 'UC_PROD_COOKIE' : 'UC_TEST_COOKIE';
    session = createCredentialSession({
      load: () => loadUcCookie({ env: envKey }),
      save: cookieStr => saveUcCookie({ env: envKey, cookieStr }),
      explicit: Boolean(process.env[envVar]),
      isAuthFailure: isUcAuthFailure,
      isSuccess: isUcSuccess,
      names: [
        'sso_login_token',
        'security_ticket',
        'security_ticket_test',
        'login_ucid',
        'lianjia_uuid',
        'lianjia_ssid',
        'crosSdkDT2019DeviceId',
        'prd-assistant-token-prod'
      ],
      preflight: async ({ run }) => {
        await run(`${hostInfo.portalUrl}/graphql`, async (ck) => requestHttp({
          protocol: hostInfo.protocol,
          hostname: hostInfo.adminHost,
          port: hostInfo.port,
          path: '/graphql',
          method: 'POST',
          headers: {
            Cookie: ck,
            'Content-Type': 'application/json;charset=UTF-8',
            Accept: 'application/json'
          }
        }, { query: '{ getAllUcCity { cityCode } }' }), { readOnly: true });
      }
    });
    credentialSessions.set(envKey, session);
  }
  return session;
}

export function assertUcWritePermitted(env = 'test') {
  const envKey = normalizeEnv(env);
  if (envKey === 'prod') {
    throw new Error('[风控物理拦截] 线上生产环境 (prod) 严格物理禁止任何 UC 写操作与角色/关系变更！所有修改仅允许在测试环境 (test) 进行。');
  }
}

/**
 * 格式化 GraphQL 内联参数对象 (兼容 UC 后端 GraphQL 语法)
 */
export function formatGqlArgs(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${v}`);
    } else if (k === 'ucid' && /^\d+$/.test(String(v).trim())) {
      parts.push(`${k}: ${String(v).trim()}`);
    } else {
      parts.push(`${k}: ${JSON.stringify(String(v).trim())}`);
    }
  }
  return parts.join(', ');
}

/**
 * 执行 UC GraphQL 请求 (POST /graphql)
 */
export async function executeUcGraphQL({
  query,
  variables = {},
  operationName = null,
  env = 'test',
  cookie = null,
  setCookie = null,
  isReadOnly = undefined,
  requestFn = requestHttp
} = {}) {
  const envKey = normalizeEnv(env);
  const hostInfo = getUcHost(envKey);
  const readOnly = isReadOnly !== undefined ? isReadOnly : !/^\s*mutation\b/i.test(query);

  if (!readOnly) {
    assertUcWritePermitted(envKey);
  }

  if (setCookie) {
    saveUcCookie({ env: envKey, cookieStr: setCookie });
  }

  const session = getCredentialSession(envKey, cookie || setCookie);
  const targetUrl = `${hostInfo.portalUrl}/graphql`;
  const postBody = { operationName, variables, query };

  const res = await session.run(targetUrl, async (activeCookie) => {
    return requestFn({
      protocol: hostInfo.protocol,
      hostname: hostInfo.adminHost,
      port: hostInfo.port,
      path: '/graphql',
      method: 'POST',
      timeout: 15000,
      headers: {
        Cookie: activeCookie,
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json'
      }
    }, postBody);
  }, { readOnly });

  if (isUcAuthFailure(res)) {
    throw new Error(`UC ${hostInfo.label} 认证失败，登录态已失效或未登录，请在 Chrome 中登录 ${hostInfo.portalUrl} 后重试。`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`UC ${hostInfo.label} GraphQL 请求失败 (HTTP ${res.statusCode}): ${res.raw || res.error || '未知网络错误'}`);
  }

  const json = res.json || {};
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msgs = json.errors.map(e => e.message).join('; ');
    throw new Error(`UC ${hostInfo.label} GraphQL 业务错误: ${msgs}`);
  }

  return json.data;
}

/**
 * 执行 UC 本域 REST API 请求 (test3-uc.admin.ke.com 下的 /api/*, /orgTag*, /server/*)
 */
export async function executeUcAdminApi({
  path,
  method = 'GET',
  params = {},
  postBody = null,
  env = 'test',
  cookie = null,
  setCookie = null,
  isReadOnly = true,
  requestFn = requestHttp
} = {}) {
  const envKey = normalizeEnv(env);
  const hostInfo = getUcHost(envKey);

  if (!isReadOnly) {
    assertUcWritePermitted(envKey);
  }

  if (setCookie) {
    saveUcCookie({ env: envKey, cookieStr: setCookie });
  }

  let fullPath = path.startsWith('/') ? path : `/${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      if (Array.isArray(v)) {
        qs.append(k, v.join(','));
      } else {
        qs.append(k, String(v));
      }
    }
  }
  const qsStr = qs.toString();
  if (qsStr) {
    fullPath += (fullPath.includes('?') ? '&' : '?') + qsStr;
  }

  const session = getCredentialSession(envKey, cookie || setCookie);
  const targetUrl = `${hostInfo.portalUrl}${fullPath}`;

  const res = await session.run(targetUrl, async (activeCookie) => {
    return requestFn({
      protocol: hostInfo.protocol,
      hostname: hostInfo.adminHost,
      port: hostInfo.port,
      path: fullPath,
      method: method.toUpperCase(),
      timeout: 15000,
      headers: {
        Cookie: activeCookie,
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
      }
    }, postBody);
  }, { readOnly: isReadOnly });

  if (isUcAuthFailure(res)) {
    throw new Error(`UC ${hostInfo.label} 认证失败，请在 Chrome 中登录 ${hostInfo.portalUrl} 后重试。`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`UC ${hostInfo.label} 接口请求失败 [${fullPath}] (HTTP ${res.statusCode}): ${res.raw || res.error || '未知错误'}`);
  }

  const json = res.json;
  if (json && typeof json === 'object') {
    if (json.code !== undefined && json.code !== 0 && json.code !== 200 && json.code !== 100000 && json.errno !== 0) {
      const msg = decodeURIComponent(String(json.msg || json.message || json.errmsg || '未知业务异常'));
      throw new Error(`UC ${hostInfo.label} 业务错误 [${json.code}]: ${msg}`);
    }
    return json.data !== undefined ? json.data : json;
  }
  return res.raw;
}

/**
 * 执行 UC 关系与角色管理中心 REST API 请求 (test-uc-relation-admin.ke.com)
 */
export async function executeUcRelationApi({
  path,
  method = 'GET',
  params = {},
  postBody = null,
  env = 'test',
  cookie = null,
  setCookie = null,
  isReadOnly = true,
  requestFn = requestHttp
} = {}) {
  const envKey = normalizeEnv(env);
  const hostInfo = getUcHost(envKey);

  if (!isReadOnly) {
    assertUcWritePermitted(envKey);
  }

  if (setCookie) {
    saveUcCookie({ env: envKey, cookieStr: setCookie });
  }

  let fullPath = path.startsWith('/') ? path : `/${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      if (Array.isArray(v)) {
        qs.append(k, v.join(','));
      } else {
        qs.append(k, String(v));
      }
    }
  }
  const qsStr = qs.toString();
  if (qsStr) {
    fullPath += (fullPath.includes('?') ? '&' : '?') + qsStr;
  }

  const session = getCredentialSession(envKey, cookie || setCookie);
  // Use portalUrl for credential relay domain matching (.ke.com), then call relationHost
  const targetUrl = `${hostInfo.portalUrl}/memberMessage`;

  const res = await session.run(targetUrl, async (activeCookie) => {
    return requestFn({
      protocol: hostInfo.protocol,
      hostname: hostInfo.relationHost,
      port: hostInfo.port,
      path: fullPath,
      method: method.toUpperCase(),
      timeout: 15000,
      headers: {
        Cookie: activeCookie,
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: hostInfo.portalUrl,
        Referer: `${hostInfo.portalUrl}/`
      }
    }, postBody);
  }, { readOnly: isReadOnly });

  if (isUcAuthFailure(res)) {
    throw new Error(`UC 关系中心 (${hostInfo.relationHost}) 认证失败，请在 Chrome 中登录 ${hostInfo.portalUrl} 后重试。`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`UC 关系中心接口请求失败 [${fullPath}] (HTTP ${res.statusCode}): ${res.raw || res.error || '未知错误'}`);
  }

  const json = res.json || {};
  if (json.code !== undefined && json.code !== 0 && json.code !== 200 && json.code !== 100000 && json.errno !== 0) {
    const msg = decodeURIComponent(String(json.msg || json.message || json.errmsg || '未知业务异常'));
    throw new Error(`UC 关系中心业务错误 [${json.code}]: ${msg}`);
  }

  return json.data !== undefined ? json.data : json;
}

// ==================== 当前登录管理员上下文 (whoami) ====================

export async function getCurrentOperator({ env = 'test', cookie = null, forceRefresh = false, requestFn = requestHttp } = {}) {
  const envKey = normalizeEnv(env);
  if (!forceRefresh && operatorCache.has(envKey)) {
    return operatorCache.get(envKey);
  }

  const hostInfo = getUcHost(envKey);
  const session = getCredentialSession(envKey, cookie);
  let activeCookieStr = '';

  try {
    const res = await session.run(`${hostInfo.portalUrl}/memberMessage`, async (activeCookie) => {
      activeCookieStr = activeCookie || '';
      return requestFn({
        protocol: hostInfo.protocol,
        hostname: hostInfo.adminHost,
        port: hostInfo.port,
        path: '/memberMessage',
        method: 'GET',
        timeout: 10000,
        headers: {
          Cookie: activeCookie,
          Accept: 'text/html,application/xhtml+xml'
        }
      });
    }, { readOnly: true });

    const html = typeof res.raw === 'string' ? res.raw : '';
    const userInfoMatch = html.match(/window\.userInfo\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
    const userCodeMatch = html.match(/var\s+userCode\s*=\s*['"]?(\d+)['"]?/);
    if (userInfoMatch) {
      const userInfo = JSON.parse(userInfoMatch[1]);
      const operator = {
        userCode: String(userInfo.userCode || (userCodeMatch && userCodeMatch[1]) || ''),
        userId: userInfo.userId || (userInfo.userCode ? `10000000${userInfo.userCode}` : null),
        userName: userInfo.userName || '',
        currentRoleId: userInfo.currentRoleId,
        roleId: userInfo.currentRole?.id || 'super_administrator',
        currentRole: userInfo.currentRole || null,
        ucRoleList: userInfo.ucRoleList || [],
        allExts: userInfo.allExts || {},
        currentRolePermissions: userInfo.currentRolePermissions || [],
        allPerms: userInfo.allPerms || []
      };
      operatorCache.set(envKey, operator);
      return operator;
    }
  } catch {}

  // Fallback: extract from login_ucid cookie
  const rawCookie = activeCookieStr || cookie || loadUcCookie({ env: envKey }) || '';
  const m = rawCookie.match(/login_ucid=(\d+)/);
  const ucid = m ? m[1] : '';
  const userCode = ucid.startsWith('10000000') ? ucid.slice(8) : ucid;
  return {
    userCode: userCode || '',
    userId: ucid || '',
    userName: '',
    currentRoleId: 2,
    roleId: 'super_administrator',
    currentRole: { id: 'super_administrator', name: '超级管理员' },
    ucRoleList: [],
    allExts: {},
    currentRolePermissions: [],
    allPerms: []
  };
}

// ==================== GraphQL Sug 联想与基础字典 ====================

export async function getUserSug(keyword, {
  pageSize = 50,
  status = undefined,
  onlyMain = 'true',
  sortByStatus = 1,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({ keyword, pageSize, status, onlyMain, sortByStatus });
  const query = `{
    getUserSug(${args}) {
      ucid
      usercode
      userName
      nickName
      orgName
      orgcode
      officeAddress
      ucPositionCode
      record
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getUserSug || [];
}

export async function getCitySug(keyword, { size = 20, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ keyword, size });
  const query = `{
    getCitySug(${args}) {
      id
      cityCode
      name
      postCode
      status
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getCitySug || [];
}

export async function getOrgSug(keyword, { size = 30, orgType = undefined, status = 2, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ keyword, size, orgType, status });
  const query = `{
    getOrgSug(${args}) {
      orgCode
      orgName
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getOrgSug || [];
}

export async function getCompSug(keyword, { size = 30, officeAddress = undefined, forCompPage = 0, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ keyword, size, officeAddress, forCompPage });
  const query = `{
    getCompSug(${args}) {
      orgCode
      orgName
      danWei
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getCompSug || [];
}

export async function getUcPositionByKeyword(keyword, { pageSize = 30, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ keyword, pageSize });
  const query = `{
    getUcPositionByKeyword(${args}) {
      positionName
      positionCode
      description
      dutyId
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getUcPositionByKeyword || [];
}

export async function getAllUcCity({ env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const query = `{
    getAllUcCity {
      id
      cityCode
      postCode
      shortname
      name
      status
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getAllUcCity || [];
}

export async function getUcCityVO(officeAddress, { env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ officeAddress });
  const query = `{
    getUcCityVO(${args}) {
      id
      cityCode
      postCode
      shortname
      name
      status
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getUcCityVO || null;
}

export async function getBusinessModeList({ env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const query = `{
    getBusinessModeList {
      businessModeCode
      businessModeName
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getBusinessModeList || [];
}

// ==================== 智能编码解析器 (名称自动转编码) ====================

export async function resolveCityCode(cityInput, { env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  if (!cityInput) return null;
  const str = String(cityInput).trim();
  if (/^\d{4,6}$/.test(str)) {
    return { cityCode: str, name: str };
  }
  const list = await getCitySug(str, { env, cookie, executeGql });
  const exact = list.find(c => c.name === str || c.cityCode === str || c.name === `${str}市` || c.name.replace(/市$/, '') === str.replace(/市$/, ''));
  if (exact) return exact;
  if (list.length > 0) return list[0];
  throw new Error(`无法解析城市 "${str}"，未找到匹配的城市编码`);
}

export async function resolvePositionCode(posInput, { env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  if (!posInput) return null;
  const str = String(posInput).trim();
  if (/^\d+$/.test(str)) {
    const list = await getUcPositionByKeyword(str, { env, cookie, executeGql });
    const exact = list.find(p => String(p.positionCode) === str);
    return exact || { positionCode: str, positionName: str };
  }
  const list = await getUcPositionByKeyword(str, { env, cookie, executeGql });
  const exact = list.find(p => p.positionName === str || String(p.positionCode) === str);
  if (exact) return exact;
  if (list.length === 1) return list[0];
  if (list.length > 1) {
    return list[0];
  }
  throw new Error(`无法解析业务角色 "${str}"，未找到匹配的 UC 岗位角色编码`);
}

export async function resolveOrgCode(orgInput, { status = 2, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  if (!orgInput) return null;
  const str = String(orgInput).trim();
  // If purely alphanumeric/underscore code (like XFTJ8001, LW1059, ZZ_15_2606748)
  if (/^[A-Za-z0-9_.-]+$/.test(str) && !/^\d+$/.test(str)) {
    return { orgCode: str, orgName: str };
  }
  const list = await getOrgSug(str, { status, env, cookie, executeGql });
  const exact = list.find(o => o.orgCode === str || o.orgName === str);
  if (exact) return exact;
  if (list.length > 0) return list[0];
  return { orgCode: str, orgName: str };
}

// ==================== 人员查询、详情与调转事件 (GraphQL) ====================

export async function getEhrUserVOByPage({
  pageNo = 1,
  pageSize = 20,
  ucid = undefined,
  userCode = undefined,
  userName = undefined,
  phoneNumber = undefined,
  officeAddress = undefined,
  positionCode = undefined,
  status = undefined,
  userRecord = undefined,
  orgCode = undefined,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({
    pageNo,
    pageSize,
    ucid,
    userCode,
    userName,
    phoneNumber,
    officeAddress,
    positionCode,
    status,
    userRecord,
    orgCode
  });
  const query = `{
    getEhrUserVOByPage(${args}) {
      total
      pageNum
      pageSize
      list
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrUserVOByPage || { total: 0, pageNum: pageNo, pageSize, list: [] };
}

export async function getEhrUserVO(ucid, {
  status = undefined,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({ ucid, status });
  const query = `{
    getEhrUserVO(${args}) {
      id
      userCode
      status
      name
      userRecord
      avatar
      officeAddressName
      orgCode
      orgName
      superior
      jobCode
      email
      brandName
      compName
      mobile
      homePhone
      ehrLevelName
      ehrPositionName
      entryDate
      sex
      supervisorName
      superiorUcid
      positionName
      positionCode
      positionStatus
      dataSource
      uopId
      level
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrUserVO || [];
}

export async function getEhrUserEventQueueListByUcid(ucid, {
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({ ucid });
  const query = `{
    getEhrUserEventQueueListByUcid(${args}) {
      id
      userUcid
      eventType
      eventTypeName
      eventReason
      eventReasonName
      oldValue
      oldName
      newValue
      newName
      occurTime
      createTime
      positionName
      positionCode
      orgName
      orgCode
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrUserEventQueueListByUcid || [];
}

/**
 * 智能解析员工标识：支持 16位 UCID、8位系统号 userCode、姓名/关键词，具备同名消歧保护
 */
export async function resolveUcUser(identifier, {
  status = undefined,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const str = String(identifier || '').trim();
  if (!str) {
    throw new Error('请提供员工标识（16位 UCID、8位系统号 userCode 或姓名）');
  }

  // Case 1: 16-digit UCID (e.g. 1000000010138597)
  if (/^10000\d{11}$/.test(str)) {
    const records = await getEhrUserVO(str, { status, env, cookie, executeGql });
    if (records.length > 0) {
      const main = records.find(r => r.userRecord === 0) || records[0];
      return {
        matched: true,
        ucid: String(main.id),
        userCode: String(main.userCode),
        name: main.name,
        status: main.status,
        records
      };
    }
    const pageRes = await getEhrUserVOByPage({ pageNo: 1, pageSize: 20, ucid: str, env, cookie, executeGql });
    const list = pageRes?.list || [];
    if (list.length > 0) {
      const main = list[0];
      const fullRecords = await getEhrUserVO(String(main.id), { env, cookie, executeGql });
      return {
        matched: true,
        ucid: String(main.id),
        userCode: String(main.userCode),
        name: main.name,
        status: main.status,
        records: fullRecords.length > 0 ? fullRecords : list
      };
    }
    return { notFound: true, query: str };
  }

  // Case 2: 6~10 digit userCode (e.g. 26068546 or 10138597)
  if (/^\d{6,10}$/.test(str)) {
    const pageRes = await getEhrUserVOByPage({ pageNo: 1, pageSize: 20, userCode: str, env, cookie, executeGql });
    const list = pageRes?.list || [];
    if (list.length > 0) {
      const main = list[0];
      const ucid = String(main.id);
      const records = await getEhrUserVO(ucid, { env, cookie, executeGql });
      return {
        matched: true,
        ucid,
        userCode: String(main.userCode),
        name: main.name,
        status: main.status,
        records: records.length > 0 ? records : list
      };
    }
    // Try standard 10000000 + 8-digit userCode
    if (str.length === 8) {
      const candidateUcid = `10000000${str}`;
      const records = await getEhrUserVO(candidateUcid, { env, cookie, executeGql });
      if (records.length > 0) {
        const main = records.find(r => r.userRecord === 0) || records[0];
        return {
          matched: true,
          ucid: String(main.id),
          userCode: String(main.userCode),
          name: main.name,
          status: main.status,
          records
        };
      }
    }
    // Fallback to getUserSug (could be phone number or partial code)
    const sugList = await getUserSug(str, { pageSize: 20, env, cookie, executeGql });
    const exactCode = sugList.find(u => String(u.usercode) === str || String(u.ucid) === str);
    if (exactCode) {
      const records = await getEhrUserVO(String(exactCode.ucid), { env, cookie, executeGql });
      return {
        matched: true,
        ucid: String(exactCode.ucid),
        userCode: String(exactCode.usercode),
        name: exactCode.userName,
        status: records[0]?.status ?? null,
        records
      };
    }
    return { notFound: true, query: str };
  }

  // Case 3: Name / Email / Keyword
  const [pageRes, sugList] = await Promise.all([
    getEhrUserVOByPage({ pageNo: 1, pageSize: 50, userName: str, status, env, cookie, executeGql }).catch(() => ({ list: [] })),
    getUserSug(str, { pageSize: 50, env, cookie, executeGql }).catch(() => [])
  ]);

  const byUcid = new Map();
  for (const row of (pageRes?.list || [])) {
    if (row.name === str || String(row.userCode) === str) {
      const ucid = String(row.id);
      if (!byUcid.has(ucid)) {
        byUcid.set(ucid, {
          ucid,
          userCode: String(row.userCode || ''),
          name: row.name || '',
          orgName: row.orgName || '',
          orgCode: row.orgCode || '',
          officeAddressName: row.officeAddressName || '',
          positionName: row.positionName || row.jobName || '',
          positionCode: row.positionCode || '',
          status: row.status
        });
      }
    }
  }

  if (byUcid.size === 0) {
    for (const s of sugList) {
      const ucid = String(s.ucid);
      if (!byUcid.has(ucid)) {
        byUcid.set(ucid, {
          ucid,
          userCode: String(s.usercode || ''),
          name: s.userName || '',
          orgName: s.orgName || '',
          orgCode: s.orgcode || '',
          officeAddressName: s.officeAddress || '',
          positionName: '',
          positionCode: s.ucPositionCode || '',
          status: null
        });
      }
    }
  }

  const candidates = [...byUcid.values()];
  if (candidates.length === 0) {
    return { notFound: true, query: str };
  }

  if (candidates.length > 1) {
    return {
      ambiguous: true,
      query: str,
      candidates
    };
  }

  const chosen = candidates[0];
  const records = await getEhrUserVO(chosen.ucid, { env, cookie, executeGql });
  const main = records.find(r => r.userRecord === 0) || records[0] || chosen;
  return {
    matched: true,
    ucid: chosen.ucid,
    userCode: String(main.userCode || chosen.userCode),
    name: main.name || chosen.name,
    status: main.status ?? chosen.status,
    records
  };
}

/**
 * 员工全景画像查询 (并发聚合 GraphQL 职位/上级/事件 + 关系中心绑定角色与管辖范围)
 */
export async function getUserFullProfile(identifier, {
  env = 'test',
  cookie = null,
  includeEvents = true,
  executeGql = executeUcGraphQL,
  executeRel = executeUcRelationApi
} = {}) {
  const resolved = await resolveUcUser(identifier, { env, cookie, executeGql });
  if (resolved.notFound || resolved.ambiguous) {
    return resolved;
  }

  const { ucid, userCode, name, records } = resolved;
  const [relationRoles, lightRoles, events] = await Promise.all([
    executeRel({
      path: '/relation/queryAllUserRoleByUserCode',
      method: 'GET',
      params: { userCode },
      env,
      cookie,
      isReadOnly: true
    }).catch(() => []),
    executeRel({
      path: '/userRole/queryRoleForUser',
      method: 'GET',
      params: { userCode },
      env,
      cookie,
      isReadOnly: true
    }).catch(() => ({ roleList: [] })),
    includeEvents
      ? getEhrUserEventQueueListByUcid(ucid, { env, cookie, executeGql }).catch(() => [])
      : Promise.resolve([])
  ]);

  const mainRecord = records.find(r => r.userRecord === 0) || records[0] || {};
  const partTimeRecords = records.filter(r => r.userRecord !== 0 && r.dataSource !== 5);
  const customUcPositions = records.filter(r => r.dataSource === 5 && r.positionStatus === 1);

  return {
    matched: true,
    ucid,
    userCode,
    name: mainRecord.name || name,
    sex: mainRecord.sex || null,
    status: mainRecord.status,
    email: mainRecord.email || '',
    mobile: mainRecord.mobile || '',
    homePhone: mainRecord.homePhone || '',
    officeAddressName: mainRecord.officeAddressName || '',
    brandName: mainRecord.brandName || '',
    compName: mainRecord.compName || '',
    orgCode: mainRecord.orgCode || '',
    orgName: mainRecord.orgName || '',
    entryDate: mainRecord.entryDate || '',
    superior: {
      name: mainRecord.supervisorName || '',
      userCode: mainRecord.superior || '',
      ucid: mainRecord.superiorUcid || ''
    },
    allPositions: records,
    mainPosition: mainRecord,
    partTimePositions: partTimeRecords,
    customUcPositions,
    relationRoles: Array.isArray(relationRoles) ? relationRoles : [],
    roleList: lightRoles?.roleList || [],
    events: Array.isArray(events) ? events : [],
    links: {
      memberMessageUrl: generateUcPortalUrl(env, '/memberMessage', {
        ucid,
        userName: mainRecord.name || name,
        userCode,
        personOrgName: mainRecord.orgName || ''
      }),
      configDetailUrl: generateUcPortalUrl(env, '/newConfigDetail', {
        userCode,
        userName: mainRecord.name || name
      }),
      orgTreeUrl: generateUcPortalUrl(env, '/newOrgTree', { userCode }),
      legacyPermissionUrl: `${getUcHost(env).manageOrigin}/uc/view/userInfo?id=${ucid}`
    }
  };
}

// ==================== 组织与组织树查询 (GraphQL + Relation REST) ====================

export async function getEhrOrgBasicVOByPage({
  pageNo = 1,
  pageSize = 20,
  orgCode = undefined,
  officeAddress = undefined,
  compCode = undefined,
  parentOrgCode = undefined,
  status = undefined,
  orgType = undefined,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({
    pageNo,
    pageSize,
    orgCode,
    officeAddress,
    compCode,
    parentOrgCode,
    status,
    orgType
  });
  const query = `{
    getEhrOrgBasicVOByPage(${args}) {
      total
      pageNum
      pageSize
      list
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrOrgBasicVOByPage || { total: 0, pageNum: pageNo, pageSize, list: [] };
}

export async function getEhrOrgVO(orgCode, { env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ orgCode });
  const query = `{
    getEhrOrgVO(${args}) {
      shortName
      fullPathName
      mdmCode
      mdmName
      treePathCodeForDispaly
      treePathNameForDisplay
      directorUserCode
      directorName
      directorUcid
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrOrgVO || null;
}

export async function getEhrOrgEventQueueListByOrgCode(orgCode, { env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ orgCode });
  const query = `{
    getEhrOrgEventQueueListByOrgCode(${args}) {
      id
      orgCode
      orgName
      eventType
      eventTypeName
      oldValue
      oldName
      newValue
      newName
      occurTime
      createTime
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getEhrOrgEventQueueListByOrgCode || [];
}

export async function getDisplayOrg({ env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const query = `{
    getDisplayOrg {
      orgCode
      orgName
      officeAddress
      officeAddressName
      directorName
      directorUserCode
      businessModeCode
      businessModeName
      orgType
      isLeaf
      childNodeList {
        orgCode
        orgName
        officeAddress
        officeAddressName
        directorName
        directorUserCode
        businessModeCode
        businessModeName
        orgType
        isLeaf
      }
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getDisplayOrg || [];
}

export async function getChildNodes(orgCode, { depth = 1, status = 1, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ orgCode, depth, status });
  const query = `{
    getChildNodes(${args}) {
      orgCode
      orgName
      officeAddress
      officeAddressName
      directorName
      directorUserCode
      businessModeCode
      businessModeName
      orgType
      isLeaf
      parentOrgCode
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getChildNodes || [];
}

export async function getTreeNodeWithParentTreePath(orgCode, { status = 1, env = 'test', cookie = null, executeGql = executeUcGraphQL } = {}) {
  const args = formatGqlArgs({ orgCode, status });
  const query = `{
    getTreeNodeWithParentTreePath(${args}) {
      orgCode
      orgName
      officeAddress
      officeAddressName
      directorName
      directorUserCode
      businessModeCode
      businessModeName
      orgType
      isLeaf
      parentOrgCode
      parentNodePath {
        orgCode
        orgName
        orgType
        isLeaf
      }
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getTreeNodeWithParentTreePath || null;
}

/**
 * 组织全景详情聚合查询 (EHR 组织详情 + 组织树路径 + 下级子组织 + 异动记录 + 组织下在职员工概览)
 */
export async function getOrgFullDetail(orgInput, {
  includeUsers = true,
  includeEvents = true,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL,
  executeRel = executeUcRelationApi
} = {}) {
  const resolved = await resolveOrgCode(orgInput, { status: 2, env, cookie, executeGql });
  const orgCode = resolved.orgCode;

  const [basicPage, ehrOrg, treeNode, childNodes, customDetail, events, usersPage] = await Promise.all([
    getEhrOrgBasicVOByPage({ pageNo: 1, pageSize: 5, orgCode, env, cookie, executeGql }).catch(() => ({ list: [] })),
    getEhrOrgVO(orgCode, { env, cookie, executeGql }).catch(() => null),
    getTreeNodeWithParentTreePath(orgCode, { status: 1, env, cookie, executeGql }).catch(() => null),
    getChildNodes(orgCode, { depth: 1, status: 1, env, cookie, executeGql }).catch(() => []),
    executeRel({ path: '/page/org/query/detail', method: 'GET', params: { orgCode }, env, cookie, isReadOnly: true }).catch(() => null),
    includeEvents ? getEhrOrgEventQueueListByOrgCode(orgCode, { env, cookie, executeGql }).catch(() => []) : Promise.resolve([]),
    includeUsers ? getEhrUserVOByPage({ pageNo: 1, pageSize: 20, orgCode, userRecord: 0, status: 1, env, cookie, executeGql }).catch(() => ({ total: 0, list: [] })) : Promise.resolve({ total: 0, list: [] })
  ]);

  const basicInfo = (basicPage?.list || []).find(item => item.orgCode === orgCode) || basicPage?.list?.[0] || {};
  return {
    orgCode,
    shortName: ehrOrg?.shortName || basicInfo.shortName || treeNode?.orgName || customDetail?.orgName || resolved.orgName,
    basicInfo,
    ehrOrg,
    treeNode,
    childNodes: childNodes || [],
    customDetail,
    events: events || [],
    activeUsers: usersPage,
    links: {
      orgMessageUrl: generateUcPortalUrl(env, '/orgMessage', {
        shortNameParam: ehrOrg?.shortName || basicInfo.shortName || '',
        orgCodeParam: orgCode
      }),
      orgTreeUrl: generateUcPortalUrl(env, '/orgTree', {
        orgCode,
        orgName: ehrOrg?.shortName || basicInfo.shortName || ''
      }),
      memberMessageUrl: generateUcPortalUrl(env, '/memberMessage', {
        orgName: ehrOrg?.shortName || basicInfo.shortName || '',
        orgCode
      })
    }
  };
}

// ==================== 城市公司分页查询 (GraphQL) ====================

export async function getCompVOForPage({
  orgCode = undefined,
  officeAddress = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  const args = formatGqlArgs({ orgCode, officeAddress, pageNo, pageSize });
  const query = `{
    getCompVOForPage(${args}) {
      total
      pageNum
      pageSize
      list
    }
  }`;
  const data = await executeGql({ query, env, cookie, isReadOnly: true });
  return data?.getCompVOForPage || { total: 0, pageNum: pageNo, pageSize, list: [] };
}

// ==================== 关系管理中心与角色查询 (Relation REST) ====================

export async function queryAllUserRoleByUserCode(userCode, { env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  return executeRel({
    path: '/relation/queryAllUserRoleByUserCode',
    method: 'GET',
    params: { userCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryRoleForUser(userCode, { env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  return executeRel({
    path: '/userRole/queryRoleForUser',
    method: 'GET',
    params: { userCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryUserRolePage({
  roleCodeList = undefined,
  userCodeList = undefined,
  officeAddress = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/userRole/queryUserRolePage',
    method: 'GET',
    params: {
      roleCodeList,
      userCodeList,
      officeAddress,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryRolePage({
  roleCodeList = undefined,
  positionCode = undefined,
  status = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  return executeRel({
    path: '/role/queryRolePage',
    method: 'GET',
    params: {
      roleCodeList,
      positionCode,
      status,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryRoleRelationByRoleCode(roleCode, { sourceId = undefined, env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  return executeRel({
    path: '/rolePosition/queryRoleRelationByRoleCode',
    method: 'GET',
    params: { roleCode, sourceId },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryRoleTree({
  userCode,
  orgCode = undefined,
  userName = undefined,
  orgName = undefined,
  roleCode = undefined,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  return executeRel({
    path: '/user/org/relation/queryRoleTree',
    method: 'GET',
    params: { userCode, orgCode, userName, orgName, roleCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryTreeOrgDetail({ orgCode, roleCode, limitMember = 20, env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  return executeRel({
    path: '/user/org/relation/queryTreeOrgDetail',
    method: 'GET',
    params: { orgCode, roleCode, limitMember },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryTreeUserDetail(userCode, { env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  return executeRel({
    path: '/user/queryTreeUserDetail',
    method: 'GET',
    params: { userCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryP2PRelations({
  roleCodeList = undefined,
  userCodeList = undefined,
  memberUserCodeList = undefined,
  orgCode = undefined,
  officeAddress = undefined,
  status = 1,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/user/user/relation/queryUserUserRelationByCityPage',
    method: 'GET',
    params: {
      roleCodeList,
      userCodeList,
      memberUserCodeList,
      orgCode,
      officeAddress,
      status,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryUserOrgRelations({
  roleCode = undefined,
  userCode = undefined,
  orgCode = undefined,
  officeAddress = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/user/org/relation/queryUserOrgRelationPageAggRelationTypeAndCity',
    method: 'GET',
    params: {
      roleCode,
      userCode,
      orgCode,
      officeAddress,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryOrgOrgRelations({
  roleCodeList,
  officeAddress = undefined,
  orgCodeList = undefined,
  status = 1,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/org/org/relation/getOrgOrgRelationPage',
    method: 'GET',
    params: {
      roleCodeList,
      officeAddress,
      orgCodeList,
      status,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryUnassignedUsers({
  roleCode,
  officeAddress = undefined,
  company = undefined,
  department = undefined,
  region = undefined,
  userCode = undefined,
  status = 1,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/user/queryUcUserNotAssignPage',
    method: 'GET',
    params: {
      roleCode,
      officeAddress,
      company,
      department,
      region,
      userCode,
      status,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryUnassignedOrgs({
  roleCode,
  bindLevel = undefined,
  officeAddress = undefined,
  company = undefined,
  department = undefined,
  region = undefined,
  orgCodeList = undefined,
  userCode = undefined,
  status = 1,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/ucOrg/queryUcOrgNotAssignPage',
    method: 'GET',
    params: {
      roleCode,
      bindLevel,
      officeAddress,
      company,
      department,
      region,
      orgCodeList,
      userCode,
      status,
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryRelationEvents({
  roleCode,
  officeAddress = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/relation/queryRelationEventPageByRoleCodeAndCity',
    method: 'POST',
    postBody: {
      roleCode,
      officeAddress,
      roleId: op.roleId,
      operatorUserCode: op.userCode,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryCustomOrgPage({
  sourceId = undefined,
  officeAddress = undefined,
  orgCode = undefined,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/page/org/query',
    method: 'GET',
    params: {
      sourceId,
      officeAddress,
      orgCode,
      operatorUserCode: op.userCode,
      roleId: op.roleId
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryCustomOrgChildren(parentOrgCode, { env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/page/org/child/query',
    method: 'GET',
    params: {
      parentOrgCode,
      roleId: op.roleId
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryOrgUserPage({
  orgCode,
  userCodes = undefined,
  roleCode = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  return executeRel({
    path: '/orgUser/queryOrgUserPage',
    method: 'GET',
    params: {
      orgCode,
      userCodes,
      roleCode,
      pageNo,
      pageSize
    },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function getCommonEnums({ type = 'all', query = '', env = 'test', cookie = null, executeRel = executeUcRelationApi } = {}) {
  const op = await getCurrentOperator({ env, cookie });
  switch (type) {
    case 'source':
      return executeRel({ path: '/common/getAllSource', method: 'GET', env, cookie, isReadOnly: true });
    case 'biz-source':
      return executeRel({
        path: '/common/getBusinessOrgSource',
        method: 'GET',
        params: { roleId: op.roleId, operatorUserCode: op.userCode },
        env,
        cookie,
        isReadOnly: true
      });
    case 'org-type':
      return executeRel({ path: '/common/org/getOrgTypeEnum', method: 'GET', env, cookie, isReadOnly: true });
    case 'org-type-source':
      return executeRel({ path: '/common/org/getOrgTypeAndBusinessOrgSourceEnum', method: 'GET', env, cookie, isReadOnly: true });
    case 'role':
      return executeRel({ path: '/common/sug/role', method: 'GET', params: { query, status: 1 }, env, cookie, isReadOnly: true });
    case 'role-pos':
      return executeRel({ path: '/common/sug/roleAndPosition', method: 'GET', params: { query, status: 1 }, env, cookie, isReadOnly: true });
    default: {
      const [sources, orgTypes, bizModes] = await Promise.all([
        executeRel({ path: '/common/getAllSource', method: 'GET', env, cookie, isReadOnly: true }).catch(() => []),
        executeRel({ path: '/common/org/getOrgTypeEnum', method: 'GET', env, cookie, isReadOnly: true }).catch(() => []),
        getBusinessModeList({ env, cookie }).catch(() => [])
      ]);
      return { sources, orgTypes, bizModes };
    }
  }
}

// ==================== 本域 BPM 角色申请与组织标签查询 (Admin REST) ====================

export async function getUserBpmProcessList({
  userCode = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeAdmin = executeUcAdminApi
} = {}) {
  const op = userCode ? { userCode } : await getCurrentOperator({ env, cookie });
  return executeAdmin({
    path: '/api/bpm/user/getUserBpmProcessList',
    method: 'GET',
    params: { userCode: op.userCode, pageNo, pageSize },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function getUnreadBpmProcess({
  userCode = undefined,
  env = 'test',
  cookie = null,
  executeAdmin = executeUcAdminApi
} = {}) {
  const op = userCode ? { userCode } : await getCurrentOperator({ env, cookie });
  return executeAdmin({
    path: '/api/bpm/user/getUnreadProcess',
    method: 'GET',
    params: { userCode: op.userCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function getUcPositionDesc(positionCode, { env = 'test', cookie = null, executeAdmin = executeUcAdminApi } = {}) {
  return executeAdmin({
    path: '/api/uc/position/getUcPositionDesc',
    method: 'GET',
    params: { positionCode },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryOrgTagDictPage({
  tagName = undefined,
  tagCode = undefined,
  status = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeAdmin = executeUcAdminApi
} = {}) {
  return executeAdmin({
    path: '/orgTagDict/queryPage',
    method: 'GET',
    params: { tagName, tagCode, status, pageNo, pageSize },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function getOrgTagDictDetail(id, { env = 'test', cookie = null, executeAdmin = executeUcAdminApi } = {}) {
  return executeAdmin({
    path: '/orgTagDict/detail',
    method: 'GET',
    params: { id },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function queryOrgTagInstancePage({
  orgCode = undefined,
  tagCode = undefined,
  status = undefined,
  pageNo = 1,
  pageSize = 20,
  env = 'test',
  cookie = null,
  executeAdmin = executeUcAdminApi
} = {}) {
  return executeAdmin({
    path: '/orgTagInstance/queryPage',
    method: 'GET',
    params: { orgCode, tagCode, status, pageNo, pageSize },
    env,
    cookie,
    isReadOnly: true
  });
}

export async function getOrgTagInstanceLogs(id, { env = 'test', cookie = null, executeAdmin = executeUcAdminApi } = {}) {
  return executeAdmin({
    path: '/orgTagInstance/logs',
    method: 'GET',
    params: { id },
    env,
    cookie,
    isReadOnly: true
  });
}

// ==================== 测试环境角色与组织变更 API (仅限 test，需上层 Pre-flight + --confirm) ====================

export async function addUserPosition({
  userCode,
  positionCode,
  orgCode,
  level = '',
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  assertUcWritePermitted(env);
  const mutation = `mutation ($addUserPositionRO: BaseUserPositionRO!) {
    addUserPosition(addUserPositionRO: $addUserPositionRO)
  }`;
  const addUserPositionRO = {
    userCode: String(userCode),
    positionCode: String(positionCode),
    orgCode: String(orgCode),
    ...(level ? { level: String(level) } : {})
  };
  const data = await executeGql({
    query: mutation,
    variables: { addUserPositionRO },
    env,
    cookie,
    isReadOnly: false
  });
  return data?.addUserPosition;
}

export async function modifyUserPosition({
  id,
  userCode,
  positionCode,
  orgCode,
  level = '',
  modifyPositionCode,
  modifyOrgCode,
  modifyLevel = '',
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  assertUcWritePermitted(env);
  const mutation = `mutation ($modifyUserPositionRO: ModifyUserPositionRO!) {
    modifyUserPosition(modifyUserPositionRO: $modifyUserPositionRO)
  }`;
  const modifyUserPositionRO = {
    id: String(id),
    userCode: String(userCode),
    positionCode: String(positionCode),
    orgCode: String(orgCode),
    level: level ? String(level) : '',
    modifyPositionCode: String(modifyPositionCode),
    modifyOrgCode: String(modifyOrgCode),
    ...(modifyLevel !== undefined ? { modifyLevel: String(modifyLevel) } : {})
  };
  const data = await executeGql({
    query: mutation,
    variables: { modifyUserPositionRO },
    env,
    cookie,
    isReadOnly: false
  });
  return data?.modifyUserPosition;
}

export async function deleteUserPosition({
  userCode,
  positionCode,
  orgCode,
  level = '',
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  assertUcWritePermitted(env);
  const mutation = `mutation ($deleteUserPositionRO: BaseUserPositionRO!) {
    deleteUserPosition(deleteUserPositionRO: $deleteUserPositionRO)
  }`;
  const deleteUserPositionRO = {
    userCode: String(userCode),
    positionCode: String(positionCode),
    orgCode: String(orgCode),
    ...(level ? { level: String(level) } : {})
  };
  const data = await executeGql({
    query: mutation,
    variables: { deleteUserPositionRO },
    env,
    cookie,
    isReadOnly: false
  });
  return data?.deleteUserPosition;
}

export async function updateBusinessMode({
  orgCode,
  businessModeCode,
  env = 'test',
  cookie = null,
  executeGql = executeUcGraphQL
} = {}) {
  assertUcWritePermitted(env);
  const args = formatGqlArgs({ orgCode, businessModeCode });
  const mutation = `mutation {
    updateBusinessMode(${args})
  }`;
  const data = await executeGql({
    query: mutation,
    env,
    cookie,
    isReadOnly: false
  });
  return data?.updateBusinessMode;
}

export async function bindRoleForUser({
  roleCode,
  userCodes = [],
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  assertUcWritePermitted(env);
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/userRole/bindRoleForUser',
    method: 'POST',
    postBody: {
      operatorUserCode: op.userCode,
      roleId: op.roleId,
      roleCode,
      userCodes: Array.isArray(userCodes) ? userCodes.map(String) : [String(userCodes)]
    },
    env,
    cookie,
    isReadOnly: false
  });
}

export async function disableRoleForUser({
  userCode,
  roleCode,
  env = 'test',
  cookie = null,
  executeRel = executeUcRelationApi
} = {}) {
  assertUcWritePermitted(env);
  const op = await getCurrentOperator({ env, cookie });
  return executeRel({
    path: '/userRole/disableRoleForUser',
    method: 'POST',
    postBody: {
      userCode: String(userCode),
      roleCode: String(roleCode),
      operatorUserCode: op.userCode,
      roleId: op.roleId
    },
    env,
    cookie,
    isReadOnly: false
  });
}
