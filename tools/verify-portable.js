const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const packageRoot = path.resolve(process.argv[2] || '');
const required = [
  'runtime/node.exe',
  'app/server.js',
  'app/public/index.html',
  'seed/starter.db',
  'Start-DingDone.cmd',
  'Enable-AutoStart.cmd',
  'Disable-AutoStart.cmd',
  'Stop-DingDone.cmd',
  'packaging/windows/launcher.js',
  'packaging/windows/watchdog.js',
  'README-Windows.txt'
];
for (const relative of required) {
  if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Missing package file: ${relative}`);
}
if (fs.existsSync(path.join(packageRoot, 'app', 'test'))) throw new Error('Development tests must not be included in the package');
if (fs.existsSync(path.join(packageRoot, 'data', 'reminders.db'))) throw new Error('Development database must not be included in the package');

const seedPath = path.join(packageRoot, 'seed', 'starter.db');
const seedBytes = fs.readFileSync(seedPath);
for (const forbidden of ['access_token=', 'oapi.dingtalk.com/robot/send']) {
  if (seedBytes.includes(Buffer.from(forbidden, 'utf8'))) throw new Error(`Seed contains forbidden Webhook material: ${forbidden}`);
}
const seed = new DatabaseSync(seedPath, { readOnly: true });
const count = (table) => Number(seed.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
const seedSummary = {
  integrity: seed.prepare('PRAGMA integrity_check').get().integrity_check,
  robots: count('robots'),
  reminders: count('reminders'),
  history: count('send_history'),
  executions: count('run_executions'),
  consumptions: count('content_consumptions'),
  contentPools: count('content_pools'),
  contentItems: count('content_items'),
  phraseItems: count('phrase_items'),
  rules: count('content_rules'),
  sendingEnabled: seed.prepare("SELECT value FROM app_settings WHERE key = 'sending_enabled'").get()?.value,
  updateRepository: seed.prepare("SELECT value FROM app_settings WHERE key = 'update_repository'").get()?.value
};
seed.close();
if (seedSummary.integrity !== 'ok' || seedSummary.robots || seedSummary.reminders || seedSummary.history || seedSummary.executions || seedSummary.consumptions || seedSummary.sendingEnabled !== 'false') {
  throw new Error(`Unsafe starter database: ${JSON.stringify(seedSummary)}`);
}
if (!seedSummary.contentPools || !seedSummary.contentItems || !seedSummary.phraseItems || !seedSummary.rules) {
  throw new Error(`Starter content is missing: ${JSON.stringify(seedSummary)}`);
}
if (seedSummary.updateRepository !== 'xuw7524-cmyk/wen-s-ding-') {
  throw new Error(`Starter update repository is missing: ${JSON.stringify(seedSummary)}`);
}

const tempLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'dingdone-portable-test-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const child = spawn(path.join(packageRoot, 'runtime', 'node.exe'), [path.join(packageRoot, 'app', 'server.js')], {
  cwd: packageRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DINGTALK_REMINDER_PRODUCTION: '1', LOCALAPPDATA: tempLocalAppData, PORT: String(port) }
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Portable server did not start: ${stderr}`);
}

(async () => {
  try {
    const status = await waitForServer();
    const [robots, reminders, history, pools, rules, phrases, settings, html] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/robots`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/reminders`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/history`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/content-pools`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/content-rules`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/phrase-pools`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/settings`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/`).then((response) => response.text())
    ]);
    const firstRun = {
      backend: status.ok,
      sendingEnabled: settings.sendingEnabled,
      robots: robots.robots.length,
      reminders: reminders.reminders.length,
      history: history.history.length,
      contentPools: pools.pools.length,
      rules: rules.rules.length,
      phrasePools: phrases.pools.length,
      watermark: html.includes("Wen's Ding"),
      robotSaveAndDelete: false
    };
    if (!firstRun.backend || firstRun.sendingEnabled || firstRun.robots || firstRun.reminders || firstRun.history || !firstRun.contentPools || !firstRun.rules || firstRun.phrasePools !== 3 || !firstRun.watermark) {
      throw new Error(`Portable first-run verification failed: ${JSON.stringify(firstRun)}`);
    }
    const createResponse = await fetch(`http://127.0.0.1:${port}/api/robots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Portable local encryption check',
        keyword: '定时通知',
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=portable-local-check-only'
      })
    });
    const created = await createResponse.json();
    if (!createResponse.ok || !created.robot?.id || String(created.robot.webhookHint).includes('access_token')) {
      throw new Error(`Portable robot save failed: ${JSON.stringify(created)}`);
    }
    const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/robots/${created.robot.id}`, { method: 'DELETE' });
    const robotsAfterDelete = await fetch(`http://127.0.0.1:${port}/api/robots`).then((response) => response.json());
    firstRun.robotSaveAndDelete = deleteResponse.ok && robotsAfterDelete.robots.length === 0;
    if (!firstRun.robotSaveAndDelete) throw new Error('Portable robot save cleanup failed');
    process.stdout.write(`${JSON.stringify({ seed: seedSummary, firstRun })}\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(tempLocalAppData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
