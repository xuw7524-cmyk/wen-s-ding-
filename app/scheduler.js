const { calculateNextCalendarRun } = require('./schedule');
const { dateKey, occursOnDate } = require('./calendar');
const { ensureKeyword, sendWithRetry } = require('./dingtalk');
const { unprotectText } = require('./security');
const { previewRule, consumeRule } = require('./content-pools');
const { renderMessage, parseMentionMobiles } = require('./message-template');

function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback;
}

function setSetting(db, key, value) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), timestamp);
}

function nextRunAfter(reminder, scheduledFor) {
  if (reminder.frequency === 'once') return null;
  const exceptions = reminder.calendarExceptions || [];
  return calculateNextCalendarRun({
    frequency: reminder.frequency,
    runDate: reminder.run_date,
    runTime: reminder.run_time,
    weekday: reminder.weekday,
    calendarMode: reminder.calendar_mode || reminder.calendarMode,
    monthlyWorkdayN: reminder.monthly_workday_n || reminder.monthlyWorkdayN,
    skipHolidays: Boolean(reminder.skip_holidays ?? reminder.skipHolidays),
    pauseDates: JSON.parse(reminder.pause_dates_json || '[]'),
    pauseRanges: JSON.parse(reminder.pause_ranges_json || '[]')
  }, new Date(scheduledFor), exceptions);
}

function safetySettings(db) {
  const value = (key, fallback) => getSetting(db, key, fallback);
  return {
    emergency: value('global_emergency_stop', 'false') === 'true',
    pauseToday: value('pause_today', ''),
    queueSeconds: Math.max(0, Number(value('queue_seconds', '0')) || 0),
    duplicate: value('duplicate_detection', 'true') !== 'false',
    duplicateMinutes: Math.max(1, Number(value('duplicate_window_minutes', '60')) || 60),
    robotLimit: Math.max(0, Number(value('same_robot_limit', '3')) || 0),
    robotWindowMinutes: Math.max(1, Number(value('same_robot_window_minutes', '10')) || 10),
    failureThreshold: Math.max(1, Number(value('failure_pause_threshold', '3')) || 3)
  };
}

function updateReminderAfterRun(db, reminder, scheduledFor, result) {
  const nextRunAt = nextRunAfter(reminder, scheduledFor);
  const recurring = reminder.frequency !== 'once';
  const enabled = recurring ? 1 : 0;
  const normalResult = result === 'success' || result === 'skipped';
  const status = normalResult ? (recurring ? 'active' : 'complete') : 'failed';
  db.prepare(`
    UPDATE reminders SET enabled = ?, status = ?, last_result = ?, last_run_at = ?,
      next_run_at = ? WHERE id = ?
  `).run(enabled, status, result, scheduledFor, nextRunAt, reminder.id);
}

function reserveExecution(db, reminderId, scheduledFor) {
  const key = `reminder:${reminderId}:${scheduledFor}`;
  const timestamp = new Date().toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO run_executions
      (reminder_id, scheduled_for, idempotency_key, state, attempt_count, created_at, updated_at)
    VALUES (?, ?, ?, 'reserved', 0, ?, ?)
  `).run(reminderId, scheduledFor, key, timestamp, timestamp);
  return { reserved: Boolean(result.changes), key };
}

function insertHistory(db, reminder, scheduledFor, content, result) {
  db.prepare(`
    INSERT OR IGNORE INTO send_history
      (reminder_id, robot_id, scheduled_for, sent_at, content_preview, success,
       response_code, response_message, retried, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reminder.id,
    reminder.robot_id,
    scheduledFor,
    result.state === 'skipped' ? null : new Date().toISOString(),
    String(content || '').slice(0, 5000),
    result.state === 'skipped' ? null : (result.state === 'success' ? 1 : 0),
    result.code || null,
    result.message || null,
    result.retried ? 1 : 0,
    new Date().toISOString()
  );
}

function calendarReminder(reminder) {
  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    frequency: reminder.frequency,
    runDate: reminder.run_date,
    runTime: reminder.run_time,
    weekday: reminder.weekday,
    calendarMode: reminder.calendar_mode || 'calendar_days',
    monthlyWorkdayN: reminder.monthly_workday_n || 1,
    skipHolidays: Boolean(reminder.skip_holidays),
    pauseDates: parseArray(reminder.pause_dates_json),
    pauseRanges: parseArray(reminder.pause_ranges_json)
  };
}

