# 🕊️ 白鸽网关三环境探查与治理手册 (Baige Gateway Guide)

本手册专为微服务网关探查与配置治理提供支持，涵盖**测试环境**、**预发环境**与**线上生产环境**三轨体系的微服务网关登记、路由组、子路由规则以及服务授权管理员探查与治理。

---

## 🌐 1. 三环境架构矩阵与凭据持久化

| 环境分类 | 环境标识 (`-e`) | 网关控制台服务端地址 | 说明 |
| :--- | :--- | :--- | :--- |
| 🟡 **测试环境 (TEST)** | `test` | `http://life-fe-baige-node.offline-beta.ttb.test.ke.com` | 测试环境微服务网关与路由配置 |
| 🟠 **预发环境 (PREVIEW)** | `preview` | `http://preview.baige.ke.com` | 预发/仿真环境微服务网关 |
| 🔴 **生产环境 (PROD)** | `prod` (默认) | `https://baige.ke.com` | 线上生产正式微服务网关 |

### 核心特性与通信机制
1. **纯 HTTP REST 极速直连**：针对测试/预发/生产三环境自动选择通讯协议（`http:` / `https:`）与端口，免除繁琐网络开销；
2. **多环境登录态自动中继与持久化**：支持从随附 Chrome 扩展自动中继获取凭据，并分别落盘至 `~/.shrimp/skills/live-inspector/` 下的 `test_baige_cookie.json`、`prev_baige_cookie.json` 与 `baige_cookie.json`。

---

## 🛡️ 2. 严格的生产/预发只读物理死锁与测试风控

1. **预发与生产物理死锁拦截**：
   - **预发环境 (`preview`) 与生产环境 (`prod`) 严格禁止执行任何写操作与路由变更**；
   - 底层脚本内置了严格的物理阻断机制，任何针对线上/预发的写操作（如添加管理员、修改域名、增删路由）均会被直接拒绝并抛出异常：
     ```bash
     node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e prod -> 🚨 自动拦截
     ```
2. **测试环境两阶段风控确认**：
   - 所有网关配置与路由修改仅允许在测试环境 (`-e test`) 中进行；
   - 默认执行 Pre-flight 试运行计算变更 Diff，严格要求用户明确文字确认后，方可追加 `--confirm` 执行正式提交。

---

## 🔍 3. 跨环境三态对照 (`check <serviceId>`)

微服务上线或排查网关 404/502 错误时，环境差异是最常见的根因。`baige_query.js check <serviceId>` 提供三环境并发探查与对比能力：
- 并发请求测试、预发与生产三环境；
- 对比登记状态、应用 ID、Eureka 转发目标、路由组总数；
- 校验当前工号在各环境的管理权限；
- 直接输出结构化对照看板与官方 Web 直达链接。

---

## ⚡ 4. 常用 CLI 命令速查

### 4.1 路由与网关只读探查 (`scripts/baige_query.js`)

```bash
# 查询已登记微服务列表 (默认 prod 生产环境，支持 -e test / preview)
node scripts/baige_query.js apps
node scripts/baige_query.js apps -q algo -e test
node scripts/baige_query.js apps -q algo -e preview

# 查看指定微服务的网关登记详情 (支持 serviceId 或纯数字应用 ID)
node scripts/baige_query.js detail utopia-scs-algo
node scripts/baige_query.js detail 144 -e prod
node scripts/baige_query.js detail utopia-scs-algo -e test

# 🛣️ 深度探查服务的网关路由信息 (路由组层级树、前缀、登录校验状态、下属子路由 URI 规则与所属泳道)
node scripts/baige_query.js routes utopia-scs-algo              # 查线上生产环境路由
node scripts/baige_query.js routes utopia-scs-algo -e preview   # 查预发环境路由
node scripts/baige_query.js routes utopia-scs-algo -e test      # 查测试环境路由
node scripts/baige_query.js routes utopia-scs-algo --json       # 导出结构化路由 JSON 供排障比对

# 查看服务的已授权管理员列表与当前账号权限状态
node scripts/baige_query.js users utopia-scs-algo

# 🔥 跨环境三态对照：并发检查服务在测试、预发与生产的登记、转发与路由状态
node scripts/baige_query.js check utopia-scs-algo
```

### 4.2 测试环境变更引擎与风控 (仅限 `-e test`)

```bash
# 测试环境添加管理员 (阶段 1: Pre-flight 试运行)
node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e test
# 用户确认后正式提交 (阶段 2: 带 --confirm)
node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e test --confirm

# 🔴 高危操作：移除服务管理员 (需用户二次确认)
node scripts/baige_modify.js delete-user utopia-scs-algo 30560224 -e test
node scripts/baige_modify.js delete-user utopia-scs-algo 30560224 -e test --confirm

# 修改测试环境服务域名配置
node scripts/baige_modify.js update-domain 6836 api.algo.ke.com,algo.ke.com -e test --confirm
```
