const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultDatabasePath, openDatabase, initializeProductionDatabase } = require('../database');
const { createPool } = require('../content-pools');

test('production first run copies starter database once without overwriting user data', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-first-run-test-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const seedPath = path.join(tempDir, 'seed', 'starter.db');
  const destination = path.join(tempDir, 'profile', 'reminders.db');
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  const seed = openDatabase(seedPath);
  createPool(seed, { name: '公司初始内容池' });
  seed.close();

  const previousProduction = process.env.DINGTALK_REMINDER_PRODUCTION;
  const previousSeed = process.env.DINGTALK_REMINDER_SEED_DB;
  process.env.DINGTALK_REMINDER_PRODUCTION = '1';
  process.env.DINGTALK_REMINDER_SEED_DB = seedPath;
  context.after(() => {
    if (previousProduction === undefined) delete process.env.DINGTALK_REMINDER_PRODUCTION;
    else process.env.DINGTALK_REMINDER_PRODUCTION = previousProduction;
    if (previousSeed === undefined) delete process.env.DINGTALK_REMINDER_SEED_DB;
    else process.env.DINGTALK_REMINDER_SEED_DB = previousSeed;
  });

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assert.equal(initializeProductionDatabase(destination), true);
  const userDb = openDatabase(destination);
  assert.equal(userDb.prepare('SELECT name FROM content_pools').get().name, '公司初始内容池');
  userDb.prepare("UPDATE content_pools SET name = '用户自己的修改'").run();
  userDb.close();

  assert.equal(initializeProductionDatabase(destination), false);
  const reopened = openDatabase(destination);
  assert.equal(reopened.prepare('SELECT name FROM content_pools').get().name, '用户自己的修改');
  reopened.close();
});

test('page contains DingDone branding, the Wen\'s Ding signature and a concise guide', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /<strong>DingDone<\/strong>/);
  assert.match(html, /Wen's Ding/);
  assert.match(html, /sidebar-signature/);
  assert.doesNotMatch(html, /sidebar-avatar/);
  assert.match(html, /id="sideGuideButton"/);
  assert.match(html, /DingDone 使用指南/);
  assert.match(html, /三步开始/);
  assert.match(script, /#sideGuideButton/);
  assert.doesNotMatch(html, /@ 指定成员/);
  assert.match(html, /自动填入最近可用日期/);
  assert.match(script, /nearestOnceDate/);
});

test('page exposes cross-platform handover and GitHub update controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /导出 \.wensding 文件/);
  assert.match(html, /确认导入并全部暂停/);
  assert.match(html, /本机正式接管/);
  assert.match(html, /GitHub 仓库/);
  assert.match(html, /当前程序版本/);
  assert.match(html, /交接 \/ 导入导出/);
  assert.match(html, /id="updateButton"/);
  assert.match(html, /交接、导入导出与更新/);
  assert.match(script, /\/api\/handover\/export/);
  assert.match(script, /\/api\/update\/check/);
});

test('production database uses the standard macOS Application Support folder', () => {
  const result = defaultDatabasePath({
    platform: 'darwin',
    home: '/Users/tester',
    env: { DINGTALK_REMINDER_PRODUCTION: '1' }
  });
  assert.equal(result, path.join('/Users/tester', 'Library', 'Application Support', 'WensDing', 'data', 'reminders.db'));
});
