# 📘 FAST / Kibana 日志与全链路 Trace 排障参考手册

本手册为 **AI Agent** 在执行线上排障时提供底层 ES DSL 语法、意图参数组装及排障方法论。

---

## 🧭 AI 内部调用意图映射速查

AI 在接收到用户自然语言排查需求时，自动在后台组装以下参数静默执行：

| 用户自然语言场景 | AI 后台自动组装与执行的指令 | 内部检索逻辑与 DSL |
| :--- | :--- | :--- |
| **查最新实时日志** | `node scripts/fast_query.js -a iot-platform -t 15m -n 10` | `sort: [{ timestamp: { order: "desc" } }]` |
| **精准定位异常堆栈** | `node scripts/fast_query.js -a utopia-scs-saas --level ERROR -t 1h` | 自动匹配 `(loglevel:ERROR OR logLevel:ERROR OR level:ERROR)` |
| **TraceId 全生命周期回溯** | `node scripts/fast_query.js -a iot-platform --traceId "361922-..."` | 自动升序 `sort: [{ timestamp: { order: "asc" } }]` 并扩充 48h 跨度 |
| **接口入参/出参抓取** | `node scripts/fast_query.js -a iot-platform --uri "/api/sync/lock" --bltag request_out` | 过滤 `data_uri:"/api/sync/lock" AND data_bltag:request_out` |
| **精确历史时段排障** | `node scripts/fast_query.js -a iot-platform --from "2026-08-31 14:00:00" --to "2026-08-31 14:30:00"` | 精确过滤 `timestamp` 范围 |
| **超长报文与堆栈瘦身** | `node scripts/fast_query.js -a iot-platform '*' 1h 20 --slim` | 截断超出 260 字符的超长 JSON |

---

## ⚡ 底层查询引擎架构与自愈细节

### 🌟 双引擎联动自愈架构 (Dual-Engine Self-Healing)
1. **一级通道（Fast-Path 极速直连）**：
   * 已收录的微服务直接向内网 Kibana 网关（如 `https://fast108-kibana-logcenter-intra.intra.ke.com/internal/search/es`）发起原生 HTTP POST；
   * 单次检索耗时仅需 **100~200ms**，日常使用无需拉起浏览器。
   * 请求头携带：
     ```json
     {
       "content-type": "application/json",
       "kbn-xsrf": "kibana",
       "kbn-version": "7.7.0"
     }
     ```

2. **二级通道（纯 HTTP API 直抓优先 + 页面探针兜底）**：
   * **HTTP API 直抓（免开页面）**：遇未收录或失效服务时，优先复用本地缓存（`~/.shrimp/skills/live-inspector/fast_cookie.json` / `FAST_COOKIE`）或通过 `19527` 桥接从随附 Chrome 扩展静默获取 `fast.ke.com` 登录态 Cookie（扩展内置 `FAST_PROD` 每 20 分钟自动保活），直接请求 `POST https://fast.ke.com/es/queryconfiglist`（依次匹配 `<app>:prod`、默认列表及 `/app/appCode/linked`）与 `POST https://fast.ke.com/es/search/url` 获取真实的 `cluster` 与 `index`；
   * **页面探针兜底**：当旧版扩展不支持凭据导出等情况时，自动降级为后台独立窗口打开 `fast.ke.com` 提取组件中的 `cluster` 与 `index`；
   * **自动纠错缓存**：提取成功后自动更新 `~/.shrimp/skills/live-inspector/service_map.json` 并立即重试直连 Kibana ES（直连检索本身免凭据）。

3. **排序与时序保障 (`sort`)**：
   * 查日志默认倒序 `desc`，拿到最新事件；
   * 查 TraceId 自动正序 `asc`，保障 AI 能顺畅提取步骤并绘制准确的 Mermaid 时序交互图。
