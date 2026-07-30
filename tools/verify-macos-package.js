const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const packageRoot = path.resolve(process.argv[2] || '');
const archivePath = path.resolve(process.argv[3] || '');
const required = [
  'runtime/darwin-arm64/node',
  'runtime/darwin-x64/node',
  'app/server.js',
  'app/public/index.html',
  'seed/starter.db',
  'Start.command',
  'Stop.command',
  'Enable-AutoStart.command',
  'Disable-AutoStart.command',
  'README-Mac.txt'
];
for (const relative of required) {
  if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Missing package file: ${relative}`);
}
if (fs.existsSync(path.join(packageRoot, 'app', 'test'))) throw new Error('Development tests must not be included');
if (fs.existsSync(path.join(packageRoot, 'data', 'reminders.db'))) throw new Error('Development database must not be included');

function verifyMachO(relativePath, expectedCpu) {
  const bytes = fs.readFileSync(path.join(packageRoot, relativePath)).subarray(0, 8);
  assert(bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), `${relativePath} is not a 64-bit little-endian Mach-O binary`);
  assert(bytes.readUInt32LE(4) === expectedCpu, `${relativePath} has the wrong processor type`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

verifyMachO('runtime/darwin-arm64/node', 0x0100000c);
verifyMachO('runtime/darwin-x64/node', 0x01000007);

for (const file of required.filter((name) => name.endsWith('.command'))) {
  const bytes = fs.readFileSync(path.join(packageRoot, file));
  assert(bytes.subarray(0, 11).toString('utf8') === '#!/bin/bash', `${file} is missing its shell header`);
  assert(!bytes.includes(Buffer.from('\r\n')), `${file} contains Windows line endings`);
}

const archive = zlib.gunzipSync(fs.readFileSync(archivePath));
const archiveModes = new Map();
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
  const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
  const mode = Number.parseInt(text(100, 8).trim(), 8);
  const size = Number.parseInt(text(124, 12).trim(), 8) || 0;
  archiveModes.set(name, mode);
  offset += 512 + Math.ceil(size / 512) * 512;
}
const archiveRoot = path.basename(packageRoot).replace(/\\/g, '/');
for (const file of [...required.filter((name) => name.endsWith('.command')), 'runtime/darwin-arm64/node', 'runtime/darwin-x64/node']) {
  const mode = archiveModes.get(`${archiveRoot}/${file}`);
  assert((mode & 0o111) !== 0, `${file} is not executable in the archive`);
}

const seedPath = path.join(packageRoot, 'seed', 'starter.db');
const seedBytes = fs.readFileSync(seedPath);
for (const forbidden of ['access_token=', 'oapi.dingtalk.com/robot/send']) {
  assert(!seedBytes.includes(Buffer.from(forbidden, 'utf8')), `Seed contains forbidden Webhook material: ${forbidden}`);
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
assert(seedSummary.integrity === 'ok', 'Starter database integrity check failed');
assert(!seedSummary.robots && !seedSummary.reminders && !seedSummary.history && !seedSummary.executions && !seedSummary.consumptions, 'Starter database contains private operational data');
assert(seedSummary.sendingEnabled === 'false', 'Sending must be disabled in the starter database');
assert(seedSummary.contentPools > 0 && seedSummary.contentItems > 0 && seedSummary.phraseItems > 0 && seedSummary.rules > 0, 'Starter content is missing');
assert(seedSummary.updateRepository === 'xuw7524-cmyk/wen-s-ding-', 'Starter update repository is missing');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-mac-package-test-'));
const databasePath = path.join(tempDir, 'data', 'reminders.db');
const port = 44000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.join(packageRoot, 'app', 'server.js')], {
  cwd: packageRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DINGTALK_REMINDER_PRODUCTION: '1',
    DINGTALK_REMINDER_DB: databasePath,
    DINGTALK_REMINDER_SEED_DB: seedPath,
    PORT: String(port)
  }
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
  throw new Error(`Packaged server did not start: ${stderr}`);
}

(async () => {
  try {
    const status = await waitForServer();
    const [robots, reminders, history, settings, html] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/robots`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/reminders`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/history`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/settings`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/`).then((response) => response.text())
    ]);
    const firstRun = {
      backend: status.ok,
      sendingEnabled: settings.sendingEnabled,
      robots: robots.robots.length,
      reminders: reminders.reminders.length,
      history: history.history.length,
      watermark: html.includes("Wen's Ding")
    };
    assert(firstRun.backend && !firstRun.sendingEnabled && !firstRun.robots && !firstRun.reminders && !firstRun.history && firstRun.watermark, `First-run verification failed: ${JSON.stringify(firstRun)}`);
    process.stdout.write(`${JSON.stringify({ seed: seedSummary, firstRun, archiveExecutables: true, runtimes: ['arm64', 'x64'] })}\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
