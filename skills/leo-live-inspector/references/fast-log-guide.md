# 📘 FAST / Kibana 日志与全链路 Trace 排障参考手册 (Fast Log Guide)

本手册为 AI Agent 在执行线上生产环境与测试环境日志排查、异常捕获与 TraceId 全链路时序分析时提供底层检索语法、CLI 参数速查及排障方法论。

---

## ⚡ 1. 线上环境：FAST 日志检索内部 CLI 参数速查 (`scripts/fast_query.js`)

AI 后台执行 `node scripts/fast_query.js [flags]`：

| 参数 Flag | 简写 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--app` | `-a` | `iot-platform` | 目标微服务名 (如 `iot-platform`, `utopia-scs-saas`) |
| `--query` | `-q` | `*` | Lucene 检索短语 / 表达式 |
| `--time` | `-t` | `24h` | 相对时间范围 (如 `15m`, `1h`, `24h`, `7d`) |
| `--from` | - | `null` | 起始时间 (支持 `2026-08-31 14:00:00` 或 `now-1h`) |
| `--to` | - | `now` | 结束时间 (支持绝对时间或 `now`) |
| `--size` | `-n` | `20` (Trace: `50`) | 最大返回日志条数 |
| `--order` | `-o` | `desc` (Trace: `asc`) | 排序方式: `desc` (最新在前) 或 `asc` (正序链路) |
| `--level` | `-l` | `null` | 日志级别过滤: `ERROR`, `WARN`, `INFO`, `DEBUG` |
| `--bltag` | - | `null` | 出入参标签: `request_in`, `request_out` 等 |
| `--uri` | `-u` | `null` | 接口 URI 过滤 (如 `/api/sync/lockDetail`) |
| `--traceId` | `--tid` | `null` | 指定 TraceId (自动切换为正序链路回溯模式) |
| `--slim` | - | `false` | 瘦身模式，截断超长报文与堆栈 JSON |
| `--format` | `-f` | `json` | 输出格式: `json`, `brief`, `table` |

---

## 🧪 2. 线下/测试环境：Paoding Loki 容器与泳道日志检索 (`scripts/test_log_query.js`)

AI 后台执行 `node scripts/test_log_query.js <appId> [options]`：

| 参数 Flag | 简写 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `<appId>` | - | 必填 | 目标微服务别名 (如 `saas`, `algo`, `warehouse`, `iot`) |
| `--query` | `-q` | `*` | 关键词或报错过滤短语 (如 `NullPointer`, `Timeout`) |
| `--level` | `-l` | `null` | 日志级别: `ERROR`, `WARN`, `INFO`, `DEBUG` |
| `--traceId` | `--tid` | `null` | 指定 TraceId 过滤与调用链回溯 |
| `--lane` | `--ns` | `null` | 指定大禹泳道名或命名空间 (如 `lixiaojing02`, `lixiaojing03`) |
| `--pod` | - | `null` | 显式指定 Pod 实例名称 |
| `--time` | `-t` | `1h` | 相对时间跨度 (如 `15m`, `30m`, `1h`, `2h`) |
| `--size` | `-n` | `20` (Trace: `50`) | 最大返回日志条数 |
| `--format` | `-f` | `table` | 输出格式: `table` (表格), `brief` (紧凑), `json` |
| `--slim` | - | `false` | 瘦身模式，截断超长堆栈或报文 |
| `--set-cookie`| - | - | 保存更新 Paoding 登录 Cookie 凭证至本地缓存 |

> 💡 **自动分流支持**：在 `fast_query.js` 中指定 `--env test` 时，底层会自动委派至 `test_log_query.js` 容器直连通道。

---

## 🧭 3. 典型场景与意图映射速查

| 用户自然语言场景 | AI 后台自动组装与执行的指令 | 内部检索逻辑与 DSL |
| :--- | :--- | :--- |
| **查最新实时日志** | `node scripts/fast_query.js -a iot-platform -t 15m -n 10` | `sort: [{ timestamp: { order: "desc" } }]` |
| **精准定位异常堆栈** | `node scripts/fast_query.js -a utopia-scs-saas --level ERROR -t 1h` | 自动匹配 `(loglevel:ERROR OR logLevel:ERROR OR level:ERROR)` |
| **TraceId 全生命周期回溯** | `node scripts/fast_query.js -a iot-platform --traceId "361922-..."` | 自动升序 `sort: [{ timestamp: { order: "asc" } }]` 并扩充 48h 跨度 |
| **接口入参/出参抓取** | `node scripts/fast_query.js -a iot-platform --uri "/api/sync/lock" --bltag request_out` | 过滤 `data_uri:"/api/sync/lock" AND data_bltag:request_out` |
| **精确历史时段排障** | `node scripts/fast_query.js -a iot-platform --from "2026-08-31 14:00:00" --to "2026-08-31 14:30:00"` | 精确过滤 `timestamp` 范围 |
| **超长报文与堆栈瘦身** | `node scripts/fast_query.js -a iot-platform '*' 1h 20 --slim` | 截断超出 260 字符的超长 JSON |

---

## ⚡ 4. 底层查询引擎架构与自愈细节

### 4.1 双引擎联动自愈架构 (Dual-Engine Self-Healing)
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
