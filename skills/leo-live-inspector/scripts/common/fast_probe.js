import { requestHttp } from './http.js';
import { getBrowserCookies } from '../credential_relay.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';
import { loadFastCookie, saveFastCookie } from './credentials.js';

const DEFAULT_FAST_BASE_URL = 'https://fast.ke.com';
const DEFAULT_BRIDGE_TIMEOUT_MS = 15000;

export function getFastBaseUrl() {
  return (process.env.LEO_FAST_BASE_URL || DEFAULT_FAST_BASE_URL).replace(/\/+$/, '');
}

export function isFastAuthFailure(res) {
  if (isLoginFailure(res)) return true;
  if (res?.statusCode === 200 && typeof res?.raw === 'string' && /<html|<!doctype/i.test(res.raw)) {
    if (/login\.ke\.com|passport|统一登录|扫码登录/i.test(res.raw)) return true;
  }
  const body = res?.json || res?.data;
  if (body && typeof body === 'object') {
    if (body.code === 3) return true;
    const msg = String(body.message || body.msg || '');
    if (/请先登录|未登录|登录失效/.test(msg)) return true;
  }
  return false;
}

export function isFastApiSuccess(res) {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300 || res.error) {
    return false;
  }
  if (isFastAuthFailure(res)) return false;
  return Boolean(res.json && typeof res.json === 'object' && res.json.status === 200);
}

/**
 * 创建 FAST 平台 (fast.ke.com) 凭据会话：复用缓存，失效时通过浏览器中继刷新
 */
export function createFastSession({ explicitCookie = '', getCookies, bridgeTimeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS } = {}) {
  const initialCookie = explicitCookie || loadFastCookie();
  const resolveCookies = getCookies || ((req) => getBrowserCookies({ ...req, timeoutMs: bridgeTimeoutMs }));
  return createCredentialSession({
    load: () => initialCookie,
    save: cookieStr => saveFastCookie(cookieStr),
    explicit: Boolean(explicitCookie || process.env.FAST_COOKIE),
    isAuthFailure: isFastAuthFailure,
    isSuccess: isFastApiSuccess,
    getCookies: resolveCookies
  });
}

async function requestFastApi(session, apiPath, body, { baseUrl = getFastBaseUrl(), timeout = 15000 } = {}) {
  const fullUrl = `${baseUrl}${apiPath}`;
  const parsed = new URL(fullUrl);
  return session.run(
    fullUrl,
    cookie => requestHttp({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
      timeout
    }, body),
    { readOnly: true }
  );
}

export function pickConfigEntry(entries) {
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter(item => item && typeof item.indexName === 'string' && item.indexName.trim());
  if (!valid.length) return null;
  return (
    valid.find(item => item.eventName === '全部日志' || /^all$/i.test(String(item.eventName || '').trim())) ||
    valid[0]
  );
}

export function extractClusterFromKibanaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/^(https?:)?\/\/([^/]+)/i);
  if (!match) return null;
  const protocol = match[1] ? match[1].toLowerCase() : 'https:';
  return `${protocol}//${match[2]}`;
}

function matchDefaultConfigEntry(entries, candidates) {
  if (!Array.isArray(entries) || !entries.length) return null;
  for (const name of candidates) {
    const exact = entries.filter(item => item?.appName === name || item?.appName === `${name}生产环境`);
    const picked = pickConfigEntry(exact);
    if (picked) return picked;
  }
  const lowers = candidates.map(c => c.toLowerCase());
  for (const lower of lowers) {
    const ci = entries.filter(item => {
      const label = String(item?.appName || '').toLowerCase();
      return label === lower || label === `${lower}生产环境`;
    });
    const picked = pickConfigEntry(ci);
    if (picked) return picked;
  }
  return null;
}

function matchLinkedAppCode(linkedList, candidates) {
  if (!Array.isArray(linkedList)) return null;
  const codes = linkedList.map(item => String(item?.appCode || '').trim()).filter(Boolean);
  const notNonProd = code => !/:(?:test|dev|qa)$/i.test(code);

  for (const name of candidates) {
    const prodExact = codes.find(c => c === `${name}:prod`);
    if (prodExact) return prodExact;
    const exact = codes.find(c => c === name);
    if (exact) return exact;
  }
  for (const name of candidates) {
    const suffixProd = codes.find(c => c.endsWith(`:${name}`) && notNonProd(c));
    if (suffixProd) return suffixProd;
    const prefixProd = codes.find(c => c.startsWith(`${name}:`) && notNonProd(c));
    if (prefixProd) return prefixProd;
  }
  return null;
}

/**
 * 纯 HTTP API 实时解析 FAST 服务索引与 Kibana 集群地址，免打开浏览器页面。
 */
