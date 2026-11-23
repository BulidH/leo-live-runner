# 🛡️ Luke 权限中心双环境治理与全景画像手册 (Luke Permission Guide)

本手册专为微服务架构提供 **RBAC 鉴权与上下文约束自动化治理** 指南，指导 AI 在执行权限探查、角色维护、员工授权画像与双人三层 Diff 时的标准协议。

---

## 🌐 1. 双环境架构矩阵与凭据中继

* 🧪 **测试环境 (TEST)**：`https://test-luke.ke.com`（默认环境，参数 `-e test`）
* 🔴 **线上生产环境 (PROD)**：`https://luke.ke.com`（参数 `-e prod`）

### 鉴权凭据与中继自愈
- 核心凭证 Cookie：`luke-token`、`login_ucid` 等；
- 本地持久化路径：`~/.shrimp/skills/live-inspector/luke_cookie.json`；
- 凭证缺失或明确失效时，通过随附 Chrome 扩展自动中继同步；浏览器未登录时温和引导用户在 Chrome 中登录目标网站后重试。

---

## 🛡️ 2. 严格的两阶段风控原则与线上/删除高危拦截机制

为防止意外篡改权限体系、影响线上生产业务或引发级联鉴权故障，变更引擎执行严格的**两阶段风控闭环与高危操作阻断**：

```
                    ┌─────────────────────────────────────────┐
                    │ 用户提出权限配置/修改/删除需求           │
                    │ (测试环境 -e test 或 线上生产 -e prod)   │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │ 阶段 1: AI 后台 Pre-flight 静态推演     │
                    │ 探查当前线上/测试现状，计算精确 Diff     │
                    │ 自动遍历级联影响的角色与受影响人员名单   │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │ 交付《高危操作/变更预审 Diff 报告》      │
                    │ 🛑 强制停下，主动向用户汇报并等待明确确认│
                    └────────────────────┬────────────────────┘
                                         │
                               用户明确输入 "确认" / "执行"
                                         │
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │ 阶段 2: 带 --confirm 提交正式写接口     │
                    │ 正式写入并立即发起回读校验               │
                    └─────────────────────────────────────────┘
```

### 🚨 触发高危预警与强制用户确认的场景：
1. **线上生产环境的一切修改与操作 (`-e prod`)**：线上任何角色赋权、接口增删均直接影响真实员工与业务可用性，必须展示 Diff 并经用户明确确认。
2. **任何环境下的删除/缩减操作**：
   - 🔴 **删除角色** (`delete-role`)：直接影响该角色名下所有绑定的员工；
   - 🔴 **删除权限点** (`delete-perm`)：级联影响所有包含此权限点的角色与相关人员；
   - 🔴 **从权限点剔除接口/服务** (`update-perm --remove-api / --remove-service`)：会导致依赖该 API 的角色鉴权失败 (403)；
   - 🔴 **从角色收回权限点或剔除接口** (`revoke-role-perm` / `grant-role-perm --remove-api`)；
   - 🔴 **解绑人员** (`unbind-role-user`)。

> ⚠️ **【高危铁律：绝对禁止未确认直写】**
> 当遇到上述场景时，变更引擎会自动输出 `🚨🚨🚨【高危操作预审报告 (HIGH RISK DELETION)】🚨🚨🚨` 警示横幅与级联影响清单。
> **AI 绝对禁止在未获得用户明确文字确认前擅自加上 `--confirm` 执行写入！** 必须向用户呈现完整报告并等待用户说“确认修改”或“确认删除”后才执行。

---

## ⚡ 3. 常用操作命令速查 (双环境 `-e test` / `-e prod`)

### 3.1 只读探查 (`scripts/luke_query.js`)

```bash
# 查询约束列表或指定约束的枚举值 (默认 test)
node scripts/luke_query.js ext
node scripts/luke_query.js ext serviceId

# 查询线上生产环境中的约束
node scripts/luke_query.js ext serviceId -e prod

# 查询权限点详情与绑定的接口
node scripts/luke_query.js perm anjia:storage:order:afterSaleOrder
node scripts/luke_query.js perm anjia:storage:order:afterSaleOrder -e prod

# 查询角色详情与权限树
node scripts/luke_query.js role admin
node scripts/luke_query.js role -q 看板管理员 -e prod

# 查询角色名下绑定的真实员工列表
node scripts/luke_query.js users admin
node scripts/luke_query.js users admin -e prod

# 👤 查询员工名下生效的角色与权限点全景画像 (支持工号或姓名)
node scripts/luke_query.js user 张林
node scripts/luke_query.js user 1000000030560224 -e prod

# 👥 对比两人之间的权限差异 (三层递进: 角色 -> 权限点 -> 数据约束)
node scripts/luke_query.js diff-user 张林 李四
node scripts/luke_query.js diff-user 1000000030560224 1000000012345678 -e prod --json
```

