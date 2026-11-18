#!/usr/bin/env node

/**
 * 🛡️ Leo Live Inspector - UC 组织与人员角色测试环境两阶段安全变更引擎 (UC Modify Engine)
 *
 * 核心风控规范：
 *   1. 严格两阶段发布机制 (Zero Silent Mutation)：
 *      - 未提供 `--confirm` 时，强制处于 Pre-flight 预审模式 (Dry-Run)，仅查询现状并输出【变更前 vs 变更后】Diff 对比单；
 *      - 必须等待用户明确确认后，追加 `--confirm` 方可真正执行写入并自动回查校验生效状态。
 *   2. 高危操作强预警：
 *      - 涉及删除人员角色 (`del-pos`)、解绑关系中心角色 (`unbind-role`) 等缩权操作，自动打印高危警示横幅。
 *   3. 生产环境物理阻断：
 *      - 严格拦截 `-e prod` 写操作，仅允许在测试环境 (`-e test`) 下执行变更。
 */

import {
  normalizeEnv,
  getUcHost,
  generateUcPortalUrl,
  assertUcWritePermitted,
  resolveOrgCode,
  resolvePositionCode,
  resolveUcUser,
  getEhrUserVO,
  getTreeNodeWithParentTreePath,
  getBusinessModeList,
  queryAllUserRoleByUserCode,
  addUserPosition,
  modifyUserPosition,
  deleteUserPosition,
  updateBusinessMode,
  bindRoleForUser,
  disableRoleForUser
} from './common/uc.js';

