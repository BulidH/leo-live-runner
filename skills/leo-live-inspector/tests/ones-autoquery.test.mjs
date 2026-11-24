import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'scripts', 'deploy_web.js');

/**
 * 把 deploy_web.js 模板里的内联页面脚本抽出来，替换掉 buildPage 注入的占位符，
 * 然后在最小 DOM 桩上真正跑一遍。
 *
 * 为什么要跑真脚本：这个 Tab 的自动查询逻辑全在前端，光读代码看不出
 * 「进入时到底有没有发请求」「切回去会不会重复查」这类问题。
 */
function loadPage() {
  const src = fs.readFileSync(SRC, 'utf8');
  let script = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  script = script
    .replace(/\$\{JSON\.stringify\(projectItems\)[^}]*\}/g, '[]')
    .replace(/\$\{JSON\.stringify\(appItems\)[^}]*\}/g, '[]');

  const byId = new Map();
  const handlers = new Map();

  function el(id = '') {
    const node = {
      id, value: '', textContent: '', innerHTML: '', className: '', disabled: false,
      style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(t, f) {
        if (!handlers.has(node)) handlers.set(node, {});
        (handlers.get(node)[t] ||= []).push(f);
      },
      querySelector() { return el(); },
      querySelectorAll() { return []; },
      closest() { return node._closest || null; },
      appendChild() {}, remove() {},
      async click() {
        for (const f of handlers.get(node)?.click || []) await f({ target: node, preventDefault() {} });
      }
    };
    return node;
  }

  const get = id => {
    if (!byId.has(id)) byId.set(id, el(id));
    return byId.get(id);
  };

  const document = {
    getElementById: get,
    querySelector: () => el(),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => el(),
    body: el()
  };

  const sandbox = {
    document,
    window: { addEventListener() {}, history: { replaceState() {} }, location: { hash: '', pathname: '/', search: '' } },
    location: { hash: '', pathname: '/', search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: {}, requestAnimationFrame: () => 0,
    JSON, Math, Date, Number, String, Array, Object, Set, Map, Error,
    encodeURIComponent, decodeURIComponent
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'deploy_web.inline.js' });

  return { sandbox, get, byId, handlers };
}

/** 模拟点击顶层 Tab：showTab 通过 #tabs 容器的 click 事件接收 */
async function clickTopTab(page, tab) {
  const container = page.get('tabs');
  const fakeBtn = { dataset: { tab } };
  for (const fn of page.handlers.get(container)?.click || []) {
    await fn({ target: { closest: sel => (String(sel).includes('data-tab') ? fakeBtn : null) } });
  }
  await new Promise(r => setTimeout(r, 0));   // 让查询的 promise 链跑完
}

/**
 * 只记录排期查询（cmd === 'schedule'）。
 * 页面加载时还会顺带请求 /api/initial、/api/credentials 等，不能算进排期次数。
 */
function stubFetch(page) {
  const calls = [];
  page.sandbox.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (body.cmd === 'schedule') calls.push({ url, body });
    return { ok: true, json: async () => ({ ok: true, json: { data: { items: [] } } }) };
  };
  return calls;
}

test('首次进入 ONES 页会自动查一次我的排期', async () => {
  const page = loadPage();
  const calls = stubFetch(page);

  await clickTopTab(page, 'ones');

  assert.equal(calls.length, 1, '进入时应自动发起 1 次排期查询');
  assert.equal(calls[0].url, '/api/ones/query');
  assert.match(calls[0].body.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(calls[0].body.to, /^\d{4}-\d{2}-\d{2}$/);
});

test('查过之后再切回 ONES 页不会重复查询', async () => {
  const page = loadPage();
  const calls = stubFetch(page);

  await clickTopTab(page, 'ones');
  assert.equal(calls.length, 1, '第一次进入应查一次');

  await clickTopTab(page, 'home');
  await clickTopTab(page, 'ones');
  assert.equal(calls.length, 1, '结果已存在时切回不应再发请求');
});

test('查询失败后再次进入会重试（失败不算查过）', async () => {
  const page = loadPage();
  let n = 0;
  page.sandbox.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (body.cmd !== 'schedule') return { ok: true, json: async () => ({}) };
    n++;
    if (n === 1) return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => ({ ok: true, json: { data: { items: [] } } }) };
  };

  await clickTopTab(page, 'ones');
  assert.equal(n, 1);
  await clickTopTab(page, 'home');
  await clickTopTab(page, 'ones');
  assert.equal(n, 2, '上次失败应允许重试');
});

test('自动查询用的是本周时间窗', async () => {
  const page = loadPage();
  const calls = stubFetch(page);
  await clickTopTab(page, 'ones');

  const { from, to } = calls[0].body;
  const d = new Date(from + 'T00:00:00');
  const span = (new Date(to + 'T00:00:00') - d) / 86400000;
  assert.equal(span, 6, '应为周一到周日的 7 天窗口');
  assert.equal(d.getDay(), 1, '起始应为周一');
});