### 3.2 变更引擎 (`scripts/luke_modify.js`)

```bash
# ------------------------------
# 1. 权限点接口维护 (增/删 API)
# ------------------------------
# 为权限点追加新 API (默认 Pre-flight 试运行)
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder --api "/anjia/afterSale/newApi"
# 用户确认后正式执行
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder --confirm --api "/anjia/afterSale/newApi"

# 🔴 高危：从权限点中剔除某个接口 (自动触发高危预警与影响面分析，严禁未确认直写)
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder --remove-api "/anjia/afterSale/oldApi"
# 用户明确确认后带 --confirm 执行
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder --confirm --remove-api "/anjia/afterSale/oldApi"

# 🔴 线上生产环境操作 (带 -e prod，先 Pre-flight 确认后再执行)
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder -e prod --api "/anjia/afterSale/newApi"
node scripts/luke_modify.js update-perm anjia:storage:order:afterSaleOrder -e prod --confirm --api "/anjia/afterSale/newApi"

# ------------------------------
# 2. 角色维护与授权
# ------------------------------
# 新建角色
node scripts/luke_modify.js create-role warehouse-op 仓储运维专员 --desc "日常仓储管理"

# 🔴 高危：删除角色 (自动排查关联员工，需确认)
node scripts/luke_modify.js delete-role warehouse-op
node scripts/luke_modify.js delete-role warehouse-op --confirm

# 为角色授权并限定约束值 (展示 Diff 与受影响员工)
node scripts/luke_modify.js grant-role-perm anjiah5:inventoryAdmin anjia:storage:order:afterSaleOrder --api "/anjia/custom/api"
node scripts/luke_modify.js grant-role-perm anjiah5:inventoryAdmin anjia:storage:order:afterSaleOrder --confirm --api "/anjia/custom/api"

# 🔴 高危：从角色中剥离某个 API
node scripts/luke_modify.js grant-role-perm anjiah5:inventoryAdmin anjia:storage:order:afterSaleOrder --remove-api "/anjia/custom/api"
node scripts/luke_modify.js grant-role-perm anjiah5:inventoryAdmin anjia:storage:order:afterSaleOrder --confirm --remove-api "/anjia/custom/api"

# ------------------------------
# 3. 人员绑定与解绑
# ------------------------------
# 绑定人员到角色
node scripts/luke_modify.js bind-role-user anjiah5:inventoryAdmin 1000000030560224
# 🔴 高危：从角色中解绑人员
node scripts/luke_modify.js unbind-role-user anjiah5:inventoryAdmin 1000000030560224
node scripts/luke_modify.js unbind-role-user anjiah5:inventoryAdmin 1000000030560224 --confirm
```

---

## 👤 4. 员工权限全景画像与双人三层深度 Diff (User & Diff-User)

在日常权限排障与线上问题核实中，“为什么张三能访问而李四报 403”、“某员工到底拥有哪些实际生效的角色与数据范围”是最常见的排障诉求。本功能通过并发分页与内存反查索引，提供极速的单人全景画像与双人深度对比能力。

### 4.1 CLI 命令与参数选项
```bash
# 1. 员工单人权限全景画像 (User Profile)
node scripts/luke_query.js user <ucid|name> [--app <appCode>] [-e test|prod] [--json]

# 2. 双人权限三层深度 Diff (User Diff)
node scripts/luke_query.js diff-user <user1> <user2> [--app <appCode>] [-e test|prod] [--json]
```

* `<ucid|name>`: 支持输入员工工号（如 `1000000030560224`）或姓名（如 `张林`）；遇到同名员工时自动激活**消歧保护机制**，列出所有同名候选人工号与所属角色供进一步精准查询；
* `--app <appCode>`: 显式指定目标应用系统（默认为 `DEFAULT_APP_ID` 即 `iot_auth`）；
* `-e / --env <test|prod>`: 环境切换（默认 `test` 测试环境 `test-luke.ke.com`，支持 `-e prod` 线上生产环境 `luke.ke.com`）；
* `--json`: 输出纯净机器可读结构化 JSON，供上层测试框架或自动化编排消费。

### 4.2 单人画像聚合与多角色约束并集自动合并
- **全量角色自动扫描**: 后台自动遍历目标应用系统名下的全部角色，并发分页抓取角色绑定的员工列表，在内存中构建实时反查索引（`UserMemoryIndex`）；
- **生命周期状态过滤**: 严格校验角色有效期 (`expireDate`)、用户绑定有效期 (`userBindingExpireDate`) 与启用状态 (`active`)，自动过滤已过期或被禁用的无效角色；
- **多角色权限点与约束自动取并集**: 当员工通过多个不同角色获得同一个权限点时，引擎自动对挂载的各类数据约束取并集（如角色 A 赋予 `cityCode: [110000]`，角色 B 赋予 `cityCode: [310000]`，画像将自动合并生效范围为 `[110000, 310000]`）；
- **完整资产直达输出**: 直接输出角色标识 (`roleId`)、角色名称、权限点标识 (`permId`)、权限点名称、生效数据约束（含关联接口路径 `apiUrl`、微服务 `serviceId`、城市范围 `cityCode` 等）、来源角色，以及 **Luke 控制台 Web 直达链接 (`portalUrl`)**。

