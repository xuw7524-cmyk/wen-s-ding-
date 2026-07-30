const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const packageRoot = path.resolve(process.argv[2] || '');
const runtimePath = path.join(packageRoot, 'runtime', 'node.exe');
const watchdogPath = path.join(packageRoot, 'packaging', 'windows', 'watchdog.js');
const enableScript = path.join(packageRoot, 'packaging', 'windows', 'Enable-AutoStart.ps1');
const disableScript = path.join(packageRoot, 'packaging', 'windows', 'Disable-AutoStart.ps1');
for (const file of [runtimePath, watchdogPath, enableScript, disableScript]) {
  if (!fs.existsSync(file)) throw new Error(`Missing recovery file: ${file}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-recovery-test-'));
const localAppData = path.join(tempRoot, 'Local App Data 中文');
const startupDir = path.join(tempRoot, 'Startup Folder 中文');
const appDataDir = path.join(localAppData, 'DingTalkReminderManager');
const port = 46000 + Math.floor(Math.random() * 1000);
let watchdogProcess = null;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function healthCheck() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && body.databaseReady === true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await run('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: ['ignore', 'pipe', 'pipe'] }).catch(() => {});
}

async function removeTemp() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

(async () => {
  try {
    fs.mkdirSync(startupDir, { recursive: true });
    await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', enableScript,
      '-StartupDirectory', startupDir, '-LocalAppData', localAppData,
      '-SkipLaunch', '-NoDialog'
    ], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const shortcutPath = path.join(startupDir, 'DingDone Auto Recovery.lnk');
    const markerPath = path.join(appDataDir, 'autostart-enabled.json');
    if (!fs.existsSync(shortcutPath) || !fs.existsSync(markerPath)) throw new Error('Auto-start shortcut or marker was not created');

    const logDir = path.join(appDataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'watchdog.log'), Buffer.alloc(1024 * 1024 + 1, 0x57));
    fs.writeFileSync(path.join(logDir, 'backend.log'), Buffer.alloc(1024 * 1024 + 1, 0x42));

    watchdogProcess = spawn(runtimePath, [watchdogPath], {
      cwd: packageRoot,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, LOCALAPPDATA: localAppData, PORT: String(port) }
    });
    await waitFor(healthCheck, 20000, 'initial watchdog startup');
    const initialStatus = await fetch(`http://127.0.0.1:${port}/api/status`).then((response) => response.json());
    if (!initialStatus.autoStartEnabled || !initialStatus.supervised) throw new Error('Backend status does not report auto-start supervision');
    const backendPidPath = path.join(appDataDir, 'backend.pid');
    const firstPid = Number(fs.readFileSync(backendPidPath, 'utf8'));
    await killTree(firstPid);
    await waitFor(async () => !(await healthCheck()), 6000, 'backend shutdown');
    await waitFor(async () => {
      if (!(await healthCheck()) || !fs.existsSync(backendPidPath)) return false;
      return Number(fs.readFileSync(backendPidPath, 'utf8')) !== firstPid;
    }, 25000, 'automatic backend recovery');
    const recoveredPid = Number(fs.readFileSync(backendPidPath, 'utf8'));

    await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', disableScript,
      '-StartupDirectory', startupDir, '-LocalAppData', localAppData, '-NoDialog'
    ], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    if (fs.existsSync(shortcutPath) || fs.existsSync(markerPath)) throw new Error('Auto-start shortcut or marker was not removed');

    const watchdogLog = path.join(appDataDir, 'logs', 'watchdog.log');
    if (!fs.existsSync(watchdogLog)) throw new Error('Watchdog log was not created');
    const logsRotated = fs.existsSync(`${watchdogLog}.previous`) && fs.existsSync(path.join(logDir, 'backend.log.previous'));
    if (!logsRotated) throw new Error('Long-running logs were not rotated');
    process.stdout.write(`${JSON.stringify({ autoStartShortcut: true, marker: true, statusReportsSupervision: true, firstPid, recoveredPid, recovered: firstPid !== recoveredPid, disabledCleanly: true, watchdogLog: true, logsRotated })}\n`);
  } finally {
    if (watchdogProcess?.pid) await killTree(watchdogProcess.pid);
    const backendPidPath = path.join(appDataDir, 'backend.pid');
    if (fs.existsSync(backendPidPath)) await killTree(Number(fs.readFileSync(backendPidPath, 'utf8')));
    await removeTemp();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
