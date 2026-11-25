import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'scripts', 'deploy_web.js');

/**
 * 取页面 HTML。
 * deploy_web.js 是 ESM 且顶层会启动 HTTP 服务，不能直接 import；
 * 这里用 vm 只求值 buildPage 所需的模板片段并展开占位符。
 */
function renderPage() {
  const src = fs.readFileSync(SRC, 'utf8');
  // 必须从 <!DOCTYPE html> 开始，否则会漏掉 head 里的主题脚本
  const start = src.indexOf('<!DOCTYPE html>');
  const end = src.indexOf('</html>', start);
  assert.ok(start > 0 && end > start, '未找到页面模板');
  let html = src.slice(start, end);
  html = html
    .replace(/\$\{JSON\.stringify\(projectItems\)[^}]*\}/g, '[]')
    .replace(/\$\{JSON\.stringify\(appItems\)[^}]*\}/g, '[]');
  // 模板里还有少量 ${...}（如 certRows），一律替换成空串
  html = html.replace(/\$\{[^}]*\}/g, '');
  return html;
}

/**
 * 把 deploy_web.js 模板里的内联页面脚本抽出来，替换掉 buildPage 注入的占位符，
 * 然后在最小 DOM 桩上真正跑一遍。
 *
 * 为什么要跑真脚本：这个 Tab 的自动查询逻辑全在前端，光读代码看不出
 * 「进入时到底有没有发请求」「切回去会不会重复查」这类问题。
 */
