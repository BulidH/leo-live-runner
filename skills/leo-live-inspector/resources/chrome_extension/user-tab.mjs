import { lanternError } from "./errors.mjs";

// 记录「扩展自己开出去的标签页」，用于下次复用与安全关闭。
// 用 local 而不是 session：扩展重载/浏览器重启后 session 会被清空，标签的归属就丢了。
const OWNED_KEY = "userTabs.owned";
const OWNED_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OWNED = 40;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function loadOwned(chromeApi) {
  try {
    const stored = await chromeApi.storage.local.get(OWNED_KEY);
    const raw = stored?.[OWNED_KEY];
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw.filter((e) => e && e.tabId != null && now - (e.at || 0) < OWNED_TTL_MS);
  } catch {
    return [];
  }
}

async function saveOwned(chromeApi, owned) {
  try {
    await chromeApi.storage.local.set({ [OWNED_KEY]: owned.slice(-MAX_OWNED) });
  } catch {}
}

/**
 * 在用户自己的浏览器窗口里打开一个普通标签页 —— 不建标签组、不开独立窗口、不碰任务状态。
 *
 * 与 tabs.new 的区别（很重要）：
 *   - tabs.new 属于任务系统：会建任务窗口、把标签归入任务分组，是给 Agent 自己干活用的；
 *   - tabs.open 属于「给人看」：就是用户平时新建一个标签页而已，和点 + 号没区别。
 *
 * 绝不导航用户已有的标签页：只有本扩展开过、且仍在同一窗口同源的标签才会被复用。
 */
export async function openInUserWindow(chromeApi, params = {}, taskState = null) {
  const url = String(params.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw lanternError("invalid_request", "tabs.open needs an http(s) url");
  }
  const focus = params.focus !== false;
  const wantOrigin = originOf(url);
  // 任务窗口是 Agent 的工作区，不要把「给人看的页面」塞进去
  const taskWindowId = taskState?.activeTask?.windowId ?? null;

  const owned = await loadOwned(chromeApi);
  let liveOwnedIds = new Set();
  try {
    const allTabs = await chromeApi.tabs.query({});
    liveOwnedIds = new Set(allTabs.map((t) => t.id));
  } catch {}

  // ① 只在自己开过的标签里找同源页复用
  const reusable = owned.find(
    (e) => liveOwnedIds.has(e.tabId) && e.origin === wantOrigin && wantOrigin
  );
  if (reusable) {
    const updated = await chromeApi.tabs.update(reusable.tabId, { url, active: focus });
    if (focus) {
      try {
        await chromeApi.windows.update(updated.windowId, { focused: true });
      } catch {}
    }
    await saveOwned(
      chromeApi,
      owned.map((e) => (e.tabId === reusable.tabId ? { ...e, url, origin: wantOrigin, at: Date.now() } : e))
    );
    return { tabId: updated.id, windowId: updated.windowId, reused: true, url, focused: focus };
  }

  // ② 新开一个普通标签页，落在用户当前正在用的窗口里
  const windows = (await chromeApi.windows.getAll({ windowTypes: ["normal"] })).filter(
    (w) => w.id != null && w.id !== taskWindowId
  );

  let created;
  let windowId;
  if (!windows.length) {
    created = await chromeApi.windows.create({ url, focused: focus, type: "normal" });
    const tab = created.tabs?.[0];
    created = tab || { id: null, windowId: created.id };
    windowId = created.windowId ?? created.id;
    await saveOwned(chromeApi, [...owned, { tabId: created.id, origin: wantOrigin, url, at: Date.now() }]);
    return { tabId: created.id ?? null, windowId, reused: false, url, focused: focus };
  }

  const target = windows.find((w) => w.focused) || windows[0];
  const tab = await chromeApi.tabs.create({ windowId: target.id, url, active: focus });
  if (focus) {
    try {
      await chromeApi.windows.update(target.id, { focused: true });
    } catch {}
  }
  await saveOwned(chromeApi, [...owned, { tabId: tab.id, origin: wantOrigin, url, at: Date.now() }]);
  return { tabId: tab.id, windowId: target.id, reused: false, url, focused: focus };
}

/**
 * 关闭「本扩展自己开过」的标签页。用户自己开的标签不在登记里，一律不动。
 */
export async function closeOwnedTab(chromeApi, params = {}) {
  const tabId = Number(params.tabId);
  if (!tabId) throw lanternError("invalid_request", "tabs.close-own needs tabId");
  const owned = await loadOwned(chromeApi);
  if (!owned.some((e) => Number(e.tabId) === tabId)) {
    throw lanternError("invalid_request", "该标签页不是本扩展开的，拒绝关闭");
  }
  try {
    await chromeApi.tabs.remove(tabId);
  } catch (err) {
    if (!/No tab with id/i.test(String(err?.message || err))) throw err;
  }
  await saveOwned(chromeApi, owned.filter((e) => Number(e.tabId) !== tabId));
  return { closed: true, tabId };
}
