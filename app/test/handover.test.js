const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../database');
const {
  encryptPackage, decryptPackage, createHandoverPackage, inspectHandoverPackage,
  importHandoverPackage, getPendingHandover, completeHandover
} = require('../handover');

function minimalPayload() {
  return {
    format: 'wens-ding-handover', version: 1, exportedAt: '2026-07-17T00:00:00.000Z',
    sourcePlatform: 'win32', includesWebhooks: true, desiredSendingEnabled: true,
    desiredActiveReminderIds: [], robots: [],
    tables: {
      content_pools: [], content_items: [], content_rules: [], content_rule_allocations: [],
      phrase_pools: [], phrase_items: [], reminders: []
    }
  };
}

function seedSource(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO robots
    (id, name, webhook_encrypted, webhook_hint, keyword, secret_encrypted, enabled, last_test_status, created_at, updated_at)
    VALUES (1, '交接机器人', 'LOCAL:https://oapi.dingtalk.com/robot/send?access_token=portable-token', 'masked', '定时通知', 'LOCAL:secret', 1, 'success', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO reminders
    (id, name, robot_id, message, frequency, run_date, run_time, weekday, at_all, enabled,
     missed_policy, timezone, next_run_at, last_run_at, status, created_at, updated_at, source_type, content_rule_id, last_result)
    VALUES (1, '交接提醒', 1, '定时通知 测试', 'daily', NULL, '23:58', NULL, 0, 1,
      'skip', 'Asia/Hong_Kong', ?, NULL, 'active', ?, ?, 'fixed', NULL, 'waiting')`)
    .run(now, now, now);
  db.prepare("UPDATE app_settings SET value = 'true' WHERE key = 'sending_enabled'").run();
  db.prepare("UPDATE app_settings SET value = '7' WHERE key = 'same_robot_limit'").run();
  db.prepare(`
    INSERT INTO calendar_exceptions (date, type, label, created_at, updated_at)
    VALUES ('2099-10-01', 'holiday', '交接节假日', ?, ?)
  `).run(now, now);
}

test('portable handover encryption is password based and detects wrong passwords or damage', () => {
  const payload = minimalPayload();
  const container = encryptPackage(payload, 'handover-pass-123');
  assert.equal(container.format, 'wens-ding-handover');
  assert.doesNotMatch(JSON.stringify(container), /portable-token/);
  assert.deepEqual(decryptPackage(container, 'handover-pass-123'), payload);
  assert.throws(() => decryptPackage(container, 'wrong-password'), /密码不正确|已经损坏/);
  const damaged = { ...container, ciphertext: `${container.ciphertext.slice(0, -4)}AAAA` };
  assert.throws(() => decryptPackage(damaged, 'handover-pass-123'), /密码不正确|已经损坏/);
});

test('handover import backs up, pauses everything, resets robot tests, and requires takeover confirmation', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-handover-'));
  const source = openDatabase(path.join(tempDir, 'source.db'));
  const target = openDatabase(path.join(tempDir, 'target.db'));
  context.after(() => {
    source.close();
    target.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  seedSource(source);
  const unprotect = async (value) => String(value).replace(/^LOCAL:/, '');
  const protect = async (value) => `TARGET:${value}`;
  const exported = await createHandoverPackage(source, {
    password: 'handover-pass-123', includeWebhooks: true, unprotect
  });
  const summary = inspectHandoverPackage(exported.package, 'handover-pass-123');
  assert.equal(summary.robots, 1);
  assert.equal(summary.reminders, 1);
  assert.equal(summary.includesWebhooks, true);
  assert.equal(summary.calendarExceptions, 1);
  assert.equal(summary.includesSafetySettings, true);

  const imported = await importHandoverPackage(target, exported.package, 'handover-pass-123', {
    confirm: 'REPLACE_AND_PAUSE', protect
  });
  assert.equal(fs.existsSync(imported.backupPath), true);
  assert.equal(target.prepare('SELECT enabled FROM reminders WHERE id = 1').get().enabled, 0);
  assert.equal(target.prepare('SELECT status FROM reminders WHERE id = 1').get().status, 'paused');
  assert.equal(target.prepare('SELECT value FROM app_settings WHERE key = \'sending_enabled\'').get().value, 'false');
  assert.equal(target.prepare("SELECT value FROM app_settings WHERE key = 'same_robot_limit'").get().value, '7');
  assert.equal(target.prepare("SELECT label FROM calendar_exceptions WHERE date = '2099-10-01'").get().label, '交接节假日');
  const robot = target.prepare('SELECT * FROM robots WHERE id = 1').get();
  assert.equal(robot.webhook_encrypted, 'TARGET:https://oapi.dingtalk.com/robot/send?access_token=portable-token');
  assert.equal(robot.last_test_status, 'not_tested');
  assert.ok(getPendingHandover(target));
  assert.throws(() => completeHandover(target, 'OLD_DEVICE_STOPPED_AND_TAKE_OVER'), /请先在这台电脑测试机器人/);

  target.prepare("UPDATE robots SET last_test_status = 'success'").run();
  const completed = completeHandover(target, 'OLD_DEVICE_STOPPED_AND_TAKE_OVER');
  assert.equal(completed.pending, false);
  assert.equal(completed.sendingEnabled, true);
  assert.equal(target.prepare('SELECT enabled FROM reminders WHERE id = 1').get().enabled, 1);
  assert.equal(getPendingHandover(target), null);
});

test('handover without webhooks imports disabled robots that request a new webhook', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-no-webhook-'));
  const source = openDatabase(path.join(tempDir, 'source.db'));
  const target = openDatabase(path.join(tempDir, 'target.db'));
  context.after(() => {
    source.close();
    target.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  seedSource(source);
  const exported = await createHandoverPackage(source, {
    password: 'handover-pass-123', includeWebhooks: false,
    unprotect: async () => { throw new Error('must not decrypt excluded webhooks'); }
  });
  await importHandoverPackage(target, exported.package, 'handover-pass-123', {
    confirm: 'REPLACE_AND_PAUSE', protect: async (value) => `TARGET:${value}`, skipBackup: true
  });
  const robot = target.prepare('SELECT enabled, webhook_hint FROM robots WHERE id = 1').get();
  assert.equal(robot.enabled, 0);
  assert.equal(robot.webhook_hint, '需要重新填写 Webhook');
});
