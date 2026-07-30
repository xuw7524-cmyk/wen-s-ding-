const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');
const { protectText, unprotectText, validateWebhook, webhookHint } = require('./security');
const { calculateNextCalendarRun } = require('./schedule');
const { normalizeRepository } = require('./update');
const { parseMentionMobiles, mentionHint } = require('./message-template');

const PACKAGE_FORMAT = 'wens-ding-handover';
const PACKAGE_VERSION = 1;
const AAD = Buffer.from('Wens Ding portable handover v1', 'utf8');
const CONFIG_TABLES = [
  'content_pools', 'content_items', 'content_rules', 'content_rule_allocations',
  'phrase_pools', 'phrase_items', 'reminders'
];
const SAFETY_SETTING_KEYS = [
  'global_emergency_stop', 'pause_today', 'queue_seconds', 'duplicate_detection',
  'duplicate_window_minutes', 'same_robot_limit', 'same_robot_window_minutes',
  'failure_pause_threshold'
];

function requirePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new Error('交接密码至少需要 8 个字符');
  if (password.length > 200) throw new Error('交接密码过长');
  return password;
}

function encryptPackage(payload, passwordInput) {
  const password = requirePassword(passwordInput);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    encryption: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decodeBase64Field(container, name, expectedLength = null) {
  const value = String(container?.[name] || '');
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('交接文件已损坏或格式不完整');
  const buffer = Buffer.from(value, 'base64');
  if (expectedLength !== null && buffer.length !== expectedLength) throw new Error('交接文件已损坏或格式不完整');
  return buffer;
}

function validatePayload(payload) {
  if (!payload || payload.format !== PACKAGE_FORMAT || payload.version !== PACKAGE_VERSION) {
    throw new Error('这不是当前版本支持的 Wen\'s Ding 交接文件');
  }
  if (!payload.tables || !Array.isArray(payload.robots)) throw new Error('交接文件缺少配置数据');
  for (const table of CONFIG_TABLES) {
    if (!Array.isArray(payload.tables[table])) throw new Error(`交接文件缺少 ${table} 数据`);
  }
  if (payload.robots.length > 500 || payload.tables.reminders.length > 5000) throw new Error('交接文件中的配置数量异常');
  return payload;
}

function decryptPackage(container, passwordInput) {
  const password = requirePassword(passwordInput);
  if (!container || container.format !== PACKAGE_FORMAT || container.version !== PACKAGE_VERSION) {
    throw new Error('请选择有效的 .wensding 交接文件');
  }
  try {
    const salt = decodeBase64Field(container, 'salt', 16);
    const iv = decodeBase64Field(container, 'iv', 12);
    const tag = decodeBase64Field(container, 'tag', 16);
    const ciphertext = decodeBase64Field(container, 'ciphertext');
    const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return validatePayload(JSON.parse(plain));
  } catch (error) {
    if (String(error.message).includes('交接文件') || String(error.message).includes('Wen\'s Ding')) throw error;
    throw new Error('交接密码不正确，或交接文件已经损坏');
  }
}

function tableRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function summarizePayload(payload) {
  return {
    exportedAt: payload.exportedAt,
    sourcePlatform: payload.sourcePlatform,
    includesWebhooks: Boolean(payload.includesWebhooks),
    robots: payload.robots.length,
    reminders: payload.tables.reminders.length,
    contentPools: payload.tables.content_pools.length,
    contentItems: payload.tables.content_items.length,
    phraseItems: payload.tables.phrase_items.length,
    rules: payload.tables.content_rules.length,
    calendarExceptions: Array.isArray(payload.calendarExceptions) ? payload.calendarExceptions.length : 0,
    includesSafetySettings: Boolean(payload.safetySettings),
    desiredActiveReminders: payload.desiredActiveReminderIds.length
  };
}

async function createHandoverPackage(db, options = {}) {
  const includeWebhooks = Boolean(options.includeWebhooks);
  const unprotect = options.unprotect || unprotectText;
  const rawRobots = tableRows(db, 'robots');
  const robots = [];
  for (const robot of rawRobots) {
    robots.push({
      id: robot.id,
      name: robot.name,
      keyword: robot.keyword,
      enabled: Boolean(robot.enabled),
      webhook: includeWebhooks ? await unprotect(robot.webhook_encrypted) : null,
      secret: includeWebhooks && robot.secret_encrypted ? await unprotect(robot.secret_encrypted) : null,
      createdAt: robot.created_at,
      updatedAt: robot.updated_at
    });
  }
  const tables = Object.fromEntries(CONFIG_TABLES.map((table) => [table, tableRows(db, table)]));
  for (const reminder of tables.reminders) {
    reminder.mention_mobiles = reminder.mention_mobiles_encrypted
      ? JSON.parse(await unprotect(reminder.mention_mobiles_encrypted))
      : [];
    reminder.mention_mobiles_encrypted = null;
  }
  const desiredActiveReminderIds = tables.reminders
    .filter((item) => item.enabled && item.status === 'active')
    .map((item) => item.id);
  const payload = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    sourcePlatform: process.platform,
    includesWebhooks: includeWebhooks,
    desiredSendingEnabled: db.prepare("SELECT value FROM app_settings WHERE key = 'sending_enabled'").get()?.value === 'true',
    updateRepository: db.prepare("SELECT value FROM app_settings WHERE key = 'update_repository'").get()?.value || '',
    desiredActiveReminderIds,
    calendarExceptions: tableRows(db, 'calendar_exceptions'),
    safetySettings: Object.fromEntries(SAFETY_SETTING_KEYS.map((key) => [
      key,
      db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? ''
    ])),
    robots,
    tables
  };
  return {
    fileName: `DingDone-handover-${new Date().toISOString().slice(0, 10)}.wensding`,
    package: encryptPackage(payload, options.password),
    summary: summarizePayload(payload)
  };
}

