#!/usr/bin/env node

/**
 * 🕊️ Leo Live Inspector - 白鸽网关配置中心探查引擎 (Baige Gateway Query Engine)
 * 
 * 核心特性：
 *   1. 三轨环境极速直连：
 *      - 线上生产环境 (prod, https://baige.ke.com)
 *      - 预发环境 (preview, http://preview.baige.ke.com)
 *      - 线下测试环境 (test, http://life-fe-baige-node.offline-beta.ttb.test.ke.com)
 *   2. 覆盖网关核心资产：服务登记 (Application)、路由组与路由规则 (RouteGroup & Routes)、服务管理员 (AuthedUsers)；
 *   3. 跨环境三态对照 (`check <serviceId>`): 秒级并发探查测试、预发与生产三环境配置与路由状态；
 *   4. 智能解析与反查：支持直接传 serviceId (如 utopia-scs-algo) 自动反查对应应用 ID；
 *   5. 人性化排版与结构化数据交付：支持终端表格和 `--json` 格式化数据输出，自带 Web 控制台直达 URL。
 */

import {
  BAIGE_HOSTS,
  normalizeEnv,
  getBaigeHost,
  generatePortalUrl,
  listApplications,
  getApplicationDetail,
  resolveApplication,
  listRouteGroups,
  listAuthedUsers,
  getAuthStatus
} from './common/baige.js';

