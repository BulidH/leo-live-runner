# 📡 Kafka 消息无损只读探查与安全模拟投递手册 (Kafka Guide)

本手册专为微服务异步消息通信提供排障指导，涵盖 Kafka 消息秒级探查、分区水位与积压排查、速率差分分析，以及测试环境安全模拟投递。

---

## 🌐 1. 核心设计理念

1. **以 Topic 为核心资产（扁平化）**：
   - 打破“必须先找微服务”的束缚，Topic 全局唯一，直接通过 Topic 名或中文别名即可秒级查询与发送；
2. **双层持久化机制**：
   - **内置预置**：[`resources/default_kafka.json`](../resources/default_kafka.json)（出厂自带常用主目录 37+ 核心 Topic）；
   - **本地自学习**：`~/.shrimp/skills/live-inspector/kafka_catalog.json`（支持 `--save` 随时沉淀新项目或自定义 Topic）；
3. **零 Commit 与零 Rebalance 保障**：
   - 探查严格采用随机临时 GroupId（`leo-peek-${Date.now()}`）与 `autoCommit: false`；
   - 严禁任何提交行为，对线上/测试正常业务消费组完全透明无感知；
4. **测试环境安全投递与 Mock 上游**：
   - 默认环境为 `test`，向 `prod` 写入会被强制拦截（必须附加 `--force-danger-confirm`）；
   - 支持利用 Topic 预存的 `sample` 模板，通过 `-s key=val` 自动替换字段并刷新当前时间戳，实现秒级模拟上游事件；
5. **多工具联动排障（闭环威力）**：
   - 从 Kafka 查出的消息自带 `traceId` ➡️ 自动调用 `fast_query.js --traceId` 追查下游消费端的执行日志与 Mermaid 时序交互图。

---

## ⚡ 2. 常用命令速查

| 操作场景 | 推荐命令 | 说明 |
| :--- | :--- | :--- |
| **查最新消息 (线上)** | `node scripts/kafka_query.js -t <topic> -n 3` | 默认查线上最新 3 条，格式化回显 JSON 消息 |
| **查最新消息 (测试)** | `node scripts/kafka_query.js -t <topic> -e test -n 3` | 自动路由至测试环境对应集群与测试 Topic |
| **查分区水位/保留消息量** | `node scripts/kafka_query.js -t <topic> --offsets-only` | 输出各分区的 Low / High 水位与消息总数看板 |
| **查消费组真实积压** | `node scripts/kafka_query.js -t <topic> -g <groupId> --lag-only` | 输出 High / Committed / Lag、总积压与未提交分区数 |
| **查生产/消费速率** | `node scripts/kafka_query.js -t <topic> -g <groupId> --rate --duration 20` | 两次只读快照差分输出速率、Lag 变化与预计追平时间 |
| **按单号/关键词筛选** | `node scripts/kafka_query.js -t <topic> -q "<orderId>"` | 在拉取的消息中过滤指定业务关键词 |
| **指定分区拉取** | `node scripts/kafka_query.js -t <topic> -p 0 -n 2` | 仅从指定分区拉取消息 |
| **基于模板发送测试消息** | `node scripts/kafka_send.js -t <topic> --use-sample -s status=已完成` | 自动套用 Sample 模板并覆盖指定字段 |
| **直接发送自定义 JSON** | `node scripts/kafka_send.js -t <topic> -d '{"orderId":"123"}'` | 投递到测试环境并回显 Partition 与 Offset |
| **全量扫描更新资产** | `node scripts/kafka_scan.js -o resources/default_kafka.json` | 扫描 IOT/HT/ZK/JZ 目录并刷新内置预置库 |
