import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  normalizeArmsEnv,
  normalizeArmsDataType,
  normalizeAggsField,
  isArmsAuthFailure,
  isArmsSuccess,
  executeArmsApi,
  resolveTimeRange,
  parseFilterExpression,
  buildFilterItem,
  buildQueryDataItems,
  resolveArmsProject,
  formatArmsTimestamp,
  normalizeQueryLogItem,
  normalizeTraceEvents,
  getArmsPerformance
} from '../scripts/common/arms.js';
import { loadArmsApiKey } from '../scripts/common/credentials.js';
import { parseArgs } from '../scripts/arms_query.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

test('ARMS normalizers map env, dataType, and aggs aliases accurately', () => {
  assert.equal(normalizeArmsEnv('prod'), 'production');
  assert.equal(normalizeArmsEnv('生产'), 'production');
  assert.equal(normalizeArmsEnv('preview'), 'preview');
  assert.equal(normalizeArmsEnv('预发'), 'preview');
  assert.equal(normalizeArmsEnv('test'), 'testing');
  assert.equal(normalizeArmsEnv('测试'), 'testing');

  assert.equal(normalizeArmsDataType('error'), 'error');
  assert.equal(normalizeArmsDataType('pvuv'), 'product');
  assert.equal(normalizeArmsDataType('perf'), 'perf');
  assert.equal(normalizeArmsDataType('custom'), 'info');

  assert.equal(normalizeAggsField('no'), 'no');
  assert.equal(normalizeAggsField('errorType'), 'detail.error_no.keyword');
  assert.equal(normalizeAggsField('pageType'), 'common.page_type.keyword');
  assert.equal(normalizeAggsField('version'), 'common.runtime_version');
});

test('ARMS auth detection catches code=10000 login, 401/403, and SSO HTML', () => {
  assert.equal(isArmsAuthFailure({ statusCode: 200, json: { code: 10000, action: 'login', msg: '请先登录' } }), true);
  assert.equal(isArmsAuthFailure({ statusCode: 401 }), true);
  assert.equal(isArmsAuthFailure({ statusCode: 200, raw: '<html>login.ke.com</html>' }), true);
  assert.equal(isArmsAuthFailure({ statusCode: 200, json: { code: 0, action: 'success', data: {} } }), false);

  assert.equal(isArmsSuccess({ statusCode: 200, json: { code: 0, data: { total: 1 } } }), true);
  assert.equal(isArmsSuccess({ statusCode: 200, json: { code: 10000, action: 'login' } }), false);
});

test('ARMS executeArmsApi supports dual-track auth (api-key, fallback to cookie, public)', async () => {
  // 1. Public endpoint skips auth
  let seenHeaders = null;
  const pubRes = await executeArmsApi({
    path: '/api/aiMcp/project/list',
    authMode: 'public',
    transport: async (opts) => {
      seenHeaders = opts.headers;
      return { statusCode: 200, json: { code: 0, data: { list: [] } } };
    }
  });
  assert.equal(pubRes.authUsed, 'public');
  assert.equal(seenHeaders['x-api-key'], undefined);

  // 2. Saved api-key sends x-api-key header
  const keyRes = await executeArmsApi({
    path: '/project/1737/api/data/query/list',
    method: 'POST',
    postBody: { aggs: 'no' },
    apiKeyLoader: () => 'fee_test_key',
    transport: async (opts) => {
      seenHeaders = opts.headers;
      return { statusCode: 200, json: { code: 0, data: { total: 0, recordList: [] } } };
    }
  });
  assert.equal(keyRes.authUsed, 'api-key');
  assert.equal(seenHeaders['x-api-key'], 'fee_test_key');

  // 3. Explicit invalid api-key fails immediately without falling back to cookie
  await assert.rejects(
    () => executeArmsApi({
      path: '/project/1737/api/data/query/list',
      apiKey: 'bad_explicit_key',
      transport: async () => ({ statusCode: 200, json: { code: 10000, action: 'login', msg: '请先登录' } })
    }),
    /x-api-key 鉴权失败/
  );

  // 4. Saved invalid api-key falls back cleanly to cookie session
  const fallbackRes = await executeArmsApi({
    path: '/project/1737/api/data/query/list',
    apiKeyLoader: () => 'stale_saved_key',
    cookieSessionFactory: () => ({
      run: async (_url, send) => send('security_ticket=valid_cookie')
    }),
    transport: async (opts) => {
      if (opts.headers['x-api-key']) {
        return { statusCode: 200, json: { code: 10000, action: 'login', msg: '请先登录' } };
      }
      assert.equal(opts.headers.Cookie, 'security_ticket=valid_cookie');
      return { statusCode: 200, json: { code: 0, data: { total: 3 } } };
    }
  });
  assert.equal(fallbackRes.authUsed, 'cookie');
  assert.equal(fallbackRes.data.total, 3);

  // 5. Saved api-key lacking project permission ("没有权限") also falls back cleanly to cookie session
  const permFallbackRes = await executeArmsApi({
    path: '/project/1818/api/data/query/list',
    apiKeyLoader: () => 'scoped_key',
    cookieSessionFactory: () => ({
      run: async (_url, send) => send('security_ticket=user_cookie')
    }),
    transport: async (opts) => {
      if (opts.headers['x-api-key']) {
        return { statusCode: 200, json: { code: 10002, msg: '没有权限' } };
      }
      assert.equal(opts.headers.Cookie, 'security_ticket=user_cookie');
      return { statusCode: 200, json: { code: 0, data: { total: 5 } } };
    }
  });
  assert.equal(permFallbackRes.authUsed, 'cookie');
  assert.equal(permFallbackRes.data.total, 5);
});