function parseArgs(args) {
  const options = {
    command: null,
    targetId: null,
    env: 'prod',
    keyword: null,
    page: 1,
    pageSize: 20,
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
    } else if (arg === '-q' || arg === '--keyword') {
      options.keyword = args[++i];
    } else if (arg === '--page') {
      options.page = parseInt(args[++i], 10) || 1;
    } else if (arg === '--page-size') {
      options.pageSize = parseInt(args[++i], 10) || 20;
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
  return options;
}

function printHelp() {
  console.log(`
🕊️ Leo Baige Gateway Query Engine (白鸽网关多环境探查引擎)

使用格式:
  node scripts/baige_query.js <subcommand> [targetId] [options]

支持环境 (-e / --env):
  prod (默认)   线上生产环境 (https://baige.ke.com)
  preview      预发环境 (http://preview.baige.ke.com)
  test         测试环境 (http://life-fe-baige-node.offline-beta.ttb.test.ke.com)

常用子命令:
  apps [keyword]               分页查询或搜索已登记的微服务网关列表 (同 list / search)
  detail <id|serviceId>        查看指定微服务的网关登记详情与转发配置
  routes <id|serviceId>        查看指定微服务的路由组列表与下属路由规则
  users <id|serviceId>         查看指定服务的已授权管理员列表与当前账号权限
  check <id|serviceId>         🔥 跨环境三态对照：并发探查测试、预发与生产环境注册及路由差异

选项:
  -e, --env <test|preview|prod>  目标环境 (默认: prod)
  -q, --keyword <str>            按 serviceId 或服务名称模糊检索
  --page <num>                   当前页码 (默认: 1)
  --page-size <num>              分页大小 (默认: 20)
  --cookie <str>                 临时覆盖使用的 Cookie
  --set-cookie <str>             保存 Cookie 至本地缓存供后续自动复用
  --json                         输出机器可读的结构化 JSON
  -h, --help                     查看本帮助说明

示例:
  node scripts/baige_query.js apps                                  # 线上生产环境查看微服务列表
  node scripts/baige_query.js apps -q algo                          # 搜索包含 algo 的微服务
  node scripts/baige_query.js detail utopia-scs-algo                # 查算法服务详情 (支持 serviceId)
  node scripts/baige_query.js routes utopia-scs-algo                # 查算法服务的路由组与转发规则
  node scripts/baige_query.js users utopia-scs-algo                 # 查算法服务的管理员列表
  node scripts/baige_query.js check utopia-scs-algo                 # 跨测试/预发/生产三环境对比检查
  node scripts/baige_query.js detail 6837 -e test                   # 测试环境按 ID 查详情
  node scripts/baige_query.js routes 144 -e prod --json             # 输出路由规则 JSON
`);
}

function getEnvTag(env) {
  const norm = normalizeEnv(env);
  if (norm === 'prod') return '🚨 线上生产环境 [baige.ke.com]';
  if (norm === 'preview') return '🟡 预发环境 [preview.baige.ke.com]';
  return '🧪 测试环境 [life-fe-baige-node.offline-beta.ttb.test.ke.com]';
}

function getRelayTypeName(type) {
  if (type === 1) return '注册发现 (Eureka)';
  if (type === 2) return '域名/IP直连';
  return `类型-${type}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }

  const { command, targetId, env, page, pageSize, keyword, json, cookie, setCookie } = options;
  const envKey = normalizeEnv(env);
  const envTag = getEnvTag(envKey);

  try {
    switch (command) {
      case 'apps':
      case 'list':
      case 'search': {
        const kw = targetId || keyword || '';
        const res = await listApplications({
          keyWord: kw,
          currentPage: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || [];
        const total = res?.total || 0;
        console.log(`\n📋 白鸽网关服务列表 (${envTag} | 共 ${total} 项, 当前第 ${page} 页):`);
        if (list.length === 0) {
          console.log(`   (未检索到匹配的服务记录${kw ? `，关键词: "${kw}"` : ''})`);
        } else {
          console.table(list.map(item => ({
            '应用ID': item.id,
            'serviceId': item.serviceId,
            '服务名称': item.serviceName || '-',
            '转发方式': getRelayTypeName(item.relayType),
            '创建人': item.creatorName || '-',
            '登记时间': (item.registerTime || '').slice(0, 19).replace('T', ' ')
          })));
        }
        console.log(`\n🔗 控制台直达: ${generatePortalUrl(envKey, '/')}`);
        break;
      }

      case 'detail': {
        if (!targetId) {
          console.error(`❌ 请提供目标应用的 ID 或 serviceId，例如: node scripts/baige_query.js detail utopia-scs-algo`);
          process.exit(1);
        }

        const detail = await resolveApplication(targetId, { env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }

        const portalUrl = generatePortalUrl(envKey, `/gatewayDetail/${detail.id}`);
        console.log(`\n🕊️ 白鸽网关服务详情 (${envTag}):`);
        console.log(`   应用 ID:       ${detail.id}`);
        console.log(`   serviceId:     ${detail.serviceId}`);
        console.log(`   服务名称:       ${detail.serviceName || '-'}`);
        console.log(`   转发类型:       ${getRelayTypeName(detail.relayType)}`);
        console.log(`   转发地址:       ${detail.eurekaUri || detail.domainList || '-'}`);
        console.log(`   创建人:         ${detail.creatorName || '-'}`);
        console.log(`   登记时间:       ${(detail.registerTime || '').slice(0, 19).replace('T', ' ')}`);
        console.log(`   🔗 Web 控制台:  ${portalUrl}`);

        // 联动查询授权管理员
        try {
          const users = await listAuthedUsers(detail.serviceId, { env: envKey, cookie });
          if (Array.isArray(users) && users.length > 0) {
            console.log(`\n👥 授权管理员 (${users.length} 人):`);
            console.log(`   ${users.map(u => u.display || `${u.name || u.userName || '未知'} (${u.userId || u.ucid || u.id})`).join('、')}`);
          }
        } catch {}
        break;
      }

      case 'routes': {
        if (!targetId) {
          console.error(`❌ 请提供目标应用的 ID 或 serviceId，例如: node scripts/baige_query.js routes utopia-scs-algo`);
          process.exit(1);
        }

        const detail = await resolveApplication(targetId, { env: envKey, cookie });
        const routeData = await listRouteGroups(detail.id, {
          currentPage: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify({ application: detail, routes: routeData }, null, 2));
          return;
        }

        const groups = routeData?.list || [];
        const total = routeData?.total || 0;
        const portalUrl = generatePortalUrl(envKey, `/gatewayDetail/${detail.id}`);

        console.log(`\n🛣️ 白鸽网关路由配置 (${envTag}):`);
        console.log(`   目标服务: ${detail.serviceName} (${detail.serviceId}, ID: ${detail.id})`);
        console.log(`   路由组总数: ${total} | 🔗 控制台直达: ${portalUrl}\n`);

        if (groups.length === 0) {
          console.log(`   (暂未配置任何路由组)`);
        } else {
          groups.forEach((group, idx) => {
            console.log(`📦 [路由组 ${idx + 1}] ID: ${group.groupRouteId} | 名称: ${group.name} | 前缀: ${group.prefix || '-'}`);
            console.log(`   规则属性: ${Array.isArray(group.ruleList) ? group.ruleList.join(' | ') : '-'}`);
            console.log(`   创建人: ${group.creator || '-'} | 登录校验: ${group.loginCheck === 1 ? '开启' : '关闭'}`);
            
            const subRoutes = group.routeList || [];
            if (subRoutes.length > 0) {
              console.log(`   下属子路由 (${subRoutes.length} 条):`);
              subRoutes.forEach(r => {
                const rules = Array.isArray(r.ruleList) ? r.ruleList.join(', ') : '';
                console.log(`     • [Route ${r.routeId}] URI: "${r.uri}" | Env: ${r.env || 'default'} | 规则: ${rules}`);
              });
            } else {
              console.log(`   下属子路由: 无`);
            }
            console.log('');
          });
        }
        break;
      }

      case 'users': {
        if (!targetId) {
          console.error(`❌ 请提供目标服务的 serviceId 或 ID，例如: node scripts/baige_query.js users utopia-scs-algo`);
          process.exit(1);
        }

        let serviceId = targetId;
        if (/^\d+$/.test(targetId)) {
          const detail = await getApplicationDetail(Number(targetId), { env: envKey, cookie });
          serviceId = detail.serviceId;
        }

        const [users, authStatus] = await Promise.all([
          listAuthedUsers(serviceId, { env: envKey, cookie }),
          getAuthStatus(serviceId, { env: envKey, cookie })
        ]);

        if (json) {
          console.log(JSON.stringify({ serviceId, users, authStatus }, null, 2));
          return;
        }

        console.log(`\n👥 白鸽网关服务管理员列表 (${envTag}):`);
        console.log(`   serviceId: ${serviceId}`);
        console.log(`   当前账号状态: ${authStatus?.isAuthed ? '✅ 已获管理员权限' : '🔒 非管理员 (无编辑权限)'}`);

        const list = Array.isArray(users) ? users : [];
        if (list.length === 0) {
          console.log(`   (暂未配置管理员)`);
        } else {
          console.table(list.map(u => ({
            '工号 (UCID)': u.userId || u.ucid || u.id || '-',
            '姓名/展示信息': u.display || u.name || u.userName || '-'
          })));
        }
        break;
      }

      case 'check': {
        if (!targetId) {
          console.error(`❌ 请提供待检查的 serviceId 或 ID，例如: node scripts/baige_query.js check utopia-scs-algo`);
          process.exit(1);
        }

        console.log(`\n🔍 开始并发探查服务 [${targetId}] 在三环境的状态...\n`);

        const envs = ['test', 'preview', 'prod'];
        const results = await Promise.allSettled(envs.map(async (e) => {
          const detail = await resolveApplication(targetId, { env: e });
          const routes = await listRouteGroups(detail.id, { env: e, pageSize: 1 });
          const auth = await getAuthStatus(detail.serviceId, { env: e }).catch(() => null);
          return {
            env: e,
            detail,
            routeTotal: routes?.total || 0,
            isAuthed: auth?.isAuthed ?? null,
            portalUrl: generatePortalUrl(e, `/gatewayDetail/${detail.id}`)
          };
        }));

        if (json) {
          console.log(JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason.message }), null, 2));
          return;
        }

        const summary = [];
        envs.forEach((e, idx) => {
          const r = results[idx];
          const envName = e === 'test' ? '🧪 测试 (TEST)' : (e === 'preview' ? '🟡 预发 (PREVIEW)' : '🚨 线上 (PROD)');
          if (r.status === 'fulfilled') {
            const data = r.value;
            summary.push({
              '环境': envName,
              '状态': '✅ 已登记',
              '应用ID': data.detail.id,
              'serviceId': data.detail.serviceId,
              '转发类型': getRelayTypeName(data.detail.relayType),
              '转发地址': data.detail.eurekaUri || data.detail.domainList || '-',
              '路由组数': data.routeTotal,
              '当前用户权限': data.isAuthed === true ? '✅ 管理员' : (data.isAuthed === false ? '🔒 普通用户' : '未知')
            });
          } else {
            summary.push({
              '环境': envName,
              '状态': '❌ 未登记或访问失败',
              '应用ID': '-',
              'serviceId': targetId,
              '转发类型': '-',
              '转发地址': '-',
              '路由组数': 0,
              '当前用户权限': '-'
            });
          }
        });

        console.table(summary);

        console.log('\n🔗 三环境控制台直达链接:');
        results.forEach((r, idx) => {
          const e = envs[idx];
          if (r.status === 'fulfilled') {
            console.log(`   ${e.toUpperCase().padEnd(7)}: ${r.value.portalUrl}`);
          }
        });
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