function loadPage() {
  // 从 buildPage 真正渲染出来的 HTML 里取脚本，不能直接对源文件做正则：
  // 源文件里还有服务端自检用的 `<script>` 字符串，会一起被匹配进来。
  const html = renderPage();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 2, '页面应同时包含主题脚本与主体脚本');
  const script = blocks.join('\n;\n');

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

  const htmlEl = {
    _attrs: {},
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; }
  };

  const document = {
    documentElement: htmlEl,
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
    matchMedia: () => ({ matches: false, addEventListener() {} }),
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

  return { sandbox, get, byId, handlers, htmlEl };
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

/** 模拟点击 ONES 子页（工时概览 / 我的排期 / …） */
async function clickOnesSubTab(page, o) {
  const container = page.get('onesTabs');
  const fakeBtn = { dataset: { o } };
  for (const fn of page.handlers.get(container)?.click || []) {
    await fn({ target: { closest: sel => (String(sel).includes('data-o') ? fakeBtn : null) } });
  }
  await new Promise(r => setTimeout(r, 0));
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

  // 进入 ONES 默认落在「工时概览」，排期要显式切过去
  await clickTopTab(page, 'ones');
  await clickOnesSubTab(page, 'schedule');

  assert.equal(calls.length, 1, '进入时应自动发起 1 次排期查询');
  assert.equal(calls[0].url, '/api/ones/query');
  assert.match(calls[0].body.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(calls[0].body.to, /^\d{4}-\d{2}-\d{2}$/);
});

test('查过之后再切回 ONES 页不会重复查询', async () => {
  const page = loadPage();
  const calls = stubFetch(page);

  await clickTopTab(page, 'ones');
  await clickOnesSubTab(page, 'schedule');
  assert.equal(calls.length, 1, '第一次进入应查一次');

  await clickTopTab(page, 'home');
  await clickTopTab(page, 'ones');
  await clickOnesSubTab(page, 'schedule');
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
  await clickOnesSubTab(page, 'schedule');
  assert.equal(n, 1);
  await clickTopTab(page, 'home');
  await clickTopTab(page, 'ones');
  await clickOnesSubTab(page, 'schedule');
  assert.equal(n, 2, '上次失败应允许重试');
});

test('自动查询用的是本周时间窗', async () => {
  const page = loadPage();
  const calls = stubFetch(page);
  await clickTopTab(page, 'ones');
  await clickOnesSubTab(page, 'schedule');

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

// ---- 主题切换 ----

test('默认落在暗色主题上', () => {
  const page = loadPage();
  assert.equal(page.htmlEl.getAttribute('data-theme'), 'dark');
});

test('点主题按钮在亮/暗之间切换，并写入 localStorage', () => {
  const page = loadPage();
  const btn = page.get('themeToggle');
  assert.ok(page.handlers.get(btn)?.click?.[0], '主题按钮应绑定点击处理器');

  const store = {};
  page.sandbox.localStorage.setItem = (k, v) => { store[k] = v; };

  page.handlers.get(btn).click[0]({ target: btn });
  assert.equal(page.htmlEl.getAttribute('data-theme'), 'light');
  assert.equal(store['leo.theme'], 'light');

  page.handlers.get(btn).click[0]({ target: btn });
  assert.equal(page.htmlEl.getAttribute('data-theme'), 'dark');
  assert.equal(store['leo.theme'], 'dark');
});

test('已保存亮色偏好时首帧就是亮色（不闪暗色）', () => {
  // 只跑 head 里的那段同步脚本，模拟「上次选了亮色」的冷启动
  const html = renderPage();
  const headScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const htmlEl = {
    _attrs: {},
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); }
  };
  const sandbox = {
    document: { documentElement: htmlEl },
    window: { matchMedia: () => ({ matches: false }) },
    location: { search: '' },
    localStorage: { getItem: k => (k === 'leo.theme' ? 'light' : null), setItem() {} },
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(headScript, sandbox, { filename: 'theme-head.js' });
  assert.equal(htmlEl.getAttribute('data-theme'), 'light', '应沿用已保存的亮色偏好');
});

test('跟随系统偏好：系统亮色且无保存值时用亮色', () => {
  const html = renderPage();
  const headScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const htmlEl = {
    _attrs: {},
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); }
  };
  const sandbox = {
    document: { documentElement: htmlEl },
    window: { matchMedia: () => ({ matches: true }) },
    location: { search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(headScript, sandbox, { filename: 'theme-head.js' });
  assert.equal(htmlEl.getAttribute('data-theme'), 'light');
});

test('主题按钮文案随主题变化', () => {
  const page = loadPage();
  const btn = page.get('themeToggle');
  const label = page.get('themeLabel');
  assert.equal(label.textContent, '暗色');
  page.handlers.get(btn).click[0]({ target: btn });
  assert.equal(label.textContent, '亮色');
});

test('CSS 同时定义了暗色与亮色两套令牌', () => {
  const html = renderPage();
  assert.match(html, /:root\s*\{[^}]*--grad-a:#0f172a/s, '暗色令牌');
  assert.match(html, /html\[data-theme="light"\]\s*\{[^}]*--grad-a:#eef2ff/s, '亮色令牌');
  // 玻璃感靠半透明令牌实现（两套主题各有值）
  assert.match(html, /:root\s*\{[^}]*--glass-card:/s, '暗色玻璃卡片令牌');
  assert.match(html, /html\[data-theme="light"\]\s*\{[^}]*--glass-card:/s, '亮色玻璃卡片令牌');
  assert.match(html, /fadeInUp\s*\.5s/, '入场动画应为 0.5s');
});

/**
 * 滚动性能回归守卫：这些 CSS 属性在滚动时逐帧重算，会造成白块闪烁和卡顿。
 * 曾经用 backdrop-filter 铺满整屏 + sticky 导航 + hover 位移，用户反馈
 * 「滑动时下面出现白块、一卡一卡、白色区域会放大一下」。
 */
test('滚动性能：不使用 backdrop-filter / fixed 背景 / hover 位移', () => {
  const html = renderPage();
  // 注释里可以提到这些词，所以只看声明（冒号紧跟属性名后的形式）
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const decls = css.replace(/\/\*[\s\S]*?\*\//g, '');   // 去掉注释再检查

  assert.doesNotMatch(decls, /backdrop-filter\s*:/, '滚动时不应有 backdrop-filter 重算');
  assert.doesNotMatch(decls, /-webkit-backdrop-filter\s*:/, '不应有 -webkit-backdrop-filter');
  assert.doesNotMatch(decls, /background-attachment\s*:\s*fixed/, '固定背景会逐帧重绘 body');
  assert.doesNotMatch(decls, /filter\s*:\s*blur\(/, 'filter:blur 在滚动时被反复重算');

  // sticky 导航保留，但必须是不带模糊的实色胶囊
  assert.match(decls, /\.tabs\s*\{[^}]*position:sticky/s);
  assert.match(decls, /\.tabs\s*\{[^}]*background:var\(--glass-nav\)/s);

  // 卡片 hover 不再位移（位移会被感知成「白色区域放大」）
  assert.doesNotMatch(decls, /\.homecard:hover\s*\{[^}]*transform/s);
  assert.doesNotMatch(decls, /\.jobitem:hover\s*\{[^}]*transform/s);
});

// ---- 默认子页 ----

test('进入 ONES 页默认落在「工时概览」', async () => {
  const page = loadPage();
  const calls = stubFetch(page);
  await clickTopTab(page, 'ones');

  // 默认子页是工时概览 → 不自动查排期
  assert.equal(calls.length, 0, '默认不应自动查排期');

  // 页面结构上：工时是第一个且带 on，卡片默认可见；排期卡片默认隐藏
  const raw = renderPage();
  assert.match(raw, /<button class="on" data-o="manhour">工时概览<\/button>/, '工时概览应是第一个且默认选中');
  assert.match(raw, /id="o-manhour">/, '工时卡片默认可见');
  assert.match(raw, /id="o-schedule" style="display:none"/, '排期卡片默认隐藏');
});
