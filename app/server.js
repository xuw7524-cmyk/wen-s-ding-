const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, listRobots, listReminders, listHistory } = require('./database');
const { protectText, unprotectText, validateWebhook, webhookHint } = require('./security');
const { calculateNextRun, calculateNextCalendarRun, parseTime } = require('./schedule');
const { parseDateKey } = require('./calendar');
const { ensureKeyword, sendWithRetry } = require('./dingtalk');
const { getSetting, setSetting, startScheduler, messageForReminder } = require('./scheduler');
const { parseMentionMobiles, mentionHint, normalizeMessageFormat } = require('./message-template');
const {
  listPools, getPool, createPool, updatePool, addPoolItems, updatePoolItem,
  deletePoolItem, deletePoolItems, reorderPoolItems, setPoolNextItem, resetPoolCycle, listRules, saveRule,
  previewRule, consumeRule
} = require('./content-pools');
const {
  listPhrasePools, addPhraseItems, updatePhraseItem, deletePhraseItem, deletePhraseItems,
  reorderPhraseItems, setPhraseNextItem, resetPhrasePool
} = require('./phrase-pools');
const {
  createHandoverPackage, inspectHandoverPackage, importHandoverPackage,
  getPendingHandover, completeHandover
} = require('./handover');
const { CURRENT_VERSION, normalizeRepository, checkForUpdate, downloadUpdate } = require('./update');
const { buildOperationsReport } = require('./operations');

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const publicDir = path.resolve(__dirname, 'public');
const db = openDatabase(process.env.DINGTALK_REMINDER_DB || undefined);

function autoStartEnabled() {
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.wensding.reminder.plist'));
  }
  if (process.platform !== 'win32') return false;
  const localAppData = process.env.LOCALAPPDATA
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local');
  return fs.existsSync(path.join(localAppData, 'DingTalkReminderManager', 'autostart-enabled.json'));
}

function supervised() {
  if (process.env.WENS_DING_SUPERVISED === '1' || (process.platform === 'darwin' && autoStartEnabled())) return true;
  if (process.platform !== 'win32') return false;
  try {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local');
    const pid = Number(fs.readFileSync(path.join(localAppData, 'DingTalkReminderManager', 'watchdog.pid'), 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': contentTypes['.json'],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('提交内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('提交的数据格式不正确');
  }
}

function requiredText(value, label, maxLength) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`请填写${label}`);
  if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return Boolean(value);
  throw new Error('开关字段格式不正确');
}

