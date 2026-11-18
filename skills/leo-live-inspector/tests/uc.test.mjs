import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UC_HOSTS,
  normalizeEnv,
  getUcHost,
  generateUcPortalUrl,
  isUcAuthFailure,
  isUcSuccess,
  assertUcWritePermitted,
  formatGqlArgs,
  resolveCityCode,
  resolvePositionCode,
  resolveOrgCode,
  resolveUcUser,
  getUserFullProfile,
  getOrgFullDetail,
  addUserPosition,
  modifyUserPosition,
  deleteUserPosition
} from '../scripts/common/uc.js';
import { parseArgs as parseQueryArgs } from '../scripts/uc_query.js';
import { parseArgs as parseModifyArgs } from '../scripts/uc_modify.js';

test('UC Common - UC_HOSTS only configures test environment and rejects prod', () => {
  assert.ok(UC_HOSTS.test);
  assert.equal(UC_HOSTS.prod, undefined);
  assert.equal(normalizeEnv('test'), 'test');
  assert.equal(normalizeEnv('PROD'), 'prod');
  assert.equal(getUcHost('test').adminHost, 'test3-uc.admin.ke.com');
  assert.equal(getUcHost('test').relationHost, 'test-uc-relation-admin.ke.com');
  assert.throws(() => getUcHost('prod'), /暂未配置 \[prod\] 环境地址/);
  assert.throws(() => assertUcWritePermitted('prod'), /风控物理拦截/);
});

test('UC Common - generateUcPortalUrl formats query string properly', () => {
  const url = generateUcPortalUrl('test', '/memberMessage', {
    ucid: '1000000010138597',
    orgCode: 'XFTJ8001',
    empty: ''
  });
  assert.equal(url, 'http://test3-uc.admin.ke.com/memberMessage?ucid=1000000010138597&orgCode=XFTJ8001');
});

test('UC Common - isUcAuthFailure & isUcSuccess detect unauthenticated states', () => {
  // HTTP 302 to test-login.ke.com
  assert.equal(isUcAuthFailure({
    statusCode: 302,
    headers: { location: 'http://test-login.ke.com/login?service=http://test3-uc.admin.ke.com/login' }
  }), true);

  // HTTP 200 with code: 401 URL-encoded msg
  assert.equal(isUcAuthFailure({
    statusCode: 200,
    json: { code: 401, msg: '%E7%94%A8%E6%88%B7%E6%9C%AA%E7%99%BB%E9%99%86', path: '%2Fgraphql' }
  }), true);

  // Valid GraphQL response
  const validGql = {
    statusCode: 200,
    json: { data: { getAllUcCity: [{ cityCode: '110000' }] } }
  };
  assert.equal(isUcAuthFailure(validGql), false);
  assert.equal(isUcSuccess(validGql), true);

  // Valid Relation REST response
  const validRest = {
    statusCode: 200,
    json: { code: 0, data: { total: 1, list: [] } }
  };
  assert.equal(isUcAuthFailure(validRest), false);
  assert.equal(isUcSuccess(validRest), true);
});

test('UC Common - formatGqlArgs handles numbers, ucid, and strings', () => {
  const formatted = formatGqlArgs({
    pageNo: 1,
    pageSize: 20,
    userRecord: 0,
    ucid: '1000000010138597',
    userName: '马楠',
    orgCode: 'XFTJ8001',
    ignoredNull: null,
    ignoredEmpty: ''
  });
  assert.equal(
    formatted,
    'pageNo: 1, pageSize: 20, userRecord: 0, ucid: 1000000010138597, userName: "马楠", orgCode: "XFTJ8001"'
  );
});

test('UC Common - Smart resolvers (resolveCityCode, resolvePositionCode, resolveOrgCode)', async () => {
  const mockGql = async ({ query }) => {
    if (query.includes('getCitySug')) {
      return { getCitySug: [{ id: 1, cityCode: '110000', name: '北京', postCode: '010', status: 0 }] };
    }
    if (query.includes('getUcPositionByKeyword')) {
      return { getUcPositionByKeyword: [{ positionName: '商圈经理', positionCode: '765', description: '全国统一' }] };
    }
    if (query.includes('getOrgSug')) {
      return { getOrgSug: [{ orgCode: 'XFTJ8001', orgName: '运营管理' }] };
    }
    return {};
  };

  const cityDirect = await resolveCityCode('120000', { executeGql: mockGql });
  assert.equal(cityDirect.cityCode, '120000');

  const cityByName = await resolveCityCode('北京', { executeGql: mockGql });
  assert.equal(cityByName.cityCode, '110000');

  const posByName = await resolvePositionCode('商圈经理', { executeGql: mockGql });
  assert.equal(posByName.positionCode, '765');

  const orgDirect = await resolveOrgCode('XFTJ8001', { executeGql: mockGql });
  assert.equal(orgDirect.orgCode, 'XFTJ8001');

  const orgByName = await resolveOrgCode('运营管理', { executeGql: mockGql });
  assert.equal(orgByName.orgCode, 'XFTJ8001');
});

