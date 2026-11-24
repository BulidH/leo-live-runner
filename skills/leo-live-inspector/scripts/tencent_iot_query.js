#!/usr/bin/env node

/**
 * 🔍 Leo Live Inspector - 腾讯云物联网开发平台 (IoT Explorer) 设备探查引擎
 * 
 * 核心能力：
 *   1. 设备状态与订阅感知：探查设备在线/离线状态、IP、心跳、已订阅核心 Topic (0DG9OA0GI7/<device>/data)；
 *   2. 核心报文流水抓取：按时间倒序提取已订阅 Topic 的上下行原始 Hex 报文；
 *   3. 协议帧自动 Decode：对接 keybox-frame-debug-api 接口，将原始 Hex 解码为业务语义（心跳/开门/授时/盘点及 TLV 载荷）；
 *   4. 行为与规则流转对账 (--behavior)：抓取 RuleEngine forward CKafka 与设备 PubAck 状态；
 *   5. 零配置独立运行：内置默认实例/产品/解码接口，不污染全局配置。
 */

import http from 'node:http';
import { ensureBridge, executeCommand } from './cli/lib/cli.mjs';

const DEFAULT_INSTANCE_ID = 'ins-3hFRo7emN99';
const DEFAULT_PRODUCT_ID = '0DG9OA0GI7';
const DEFAULT_DEVICE_NAME = '860734086841437';
const DEFAULT_PROJECT_ID = 'prj-yvamqmvt';
const DEFAULT_DECODE_URL = 'http://beijia-iot-device-access.mvp.ttb.test.ke.com/beike_beijia/keybox/command/frame/decode';

