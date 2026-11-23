# 🗼 灯塔 ARMS 前端监控与全链路排障手册 (ARMS Monitor Guide)

本手册专为直连公司前端监控平台 `http://arms.fee.lianjia.com` 提供全链路排障指南，补齐前端侧的线上与测试环境排障闭环（只读观测，**不包含告警规则、告警历史与自定义看板**）。

---

## 🌐 1. 核心特性与双轨鉴权机制

### 1.1 双轨鉴权自动切换
1. **轨道 A（优先 `x-api-key`）**：
   - 读取 `--api-key` 参数、`ARMS_API_KEY` 环境变量或 `~/.shrimp/skills/live-inspector/arms_api_key.json`（可通过 `--set-api-key <key>` 写入）；
   - 完全脱离浏览器依赖，稳定支持：日志检索与聚合、`viewid` 单次访问全链路追踪、异常错误榜、资源异常、白屏监测、性能 Web Vitals 与 API 慢/失败请求排查。
2. **轨道 B（自动回退 Chrome Cookie 中继）**：
   - 未配置 API Key 或显式加传 `--use-cookie` 时，自动复用 `createCredentialSession` 从随附 Chrome 扩展同步 `arms.fee.lianjia.com` 登录态；
   - 验证通过后自动缓存至 `~/.shrimp/skills/live-inspector/arms_cookie.json`。

### 1.2 免登录项目自发现与自学习
- 调用免鉴权接口 `/api/aiMcp/project/list` 拉取全量项目清单并缓存至 `~/.shrimp/skills/live-inspector/arms_projects.json`（24h 有效，支持 `--refresh`）；
- 支持传项目 ID（如 `1737`）、项目标识（如 `app-life-fe-intelligentize`）、Git 仓库名（如 `life-fe-intelligentize`）或中文显示名（如 `智慧工地H5`）；
- 未提供项目参数时，脚本自动探测当前本地 Git 仓库推导对应项目。

---

## ⚡ 2. 常用 CLI 命令速查 (`scripts/arms_query.js`)

```bash
# 0. 保存 x-api-key (可选，已配置后无需浏览器登录态)
node scripts/arms_query.js --set-api-key <你的API_KEY>

# 1. 查找灯塔项目 (免鉴权)
node scripts/arms_query.js projects intelligentize

# 2. 查看项目健康分、PV/UV、错误率与体验分概览
node scripts/arms_query.js overview life-fe-intelligentize

# 3. 自定义条件日志检索与聚合 (queryData，最大窗口 7 天)
node scripts/arms_query.js logs 1737 -q "TRTC SDK初始化失败" -t today -n 10 --slim
node scripts/arms_query.js logs 1737 -q "TRTC" --aggs pageType -t today
node scripts/arms_query.js logs 1737 -f "common.ucid=3000110000457769" -f "extra~TRTC" -t 24h

# 4. 运行时 / 资源加载 / 白屏异常 TOP 榜与采样明细
node scripts/arms_query.js errors 1737 --kind all -n 10
node scripts/arms_query.js errors 1737 --kind resource --source-type script
node scripts/arms_query.js errors 1737 --error-id "===TRTC SDK初始化失败:===TRTC SDK初始化失败:"

# 5. 按 viewId 还原单次访问全链路时间线 (PV -> 性能 -> API 失败/慢请求 -> JS 报错)
node scripts/arms_query.js trace 1737 2w4360jic43mwmzff5g

# 6. Core Web Vitals 性能分位与 API 请求健康度
node scripts/arms_query.js perf 1737 --metric LCP --days 7
node scripts/arms_query.js api 1737 --failed-only -t 24h -n 20
node scripts/arms_query.js pvuv 1737
```
