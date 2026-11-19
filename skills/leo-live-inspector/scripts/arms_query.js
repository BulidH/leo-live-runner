#!/usr/bin/env node

/**
 * 🗼 Leo Live Inspector - 灯塔 ARMS 前端监控与排障引擎 (ARMS Frontend Query Engine)
 *
 * 核心能力：
 *   1. 双轨鉴权（优先 x-api-key，无缝回退 Chrome Cookie 自动中继）；
 *   2. 免登录项目自动发现（Git 仓库 / 域名 / 项目名 / ID -> 自动缓存本地 arms_projects.json）；
 *   3. 自定义条件日志检索与聚合 (queryData: logs)；
 *   4. 运行时 / 资源加载 / 白屏异常聚合榜与详情 (errors)；
 *   5. ViewId 单次访问全链路时序回溯 (trace)；
 *   6. 页面性能 Web Vitals、API 请求耗时/失败率、PV/UV 与项目健康分 (overview / perf / api / pvuv)。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listArmsProjects,
  resolveArmsProject,
  queryArmsLogs,
  getArmsErrorsSummary,
  traceArmsViewId,
  getArmsOverview,
  getArmsPerformance,
  getArmsApiMetrics,
  getArmsPvuv,
  saveArmsApiKey,
  saveArmsCookie
} from './common/arms.js';

const SUBCOMMANDS = new Set([
  'projects',
  'overview',
  'logs',
  'errors',
  'trace',
  'perf',
  'api',
  'pvuv',
  'help'
]);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: null,
    project: null,
    keyword: null,
    viewId: null,
    errorId: null,
    time: '2h',
    from: null,
    to: null,
    dataType: 'error',
    env: 'production',
    query: null,
    pageType: null,
    url: null,
    errorType: null,
    ucid: null,
    ip: null,
    os: null,
    browser: null,
    device: null,
    isp: null,
    province: null,
    city: null,
    filters: [],
    aggs: 'no',
    kind: 'all',
    sourceType: '',
    metric: 'LCP',
    days: 7,
    projectType: 'h5',
    failedOnly: false,
    minSpent: 0,
    size: 20,
    page: 1,
    slim: false,
    refresh: false,
    apiKey: null,
    setApiKey: null,
    cookie: null,
    setCookie: null,
    useCookie: false,
    json: false,
    help: false
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--slim') {
      options.slim = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--failed-only') {
      options.failedOnly = true;
    } else if (arg === '--use-cookie') {
      options.useCookie = true;
    } else if (arg === '-p' || arg === '--project') {
      options.project = argv[++i];
    } else if (arg === '-q' || arg === '--query') {
      options.query = argv[++i];
    } else if (arg === '-t' || arg === '--time') {
      options.time = argv[++i];
    } else if (arg === '--from') {
      options.from = argv[++i];
    } else if (arg === '--to') {
      options.to = argv[++i];
    } else if (arg === '--type' || arg === '--data-type') {
      options.dataType = argv[++i];
    } else if (arg === '-e' || arg === '--env') {
      options.env = argv[++i];
    } else if (arg === '--page-type') {
      options.pageType = argv[++i];
    } else if (arg === '-u' || arg === '--url') {
      options.url = argv[++i];
    } else if (arg === '--error-type') {
      options.errorType = argv[++i];
    } else if (arg === '--error-id') {
      options.errorId = argv[++i];
    } else if (arg === '--ucid') {
      options.ucid = argv[++i];
    } else if (arg === '--ip') {
      options.ip = argv[++i];
    } else if (arg === '--os') {
      options.os = argv[++i];
    } else if (arg === '--browser') {
      options.browser = argv[++i];
    } else if (arg === '--device') {
      options.device = argv[++i];
    } else if (arg === '--isp') {
      options.isp = argv[++i];
    } else if (arg === '--province') {
      options.province = argv[++i];
    } else if (arg === '--city') {
      options.city = argv[++i];
    } else if (arg === '-f' || arg === '--filter') {
      options.filters.push(argv[++i]);
    } else if (arg === '--aggs') {
      options.aggs = argv[++i];
    } else if (arg === '--kind') {
      options.kind = argv[++i];
    } else if (arg === '--source-type') {
      options.sourceType = argv[++i];
    } else if (arg === '--vid' || arg === '--view-id') {
      options.viewId = argv[++i];
    } else if (arg === '--metric') {
      options.metric = argv[++i];
    } else if (arg === '--days') {
      options.days = parseInt(argv[++i], 10) || 7;
    } else if (arg === '--project-type') {
      options.projectType = argv[++i];
    } else if (arg === '--min-spent') {
      options.minSpent = parseInt(argv[++i], 10) || 0;
    } else if (arg === '-n' || arg === '--size' || arg === '--limit') {
      options.size = parseInt(argv[++i], 10) || 20;
    } else if (arg === '--page') {
      options.page = parseInt(argv[++i], 10) || 1;
    } else if (arg === '--api-key') {
      options.apiKey = argv[++i];
    } else if (arg === '--set-api-key') {
      options.setApiKey = argv[++i];
    } else if (arg === '--cookie') {
      options.cookie = argv[++i];
    } else if (arg === '--set-cookie') {
      options.setCookie = argv[++i];
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional[0] && SUBCOMMANDS.has(positional[0])) {
    options.command = positional[0];
    if (options.command === 'projects') {
      options.keyword = positional[1] || options.query || null;
    } else if (options.command === 'trace') {
      if (positional[1] && positional[2]) {
        options.project = options.project || positional[1];
        options.viewId = options.viewId || positional[2];
      } else if (positional[1]) {
        if (/^\d+$/.test(positional[1]) && options.viewId) {
          options.project = options.project || positional[1];
        } else if (options.project) {
          options.viewId = options.viewId || positional[1];
        } else {
          options.viewId = positional[1];
        }
      }
    } else if (positional[1]) {
      options.project = options.project || positional[1];
    }
  } else if (positional.length > 0) {
    options.command = 'logs';
    options.project = options.project || positional[0];
  } else {
    options.command = 'help';
  }

  return options;
}

function printHelp() {
  console.log(`
🗼 Leo ARMS Frontend Query Engine (灯塔前端监控与全链路排障引擎)

使用格式:
  node scripts/arms_query.js <subcommand> [project] [options]

核心子命令:
  projects [keyword]            列出或搜索灯塔前端项目 (免登录，自动缓存)
  overview [project]            查看项目健康分、质量/体验分、PV/UV、TTFB 与错误率
  logs [project]                自定义条件检索与聚合日志 (对应 queryData)
  errors [project]              运行时异常、资源加载异常与白屏异常 TOP 榜
  trace [project] <viewId>      按 viewId 还原单次访问全链路时间线 (PV/性能/API/报错)
  perf [project]                查看 Core Web Vitals (LCP/INP/CLS/TTFB/FCP/TBT) 与分位趋势
  api [project]                 查看 API 接口成功率、平均耗时与慢请求/失败明细
  pvuv [project]                查看项目页面 PV/UV 排行

常用选项:
  -p, --project <id|name|git>   项目 ID / 英文标识 / 中文名 / Git 仓库名 (默认自动探测当前仓库)
  -q, --query <keyword>         日志检索关键词 (logs 中匹配异常/上报内容)
  -t, --time <range>            时间范围 (如 15m, 1h, 2h, 24h, 3d, 7d, today; logs 默认 2h)
      --from / --to             起止时间 (如 '2026-11-19 10:00')
      --type <error|pvuv|perf|custom>  数据类型 (默认 error)
  -e, --env <prod|test>         环境 (默认 prod)
      --page-type <str>         按 PageType 精确筛选
  -u, --url <str>               按页面 URL / API URL 包含筛选
      --error-type <str>        按异常类型筛选 (如 页面报错_CONSOLE_ERROR)
      --error-id <id>           errors 子命令下查看指定异常的原始采样详情
      --ucid / --ip / --os / --browser / --device / --isp / --province / --city
  -f, --filter <expr>           通用筛选条件 (可多次传入，如 extra~TRTC 或 common.ucid=123)
      --aggs <dim>              聚合维度 (如 errorType, pageType, url, ucid, os, browser, version)
      --kind <all|runtime|resource|white-screen>  errors 类别 (默认 all)
      --source-type <script|img|css|other>        resource 异常资源类型
      --vid <viewId>            trace 子命令指定 viewId
      --metric <LCP|INP|CLS|TBT|TTFB|FCP>         perf 子命令指定指标
      --failed-only             api 子命令仅保留存在失败的接口或状态码异常日志
      --min-spent <ms>          api 子命令过滤耗时 >= ms
  -n, --size <num>              返回条数 (默认 20)
      --page <num>              页码 (默认 1)
      --slim                    精简超长 URL 与堆栈文本
      --refresh                 强制刷新项目列表缓存
      --api-key / --set-api-key <key>   指定或持久化保存 x-api-key
      --cookie / --set-cookie <str>     指定或持久化保存灯塔 Cookie
      --use-cookie              跳过本地 api-key，强制走 Chrome Cookie 中继
      --json                    输出结构化 JSON

示例:
  node scripts/arms_query.js projects intelligentize
  node scripts/arms_query.js logs life-fe-intelligentize -q "TRTC SDK初始化失败" -t today
  node scripts/arms_query.js logs 1737 -q "TRTC" --aggs pageType -t today
  node scripts/arms_query.js errors 1737 --kind all
  node scripts/arms_query.js trace 1737 2w4360jic43mwmzff5g
  node scripts/arms_query.js api 1737 --failed-only -t 24h
  node scripts/arms_query.js perf 1737 --metric LCP --days 7
`);
}

function projectHeader(project, extra = '') {
  const id = project.project_id ?? project.id ?? '';
  const name = project.display_name || project.project_name || '';
  const slug = project.project_name ? ` (${project.project_name})` : '';
  return `🗼 项目 [${id}] ${name}${slug}${extra ? ` | ${extra}` : ''}`;
}

function renderProjects(list, keyword) {
  let rows = list;
  if (keyword) {
    const q = keyword.toLowerCase();
    rows = list.filter(p =>
      String(p.project_id).includes(q) ||
      String(p.project_name || '').toLowerCase().includes(q) ||
      String(p.display_name || '').toLowerCase().includes(q) ||
      String(p.git_url || '').toLowerCase().includes(q) ||
      String(p.home_page || '').toLowerCase().includes(q)
    );
  }
  console.log(`\n🗼 灯塔项目列表 (共匹配 ${rows.length} / 总计 ${list.length} 个):`);
  for (const p of rows.slice(0, 30)) {
    console.log(`- [${p.project_id}] ${p.display_name || '-'} (${p.project_name}) | ${p.project_type || '-'} | ${p.home_page || '-'} | ${p.git_url || '-'}`);
  }
  if (rows.length > 30) {
    console.log(`... 仅展示前 30 条，可使用关键词进一步缩小范围`);
  }
}

function renderOverview(project, data) {
  console.log(`\n${projectHeader(project, `鉴权: ${data.authUsed}`)}`);
  if (data.overview?.alarm) {
    const a = data.overview.alarm;
    console.log(`📊 今日概况 (${data.overview.time_range?.start_time || ''} ~ ${data.overview.time_range?.end_time || ''}):`);
    console.log(`   PV: ${a.total_pv ?? '-'} | 报警数: ${a.total ?? '-'} | 异常类数: ${a.err_total ?? '-'} | 异常率: ${a.error_rate ?? '-'}%`);
    if (Array.isArray(a.page_list) && a.page_list.length) {
      console.log(`   涉及页面: ${a.page_list.join(', ')}`);
    }
  }
  if (data.healthScore) {
    const h = data.healthScore;
    console.log(`💚 健康评分 (${data.date}): 总分 ${h.score ?? '-'} | 质量分 ${h.error?.score ?? '-'} | 体验分 ${h.perf?.score ?? '-'}`);
    console.log(`   UV: ${h.uv_total_count ?? '-'} | PV: ${h.pv_total_count ?? '-'} | 异常PV比: ${h.error_ratio ?? '-'} | TTFB: ${h.ttfb_avg ?? '-'}ms | 接口平均耗时: ${h.slow_api_avg ?? '-'}ms`);
    for (const m of [...(h.error?.measures || []), ...(h.perf?.measures || [])]) {
      console.log(`   - ${m.title}: ${m.value} (得分 ${m.score})`);
    }
  }
}

function renderLogs(project, res) {
  console.log(`\n${projectHeader(project, `窗口: ${res.timeRange.start} ~ ${res.timeRange.end} | 鉴权: ${res.authUsed}`)}`);
  console.log(`📋 命中总条数: ${res.total} | 聚合模式: ${res.aggs}${res.totalUv ? ` | 影响UV: ${res.totalUv}` : ''}`);
  if (res.aggs !== 'no') {
    for (const row of res.records) {
      console.log(`- [${row.count} 次 | ${row.countPer || '-'}% | UV:${row.uv ?? '-'}] ${row.key}`);
    }
    return;
  }
  for (const r of res.records) {
    console.log(`\n[${r.time}] ${r.errorType || r.type} | PageType: ${r.pageType || '-'}`);
    console.log(`  内容: ${r.desc || '-'}`);
    if (r.stack && r.stack !== r.desc) console.log(`  堆栈: ${r.stack.replace(/\s+/g, ' ').slice(0, 260)}`);
    console.log(`  viewId: ${r.viewId || '-'} | ucid: ${r.ucid || '-'} | 终端: ${r.os} / ${r.browser} / ${r.device} | 地域: ${r.region} (${r.isp || '-'})`);
    if (r.url) console.log(`  URL: ${r.url}`);
  }
}

function renderErrors(project, res) {
  console.log(`\n${projectHeader(project, `环境: ${res.env} | 鉴权: ${res.authUsed}`)}`);
  if (res.errorDetail) {
    console.log(`🔎 异常采样明细 (共 ${res.errorDetail.list?.length ?? 0} 条):`);
    for (const item of (res.errorDetail.list || []).slice(0, 5)) {
      const n = normalizeLogForDetail(item);
      console.log(`- [${n.time}] viewId=${n.viewId} ucid=${n.ucid} ${n.os} ${n.browser} (${n.isp}) | ${n.desc}`);
      if (n.url) console.log(`  URL: ${n.url}`);
    }
    return;
  }
  if (res.runtime) {
    const ov = res.runtime.overview;
    console.log(`\n🚨 运行时/控制台异常概览: 总次数 ${ov.todayTotal ?? '-'} | 影响PV ${ov.todayPv ?? '-'} (${ov.todayPvPercent ?? '-'}%) | 影响UV ${ov.todayUv ?? '-'} (${ov.todayUvPercent ?? '-'}%)`);
    for (const t of res.runtime.byType) {
      console.log(`   - ${t.key}: ${t.doc_count}`);
    }
    for (const group of res.runtime.topByCategory) {
      if (!group.items.length) continue;
      console.log(`\n  ▸ ${group.errorType} TOP:`);
      for (const item of group.items.slice(0, 10)) {
        console.log(`    • [${item.count}次 / ${item.uv}人 | 最近 ${item.lastTime}] ${item.describe || item.errorId}`);
      }
    }
  }
  if (res.resource) {
    console.log(`\n📦 资源加载异常: 今日总计 ${res.resource.total} 次 | 影响页面 ${res.resource.pvTotal} | 影响用户 ${res.resource.uvTotal}`);
    for (const item of res.resource.list.slice(0, 15)) {
      console.log(`  • [${item.count}次 / ${item.uvNum}人 / ${item.pageNum}页] ${item.url}`);
    }
  }
  if (res.whiteScreen) {
    console.log(`\n⬜ 白屏异常 (共 ${res.whiteScreen.total} 条):`);
    for (const item of res.whiteScreen.list.slice(0, 10)) {
      console.log(`  • [${item.time}] 原因:${item.reason} | 挂载:${item.loadTimeMs}ms | viewId:${item.viewId} | ${item.url}`);
    }
  }
}

function normalizeLogForDetail(item) {
  let desc = '';
  try {
    desc = typeof item.extra === 'string' ? JSON.parse(item.extra).desc : (item.extra?.desc || '');
  } catch {
    desc = String(item.extra || '');
  }
  return {
    time: item.time_ms || item.time || '',
    viewId: item.viewId || '',
    ucid: item.common?.ucid || '',
    os: item.ua?.os ? `${item.ua.os.name}-${item.ua.os.version}` : '',
    browser: item.ua?.browser ? `${item.ua.browser.name}-${item.ua.browser.version}` : '',
    isp: item.common?.isp || '',
    url: item.detail?.url || '',
    desc
  };
}

function renderTrace(project, res) {
  const m = res.meta;
  console.log(`\n${projectHeader(project, `ViewId 链路追踪 | 鉴权: ${res.authUsed}`)}`);
  console.log(`🧭 ViewId: ${m.viewId} | UUID: ${m.uuid || '-'} | UCID: ${m.ucid || '-'}`);
  console.log(`📱 终端: ${m.os} / ${m.browser} / ${m.device} | 地域: ${m.region} (${m.isp || '-'}) | IP: ${m.ip || '-'}`);
  console.log(`🔗 入口 URL: ${m.url || '-'}`);
  console.log(`⏱️ 事件总数: ${res.rawCount} (去重合并后 ${res.events.length} 步) | 异常事件: ${res.errors.length} | 慢/失败API: ${res.slowOrFailedApis.length}\n`);

  for (const ev of res.events) {
    const rep = ev.repeatCount > 1 ? ` (x${ev.repeatCount})` : '';
    const tag = ev.type === 'error' ? '❌' : (ev.httpCode === 0 || (ev.httpCode && ev.httpCode >= 400) ? '🔴' : '•');
    const summaryParts = [ev.type, ev.subType, ev.desc, ev.url].filter(Boolean);
    const metrics = [];
    if (ev.httpCode !== null && ev.httpCode !== undefined && ev.url) metrics.push(`status=${ev.httpCode}`);
    if (ev.duringMs) metrics.push(`spent=${ev.duringMs}ms`);
    else if (ev.value && !ev.desc) metrics.push(`val=${ev.value}`);
    console.log(`${tag} [${ev.time}]${rep} ${summaryParts.join(' | ')}${metrics.length ? ` (${metrics.join(', ')})` : ''}`);
  }
}

function renderPerf(project, res) {
  console.log(`\n${projectHeader(project, `指标: ${res.metric} | 环境: ${res.env} | 鉴权: ${res.authUsed}`)}`);
  const s = res.summary;
  console.log(`⚡ 全局均值: PV=${s.pvTotalCount ?? '-'} UV=${s.uvTotalCount ?? '-'} | LCP=${s.lcpAvg ?? '-'}ms FCP=${s.fcpAvg ?? '-'}ms TTFB=${s.ttfbAvg ?? '-'}ms TBT=${s.tbtAvg ?? '-'}ms CLS=${s.clsAvg ?? '-'} INP=${s.inpAvg ?? '-'}ms`);
  if (res.per75Trend.length) {
    console.log(`\n📈 ${res.metric} P75 日趋势:`);
    for (const d of res.per75Trend.slice(-10)) {
      const valKey = Object.keys(d).find(k => k.endsWith('_avg'));
      console.log(`  • ${d.count_at_time}: ${valKey ? d[valKey] : '-'}`);
    }
  }
  if (res.topPages.length) {
    console.log(`\n📄 页面 ${res.metric} 分位排行 (TOP ${res.topPages.length}):`);
    for (const p of res.topPages) {
      console.log(`  • PV:${p.pv} UV:${p.uv} | P50=${p.p50 ? Number(p.p50).toFixed(1) : '-'} P75=${p.p75 ? Number(p.p75).toFixed(1) : '-'} P90=${p.p90 ? Number(p.p90).toFixed(1) : '-'} | ${p.pageType}`);
    }
  }
}

function renderApiMetrics(project, res) {
  console.log(`\n${projectHeader(project, `API 监控 (${res.timeRange.start} ~ ${res.timeRange.end}) | 鉴权: ${res.authUsed}`)}`);
  console.log(`🌐 接口分布 (展示 ${res.distribution.length} 条):`);
  for (const d of res.distribution.slice(0, 20)) {
    console.log(`  • [请求:${d.count} 失败:${d.failedCount} 成功率:${d.successPercent}% 均耗:${Math.round(Number(d.spent || 0))}ms] ${d.url}`);
  }
  if (res.rawLogs.length) {
    console.log(`\n📜 原始请求日志 (总 ${res.rawTotal} 条，展示 ${res.rawLogs.length} 条):`);
    for (const r of res.rawLogs.slice(0, 15)) {
      console.log(`  • [${r.time}] HTTP ${r.httpCode} (${r.duringMs}ms) | viewId:${r.viewId} | ${r.apiUrl}`);
    }
  }
}

function renderPvuv(project, res) {
  console.log(`\n${projectHeader(project, `周期: ${res.startAt} ~ ${res.endAt} | 鉴权: ${res.authUsed}`)}`);
  for (const p of res.pages) {
    console.log(`  • PV:${p.count} UV:${p.uv} | ${p.key}`);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.setApiKey) {
    const ok = saveArmsApiKey(opts.setApiKey);
    if (!ok) {
      console.error('❌ 保存 ARMS API Key 失败');
      process.exit(1);
    }
    console.log('✅ 已保存 ARMS x-api-key 至 ~/.shrimp/skills/live-inspector/arms_api_key.json');
    if (opts.command === 'help') return;
  }

  if (opts.setCookie) {
    const ok = saveArmsCookie(opts.setCookie);
    if (!ok) {
      console.error('❌ 保存 ARMS Cookie 失败');
      process.exit(1);
    }
    console.log('✅ 已保存 ARMS Cookie 至 ~/.shrimp/skills/live-inspector/arms_cookie.json');
    if (opts.command === 'help') return;
  }

  if (opts.help || opts.command === 'help') {
    printHelp();
    return;
  }

  const authOpts = {
    apiKey: opts.apiKey,
    cookie: opts.cookie,
    useCookie: opts.useCookie
  };

  if (opts.command === 'projects') {
    const list = await listArmsProjects({ refresh: opts.refresh });
    if (opts.json) {
      const q = (opts.keyword || '').toLowerCase();
      const filtered = q
        ? list.filter(p =>
            String(p.project_id).includes(q) ||
            String(p.project_name || '').toLowerCase().includes(q) ||
            String(p.display_name || '').toLowerCase().includes(q) ||
            String(p.git_url || '').toLowerCase().includes(q)
          )
        : list;
      console.log(JSON.stringify({ total: filtered.length, list: filtered }, null, 2));
      return;
    }
    renderProjects(list, opts.keyword);
    return;
  }

  const project = await resolveArmsProject(opts.project, { refresh: opts.refresh });
  const projectId = project.project_id;

  if (opts.command === 'overview') {
    const data = await getArmsOverview(projectId, { projectType: opts.projectType, ...authOpts });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderOverview(project, data);
    return;
  }

  if (opts.command === 'logs') {
    const data = await queryArmsLogs(projectId, {
      time: opts.time,
      from: opts.from,
      to: opts.to,
      dataType: opts.dataType,
      env: opts.env,
      query: opts.query,
      pageType: opts.pageType,
      url: opts.url,
      errorType: opts.errorType,
      ucid: opts.ucid,
      ip: opts.ip,
      os: opts.os,
      browser: opts.browser,
      device: opts.device,
      isp: opts.isp,
      province: opts.province,
      city: opts.city,
      filters: opts.filters,
      aggs: opts.aggs,
      size: opts.size,
      page: opts.page,
      slim: opts.slim,
      ...authOpts
    });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderLogs(project, data);
    return;
  }

  if (opts.command === 'errors') {
    const data = await getArmsErrorsSummary(projectId, {
      env: opts.env,
      kind: opts.kind,
      errorId: opts.errorId,
      sourceType: opts.sourceType,
      page: opts.page,
      size: opts.size,
      time: opts.time === '2h' ? '3d' : opts.time,
      from: opts.from,
      to: opts.to,
      ...authOpts
    });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderErrors(project, data);
    return;
  }

  if (opts.command === 'trace') {
    const data = await traceArmsViewId(projectId, {
      viewId: opts.viewId,
      time: opts.time === '2h' ? '7d' : opts.time,
      from: opts.from,
      to: opts.to,
      size: opts.size === 20 ? 1000 : opts.size,
      ...authOpts
    });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderTrace(project, data);
    return;
  }

  if (opts.command === 'perf') {
    const data = await getArmsPerformance(projectId, {
      days: opts.days,
      metric: opts.metric,
      env: opts.env,
      size: opts.size,
      ...authOpts
    });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderPerf(project, data);
    return;
  }

  if (opts.command === 'api') {
    const data = await getArmsApiMetrics(projectId, {
      time: opts.time,
      from: opts.from,
      to: opts.to,
      url: opts.url || '',
      env: opts.env,
      failedOnly: opts.failedOnly,
      minSpent: opts.minSpent,
      page: opts.page,
      size: opts.size,
      ...authOpts
    });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderApiMetrics(project, data);
    return;
  }

  if (opts.command === 'pvuv') {
    const data = await getArmsPvuv(projectId, { size: opts.size, ...authOpts });
    if (opts.json) console.log(JSON.stringify({ project, ...data }, null, 2));
    else renderPvuv(project, data);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`❌ [ARMS Query Error] ${err.message}`);
    process.exit(1);
  });
}
