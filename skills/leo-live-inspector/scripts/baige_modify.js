#!/usr/bin/env node

/**
 * 🛠️ Leo Live Inspector - 白鸽网关配置变更与两阶段风控引擎 (Baige Gateway Modifier)
 * 
 * 核心设计原则：
 *   1. 三轨环境支持 (Tri-Environment):
 *      - 测试环境 (test, 默认)
 *      - 预发环境 (preview)
 *      - 线上生产环境 (prod, 严格高危拦截与确认)
 *   2. 严格两阶段风控原则 (Pre-flight vs Confirmed):
 *      - 阶段 1 (默认 Dry-Run 试运行): 先查出当前配置，计算出【变更前 vs 变更后】Diff 对比单与影响面评估，
 *        绝对禁止未确认直接写入！
 *      - 阶段 2 (带 --confirm 正式执行): 用户明确确认后，追加 --confirm 正式提交变更，并立即回查生效情况。
 *   3. 🚨 高危操作拦截与线上防护:
 *      - 针对【删除管理员、修改生产域名与转发配置】等高危操作强制输出警示；
 *      - 生产环境 (prod) 渲染醒目的【生产变更警示红框】，必须经过用户明确二次确认方可执行！
 */

import {
  BAIGE_HOSTS,
  normalizeEnv,
  getBaigeHost,
  generatePortalUrl,
  resolveApplication,
  getApplicationDetail,
  listAuthedUsers,
  addAuthedUser,
  deleteAuthedUser,
  updateDomain
} from './common/baige.js';