function parseCliArgs() {
  const argv = process.argv.slice(2);
  const options = {
    device: DEFAULT_DEVICE_NAME,
    instance: DEFAULT_INSTANCE_ID,
    product: DEFAULT_PRODUCT_ID,
    topic: 'data',
    limit: 5,
    raw: false,
    behavior: false,
    json: false,
    decodeUrl: DEFAULT_DECODE_URL,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-d' || arg === '--device') {
      options.device = argv[++i];
    } else if (arg === '-n' || arg === '--limit') {
      options.limit = parseInt(argv[++i], 10) || 5;
    } else if (arg === '-t' || arg === '--topic') {
      options.topic = argv[++i];
    } else if (arg === '--instance') {
      options.instance = argv[++i];
    } else if (arg === '--product') {
      options.product = argv[++i];
    } else if (arg === '--raw') {
      options.raw = true;
    } else if (arg === '--behavior') {
      options.behavior = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--decode-url') {
      options.decodeUrl = argv[++i];
    } else if (!arg.startsWith('-') && !options.deviceExplicit) {
      options.device = arg;
      options.deviceExplicit = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
🔍 Leo Live Inspector - 腾讯云物联网开发平台 (IoT Explorer) 设备探查工具

用法:
  node scripts/tencent_iot_query.js [设备名称] [选项]

选项:
  -d, --device <name>       目标设备名称 (默认: ${DEFAULT_DEVICE_NAME})
  -n, --limit <count>       抓取上下行最新报文条数 (默认: 5)
  -t, --topic <name>        核心 Topic 过滤关键词 (默认: data)
  --behavior                同时提取行为日志 (规则引擎流转 CKafka、PubAck)
  --raw                     关闭协议帧自动解码，仅输出原始 Hex 报文
  --decode-url <url>        指定钥匙箱协议帧解码服务地址
  --instance <id>           指定腾讯云 IoT 实例 ID (默认: ${DEFAULT_INSTANCE_ID})
  --product <id>            指定腾讯云产品 ID (默认: ${DEFAULT_PRODUCT_ID})
  --json                    输出机器可读的原始 JSON 结果
  -h, --help                显示帮助说明

示例:
  # 查默认钥匙箱最新 5 条报文并自动解码
  node scripts/tencent_iot_query.js

  # 查指定设备最新 10 条报文，并输出规则引擎流转日志
  node scripts/tencent_iot_query.js 860734086841437 -n 10 --behavior

  # 仅抓取原始十六进制 Hex 报文
  node scripts/tencent_iot_query.js 860734086841437 --raw
`);
}

/**
 * 远程调用钥匙箱协议解码 API
 */
async function decodeFrameViaApi(frameHex, decodeUrl) {
  if (!frameHex || typeof frameHex !== 'string') {
    return { valid: false, type: '空报文', summary: '-', xor: '-' };
  }

  try {
    const url = new URL(decodeUrl);
    const postData = JSON.stringify({ frame: frameHex.trim() });

    const responseText = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 4000
        },
        res => {
          let data = '';
          res.on('data', chunk => {
            data += chunk;
          });
          res.on('end', () => resolve(data));
        }
      );

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('解码服务请求超时'));
      });
      req.write(postData);
      req.end();
    });

    const resJson = JSON.parse(responseText);
    if (!resJson || resJson.errorCode !== 0 || !resJson.data) {
      return { valid: false, type: '解码失败', summary: resJson?.msg || '未知错误', xor: '-' };
    }

    const data = resJson.data;
    const desc = typeof data.desc === 'string' ? JSON.parse(data.desc) : (data.desc || {});
    const header = desc.header || [];
    const typeItem = header.find(h => h.name === '报文类型');
    const sidItem = header.find(h => h.name === '报文编号');

    const msgType = typeItem ? typeItem.valueDesc : (data.direction || '未知');
    const sid = sidItem ? sidItem.value : '';

    const tlvs = (desc.tlvs || []).map(tlv => {
      const tagName = tlv.tag?.valueDesc || tlv.tag?.name || 'Tag';
      const valDesc = tlv.value?.valueDesc ?? tlv.value?.value ?? '';
      return `${tagName}: ${valDesc}`;
    });

    const xorDesc = desc.xor?.valueDesc || (desc.xor?.value === 'true' ? '校验通过' : '未知');
    const sidPrefix = sid ? `[SID:${sid}] ` : '';
    const summary = `${sidPrefix}${tlvs.join(', ') || '无业务载荷'}`;

    return {
      valid: Boolean(data.valid),
      type: msgType,
      summary,
      xor: xorDesc
    };
  } catch (err) {
    return {
      valid: false,
      type: '离线模式',
      summary: `未连接解码服务 (${err.message})`,
      xor: '-'
    };
  }
}

/**
 * 确保页面处于“内容日志” Tab 并选中“自定义topic”与目标 topic
 */
async function ensureTargetTopicSelected(targetTopicKeyword = 'data') {
  // 1. 确保在“云日志” -> “内容日志”
  await executeCommand('eval', {
    script: `(() => {
      const allTabs = Array.from(document.querySelectorAll('.app-iotexplorer-tabs__tab, span'));
      const contentLogTab = allTabs.find(s => s.innerText.trim() === '内容日志');
      if (contentLogTab) {
        const parentLink = contentLogTab.closest('a');
        if (!parentLink || !parentLink.classList.contains('is-active')) {
          contentLogTab.click();
          return true;
        }
      }
      return false;
    })()`
  });
  await new Promise(r => setTimeout(r, 400));

  // 2. 检查当前是否已经是自定义 topic
  const checkStatusRes = await executeCommand('eval', {
    script: `(() => {
      const dds = Array.from(document.querySelectorAll('.app-iotexplorer-dropdown__header'));
      const logTypeDd = dds.find(d => d.innerText.includes('自定义topic') || d.innerText.includes('二进制透传'));
      const isCustom = logTypeDd && logTypeDd.innerText.includes('自定义topic');
      const topicDd = dds.find(d => d.innerText.includes('${targetTopicKeyword}') || d.innerText.includes('请选择'));
      const isTopicSelected = topicDd && topicDd.innerText.includes('${targetTopicKeyword}');
      return { isCustom, isTopicSelected };
    })()`
  });

  const status = checkStatusRes?.evalResult || {};

  // 3. 若非自定义 topic，先切为自定义 topic
  if (!status.isCustom) {
    await executeCommand('eval', {
      script: `(() => {
        const dds = Array.from(document.querySelectorAll('.app-iotexplorer-dropdown__header'));
        const binaryDd = dds.find(d => d.innerText.includes('二进制透传'));
        if (binaryDd) binaryDd.click();
      })()`
    });
    await new Promise(r => setTimeout(r, 400));

    await executeCommand('eval', {
      script: `(() => {
        const customTopicItem = Array.from(document.querySelectorAll('li, div, span')).find(
          e => e.children.length === 0 && e.innerText && e.innerText.trim() === '自定义topic'
        );
        if (customTopicItem) customTopicItem.click();
      })()`
    });
    await new Promise(r => setTimeout(r, 600));
  }

  // 4. 若 topic 仍是“请选择”，点开并选择包含 targetTopicKeyword 的 topic
  if (!status.isTopicSelected) {
    await executeCommand('eval', {
      script: `(() => {
        const dds = Array.from(document.querySelectorAll('.app-iotexplorer-dropdown__header'));
        const topicDd = dds.find(d => d.innerText.includes('请选择') || d.innerText.includes('topic'));
        if (topicDd) topicDd.click();
      })()`
    });
    await new Promise(r => setTimeout(r, 400));

    await executeCommand('eval', {
      script: `(() => {
        const topicItem = Array.from(document.querySelectorAll('li, .app-iotexplorer-dropdown__menu-item')).find(
          e => e.tagName !== 'SCRIPT' && (e.innerText || '').includes('${targetTopicKeyword}')
        );
        if (topicItem) {
          topicItem.click();
          return true;
        }
        return false;
      })()`
    });
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * 抽取页面上的设备状态与已订阅 Topic
 */
async function extractDeviceStatus() {
  const script = `(() => {
    const text = document.body.innerText;
    let status = '离线';
    if (text.includes('设备状态\t在线') || text.includes('设备状态 在线') || /设备状态\\s*在线/.test(text)) {
      status = '在线';
    } else {
      const match = text.match(/202[5-9]-\\d{2}-\\d{2}\\s+(\\d{2}):(\\d{2}):(\\d{2})/);
      if (match) {
        status = '在线';
      }
    }
    return status;
  })()`;
  const res = await executeCommand('eval', { script });
  return res?.evalResult || '在线';
}

/**
 * 在目标标签页中抽取上下行内容日志
 */
async function extractContentLogs(limit, topicFilter) {
  await ensureTargetTopicSelected(topicFilter);

  const evalScript = `(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let contentRows = [];

    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll('tbody tr'));
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (tds.length >= 4 && (tds[1] === '上行' || tds[1] === '下行')) {
          contentRows.push({
            time: tds[0],
            direction: tds[1],
            topic: tds[2],
            content: tds[3]
          });
        }
      }
    }

    const targetTopicKeyword = '${topicFilter}';
    const filteredContent = contentRows
      .filter(r => !targetTopicKeyword || r.topic.includes(targetTopicKeyword))
      .slice(0, ${limit});

    return {
      subscribedTopic: filteredContent[0]?.topic || '${DEFAULT_PRODUCT_ID}/${DEFAULT_DEVICE_NAME}/data',
      logs: filteredContent
    };
  })()`;

  const res = await executeCommand('eval', { script: evalScript });
  return res?.evalResult || { subscribedTopic: '', logs: [] };
}

/**
 * 抽取行为日志 (RuleEngine forward CKafka, PubAck)
 */
async function extractBehaviorLogs(limit = 6) {
  const switchScript = `(() => {
    const allTabs = Array.from(document.querySelectorAll('.app-iotexplorer-tabs__tab, span'));
    const behaviorTab = allTabs.find(s => s.innerText.trim() === '行为日志');
    if (behaviorTab) {
      behaviorTab.click();
      return true;
    }
    return false;
  })()`;

  await executeCommand('eval', { script: switchScript });
  await new Promise(r => setTimeout(r, 800));

  const extractScript = `(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let behaviorRows = [];
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll('tbody tr'));
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (tds.length >= 4 && (tds[1] === 'MESSAGE' || tds[4] === 'SUCC' || tds[4] === 'FAIL')) {
          behaviorRows.push({
            time: tds[0] || '',
            category: tds[1] || '',
            requestId: tds[2] || '',
            content: tds[3] || '',
            result: tds[4] || ''
          });
        }
      }
    }

    // 切回内容日志
    const allTabs = Array.from(document.querySelectorAll('.app-iotexplorer-tabs__tab, span'));
    const contentLogTab = allTabs.find(s => s.innerText.trim() === '内容日志');
    if (contentLogTab) contentLogTab.click();

    return behaviorRows.slice(0, ${limit});
  })()`;

  const res = await executeCommand('eval', { script: extractScript });
  return res?.evalResult || [];
}

async function main() {
  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // 1. 确保桥接在线
  try {
    await ensureBridge({ startTimeoutMs: 10000 });
  } catch (err) {
    console.error(`❌ 无法连接 Leo Lantern 浏览器桥接服务: ${err.message}`);
    process.exit(1);
  }

  // 2. 检查现存的 Tencent Cloud IoT 标签页（优先命中 active 的）
  const tabsRes = await executeCommand('tabs');
  const allTabs = tabsRes?.result || [];
  
  let targetTab = allTabs.find(t => 
    t.url && 
    t.url.includes('console.cloud.tencent.com/iotexplorer/v2/instance/device/detail') &&
    (t.url.includes(options.device) || t.url.includes(options.product)) &&
    t.active
  ) || allTabs.find(t => 
    t.url && 
    t.url.includes('console.cloud.tencent.com/iotexplorer/v2/instance/device/detail') &&
    (t.url.includes(options.device) || t.url.includes(options.product))
  );

  const targetUrl = `https://console.cloud.tencent.com/iotexplorer/v2/instance/device/detail?instance_id=${options.instance}&log_type=ContentLog&name=${options.device}&product_id=${options.product}&project_id=${DEFAULT_PROJECT_ID}&s_product_id=&tab=cloudLog`;

  if (!targetTab) {
    // 新开独立标签页
    await executeCommand('new-tab', { url: targetUrl, force: true });
    await executeCommand('wait', { idle: true, idleMs: 1500 });
  } else {
    // 接管已有标签页
    await executeCommand('claim', { tabId: targetTab.id });
    if (!targetTab.url.includes(options.device)) {
      await executeCommand('goto', { url: targetUrl });
      await executeCommand('wait', { idle: true, idleMs: 1500 });
    }
  }

  // 3. 提取设备状态与内容日志
  const deviceStatus = await extractDeviceStatus();
  const pageContent = await extractContentLogs(options.limit, options.topic);

  // 4. 对核心报文进行协议解码
  const logsWithDecode = [];
  for (const log of (pageContent.logs || [])) {
    if (!options.raw && log.content) {
      const decoded = await decodeFrameViaApi(log.content, options.decodeUrl);
      logsWithDecode.push({
        ...log,
        decoded
      });
    } else {
      logsWithDecode.push({
        ...log,
        decoded: null
      });
    }
  }

  // 5. 提取行为日志 (若需要)
  let behaviorLogs = [];
  if (options.behavior) {
    behaviorLogs = await extractBehaviorLogs(6);
  }

  // 6. 输出结果
  const outputData = {
    device: {
      name: options.device,
      product: '测试-钥匙箱',
      productId: options.product,
      instanceId: options.instance,
      status: deviceStatus,
      subscribedTopic: pageContent.subscribedTopic || `${options.product}/${options.device}/data`
    },
    logs: logsWithDecode,
    behaviorLogs
  };

  if (options.json) {
    console.log(JSON.stringify(outputData, null, 2));
    return;
  }

  // Markdown 格式化输出
  console.log(`\n🔍 腾讯云物联网开发平台 (IoT Explorer) 设备探查: ${options.device}`);
  console.log(`所属产品: ${outputData.device.product} (${outputData.device.productId}) | 实例: ${outputData.device.instanceId}`);
  const statusTag = outputData.device.status === '在线' ? '🟢 在线' : '🔴 离线';
  console.log(`设备状态: ${statusTag} | 核心已订阅 Topic: \`${outputData.device.subscribedTopic}\`\n`);

  if (!outputData.logs.length) {
    console.log(`⚠️ 未检索到核心 Topic \`${outputData.device.subscribedTopic}\` 的上下行报文（或当前时间段为空）\n`);
  } else {
    console.log(`📡 最新上下行通信日志 (已解码 ${outputData.logs.length} 条):`);
    console.log(`| 时间 | 方向 | 报文类型 | 业务解析摘要 | 校验 | 原始报文(Hex) |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- |`);

    for (const item of outputData.logs) {
      const dirIcon = item.direction === '上行' ? '⬆️ 上行' : '⬇️ 下行';
      const msgType = item.decoded?.type || '-';
      const summary = item.decoded?.summary || '-';
      const xor = item.decoded?.xor || '-';
      const hexSnippet = item.content.length > 28 ? `${item.content.slice(0, 14)}...${item.content.slice(-10)}` : item.content;
      console.log(`| ${item.time} | ${dirIcon} | **${msgType}** | ${summary} | ${xor} | \`${hexSnippet}\` |`);
    }
    console.log();
  }

  if (options.behavior && behaviorLogs.length) {
    console.log(`⚡ 规则引擎流转与行为日志:`);
    for (const b of behaviorLogs) {
      const isCkafka = b.content.includes('CKafka');
      const prefix = isCkafka ? '📨 [Kafka流转]' : '🔄 [设备交互]';
      const resTag = b.result === 'SUCC' ? '✅ SUCC' : `❌ ${b.result}`;
      console.log(`- ${b.time} ${prefix} ${b.content} -> ${resTag}`);
    }
    console.log();
  }
}

main().catch(err => {
  console.error(`❌ 执行异常: ${err.message}`);
  process.exit(1);
});