function inspectHandoverPackage(container, password) {
  return summarizePayload(decryptPackage(container, password));
}

function insertRow(db, table, row) {
  const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const keys = Object.keys(row).filter((key) => allowed.has(key));
  if (!keys.length) throw new Error(`无法导入 ${table} 数据`);
  const placeholders = keys.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`).run(...keys.map((key) => row[key]));
}

async function createImportBackup(db) {
  const databasePath = db.location();
  const backupDir = path.join(path.dirname(databasePath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `before-handover-import-${stamp}.db`);
  await backup(db, backupPath);
  return backupPath;
}

async function importHandoverPackage(db, container, password, options = {}) {
  if (options.confirm !== 'REPLACE_AND_PAUSE') throw new Error('导入交接包需要明确确认');
  const payload = decryptPackage(container, password);
  const protect = options.protect || protectText;
  const timestamp = new Date().toISOString();
  const robotRows = [];
  for (const robot of payload.robots) {
    const portableWebhook = payload.includesWebhooks && robot.webhook ? validateWebhook(robot.webhook) : null;
    const hasWebhook = Boolean(portableWebhook);
    robotRows.push({
      id: robot.id,
      name: String(robot.name || '').slice(0, 100),
      webhook_encrypted: await protect(hasWebhook ? portableWebhook : 'MISSING_WEBHOOK'),
      webhook_hint: hasWebhook ? webhookHint(portableWebhook) : '需要重新填写 Webhook',
      keyword: String(robot.keyword || '定时通知').slice(0, 100),
      secret_encrypted: hasWebhook && robot.secret ? await protect(robot.secret) : null,
      enabled: hasWebhook && robot.enabled ? 1 : 0,
      last_test_status: 'not_tested',
      last_test_at: null,
      created_at: robot.createdAt || timestamp,
      updated_at: timestamp
    });
  }
  const reminderRows = [];
  for (const source of payload.tables.reminders) {
    const portableMentions = parseMentionMobiles(Array.isArray(source.mention_mobiles) ? source.mention_mobiles : []);
    reminderRows.push({
      ...source,
      mention_mobiles_encrypted: portableMentions.length ? await protect(JSON.stringify(portableMentions)) : null,
      mention_hint: mentionHint(portableMentions)
    });
  }

  const backupPath = options.skipBackup ? null : await createImportBackup(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DELETE FROM run_executions;
      DELETE FROM send_history;
      DELETE FROM content_consumptions;
      DELETE FROM reminders;
      DELETE FROM content_rule_allocations;
      DELETE FROM content_rules;
      DELETE FROM content_items;
      DELETE FROM content_pools;
      DELETE FROM phrase_items;
      DELETE FROM phrase_pools;
      DELETE FROM calendar_exceptions;
      DELETE FROM robots;
    `);
    for (const table of ['content_pools', 'content_items', 'content_rules', 'content_rule_allocations', 'phrase_pools', 'phrase_items']) {
      payload.tables[table].forEach((row) => insertRow(db, table, row));
    }
    robotRows.forEach((row) => insertRow(db, 'robots', row));
    (Array.isArray(payload.calendarExceptions) ? payload.calendarExceptions : [])
      .forEach((row) => insertRow(db, 'calendar_exceptions', row));
    reminderRows.forEach((source) => {
      insertRow(db, 'reminders', {
        ...source,
        enabled: 0,
        status: 'paused',
        next_run_at: null,
        last_result: 'waiting',
        updated_at: timestamp
      });
    });
    const pending = {
      importedAt: timestamp,
      includesWebhooks: Boolean(payload.includesWebhooks),
      desiredSendingEnabled: Boolean(payload.desiredSendingEnabled),
      desiredActiveReminderIds: payload.desiredActiveReminderIds
    };
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('sending_enabled', 'false', ?)
      ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`).run(timestamp);
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('handover_pending', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(pending), timestamp);
    if (payload.updateRepository) {
      const repository = normalizeRepository(payload.updateRepository);
      db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('update_repository', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(repository, timestamp);
    }
    if (payload.safetySettings && typeof payload.safetySettings === 'object') {
      const saveSetting = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      SAFETY_SETTING_KEYS.forEach((key) => {
        if (payload.safetySettings[key] !== undefined) {
          saveSetting.run(key, String(payload.safetySettings[key]), timestamp);
        }
      });
    }
    db.exec('COMMIT');
    return { summary: summarizePayload(payload), backupPath, pending: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getPendingHandover(db) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'handover_pending'").get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function completeHandover(db, confirm) {
  if (confirm !== 'OLD_DEVICE_STOPPED_AND_TAKE_OVER') throw new Error('正式接管需要明确确认旧电脑已经停止发送');
  const pending = getPendingHandover(db);
  if (!pending) throw new Error('当前没有等待接管的交接配置');
  const desiredIds = [...new Set((pending.desiredActiveReminderIds || []).map(Number).filter(Number.isInteger))];
  if (desiredIds.length) {
    const placeholders = desiredIds.map(() => '?').join(',');
    const untested = db.prepare(`
      SELECT DISTINCT b.name FROM reminders r JOIN robots b ON b.id = r.robot_id
      WHERE r.id IN (${placeholders}) AND b.last_test_status != 'success'
    `).all(...desiredIds);
    if (untested.length) throw new Error(`请先在这台电脑测试机器人：${untested.map((item) => item.name).join('、')}`);
  }
  const timestamp = new Date().toISOString();
  const exceptions = db.prepare('SELECT date, type, label FROM calendar_exceptions ORDER BY date ASC').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    let activatedReminders = 0;
    desiredIds.forEach((id) => {
      const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
      if (!reminder) return;
      const nextRunAt = calculateNextCalendarRun({
        frequency: reminder.frequency,
        runDate: reminder.run_date,
        runTime: reminder.run_time,
        weekday: reminder.weekday,
        calendarMode: reminder.calendar_mode || 'calendar_days',
        monthlyWorkdayN: reminder.monthly_workday_n || 1,
        skipHolidays: Boolean(reminder.skip_holidays),
        pauseDates: JSON.parse(reminder.pause_dates_json || '[]'),
        pauseRanges: JSON.parse(reminder.pause_ranges_json || '[]')
      }, new Date(), exceptions);
      if (nextRunAt) {
        db.prepare("UPDATE reminders SET enabled = 1, status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(nextRunAt, timestamp, id);
        activatedReminders += 1;
      } else {
        db.prepare("UPDATE reminders SET enabled = 0, status = 'complete', next_run_at = NULL, updated_at = ? WHERE id = ?")
          .run(timestamp, id);
      }
    });
    const enableSending = Boolean(pending.desiredSendingEnabled && activatedReminders);
    db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'sending_enabled'")
      .run(enableSending ? 'true' : 'false', timestamp);
    db.prepare("DELETE FROM app_settings WHERE key = 'handover_pending'").run();
    db.exec('COMMIT');
    return { pending: false, sendingEnabled: enableSending, activatedReminders };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  encryptPackage,
  decryptPackage,
  createHandoverPackage,
  inspectHandoverPackage,
  importHandoverPackage,
  getPendingHandover,
  completeHandover
};
