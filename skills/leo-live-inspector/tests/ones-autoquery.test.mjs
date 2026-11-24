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

  // [data-preset="xxx"] 这类选择器必须返回**稳定**的节点：
  // 页面在绑定时用它取按钮，测试在点击时用同一个 id 取按钮，
  // 如果每次返回新对象，绑定和点击就落在两个不同节点上。
  function querySelector(sel) {
    const m = String(sel).match(/^\[data-preset="([^"]+)"\]$/);
    if (m) return get('preset-' + m[1]);
    return el(sel);
  }

  /** 简单收集所有预设按钮，供 querySelectorAll('[data-preset]') 使用 */
  function presetButtons() {
    return (sandbox.ONES_SCHED_PRESETS_KEYS || []).map(k => get('preset-' + k));
  }

  const document = {
    getElementById: get,
    querySelector,
    querySelectorAll(sel) {
      const m = String(sel).match(/^\[data-preset\]$/);
      if (m) return presetButtons();
      return [];
    },
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
  // 内联脚本用 const 声明，vm 里不会挂到 sandbox 上；追加一行显式导出给测试用
  vm.runInContext(script + '\n;globalThis.__ONES_SCHED_PRESETS = ONES_SCHED_PRESETS;',
    sandbox, { filename: 'deploy_web.inline.js' });
  sandbox.ONES_SCHED_PRESETS = sandbox.__ONES_SCHED_PRESETS;

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

// ---- 时间窗预设 ----

/** 取页面里算好的预设区间（直接调用页面作用域里的 ONES_SCHED_PRESETS） */
function presetRange(page, key) {
  return page.sandbox.ONES_SCHED_PRESETS[key]();
}

function expectWeekday(dateStr, weekday, label) {
  const d = new Date(dateStr + 'T00:00:00');
  assert.equal(d.getDay(), weekday, `${label} 应为 ${['周日','周一','周二','周三','周四','周五','周六'][weekday]}`);
}

test('本月预设：本月 1 号 ~ 本月最后一天', () => {
  const page = loadPage();
  const { from, to } = presetRange(page, 'thismonth');
  const now = new Date();
  assert.equal(new Date(from + 'T00:00:00').getDate(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  assert.equal(to, `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`);
});

test('上一月预设：覆盖完整的上一个自然月', () => {
  const page = loadPage();
  const { from, to } = presetRange(page, 'lastmonth');
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to + 'T00:00:00');
  assert.equal(f.getDate(), 1, '应为上月 1 号');
  assert.equal(t.getMonth(), f.getMonth(), '起止应在同一个月内');
  assert.equal(t.getDate(), new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate(), '应为上月最后一天');
});

test('上周一 ~ 本周日：跨度 14 天，起于周一终于周日', () => {
  const page = loadPage();
  const { from, to } = presetRange(page, 'twoweek');
  expectWeekday(from, 1, '起始');
  expectWeekday(to, 0, '结束');
  const span = (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000;
  assert.equal(span, 13, '含首尾共 14 天');
});

test('本周一 ~ 下周五：结束日期是下周五', () => {
  const page = loadPage();
  const { from, to } = presetRange(page, 'weekahead');
  expectWeekday(from, 1, '起始');
  expectWeekday(to, 5, '结束');
  const span = (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000;
  assert.equal(span, 11, '本周一 + 11 天 = 下周五');
});

test('点预设按钮会带上查询并高亮该按钮', async () => {
  const page = loadPage();
  const calls = stubFetch(page);
  await clickTopTab(page, 'ones');
  const before = calls.length;

  const btn = page.get('preset-thismonth');
  const handler = page.handlers.get(btn)?.click?.[0];
  assert.ok(handler, '预设按钮应绑定点击处理器');
  await handler({ target: btn });

  assert.equal(calls.length, before + 1, '点预设应立即触发一次查询');
  assert.equal(calls.at(-1).body.from, presetRange(page, 'thismonth').from);
});

test('上一周以当前显示日期为基准平移（先点本月也不会错位）', async () => {
  const page = loadPage();
  const calls = stubFetch(page);
  await clickTopTab(page, 'ones');

  const monthBtn = page.get('preset-thismonth');
  await page.handlers.get(monthBtn).click[0]({ target: monthBtn });

  const prev = page.get('oSchedPrev');
  await page.handlers.get(prev).click[0]({ target: prev });

  const from = page.get('oSchedFrom').value;
  const monthFirst = new Date(presetRange(page, 'thismonth').from + 'T00:00:00');
  const expected = new Date(monthFirst.getFullYear(), monthFirst.getMonth(), monthFirst.getDate() - 7);
  const pad = n => String(n).padStart(2, '0');
  const want = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`;
  assert.equal(from, want, '应在上月 1 号基础上往前推 7 天');
  assert.equal(calls.at(-1).body.from, want);
});