test('ARMS filter builder and time range enforce 7-day limit and operator mapping', () => {
  const now = new Date('2026-11-19T12:00:00+08:00');
  const range = resolveTimeRange({ time: '2h', now });
  assert.equal(range.endAt - range.startAt, 7200);
  assert.throws(() => resolveTimeRange({ time: '10d', now }), /最大支持 7 天/);

  assert.deepEqual(parseFilterExpression('extra~TRTC SDK'), {
    key: 'extra',
    condition: 'include',
    value: 'TRTC SDK',
    type: 'text'
  });
  assert.deepEqual(buildFilterItem('width', '=', '390'), {
    key: 'common.dsp_w',
    condition: '=',
    value: 390,
    type: 'number'
  });

  const items = buildQueryDataItems({
    startStr: '2026-11-19 10:00',
    endStr: '2026-11-19 12:00',
    dataType: 'error',
    env: 'prod',
    query: 'TRTC',
    pageType: 'ics.home.ke.com/pages/playbackLocal/playbackDetail/constructionLive'
  });
  assert.equal(items.length, 5);
  assert.equal(items[3].key, 'extra');
  assert.equal(items[3].condition, 'include');
  assert.equal(items[4].key, 'common.page_type');
});

test('ARMS resolveArmsProject resolves by ID, git repo slug, display name, and disambiguates', async () => {
  const tmpCache = path.join(os.tmpdir(), `arms-proj-test-${Date.now()}.json`);
  const mockProjects = [
    { project_id: 1737, project_name: 'app-life-fe-intelligentize', display_name: '智慧工地H5', git_url: 'https://git.lianjia.com/life-fe/webgl/life-fe-intelligentize.git', home_page: 'https://ics.home.ke.com/' },
    { project_id: 1800, project_name: 'wisdom-saas', display_name: '智慧工地saas平台', git_url: 'https://git.lianjia.com/life-fe/wisdom-saas.git', home_page: 'https://ics-saas.ke.com/' },
    { project_id: 1900, project_name: 'wisdom-miniapp', display_name: '智慧工地小程序', git_url: 'https://git.lianjia.com/life-fe/wisdom-miniapp.git', home_page: '' }
  ];
  const opts = {
    refresh: true,
    cacheFile: tmpCache,
    transport: async () => ({ statusCode: 200, json: { code: 0, data: { list: mockProjects } } })
  };

  try {
    const byId = await resolveArmsProject('1737', opts);
    assert.equal(byId.project_id, 1737);

    const byGit = await resolveArmsProject('life-fe-intelligentize', { ...opts, refresh: false });
    assert.equal(byGit.project_id, 1737);

    const byDisplay = await resolveArmsProject('智慧工地H5', { ...opts, refresh: false });
    assert.equal(byDisplay.project_id, 1737);

    await assert.rejects(() => resolveArmsProject('智慧工地', { ...opts, refresh: false }), /匹配到多个灯塔项目/);
  } finally {
    try { fs.unlinkSync(tmpCache); } catch {}
  }
});