test('UC Common - resolveUcUser handles 16-digit UCID, 8-digit userCode, and homonym disambiguation', async () => {
  const mockRecords = [
    {
      id: '1000000010138597',
      userCode: '10138597',
      name: '马楠',
      status: 0,
      userRecord: 0,
      orgCode: 'XFTJ8001',
      orgName: '运营管理',
      positionCode: '12008',
      positionName: 'HRBP',
      dataSource: 0,
      positionStatus: 0
    }
  ];

  const mockGqlSingle = async ({ query }) => {
    if (query.includes('getEhrUserVO(')) {
      return { getEhrUserVO: mockRecords };
    }
    if (query.includes('getEhrUserVOByPage(')) {
      return { getEhrUserVOByPage: { total: 1, list: mockRecords } };
    }
    return { getUserSug: [] };
  };

  // 16-digit UCID
  const byUcid = await resolveUcUser('1000000010138597', { executeGql: mockGqlSingle });
  assert.equal(byUcid.matched, true);
  assert.equal(byUcid.userCode, '10138597');

  // 8-digit userCode
  const byCode = await resolveUcUser('10138597', { executeGql: mockGqlSingle });
  assert.equal(byCode.matched, true);
  assert.equal(byCode.ucid, '1000000010138597');

  // Homonym disambiguation for name "张伟"
  const mockGqlAmbiguous = async ({ query }) => {
    if (query.includes('getEhrUserVOByPage(')) {
      return {
        getEhrUserVOByPage: {
          total: 2,
          list: [
            { id: 1000000010000001, userCode: '10000001', name: '张伟', orgName: '组织A', orgCode: 'ORGA', status: 1 },
            { id: 1000000010000002, userCode: '10000002', name: '张伟', orgName: '组织B', orgCode: 'ORGB', status: 1 }
          ]
        }
      };
    }
    return { getUserSug: [] };
  };

  const byAmbiguousName = await resolveUcUser('张伟', { executeGql: mockGqlAmbiguous });
  assert.equal(byAmbiguousName.ambiguous, true);
  assert.equal(byAmbiguousName.candidates.length, 2);
});

test('UC Common - getUserFullProfile aggregates GraphQL and Relation REST APIs', async () => {
  const mockGql = async ({ query }) => {
    if (query.includes('getEhrUserVO(')) {
      return {
        getEhrUserVO: [
          {
            id: '1000000026068546',
            userCode: '26068546',
            name: '刘泓',
            status: 1,
            userRecord: 0,
            orgCode: 'LW1059',
            orgName: '平台Office',
            positionCode: '12134',
            positionName: '高级主管',
            positionStatus: 1,
            dataSource: 0
          },
          {
            id: '1000000026068546',
            userCode: '26068546',
            name: '刘泓',
            status: 1,
            userRecord: 1,
            orgCode: 'XFTJ8001',
            orgName: '运营管理',
            positionCode: '765',
            positionName: '商圈经理',
            positionStatus: 1,
            dataSource: 5,
            uopId: '998877',
            level: 'P6'
          }
        ]
      };
    }
    if (query.includes('getEhrUserEventQueueListByUcid')) {
      return {
        getEhrUserEventQueueListByUcid: [
          { id: '1', createTime: '2026-01-01 10:00:00', eventReason: 'PJA', eventReasonName: '增加兼职', positionName: '商圈经理', positionCode: '765', orgName: '运营管理', orgCode: 'XFTJ8001' }
        ]
      };
    }
    return {};
  };

  const mockRel = async ({ path }) => {
    if (path === '/relation/queryAllUserRoleByUserCode') {
      return [{ roleName: '商圈经理', roleCode: '765', roleType: 0, relationList: [{ name: '测试店A', code: 'ORG_A' }] }];
    }
    if (path === '/userRole/queryRoleForUser') {
      return { roleList: [{ roleCode: '765', roleName: '商圈经理', sourceName: '通用人员管理' }] };
    }
    return {};
  };

  const profile = await getUserFullProfile('1000000026068546', {
    executeGql: mockGql,
    executeRel: mockRel
  });

  assert.equal(profile.matched, true);
  assert.equal(profile.userCode, '26068546');
  assert.equal(profile.allPositions.length, 2);
  assert.equal(profile.customUcPositions.length, 1);
  assert.equal(profile.customUcPositions[0].uopId, '998877');
  assert.equal(profile.relationRoles.length, 1);
  assert.equal(profile.events.length, 1);
});