function calendarExceptions() {
  return db.prepare('SELECT date, type, label FROM calendar_exceptions ORDER BY date ASC').all();
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function scheduleInputFromRow(reminder) {
  return {
    frequency: reminder.frequency,
    runDate: reminder.run_date,
    runTime: reminder.run_time,
    weekday: reminder.weekday,
    calendarMode: reminder.calendar_mode || 'calendar_days',
    monthlyWorkdayN: reminder.monthly_workday_n || 1,
    skipHolidays: Boolean(reminder.skip_holidays),
    pauseDates: JSON.parse(reminder.pause_dates_json || '[]'),
    pauseRanges: JSON.parse(reminder.pause_ranges_json || '[]')
  };
}

function calculateNextForRow(reminder, now = new Date()) {
  return calculateNextCalendarRun(scheduleInputFromRow(reminder), now, calendarExceptions());
}

function recomputeEnabledReminders() {
  const timestamp = nowIso();
  const rows = db.prepare('SELECT * FROM reminders WHERE enabled = 1').all();
  const update = db.prepare(`
    UPDATE reminders SET next_run_at = ?, enabled = ?, status = ? WHERE id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    rows.forEach((reminder) => {
      const nextRunAt = calculateNextForRow(reminder);
      const stillActive = Boolean(nextRunAt);
      update.run(nextRunAt, stillActive ? 1 : 0, stillActive ? 'active' : 'complete', reminder.id);
    });
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('calendar_recomputed_at', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(timestamp, timestamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function validateReminder(body) {
  const name = requiredText(body.name, '提醒名称', 100);
  const sourceType = body.sourceType === 'pool_rule' ? 'pool_rule' : 'fixed';
  const message = sourceType === 'fixed' ? requiredText(body.message, '消息内容', 5000) : String(body.message || '').trim().slice(0, 5000);
  const contentRuleId = sourceType === 'pool_rule' ? Number(body.contentRuleId) : null;
  if (sourceType === 'pool_rule' && (!Number.isInteger(contentRuleId) || !db.prepare('SELECT 1 FROM content_rules WHERE id = ? AND enabled = 1').get(contentRuleId))) {
    throw new Error('请选择有效的内容池规则');
  }
  const robotId = Number(body.robotId);
  if (!Number.isInteger(robotId) || !db.prepare('SELECT 1 FROM robots WHERE id = ?').get(robotId)) {
    throw new Error('请选择有效的机器人');
  }
  const frequency = String(body.frequency || '');
  if (!['once', 'daily', 'weekly'].includes(frequency)) throw new Error('请选择重复规则');
  const runTime = String(body.runTime || '');
  parseTime(runTime);
  const runDate = frequency === 'once' ? String(body.runDate || '') : null;
  if (frequency === 'once' && !parseDateKey(runDate)) {
    throw new Error('请选择一次性提醒的发送日期');
  }
  const weekday = frequency === 'weekly' ? Number(body.weekday) : null;
  const missedPolicy = body.missedPolicy === 'catch_up' ? 'catch_up' : 'skip';
  const enabled = toBoolean(body.enabled, true);
  const calendarMode = ['calendar_days', 'workdays', 'monthly_workday'].includes(body.calendarMode) ? body.calendarMode : 'calendar_days';
  if (calendarMode === 'monthly_workday' && frequency !== 'daily') {
    throw new Error('“每月第 N 个工作日”是独立规则，请把重复规则选择为“每天”');
  }
  const monthlyWorkdayN = Number(body.monthlyWorkdayN || 1);
  if (!Number.isInteger(monthlyWorkdayN) || monthlyWorkdayN < 1 || monthlyWorkdayN > 23) {
    throw new Error('每月工作日序号必须是 1 到 23 的整数');
  }
  const pauseDates = parseList(body.pauseDates);
  if (pauseDates.some((item) => !parseDateKey(item))) throw new Error('指定暂停日期格式不正确');
  const pauseRanges = parseList(body.pauseRanges);
  pauseRanges.forEach((range) => {
    const [start, end, extra] = String(range).split('~').map((item) => item.trim());
    if (extra !== undefined || !parseDateKey(start) || !parseDateKey(end)) throw new Error('暂停日期段格式应为 YYYY-MM-DD~YYYY-MM-DD');
    if (start > end) throw new Error('暂停日期段的结束日期不能早于开始日期');
  });
  const skipHolidays = toBoolean(body.skipHolidays);
  const nextRunAt = enabled ? calculateNextCalendarRun({ frequency, runDate, runTime, weekday, calendarMode, monthlyWorkdayN, pauseDates, pauseRanges, skipHolidays }, new Date(), calendarExceptions()) : null;
  if (frequency === 'once' && enabled && !nextRunAt) throw new Error('一次性提醒时间必须晚于现在');
  const messageFormat = normalizeMessageFormat(body.messageFormat);
  const messageTitle = String(body.messageTitle || '').trim().slice(0, 100);
  const mentionMobiles = parseMentionMobiles(body.mentionMobiles);

  return {
    name,
    message,
    sourceType,
    contentRuleId,
    robotId,
    frequency,
    runDate,
    runTime,
    weekday,
    atAll: toBoolean(body.atAll),
    messageFormat,
    messageTitle,
    mentionMobiles,
    enabled,
    missedPolicy,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    nextRunAt,
    status: enabled ? 'active' : 'paused',
    calendarMode, monthlyWorkdayN, skipHolidays, pauseDates, pauseRanges,
    previewConfirmRequired: toBoolean(body.previewConfirmRequired)
  };
}

async function handleRobots(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/robots') {
    json(response, 200, { robots: listRobots(db) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/robots') {
    const body = await readJson(request);
    const name = requiredText(body.name, '机器人名称', 100);
    const keyword = requiredText(body.keyword || '定时通知', '安全关键词', 100);
    const webhook = validateWebhook(body.webhook);
    const secret = String(body.secret || '').trim();
    if (secret.length > 500) throw new Error('签名密钥长度不正确');
    const timestamp = nowIso();
    const webhookEncrypted = await protectText(webhook);
    const secretEncrypted = secret ? await protectText(secret) : null;
    const result = db.prepare(`
      INSERT INTO robots (name, webhook_encrypted, webhook_hint, keyword, secret_encrypted, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, webhookEncrypted, webhookHint(webhook), keyword, secretEncrypted, toBoolean(body.enabled, true) ? 1 : 0, timestamp, timestamp);
    const robot = listRobots(db).find((item) => item.id === Number(result.lastInsertRowid));
    json(response, 201, { robot });
    return true;
  }

  const testMatch = /^\/api\/robots\/(\d+)\/test$/.exec(url.pathname);
  if (request.method === 'POST' && testMatch) {
    const id = Number(testMatch[1]);
    const robot = db.prepare('SELECT * FROM robots WHERE id = ?').get(id);
    if (!robot) throw new Error('机器人不存在');
    const body = await readJson(request);
    let content;
    if (body.contentRuleId) {
      content = previewRule(db, Number(body.contentRuleId), Number(body.weekday ?? new Date().getDay()), robot.keyword).message;
    } else {
      content = ensureKeyword(body.message || '连接测试\n\n这是一条由 DingDone 发送的测试消息。', robot.keyword);
    }
    const timestamp = nowIso();
    try {
      const webhook = await unprotectText(robot.webhook_encrypted);
      const secret = robot.secret_encrypted ? await unprotectText(robot.secret_encrypted) : null;
      const result = await sendWithRetry({ webhook, secret, content, atAll: Boolean(body.atAll) });
      db.prepare(`UPDATE robots SET last_test_status = 'success', last_test_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, id);
      db.prepare(`
        INSERT INTO send_history
          (reminder_id, robot_id, scheduled_for, sent_at, content_preview, success,
           response_code, response_message, retried, created_at)
        VALUES (NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(id, timestamp, timestamp, content.slice(0, 5000), String(result.errcode), result.errmsg, result.retried ? 1 : 0, timestamp);
      json(response, 200, { ok: true, result: { errcode: result.errcode, errmsg: result.errmsg, attempts: result.attempts } });
      return true;
    } catch (error) {
      db.prepare(`UPDATE robots SET last_test_status = 'failed', last_test_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, id);
      db.prepare(`
        INSERT INTO send_history
          (reminder_id, robot_id, scheduled_for, sent_at, content_preview, success,
           response_code, response_message, retried, created_at)
        VALUES (NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(id, timestamp, timestamp, content.slice(0, 5000), String(error.code || 'TEST_FAILED'), error.message, Number(error.attempts || 1) > 1 ? 1 : 0, timestamp);
      json(response, 400, { error: `测试发送失败：${error.message}` });
      return true;
    }
  }

  const match = /^\/api\/robots\/(\d+)$/.exec(url.pathname);
  if (!match) return false;
  const id = Number(match[1]);
  const existing = db.prepare('SELECT * FROM robots WHERE id = ?').get(id);
  if (!existing) {
    json(response, 404, { error: '机器人不存在' });
    return true;
  }

  if (request.method === 'PATCH') {
    const body = await readJson(request);
    const name = body.name === undefined ? existing.name : requiredText(body.name, '机器人名称', 100);
    const keyword = body.keyword === undefined ? existing.keyword : requiredText(body.keyword, '安全关键词', 100);
    let webhookEncrypted = existing.webhook_encrypted;
    let hint = existing.webhook_hint;
    if (body.webhook) {
      const webhook = validateWebhook(body.webhook);
      webhookEncrypted = await protectText(webhook);
      hint = webhookHint(webhook);
    }
    let secretEncrypted = existing.secret_encrypted;
    if (body.secret !== undefined) {
      const secret = String(body.secret || '').trim();
      secretEncrypted = secret ? await protectText(secret) : null;
    }
    const filledMissingWebhook = Boolean(body.webhook && existing.webhook_hint === '需要重新填写 Webhook');
    const enabled = body.enabled === undefined ? (filledMissingWebhook ? 1 : existing.enabled) : (toBoolean(body.enabled) ? 1 : 0);
    db.prepare(`
      UPDATE robots SET name = ?, keyword = ?, webhook_encrypted = ?, webhook_hint = ?,
        secret_encrypted = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(name, keyword, webhookEncrypted, hint, secretEncrypted, enabled, nowIso(), id);
    json(response, 200, { robot: listRobots(db).find((item) => item.id === id) });
    return true;
  }

  if (request.method === 'DELETE') {
    const count = db.prepare('SELECT COUNT(*) AS total FROM reminders WHERE robot_id = ?').get(id).total;
    if (count > 0) {
      json(response, 409, { error: '这个机器人仍被提醒任务使用，暂时不能删除' });
      return true;
    }
    db.prepare('DELETE FROM robots WHERE id = ?').run(id);
    json(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleReminders(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/reminders') {
    json(response, 200, { reminders: listReminders(db) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/reminders') {
    const item = validateReminder(await readJson(request));
    const timestamp = nowIso();
    const mentionEncrypted = item.mentionMobiles.length ? await protectText(JSON.stringify(item.mentionMobiles)) : null;
    const result = db.prepare(`
      INSERT INTO reminders
        (name, robot_id, message, source_type, content_rule_id, frequency, run_date, run_time, weekday, at_all, enabled,
        missed_policy, timezone, next_run_at, status, message_format, message_title, mention_mobiles_encrypted, mention_hint,
         calendar_mode, monthly_workday_n, skip_holidays, pause_dates_json, pause_ranges_json, preview_confirm_required,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.name, item.robotId, item.message, item.sourceType, item.contentRuleId, item.frequency, item.runDate, item.runTime,
      item.weekday, item.atAll ? 1 : 0, item.enabled ? 1 : 0, item.missedPolicy, item.timezone,
      item.nextRunAt, item.status, item.messageFormat, item.messageTitle, mentionEncrypted, mentionHint(item.mentionMobiles),
      item.calendarMode, item.monthlyWorkdayN, item.skipHolidays ? 1 : 0, JSON.stringify(item.pauseDates), JSON.stringify(item.pauseRanges), item.previewConfirmRequired ? 1 : 0,
      timestamp, timestamp);
    const reminder = listReminders(db).find((row) => row.id === Number(result.lastInsertRowid));
    json(response, 201, { reminder });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/reminders/preview') {
    const item = validateReminder(await readJson(request));
    const robot = db.prepare('SELECT name, keyword FROM robots WHERE id = ?').get(item.robotId);
    const scheduledFor = item.nextRunAt || calculateNextRun({
      frequency: item.frequency,
      runDate: item.runDate,
      runTime: item.runTime,
      weekday: item.weekday
    }) || new Date().toISOString();
    const preview = messageForReminder(db, {
      name: item.name,
      robot_name: robot.name,
      keyword: robot.keyword,
      message: item.message,
      source_type: item.sourceType,
      content_rule_id: item.contentRuleId,
      message_format: item.messageFormat,
      message_title: item.messageTitle
    }, scheduledFor);
    json(response, 200, {
      preview: {
        format: preview.format,
        title: preview.title,
        content: preview.content,
        scheduledFor,
        atAll: item.atAll,
        mentionHint: item.atAll ? '@所有人' : mentionHint(item.mentionMobiles)
      }
    });
    return true;
  }

  const copyMatch = /^\/api\/reminders\/(\d+)\/copy$/.exec(url.pathname);
  if (request.method === 'POST' && copyMatch) {
    const id = Number(copyMatch[1]);
    const existing = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    if (!existing) {
      json(response, 404, { error: '提醒不存在' });
      return true;
    }
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO reminders
        (name, robot_id, message, source_type, content_rule_id, frequency, run_date, run_time, weekday, at_all, enabled,
         missed_policy, timezone, next_run_at, status, message_format, message_title, mention_mobiles_encrypted, mention_hint,
         calendar_mode, monthly_workday_n, skip_holidays, pause_dates_json, pause_ranges_json, preview_confirm_required, preview_confirmed_at,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(`${existing.name}（副本）`, existing.robot_id, existing.message, existing.source_type, existing.content_rule_id, existing.frequency,
      existing.run_date, existing.run_time, existing.weekday, existing.at_all,
      existing.missed_policy, existing.timezone, existing.message_format, existing.message_title,
      existing.mention_mobiles_encrypted, existing.mention_hint,
      existing.calendar_mode, existing.monthly_workday_n, existing.skip_holidays,
      existing.pause_dates_json, existing.pause_ranges_json, existing.preview_confirm_required,
      timestamp, timestamp);
    const reminder = listReminders(db).find((row) => row.id === Number(result.lastInsertRowid));
    json(response, 201, { reminder });
    return true;
  }

  const mentionsMatch = /^\/api\/reminders\/(\d+)\/mentions$/.exec(url.pathname);
  if (request.method === 'GET' && mentionsMatch) {
    const existing = db.prepare('SELECT mention_mobiles_encrypted FROM reminders WHERE id = ?').get(Number(mentionsMatch[1]));
    if (!existing) {
      json(response, 404, { error: '提醒不存在' });
      return true;
    }
    const mentionMobiles = existing.mention_mobiles_encrypted
      ? parseMentionMobiles(JSON.parse(await unprotectText(existing.mention_mobiles_encrypted)))
      : [];
    json(response, 200, { mentionMobiles });
    return true;
  }

  const statusMatch = /^\/api\/reminders\/(\d+)\/status$/.exec(url.pathname);
  if (request.method === 'PATCH' && statusMatch) {
    const id = Number(statusMatch[1]);
    const existing = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    if (!existing) {
      json(response, 404, { error: '提醒不存在' });
      return true;
    }
    const body = await readJson(request);
    const enabled = toBoolean(body.enabled);
    const nextRunAt = enabled ? calculateNextForRow(existing) : null;
    if (enabled && existing.frequency === 'once' && !nextRunAt) throw new Error('这个一次性提醒的时间已经过去，请编辑时间后再启用');
    db.prepare('UPDATE reminders SET enabled = ?, status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, enabled ? 'active' : 'paused', nextRunAt, nowIso(), id);
    json(response, 200, { reminder: listReminders(db).find((row) => row.id === id) });
    return true;
  }

  const confirmPreviewMatch = /^\/api\/reminders\/(\d+)\/confirm-preview$/.exec(url.pathname);
  if (request.method === 'POST' && confirmPreviewMatch) {
    const id = Number(confirmPreviewMatch[1]);
    if (!db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(id)) throw new Error('提醒不存在');
    const timestamp = nowIso();
    db.prepare('UPDATE reminders SET preview_confirmed_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, id);
    json(response, 200, { reminder: listReminders(db).find((row) => row.id === id) });
    return true;
  }

  const match = /^\/api\/reminders\/(\d+)$/.exec(url.pathname);
  if (!match) return false;
  const id = Number(match[1]);
  if (!db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(id)) {
    json(response, 404, { error: '提醒不存在' });
    return true;
  }

  if (request.method === 'PUT') {
    const item = validateReminder(await readJson(request));
    const mentionEncrypted = item.mentionMobiles.length ? await protectText(JSON.stringify(item.mentionMobiles)) : null;
    db.prepare(`
      UPDATE reminders SET name = ?, robot_id = ?, message = ?, source_type = ?, content_rule_id = ?, frequency = ?, run_date = ?,
        run_time = ?, weekday = ?, at_all = ?, enabled = ?, missed_policy = ?, timezone = ?,
        next_run_at = ?, status = ?, message_format = ?, message_title = ?, mention_mobiles_encrypted = ?, mention_hint = ?,
        calendar_mode = ?, monthly_workday_n = ?, skip_holidays = ?, pause_dates_json = ?, pause_ranges_json = ?, preview_confirm_required = ?, preview_confirmed_at = NULL,
        updated_at = ? WHERE id = ?
    `).run(item.name, item.robotId, item.message, item.sourceType, item.contentRuleId, item.frequency, item.runDate, item.runTime,
      item.weekday, item.atAll ? 1 : 0, item.enabled ? 1 : 0, item.missedPolicy, item.timezone,
      item.nextRunAt, item.status, item.messageFormat, item.messageTitle, mentionEncrypted, mentionHint(item.mentionMobiles),
      item.calendarMode, item.monthlyWorkdayN, item.skipHolidays ? 1 : 0, JSON.stringify(item.pauseDates), JSON.stringify(item.pauseRanges), item.previewConfirmRequired ? 1 : 0,
      nowIso(), id);
    json(response, 200, { reminder: listReminders(db).find((row) => row.id === id) });
    return true;
  }

  if (request.method === 'DELETE') {
    db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    json(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleContentPools(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/content-pools') {
    json(response, 200, { pools: listPools(db) });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/content-pools') {
    json(response, 201, { pool: createPool(db, await readJson(request)) });
    return true;
  }

  const itemsMatch = /^\/api\/content-pools\/(\d+)\/items$/.exec(url.pathname);
  if (request.method === 'POST' && itemsMatch) {
    const body = await readJson(request);
    let items = body.items;
    if (!Array.isArray(items) && body.bulkText) {
      const text = String(body.bulkText).trim();
      items = body.splitMode === 'line'
        ? text.split(/\r?\n/)
        : text.split(/\r?\n\s*\r?\n/);
    }
    json(response, 201, { pool: addPoolItems(db, Number(itemsMatch[1]), items) });
    return true;
  }
  if (request.method === 'DELETE' && itemsMatch) {
    const body = await readJson(request);
    json(response, 200, deletePoolItems(db, Number(itemsMatch[1]), body.itemIds, Boolean(body.clearAll)));
    return true;
  }

  const itemMatch = /^\/api\/content-pools\/(\d+)\/items\/(\d+)$/.exec(url.pathname);
  if (itemMatch && request.method === 'PATCH') {
    json(response, 200, { pool: updatePoolItem(db, Number(itemMatch[1]), Number(itemMatch[2]), await readJson(request)) });
    return true;
  }
  if (itemMatch && request.method === 'DELETE') {
    json(response, 200, { pool: deletePoolItem(db, Number(itemMatch[1]), Number(itemMatch[2])) });
    return true;
  }

  const reorderMatch = /^\/api\/content-pools\/(\d+)\/reorder$/.exec(url.pathname);
  if (request.method === 'POST' && reorderMatch) {
    const body = await readJson(request);
    json(response, 200, { pool: reorderPoolItems(db, Number(reorderMatch[1]), body.itemIds) });
    return true;
  }
  const nextMatch = /^\/api\/content-pools\/(\d+)\/next$/.exec(url.pathname);
  if (request.method === 'POST' && nextMatch) {
    const body = await readJson(request);
    json(response, 200, { pool: setPoolNextItem(db, Number(nextMatch[1]), body.itemId) });
    return true;
  }
  const resetMatch = /^\/api\/content-pools\/(\d+)\/reset$/.exec(url.pathname);
  if (request.method === 'POST' && resetMatch) {
    json(response, 200, { pool: resetPoolCycle(db, Number(resetMatch[1])) });
    return true;
  }

  const poolMatch = /^\/api\/content-pools\/(\d+)$/.exec(url.pathname);
  if (!poolMatch) return false;
  const poolId = Number(poolMatch[1]);
  if (request.method === 'GET') {
    json(response, 200, { pool: getPool(db, poolId) });
    return true;
  }
  if (request.method === 'PATCH') {
    json(response, 200, { pool: updatePool(db, poolId, await readJson(request)) });
    return true;
  }
  if (request.method === 'DELETE') {
    const used = db.prepare('SELECT COUNT(*) AS total FROM content_rule_allocations WHERE pool_id = ?').get(poolId).total;
    if (used) {
      json(response, 409, { error: '这个内容池仍被星期规则使用，请先修改规则' });
      return true;
    }
    const result = db.prepare('DELETE FROM content_pools WHERE id = ?').run(poolId);
    if (!result.changes) throw new Error('内容池不存在');
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleContentRules(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/content-rules') {
    json(response, 200, { rules: listRules(db) });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/content-rules') {
    json(response, 201, { rule: saveRule(db, null, await readJson(request)) });
    return true;
  }

  const previewMatch = /^\/api\/content-rules\/(\d+)\/preview$/.exec(url.pathname);
  if (request.method === 'POST' && previewMatch) {
    const body = await readJson(request);
    json(response, 200, { preview: previewRule(db, Number(previewMatch[1]), body.weekday, body.keyword) });
    return true;
  }
  const consumeMatch = /^\/api\/content-rules\/(\d+)\/consume$/.exec(url.pathname);
  if (request.method === 'POST' && consumeMatch) {
    const body = await readJson(request);
    json(response, 200, { result: consumeRule(db, Number(consumeMatch[1]), body.weekday, body.keyword, body.idempotencyKey) });
    return true;
  }

  const ruleMatch = /^\/api\/content-rules\/(\d+)$/.exec(url.pathname);
  if (!ruleMatch) return false;
  const ruleId = Number(ruleMatch[1]);
  if (request.method === 'PUT') {
    json(response, 200, { rule: saveRule(db, ruleId, await readJson(request)) });
    return true;
  }
  if (request.method === 'DELETE') {
    const reminderCount = db.prepare("SELECT COUNT(*) AS total FROM reminders WHERE source_type = 'pool_rule' AND content_rule_id = ?").get(ruleId).total;
    if (reminderCount) {
      json(response, 409, { error: '这个星期规则仍被提醒任务使用，请先修改或删除相关提醒' });
      return true;
    }
    const result = db.prepare('DELETE FROM content_rules WHERE id = ?').run(ruleId);
    if (!result.changes) throw new Error('内容规则不存在');
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handlePhrasePools(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/phrase-pools') {
    json(response, 200, { pools: listPhrasePools(db) });
    return true;
  }
  const itemsMatch = /^\/api\/phrase-pools\/(greeting|opening|closing)\/items$/.exec(url.pathname);
  if (request.method === 'POST' && itemsMatch) {
    const body = await readJson(request);
    let items = body.items;
    if (!Array.isArray(items) && body.bulkText) {
      const text = String(body.bulkText).trim();
      items = body.splitMode === 'line' ? text.split(/\r?\n/) : text.split(/\r?\n\s*\r?\n/);
    }
    json(response, 201, { pool: addPhraseItems(db, itemsMatch[1], items) });
    return true;
  }
  if (request.method === 'DELETE' && itemsMatch) {
    const body = await readJson(request);
    json(response, 200, deletePhraseItems(db, itemsMatch[1], body.itemIds, Boolean(body.clearAll)));
    return true;
  }
  const itemMatch = /^\/api\/phrase-pools\/(greeting|opening|closing)\/items\/(\d+)$/.exec(url.pathname);
  if (itemMatch && request.method === 'PATCH') {
    json(response, 200, { pool: updatePhraseItem(db, itemMatch[1], Number(itemMatch[2]), await readJson(request)) });
    return true;
  }
  if (itemMatch && request.method === 'DELETE') {
    json(response, 200, { pool: deletePhraseItem(db, itemMatch[1], Number(itemMatch[2])) });
    return true;
  }
  const reorderMatch = /^\/api\/phrase-pools\/(greeting|opening|closing)\/reorder$/.exec(url.pathname);
  if (request.method === 'POST' && reorderMatch) {
    const body = await readJson(request);
    json(response, 200, { pool: reorderPhraseItems(db, reorderMatch[1], body.itemIds) });
    return true;
  }
  const nextMatch = /^\/api\/phrase-pools\/(greeting|opening|closing)\/next$/.exec(url.pathname);
  if (request.method === 'POST' && nextMatch) {
    const body = await readJson(request);
    json(response, 200, { pool: setPhraseNextItem(db, nextMatch[1], body.itemId) });
    return true;
  }
  const resetMatch = /^\/api\/phrase-pools\/(greeting|opening|closing)\/reset$/.exec(url.pathname);
  if (request.method === 'POST' && resetMatch) {
    json(response, 200, { pool: resetPhrasePool(db, resetMatch[1]) });
    return true;
  }
  return false;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/security') {
    const keys = ['global_emergency_stop', 'pause_today', 'queue_seconds', 'duplicate_detection', 'duplicate_window_minutes', 'same_robot_limit', 'same_robot_window_minutes', 'failure_pause_threshold'];
    const settings = Object.fromEntries(keys.map((key) => [key, getSetting(db, key, '')]));
    json(response, 200, { settings, exceptions: calendarExceptions() });
    return true;
  }
  if (request.method === 'PUT' && url.pathname === '/api/security') {
    const body = await readJson(request);
    const allowed = ['global_emergency_stop', 'pause_today', 'queue_seconds', 'duplicate_detection', 'duplicate_window_minutes', 'same_robot_limit', 'same_robot_window_minutes', 'failure_pause_threshold'];
    for (const key of allowed) if (body[key] !== undefined) setSetting(db, key, typeof body[key] === 'boolean' ? String(body[key]) : String(body[key]));
    json(response, 200, { settings: Object.fromEntries(allowed.map((key) => [key, getSetting(db, key, '')])) });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/calendar/exceptions') {
    json(response, 200, { exceptions: calendarExceptions() });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/calendar/exceptions') {
    const body = await readJson(request);
    const date = String(body.date || '');
    if (!parseDateKey(date)) throw new Error('日期格式应为 YYYY-MM-DD');
    const type = ['holiday', 'workday', 'pause'].includes(body.type) ? body.type : 'holiday';
    const timestamp = nowIso();
    db.prepare(`INSERT INTO calendar_exceptions(date, type, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET type = excluded.type, label = excluded.label, updated_at = excluded.updated_at`).run(date, type, String(body.label || '').slice(0, 100), timestamp, timestamp);
    recomputeEnabledReminders();
    json(response, 200, { exceptions: calendarExceptions() });
    return true;
  }
  const exceptionMatch = /^\/api\/calendar\/exceptions\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  if (request.method === 'DELETE' && exceptionMatch) {
    db.prepare('DELETE FROM calendar_exceptions WHERE date = ?').run(exceptionMatch[1]);
    recomputeEnabledReminders();
    json(response, 200, { exceptions: calendarExceptions() });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/operations') {
    const sendingEnabled = getSetting(db, 'sending_enabled', 'false') === 'true';
    json(response, 200, buildOperationsReport({
      robots: listRobots(db),
      reminders: listReminders(db),
      history: listHistory(db),
      pools: listPools(db),
      exceptions: calendarExceptions(),
      sendingEnabled,
      autoStartEnabled: autoStartEnabled(),
      supervised: supervised()
    }));
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/update/file') {
    const requestedName = String(url.searchParams.get('name') || '');
    const safeName = path.basename(requestedName);
    if (!safeName || safeName !== requestedName) throw new Error('下载文件名不正确');
    const filePath = path.join(path.dirname(db.location()), 'updates', safeName);
    if (!fs.existsSync(filePath)) throw new Error('下载文件不存在，请重新检查更新');
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(filePath).size,
      'Content-Disposition': `attachment; filename="${safeName.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/update') {
    json(response, 200, {
      currentVersion: CURRENT_VERSION,
      repository: getSetting(db, 'update_repository', '')
    });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/config') {
    const body = await readJson(request);
    const repository = normalizeRepository(body.repository);
    setSetting(db, 'update_repository', repository);
    json(response, 200, { currentVersion: CURRENT_VERSION, repository });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/check') {
    const repository = getSetting(db, 'update_repository', '');
    if (!repository) throw new Error('请先填写用于发布新版的 GitHub 仓库');
    json(response, 200, await checkForUpdate(repository));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/download') {
    const repository = getSetting(db, 'update_repository', '');
    if (!repository) throw new Error('请先填写用于发布新版的 GitHub 仓库');
    const result = await downloadUpdate(repository, path.join(path.dirname(db.location()), 'updates'));
    json(response, 200, {
      name: result.downloadedFile.name,
      digest: result.downloadedFile.digest,
      downloadUrl: `/api/update/file?name=${encodeURIComponent(result.downloadedFile.name)}`
    });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/handover/export') {
    const body = await readJson(request);
    const result = await createHandoverPackage(db, {
      password: body.password,
      includeWebhooks: Boolean(body.includeWebhooks)
    });
    json(response, 200, result);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/handover/inspect') {
    const body = await readJson(request);
    json(response, 200, { summary: inspectHandoverPackage(body.package, body.password) });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/handover/import') {
    const body = await readJson(request);
    const result = await importHandoverPackage(db, body.package, body.password, { confirm: body.confirm });
    json(response, 200, { ...result, backupCreated: Boolean(result.backupPath), backupPath: undefined });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/handover/complete') {
    const body = await readJson(request);
    json(response, 200, completeHandover(db, body.confirm));
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const sendingEnabled = getSetting(db, 'sending_enabled', 'false') === 'true';
    const pendingHandover = getPendingHandover(db);
    json(response, 200, {
      ok: true,
      databaseReady: true,
      sendingEnabled,
      autoStartEnabled: autoStartEnabled(),
      supervised: supervised(),
      currentVersion: CURRENT_VERSION,
      handoverPending: Boolean(pendingHandover),
      handoverImportedAt: pendingHandover?.importedAt || null,
      contentPoolsReady: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
    });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 50) || 50));
    json(response, 200, { history: listHistory(db, limit) });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/settings') {
    json(response, 200, { sendingEnabled: getSetting(db, 'sending_enabled', 'false') === 'true' });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/settings/sending') {
    const body = await readJson(request);
    const enabled = Boolean(body.enabled);
    if (enabled) {
      if (getPendingHandover(db)) throw new Error('交接配置仍在等待确认，请先完成机器人测试并点击“本机正式接管”');
      if (body.confirm !== 'ENABLE_REAL_SENDING') throw new Error('启用真实发送需要明确确认');
      const tested = db.prepare("SELECT COUNT(*) AS total FROM robots WHERE enabled = 1 AND last_test_status = 'success'").get().total;
      if (!tested) throw new Error('请先选择机器人完成一次测试发送');
    }
    setSetting(db, 'sending_enabled', enabled ? 'true' : 'false');
    json(response, 200, { sendingEnabled: enabled });
    return true;
  }
  if (await handleContentPools(request, response, url)) return true;
  if (await handlePhrasePools(request, response, url)) return true;
  if (await handleContentRules(request, response, url)) return true;
  if (await handleRobots(request, response, url)) return true;
  if (await handleReminders(request, response, url)) return true;
  return false;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || host}`);
  try {
    if (url.pathname === '/health') {
      json(response, 200, {
        ok: true,
        appId: 'wens-ding',
        version: CURRENT_VERSION,
        instancePath: path.resolve(__dirname, '..')
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!await handleApi(request, response, url)) json(response, 404, { error: '接口不存在' });
      return;
    }

    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(publicDir, `.${decodeURIComponent(requestedPath)}`);
    if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500);
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(data);
    });
  } catch (error) {
    const duplicateName = error.code === 'ERR_SQLITE_ERROR' && String(error.message).includes('UNIQUE constraint failed: robots.name');
    json(response, duplicateName ? 409 : 400, {
      error: duplicateName ? '机器人名称已存在，请换一个名称' : error.message
    });
  }
}

const server = http.createServer(handleRequest);
const scheduler = startScheduler(db);
server.listen(port, host, () => {
  console.log(`DingTalk Reminder Manager: http://${host}:${port}`);
});

function shutdown() {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
