# 🗄️ 数据库查询参考手册 (Database Guide - 线上服务云 / 线下直连双模)

本手册专为微服务数据探查与测试环境数据治理提供指导，涵盖线上生产环境服务云 MySQL 只读网关与线下测试环境 MySQL 本地直连读写双模体系。

---

## 🌐 1. 架构总览与环境安全边界

| 环境分类 | 执行脚本 | 鉴权通道 | 读写权限 | 安全红线 |
| :--- | :--- | :--- | :--- | :--- |
| 🔴 **线上生产 (PROD)** | `scripts/cloud_mysql_query.js` | 服务云 `cloud_console_token_egg` | **严格物理只读** (`Slave` 从库优先) | 严禁任何 DML 写入或 DDL 结构变动 |
| 🟡 **测试/线下 (TEST)** | `scripts/test_mysql_query.js` | 动态密码解析 / 本地凭证缓存 | **读写双向支持** (DQL / DML / DDL) | 强制顶层 `WHERE` 保护，禁止无条件全表篡改 |

---

## 🔴 2. 线上生产环境：服务云 MySQL 自助查询 (`scripts/cloud_mysql_query.js`)

AI 后台执行 `node scripts/cloud_mysql_query.js <appId|port> [database|sql] [sql] [options]`：

### 2.1 参数选项与说明
| 参数/选项 | 简写 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `<appId\|port>` | - | 必填 | 目标微服务别名 (如 `recorder`, `saas`, `algo`) 或端口号 (如 `6763`) |
| `[database\|sql]` | - | 必填 | 库名（当第 1 参数为端口时）或待执行的 SQL（当第 1 参数为服务别名时） |
| `[sql]` | - | 可选 | 待执行的 SQL 语句（当第 1 参数为端口号时） |
| `--role` | - | `Slave` | 查询角色: `Slave` (从库只读，默认推荐) 或 `Master` (主库) |
| `--env` | `-e` | `prod` | 环境控制，指定 `test` / `dev` 时自动委派给 `test_mysql_query.js` |
| `--set-token` | - | - | 保存更新服务云 `cloud_console_token_egg` 凭证至本地缓存 |
| `--token` | - | - | 临时覆盖 Token |
| `--json` | - | `false` | 输出纯 JSON 数据结果 |

### 2.2 只读与表结构探查守则
1. **只读保护机制**：
   - 服务云线上数据库仅允许只读查询 (`SELECT`, `SHOW`, `EXPLAIN`, `DESCRIBE`)，任何写入、修改或删除请求会被网关直接物理拦截；
2. **表结构未知探查 SOP**：
   - 未知线上表名或字段名时，切勿盲猜！
   - 先执行列举所有数据表：
     ```bash
     node scripts/cloud_mysql_query.js <appId> "SHOW TABLES"
     ```
   - 探查具体表的字段结构与索引类型：
     ```bash
     node scripts/cloud_mysql_query.js <appId> "DESCRIBE <tableName>"
     ```
3. **已授权数据库目录**：
   - 可执行 `node scripts/cloud_mysql_query.js --list-dbs` 查看当前账号已授权的所有端口与数据库列表。

---

## 🟡 3. 线下/测试环境：MySQL 本地直连查询与写入 (`scripts/test_mysql_query.js`)

AI 后台执行 `node scripts/test_mysql_query.js <service|host> [datasource|sql] [sql] [options]`：

### 3.1 参数选项与说明
| 参数/选项 | 简写 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `<service\|host>` | - | 必填 | 微服务别名 (如 `saas`, `iot`, `recorder`, `cangjie`) 或测试库 Host/Port |
| `[datasource]` | - | 可选 | 多数据源别名 (如 `tenant0`, `tenant1`, `base`)，未填自动走默认主库 |
| `[sql]` | - | 必填 | 待执行的 SQL：查询 (`SELECT`/`SHOW`/`DESC`/`EXPLAIN`)、写入 (`INSERT`/`UPDATE`/`DELETE`/`REPLACE`)、结构 (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`) |
| `--ds <alias>` | - | 自动匹配 | 显式指定数据源名称 |
| `--list-ds` | - | `false` | 列出该服务下全部已注册的测试数据源与默认库 |
| `--force` | - | `false` | 强制执行无 WHERE 条件的 UPDATE/DELETE（默认拦截，防止全表误操作） |
| `-p, --password` | - | 动态嗅探 | 临时提供密码（握手验通后自动静默持久化至 `~/.shrimp`） |
| `--max-rows` | - | `50` | 最大返回数据行数 |
| `--json` | - | `false` | 输出格式化 JSON |

### 3.2 写入安全规则与防误删防篡改
1. **顶层 WHERE 语法防护**：
   - 执行 `UPDATE` 或 `DELETE` 时，必须明确包含顶层的有效 `WHERE` 条件；
   - 字符串字面量、注释、反引号标识符或嵌套子查询中的伪 `WHERE` 一律不被视为有效条件，防止因书写漏洞导致全表数据被清空；
   - 遇到多语句执行或无法可靠静态分析的 SQL，脚本默认阻断，除非用户明确显式传入 `--force`。
2. **结构化回显指标**：
   - DML 操作精确返回 `affectedRows`（受影响行数）、`insertId`（自增主键）、`changedRows`（实际变更行数）；
   - DDL 结构操作返回执行成功状态与目标表名。

### 3.3 测试库密码动态发现与静默沉淀机制
1. **零硬编码**：Skill 代码库内绝不硬编码任何明文密码；
2. **本地配置自动嗅探**：
   - 若本地缓存缺少目标测试库密码，AI 会主动引导用户切换或指向该项目的本地工程根目录（如 `cd /path/to/utopia-scs-saas`）；
   - 脚本将自动从本地的 `application-test.yml`、`application-dev.properties` 或 `.env.test` 中解析对应的数据库账号密码；
3. **验通即沉淀**：
   - 只要首次握手成功，脚本便会将凭据无感保存至 `~/.shrimp/skills/live-inspector/test_databases.json`，后续调用永久免输。
