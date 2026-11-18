#!/usr/bin/env node

/**
 * 🏢 Leo Live Inspector - UC 组织与人员角色管理中心全量探查引擎 (UC Query Engine)
 *
 * 核心特性：
 *   1. 双引擎极速直连：
 *      - GraphQL 引擎: http://test3-uc.admin.ke.com/graphql (人员/组织/城市公司/调转事件/Sug联想)
 *      - 关系与角色 REST 引擎: http://test-uc-relation-admin.ke.com (人员角色维护/人-人/人-组织/组织-组织/层级架构树)
 *      - 本域 REST 引擎: BPM 角色申请流 (/api/bpm/*) 与 组织标签管理 (/orgTagDict/*, /orgTagInstance/*)
 *   2. 智能标识解析与同名消歧：
 *      - 支持直接传入 16位 UCID、8位系统号 (userCode) 或 姓名，重名自动列出候选清单
 *      - 支持筛选参数直接传中文城市名 (如 "北京")、中文角色名 (如 "商圈经理")、中文组织名，自动转码查询
 *   3. 预留多环境扩展点：默认 `-e test` (测试环境)，预留 `-e prod` 扩展点。
 */

import {
  normalizeEnv,
  getUcHost,
  generateUcPortalUrl,
  EVENT_REASON_TYPES,
  getCurrentOperator,
  getUserSug,
  getCitySug,
  getOrgSug,
  getCompSug,
  getUcPositionByKeyword,
  getAllUcCity,
  getBusinessModeList,
  resolveCityCode,
  resolvePositionCode,
  resolveOrgCode,
  resolveUcUser,
  getEhrUserVOByPage,
  getEhrUserVO,
  getEhrUserEventQueueListByUcid,
  getUserFullProfile,
  getEhrOrgBasicVOByPage,
  getEhrOrgEventQueueListByOrgCode,
  getDisplayOrg,
  getChildNodes,
  getTreeNodeWithParentTreePath,
  getOrgFullDetail,
  getCompVOForPage,
  queryAllUserRoleByUserCode,
  queryRoleForUser,
  queryUserRolePage,
  queryRolePage,
  queryRoleRelationByRoleCode,
  queryRoleTree,
  queryTreeUserDetail,
  queryP2PRelations,
  queryUserOrgRelations,
  queryOrgOrgRelations,
  queryUnassignedUsers,
  queryUnassignedOrgs,
  queryRelationEvents,
  queryCustomOrgPage,
  queryCustomOrgChildren,
  queryOrgUserPage,
  getCommonEnums,
  getUserBpmProcessList,
  getUnreadBpmProcess,
  getUcPositionDesc,
  queryOrgTagDictPage,
  getOrgTagDictDetail,
  queryOrgTagInstancePage,
  getOrgTagInstanceLogs
} from './common/uc.js';

