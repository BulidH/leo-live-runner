# 🏢 UC 组织与人员角色管理中心探查与测试环境角色治理手册 (UC Organization Guide)

本手册专为测试环境（`http://test3-uc.admin.ke.com` 与 `http://test-uc-relation-admin.ke.com`）提供全量人员、组织、城市公司、业务角色、关系配置（人-人、人-组织、组织-组织）、组织标签及 BPM 角色申请流探查，以及测试环境人员角色的两阶段安全治理指导。

---

## 🌐 1. 架构特性与双引擎无缝聚合

UC 探查与修改引擎采用双接口协议聚合：

1. **`test3-uc.admin.ke.com/graphql`（GraphQL + 本域 REST）**：
   - 负责人员分页/详情 (`getEhrUserVOByPage`, `getEhrUserVO`)；
   - 员工人事调转记录 (`getEhrUserEventQueueListByUcid`)；
   - 组织分页/详情/异动 (`getEhrOrgBasicVOByPage`, `getEhrOrgVO`, `getEhrOrgEventQueueListByOrgCode`)；
   - 组织树与上下级下探 (`getDisplayOrg`, `getChildNodes`, `getTreeNodeWithParentTreePath`)；
   - 城市公司与编码表 (`getCompVOForPage`, `getAllUcCity`)；
   - 五大远程 Sug 联想与 BPM 角色申请单。
2. **`test-uc-relation-admin.ke.com`（关系与角色 REST）**：
   - 负责人员绑定角色与管辖范围 (`/relation/queryAllUserRoleByUserCode`, `/userRole/queryRoleForUser`, `/userRole/queryUserRolePage`)；
   - 业务角色定义与属性 (`/role/queryRolePage`)；
   - 角色层级架构树 (`/user/org/relation/queryRoleTree`)；
   - 人-人 (`/user/user/relation/*`)、人-组织 (`/user/org/relation/*`)、组织-组织 (`/org/org/relation/*`) 关系配置与操作日志。

### 鉴权凭据与持久化
- 适用于 `test3-uc.admin.ke.com` 与 `test-uc-relation-admin.ke.com` 的 `.ke.com` 鉴权 Cookie（`sso_login_token`、`security_ticket_test`、`login_ucid` 等）；
- 本地自动缓存至 `~/.shrimp/skills/live-inspector/test_uc_cookie.json`。

---

## 🔍 2. 智能标识解析与中文自动转码

为了免除技术人员繁琐查询代码字典的负担，底层内置了自动转码与消歧引擎：

1. **查人智能识别**：
   - 支持 **16 位 UCID**（如 `1000000030560224`）；
   - 支持 **8 位系统号 `userCode`**（如 `30560224`）；
   - 支持 **中文姓名**（如 `张林`），遇到重名员工时自动激活消歧保护列表，展示候选人员信息。
2. **参数中文自动转码**：
   - `--city 北京` ➡️ 自动转为城市代码 `110000`；
   - `--role 商圈经理` ➡️ 自动检索角色表并转换为角色 ID `765`；
   - `--org 运营管理` ➡️ 自动转为组织编码 `XFTJ8001`。

---

## 🛡️ 3. 测试环境角色修改两阶段风控 (Zero Silent Mutation)

测试环境虽然允许对人员角色进行治理，但为杜绝意外破坏测试账号权限体系，强制遵循两阶段风控：

1. **绝对禁止静默写入**：
   - 任何角色新增 (`add-pos`)、修改 (`mod-pos`)、删除 (`del-pos`)、关系角色绑定/解绑 (`bind-role` / `unbind-role`)、组织业务模式修改 (`update-biz-mode`) **严禁直接带 `--confirm` 一步写入**；
2. **阶段 1：Pre-flight 预审 (Dry-Run)**：
   - 不带 `--confirm` 运行，系统自动查询目标员工当前已生效的手动角色列表；
   - 计算【变更前 vs 变更后】Diff 预审单（删除/解绑会自动标红并触发 `🚨🚨🚨【高危操作预审报告】`）；
   - **必须停下等待用户明确文字确认**。
3. **阶段 2：正式提交与自动回查 (Commit & Verify)**：
   - 用户明确回复“确认”后，AI 追加 `--confirm` 正式发起 GraphQL Mutation 或 REST 请求；
   - 提交成功后，脚本立即自动回查校验最新生效角色列表，并向用户交付结果。