function parseArgs(args) {
  const options = {
    command: null,
    targetId: null,
    arg2: null,
    env: 'test',
    confirm: false,
    json: false,
    cookie: null,
    setCookie: null,
    help: false
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-e' || arg === '--env') {
      options.env = args[++i];
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--cookie') {
      options.cookie = args[++i];
    } else if (arg === '--set-cookie') {
      options.setCookie = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  options.command = positional[0] || 'help';
  options.targetId = positional[1] || null;
  options.arg2 = positional[2] || null;
  return options;
}

function printHelp() {
  console.log(`
🛠️ Leo Baige Gateway Modifier (白鸽网关变更与风控引擎)

使用格式:
  node scripts/baige_modify.js <subcommand> <serviceId|id> [value] [options]

环境策略 (-e / --env):
  test (唯一允许写操作)   测试环境 (http://life-fe-baige-node.offline-beta.ttb.test.ke.com)
  preview (严禁写操作)    预发环境 - 严格禁止任何写操作与路由操作！代码物理阻断
  prod (严禁写操作)       线上生产环境 - 严格禁止任何写操作与路由操作！代码物理阻断

支持子命令:
  add-user <serviceId> <ucid>       为指定微服务添加授权管理员 (仅限测试环境)
  delete-user <serviceId> <ucid>    🔴 高危：删除指定微服务的授权管理员 (仅限测试环境)
  update-domain <id> <domains>      修改服务域名列表 (仅限测试环境)

风控选项:
  --confirm                         正式发布门禁 (未传则仅执行 Pre-flight 试运行与 Diff 预审)
  -e, --env <test>                  目标环境 (必须为 test，preview 和 prod 严禁写入)
  --cookie <str>                    临时覆盖使用的 Cookie
  --json                            输出机器可读的结构化 JSON
  -h, --help                        查看本帮助说明

示例:
  # 阶段 1: Pre-flight 试运行 (默认探查并输出 Diff)
  node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e test
  # 阶段 2: 用户确认后追加 --confirm 正式执行
  node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e test --confirm
`);
}

function getEnvTag(env) {
  const norm = normalizeEnv(env);
  if (norm === 'prod') return '🚨 线上生产环境 [baige.ke.com]';
  if (norm === 'preview') return '🟡 预发环境 [preview.baige.ke.com]';
  return '🧪 测试环境 [life-fe-baige-node.offline-beta.ttb.test.ke.com]';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }

  const { command, targetId, arg2, env, confirm, json, cookie } = options;
  const envKey = normalizeEnv(env);
  const isProd = envKey === 'prod';
  const isPreview = envKey === 'preview';
  const envTag = getEnvTag(envKey);

  // 🛡️ 风控铁律：预发与生产环境绝对禁止任何写操作与路由操作，物理死锁阻断
  if (isProd || isPreview) {
    const errorMsg = `🚨 【风控物理阻断】白鸽网关在预发环境 (preview) 与线上生产环境 (prod) 严格禁止任何写操作与路由变更！\n   所有网关配置与路由修改仅允许在测试环境 (-e test) 中进行。`;
    if (json) {
      console.log(JSON.stringify({ error: errorMsg, code: 'WRITE_PROHIBITED' }, null, 2));
    } else {
      console.error(`\n${errorMsg}\n`);
    }
    process.exit(1);
  }

  try {
    switch (command) {
      case 'add-user': {
        const serviceId = targetId;
        const ucid = arg2;
        if (!serviceId || !ucid) {
          console.error(`❌ 参数不完整。格式: node scripts/baige_modify.js add-user <serviceId> <ucid> [-e test|preview|prod]`);
          process.exit(1);
        }

        // 1. 探查当前状态
        const app = await resolveApplication(serviceId, { env: envKey, cookie });
        const users = await listAuthedUsers(app.serviceId, { env: envKey, cookie });
        const existing = (users || []).find(u => String(u.userId || u.ucid) === String(ucid));

        if (existing) {
          console.log(`\n⚠️  [${envTag}] 员工 ${ucid} (${existing.display || existing.name || '已存在'}) 已经是服务 [${app.serviceId}] 的管理员，无需重复添加。`);
          return;
        }

        // 2. Pre-flight 阶段
        if (!confirm) {
          console.log(`\n🔍 ================== 【变更 Pre-flight 预审】 ==================`);
          console.log(`   目标环境:   ${envTag}`);
          console.log(`   目标服务:   ${app.serviceName} (${app.serviceId}, ID: ${app.id})`);
          console.log(`   操作类型:   添加服务管理员 (addAuthedUser)`);
          console.log(`   拟添加工号: ${ucid}`);
          console.log(`   当前管理员: ${(users || []).map(u => u.display || u.userId).join('、') || '暂无'}`);
          console.log(`   🔗 控制台:   ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}`);
          if (isProd) {
            console.log(`\n🚨 【高危警告】当前目标为线上生产环境！添加后该员工将获得生产网关修改权限！`);
          }
          console.log(`\n💡 提示: 当前为安全预览模式，未发生真实写入。如确认无误，请在命令末尾追加 --confirm 正式提交。`);
          console.log(`=================================================================\n`);
          return;
        }

        // 3. 正式提交阶段
        console.log(`\n🚀 [${envTag}] 正在提交添加管理员请求: ${app.serviceId} -> 工号: ${ucid}...`);
        await addAuthedUser(app.serviceId, ucid, { env: envKey, cookie });

        // 4. 回查校验
        const afterUsers = await listAuthedUsers(app.serviceId, { env: envKey, cookie });
        const verified = (afterUsers || []).some(u => String(u.userId || u.ucid) === String(ucid));

        if (json) {
          console.log(JSON.stringify({ success: true, serviceId: app.serviceId, ucid, verified }, null, 2));
        } else {
          console.log(`\n✅ [${envTag}] 管理员添加成功并校验生效！`);
          console.log(`   当前最新管理员列表: ${(afterUsers || []).map(u => u.display || u.userId).join('、')}`);
          console.log(`   🔗 Web 控制台: ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}\n`);
        }
        break;
      }

      case 'delete-user': {
        const serviceId = targetId;
        const ucid = arg2;
        if (!serviceId || !ucid) {
          console.error(`❌ 参数不完整。格式: node scripts/baige_modify.js delete-user <serviceId> <ucid> [-e test|preview|prod]`);
          process.exit(1);
        }

        const app = await resolveApplication(serviceId, { env: envKey, cookie });
        const users = await listAuthedUsers(app.serviceId, { env: envKey, cookie });
        const targetUser = (users || []).find(u => String(u.userId || u.ucid) === String(ucid));

        if (!targetUser) {
          console.log(`\n⚠️  [${envTag}] 服务 [${app.serviceId}] 的管理员列表中不存在工号 ${ucid}，无需删除。`);
          return;
        }

        // 阶段 1: Pre-flight 警告
        if (!confirm) {
          console.log(`\n🔴 ================== 【高危操作 Pre-flight 预审】 ==================`);
          console.log(`   目标环境:   ${envTag}`);
          console.log(`   目标服务:   ${app.serviceName} (${app.serviceId}, ID: ${app.id})`);
          console.log(`   操作类型:   🔴 移除服务管理员 (deleteAuthedUser)`);
          console.log(`   待移除员工: ${targetUser.display || targetUser.userId}`);
          console.log(`   当前总人数: ${users.length} 人`);
          if (users.length <= 1) {
            console.log(`   ⚠️ 【致命警示】移除后该服务将失去所有管理员！`);
          }
          if (isProd) {
            console.log(`   🚨 【生产风控】当前为生产环境，请务必核实负责人身份！`);
          }
          console.log(`   🔗 控制台:   ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}`);
          console.log(`\n💡 提示: 当前为安全预览模式，未发生真实删除。请核实后追加 --confirm 正式执行。`);
          console.log(`=================================================================\n`);
          return;
        }

        // 阶段 2: 执行删除
        console.log(`\n🗑️ [${envTag}] 正在提交删除管理员请求: ${app.serviceId} -> 工号: ${ucid}...`);
        await deleteAuthedUser(app.serviceId, ucid, { env: envKey, cookie });

        // 回查
        const afterUsers = await listAuthedUsers(app.serviceId, { env: envKey, cookie });
        const stillExists = (afterUsers || []).some(u => String(u.userId || u.ucid) === String(ucid));

        if (json) {
          console.log(JSON.stringify({ success: true, serviceId: app.serviceId, ucid, verified: !stillExists }, null, 2));
        } else {
          console.log(`\n✅ [${envTag}] 管理员移除成功并回查确认！`);
          console.log(`   剩余管理员列表: ${(afterUsers || []).map(u => u.display || u.userId).join('、') || '暂无'}`);
          console.log(`   🔗 Web 控制台: ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}\n`);
        }
        break;
      }

      case 'update-domain': {
        const idOrServiceId = targetId;
        const domainsStr = arg2;
        if (!idOrServiceId || !domainsStr) {
          console.error(`❌ 参数不完整。格式: node scripts/baige_modify.js update-domain <id|serviceId> <domain1,domain2,...> [-e test|preview|prod]`);
          process.exit(1);
        }

        const app = await resolveApplication(idOrServiceId, { env: envKey, cookie });
        const newDomains = domainsStr.split(',').map(d => d.trim()).filter(Boolean);

        if (!confirm) {
          console.log(`\n🔍 ================== 【域名配置 Pre-flight 预审】 ==================`);
          console.log(`   目标环境:   ${envTag}`);
          console.log(`   目标服务:   ${app.serviceName} (${app.serviceId}, ID: ${app.id})`);
          console.log(`   现有域名:   ${app.domainList ? JSON.stringify(app.domainList) : '无'}`);
          console.log(`   拟配置域名: ${JSON.stringify(newDomains)}`);
          if (isProd) {
            console.log(`\n🚨 【高危警告】线上生产环境修改域名将直接影响外部流量解析与网关路由！`);
          }
          console.log(`   🔗 控制台:   ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}`);
          console.log(`\n💡 提示: 当前为安全预览模式，未发生真实写入。如确认无误，请在命令末尾追加 --confirm 正式提交。`);
          console.log(`=================================================================\n`);
          return;
        }

        console.log(`\n🚀 [${envTag}] 正在更新服务 [${app.id}] 域名配置...`);
        await updateDomain(app.id, newDomains, { env: envKey, cookie });

        const afterApp = await getApplicationDetail(app.id, { env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify({ success: true, id: app.id, domainList: afterApp.domainList }, null, 2));
        } else {
          console.log(`\n✅ [${envTag}] 域名配置更新成功并校验生效！`);
          console.log(`   最新域名配置: ${JSON.stringify(afterApp.domainList)}`);
          console.log(`   🔗 Web 控制台: ${generatePortalUrl(envKey, `/gatewayDetail/${app.id}`)}\n`);
        }
        break;
      }

      default:
        console.error(`❌ 未知子命令: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ error: err.message, stack: err.stack }, null, 2));
    } else {
      console.error(`\n❌ [${envTag}] 执行失败: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
