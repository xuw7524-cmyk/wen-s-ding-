const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../database');
const { setSetting, runSchedulerTick, recoverStaleExecutions } = require('../scheduler');
const { createPool, addPoolItems, saveRule, getPool } = require('../content-pools');
const { addPhraseItems, listPhrasePools } = require('../phrase-pools');

function insertRobot(db, name = '测试机器人') {
  const now = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO robots
      (name, webhook_encrypted, webhook_hint, keyword, enabled, created_at, updated_at)
    VALUES (?, 'encrypted-webhook', 'masked', '定时通知', 1, ?, ?)
  `).run(name, now, now).lastInsertRowid);
}

function insertReminder(db, input) {
  const now = new Date().toISOString();
  const id = Number(db.prepare(`
    INSERT INTO reminders
      (name, robot_id, message, source_type, content_rule_id, frequency, run_time,
       at_all, enabled, missed_policy, timezone, next_run_at, status, message_format, message_title,
       mention_mobiles_encrypted, mention_hint, calendar_mode, monthly_workday_n, skip_holidays,
       pause_dates_json, pause_ranges_json, preview_confirm_required, preview_confirmed_at,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'Asia/Hong_Kong', ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.name, input.robotId, input.message || '', input.sourceType || 'fixed',
    input.contentRuleId || null, input.frequency || 'daily', input.runTime || '23:59',
    input.atAll ? 1 : 0, input.missedPolicy || 'catch_up',
    input.nextRunAt, input.messageFormat || 'text', input.messageTitle || '', input.mentionEncrypted || null,
    input.mentionHint || '', input.calendarMode || 'calendar_days', input.monthlyWorkdayN || 1,
    input.skipHolidays ? 1 : 0, JSON.stringify(input.pauseDates || []), JSON.stringify(input.pauseRanges || []),
    input.previewConfirmRequired ? 1 : 0, input.previewConfirmedAt || null,
    now, input.updatedAt || now).lastInsertRowid);
  return id;
}

test('scheduler sends due fixed reminder once, records result and advances next run', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const now = new Date();
  const scheduledFor = new Date(now.getTime() - 30_000).toISOString();
  const reminderId = insertReminder(db, {
    name: '固定提醒', robotId, message: '请检查数据', atAll: true, nextRunAt: scheduledFor
  });
  setSetting(db, 'sending_enabled', 'true');
  const sent = [];
  const result = await runSchedulerTick(db, {
    now,
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async (options) => {
      sent.push(options);
      return { errcode: 0, errmsg: 'ok', attempts: 1, retried: false };
    }
  });
  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].state, 'success');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '定时通知｜请检查数据');
  assert.equal(sent[0].atAll, true);
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
  assert.equal(reminder.last_result, 'success');
  assert.ok(new Date(reminder.next_run_at) > now);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM run_executions').get().total, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM send_history WHERE success = 1').get().total, 1);
});

test('scheduler renders variables and sends encrypted specified members as Markdown options', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-format-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db, '运营群');
  const now = new Date('2026-07-20T01:30:30.000Z');
  insertReminder(db, {
    name: '每日检查', robotId, message: '{日期} {时间} 请检查', messageFormat: 'markdown',
    messageTitle: '{星期}风险提醒', mentionEncrypted: 'encrypted-mentions',
    mentionHint: '已保存 1 人：•••• 8000', nextRunAt: '2026-07-20T01:30:00.000Z'
  });
  setSetting(db, 'sending_enabled', 'true');
  const sent = [];
  await runSchedulerTick(db, {
    now,
    decryptFunction: async (value) => value === 'encrypted-mentions' ? '["13800138000"]' : 'http://local.test/fake',
    sendFunction: async (options) => { sent.push(options); return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(sent[0].format, 'markdown');
  assert.equal(sent[0].title, '星期一风险提醒');
  assert.equal(sent[0].content, '定时通知\n\n2026-07-20 09:30 请检查');
  assert.deepEqual(sent[0].atMobiles, ['13800138000']);
});

test('failed pool reminder records failure without advancing risk or phrase pools', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-pool-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const pool = createPool(db, { name: 'A池' });
  addPoolItems(db, pool.id, ['风险内容1', '风险内容2']);
  addPhraseItems(db, 'greeting', ['大家好']);
  addPhraseItems(db, 'opening', ['请留意']);
  addPhraseItems(db, 'closing', ['谢谢配合']);
  const now = new Date();
  const weekday = new Date(now.getTime() - 30_000).getDay();
  const rule = saveRule(db, null, {
    name: '内容规则', messageTitle: '风险提醒',
    allocations: [{ weekday, slotOrder: 1, poolId: pool.id, itemCount: 1 }]
  });
  insertReminder(db, {
    name: '内容池提醒', robotId, sourceType: 'pool_rule', contentRuleId: rule.id,
    nextRunAt: new Date(now.getTime() - 30_000).toISOString()
  });
  setSetting(db, 'sending_enabled', 'true');
  const error = new Error('模拟发送失败');
  error.code = 'MOCK_FAILURE';
  error.attempts = 3;
  const result = await runSchedulerTick(db, {
    now,
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async () => { throw error; }
  });
  assert.equal(result.processed[0].state, 'failed');
  assert.equal(getPool(db, pool.id).usedInCycle, 0);
  assert.equal(listPhrasePools(db).every((item) => item.usedInCycle === 0), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM content_consumptions').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM send_history WHERE success = 0').get().total, 1);
});