export function parseArgs(args) {
  const options = {
    command: null,
    targetId: null,
    targetId2: null,
    env: 'test',
    keyword: null,
    name: null,
    code: null,
    ucid: null,
    city: null,
    org: null,
    comp: null,
    parent: null,
    role: null,
    user: null,
    member: null,
    status: undefined,
    record: undefined,
    orgType: undefined,
    sourceId: undefined,
    unassigned: false,
    instances: false,
    allCities: false,
    customTree: false,
    orgUsers: false,
    logsId: null,
    detailId: null,
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
    } else if (arg === '--name') {
      options.name = args[++i];
    } else if (arg === '--code' || arg === '--user-code') {
      options.code = args[++i];
    } else if (arg === '--ucid') {
      options.ucid = args[++i];
    } else if (arg === '--city') {
      options.city = args[++i];
    } else if (arg === '--org') {
      options.org = args[++i];
    } else if (arg === '--comp' || arg === '--company') {
      options.comp = args[++i];
    } else if (arg === '--parent') {
      options.parent = args[++i];
    } else if (arg === '--role' || arg === '--pos') {
      options.role = args[++i];
    } else if (arg === '--user') {
      options.user = args[++i];
    } else if (arg === '--member') {
      options.member = args[++i];
    } else if (arg === '--status') {
      const val = args[++i];
      if (val === '在职' || val === '有效' || val === 'active') options.status = 1;
      else if (val === '离职' || val === '无效' || val === 'inactive') options.status = 0;
      else options.status = val !== undefined ? parseInt(val, 10) : undefined;
    } else if (arg === '--record') {
      const val = args[++i];
      if (val === '主岗' || val === 'main') options.record = 0;
      else if (val === '兼岗' || val === 'part') options.record = 1;
      else if (val === 'all' || val === '全部') options.record = null;
      else options.record = val !== undefined ? parseInt(val, 10) : undefined;
    } else if (arg === '--type' || arg === '--org-type') {
      options.orgType = parseInt(args[++i], 10);
    } else if (arg === '--source') {
      options.sourceId = args[++i];
    } else if (arg === '--unassigned') {
      options.unassigned = true;
    } else if (arg === '--instances') {
      options.instances = true;
    } else if (arg === '--all-cities') {
      options.allCities = true;
    } else if (arg === '--custom') {
      options.customTree = true;
    } else if (arg === '--org-users') {
      options.orgUsers = true;
    } else if (arg === '--logs') {
      options.logsId = args[++i] || 'true';
    } else if (arg === '--detail') {
      options.detailId = args[++i];
    } else if (arg === '--page') {
      options.page = parseInt(args[++i], 10) || 1;
    } else if (arg === '-n' || arg === '--page-size') {
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
  options.targetId2 = positional[2] || null;
  return options;
}

function getEnvTag(env) {
  const norm = normalizeEnv(env);
  if (norm === 'prod') {
    throw new Error('UC 线上生产环境 (-e prod) 暂未配置接入，当前仅支持测试环境 (-e test)');
  }
  const host = getUcHost(norm);
  return `🧪 测试环境 [${host.adminHost}]`;
}

function printDisambiguation(query, candidates) {
  console.log(`\n⚠️ 检测到同名或多条匹配员工 "${query}" (共 ${candidates.length} 人)，请使用具体的 16位 UCID 或 8位系统号精确查询:\n`);
  console.table(candidates.map(c => ({
    'UCID': c.ucid,
    '系统号 (userCode)': c.userCode || '-',
    '姓名': c.name || '-',
    '城市': c.officeAddressName || '-',
    '所在组织': c.orgName ? `${c.orgName} (${c.orgCode || '-'})` : (c.orgCode || '-'),
    '岗位/角色': c.positionName ? `${c.positionName}${c.positionCode ? `(${c.positionCode})` : ''}` : '-',
    '状态': c.status === 1 ? '在职' : (c.status === 0 ? '离职' : '-')
  })));
}

function formatEventDescription(ev) {
  const reason = ev.eventReason || ev.eventType || '';
  if (EVENT_REASON_TYPES.ROLE_ASSIGN.includes(reason)) {
    return `业务角色: ${ev.positionName || '-'}(${ev.positionCode || '-'}) | 所在组织: ${ev.orgName || '-'}(${ev.orgCode || '-'})`;
  }
  if (EVENT_REASON_TYPES.ROLE_TRANSFER.includes(reason)) {
    return `原角色: ${ev.oldName || '-'}(${ev.oldValue || '-'}) ➡️ 新角色: ${ev.newName || '-'}(${ev.newValue || '-'})`;
  }
  return `原组织: ${ev.oldName || '-'}(${ev.oldValue || '-'}) ➡️ 新组织: ${ev.newName || '-'}(${ev.newValue || '-'})`;
}

function printHelp() {
  console.log(`
🏢 Leo UC Query Engine (UC 组织与人员角色管理中心全量探查引擎)

使用格式:
  node scripts/uc_query.js <subcommand> [target] [options]

支持环境 (-e / --env):
  test (默认)   测试环境 (http://test3-uc.admin.ke.com & http://test-uc-relation-admin.ke.com)
  prod         线上环境扩展点 (http://uc.admin.ke.com & http://uc-relation-admin.ke.com)

核心子命令:
  whoami                                    查看当前登录的 UC 管理员账号、管理员角色与权限范围
  user <ucid|userCode|name>                 👤 员工全景画像 (基础信息+汇报链+主兼岗+UC角色设置+关系管辖范围+调转记录)
  users [keyword]                           🔍 多维检索人员列表 (支持按城市/组织/业务角色/在职状态/主兼岗组合找测试号)
  roles <ucid|userCode|name>                🎭 查询指定员工的所有角色详情 (UC岗位角色 + 关系中心角色及管辖门店/人员)
  role-users [roleCode|roleName]            👥 按业务角色反查绑定人员列表 (支持关系中心维护表与EHR人员表双视图)
  role-defs [keyword]                       📋 查询业务角色定义列表 (/roleCreate) 及角色关联的 UC 岗位映射
  role-tree <userCode|name> [--role <code>] 🌳 查询员工的角色层级架构树 (/newOrgTree)
  events <ucid|userCode|orgCode>            📜 查询人员人事调转记录或组织历史异动事件流
  org <orgCode|orgName>                     🏛️ 组织全景详情 (全路径+负责人+MDM加盟商+上下级树节点+异动历史+在职成员)
  orgs [orgCode|orgName]                    🔎 组织多维分页检索 (支持按城市/公司/上级组织/层级/状态过滤)
  org-tree [orgCode]                        🌲 业务组织树探查 (顶层集团树 / 指定组织子节点 / --custom 自定义业务组织树)
  companies [keyword]                       🏙️ 城市公司分页查询 (--city 城市, --all-cities 列出全国所有UC城市编码)
  p2p                                       🤝 人-人关系分页查询 (--role 角色, --city 城市, --user 负责人, --unassigned 待分配)
  user-org                                  🏘️ 人-组织关系聚合查询 (--role 角色, --city 城市, --user 人员, --org 组织, --unassigned 待分配)
  org-org                                   🔗 组织-组织关系分页查询 (--role 关系标签, --city 城市, --org 组织)
  rel-logs                                  📝 关系配置操作日志查询 (--role 角色编码, --city 城市编码)
  tags [keyword]                            🏷️ 组织标签字典查询 (--instances 查组织标签实例, --detail <id>, --logs <id>)
  bpm [userCode|name]                       📨 查询员工的 BPM 角色申请审批流记录与未读驳回提醒
  sug <type> [keyword]                      💡 通用联想与枚举字典查询 (type: user|city|org|comp|pos|role|role-pos|source|org-type|biz-mode|all)

常用筛选选项:
  -q, --keyword <str>     搜索关键词
  --city <name|code>      城市名称或编码 (如 "北京" 或 "110000"，支持中文自动转码)
  --org <name|code>       组织名称或编码 (如 "运营管理" 或 "XFTJ8001"，支持中文自动转码)
  --role <name|code>      业务角色名称或编码 (如 "商圈经理" 或 "765"，支持中文自动转码)
  --comp <name|code>      公司名称或编码
  --parent <name|code>    上级组织名称或编码
  --status <1|0|在职|离职> 状态过滤 (1: 在职/有效, 0: 离职/无效)
  --record <0|1|all>      角色属性过滤 (0: 主岗, 1: 兼岗, all: 全部)
  --type <num>            组织层级 (orgType, 如 2~8, 14~16)
  --page <num>            页码 (默认: 1)
  -n, --page-size <num>   每页条数 (默认: 20)
  --cookie <str>          单次覆盖 Cookie
  --set-cookie <str>      保存 Cookie 至本地缓存 (~/.shrimp/skills/live-inspector/test_uc_cookie.json)
  --json                  输出纯 JSON 格式

示例:
  node scripts/uc_query.js whoami
  node scripts/uc_query.js user 26068546
  node scripts/uc_query.js user 马楠
  node scripts/uc_query.js users --city 北京 --role 商圈经理 --status 在职 -n 10
  node scripts/uc_query.js roles 10138597
  node scripts/uc_query.js role-users 商圈经理 --city 天津
  node scripts/uc_query.js org XFTJ8001
  node scripts/uc_query.js orgs --city 北京 --status 1
  node scripts/uc_query.js p2p --role Community_Manager --city 110000
  node scripts/uc_query.js user-org --role CA --city 110000
  node scripts/uc_query.js sug pos 经理
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }

  const {
    command,
    targetId,
    targetId2,
    env,
    keyword,
    name,
    code,
    ucid,
    city,
    org,
    comp,
    parent,
    role,
    user,
    member,
    status,
    record,
    orgType,
    sourceId,
    unassigned,
    instances,
    allCities,
    customTree,
    orgUsers,
    logsId,
    detailId,
    page,
    pageSize,
    json,
    cookie
  } = options;

  const envKey = normalizeEnv(env);
  const envTag = getEnvTag(envKey);

  try {
    switch (command) {
      case 'whoami':
      case 'me': {
        const op = await getCurrentOperator({ env: envKey, cookie, forceRefresh: true });
        if (json) {
          console.log(JSON.stringify(op, null, 2));
          return;
        }
        console.log(`\n👤 当前 UC 登录管理员信息 (${envTag}):`);
        console.log(`   姓名:           ${op.userName || '-'}`);
        console.log(`   系统号:         ${op.userCode || '-'}`);
        console.log(`   UCID:           ${op.userId || '-'}`);
        console.log(`   当前管理员角色: ${op.currentRole?.name || '-'} (${op.roleId || '-'}, roleId: ${op.currentRoleId ?? '-'})`);
        console.log(`   角色描述:       ${op.currentRole?.desc || '-'}`);
        if (Array.isArray(op.ucRoleList) && op.ucRoleList.length > 0) {
          console.log(`   可选管理员角色: ${op.ucRoleList.map(r => `${r.name}(${r.id}${r.currentRole ? ' *当前' : ''})`).join('、')}`);
        }
        if (op.allExts && Object.keys(op.allExts).length > 0) {
          console.log(`   数据范围约束:   ${JSON.stringify(op.allExts)}`);
        }
        console.log(`   当前生效权限数: ${(op.currentRolePermissions || []).length} 项`);
        break;
      }

      case 'user':
      case 'profile': {
        const identifier = targetId || ucid || code || name || keyword;
        if (!identifier) {
          console.error('❌ 请提供员工标识 (16位 UCID、8位系统号 userCode 或姓名)，例如: node scripts/uc_query.js user 26068546');
          process.exit(1);
        }

        const profile = await getUserFullProfile(identifier, { env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }

        if (profile.notFound) {
          console.error(`❌ [${envTag}] 未找到匹配 "${identifier}" 的员工记录`);
          process.exit(1);
        }
        if (profile.ambiguous) {
          printDisambiguation(profile.query, profile.candidates);
          return;
        }

        const statusStr = profile.status === 1 ? '🟢 在职 (1)' : (profile.status === 0 ? '⚪ 离职 (0)' : `未知 (${profile.status})`);
        console.log(`\n👤 员工 UC 全景画像 (${envTag}):`);
        console.log(`   姓名:       ${profile.name} (${profile.sex || '性别未填'}) | 状态: ${statusStr}`);
        console.log(`   UCID:       ${profile.ucid} | 系统号 (userCode): ${profile.userCode}`);
        console.log(`   联系方式:   手机 ${profile.mobile || '-'} / 座机 ${profile.homePhone || '-'} | 邮箱: ${profile.email || '-'}`);
        console.log(`   归属组织:   [${profile.officeAddressName || '-'}] ${profile.brandName || '-'} / ${profile.compName || '-'} / ${profile.orgName || '-'} (${profile.orgCode || '-'})`);
        console.log(`   入职日期:   ${profile.entryDate || '-'} | 直属上级: ${profile.superior.name ? `${profile.superior.name} (系统号: ${profile.superior.userCode}, UCID: ${profile.superior.ucid})` : '-'}`);

        console.log(`\n📌 1. EHR 人事职位与 UC 岗位角色 (共 ${profile.allPositions.length} 条记录):`);
        if (profile.allPositions.length === 0) {
          console.log('   (暂无职位记录)');
        } else {
          console.table(profile.allPositions.map(p => ({
            '属性': p.userRecord === 0 ? '主岗 (0)' : `兼岗 (${p.userRecord})`,
            'UC业务角色': p.positionName || p.positionCode ? `${p.positionName || '-'}(${p.positionCode || '-'})` : '-',
            '角色状态': p.positionStatus === 1 ? '有效(1)' : `无效(${p.positionStatus})`,
            '数据来源': p.dataSource === 5 ? '🔧 UC手动设置(5)' : `EHR同步(${p.dataSource ?? 0})`,
            'uopId': p.uopId || '-',
            '所在组织': `${p.orgName || '-'}(${p.orgCode || '-'})`,
            '城市/公司': `${p.officeAddressName || '-'} / ${p.compName || '-'}`,
            'EHR职位/编码': p.ehrPositionName || p.jobCode ? `${p.ehrPositionName || '-'}(${p.jobCode || '-'})` : '-',
            '职级': p.ehrLevelName || p.level || '-'
          })));
        }

        console.log(`\n🎭 2. 关系配置中心绑定的业务角色与管辖范围 (共 ${profile.relationRoles.length} 项):`);
        if (profile.relationRoles.length === 0 && profile.roleList.length === 0) {
          console.log('   (该员工在关系配置中心暂未绑定额外业务角色关系)');
        } else if (profile.relationRoles.length > 0) {
          profile.relationRoles.forEach((r, idx) => {
            const rType = r.roleType === 1 ? '自定义角色' : '岗位角色';
            const rels = Array.isArray(r.relationList) ? r.relationList : [];
            const preview = rels.slice(0, 10).map(item => `${item.name}(${item.code})`).join(', ');
            console.log(`   • [角色 ${idx + 1}] ${r.roleName}(${r.roleCode || '-'}) [${rType}] — 关联/管辖对象 (${rels.length} 个): ${preview}${rels.length > 10 ? ` ...等共 ${rels.length} 个` : ''}`);
          });
        } else {
          console.table(profile.roleList.map(r => ({
            '角色编码': r.roleCode,
            '角色名称': r.roleName,
            '所属业务线': r.sourceName || '-'
          })));
        }

        if (profile.events.length > 0) {
          console.log(`\n📜 3. 最近人事调转与角色异动记录 (展示最近 ${Math.min(5, profile.events.length)} / ${profile.events.length} 条):`);
          profile.events.slice(0, 5).forEach(ev => {
            console.log(`   • [${ev.createTime || ev.occurTime || '-'}] ${ev.eventReasonName || ev.eventTypeName || ev.eventReason || '-'}: ${formatEventDescription(ev)}`);
          });
        }

        console.log(`\n🔗 控制台直达链接:`);
        console.log(`   人员查询页:     ${profile.links.memberMessageUrl}`);
        console.log(`   人员角色关系页: ${profile.links.configDetailUrl}`);
        console.log(`   老版权限查询页: ${profile.links.legacyPermissionUrl}`);
        break;
      }

      case 'users':
      case 'search':
      case 'list': {
        let resolvedCityCode = undefined;
        let resolvedOrgCode = undefined;
        let resolvedPosCode = undefined;
        let resolvedUcid = ucid;
        let resolvedUserCode = code;
        let resolvedUserName = name;

        const kw = targetId || keyword;
        if (kw && !ucid && !code && !name) {
          if (/^10000\d{11}$/.test(kw)) resolvedUcid = kw;
          else if (/^\d{6,10}$/.test(kw)) resolvedUserCode = kw;
          else resolvedUserName = kw;
        }

        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }
        if (org) {
          const oObj = await resolveOrgCode(org, { status: 2, env: envKey, cookie });
          resolvedOrgCode = oObj.orgCode;
        }
        if (role) {
          const pObj = await resolvePositionCode(role, { env: envKey, cookie });
          resolvedPosCode = pObj.positionCode;
        }

        const effectiveRecord = record === null ? undefined : (record !== undefined ? record : 0);
        const pageRes = await getEhrUserVOByPage({
          pageNo: page,
          pageSize,
          ucid: resolvedUcid,
          userCode: resolvedUserCode,
          userName: resolvedUserName,
          officeAddress: resolvedCityCode,
          orgCode: resolvedOrgCode,
          positionCode: resolvedPosCode,
          status,
          userRecord: effectiveRecord,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(pageRes, null, 2));
          return;
        }

        const list = pageRes?.list || [];
        const total = pageRes?.total || 0;
        console.log(`\n📋 UC 人员查询结果 (${envTag} | 共 ${total} 条, 当前第 ${page}/${Math.ceil(total / pageSize) || 1} 页):`);
        if (list.length === 0) {
          console.log('   (未检索到匹配的人员记录)');
        } else {
          console.table(list.map(u => ({
            'UCID': String(u.id),
            '系统号': u.userCode || '-',
            '姓名': u.name || '-',
            '业务角色/编码': u.positionName || u.positionCode ? `${u.positionName || '--'}(${u.positionCode || '--'})` : '--',
            'EHR职务': u.jobName || '-',
            '属性': u.userRecord === 0 ? '主岗' : '兼岗',
            '城市': u.officeAddressName || '-',
            '品牌': u.brandName || '--',
            '公司': u.compName || '--',
            '所在组织': u.orgName ? `${u.orgName}(${u.orgCode})` : (u.orgCode || '--'),
            '状态': u.status === 1 ? '在职' : (u.status === 0 ? '离职' : '--')
          })));
        }
        console.log(`\n🔗 页面直达: ${generateUcPortalUrl(envKey, '/memberMessage')}`);
        break;
      }

      case 'roles': {
        const identifier = targetId || ucid || code || name || keyword;
        if (!identifier) {
          console.error('❌ 请提供员工标识 (UCID / 系统号 / 姓名)，例如: node scripts/uc_query.js roles 26068546');
          process.exit(1);
        }

        const profile = await getUserFullProfile(identifier, { env: envKey, cookie, includeEvents: false });
        if (json) {
          console.log(JSON.stringify({
            ucid: profile.ucid,
            userCode: profile.userCode,
            name: profile.name,
            status: profile.status,
            ucPositions: profile.allPositions,
            relationRoles: profile.relationRoles,
            roleList: profile.roleList
          }, null, 2));
          return;
        }

        if (profile.notFound) {
          console.error(`❌ [${envTag}] 未找到匹配 "${identifier}" 的员工`);
          process.exit(1);
        }
        if (profile.ambiguous) {
          printDisambiguation(profile.query, profile.candidates);
          return;
        }

        console.log(`\n🎭 员工角色全景明细 (${envTag}) — ${profile.name} (系统号: ${profile.userCode}, UCID: ${profile.ucid}):`);
        console.log(`\n1️⃣ UC 岗位业务角色与手动设置角色 (${profile.allPositions.length} 条):`);
        console.table(profile.allPositions.map(p => ({
          '属性': p.userRecord === 0 ? '主岗' : '兼岗',
          '业务角色': `${p.positionName || '-'}(${p.positionCode || '-'})`,
          '角色状态': p.positionStatus === 1 ? '有效' : '无效',
          '来源': p.dataSource === 5 ? '🔧 UC手动设置(可改删)' : `EHR同步(${p.dataSource ?? 0})`,
          'uopId': p.uopId || '-',
          '组织': `${p.orgName || '-'}(${p.orgCode || '-'})`,
          'EHR职位': `${p.ehrPositionName || '-'}(${p.jobCode || '-'})`,
          '职级': p.level || p.ehrLevelName || '-'
        })));

        console.log(`\n2️⃣ 关系配置中心角色及管辖范围 (${profile.relationRoles.length} 项):`);
        if (profile.relationRoles.length === 0) {
          console.log('   (无关系配置中心角色记录)');
        } else {
          profile.relationRoles.forEach((r, i) => {
            const rels = r.relationList || [];
            console.log(`   [${i + 1}] ${r.roleName} (编码: ${r.roleCode || '-'}, 类型: ${r.roleType === 1 ? '自定义角色' : '岗位角色'})`);
            if (rels.length > 0) {
              console.log(`       管辖/关联对象 (${rels.length} 个): ${rels.slice(0, 15).map(x => `${x.name}(${x.code})`).join('、')}${rels.length > 15 ? ` ...等共 ${rels.length} 个` : ''}`);
            }
          });
        }
        break;
      }

      case 'role-users': {
        const roleInput = targetId || role || keyword;
        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }

        let resolvedRoleCode = roleInput;
        if (roleInput && !/^[A-Za-z0-9_-]+$/.test(roleInput)) {
          const pObj = await resolvePositionCode(roleInput, { env: envKey, cookie }).catch(() => null);
          if (pObj) resolvedRoleCode = pObj.positionCode;
        }

        const [relRolePage, ehrRolePage] = await Promise.all([
          queryUserRolePage({
            roleCodeList: resolvedRoleCode,
            userCodeList: user || code,
            officeAddress: resolvedCityCode,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          }).catch(() => null),
          resolvedRoleCode && /^\d+$/.test(String(resolvedRoleCode))
            ? getEhrUserVOByPage({
                pageNo: page,
                pageSize,
                positionCode: String(resolvedRoleCode),
                officeAddress: resolvedCityCode,
                status: status !== undefined ? status : 1,
                userRecord: record !== undefined ? record : 0,
                env: envKey,
                cookie
              }).catch(() => null)
            : Promise.resolve(null)
        ]);

        if (json) {
          console.log(JSON.stringify({ relationRolePage: relRolePage, ehrRolePage }, null, 2));
          return;
        }

        if (relRolePage && Array.isArray(relRolePage.list) && relRolePage.list.length > 0) {
          console.log(`\n👥 人员角色维护表查询结果 (${envTag} | 共 ${relRolePage.total || relRolePage.list.length} 条, 第 ${page} 页):`);
          console.table(relRolePage.list.map(item => ({
            '姓名(系统号)': `${item.userName || '-'}(${item.userCode || '-'})`,
            '业务角色(编码)': `${item.roleName || '-'}(${item.roleCode || '-'})`,
            '城市': item.officeAddressName || '-',
            '角色类型': item.roleType === 1 ? '自定义角色' : '岗位角色',
            '绑定类型': item.bindType ?? '-'
          })));
        }

        if (ehrRolePage && Array.isArray(ehrRolePage.list) && ehrRolePage.list.length > 0) {
          console.log(`\n📋 EHR/UC 岗位角色人员列表 [positionCode=${resolvedRoleCode}] (共 ${ehrRolePage.total} 人, 第 ${page} 页):`);
          console.table(ehrRolePage.list.map(u => ({
            'UCID': String(u.id),
            '系统号': u.userCode,
            '姓名': u.name,
            '业务角色': `${u.positionName || '-'}(${u.positionCode || '-'})`,
            '属性': u.userRecord === 0 ? '主岗' : '兼岗',
            '城市': u.officeAddressName || '-',
            '所在组织': `${u.orgName || '-'}(${u.orgCode || '-'})`,
            '状态': u.status === 1 ? '在职' : '离职'
          })));
        }

        if ((!relRolePage?.list || relRolePage.list.length === 0) && (!ehrRolePage?.list || ehrRolePage.list.length === 0)) {
          console.log(`\n   (未检索到匹配的角色人员记录${resolvedRoleCode ? `，角色编码: ${resolvedRoleCode}` : ''})`);
        }
        break;
      }

      case 'role-defs': {
        const kw = targetId || role || keyword;
        const [rolePage, mappedPositions, posDesc] = await Promise.all([
          queryRolePage({
            roleCodeList: kw,
            status,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          }).catch(() => ({ total: 0, list: [] })),
          kw ? queryRoleRelationByRoleCode(kw, { sourceId, env: envKey, cookie }).catch(() => []) : Promise.resolve([]),
          kw && /^\d+$/.test(kw) ? getUcPositionDesc(kw, { env: envKey, cookie }).catch(() => null) : Promise.resolve(null)
        ]);

        if (json) {
          console.log(JSON.stringify({ rolePage, mappedPositions, posDesc }, null, 2));
          return;
        }

        const list = rolePage?.list || [];
        console.log(`\n📋 UC 业务角色定义列表 (${envTag} | 共 ${rolePage?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length > 0) {
          console.table(list.map(r => ({
            '角色编码': r.roleCode,
            '角色名称': r.roleName,
            '角色类型': r.roleType === 1 ? '自定义角色(1)' : '岗位角色(0)',
            '绑定类型(bindType)': r.bindType === 1 ? '1-人-组织' : (r.bindType === 2 ? '2-人-人' : (r.bindType === 4 ? '4-组织-组织' : r.bindType)),
            '绑定层级(bindLevel)': r.bindLevel ?? '-',
            '业务域(sourceId)': r.sourceName || r.sourceId || '-',
            '状态': r.status === 1 ? '有效' : '无效'
          })));
        } else {
          console.log('   (未查询到匹配的业务角色定义)');
        }

        if (Array.isArray(mappedPositions) && mappedPositions.length > 0) {
          console.log(`\n🔗 角色 [${kw}] 映射的 UC 岗位列表 (共 ${mappedPositions.length} 项):`);
          console.table(mappedPositions.map(p => ({
            '岗位编码': p.positionCode,
            '岗位名称': p.positionName,
            '关联类型': p.relationType
          })));
        }
        if (posDesc) {
          console.log(`\n📝 岗位 [${kw}] 描述说明: ${typeof posDesc === 'string' ? posDesc : JSON.stringify(posDesc)}`);
        }
        break;
      }

      case 'role-tree': {
        const identifier = targetId || user || code || name;
        if (!identifier) {
          console.error('❌ 请提供员工系统号或姓名，例如: node scripts/uc_query.js role-tree 20192015');
          process.exit(1);
        }

        let targetUserCode = identifier;
        if (!/^\d{6,10}$/.test(identifier)) {
          const resolved = await resolveUcUser(identifier, { env: envKey, cookie });
          if (resolved.notFound) {
            console.error(`❌ 未找到员工 "${identifier}"`);
            process.exit(1);
          }
          if (resolved.ambiguous) {
            printDisambiguation(resolved.query, resolved.candidates);
            return;
          }
          targetUserCode = resolved.userCode;
        }

        const [userRolesRes, userDetail, treeData] = await Promise.all([
          queryRoleForUser(targetUserCode, { env: envKey, cookie }).catch(() => ({ roleList: [] })),
          queryTreeUserDetail(targetUserCode, { env: envKey, cookie }).catch(() => null),
          queryRoleTree({ userCode: targetUserCode, roleCode: role, env: envKey, cookie }).catch(() => null)
        ]);

        if (json) {
          console.log(JSON.stringify({ userCode: targetUserCode, userDetail, roleList: userRolesRes?.roleList || [], treeData }, null, 2));
          return;
        }

        console.log(`\n🌳 员工角色层级架构树 (${envTag}) — 系统号: ${targetUserCode}:`);
        if (userDetail) {
          console.log(`   当前岗位: ${userDetail.positionName || '-'} | 所在组织: ${userDetail.currentOrgName || '-'}(${userDetail.currentOrgCode || '-'}) | 直属上级: ${userDetail.superiorUserName || '-'}`);
        }
        const rList = userRolesRes?.roleList || [];
        if (rList.length > 0) {
          console.log(`   拥有角色 (${rList.length} 个): ${rList.map(r => `${r.roleName}(${r.roleCode}, 业务线: ${r.sourceName || '-'})`).join('、')}`);
        }
        if (treeData) {
          const supList = treeData.superiorTreeList || [];
          const followList = treeData.followOrgList || [];
          console.log(`\n   向上汇报组织链 (${supList.length} 层):`);
          supList.forEach((node, idx) => {
            console.log(`     ${'  '.repeat(idx)}↑ [${node.orgCode}] ${node.orgName} — 负责人: ${node.directName || '-'}(${node.directUserCode || '-'})`);
          });
          console.log(`   当前节点: [${treeData.orgCode || '-'}] ${treeData.orgName || '-'} — ${treeData.userName || '-'}(${treeData.userCode || targetUserCode})`);
          if (followList.length > 0) {
            console.log(`   下属管辖组织 (${followList.length} 个): ${followList.map(o => `${o.orgName}(${o.orgCode})`).join('、')}`);
          }
        }
        break;
      }

      case 'events': {
        const target = targetId || ucid || code || org;
        if (!target) {
          console.error('❌ 请提供员工标识 (UCID / 系统号 / 姓名) 或组织编码，例如: node scripts/uc_query.js events 10138597 或 node scripts/uc_query.js events XFTJ8001');
          process.exit(1);
        }

        // Determine if target is an orgCode (contains letters like XFTJ8001, B10066616, LW1059)
        if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(target)) {
          const orgEvents = await getEhrOrgEventQueueListByOrgCode(target, { env: envKey, cookie });
          if (json) {
            console.log(JSON.stringify(orgEvents, null, 2));
            return;
          }
          console.log(`\n📜 组织 [${target}] 历史异动事件记录 (${envTag} | 共 ${orgEvents.length} 条):`);
          if (orgEvents.length === 0) {
            console.log('   (暂无组织异动记录)');
          } else {
            console.table(orgEvents.map(ev => ({
              '事件ID': ev.id,
              '生效时间': ev.createTime || ev.occurTime || '-',
              '异动类型': `${ev.eventTypeName || '-'}(${ev.eventType || '-'})`,
              '原名称/原值': ev.oldName || ev.oldValue || '-',
              '新名称/新值': ev.newName || ev.newValue || '-'
            })));
          }
          return;
        }

        const resolved = await resolveUcUser(target, { env: envKey, cookie });
        if (resolved.notFound) {
          console.error(`❌ 未找到员工 "${target}"`);
          process.exit(1);
        }
        if (resolved.ambiguous) {
          printDisambiguation(resolved.query, resolved.candidates);
          return;
        }

        const userEvents = await getEhrUserEventQueueListByUcid(resolved.ucid, { env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify({ user: resolved, events: userEvents }, null, 2));
          return;
        }

        console.log(`\n📜 员工 [${resolved.name} (${resolved.userCode}, UCID: ${resolved.ucid})] 调转事件记录 (${envTag} | 共 ${userEvents.length} 条):`);
        if (userEvents.length === 0) {
          console.log('   (暂无调转记录)');
        } else {
          console.table(userEvents.map(ev => ({
            '事件ID': ev.id,
            'UC生效时间': ev.createTime || ev.occurTime || '-',
            '调转类型': `${ev.eventReasonName || ev.eventTypeName || '-'}(${ev.eventReason || ev.eventType || '-'})`,
            '变动详情': formatEventDescription(ev)
          })));
        }
        break;
      }

      case 'org': {
        const orgInput = targetId || org || keyword;
        if (!orgInput) {
          console.error('❌ 请提供组织编码或组织名称，例如: node scripts/uc_query.js org XFTJ8001');
          process.exit(1);
        }

        const detail = await getOrgFullDetail(orgInput, { env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }

        const b = detail.basicInfo || {};
        const e = detail.ehrOrg || {};
        const t = detail.treeNode || {};
        console.log(`\n🏛️ UC 组织全景详情 (${envTag}):`);
        console.log(`   组织名称:     ${detail.shortName || '-'} | 组织编码: ${detail.orgCode}`);
        console.log(`   组织状态:     ${b.status === 1 ? '🟢 有效 (1)' : (b.status === 0 ? '⚪ 无效 (0)' : '-') } | 组织层级 (orgType): ${b.orgType ?? t.orgType ?? '-'}`);
        console.log(`   所在城市:     ${b.officeAddressName || t.officeAddressName || '-'} (${b.officeAddress || t.officeAddress || '-'})`);
        console.log(`   品牌 / 公司:  ${b.brandName || '-'}(${b.brandCode || '-'}) / ${b.treeLevel2Name || '-'}(${b.treeLevel2Code || '-'})`);
        console.log(`   上级组织:     ${b.parentShortName || '-'}(${b.parentOrgCode || t.parentOrgCode || '-'})`);
        console.log(`   组织全路径:   ${e.treePathNameForDisplay || e.fullPathName || '-'}`);
        console.log(`   全路径编码:   ${e.treePathCodeForDispaly || '-'}`);
        console.log(`   组织负责人:   ${e.directorName || t.directorName || '-'} (系统号: ${e.directorUserCode || t.directorUserCode || '-'}, UCID: ${e.directorUcid || '-'})`);
        if (e.mdmCode || e.mdmName) {
          console.log(`   经营加盟商:   ${e.mdmName || '-'}(${e.mdmCode || '-'})`);
        }
        if (t.businessModeName || t.businessModeCode) {
          console.log(`   业务模式:     ${t.businessModeName || '-'}(${t.businessModeCode || '-'})`);
        }

        if (detail.childNodes.length > 0) {
          console.log(`\n🌲 下级子组织 (${detail.childNodes.length} 个):`);
          console.table(detail.childNodes.slice(0, 20).map(c => ({
            '子组织编码': c.orgCode,
            '子组织名称': c.orgName,
            '层级(orgType)': c.orgType ?? '-',
            '负责人': c.directorName ? `${c.directorName}(${c.directorUserCode || '-'})` : '-',
            '业务模式': c.businessModeName || '-',
            '叶子节点': c.isLeaf === 1 ? '是' : '否'
          })));
        }

        const uList = detail.activeUsers?.list || [];
        console.log(`\n👥 组织下在职主岗成员 (共 ${detail.activeUsers?.total || uList.length} 人, 展示前 ${uList.length} 人):`);
        if (uList.length > 0) {
          console.table(uList.map(u => ({
            'UCID': String(u.id),
            '系统号': u.userCode,
            '姓名': u.name,
            '业务角色': u.positionName || u.positionCode ? `${u.positionName || '-'}(${u.positionCode || '-'})` : '-',
            'EHR职务': u.jobName || '-'
          })));
        } else {
          console.log('   (当前组织下暂无在职主岗员工)');
        }

        if (detail.events.length > 0) {
          console.log(`\n📜 组织历史异动记录 (共 ${detail.events.length} 条):`);
          detail.events.slice(0, 5).forEach(ev => {
            console.log(`   • [${ev.createTime || '-'}] ${ev.eventTypeName || ev.eventType}: ${ev.oldName || '-'} ➡️ ${ev.newName || '-'}`);
          });
        }

        console.log(`\n🔗 页面直达:`);
        console.log(`   组织查询页: ${detail.links.orgMessageUrl}`);
        console.log(`   业务组织树: ${detail.links.orgTreeUrl}`);
        console.log(`   组织成员页: ${detail.links.memberMessageUrl}`);
        break;
      }

      case 'orgs': {
        let resolvedCityCode = undefined;
        let resolvedOrgCode = undefined;
        let resolvedParentCode = undefined;

        const orgInput = targetId || org || keyword;
        if (orgInput) {
          const oObj = await resolveOrgCode(orgInput, { status: 2, env: envKey, cookie });
          resolvedOrgCode = oObj.orgCode;
        }
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }
        if (parent) {
          const pObj = await resolveOrgCode(parent, { status: 2, env: envKey, cookie });
          resolvedParentCode = pObj.orgCode;
        }

        const pageRes = await getEhrOrgBasicVOByPage({
          pageNo: page,
          pageSize,
          orgCode: resolvedOrgCode,
          officeAddress: resolvedCityCode,
          compCode: comp,
          parentOrgCode: resolvedParentCode,
          status,
          orgType,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(pageRes, null, 2));
          return;
        }

        const list = pageRes?.list || [];
        const total = pageRes?.total || 0;
        console.log(`\n🏛️ UC 组织分页查询结果 (${envTag} | 共 ${total} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (未查询到匹配的组织记录)');
        } else {
          console.table(list.map(o => ({
            '组织编码': o.orgCode,
            '组织名称': o.shortName || '-',
            '城市/编码': o.officeAddress ? `${o.officeAddressName || '-'}/${o.officeAddress}` : '--',
            '品牌/编码': o.brandName ? `${o.brandName}/${o.brandCode || '--'}` : '--',
            '公司/编码': o.treeLevel2Name ? `${o.treeLevel2Name}/${o.treeLevel2Code || '--'}` : '--',
            '层级(orgType)': o.orgType ?? '--',
            '上级组织': o.parentShortName ? `${o.parentShortName}(${o.parentOrgCode || '-'})` : '--',
            '状态': o.status === 1 ? '有效' : (o.status === 0 ? '无效' : '--')
          })));
        }
        break;
      }

      case 'org-tree': {
        const targetOrg = targetId || org;
        if (customTree) {
          let resolvedCityCode = undefined;
          if (city) {
            const cObj = await resolveCityCode(city, { env: envKey, cookie });
            resolvedCityCode = cObj.cityCode;
          }
          const data = targetOrg && !sourceId
            ? await queryCustomOrgChildren(targetOrg, { env: envKey, cookie })
            : await queryCustomOrgPage({ sourceId, officeAddress: resolvedCityCode, orgCode: targetOrg, env: envKey, cookie });
          if (json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(`\n🌲 自定义业务组织树查询结果 (${envTag}):`);
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (orgUsers && targetOrg) {
          const res = await queryOrgUserPage({
            orgCode: targetOrg,
            userCodes: user || code,
            roleCode: role,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          const list = res?.list || [];
          console.log(`\n👥 业务组织 [${targetOrg}] 绑定成员列表 (${envTag} | 共 ${res?.total || list.length} 人):`);
          console.table(list);
          return;
        }

        if (!targetOrg) {
          const [roots, bizModes] = await Promise.all([
            getDisplayOrg({ env: envKey, cookie }),
            getBusinessModeList({ env: envKey, cookie }).catch(() => [])
          ]);
          if (json) {
            console.log(JSON.stringify({ roots, bizModes }, null, 2));
            return;
          }
          console.log(`\n🌲 UC 业务组织树顶层结构 (${envTag}):`);
          roots.forEach(r => {
            console.log(`   📦 [${r.orgCode}] ${r.orgName} (负责人: ${r.directorName || '-'}/${r.directorUserCode || '-'}, 业务模式: ${r.businessModeName || '-'})`);
            const children = r.childNodeList || [];
            if (children.length > 0) {
              console.table(children.map(c => ({
                '组织编码': c.orgCode,
                '组织名称': c.orgName,
                '城市': c.officeAddressName || '-',
                '负责人': c.directorName ? `${c.directorName}(${c.directorUserCode || '-'})` : '-',
                '业务模式': c.businessModeName || '-',
                '层级': c.orgType ?? '-',
                '是否叶子': c.isLeaf === 1 ? '是' : '否'
              })));
            }
          });
          if (bizModes.length > 0) {
            console.log(`\n💼 可选业务模式字典: ${bizModes.map(b => `${b.businessModeName}(${b.businessModeCode})`).join('、')}`);
          }
        } else {
          const [nodePath, children] = await Promise.all([
            getTreeNodeWithParentTreePath(targetOrg, { status: status ?? 1, env: envKey, cookie }),
            getChildNodes(targetOrg, { depth: 1, status: status ?? 1, env: envKey, cookie })
          ]);
          if (json) {
            console.log(JSON.stringify({ nodePath, children }, null, 2));
            return;
          }
          console.log(`\n🌲 组织树节点 [${targetOrg}] 路径与下级节点 (${envTag}):`);
          if (nodePath) {
            const pathStr = (nodePath.parentNodePath || []).map(p => `${p.orgName}(${p.orgCode})`).join(' ➡️ ');
            console.log(`   父级路径: ${pathStr ? `${pathStr} ➡️ ` : ''}【${nodePath.orgName}(${nodePath.orgCode})】`);
            console.log(`   负责人:   ${nodePath.directorName || '-'}(${nodePath.directorUserCode || '-'}) | 城市: ${nodePath.officeAddressName || '-'} | 业务模式: ${nodePath.businessModeName || '-'}`);
          }
          console.log(`\n   下级子节点 (${children.length} 个):`);
          if (children.length > 0) {
            console.table(children.map(c => ({
              '子组织编码': c.orgCode,
              '子组织名称': c.orgName,
              '城市': c.officeAddressName || '-',
              '负责人': c.directorName ? `${c.directorName}(${c.directorUserCode || '-'})` : '-',
              '业务模式': c.businessModeName || '-',
              '层级': c.orgType ?? '-',
              '是否叶子': c.isLeaf === 1 ? '是' : '否'
            })));
          } else {
            console.log('   (已是叶子节点或无下级有效组织)');
          }
        }
        break;
      }

      case 'companies':
      case 'comp':
      case 'cities': {
        if (allCities || command === 'cities') {
          const cities = await getAllUcCity({ env: envKey, cookie });
          if (json) {
            console.log(JSON.stringify(cities, null, 2));
            return;
          }
          console.log(`\n🏙️ UC 全量城市字典 (${envTag} | 共 ${cities.length} 个城市):`);
          console.table(cities.slice(0, 50).map(c => ({
            'ID': c.id,
            '城市编码 (cityCode)': c.cityCode,
            '城市名称': c.name,
            '简称': c.shortname || '-',
            '区号 (postCode)': c.postCode || '-',
            '状态': c.status
          })));
          if (cities.length > 50) {
            console.log(`   ...共 ${cities.length} 条，如需查看完整列表请加 --json`);
          }
          return;
        }

        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }
        let resolvedCompCode = targetId || comp || org || keyword;
        if (resolvedCompCode && !/^[A-Za-z0-9_.-]+$/.test(resolvedCompCode)) {
          const sugs = await getCompSug(resolvedCompCode, { officeAddress: resolvedCityCode, forCompPage: 1, env: envKey, cookie });
          if (sugs.length > 0) resolvedCompCode = sugs[0].orgCode;
        }

        const res = await getCompVOForPage({
          orgCode: resolvedCompCode,
          officeAddress: resolvedCityCode,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || [];
        console.log(`\n🏢 UC 城市公司列表 (${envTag} | 共 ${res?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (未查询到匹配的城市公司)');
        } else {
          console.table(list.map(c => ({
            '城市': c.officeAddressName || '--',
            '城市编码': c.ucOfficeAddress || '--',
            '区号': c.postCode || '--',
            '公司名称': c.orgName || '--',
            '组织编码': c.ucOrgCode || '--',
            'PS编码': c.ehrSet || '--',
            '状态': c.status === 1 ? '有效' : (c.status === 0 ? '无效' : '--')
          })));
        }
        break;
      }

      case 'p2p': {
        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }
        const roleCode = targetId || role;

        if (unassigned) {
          if (!roleCode) {
            console.error('❌ 查询待分配人员 (--unassigned) 必须通过 --role 指定业务角色编码');
            process.exit(1);
          }
          const res = await queryUnassignedUsers({
            roleCode,
            officeAddress: resolvedCityCode,
            company: comp,
            userCode: user || code,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          const list = res?.list || [];
          console.log(`\n🤝 人-人关系 [待分配人员] (${envTag} | 共 ${res?.total || list.length} 条):`);
          console.table(list);
          return;
        }

        const res = await queryP2PRelations({
          roleCodeList: roleCode,
          userCodeList: user || code,
          memberUserCodeList: member,
          orgCode: org,
          officeAddress: resolvedCityCode,
          status: status ?? 1,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || [];
        console.log(`\n🤝 人-人关系列表 (${envTag} | 共 ${res?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (未查询到匹配的人-人关系记录，可通过 --role <roleCode> --city <cityCode> 过滤)');
        } else {
          console.table(list.map(r => ({
            'ID': r.id || '-',
            '业务角色': `${r.roleName || '-'}(${r.roleCode || '-'})`,
            '负责人': `${r.userName || '-'}(${r.userCode || '-'})`,
            '组员/成员': `${r.memberUserName || '-'}(${r.memberUserCode || '-'})`,
            '城市': r.officeAddressName || r.officeAddress || '-',
            '所在组织': r.orgName ? `${r.orgName}(${r.orgCode || '-'})` : (r.orgCode || '-')
          })));
        }
        break;
      }

      case 'user-org': {
        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }
        const roleCode = targetId || role;

        if (unassigned) {
          if (!roleCode) {
            console.error('❌ 查询待分配组织 (--unassigned) 必须通过 --role 指定业务角色编码');
            process.exit(1);
          }
          const res = await queryUnassignedOrgs({
            roleCode,
            officeAddress: resolvedCityCode,
            company: comp,
            orgCodeList: org,
            userCode: user || code,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          const list = res?.list || [];
          console.log(`\n🏘️ 人-组织关系 [待分配组织] (${envTag} | 共 ${res?.total || list.length} 条):`);
          console.table(list);
          return;
        }

        const res = await queryUserOrgRelations({
          roleCode,
          userCode: user || code,
          orgCode: org,
          officeAddress: resolvedCityCode,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || [];
        console.log(`\n🏘️ 人-组织关系聚合列表 (${envTag} | 共 ${res?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (未查询到匹配的人-组织关系记录，可通过 --role <roleCode> --city <cityCode> 过滤)');
        } else {
          console.table(list.map(r => ({
            '组织名称(编码)': `${r.shortName || r.orgName || '-'}(${r.orgCode || '-'})`,
            '业务角色': `${r.roleName || '-'}(${r.roleCode || '-'})`,
            '关联人员': Array.isArray(r.relationUserInfo)
              ? r.relationUserInfo.map(u => `${u.userName || ''}(${u.userCode || ''})`).join(', ')
              : (r.userName ? `${r.userName}(${r.userCode})` : '-'),
            '城市': r.officeAddressName || r.officeAddress || '-'
          })));
        }
        break;
      }

      case 'org-org': {
        const roleCode = targetId || role;
        if (!roleCode) {
          console.error('❌ 查询组织-组织关系必须提供关系标签 (roleCode)，例如: node scripts/uc_query.js org-org 200111');
          process.exit(1);
        }
        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }

        const res = await queryOrgOrgRelations({
          roleCodeList: roleCode,
          officeAddress: resolvedCityCode,
          orgCodeList: org,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || (Array.isArray(res) ? res : []);
        console.log(`\n🔗 组织-组织关系列表 (${envTag} | 共 ${res?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (未查询到匹配的组织-组织关系记录)');
        } else {
          console.table(list.map(r => ({
            '组织名称(编码)': `${r.orgName || '-'}（${r.orgCode || '-'}）`,
            '关联组织(编码)': `${r.memberOrgName || '-'}（${r.memberOrgCode || '-'}）`,
            '城市': r.officeAddressStr || '-',
            '关系标签': `${r.roleName || '-'}(${r.roleCode || roleCode})`
          })));
        }
        break;
      }

      case 'rel-logs': {
        const roleCode = targetId || role;
        let resolvedCityCode = undefined;
        if (city) {
          const cObj = await resolveCityCode(city, { env: envKey, cookie });
          resolvedCityCode = cObj.cityCode;
        }

        const res = await queryRelationEvents({
          roleCode,
          officeAddress: resolvedCityCode,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });

        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        const list = res?.list || [];
        console.log(`\n📝 关系配置操作日志 (${envTag} | 共 ${res?.total || list.length} 条, 第 ${page} 页):`);
        if (list.length === 0) {
          console.log('   (暂无关系配置操作日志)');
        } else {
          console.table(list);
        }
        break;
      }

      case 'tags': {
        if (detailId) {
          const d = await getOrgTagDictDetail(detailId, { env: envKey, cookie });
          console.log(JSON.stringify(d, null, 2));
          return;
        }
        if (logsId && logsId !== 'true') {
          const l = await getOrgTagInstanceLogs(logsId, { env: envKey, cookie });
          console.log(JSON.stringify(l, null, 2));
          return;
        }
        if (instances) {
          const res = await queryOrgTagInstancePage({
            orgCode: org,
            tagCode: targetId || code || keyword,
            status,
            pageNo: page,
            pageSize,
            env: envKey,
            cookie
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          const list = res?.list || [];
          console.log(`\n🏷️ 组织标签实例列表 (${envTag} | 共 ${res?.total || list.length} 条):`);
          console.table(list);
          return;
        }

        const res = await queryOrgTagDictPage({
          tagName: targetId || name || keyword,
          tagCode: code,
          status,
          pageNo: page,
          pageSize,
          env: envKey,
          cookie
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        const list = res?.list || [];
        console.log(`\n🏷️ 组织标签字典列表 (${envTag} | 共 ${res?.total || list.length} 条):`);
        if (list.length === 0) {
          console.log('   (暂无组织标签字典记录)');
        } else {
          console.table(list);
        }
        break;
      }

      case 'bpm': {
        let targetUserCode = targetId || user || code;
        if (targetUserCode && !/^\d{6,10}$/.test(targetUserCode)) {
          const resolved = await resolveUcUser(targetUserCode, { env: envKey, cookie });
          if (resolved.notFound) {
            console.error(`❌ 未找到员工 "${targetUserCode}"`);
            process.exit(1);
          }
          if (resolved.ambiguous) {
            printDisambiguation(resolved.query, resolved.candidates);
            return;
          }
          targetUserCode = resolved.userCode;
        }

        const [bpmList, unread] = await Promise.all([
          getUserBpmProcessList({ userCode: targetUserCode, pageNo: page, pageSize, env: envKey, cookie }),
          getUnreadBpmProcess({ userCode: targetUserCode, env: envKey, cookie }).catch(() => [])
        ]);

        if (json) {
          console.log(JSON.stringify({ bpmList, unread }, null, 2));
          return;
        }

        const list = bpmList?.list || [];
        console.log(`\n📨 员工 BPM 角色申请流程列表 (${envTag} | 共 ${bpmList?.total || list.length} 条):`);
        if (Array.isArray(unread) && unread.length > 0) {
          console.log(`   ⚠️ 未读驳回提醒: ${JSON.stringify(unread)}`);
        }
        if (list.length === 0) {
          console.log('   (暂无 BPM 角色申请记录)');
        } else {
          console.table(list);
        }
        break;
      }

      case 'sug': {
        const sugType = (targetId || 'all').toLowerCase();
        const kw = targetId2 || keyword || '';
        let result;
        switch (sugType) {
          case 'user':
            result = await getUserSug(kw, { pageSize, env: envKey, cookie });
            break;
          case 'city':
            result = await getCitySug(kw, { size: pageSize, env: envKey, cookie });
            break;
          case 'org':
            result = await getOrgSug(kw, { size: pageSize, status: status ?? 2, env: envKey, cookie });
            break;
          case 'comp':
            result = await getCompSug(kw, { size: pageSize, officeAddress: city, env: envKey, cookie });
            break;
          case 'pos':
          case 'position':
            result = await getUcPositionByKeyword(kw, { pageSize, env: envKey, cookie });
            break;
          case 'biz-mode':
            result = await getBusinessModeList({ env: envKey, cookie });
            break;
          case 'role':
          case 'role-pos':
          case 'source':
          case 'biz-source':
          case 'org-type':
          case 'org-type-source':
          case 'all':
            result = await getCommonEnums({ type: sugType, query: kw, env: envKey, cookie });
            break;
          default:
            console.error(`❌ 未知的 sug 类型 "${sugType}"，可选值: user | city | org | comp | pos | role | role-pos | source | biz-source | org-type | biz-mode | all`);
            process.exit(1);
        }

        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`\n💡 UC 联想与字典查询 [${sugType}] (${envTag}):`);
        if (Array.isArray(result)) {
          console.table(result);
        } else {
          console.log(JSON.stringify(result, null, 2));
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

import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
