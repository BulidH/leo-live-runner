# 🔎 ES 搜索云平台探查与测试环境安全 CRUD 手册 (ES Search Guide)

本手册专为对接**贝壳搜索云平台 (`search.ke.com`)** 提供操作指引，彻底脱离本地项目代码目录与微服务名依赖，提供索引资产自动发现、精准字段结构与语义解析、双环境数据检索与测试环境安全 CRUD。

---

## 🌐 1. 核心设计与云平台直连机制

使用者调用时**无需提供微服务 `appId`、无需处于项目代码目录下、也无需手动配置网关与 Token**：

1. **自动登录态中继与缓存**：
   - 通过 `createCredentialSession`（`scripts/common/browser_credentials.js`）自动从随附 Chrome 扩展获取 `search.ke.com` Cookie；
   - 验证通过后持久化至 `~/.shrimp/skills/live-inspector/search_cookie.json`（支持 `--set-cookie` 或 `SEARCH_COOKIE` 环境变量覆盖）。
2. **个人授权索引目录 (`es_catalog.json`)**：
   - 调用 `search.ke.com/ajax/createApp/getAppList` 拉取当前工号已授权的全部 ES 索引（含 `serviceId`、名称、业务描述、接入方式）；
   - 缓存至 `~/.shrimp/skills/live-inspector/es_catalog.json`（24 小时有效，可传 `--refresh` 强制刷新）。
3. **双环境配置动态解析 & 双网关协议适配**：
   - **线上环境 (`-e prod`)**：读取 `detailSearchQA/getVersionList` 与 `getConfig`，提取线上查询网关、Token、精确 `mapping`、`routingField` 及 `binlogSource`；
   - **测试环境 (`-e test`)**：自动依次尝试 `detailBusinessQA` 与 `detailBusinessRD`（可通过 `--role qa|rd` 指定优先级），支持 `pull`/`push` 与 ES8 原生 DSL 网关 (`/search/es`)。

---

## 🛡️ 2. 字段理解与纯正则生产安全铁律

1. **字段结构与业务语义解答**：
   - 执行 `--schema` 时，脚本合并展示 `search.ke.com` 官方 `mapping`（字段类型、是否可检索、`nested` 子字段、`dense_vector` 向量维度与模型）、`routingField` 路由键、上游 `binlogSource`（库/表/业务主键）以及实时样本值；
   - AI 应结合这些信息为用户清晰解释每个字段的业务含义与可检索方式。
2. **纯规则判决 (`TEST_PATTERNS`)**：
   - 严格依靠测试环境语义正则（涵盖 `.test.ke.com`、`-test.`、`sit`、`qa`、`dev` 等）；
3. **疑罪从严，生产物理死锁**：
   - 任何未匹配到 `TEST_PATTERNS` 的 URL 或指定 `-e prod` 的请求，**一律判定为生产环境，底层代码彻底阻断新增/修改/删除等写操作**；
4. **测试环境两阶段预审**：
   - 测试环境修改强制要求 Pre-flight 试运行（打印变更前现有值 vs 拟写入新值 Diff 对比单），用户明确确认或追加 `--confirm` 后方可正式写入。

---

## ⚡ 3. 常用 CLI 命令速查

### 3.1 索引目录发现与字段语义探查
```bash
# 列出当前工号已授权的所有 ES 索引 (支持 --refresh 强制同步)
node scripts/es_query.js --list-indexes

# 查看精准 Mapping 字段、上游数据源、路由键与真实样本值
node scripts/es_query.js 1036710001 --schema -e prod
node scripts/es_query.js 订单 --schema -e prod
node scripts/es_query.js 智能客服 --schema -e test
```

### 3.2 多维度数据检索
```bash
# 按 serviceId 或索引名关键词查询最新 10 条线上数据
node scripts/es_query.js 1036710001 -n 10 -e prod
node scripts/es_query.js 门锁 -n 10 -e prod

# 测试环境数据检索 (自动匹配 BusinessQA / BusinessRD)
node scripts/es_query.js 智能客服 -n 5 -e test

# 带关键词、键值对过滤或自定义 DSL 查询
node scripts/es_query.js 门锁 -q "合肥" --filter "cityCode:340100" -n 5
node scripts/es_query.js 1013506001 -e test --dsl '{"query":{"term":{"cityCode":"110000"}}}'
```

### 3.3 测试环境数据 CRUD (两阶段确认)
```bash
# 阶段 1: 更新部分字段 (Dry-Run 预审模式，展示 Diff)
node scripts/es_modify.js 门锁 --action update-part --id "10001" --data '{"battery": 95}' -e test

# 阶段 2: 确认无误后正式提交写入并自动回查验证
node scripts/es_modify.js 门锁 --action update-part --id "10001" --data '{"battery": 95}' -e test --confirm

# 测试环境删除文档
node scripts/es_modify.js 门锁 --action delete --id "10001" -e test --confirm
```