export async function probeFastIndexViaApi(appCode, options = {}) {
  const stripEnv = s => String(s || '').trim().replace(/[:_\-](prod|test|dev)$/i, '');
  const rawInput = String(appCode || '').trim();
  if (!rawInput) return null;

  const candidates = [...new Set([stripEnv(rawInput), stripEnv(options.canonicalApp)].filter(Boolean))];
  if (!candidates.length) return null;

  const baseUrl = (options.baseUrl || getFastBaseUrl()).replace(/\/+$/, '');
  const session = options.session || createFastSession({
    explicitCookie: options.cookie || '',
    getCookies: options.getCookies,
    bridgeTimeoutMs: options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS
  });

  const queryConfigList = async (queryAppCode) => {
    const res = await requestFastApi(session, '/es/queryconfiglist', { appCode: queryAppCode }, { baseUrl });
    if (res?.json?.status === 200 && Array.isArray(res.json.data)) {
      return res.json.data;
    }
    return [];
  };

  let picked = null;

  // 1. 按标准 appCode:prod 直接精确查询（涵盖默认列表之外的服务，如 zulin-iot-platform:prod）
  const appCodeQueries = [];
  if (rawInput.includes(':')) appCodeQueries.push(rawInput);
  for (const c of candidates) {
    appCodeQueries.push(`${c}:prod`);
  }
  for (const queryCode of [...new Set(appCodeQueries)]) {
    const entries = await queryConfigList(queryCode);
    picked = pickConfigEntry(entries);
    if (picked) break;
  }

  // 2. 回退查询默认授权列表（appCode: null），按 appName / appName生产环境 匹配
  if (!picked) {
    const defaultEntries = await queryConfigList(null);
    picked = matchDefaultConfigEntry(defaultEntries, candidates);
  }

  // 3. 回退查询关联 appCode 全集（适配 sys:app 格式，如 pt-lmall-op:op-lmall）
  if (!picked) {
    const linkedRes = await requestFastApi(session, '/app/appCode/linked', null, { baseUrl });
    if (linkedRes?.json?.status === 200 && Array.isArray(linkedRes.json.data)) {
      const matchedCode = matchLinkedAppCode(linkedRes.json.data, candidates);
      if (matchedCode) {
        const entries = await queryConfigList(matchedCode);
        picked = pickConfigEntry(entries);
      }
    }
  }

  if (!picked) return null;

  // /es/search/url 要求 POST 裸字符串 indexName（带额外 JSON 引号会触发后端 500）
  const urlRes = await requestFastApi(session, '/es/search/url', picked.indexName, { baseUrl });
  const cluster = extractClusterFromKibanaUrl(urlRes?.json?.data?.url);
  if (!cluster) return null;

  return {
    cluster,
    index: picked.indexName,
    appName: picked.appName || null,
    eventName: picked.eventName || null,
    source: 'fast-api'
  };
}

// Runs inside the FAST page through toString(), so it must not use anything from this module.
export function findLogOption(options, app) {
  const service = options.find((option) => option.label === app || option.label === `${app}生产环境`);
  const logs = service?.children || [];
  const log = logs.find((entry) => entry.label === '全部日志') || logs[0];
  return log ? [service.value, log.value] : null;
}

/**
 * Asks the FAST page for a service's log URL, which holds the cluster the service lives on.
 *
 * The page's iframe only shows the service it opened on, so reading it would cache another service's
 * index and silently return the wrong logs. Anything unexpected therefore learns nothing.
 *
 * Resetting version makes getKibanaUrl store the URL instead of routing away, which it does between
 * two clusters of version 7. This relies on the page's internals: if they change, the probe stops
 * learning and queries fall back to `<app>*`. settleMs stays under the extension's 8s eval limit.
 */
export function probePageScript(app, { settleMs = 5000, pollMs = 200 } = {}) {
  return `(() => {
    const find = ${findLogOption.toString()};
    const nothing = { cluster: null, index: null };
    const deadline = Date.now() + ${settleMs};
    const later = (run) => setTimeout(run, ${pollMs});
    return new Promise((resolve) => {
      const awaitUrl = (page, index) => {
        const host = (page.url || '').includes(index) && page.url.match(/\\/\\/([^/]+)/);
        if (host) return resolve({ cluster: 'https://' + host[1], index });
        if (Date.now() >= deadline) return resolve(nothing);
        later(() => awaitUrl(page, index));
      };
      const awaitOptions = () => {
        const picker = document.querySelector('.el-cascader')?.__vue__;
        const options = picker?.options || [];
        let page = picker?.$parent;
        while (page && !page.getKibanaUrl) page = page.$parent;
        // The page's own first lookup must finish, or its answer could overwrite ours.
        if (!options.length || !page?.url) {
          if (Date.now() >= deadline) return resolve(nothing);
          return later(awaitOptions);
        }
        const option = find(options, ${JSON.stringify(app)});
        if (!option) return resolve(nothing);
        page.version = 0;
        page.option = option;
        page.getKibanaUrl();
        awaitUrl(page, option[1]);
      };
      awaitOptions();
    });
  })()`;
}