export function parseArgs(args) {
  const options = {
    command: null,
    targetId: null,
    targetId2: null,
    env: 'test',
    org: null,
    role: null,
    level: '',
    id: null,
    fromOrg: null,
    fromRole: null,
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
    } else if (arg === '--org' || arg === '--to-org') {
      options.org = args[++i];
    } else if (arg === '--role' || arg === '--pos' || arg === '--to-role') {
      options.role = args[++i];
    } else if (arg === '--level' || arg === '--to-level') {
      options.level = args[++i] || '';
    } else if (arg === '--id' || arg === '--uop-id') {
      options.id = args[++i];
    } else if (arg === '--from-org') {
      options.fromOrg = args[++i];
    } else if (arg === '--from-role') {
      options.fromRole = args[++i];
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
  options.targetId2 = positional[2] || null;
  return options;
}

function printHelp() {
  console.log(`
🛡️ Leo UC Modify Engine (UC 测试环境人员角色与组织两阶段安全变更引擎)

⚠️ 铁律：所有变更默认运行在 Pre-flight 预审模式（只读计算 Diff），必须在用户明确确认后追加 --confirm 才会真正执行写入！

使用格式:
  node scripts/uc_modify.js <subcommand> <target> [options] [--confirm]

支持子命令:
  add-pos <user> --org <org> --role <pos> [--level <lvl>]
      在测试环境给在职员工新增 UC 岗位角色 (对应 /memberMessage 详情弹窗 -> 角色设置 -> 新增角色)

  mod-pos <user> [--id <uopId>] --org <newOrg> --role <newRole> [--level <newLvl>]
      修改在职员工已配置的 UC 岗位角色 (不传 --id 时若仅有一条手动角色自动匹配，或通过 --from-org / --from-role 匹配)

  del-pos <user> [--id <uopId>] [--org <org>] [--role <pos>]
      🔴 [高危] 删除在职员工手动配置的 UC 岗位角色 (dataSource=5)

  bind-role <user> --role <roleCode>
      在关系配置中心为员工绑定业务角色 (/userRole/bindRoleForUser)

  unbind-role <user> --role <roleCode>
      🔴 [高危] 在关系配置中心解除员工的业务角色 (/userRole/disableRoleForUser)

  update-biz-mode <orgCode> <businessModeCode>
      修改组织树节点的业务模式 (GraphQL updateBusinessMode)

常用选项:
  --org <code|name>       目标组织编码或名称 (支持中文名称自动解析)
  --role <code|name>      目标业务角色/岗位编码或名称 (支持中文名称自动解析)
  --level <str>           角色职级 (可选)
  --id <uopId>            待修改或删除的记录 uopId
  --from-org <code>       修改/删除前匹配的组织编码
  --from-role <code>      修改/删除前匹配的角色编码
  --confirm               确认执行门禁 (未加此参数时仅做 Pre-flight Diff 预览)
  -e, --env <test>        目标环境 (默认: test，生产环境 prod 物理阻断写操作)
  --json                  输出纯 JSON 格式

示例:
  # 阶段 1: Pre-flight 预审 (展示 Diff 确认单，不实际写入)
  node scripts/uc_modify.js add-pos 26068546 --org XFTJ8001 --role 商圈经理

  # 阶段 2: 用户确认后正式写入并回查校验
  node scripts/uc_modify.js add-pos 26068546 --org XFTJ8001 --role 商圈经理 --confirm

  # 修改已有角色 (Pre-flight -> Confirm)
  node scripts/uc_modify.js mod-pos 26068546 --id 697424 --org LW1059 --role 12134
  node scripts/uc_modify.js mod-pos 26068546 --id 697424 --org LW1059 --role 12134 --confirm

  # 删除手动配置角色 (Pre-flight -> Confirm)
  node scripts/uc_modify.js del-pos 26068546 --id 697424
  node scripts/uc_modify.js del-pos 26068546 --id 697424 --confirm
`);
}

function printDisambiguation(query, candidates) {
  console.log(`\n⚠️ 检测到同名或多条匹配员工 "${query}" (共 ${candidates.length} 人)，请使用具体的 16位 UCID 或 8位系统号精确指定:\n`);
  console.table(candidates.map(c => ({
    'UCID': c.ucid,
    '系统号 (userCode)': c.userCode || '-',
    '姓名': c.name || '-',
    '所在组织': c.orgName ? `${c.orgName} (${c.orgCode || '-'})` : (c.orgCode || '-'),
    '状态': c.status === 1 ? '在职' : (c.status === 0 ? '离职' : '-')
  })));
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
    org,
    role,
    level,
    id,
    fromOrg,
    fromRole,
    confirm,
    json,
    cookie
  } = options;

  const envKey = normalizeEnv(env);

  try {
    // 物理拦截线上写操作
    assertUcWritePermitted(envKey);
    const hostInfo = getUcHost(envKey);
    const envTag = `🧪 测试环境 [${hostInfo.adminHost}]`;

    switch (command) {
      case 'add-pos': {
        if (!targetId || !org || !role) {
          console.error('❌ 用法错误: add-pos 需要指定 <user>、--org <组织编码或名称> 和 --role <角色编码或名称>');
          process.exit(1);
        }

        const resolvedUser = await resolveUcUser(targetId, { env: envKey, cookie });
        if (resolvedUser.notFound) {
          console.error(`❌ 未找到员工 "${targetId}"`);
          process.exit(1);
        }
        if (resolvedUser.ambiguous) {
          printDisambiguation(resolvedUser.query, resolvedUser.candidates);
          process.exit(1);
        }

        const [orgObj, posObj] = await Promise.all([
          resolveOrgCode(org, { status: 1, env: envKey, cookie }),
          resolvePositionCode(role, { env: envKey, cookie })
        ]);

        const customPositions = (resolvedUser.records || []).filter(r => r.dataSource === 5 && r.positionStatus === 1);
        const alreadyExists = customPositions.find(
          r => String(r.orgCode) === String(orgObj.orgCode) && String(r.positionCode) === String(posObj.positionCode)
        );

        const preflightReport = {
          mode: confirm ? 'COMMIT' : 'PREFLIGHT_DRY_RUN',
          action: 'addUserPosition',
          env: envKey,
          user: {
            ucid: resolvedUser.ucid,
            userCode: resolvedUser.userCode,
            name: resolvedUser.name,
            status: resolvedUser.status
          },
          existingCustomPositions: customPositions.map(p => ({
            uopId: p.uopId,
            orgCode: p.orgCode,
            orgName: p.orgName,
            positionCode: p.positionCode,
            positionName: p.positionName,
            level: p.level || ''
          })),
          targetAddition: {
            userCode: resolvedUser.userCode,
            orgCode: orgObj.orgCode,
            orgName: orgObj.orgName || orgObj.orgCode,
            positionCode: posObj.positionCode,
            positionName: posObj.positionName || posObj.positionCode,
            level: level || ''
          },
          alreadyExists: Boolean(alreadyExists),
          portalUrl: generateUcPortalUrl(envKey, '/memberMessage', {
            ucid: resolvedUser.ucid,
            userName: resolvedUser.name,
            userCode: resolvedUser.userCode
          })
        };

        if (!confirm) {
          if (json) {
            console.log(JSON.stringify(preflightReport, null, 2));
            return;
          }
          console.log(`\n📋 【测试环境 UC 角色新增预审单 (Pre-flight Dry-Run)】 (${envTag})`);
          console.log(`===================================================================`);
          console.log(`👤 目标员工:   ${resolvedUser.name} (系统号: ${resolvedUser.userCode}, UCID: ${resolvedUser.ucid}, 状态: ${resolvedUser.status === 1 ? '在职' : '离职'})`);
          if (resolvedUser.status !== 1) {
            console.log(`⚠️ 注意:       该员工当前状态非在职 (status=${resolvedUser.status})，UC 页面仅对在职人员开放角色设置！`);
          }
          console.log(`📂 当前手动角色 (${customPositions.length} 个):`);
          if (customPositions.length === 0) {
            console.log(`   (无手动配置角色)`);
          } else {
            customPositions.forEach(p => {
              console.log(`   • [uopId: ${p.uopId}] 组织: ${p.orgName || '-'}(${p.orgCode}) | 角色: ${p.positionName || '-'}(${p.positionCode}) | 职级: ${p.level || '-'}`);
            });
          }
          console.log(`\n➕ 拟新增角色配置 (Target Diff):`);
          console.log(`   + 所在组织: ${orgObj.orgName || '-'}(${orgObj.orgCode})`);
          console.log(`   + 业务角色: ${posObj.positionName || '-'}(${posObj.positionCode})`);
          console.log(`   + 角色职级: ${level || '(空)'}`);
          if (alreadyExists) {
            console.log(`   ⚠️ 提示: 该员工已存在相同组织+相同角色的记录 (uopId: ${alreadyExists.uopId})！`);
          }
          console.log(`🔗 页面直达:   ${preflightReport.portalUrl}`);
          console.log(`===================================================================`);
          console.log(`🛑 [等待用户确认] 请向用户展示以上变更预审单，用户明确确认后再追加 --confirm 执行写入。`);
          return;
        }

        const mutRes = await addUserPosition({
          userCode: resolvedUser.userCode,
          orgCode: orgObj.orgCode,
          positionCode: posObj.positionCode,
          level,
          env: envKey,
          cookie
        });

        const afterRecords = await getEhrUserVO(resolvedUser.ucid, { env: envKey, cookie });
        const afterCustom = afterRecords.filter(r => r.dataSource === 5 && r.positionStatus === 1);

        if (json) {
          console.log(JSON.stringify({
            ...preflightReport,
            result: mutRes,
            afterCustomPositions: afterCustom
          }, null, 2));
          return;
        }

        console.log(`\n✅ [提交成功] 已为 ${resolvedUser.name}(${resolvedUser.userCode}) 新增 UC 角色:`);
        console.log(`   服务端响应: ${mutRes || 'OK'}`);
        console.log(`\n🔍 回查最新生效的手动配置角色 (共 ${afterCustom.length} 个):`);
        console.table(afterCustom.map(p => ({
          'uopId': p.uopId,
          '组织名称(编码)': `${p.orgName || '-'}(${p.orgCode})`,
          '业务角色(编码)': `${p.positionName || '-'}(${p.positionCode})`,
          '职级': p.level || '-',
          '状态': p.positionStatus === 1 ? '有效' : '无效'
        })));
        break;
      }

      case 'mod-pos': {
        if (!targetId || !org || !role) {
          console.error('❌ 用法错误: mod-pos 需要指定 <user>、--org <新组织> 和 --role <新角色> (以及可选 --id <uopId>)');
          process.exit(1);
        }

        const resolvedUser = await resolveUcUser(targetId, { env: envKey, cookie });
        if (resolvedUser.notFound) {
          console.error(`❌ 未找到员工 "${targetId}"`);
          process.exit(1);
        }
        if (resolvedUser.ambiguous) {
          printDisambiguation(resolvedUser.query, resolvedUser.candidates);
          process.exit(1);
        }

        const customPositions = (resolvedUser.records || []).filter(r => r.dataSource === 5 && r.positionStatus === 1);
        let targetRecord = null;
        if (id) {
          targetRecord = customPositions.find(p => String(p.uopId) === String(id));
        } else if (fromOrg || fromRole) {
          targetRecord = customPositions.find(p =>
            (!fromOrg || String(p.orgCode) === String(fromOrg) || p.orgName === fromOrg) &&
            (!fromRole || String(p.positionCode) === String(fromRole) || p.positionName === fromRole)
          );
        } else if (customPositions.length === 1) {
          targetRecord = customPositions[0];
        }

        if (!targetRecord) {
          console.error(`❌ 无法唯一定位待修改的手动配置角色记录，请通过 --id <uopId> 指定。当前员工可修改的手动角色如下:`);
          console.table(customPositions.map(p => ({
            'uopId': p.uopId,
            '组织': `${p.orgName || '-'}(${p.orgCode})`,
            '角色': `${p.positionName || '-'}(${p.positionCode})`,
            '职级': p.level || '-'
          })));
          process.exit(1);
        }

        const [orgObj, posObj] = await Promise.all([
          resolveOrgCode(org, { status: 1, env: envKey, cookie }),
          resolvePositionCode(role, { env: envKey, cookie })
        ]);

        const newLevel = level !== '' ? level : (targetRecord.level || '');

        const preflightReport = {
          mode: confirm ? 'COMMIT' : 'PREFLIGHT_DRY_RUN',
          action: 'modifyUserPosition',
          env: envKey,
          user: {
            ucid: resolvedUser.ucid,
            userCode: resolvedUser.userCode,
            name: resolvedUser.name
          },
          before: {
            uopId: targetRecord.uopId,
            orgCode: targetRecord.orgCode,
            orgName: targetRecord.orgName,
            positionCode: targetRecord.positionCode,
            positionName: targetRecord.positionName,
            level: targetRecord.level || ''
          },
          after: {
            uopId: targetRecord.uopId,
            modifyOrgCode: orgObj.orgCode,
            modifyOrgName: orgObj.orgName || orgObj.orgCode,
            modifyPositionCode: posObj.positionCode,
            modifyPositionName: posObj.positionName || posObj.positionCode,
            modifyLevel: newLevel
          }
        };

        if (!confirm) {
          if (json) {
            console.log(JSON.stringify(preflightReport, null, 2));
            return;
          }
          console.log(`\n📋 【测试环境 UC 角色修改预审单 (Pre-flight Dry-Run)】 (${envTag})`);
          console.log(`===================================================================`);
          console.log(`👤 目标员工:   ${resolvedUser.name} (系统号: ${resolvedUser.userCode}, UCID: ${resolvedUser.ucid})`);
          console.log(`🔑 记录 uopId: ${targetRecord.uopId}`);
          console.log(`\n📊 变更前后对比 (Diff):`);
          console.log(`   - [变更前] 组织: ${targetRecord.orgName || '-'}(${targetRecord.orgCode}) | 角色: ${targetRecord.positionName || '-'}(${targetRecord.positionCode}) | 职级: ${targetRecord.level || '(空)'}`);
          console.log(`   + [变更后] 组织: ${orgObj.orgName || '-'}(${orgObj.orgCode}) | 角色: ${posObj.positionName || '-'}(${posObj.positionCode}) | 职级: ${newLevel || '(空)'}`);
          console.log(`===================================================================`);
          console.log(`🛑 [等待用户确认] 请向用户展示以上修改 Diff，用户明确确认后再追加 --confirm 执行提交。`);
          return;
        }

        const mutRes = await modifyUserPosition({
          id: targetRecord.uopId,
          userCode: resolvedUser.userCode,
          positionCode: targetRecord.positionCode,
          orgCode: targetRecord.orgCode,
          level: targetRecord.level || '',
          modifyPositionCode: posObj.positionCode,
          modifyOrgCode: orgObj.orgCode,
          modifyLevel: newLevel,
          env: envKey,
          cookie
        });

        const afterRecords = await getEhrUserVO(resolvedUser.ucid, { env: envKey, cookie });
        const afterCustom = afterRecords.filter(r => r.dataSource === 5 && r.positionStatus === 1);

        if (json) {
          console.log(JSON.stringify({ ...preflightReport, result: mutRes, afterCustomPositions: afterCustom }, null, 2));
          return;
        }

        console.log(`\n✅ [修改成功] 已更新 ${resolvedUser.name}(${resolvedUser.userCode}) 的 UC 角色 (uopId: ${targetRecord.uopId}):`);
        console.table(afterCustom.map(p => ({
          'uopId': p.uopId,
          '组织名称(编码)': `${p.orgName || '-'}(${p.orgCode})`,
          '业务角色(编码)': `${p.positionName || '-'}(${p.positionCode})`,
          '职级': p.level || '-'
        })));
        break;
      }

      case 'del-pos': {
        if (!targetId) {
          console.error('❌ 用法错误: del-pos 需要指定 <user> 以及 --id <uopId> (或 --org 与 --role)');
          process.exit(1);
        }

        const resolvedUser = await resolveUcUser(targetId, { env: envKey, cookie });
        if (resolvedUser.notFound) {
          console.error(`❌ 未找到员工 "${targetId}"`);
          process.exit(1);
        }
        if (resolvedUser.ambiguous) {
          printDisambiguation(resolvedUser.query, resolvedUser.candidates);
          process.exit(1);
        }

        const customPositions = (resolvedUser.records || []).filter(r => r.dataSource === 5 && r.positionStatus === 1);
        let targetRecord = null;
        if (id) {
          targetRecord = customPositions.find(p => String(p.uopId) === String(id));
        } else if (org || role || fromOrg || fromRole) {
          const matchOrg = org || fromOrg;
          const matchRole = role || fromRole;
          targetRecord = customPositions.find(p =>
            (!matchOrg || String(p.orgCode) === String(matchOrg) || p.orgName === matchOrg) &&
            (!matchRole || String(p.positionCode) === String(matchRole) || p.positionName === matchRole)
          );
        } else if (customPositions.length === 1) {
          targetRecord = customPositions[0];
        }

        if (!targetRecord) {
          console.error(`❌ 未定位到待删除的手动配置角色记录，请通过 --id <uopId> 指定。当前可删除的手动角色列表:`);
          console.table(customPositions.map(p => ({
            'uopId': p.uopId,
            '组织': `${p.orgName || '-'}(${p.orgCode})`,
            '角色': `${p.positionName || '-'}(${p.positionCode})`,
            '职级': p.level || '-'
          })));
          process.exit(1);
        }

        const preflightReport = {
          mode: confirm ? 'COMMIT' : 'PREFLIGHT_HIGH_RISK_DELETION',
          action: 'deleteUserPosition',
          env: envKey,
          user: {
            ucid: resolvedUser.ucid,
            userCode: resolvedUser.userCode,
            name: resolvedUser.name
          },
          targetDeletion: {
            uopId: targetRecord.uopId,
            orgCode: targetRecord.orgCode,
            orgName: targetRecord.orgName,
            positionCode: targetRecord.positionCode,
            positionName: targetRecord.positionName,
            level: targetRecord.level || ''
          }
        };

        if (!confirm) {
          if (json) {
            console.log(JSON.stringify(preflightReport, null, 2));
            return;
          }
          console.log(`\n🚨🚨🚨【高危操作预审报告 (HIGH RISK DELETION)】🚨🚨🚨`);
          console.log(`===================================================================`);
          console.log(`🌍 目标环境:   ${envTag}`);
          console.log(`👤 目标员工:   ${resolvedUser.name} (系统号: ${resolvedUser.userCode}, UCID: ${resolvedUser.ucid})`);
          console.log(`🗑️ 拟删除角色: [uopId: ${targetRecord.uopId}] 组织: ${targetRecord.orgName || '-'}(${targetRecord.orgCode}) | 角色: ${targetRecord.positionName || '-'}(${targetRecord.positionCode}) | 职级: ${targetRecord.level || '-'}`);
          console.log(`===================================================================`);
          console.log(`🛑 [强制阻断等待确认] 请向用户呈现以上删除预审单，获得用户明确“确认删除”指令后再追加 --confirm 执行！`);
          return;
        }

        const mutRes = await deleteUserPosition({
          userCode: resolvedUser.userCode,
          positionCode: targetRecord.positionCode,
          orgCode: targetRecord.orgCode,
          level: targetRecord.level || '',
          env: envKey,
          cookie
        });

        const afterRecords = await getEhrUserVO(resolvedUser.ucid, { env: envKey, cookie });
        const afterCustom = afterRecords.filter(r => r.dataSource === 5 && r.positionStatus === 1);

        if (json) {
          console.log(JSON.stringify({ ...preflightReport, result: mutRes, afterCustomPositions: afterCustom }, null, 2));
          return;
        }

        console.log(`\n✅ [删除成功] 已删除 ${resolvedUser.name}(${resolvedUser.userCode}) 的角色 [${targetRecord.positionName}(${targetRecord.positionCode}) @ ${targetRecord.orgCode}]`);
        console.log(`🔍 回查剩余手动配置角色: ${afterCustom.length} 个`);
        if (afterCustom.length > 0) {
          console.table(afterCustom.map(p => ({
            'uopId': p.uopId,
            '组织': `${p.orgName || '-'}(${p.orgCode})`,
            '角色': `${p.positionName || '-'}(${p.positionCode})`
          })));
        }
        break;
      }

      case 'bind-role':
      case 'unbind-role': {
        const isUnbind = command === 'unbind-role';
        const roleCode = role || targetId2;
        if (!targetId || !roleCode) {
          console.error(`❌ 用法错误: ${command} 需要指定 <user> 和 --role <roleCode>`);
          process.exit(1);
        }

        const resolvedUser = await resolveUcUser(targetId, { env: envKey, cookie });
        if (resolvedUser.notFound) {
          console.error(`❌ 未找到员工 "${targetId}"`);
          process.exit(1);
        }
        if (resolvedUser.ambiguous) {
          printDisambiguation(resolvedUser.query, resolvedUser.candidates);
          process.exit(1);
        }

        const currentRelRoles = await queryAllUserRoleByUserCode(resolvedUser.userCode, { env: envKey, cookie }).catch(() => []);
        const preflightReport = {
          mode: confirm ? 'COMMIT' : (isUnbind ? 'PREFLIGHT_HIGH_RISK_DELETION' : 'PREFLIGHT_DRY_RUN'),
          action: isUnbind ? 'disableRoleForUser' : 'bindRoleForUser',
          env: envKey,
          user: {
            ucid: resolvedUser.ucid,
            userCode: resolvedUser.userCode,
            name: resolvedUser.name
          },
          roleCode,
          currentRelationRoles: Array.isArray(currentRelRoles) ? currentRelRoles.map(r => ({
            roleCode: r.roleCode,
            roleName: r.roleName,
            roleType: r.roleType
          })) : []
        };

        if (!confirm) {
          if (json) {
            console.log(JSON.stringify(preflightReport, null, 2));
            return;
          }
          if (isUnbind) {
            console.log(`\n🚨🚨🚨【高危操作预审报告：关系中心角色解绑】🚨🚨🚨`);
          } else {
            console.log(`\n📋 【测试环境关系中心角色绑定预审单 (Pre-flight Dry-Run)】`);
          }
          console.log(`===================================================================`);
          console.log(`👤 目标员工:   ${resolvedUser.name} (系统号: ${resolvedUser.userCode}, UCID: ${resolvedUser.ucid})`);
          console.log(`🎭 目标角色码: ${roleCode} (${isUnbind ? '拟解除绑定' : '拟新增绑定'})`);
          console.log(`📂 当前已绑角色: ${(preflightReport.currentRelationRoles || []).map(r => `${r.roleName}(${r.roleCode})`).join('、') || '无'}`);
          console.log(`===================================================================`);
          console.log(`🛑 [等待用户确认] 请向用户展示以上预审信息，确认后再追加 --confirm 执行。`);
          return;
        }

        const res = isUnbind
          ? await disableRoleForUser({ userCode: resolvedUser.userCode, roleCode, env: envKey, cookie })
          : await bindRoleForUser({ roleCode, userCodes: [resolvedUser.userCode], env: envKey, cookie });

        const afterRelRoles = await queryAllUserRoleByUserCode(resolvedUser.userCode, { env: envKey, cookie }).catch(() => []);
        if (json) {
          console.log(JSON.stringify({ ...preflightReport, result: res, afterRelationRoles: afterRelRoles }, null, 2));
          return;
        }
        console.log(`\n✅ [${isUnbind ? '解绑' : '绑定'}成功] 已完成 ${resolvedUser.name}(${resolvedUser.userCode}) 角色 [${roleCode}] 操作！`);
        break;
      }

      case 'update-biz-mode': {
        const orgCode = targetId || org;
        const bizModeCode = targetId2 || role;
        if (!orgCode || !bizModeCode) {
          console.error('❌ 用法错误: update-biz-mode <orgCode> <businessModeCode> [--confirm]');
          process.exit(1);
        }

        const [nodeInfo, bizModes] = await Promise.all([
          getTreeNodeWithParentTreePath(orgCode, { status: 1, env: envKey, cookie }),
          getBusinessModeList({ env: envKey, cookie }).catch(() => [])
        ]);

        const targetMode = bizModes.find(b => b.businessModeCode === bizModeCode || b.businessModeName === bizModeCode) || {
          businessModeCode: bizModeCode,
          businessModeName: bizModeCode
        };

        const preflightReport = {
          mode: confirm ? 'COMMIT' : 'PREFLIGHT_DRY_RUN',
          action: 'updateBusinessMode',
          env: envKey,
          orgCode,
          orgName: nodeInfo?.orgName || orgCode,
          before: {
            businessModeCode: nodeInfo?.businessModeCode || null,
            businessModeName: nodeInfo?.businessModeName || null
          },
          after: targetMode
        };

        if (!confirm) {
          if (json) {
            console.log(JSON.stringify(preflightReport, null, 2));
            return;
          }
          console.log(`\n📋 【测试环境组织业务模式修改预审单 (Pre-flight Dry-Run)】 (${envTag})`);
          console.log(`   目标组织: [${orgCode}] ${nodeInfo?.orgName || '-'}`);
          console.log(`   - 变更前: ${nodeInfo?.businessModeName || '-'}(${nodeInfo?.businessModeCode || '-'})`);
          console.log(`   + 变更后: ${targetMode.businessModeName}(${targetMode.businessModeCode})`);
          console.log(`🛑 [等待用户确认] 请向用户展示以上修改 Diff，确认后再追加 --confirm 执行。`);
          return;
        }

        const res = await updateBusinessMode({
          orgCode,
          businessModeCode: targetMode.businessModeCode,
          env: envKey,
          cookie
        });

        const afterNode = await getTreeNodeWithParentTreePath(orgCode, { status: 1, env: envKey, cookie });
        if (json) {
          console.log(JSON.stringify({ ...preflightReport, result: res, afterNode }, null, 2));
          return;
        }
        console.log(`\n✅ [修改成功] 组织 [${orgCode}] 业务模式已更新为: ${afterNode?.businessModeName || targetMode.businessModeName}(${afterNode?.businessModeCode || targetMode.businessModeCode})`);
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
      console.error(`\n❌ 执行失败: ${err.message}`);
    }
    process.exit(1);
  }
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