---

## ⚡ 4. 常用 CLI 命令速查

### 4.1 全量只读探查 (`scripts/uc_query.js`)

```bash
# 查看当前登录的 UC 管理员账号、管理员角色与权限范围
node scripts/uc_query.js whoami

# 👤 员工 UC 全景画像 (支持 16位UCID / 8位系统号 / 姓名)
node scripts/uc_query.js user 30560224
node scripts/uc_query.js user 马楠

# 🔍 多维检索人员 / 找测试账号 (支持中文城市、角色、组织名自动转码)
node scripts/uc_query.js users --city 北京 --role 商圈经理 --status 在职 -n 10
node scripts/uc_query.js users --org XFTJ8001 --record 主岗

# 🎭 查询某员工名下所有角色明细 (UC岗位角色 + 关系中心角色及管辖门店/人员)
node scripts/uc_query.js roles 30560224

# 👥 按业务角色反查绑定人员列表 (关系维护表 + EHR岗位表双视图)
node scripts/uc_query.js role-users 商圈经理 --city 北京

# 📋 查询业务角色定义与映射的 UC 岗位 / 角色层级架构树
node scripts/uc_query.js role-defs 商圈经理
node scripts/uc_query.js role-tree 20192015

# 🏛️ 组织全景详情 / 组织多维分页检索 / 业务组织树
node scripts/uc_query.js org XFTJ8001
node scripts/uc_query.js orgs --city 天津 --status 1
node scripts/uc_query.js org-tree
node scripts/uc_query.js org-tree XFTJ7001

# 📜 人员人事调转记录 / 组织历史异动记录
node scripts/uc_query.js events 10138597
node scripts/uc_query.js events XFTJ8001

# 🏙️ 城市公司分页查询 & 全量城市编码表
node scripts/uc_query.js companies --city 北京
node scripts/uc_query.js cities

# 🤝 三大关系配置查询 (人-人 p2p / 人-组织 user-org / 组织-组织 org-org / 操作日志 rel-logs)
node scripts/uc_query.js p2p --role Community_Manager --city 北京
node scripts/uc_query.js user-org --role CA --city 北京
node scripts/uc_query.js org-org 200111 --city 北京
node scripts/uc_query.js rel-logs --role CA --city 北京

# 🏷️ 组织标签字典与实例 / 📨 BPM 角色申请记录 / 💡 通用 Sug 联想
node scripts/uc_query.js tags
node scripts/uc_query.js tags --instances --org XFTJ8001
node scripts/uc_query.js bpm 30560224
node scripts/uc_query.js sug pos 经理
```

### 4.2 测试环境角色与组织变更 (`scripts/uc_modify.js`，强制两阶段确认)

```bash
# 1. 新增员工 UC 岗位角色 (阶段 1: Pre-flight 预审 Diff -> 阶段 2: 用户确认后 --confirm)
node scripts/uc_modify.js add-pos 30560224 --org XFTJ8001 --role 商圈经理
node scripts/uc_modify.js add-pos 30560224 --org XFTJ8001 --role 商圈经理 --confirm

# 2. 修改员工已配置的 UC 岗位角色 (阶段 1: Pre-flight 预审 Diff -> 阶段 2: 用户确认后 --confirm)
node scripts/uc_modify.js mod-pos 30560224 --id 697424 --org LW1059 --role 12134
node scripts/uc_modify.js mod-pos 30560224 --id 697424 --org LW1059 --role 12134 --confirm

# 3. 🔴 高危：删除员工手动配置的 UC 岗位角色 (需用户二次确认)
node scripts/uc_modify.js del-pos 30560224 --id 697424
node scripts/uc_modify.js del-pos 30560224 --id 697424 --confirm

# 4. 关系配置中心角色绑定与解绑 (阶段 1 -> 阶段 2)
node scripts/uc_modify.js bind-role 30560224 --role GUANLIYUAN
node scripts/uc_modify.js bind-role 30560224 --role GUANLIYUAN --confirm
node scripts/uc_modify.js unbind-role 30560224 --role GUANLIYUAN
node scripts/uc_modify.js unbind-role 30560224 --role GUANLIYUAN --confirm
```
