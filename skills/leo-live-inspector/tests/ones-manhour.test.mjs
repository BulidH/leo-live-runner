import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeManhourDays, MANHOUR_TARGET } from '../scripts/common/ones.js';

/**
 * 个人工时概览的核心是「每天打没打满」这一条判定。
 * ONES 只给 man_hour 和 is_workday 两个原始值，节假日 / 调休 / 未来日期
 * 都由 is_workday + 日期先后推出——这里把每种组合都钉死，
 * 免得以后改判定时把「未来工作日」误报成「漏打」。
 */

const day = (date, weekDay, isWorkday, manHour) => ({
  day: date, week_day: weekDay, is_workday: isWorkday, man_hour: manHour
});

/** 构造一整周（周一到周日），便于断言汇总 */
function buildWeek({ today, monday = '2026-11-23', hours = [1, 1, 1, 1, 1, 0, 0], workdays = [1, 1, 1, 1, 1, 0, 0] } = {}) {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const base = new Date(monday + 'T00:00:00');
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const p = n => String(n).padStart(2, '0');
    const ds = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    // 未来日期在 ONES 里 man_hour 必然是 0；不这样构造会误判成「已打满」
    const h = today && ds > today ? 0 : hours[i];
    rows.push(day(ds, names[i], workdays[i], h));
  }
  return normalizeManhourDays(rows, { today });
}

test('工时判定的七种状态', () => {
  const { days } = normalizeManhourDays([
    day('2026-11-02', '周一', 1, 1),      // 正好打满
    day('2026-11-03', '周二', 1, 0.3),    // 不足
    day('2026-11-04', '周三', 1, 0),      // 未打
    day('2026-11-05', '周四', 1, 1.5),    // 超出
    day('2026-11-07', '周六', 0, 0),      // 非工作日
    day('2026-11-08', '周日', 0, 0.5)     // 非工作日却打了工时
  ], { today: '2026-11-30' });

  assert.deepEqual(days.map(d => d.status),
    ['full', 'short', 'missing', 'over', 'off', 'overtime']);
});

test('打满基准是 1 人天', () => {
  assert.equal(MANHOUR_TARGET, 1);
  const { days } = normalizeManhourDays([day('2026-11-02', '周一', 1, 1)], { today: '2026-11-30' });
  assert.equal(days[0].status, 'full');
});

test('浮点误差不影响「打满」判定', () => {
  // 0.1+0.2 这类累加会得到 0.9999999，不能因此判成「不足」
  for (const h of [0.9999999, 1.0000001, 1]) {
    const { days } = normalizeManhourDays([day('2026-11-02', '周一', 1, h)], { today: '2026-11-30' });
    assert.equal(days[0].status, 'full', `${h} 应判为打满`);
  }
});

test('未来的工作日是「待打」，不是「漏打」', () => {
  const { days } = buildWeek({ today: '2026-11-24' });
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));

  assert.equal(byDate['2026-11-23'].status, 'full', '已过去且打满');
  assert.equal(byDate['2026-11-24'].status, 'full', '今天已打满');
  assert.equal(byDate['2026-11-25'].status, 'pending', '未来的工作日还没到，不该报漏打');
  assert.equal(byDate['2026-11-28'].status, 'off', '未来周末仍显示为假');
});

test('未来日期不参与「应打 / 差额」统计', () => {
  // 整周只有周一、周二已经过去，其余都是未来
  const { summary } = buildWeek({ today: '2026-11-24' });
  // summary.workdays 是「已经过去的工作日」，界面上的分母就是它：
  // 未来的工作日还没到，算进分母只会让「打满 2/5 天」显得像欠了工时。
  assert.equal(summary.workdays, 2, '只统计已过工作日');
  assert.equal(summary.expected, 2, '应打 = 已过工作日 × 1');
  assert.equal(summary.gap, 0, '两天都打满了');
  assert.equal(summary.unfilled.length, 0);
});

test('差额为正表示还差多少，为负表示超打', () => {
  const short = buildWeek({ today: '2026-11-27', hours: [1, 0.5, 0, 1, 1, 0, 0] });
  assert.equal(short.summary.gap, 1.5, '0.5 + 1 = 1.5 人天没打');

  const over = buildWeek({ today: '2026-11-27', hours: [1, 1, 2, 1, 1, 0, 0] });
  assert.equal(over.summary.gap, -1, '周三多打了 1 人天');
});

test('未打满清单按日期升序列出，含状态文案', () => {
  const { summary } = buildWeek({ today: '2026-11-27', hours: [1, 0.3, 0, 1, 1, 0, 0] });
  assert.deepEqual(summary.unfilled.map(u => u.date), ['2026-11-24', '2026-11-25']);
  assert.deepEqual(summary.unfilled.map(u => u.statusLabel), ['不足', '未打']);
});

test('调休上班的周六算工作日，需要打满', () => {
  // 2026-10-10 是周六，但国庆调休上班（ONES 的 is_workday=1）
  const { days, summary } = normalizeManhourDays([
    day('2026-10-09', '周五', 1, 1),
    day('2026-10-10', '周六', 1, 1)
  ], { today: '2026-10-31' });
  assert.equal(days[1].isWorkday, true);
  assert.equal(days[1].status, 'full');
  assert.equal(summary.workdays, 2, '调休的周六要计进工作日');
});

test('法定节假日即使有工时也不算「缺勤」', () => {
  const { days } = normalizeManhourDays([
    day('2026-10-01', '周四', 0, 0),
    day('2026-10-02', '周五', 0, 2)
  ], { today: '2026-10-31' });
  assert.equal(days[0].status, 'off');
  assert.equal(days[1].status, 'overtime', '节假日打了工时记为加班');
});

test('结果按日期升序，即使输入乱序', () => {
  const { days } = normalizeManhourDays([
    day('2026-11-05', '周四', 1, 1),
    day('2026-11-02', '周一', 1, 1),
    day('2026-11-04', '周三', 1, 1)
  ], { today: '2026-11-30' });
  assert.deepEqual(days.map(d => d.date), ['2026-11-02', '2026-11-04', '2026-11-05']);
});

test('空列表不炸', () => {
  const { days, summary } = normalizeManhourDays([], { today: '2026-11-30' });
  assert.equal(days.length, 0);
  assert.equal(summary.workdays, 0);
  assert.equal(summary.gap, 0);
  assert.deepEqual(summary.unfilled, []);
});

test('今天被标记出来（页面要画高亮框）', () => {
  const { days } = buildWeek({ today: '2026-11-25' });
  const today = days.filter(d => d.isToday);
  assert.equal(today.length, 1);
  assert.equal(today[0].date, '2026-11-25');
});
