const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateNextRun } = require('../schedule');
const { isSendable, occursOnDate, nextCalendarRun } = require('../calendar');

test('calendar-day reminders only skip holidays when that option is enabled', () => {
  const holiday = new Date(2026, 6, 21, 9, 0, 0);
  const exceptions = [{ date: '2026-07-21', type: 'holiday' }];
  assert.equal(isSendable(holiday, {
    calendarMode: 'calendar_days',
    skipHolidays: false,
    pauseDates: [],
    pauseRanges: []
  }, exceptions), true);
  assert.equal(isSendable(holiday, {
    calendarMode: 'calendar_days',
    skipHolidays: true,
    pauseDates: [],
    pauseRanges: []
  }, exceptions), false);
});

test('one-time reminder on a paused date is skipped instead of silently moved', () => {
  const reminder = {
    frequency: 'once',
    runDate: '2026-07-21',
    runTime: '09:00',
    calendarMode: 'calendar_days',
    pauseDates: ['2026-07-21'],
    pauseRanges: [],
    calendarExceptions: []
  };
  const next = nextCalendarRun(reminder, new Date(2026, 6, 20, 8, 0, 0), calculateNextRun);
  assert.equal(next, null);
});

test('monthly workday rule only occurs on the configured numbered workday', () => {
  const reminder = {
    frequency: 'daily',
    runTime: '09:00',
    calendarMode: 'monthly_workday',
    monthlyWorkdayN: 2,
    skipHolidays: false,
    pauseDates: [],
    pauseRanges: []
  };
  const exceptions = [{ date: '2026-08-03', type: 'holiday' }];
  assert.equal(occursOnDate(reminder, new Date(2026, 7, 3), exceptions), false);
  assert.equal(occursOnDate(reminder, new Date(2026, 7, 4), exceptions), false);
  assert.equal(occursOnDate(reminder, new Date(2026, 7, 5), exceptions), true);
  assert.equal(occursOnDate(reminder, new Date(2026, 7, 6), exceptions), false);
});
