import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  probeFastIndexViaApi,
  extractClusterFromKibanaUrl,
  isFastAuthFailure,
  pickConfigEntry
} from '../scripts/common/fast_probe.js';
import { createCredentialSession } from '../scripts/common/browser_credentials.js';

const FAST_QUERY_SCRIPT = fileURLToPath(new URL('../scripts/fast_query.js', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });
}

function pollLikeCookieExtension(port, cookieValue = 'sid=valid_fast_session') {
  const seen = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const { cmd } = await (await fetch(`http://127.0.0.1:${port}/ext/poll?waitMs=100`)).json();
        if (!cmd) continue;
        seen.push(cmd);
        let result = {};
        if (cmd.type === 'cookies.export' || cmd.type === 'cookies.get') {
          result = {
            matchedBy: 'url',
            cookies: [
              {
                name: cookieValue.split('=')[0],
                value: cookieValue.split('=')[1],
                domain: '127.0.0.1',
                hostOnly: true,
                path: '/',
                secure: false,
                httpOnly: true
              }
            ]
          };
        }
        await fetch(`http://127.0.0.1:${port}/ext/result`, {
          method: 'POST',
          body: JSON.stringify({ id: cmd.id, ok: true, result })
        });
      } catch {
        await pause(50);
      }
    }
  })();
  return { seen, stop: async () => { running = false; await loop; } };
}

test('helper parsers detect FAST auth failures, extract clusters, and prefer All-logs entries', () => {
  assert.equal(isFastAuthFailure({ statusCode: 200, json: { code: 3, status: 500, message: '请先登录' } }), true);
  assert.equal(isFastAuthFailure({ statusCode: 200, json: { status: 200, data: [] } }), false);
  assert.equal(
    extractClusterFromKibanaUrl('//fast108-kibana-logcenter-intra.intra.ke.com/app/kibana#/discover'),
    'https://fast108-kibana-logcenter-intra.intra.ke.com'
  );
  assert.equal(
    pickConfigEntry([
      { indexName: 'index-1-1', eventName: '网关日志' },
      { indexName: 'index-1-2', eventName: '全部日志' }
    ]).indexName,
    'index-1-2'
  );
});

