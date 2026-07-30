const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.resolve(process.argv[2] || 'data/reminders.db');
const db = new DatabaseSync(databasePath, { readOnly: true });
const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
const summary = {
  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  robots: count('robots'),
  reminders: count('reminders'),
  history: count('send_history'),
  contentPools: count('content_pools'),
  contentItems: count('content_items'),
  phraseItems: count('phrase_items'),
  rules: count('content_rules'),
  sendingEnabled: db.prepare("SELECT value FROM app_settings WHERE key = 'sending_enabled'").get()?.value
};
db.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
