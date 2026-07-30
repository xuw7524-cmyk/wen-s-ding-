const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function textArgument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : fallback;
}

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = argument('--source', path.join(projectRoot, 'data', 'reminders.db'));
const outputPath = argument('--output', path.join(projectRoot, 'seed', 'starter.db'));
const updateRepository = textArgument('--update-repository');
if (updateRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(updateRepository)) {
  throw new Error('Invalid update repository');
}

if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });

const quoteSql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const source = new DatabaseSync(sourcePath);
try {
  source.exec('PRAGMA wal_checkpoint(PASSIVE)');
  source.exec(`VACUUM INTO ${quoteSql(outputPath)}`);
} finally {
  source.close();
}

const seed = new DatabaseSync(outputPath);
const hasTable = (name) => Boolean(seed.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
try {
  seed.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  for (const table of ['run_executions', 'send_history', 'reminders', 'robots', 'content_consumptions']) {
    if (hasTable(table)) seed.exec(`DELETE FROM ${table}`);
  }
  if (hasTable('content_items')) {
    seed.exec('UPDATE content_items SET last_used_cycle = 0, use_count = 0, last_used_at = NULL');
  }
  if (hasTable('content_pools')) seed.exec('UPDATE content_pools SET current_cycle = 1');
  if (hasTable('phrase_items')) {
    seed.exec('UPDATE phrase_items SET last_used_cycle = 0, use_count = 0, last_used_at = NULL');
  }
  if (hasTable('phrase_pools')) seed.exec('UPDATE phrase_pools SET current_cycle = 1, last_item_id = NULL');
  if (hasTable('app_settings')) {
    seed.exec("DELETE FROM app_settings; INSERT INTO app_settings (key, value, updated_at) VALUES ('sending_enabled', 'false', datetime('now')); INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_interval_seconds', '15', datetime('now'))");
    if (updateRepository) {
      seed.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('update_repository', ?, datetime('now'))").run(updateRepository);
    }
  }
  if (hasTable('sqlite_sequence')) {
    seed.exec("DELETE FROM sqlite_sequence WHERE name IN ('robots', 'reminders', 'send_history', 'run_executions', 'content_consumptions')");
  }
  seed.exec('COMMIT; PRAGMA journal_mode = DELETE; VACUUM');

  const count = (table) => hasTable(table) ? Number(seed.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total) : 0;
  const integrity = seed.prepare('PRAGMA integrity_check').get().integrity_check;
  const summary = {
    outputPath,
    integrity,
    robots: count('robots'),
    reminders: count('reminders'),
    history: count('send_history'),
    executions: count('run_executions'),
    consumptions: count('content_consumptions'),
    contentPools: count('content_pools'),
    contentItems: count('content_items'),
    phraseItems: count('phrase_items'),
    rules: count('content_rules'),
    sendingEnabled: hasTable('app_settings')
      ? seed.prepare("SELECT value FROM app_settings WHERE key = 'sending_enabled'").get()?.value
      : null,
    updateRepository: hasTable('app_settings')
      ? seed.prepare("SELECT value FROM app_settings WHERE key = 'update_repository'").get()?.value || null
      : null
  };
  if (integrity !== 'ok' || summary.robots || summary.reminders || summary.history || summary.executions || summary.consumptions || summary.sendingEnabled !== 'false') {
    throw new Error(`Sanitized seed verification failed: ${JSON.stringify(summary)}`);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  try { seed.exec('ROLLBACK'); } catch {}
  throw error;
} finally {
  seed.close();
}
