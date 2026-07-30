const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function defaultDatabasePath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  if (env.DINGTALK_REMINDER_DB) return path.resolve(env.DINGTALK_REMINDER_DB);
  if (env.DINGTALK_REMINDER_PRODUCTION === '1') {
    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'WensDing', 'data', 'reminders.db');
    }
    const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || process.cwd(), 'AppData', 'Local');
    return path.join(base, 'DingTalkReminderManager', 'data', 'reminders.db');
  }
  return path.resolve(__dirname, '..', 'data', 'reminders.db');
}

function initializeProductionDatabase(filePath) {
  if (fs.existsSync(filePath)) return false;
  const seedPath = process.env.DINGTALK_REMINDER_SEED_DB
    ? path.resolve(process.env.DINGTALK_REMINDER_SEED_DB)
    : path.resolve(__dirname, '..', 'seed', 'starter.db');
  if (process.env.DINGTALK_REMINDER_PRODUCTION !== '1' || !fs.existsSync(seedPath)) return false;
  fs.copyFileSync(seedPath, filePath, fs.constants.COPYFILE_EXCL);
  return true;
}

function openDatabase(filePath = defaultDatabasePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  initializeProductionDatabase(filePath);
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS robots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      webhook_encrypted TEXT NOT NULL,
      webhook_hint TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '定时通知',
      secret_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_test_status TEXT NOT NULL DEFAULT 'not_tested',
      last_test_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      robot_id INTEGER NOT NULL REFERENCES robots(id) ON DELETE RESTRICT,
      message TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly')),
      run_date TEXT,
      run_time TEXT NOT NULL,
      weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
      at_all INTEGER NOT NULL DEFAULT 0 CHECK (at_all IN (0, 1)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      missed_policy TEXT NOT NULL DEFAULT 'skip' CHECK (missed_policy IN ('catch_up', 'skip')),
      timezone TEXT NOT NULL DEFAULT 'Asia/Hong_Kong',
      next_run_at TEXT,
      last_run_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'complete', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS send_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
      robot_id INTEGER REFERENCES robots(id) ON DELETE SET NULL,
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
      content_preview TEXT NOT NULL,
      success INTEGER CHECK (success IN (0, 1)),
      response_code TEXT,
      response_message TEXT,
      retried INTEGER NOT NULL DEFAULT 0 CHECK (retried IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE (reminder_id, scheduled_for)
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_history_created ON send_history(created_at DESC);

    CREATE TABLE IF NOT EXISTS content_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      current_cycle INTEGER NOT NULL DEFAULT 1 CHECK (current_cycle >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id INTEGER NOT NULL REFERENCES content_pools(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_used_cycle INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (pool_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS content_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      message_title TEXT NOT NULL DEFAULT '每日风险提醒',
      opening TEXT NOT NULL DEFAULT '',
      closing TEXT NOT NULL DEFAULT '',
      output_mode TEXT NOT NULL DEFAULT 'combine' CHECK (output_mode IN ('combine', 'separate')),
      layout_mode TEXT NOT NULL DEFAULT 'balanced',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_rule_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES content_rules(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      slot_order INTEGER NOT NULL CHECK (slot_order >= 1),
      pool_id INTEGER NOT NULL REFERENCES content_pools(id) ON DELETE RESTRICT,
      item_count INTEGER NOT NULL DEFAULT 1 CHECK (item_count BETWEEN 1 AND 50),
      UNIQUE (rule_id, weekday, slot_order)
    );

    CREATE TABLE IF NOT EXISTS content_consumptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      rule_id INTEGER NOT NULL REFERENCES content_rules(id) ON DELETE RESTRICT,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      selections_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_content_items_pool_order ON content_items(pool_id, enabled, sort_order);
    CREATE INDEX IF NOT EXISTS idx_rule_allocations_day ON content_rule_allocations(rule_id, weekday, slot_order);

    CREATE TABLE IF NOT EXISTS phrase_pools (
      kind TEXT PRIMARY KEY CHECK (kind IN ('greeting', 'opening', 'closing')),
      display_name TEXT NOT NULL,
      current_cycle INTEGER NOT NULL DEFAULT 1 CHECK (current_cycle >= 1),
      last_item_id INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phrase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL REFERENCES phrase_pools(kind) ON DELETE CASCADE,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_used_cycle INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_phrase_items_kind ON phrase_items(kind, enabled, id);

    CREATE TABLE IF NOT EXISTS run_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      scheduled_for TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'sending', 'success', 'failed', 'skipped')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      content_preview TEXT NOT NULL DEFAULT '',
      response_code TEXT,
      response_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (reminder_id, scheduled_for)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_exceptions (
      date TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('holiday', 'workday', 'pause')),
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
      VALUES ('sending_enabled', 'false', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
      VALUES ('scheduler_interval_seconds', '15', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('global_emergency_stop', 'false', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('pause_today', '', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('queue_seconds', '0', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('duplicate_detection', 'true', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('duplicate_window_minutes', '60', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('same_robot_limit', '3', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('same_robot_window_minutes', '10', datetime('now'));
    INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('failure_pause_threshold', '3', datetime('now'));

    INSERT OR IGNORE INTO phrase_pools (kind, display_name, current_cycle, updated_at)
      VALUES ('greeting', '称呼池', 1, datetime('now'));
    INSERT OR IGNORE INTO phrase_pools (kind, display_name, current_cycle, updated_at)
      VALUES ('opening', '开头话术池', 1, datetime('now'));
    INSERT OR IGNORE INTO phrase_pools (kind, display_name, current_cycle, updated_at)
      VALUES ('closing', '结束语池', 1, datetime('now'));
  `);

  const reminderColumns = new Set(db.prepare('PRAGMA table_info(reminders)').all().map((column) => column.name));
  if (!reminderColumns.has('source_type')) {
    db.exec("ALTER TABLE reminders ADD COLUMN source_type TEXT NOT NULL DEFAULT 'fixed'");
  }
  if (!reminderColumns.has('content_rule_id')) {
    db.exec('ALTER TABLE reminders ADD COLUMN content_rule_id INTEGER');
  }
  if (!reminderColumns.has('last_result')) {
    db.exec("ALTER TABLE reminders ADD COLUMN last_result TEXT NOT NULL DEFAULT 'waiting'");
  }
  if (!reminderColumns.has('message_format')) {
    db.exec("ALTER TABLE reminders ADD COLUMN message_format TEXT NOT NULL DEFAULT 'text'");
  }
  if (!reminderColumns.has('message_title')) {
    db.exec("ALTER TABLE reminders ADD COLUMN message_title TEXT NOT NULL DEFAULT ''");
  }
  if (!reminderColumns.has('mention_mobiles_encrypted')) {
    db.exec('ALTER TABLE reminders ADD COLUMN mention_mobiles_encrypted TEXT');
  }
  if (!reminderColumns.has('mention_hint')) {
    db.exec("ALTER TABLE reminders ADD COLUMN mention_hint TEXT NOT NULL DEFAULT ''");
  }
  if (!reminderColumns.has('calendar_mode')) db.exec("ALTER TABLE reminders ADD COLUMN calendar_mode TEXT NOT NULL DEFAULT 'calendar_days'");
  if (!reminderColumns.has('monthly_workday_n')) db.exec('ALTER TABLE reminders ADD COLUMN monthly_workday_n INTEGER NOT NULL DEFAULT 1');
  if (!reminderColumns.has('skip_holidays')) db.exec('ALTER TABLE reminders ADD COLUMN skip_holidays INTEGER NOT NULL DEFAULT 0');
  if (!reminderColumns.has('pause_dates_json')) db.exec("ALTER TABLE reminders ADD COLUMN pause_dates_json TEXT NOT NULL DEFAULT '[]'");
  if (!reminderColumns.has('pause_ranges_json')) db.exec("ALTER TABLE reminders ADD COLUMN pause_ranges_json TEXT NOT NULL DEFAULT '[]'");
  if (!reminderColumns.has('preview_confirm_required')) db.exec('ALTER TABLE reminders ADD COLUMN preview_confirm_required INTEGER NOT NULL DEFAULT 0');
  if (!reminderColumns.has('preview_confirmed_at')) db.exec('ALTER TABLE reminders ADD COLUMN preview_confirmed_at TEXT');
  if (!reminderColumns.has('consecutive_failures')) db.exec('ALTER TABLE reminders ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
  const ruleColumns = new Set(db.prepare('PRAGMA table_info(content_rules)').all().map((column) => column.name));
  if (!ruleColumns.has('layout_mode')) {
    db.exec("ALTER TABLE content_rules ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'spacious'");
  }
  const phraseItemColumns = new Set(db.prepare('PRAGMA table_info(phrase_items)').all().map((column) => column.name));
  if (!phraseItemColumns.has('sort_order')) {
    db.exec('ALTER TABLE phrase_items ADD COLUMN sort_order INTEGER');
    const kinds = ['greeting', 'opening', 'closing'];
    const updateOrder = db.prepare('UPDATE phrase_items SET sort_order = ? WHERE id = ?');
    kinds.forEach((kind) => {
      db.prepare('SELECT id FROM phrase_items WHERE kind = ? ORDER BY id ASC').all(kind)
        .forEach((item, index) => updateOrder.run(index + 1, item.id));
    });
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_phrase_items_order ON phrase_items(kind, enabled, sort_order)');
  return db;
}

function mapRobot(row) {
  return {
    id: row.id,
    name: row.name,
    webhookHint: row.webhook_hint,
    keyword: row.keyword,
    hasSecret: Boolean(row.secret_encrypted),
    enabled: Boolean(row.enabled),
    lastTestStatus: row.last_test_status,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapReminder(row) {
  return {
    id: row.id,
    name: row.name,
    robotId: row.robot_id,
    robotName: row.robot_name,
    message: row.message,
    messageFormat: row.message_format || 'text',
    messageTitle: row.message_title || '',
    mentionHint: row.mention_hint || '',
    hasMentionTargets: Boolean(row.mention_mobiles_encrypted),
    sourceType: row.source_type || 'fixed',
    contentRuleId: row.content_rule_id,
    contentRuleName: row.content_rule_name || null,
    frequency: row.frequency,
    runDate: row.run_date,
    runTime: row.run_time,
    weekday: row.weekday,
    atAll: Boolean(row.at_all),
    enabled: Boolean(row.enabled),
    missedPolicy: row.missed_policy,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    status: row.status,
    lastResult: row.last_result || 'waiting',
    calendarMode: row.calendar_mode || 'calendar_days',
    monthlyWorkdayN: row.monthly_workday_n || 1,
    skipHolidays: Boolean(row.skip_holidays),
    pauseDates: JSON.parse(row.pause_dates_json || '[]'),
    pauseRanges: JSON.parse(row.pause_ranges_json || '[]'),
    previewConfirmRequired: Boolean(row.preview_confirm_required),
    previewConfirmedAt: row.preview_confirmed_at || null,
    consecutiveFailures: row.consecutive_failures || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listRobots(db) {
  return db.prepare(`
    SELECT id, name, webhook_hint, keyword, secret_encrypted, enabled,
           last_test_status, last_test_at, created_at, updated_at
    FROM robots ORDER BY enabled DESC, name ASC
  `).all().map(mapRobot);
}

function listReminders(db) {
  return db.prepare(`
    SELECT r.*, b.name AS robot_name, c.name AS content_rule_name
    FROM reminders r JOIN robots b ON b.id = r.robot_id
    LEFT JOIN content_rules c ON c.id = r.content_rule_id
    ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             r.next_run_at IS NULL, r.next_run_at ASC, r.id DESC
  `).all().map(mapReminder);
}

function listHistory(db, limit = 50) {
  return db.prepare(`
    SELECT h.id, h.scheduled_for, h.sent_at, h.content_preview, h.success,
           h.response_code, h.response_message, h.retried, h.created_at,
           r.name AS reminder_name, b.name AS robot_name
    FROM send_history h
    LEFT JOIN reminders r ON r.id = h.reminder_id
    LEFT JOIN robots b ON b.id = h.robot_id
    ORDER BY h.created_at DESC LIMIT ?
  `).all(limit).map((row) => ({
    id: row.id,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    contentPreview: row.content_preview,
    success: row.success === null ? null : Boolean(row.success),
    responseCode: row.response_code,
    responseMessage: row.response_message,
    retried: Boolean(row.retried),
    createdAt: row.created_at,
    reminderName: row.reminder_name || '已删除的提醒',
    robotName: row.robot_name || '已删除的机器人'
  }));
}

module.exports = { defaultDatabasePath, initializeProductionDatabase, openDatabase, listRobots, listReminders, listHistory, mapRobot, mapReminder };
