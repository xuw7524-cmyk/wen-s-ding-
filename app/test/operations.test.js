const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSevenDayPlan, buildHealthReport } = require('../operations');

test('seven day plan expands daily, weekly and one-time reminders without past occurrences', () => {
  const now = new Date(2026, 6, 20, 10, 0, 0);
  const common = { enabled: true, status: 'active', robotId: 1, robotName: '运营群', sourceType: 'fixed', atAll: false };
  const days = buildSevenDayPlan([
    { ...common, id: 1, name: '每日早报', frequency: 'daily', runTime: '09:00' },
    { ...common, id: 2, name: '每日晚报', frequency: 'daily', runTime: '18:00' },
    { ...common, id: 3, name: '周三提醒', frequency: 'weekly', weekday: 3, runTime: '11:00' },
    { ...common, id: 4, name: '一次提醒', frequency: 'once', runDate: '2026-07-21', runTime: '12:00' },
    { ...common, id: 5, name: '暂停提醒', frequency: 'daily', runTime: '15:00', enabled: false, status: 'paused' }
  ], now);
  assert.equal(days.length, 7);
  assert.deepEqual(days[0].items.map((item) => item.name), ['每日晚报']);
  assert.deepEqual(days[1].items.map((item) => item.name), ['每日早报', '一次提醒', '每日晚报']);
  assert.equal(days.find((day) => day.date === '2026-07-22').items.some((item) => item.name === '周三提醒'), true);
  assert.equal(days.flatMap((day) => day.items).some((item) => item.name === '暂停提醒'), false);
});

test('seven day plan uses the same monthly-workday rule as the scheduler', () => {
  const now = new Date(2026, 7, 2, 10, 0, 0);
  const days = buildSevenDayPlan([{
    id: 8,
    name: '每月第二个工作日',
    enabled: true,
    status: 'active',
    robotId: 1,
    robotName: '运营群',
    sourceType: 'fixed',
    atAll: false,
    frequency: 'daily',
    runTime: '09:00',
    calendarMode: 'monthly_workday',
    monthlyWorkdayN: 2,
    pauseDates: [],
    pauseRanges: []
  }], now, [{ date: '2026-08-03', type: 'holiday' }]);
  assert.deepEqual(
    days.flatMap((day) => day.items).map((item) => item.scheduledFor),
    [new Date(2026, 7, 5, 9, 0, 0).toISOString()]
  );
});

test('health report explains paused sending, untested robots, duplicates and recent failures', () => {
  const now = new Date('2026-07-20T10:00:00.000Z');
  const reminders = [
    { id: 1, enabled: true, status: 'active', robotId: 1, nextRunAt: '2026-07-21T02:00:00.000Z' },
    { id: 2, enabled: true, status: 'active', robotId: 1, nextRunAt: '2026-07-21T02:00:00.000Z' }
  ];
  const report = buildHealthReport({
    autoStartEnabled: true,
    supervised: true,
    sendingEnabled: false,
    robots: [{ id: 1, enabled: true, lastTestStatus: 'not_tested' }],
    reminders,
    pools: [{ enabled: true, itemCount: 0 }],
    history: [{ success: false, createdAt: '2026-07-20T09:00:00.000Z' }]
  }, now);
  assert.equal(report.level, 'error');
  assert.equal(report.checks.find((item) => item.id === 'recovery').level, 'ok');
  assert.equal(report.checks.find((item) => item.id === 'sending').level, 'warning');
  assert.equal(report.checks.find((item) => item.id === 'duplicates').level, 'warning');
  assert.equal(report.checks.find((item) => item.id === 'failures').level, 'error');
});