test('a newly added calendar pause skips a stale due occurrence without sending it', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-calendar-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const now = new Date(2026, 6, 21, 9, 0, 30);
  const scheduledFor = new Date(2026, 6, 21, 9, 0, 0).toISOString();
  const reminderId = insertReminder(db, {
    name: '日历暂停测试', robotId, message: '今天不应发送', runTime: '09:00', nextRunAt: scheduledFor
  });
  db.prepare(`
    INSERT INTO calendar_exceptions (date, type, label, created_at, updated_at)
    VALUES ('2026-07-21', 'pause', '临时暂停', ?, ?)
  `).run(now.toISOString(), now.toISOString());
  setSetting(db, 'sending_enabled', 'true');
  let sends = 0;
  const result = await runSchedulerTick(db, {
    now,
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async () => { sends += 1; return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(result.processed[0].state, 'skipped');
  assert.equal(result.processed[0].code, 'CALENDAR_SKIP');
  assert.equal(sends, 0);
  assert.ok(new Date(db.prepare('SELECT next_run_at FROM reminders WHERE id = ?').get(reminderId).next_run_at) > now);
});

test('pause today skips and advances due reminders while emergency stop leaves them pending', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-safety-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const now = new Date(2026, 6, 21, 10, 0, 30);
  const pausedId = insertReminder(db, {
    name: '当天暂停', robotId, message: '跳过我', runTime: '10:00',
    nextRunAt: new Date(2026, 6, 21, 10, 0, 0).toISOString()
  });
  setSetting(db, 'sending_enabled', 'true');
  setSetting(db, 'pause_today', '2026-07-21');
  const paused = await runSchedulerTick(db, { now, sendFunction: async () => assert.fail('不应发送') });
  assert.equal(paused.processed[0].state, 'skipped');
  assert.equal(paused.processed[0].code, 'PAUSED_TODAY');
  assert.ok(new Date(db.prepare('SELECT next_run_at FROM reminders WHERE id = ?').get(pausedId).next_run_at) > now);

  const emergencyId = insertReminder(db, {
    name: '紧急停止', robotId, message: '保持待发送', runTime: '10:00',
    nextRunAt: new Date(2026, 6, 21, 10, 0, 0).toISOString()
  });
  setSetting(db, 'pause_today', '');
  setSetting(db, 'global_emergency_stop', 'true');
  const emergency = await runSchedulerTick(db, { now, sendFunction: async () => assert.fail('不应发送') });
  assert.equal(emergency.processed[0].state, 'blocked');
  assert.equal(
    db.prepare('SELECT next_run_at FROM reminders WHERE id = ?').get(emergencyId).next_run_at,
    new Date(2026, 6, 21, 10, 0, 0).toISOString()
  );
});

test('advance queue discovers a reminder early but sends at its scheduled time, not after it', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-queue-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const scheduled = new Date(2026, 6, 21, 11, 0, 0);
  insertReminder(db, {
    name: '提前队列', robotId, message: '准点发送', runTime: '11:00', nextRunAt: scheduled.toISOString()
  });
  setSetting(db, 'sending_enabled', 'true');
  setSetting(db, 'queue_seconds', '60');
  let sends = 0;
  const early = await runSchedulerTick(db, {
    now: new Date(scheduled.getTime() - 30_000),
    sendFunction: async () => { sends += 1; return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(early.processed[0].state, 'queued');
  assert.equal(sends, 0);
  const onTime = await runSchedulerTick(db, {
    now: scheduled,
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async () => { sends += 1; return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(onTime.processed[0].state, 'success');
  assert.equal(sends, 1);
});

test('robot rate limit does not reserve the occurrence and it can send after the window clears', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-limit-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const now = new Date(2026, 6, 21, 12, 0, 30);
  insertReminder(db, {
    name: '限流重试', robotId, message: '稍后仍要发送', runTime: '12:00',
    nextRunAt: new Date(2026, 6, 21, 12, 0, 0).toISOString()
  });
  db.prepare(`
    INSERT INTO send_history
      (robot_id, scheduled_for, sent_at, content_preview, success, created_at)
    VALUES (?, ?, ?, '其他内容', 1, ?)
  `).run(robotId, now.toISOString(), now.toISOString(), new Date(now.getTime() - 60_000).toISOString());
  setSetting(db, 'sending_enabled', 'true');
  setSetting(db, 'same_robot_limit', '1');
  setSetting(db, 'same_robot_window_minutes', '10');
  let sends = 0;
  const limited = await runSchedulerTick(db, { now, sendFunction: async () => { sends += 1; } });
  assert.equal(limited.processed[0].code, 'RATE_LIMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM run_executions').get().total, 0);
  db.prepare('UPDATE send_history SET created_at = ?').run(new Date(now.getTime() - 11 * 60_000).toISOString());
  const retried = await runSchedulerTick(db, {
    now: new Date(now.getTime() + 15_000),
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async () => { sends += 1; return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(retried.processed[0].state, 'success');
  assert.equal(sends, 1);
});

test('preview confirmation survives successful recurring runs until the reminder is edited', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-preview-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const originalUpdatedAt = '2026-07-20T00:00:00.000Z';
  const firstScheduled = new Date(2026, 6, 21, 13, 0, 0);
  const reminderId = insertReminder(db, {
    name: '预览确认', robotId, message: '确认后循环发送', runTime: '13:00',
    nextRunAt: firstScheduled.toISOString(), previewConfirmRequired: true,
    previewConfirmedAt: originalUpdatedAt, updatedAt: originalUpdatedAt
  });
  setSetting(db, 'sending_enabled', 'true');
  setSetting(db, 'duplicate_detection', 'false');
  let sends = 0;
  const first = await runSchedulerTick(db, {
    now: new Date(firstScheduled.getTime() + 1_000),
    decryptFunction: async () => 'http://local.test/fake',
    sendFunction: async () => { sends += 1; return { errcode: 0, errmsg: 'ok' }; }
  });
  assert.equal(first.processed[0].state, 'success');
  const afterFirst = db.prepare('SELECT updated_at, preview_confirmed_at FROM reminders WHERE id = ?').get(reminderId);
  assert.equal(afterFirst.updated_at, originalUpdatedAt);
  assert.equal(afterFirst.preview_confirmed_at, originalUpdatedAt);
  assert.equal(sends, 1);
});

test('stale in-flight delivery is surfaced as unknown and pauses the reminder to prevent duplicates', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-scheduler-recovery-test-'));
  const db = openDatabase(path.join(tempDir, 'scheduler.db'));
  context.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const robotId = insertRobot(db);
  const reminderId = insertReminder(db, {
    name: '异常恢复', robotId, message: '可能已经发出',
    nextRunAt: '2026-07-21T05:00:00.000Z'
  });
  const staleAt = '2026-07-21T05:00:01.000Z';
  db.prepare(`
    INSERT INTO run_executions
      (reminder_id, scheduled_for, idempotency_key, state, content_preview, created_at, updated_at)
    VALUES (?, '2026-07-21T05:00:00.000Z', 'stale-send', 'sending', '可能已经发出', ?, ?)
  `).run(reminderId, staleAt, staleAt);
  db.prepare(`
    INSERT INTO run_executions
      (reminder_id, scheduled_for, idempotency_key, state, created_at, updated_at)
    VALUES (?, '2026-07-20T05:00:00.000Z', 'stale-reservation', 'reserved', ?, ?)
  `).run(reminderId, staleAt, staleAt);
  const recovered = recoverStaleExecutions(db, new Date('2026-07-21T05:10:00.000Z'));
  assert.equal(recovered.unknownDeliveries, 1);
  assert.equal(recovered.releasedReservations, 1);
  const reminder = db.prepare('SELECT enabled, status, last_result FROM reminders WHERE id = ?').get(reminderId);
  assert.equal(reminder.enabled, 0);
  assert.equal(reminder.status, 'paused');
  assert.equal(reminder.last_result, 'delivery_unknown');
  assert.equal(db.prepare("SELECT state FROM run_executions WHERE idempotency_key = 'stale-send'").get().state, 'failed');
  assert.equal(db.prepare("SELECT success FROM send_history WHERE response_code = 'DELIVERY_RESULT_UNKNOWN'").get().success, null);
});