### 4.3 双人权限三层渐进式深度 Diff 机制
当对比员工 A 与员工 B 的权限差异时，系统自顶向下进行三层逐级下探分析：
* **Tier 1: 角色层差异 (Roles Diff)**
  - 标记 `[A独有]`、`[B独有]`、`[共有]` 角色；
  - 附带角色 Code、角色名称及 Luke 控制台直达链接；
* **Tier 2: 权限点层差异 (Permissions Diff)**
  - 标记 `[A独有]`、`[B独有]`、`[共有]` 权限点；
  - 标明该权限点来源于哪个具体角色，直观揭示因角色缺失带来的权限断层；
* **Tier 3: 数据约束深度下探 (Constraint Scope Diff)**
  - 针对两人共有的权限点，深度逐字段比对生效约束取值集合（如城市代码 `cityCode`、API 路径 `apiUrl`、微服务标识 `serviceId` 等取值差集）；
  - 精准计算单方独有约束值集合（`onlyInA` vs `onlyInB`），并在终端仅展示存在差异的约束行，屏蔽无差异噪点；
  - 若两人权限全景画像 100% 完全一致，直接输出庆贺横幅 `🎉 两人名下在当前系统的生效权限与数据范围 100% 完全一致！`。

### 4.4 核心字段与控制台 Web 直达链接
为方便技术人员与业务负责人核验，所有输出均完整呈现以下五大核心要素：
1. **角色 Code (`roleId`)**: 系统级唯一角色标识（如 `anjiah5:inventoryAdmin`）；
2. **权限 Code (`permId`)**: 接口/操作唯一权限点标识（如 `anjia:lock:infoView`）；
3. **约束 Code (`extId`)**: 维度唯一标识（如 `cityCode`、`apiUrl`、`serviceId`）；
4. **关联接口路径 (`apiUrl`)**: 真实后端受控 API 路径（如 `/api/v1/locks/info`）；
5. **Luke 控制台 Web 直达 URL (`portalUrl`)**: 自动拼装包含环境前缀与目标 Tab 的官方控制台链接（如 `https://luke.ke.com/#/app/iot_auth/role`），可直接在浏览器一键打开。

---

## 📢 5. AI 交互与自然语言交付规范 (AI Delivery Standard)

在为最终用户提供权限诊断、查权与授权对比服务时，AI **必须严格遵守以下自然语言交付铁律**：

1. **🚫 严禁直接向最终用户倾倒 CLI 原始 JSON / 冗长终端输出**：
   - CLI 返回的结构化 JSON 仅供 AI 后台精准推理和提取事实证据；
   - 对外交付时必须转化为结构清晰、重点突出的 Markdown 概览结论与表格，严禁大段贴出未经提炼的 JSON 字符串。
2. **🎯 核心结论先行 (Conclusion First)**：
   - 回复的第一句话必须直奔主题，给出定性排障结论。例如：
     > “**张林相比李四，缺少角色【安家H5-库存管理员 (`anjiah5:inventoryAdmin`)】，导致缺少权限点【门锁删除 (`anjia:lock:delete`)】；在共有权限【门锁查看】下，缺少城市代码 `310000 (上海)` 的数据权限。**”
3. **🔗 完整列出 Code 与 Luke 控制台直达 URL**：
   - 提及角色时必须列出完整角色 Code（如 `anjiah5:inventoryAdmin`）；
   - 提及权限点时必须列出完整权限 Code（如 `anjia:lock:infoView`）；
   - 提及约束时必须列出约束 Code 与具体取值差集（如 `apiUrl: [/api/v1/locks/delete]`）；
   - 必须在报告中附带 Luke Portal Web 直达链接，方便用户或管理员一键点击跳转至 Luke 控制台进行审核、申请或分配。
4. **🛠️ 给出明确、可落地的排障与修复指引**：
   - **缺失角色时**：明确告知缺少哪个角色 Code，并指引用户前往 Luke 申请该角色，或提供管理员绑定命令：`node scripts/luke_modify.js bind-role-user <roleId> <ucid>`；
   - **角色具备但缺少数据约束时**：明确指出缺失的城市代码或接口范围，指引在角色授权配置中通过 `grant-role-perm` 扩充对应约束取值；
   - **针对 403 接口鉴权拦截排查**：直接反查报错接口 URL 是否挂载在对应权限点下，明确指出是角色未绑定、接口未加权限点、还是限定约束（如 cityCode）未包含当前操作上下文。