test('probeFastIndexViaApi resolves :prod appCode and sends raw string indexName to /es/search/url', async () => {
  const seenRequests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    seenRequests.push({ url: req.url, body, cookie: req.headers.cookie || '' });
    res.setHeader('content-type', 'application/json');

    if (req.headers.cookie !== 'security_ticket=ok') {
      res.end(JSON.stringify({ code: 3, status: 500, message: '请先登录' }));
      return;
    }

    if (req.url === '/es/queryconfiglist') {
      const parsed = JSON.parse(body);
      if (parsed.appCode === 'utopia-scs-saas:prod') {
        res.end(JSON.stringify({
          status: 200,
          data: [
            { appId: 9592, appName: '智慧工地saas全量日志', eventName: '部分日志', indexName: 'index-9592-1' },
            { appId: 9592, appName: '智慧工地saas全量日志', eventName: 'All', indexName: 'index-9592-8939' }
          ]
        }));
        return;
      }
      res.end(JSON.stringify({ status: 200, data: [] }));
      return;
    }

    if (req.url === '/es/search/url') {
      // Must be raw string (not JSON-quoted "\"index-9592-8939\"")
      if (body !== 'index-9592-8939') {
        res.end(JSON.stringify({ code: 0, status: 500, message: '操作异常，请重试或联系管理员' }));
        return;
      }
      res.end(JSON.stringify({
        status: 200,
        data: {
          clusterVersion: 7,
          url: '//fast105-kibana-logcenter-intra.intra.ke.com/app/kibana#/discover'
        }
      }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await probeFastIndexViaApi('utopia-scs-saas', {
      baseUrl,
      cookie: 'security_ticket=ok'
    });
    assert.deepEqual(result, {
      cluster: 'https://fast105-kibana-logcenter-intra.intra.ke.com',
      index: 'index-9592-8939',
      appName: '智慧工地saas全量日志',
      eventName: 'All',
      source: 'fast-api'
    });
    assert.equal(seenRequests[0].url, '/es/queryconfiglist');
    assert.equal(seenRequests[1].url, '/es/search/url');
    assert.equal(seenRequests[1].body, 'index-9592-8939');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('probeFastIndexViaApi falls back to default list and /app/appCode/linked, and renews expired cookies via visit', async () => {
  let visitCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');

    if (req.headers.cookie !== 'security_ticket=fresh') {
      res.end(JSON.stringify({ code: 3, status: 500, message: '请先登录' }));
      return;
    }

    if (req.url === '/es/queryconfiglist') {
      const parsed = JSON.parse(body);
      if (parsed.appCode === null) {
        res.end(JSON.stringify({
          status: 200,
          data: [{ appName: 'beijia-clean-core生产环境', eventName: '全部日志', indexName: 'index-8479-7704' }]
        }));
        return;
      }
      if (parsed.appCode === 'pt-lmall-op:op-lmall') {
        res.end(JSON.stringify({
          status: 200,
          data: [{ appName: 'op-lmall', eventName: '全部日志', indexName: 'index-7001-123' }]
        }));
        return;
      }
      res.end(JSON.stringify({ status: 200, data: [] }));
      return;
    }

    if (req.url === '/app/appCode/linked') {
      res.end(JSON.stringify({
        status: 200,
        data: [{ appCode: 'pt-lmall-op:op-lmall' }]
      }));
      return;
    }

    if (req.url === '/es/search/url') {
      const host = body === 'index-8479-7704' ? 'fast108-kibana.example.com' : 'fast103-kibana.example.com';
      res.end(JSON.stringify({ status: 200, data: { url: `//${host}/app/kibana` } }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let savedCookie = '';
    const session = createCredentialSession({
      load: () => '',
      save: (c) => { savedCookie = c; },
      isAuthFailure: isFastAuthFailure,
      isSuccess: (res) => Boolean(res?.json?.status === 200),
      getCookies: async ({ visit } = {}) => {
        if (visit) visitCalls += 1;
        return [{ name: 'security_ticket', value: visit ? 'fresh' : 'stale' }];
      }
    });

    const defaultMatched = await probeFastIndexViaApi('beijia-clean-core', { baseUrl, session });
    assert.equal(defaultMatched.index, 'index-8479-7704');
    assert.equal(defaultMatched.cluster, 'https://fast108-kibana.example.com');
    assert.equal(visitCalls, 1);
    assert.equal(savedCookie, 'security_ticket=fresh');

    const linkedMatched = await probeFastIndexViaApi('op-lmall', {
      baseUrl,
      session
    });
    assert.equal(linkedMatched.index, 'index-7001-123');
    assert.equal(linkedMatched.cluster, 'https://fast103-kibana.example.com');

    const loginRequiredSession = createCredentialSession({
      load: () => '',
      save: () => {},
      isAuthFailure: isFastAuthFailure,
      isSuccess: (res) => Boolean(res?.json?.status === 200),
      getCookies: async ({ visit } = {}) => {
        if (visit) throw Object.assign(new Error('https://fast.ke.com 需要登录'), { code: 'LOGIN_REQUIRED' });
        return [{ name: 'security_ticket', value: 'stale' }];
      }
    });
    await assert.rejects(
      () => probeFastIndexViaApi('beijia-clean-core', { baseUrl, session: loginRequiredSession }),
      (err) => err.code === 'LOGIN_REQUIRED'
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fast_query.js learns a new index via HTTP API without opening a browser page and caches both service_map and fast_cookie', async () => {
  const port = await closedPort();
  const esServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rawResponse: { took: 5, hits: { total: 0, hits: [] } } }));
  });
  await new Promise((resolve) => esServer.listen(0, '127.0.0.1', resolve));
  const cluster = `http://127.0.0.1:${esServer.address().port}`;

  const fastServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.headers.cookie !== 'sid=valid_fast_session') {
      res.end(JSON.stringify({ code: 3, status: 500, message: '请先登录' }));
      return;
    }
    if (req.url === '/es/queryconfiglist') {
      const parsed = JSON.parse(body);
      if (parsed.appCode === 'brand-new-svc:prod') {
        res.end(JSON.stringify({
          status: 200,
          data: [{ appName: 'brand-new-svc', eventName: '全部日志', indexName: 'index-9999-1111' }]
        }));
        return;
      }
      res.end(JSON.stringify({ status: 200, data: [] }));
      return;
    }
    if (req.url === '/es/search/url' && body === 'index-9999-1111') {
      res.end(JSON.stringify({ status: 200, data: { url: `${cluster}/app/kibana` } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => fastServer.listen(0, '127.0.0.1', resolve));
  const fastBaseUrl = `http://127.0.0.1:${fastServer.address().port}`;

  const extension = pollLikeCookieExtension(port, 'sid=valid_fast_session');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-fast-api-e2e-'));
  try {
    const child = spawn(process.execPath, [FAST_QUERY_SCRIPT, '-a', 'brand-new-svc', '-n', '1'], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        FAST_COOKIE: '',
        LEO_FAST_BASE_URL: fastBaseUrl,
        LEO_LANTERN_PORT: String(port),
        LEO_LANTERN_IDLE_EXIT_MIN: '0.1'
      }
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(status, 0, output);
    const parsedOutput = JSON.parse(output);
    assert.equal(parsedOutput.summary.indexPattern, 'index-9999-1111*');
    assert.equal(parsedOutput.summary.kibanaCluster, cluster);
    assert.equal(parsedOutput.summary.isLearned, true);

    const cmdTypes = extension.seen.map((cmd) => cmd.type);
    assert.ok(cmdTypes.includes('cookies.export') || cmdTypes.includes('cookies.get'), 'should read cookies via extension');
    assert.ok(!cmdTypes.includes('task.start'), 'must not open a browser window/task');
    assert.ok(!cmdTypes.includes('tabs.goto'), 'must not navigate to fast.ke.com UI');
    assert.ok(!cmdTypes.includes('page.eval'), 'must not inject page eval');

    const serviceMap = JSON.parse(fs.readFileSync(path.join(home, '.shrimp/skills/live-inspector/service_map.json'), 'utf8'));
    assert.deepEqual(serviceMap['brand-new-svc'], { index: 'index-9999-1111*', cluster });

    const fastCookie = JSON.parse(fs.readFileSync(path.join(home, '.shrimp/skills/live-inspector/fast_cookie.json'), 'utf8'));
    assert.equal(fastCookie.cookie, 'sid=valid_fast_session');
  } finally {
    await extension.stop();
    esServer.closeAllConnections();
    fastServer.closeAllConnections();
    await new Promise((resolve) => esServer.close(resolve));
    await new Promise((resolve) => fastServer.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('chrome extension background.js registers FAST_PROD keep-alive target', () => {
  const background = fs.readFileSync(new URL('../resources/chrome_extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /slot:\s*'FAST_PROD'/);
  assert.match(background, /https:\/\/fast\.ke\.com\/es\/queryconfiglist/);
});