test('UC Common - getOrgFullDetail aggregates org info, tree path, children and active users', async () => {
  const mockGql = async ({ query }) => {
    if (query.includes('getEhrOrgBasicVOByPage')) {
      return { getEhrOrgBasicVOByPage: { total: 1, list: [{ orgCode: 'XFTJ8001', shortName: '运营管理', status: 1, orgType: 5 }] } };
    }
    if (query.includes('getEhrOrgVO')) {
      return { getEhrOrgVO: { shortName: '运营管理', fullPathName: '贝壳/天津/运营管理', directorName: '朱建新', directorUserCode: '10002058' } };
    }
    if (query.includes('getTreeNodeWithParentTreePath')) {
      return { getTreeNodeWithParentTreePath: { orgCode: 'XFTJ8001', orgName: '运营管理', parentNodePath: [{ orgCode: 'JT0001', orgName: '集团' }] } };
    }
    if (query.includes('getChildNodes')) {
      return { getChildNodes: [{ orgCode: 'XFTJ8002', orgName: '运营一组', isLeaf: 1 }] };
    }
    if (query.includes('getEhrOrgEventQueueListByOrgCode')) {
      return { getEhrOrgEventQueueListByOrgCode: [] };
    }
    if (query.includes('getEhrUserVOByPage')) {
      return { getEhrUserVOByPage: { total: 1, list: [{ id: 1000000010138597, userCode: '10138597', name: '马楠' }] } };
    }
    return {};
  };

  const detail = await getOrgFullDetail('XFTJ8001', {
    executeGql: mockGql,
    executeRel: async () => null
  });

  assert.equal(detail.orgCode, 'XFTJ8001');
  assert.equal(detail.shortName, '运营管理');
  assert.equal(detail.ehrOrg.directorName, '朱建新');
  assert.equal(detail.childNodes.length, 1);
  assert.equal(detail.activeUsers.total, 1);
});

test('UC Mutations - addUserPosition, modifyUserPosition, deleteUserPosition send expected GraphQL variables', async () => {
  const calls = [];
  const mockGql = async (opts) => {
    calls.push(opts);
    return {
      addUserPosition: 'success',
      modifyUserPosition: 'modified',
      deleteUserPosition: 'deleted'
    };
  };

  const addRes = await addUserPosition({
    userCode: '26068546',
    positionCode: '765',
    orgCode: 'XFTJ8001',
    level: 'P6',
    env: 'test',
    executeGql: mockGql
  });
  assert.equal(addRes, 'success');
  assert.equal(calls[0].isReadOnly, false);
  assert.deepEqual(calls[0].variables.addUserPositionRO, {
    userCode: '26068546',
    positionCode: '765',
    orgCode: 'XFTJ8001',
    level: 'P6'
  });

  const modRes = await modifyUserPosition({
    id: '697424',
    userCode: '26068546',
    positionCode: '765',
    orgCode: 'XFTJ8001',
    level: 'P6',
    modifyPositionCode: '12134',
    modifyOrgCode: 'LW1059',
    modifyLevel: 'P7',
    env: 'test',
    executeGql: mockGql
  });
  assert.equal(modRes, 'modified');
  assert.equal(calls[1].variables.modifyUserPositionRO.id, '697424');
  assert.equal(calls[1].variables.modifyUserPositionRO.modifyOrgCode, 'LW1059');

  const delRes = await deleteUserPosition({
    userCode: '26068546',
    positionCode: '12134',
    orgCode: 'LW1059',
    env: 'test',
    executeGql: mockGql
  });
  assert.equal(delRes, 'deleted');
});

test('UC CLI arg parsers - parseQueryArgs and parseModifyArgs', () => {
  const qOpts = parseQueryArgs(['users', '--city', '北京', '--role', '商圈经理', '--status', '在职', '--record', '主岗', '-n', '10']);
  assert.equal(qOpts.command, 'users');
  assert.equal(qOpts.city, '北京');
  assert.equal(qOpts.role, '商圈经理');
  assert.equal(qOpts.status, 1);
  assert.equal(qOpts.record, 0);
  assert.equal(qOpts.pageSize, 10);

  const mOpts = parseModifyArgs(['add-pos', '26068546', '--org', 'XFTJ8001', '--role', '765', '--confirm']);
  assert.equal(mOpts.command, 'add-pos');
  assert.equal(mOpts.targetId, '26068546');
  assert.equal(mOpts.org, 'XFTJ8001');
  assert.equal(mOpts.role, '765');
  assert.equal(mOpts.confirm, true);
});
