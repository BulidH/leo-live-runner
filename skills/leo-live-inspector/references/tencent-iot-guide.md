# 腾讯云物联网开发平台 (IoT Explorer) 设备探查指南

本工具专门用于探查腾讯云物联网开发平台（IoT Explorer）上的设备在线状态、核心订阅 Topic 通信报文及规则引擎（RuleEngine）CKafka 流转日志。

```bash
node scripts/tencent_iot_query.js [设备名称] [选项]
```

---

## 核心能力与特性

1. **设备状态与核心订阅识别**：
   - 自动探查设备在线/离线状态、实例 ID、所属产品及 ClientId。
   - 聚焦核心已订阅 Topic（如 `0DG9OA0GI7/<device>/data`），自动过滤无关的系统级和透传 Topic。
2. **上下行报文实时抓取与 Decode 解码**：
   - 抓取时间倒序的上下行报文流水。
   - **自动协议解码**：对接 `keybox-frame-debug-api`（`POST /beike_beijia/keybox/command/frame/decode`），将十六进制 Hex 自动翻译为人类可读的业务语义：
     - **心跳上报**：提取信号强度（RSRP）、设备时钟、固件版本号。
     - **远程授时 / 远程开门**：提取报文编号 (SID)、操作类型、时间戳。
     - **盘点结果上报**：提取应答状态、钥匙槽位状态。
     - **校验状态**：自动校验 XOR 校验码。
3. **规则引擎流转对账 (`--behavior`)**：
   - 抓取腾讯云规则引擎将设备上行报文推送到 CKafka（`ckafka-gnan8eqg` / `iot_keybox_uplink_test`）的投递结果 (`SUCC` / `FAIL`)。
   - 抓取设备端针对平台下行指令的 `PubAck` 确认耗时（通常 100~200ms）。
4. **零外部配置侵入**：
   - 内置默认实例 `ins-3hFRo7emN99`、产品 `0DG9OA0GI7` 与默认测试解码服务，无需修改 `default_services.json` 即可独立运行。

---

## 命令参数说明

| 参数 | 简写 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `[device]` | `-d`, `--device` | `860734086841437` | 目标设备名称 (IMEI / MAC) |
| `--limit` | `-n` | `5` | 获取上下行通信报文的条数 |
| `--topic` | `-t` | `data` | 过滤核心 Topic 关键词 |
| `--behavior` | | `false` | 提取行为日志 (包含规则引擎 CKafka 转发与 PubAck) |
| `--raw` | | `false` | 关闭自动协议解码，仅输出原始 Hex 报文 |
| `--decode-url` | | 测试环境 API | 覆盖钥匙箱协议帧解码服务接口地址 |
| `--instance` | | `ins-3hFRo7emN99` | 覆盖腾讯云物联网实例 ID |
| `--product` | | `0DG9OA0GI7` | 覆盖腾讯云物联网产品 ID |
| `--json` | | `false` | 以结构化 JSON 格式输出结果 |

---

## 常用命令示例

```bash
# 1. 查默认钥匙箱最新 5 条报文并自动解码
node scripts/tencent_iot_query.js

# 2. 查指定设备最新 10 条报文，并输出规则引擎流转日志
node scripts/tencent_iot_query.js 860734086841437 -n 10 --behavior

# 3. 仅抓取原始十六进制 Hex 报文 (不调解码服务)
node scripts/tencent_iot_query.js 860734086841437 --raw

# 4. 配合 Kafka 工具进行端到端对账
# Step 1: 查腾讯云设备报文与 CKafka 流转
node scripts/tencent_iot_query.js 860734086841437 --behavior
# Step 2: 查 CKafka 真实接收到的消息体
node scripts/kafka_query.js -t iot_keybox_uplink_test -n 3
```

---

## 协议解码说明 (keybox-frame-debug-api)

解码接口调用本地测试环境微服务：
- **URL**：`http://beijia-iot-device-access.mvp.ttb.test.ke.com/beike_beijia/keybox/command/frame/decode`
- **请求方法**：`POST`
- **请求体**：`{"frame": "<hex>"}`
- **典型报文前缀**：
  - `0x81`：设备心跳上报 (UPLINK)
  - `0x43`：平台远程授时 (DOWNLINK)
  - `0x82`：钥匙盘点结果上报 (UPLINK)
  - `0x45`：平台远程开门指令 (DOWNLINK)