test('ARMS trace normalization, timestamp formatting, and perf scaling work accurately', async () => {
  const formatted = formatArmsTimestamp(1795058431000);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const item = normalizeQueryLogItem({
    time_ms: 1795058431000,
    type: 'error',
    ip: '1.2.3.4',
    country: '中国',
    province: '北京',
    city: '北京',
    viewId: 'vid-1',
    common: { page_type: 'ics/live', uuid: 'u1', ucid: '123', isp: '移动', runtime_version: '1.0.0' },
    detail: { error_no: '页面报错_CONSOLE_ERROR', url: 'https://ics.home.ke.com/a' },
    extra: JSON.stringify({ desc: '===TRTC SDK初始化失败:', stack: 'stack' }),
    ua: { os: { name: 'Android', version: '16' }, browser: { name: 'WebView', version: '138' }, device: { vendor: 'Honor', model: 'X' } }
  });
  assert.equal(item.desc, '===TRTC SDK初始化失败:');
  assert.equal(item.viewId, 'vid-1');

  const trace = normalizeTraceEvents([
    { time_ms: 1795058431000, type: 'error', viewId: 'v1', common: { ucid: '1' }, detail: { error_no: 'CONSOLE_ERROR', url: 'https://a' }, extra: '{"desc":"err1"}' },
    { time_ms: 1795058431000, type: 'error', viewId: 'v1', common: { ucid: '1' }, detail: { error_no: 'CONSOLE_ERROR', url: 'https://a' }, extra: '{"desc":"err1"}' },
    { time_ms: 1795058423000, type: 'api', viewId: 'v1', common: { ucid: '1' }, detail: { subType: 'API_XHR', url: 'https://trtcplay.ke.com/a.ts', http_code: 0, during_ms: 5564 }, extra: '{"param":"","msg":"OK","body":"","resp":""}' }
  ]);
  assert.equal(trace.rawCount, 3);
  assert.equal(trace.events.length, 2);
  assert.equal(trace.events[0].url, 'https://trtcplay.ke.com/a.ts');
  assert.equal(trace.events[0].desc, '');
  assert.equal(trace.events[1].repeatCount, 2);
  assert.equal(trace.slowOrFailedApis.length, 1);

  const perf = await getArmsPerformance(1737, {
    metric: 'LCP',
    apiKey: 'k',
    transport: async (opts) => {
      if (opts.path.includes('/summary/days/all/avg')) {
        return { statusCode: 200, json: { code: 0, data: { pvTotalCount: 100, lcpAvg: 971900, clsAvg: 81 } } };
      }
      if (opts.path.includes('/per75/list')) {
        return { statusCode: 200, json: { code: 0, data: [{ count_at_time: '11-18', lcp_avg: 930445 }] } };
      }
      return { statusCode: 200, json: { code: 0, data: [{ key: 'ics/live', doc_count: 10, pv: { value: 9 }, uv: { value: 5 }, percent: { values: { '50.0': 400, '75.0': 680, '90.0': 1100 } } }] } };
    }
  });
  assert.equal(perf.summary.lcpAvg, 971.9);
  assert.equal(perf.summary.clsAvg, 0.081);
  assert.equal(perf.per75Trend[0].lcp_avg, 930.445);
});

test('ARMS CLI parseArgs & loadArmsApiKey env override & --help work properly', async () => {
  const prevEnv = process.env.ARMS_API_KEY;
  process.env.ARMS_API_KEY = 'fee_env_override';
  try {
    assert.equal(loadArmsApiKey(), 'fee_env_override');
  } finally {
    if (prevEnv === undefined) delete process.env.ARMS_API_KEY;
    else process.env.ARMS_API_KEY = prevEnv;
  }

  const parsedLogs = parseArgs(['logs', '1737', '-q', 'TRTC', '--aggs', 'pageType', '-t', 'today', '-f', 'common.ucid=123', '--json']);
  assert.equal(parsedLogs.command, 'logs');
  assert.equal(parsedLogs.project, '1737');
  assert.equal(parsedLogs.query, 'TRTC');
  assert.equal(parsedLogs.aggs, 'pageType');
  assert.deepEqual(parsedLogs.filters, ['common.ucid=123']);
  assert.equal(parsedLogs.json, true);

  const parsedTrace = parseArgs(['trace', '1737', '2w4360jic43mwmzff5g']);
  assert.equal(parsedTrace.command, 'trace');
  assert.equal(parsedTrace.project, '1737');
  assert.equal(parsedTrace.viewId, '2w4360jic43mwmzff5g');

  const { stdout } = await execFileAsync('node', [path.join(SCRIPTS_DIR, 'arms_query.js'), '--help']);
  assert.ok(stdout.includes('Leo ARMS Frontend Query Engine'));
  assert.ok(stdout.includes('arms_query.js'));
});