function skipOccurrence(db, reminder, scheduledFor, code, message, content = '') {
  const reservation = reserveExecution(db, reminder.id, scheduledFor);
  if (!reservation.reserved) return { state: 'duplicate', reminderId: reminder.id, scheduledFor };
  const result = { state: 'skipped', code, message, reminderId: reminder.id };
  db.prepare(`
    UPDATE run_executions SET state = 'skipped', response_code = ?,
      response_message = ?, updated_at = ? WHERE idempotency_key = ?
  `).run(code, message, new Date().toISOString(), reservation.key);
  insertHistory(db, reminder, scheduledFor, content, result);
  updateReminderAfterRun(db, reminder, scheduledFor, 'skipped');
  return result;
}

function recordUnknownDelivery(db, reminder, scheduledFor, key, content, message) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE run_executions SET state = 'failed', response_code = 'DELIVERY_RESULT_UNKNOWN',
      response_message = ?, content_preview = ?, updated_at = ? WHERE idempotency_key = ?
  `).run(message, String(content || '').slice(0, 5000), timestamp, key);
  db.prepare(`
    INSERT OR IGNORE INTO send_history
      (reminder_id, robot_id, scheduled_for, sent_at, content_preview, success,
       response_code, response_message, retried, created_at)
    VALUES (?, ?, ?, NULL, ?, NULL, 'DELIVERY_RESULT_UNKNOWN', ?, 0, ?)
  `).run(reminder.id, reminder.robot_id, scheduledFor, String(content || '').slice(0, 5000), message, timestamp);
  db.prepare(`
    UPDATE reminders SET enabled = 0, status = 'paused', last_result = 'delivery_unknown',
      last_run_at = ?, next_run_at = NULL WHERE id = ?
  `).run(scheduledFor, reminder.id);
}

function recoverStaleExecutions(db, now = new Date(), staleMinutes = 5) {
  const cutoff = new Date(now.getTime() - staleMinutes * 60 * 1000).toISOString();
  const released = db.prepare(`
    DELETE FROM run_executions WHERE state = 'reserved' AND updated_at < ?
  `).run(cutoff).changes;
  const stale = db.prepare(`
    SELECT e.*, r.robot_id FROM run_executions e
    JOIN reminders r ON r.id = e.reminder_id
    WHERE e.state = 'sending' AND e.updated_at < ?
  `).all(cutoff);
  stale.forEach((execution) => {
    recordUnknownDelivery(db, {
      id: execution.reminder_id,
      robot_id: execution.robot_id
    }, execution.scheduled_for, execution.idempotency_key, execution.content_preview,
    '后台曾在发送过程中异常退出，无法确认钉钉是否已收到；提醒已自动暂停，请核对群消息后再启用');
  });
  return { unknownDeliveries: stale.length, releasedReservations: released };
}

function messageForReminder(db, reminder, scheduledFor) {
  let sourceContent;
  let poolPreview = null;
  if (reminder.source_type === 'pool_rule') {
    poolPreview = previewRule(db, reminder.content_rule_id, new Date(scheduledFor).getDay(), reminder.keyword);
    sourceContent = poolPreview.message;
  } else {
    sourceContent = reminder.message;
  }
  return {
    ...renderMessage({
      content: sourceContent,
      title: reminder.message_title,
      format: reminder.message_format,
      keyword: reminder.keyword,
      scheduledFor,
      robotName: reminder.robot_name,
      reminderName: reminder.name
    }),
    poolPreview
  };
}

async function processDueReminder(db, reminder, options = {}) {
  const now = options.now || new Date();
  const scheduledFor = reminder.next_run_at;
  const safety = safetySettings(db);
  if (safety.emergency) {
    return { state: 'blocked', code: 'SAFETY_STOP', message: '全局紧急停止', reminderId: reminder.id };
  }
  if (safety.pauseToday === dateKey(now)) {
    return skipOccurrence(db, reminder, scheduledFor, 'PAUSED_TODAY', '今天已暂停全部消息，本次计划已跳过');
  }
  if (!occursOnDate(calendarReminder(reminder), new Date(scheduledFor), reminder.calendarExceptions || [])) {
    return skipOccurrence(db, reminder, scheduledFor, 'CALENDAR_SKIP', '该发送日期已被日历规则暂停，本次计划已跳过');
  }
  if (now.getTime() < new Date(scheduledFor).getTime()) {
    return {
      state: 'queued',
      code: 'WAITING_QUEUE',
      message: `已进入发送前队列，将在计划时间 ${new Date(scheduledFor).toLocaleString()} 发送`,
      reminderId: reminder.id
    };
  }
  if (reminder.preview_confirm_required && reminder.preview_confirmed_at !== reminder.updated_at) {
    return { state: 'blocked', code: 'PREVIEW_CONFIRM_REQUIRED', message: '需要先确认完整发送预览', reminderId: reminder.id };
  }
  if (safety.robotLimit > 0) {
    const since = new Date(now.getTime() - safety.robotWindowMinutes * 60 * 1000).toISOString();
    const count = db.prepare('SELECT COUNT(*) AS count FROM send_history WHERE robot_id = ? AND success = 1 AND created_at >= ?')
      .get(reminder.robot_id, since).count;
    if (count >= safety.robotLimit) {
      return {
        state: 'blocked',
        code: 'RATE_LIMIT',
        message: '同一群近期发送次数过多，窗口结束后会自动重试',
        reminderId: reminder.id
      };
    }
  }
  const reservation = reserveExecution(db, reminder.id, scheduledFor);
  if (!reservation.reserved) return { state: 'duplicate', reminderId: reminder.id, scheduledFor };

  const toleranceMs = options.missedToleranceMs ?? 2 * 60 * 1000;
  const lateBy = now.getTime() - new Date(scheduledFor).getTime();
  if (reminder.missed_policy === 'skip' && lateBy > toleranceMs) {
    const result = { state: 'skipped', code: 'MISSED', message: '错过发送时间，已按设置跳过' };
    db.prepare(`UPDATE run_executions SET state = 'skipped', response_code = ?, response_message = ?, updated_at = ? WHERE idempotency_key = ?`)
      .run(result.code, result.message, new Date().toISOString(), reservation.key);
    insertHistory(db, reminder, scheduledFor, '', result);
    updateReminderAfterRun(db, reminder, scheduledFor, 'skipped');
    return result;
  }

  let content = '';
  try {
    const message = messageForReminder(db, reminder, scheduledFor);
    content = message.content;
    if (safety.duplicate) {
      const duplicateSince = new Date(now.getTime() - safety.duplicateMinutes * 60 * 1000).toISOString();
      if (db.prepare('SELECT 1 FROM send_history WHERE robot_id = ? AND success = 1 AND content_preview = ? AND created_at >= ?').get(reminder.robot_id, content.slice(0, 5000), duplicateSince)) {
        const result = { state: 'skipped', code: 'DUPLICATE_CONTENT', message: '检测到近期相同内容，已跳过发送' };
        db.prepare('UPDATE run_executions SET state = ?, response_code = ?, response_message = ?, updated_at = ? WHERE idempotency_key = ?').run('skipped', result.code, result.message, new Date().toISOString(), reservation.key);
        insertHistory(db, reminder, scheduledFor, content, result);
        updateReminderAfterRun(db, reminder, scheduledFor, 'skipped');
        return result;
      }
    }
    const decrypt = options.decryptFunction || unprotectText;
    const webhook = await decrypt(reminder.webhook_encrypted);
    const secret = reminder.secret_encrypted ? await decrypt(reminder.secret_encrypted) : null;
    const atMobiles = reminder.mention_mobiles_encrypted
      ? parseMentionMobiles(JSON.parse(await decrypt(reminder.mention_mobiles_encrypted)))
      : [];
    db.prepare(`UPDATE run_executions SET state = 'sending', content_preview = ?, updated_at = ? WHERE idempotency_key = ?`)
      .run(content.slice(0, 5000), new Date().toISOString(), reservation.key);
    const send = options.sendFunction || ((sendOptions) => sendWithRetry(sendOptions));
    const sendResult = await send({
      webhook,
      secret,
      content,
      title: message.title,
      format: message.format,
      atAll: Boolean(reminder.at_all),
      atMobiles
    });
    const result = {
      state: 'success',
      code: String(sendResult.errcode ?? 0),
      message: sendResult.errmsg || 'ok',
      retried: Boolean(sendResult.retried),
      attempts: sendResult.attempts || 1
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (message.poolPreview) {
        consumeRule(db, reminder.content_rule_id, new Date(scheduledFor).getDay(), reminder.keyword, reservation.key, { inTransaction: true });
      }
      db.prepare(`
        UPDATE run_executions SET state = 'success', attempt_count = ?, response_code = ?,
          response_message = ?, updated_at = ? WHERE idempotency_key = ?
      `).run(result.attempts, result.code, result.message, new Date().toISOString(), reservation.key);
      insertHistory(db, reminder, scheduledFor, content, result);
      db.prepare('UPDATE reminders SET consecutive_failures = 0 WHERE id = ?').run(reminder.id);
      updateReminderAfterRun(db, reminder, scheduledFor, 'success');
      db.exec('COMMIT');
    } catch (finalizeError) {
      db.exec('ROLLBACK');
      recordUnknownDelivery(
        db, reminder, scheduledFor, reservation.key, content,
        `钉钉已返回成功，但本地记录未能完整保存：${finalizeError.message}`
      );
      return {
        state: 'failed',
        code: 'DELIVERY_RESULT_UNKNOWN',
        message: '钉钉可能已经收到，但本地记录保存失败；提醒已暂停，请先核对群消息',
        reminderId: reminder.id
      };
    }
    return result;
  } catch (error) {
    const deliveryUnknown = Boolean(error.deliveryUnknown);
    const result = {
      state: 'failed',
      code: deliveryUnknown ? 'DELIVERY_RESULT_UNKNOWN' : String(error.code || 'SEND_FAILED'),
      message: error.message || '发送失败',
      retried: Number(error.attempts || 1) > 1,
      attempts: Number(error.attempts || 1)
    };
    db.prepare(`
      UPDATE run_executions SET state = 'failed', attempt_count = ?, content_preview = ?,
        response_code = ?, response_message = ?, updated_at = ? WHERE idempotency_key = ?
    `).run(result.attempts, content.slice(0, 5000), result.code, result.message, new Date().toISOString(), reservation.key);
    insertHistory(db, reminder, scheduledFor, content, result);
    if (deliveryUnknown) {
      db.prepare(`
        UPDATE reminders SET consecutive_failures = consecutive_failures + 1, enabled = 0,
          status = 'paused', last_result = 'delivery_unknown', last_run_at = ?, next_run_at = NULL
        WHERE id = ?
      `).run(scheduledFor, reminder.id);
      return result;
    }
    const failures = Number(reminder.consecutive_failures || 0) + 1;
    const autoPaused = failures >= safety.failureThreshold;
    db.prepare('UPDATE reminders SET consecutive_failures = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END, status = CASE WHEN ? THEN \'paused\' ELSE status END WHERE id = ?').run(failures, autoPaused ? 1 : 0, autoPaused ? 1 : 0, reminder.id);
    updateReminderAfterRun(db, reminder, scheduledFor, 'failed');
    if (autoPaused) db.prepare("UPDATE reminders SET enabled = 0, status = 'paused', last_result = 'failed_auto_paused', updated_at = ? WHERE id = ?").run(new Date().toISOString(), reminder.id);
    return result;
  }
}

async function runSchedulerTick(db, options = {}) {
  if (getSetting(db, 'sending_enabled', 'false') !== 'true' && !options.force) {
    return { sendingEnabled: false, processed: [] };
  }
  const now = options.now || new Date();
  const queueSeconds = safetySettings(db).queueSeconds;
  const queueUntil = new Date(now.getTime() + queueSeconds * 1000).toISOString();
  const due = db.prepare(`
    SELECT r.*, b.name AS robot_name, b.webhook_encrypted, b.secret_encrypted, b.keyword, b.enabled AS robot_enabled,
      (SELECT json_group_array(json_object('date', ce.date, 'type', ce.type, 'label', ce.label)) FROM calendar_exceptions ce) AS calendar_exceptions_json
    FROM reminders r JOIN robots b ON b.id = r.robot_id
    WHERE r.enabled = 1 AND b.enabled = 1 AND r.next_run_at IS NOT NULL AND r.next_run_at <= ?
    ORDER BY r.next_run_at ASC, r.id ASC
  `).all(queueUntil).map((row) => ({ ...row, calendarExceptions: JSON.parse(row.calendar_exceptions_json || '[]') }));
  const processed = [];
  for (const reminder of due) {
    processed.push(await processDueReminder(db, reminder, { ...options, now }));
  }
  return { sendingEnabled: true, processed };
}

function startScheduler(db, options = {}) {
  recoverStaleExecutions(db);
  const intervalSeconds = Math.max(5, Number(getSetting(db, 'scheduler_interval_seconds', '15')) || 15);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerTick(db, options);
    } catch {
      // Individual execution errors are recorded in SQLite. Keep the scheduler alive.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer), intervalSeconds };
}

module.exports = {
  getSetting,
  setSetting,
  nextRunAfter,
  reserveExecution,
  messageForReminder,
  recoverStaleExecutions,
  processDueReminder,
  runSchedulerTick,
  startScheduler
};
