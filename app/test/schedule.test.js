const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateNextRun } = require('../schedule');

test('daily reminder advances to tomorrow after today time passed', () => {
  const now = new Date(2026, 6, 16, 10, 0, 0);
  const result = new Date(calculateNextRun({ frequency: 'daily', runTime: '09:30' }, now));
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 6);
  assert.equal(result.getDate(), 17);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getMinutes(), 30);
});

test('weekly reminder chooses the next requested weekday', () => {
  const now = new Date(2026, 6, 16, 10, 0, 0); // Thursday
  const result = new Date(calculateNextRun({ frequency: 'weekly', runTime: '17:30', weekday: 1 }, now));
  assert.equal(result.getDay(), 1);
  assert.equal(result.getDate(), 20);
  assert.equal(result.getHours(), 17);
  assert.equal(result.getMinutes(), 30);
});

test('past one-time reminder has no next run', () => {
  const now = new Date(2026, 6, 16, 10, 0, 0);
  assert.equal(calculateNextRun({ frequency: 'once', runDate: '2026-07-15', runTime: '09:30' }, now), null);
});
