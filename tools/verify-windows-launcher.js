const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const packageRoot = path.resolve(process.argv[2] || '');
const launcherPath = path.join(packageRoot, 'Start-DingDone.cmd');
if (!fs.existsSync(launcherPath)) throw new Error('Start-DingDone.cmd is missing');

const tempLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'dingdone-launcher-test-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const appDataDir = path.join(tempLocalAppData, 'DingTalkReminderManager');

function runLauncher() {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/c', launcherPath], {
      cwd: packageRoot,
      windowsHide: true,
      env: {
        ...process.env,
        LOCALAPPDATA: tempLocalAppData,
        PORT: String(port),
        WENS_DING_NO_BROWSER: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Launcher did not finish within 30 seconds'));
    }, 30000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Launcher exited with ${code}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function stopBackend() {
  const pidPath = path.join(appDataDir, 'backend.pid');
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) return;
  await new Promise((resolve) => {
    const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    taskkill.on('exit', resolve);
    taskkill.on('error', resolve);
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      break;
    }
  }
}

async function removeTempDirectory() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(tempLocalAppData, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

(async () => {
  try {
    const first = await runLauncher();
    if (!first.stdout.includes('DingDone') || first.stdout.includes("Wen's Ding")) {
      throw new Error(`Launcher still exposes an outdated product name: ${first.stdout}`);
    }
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    if (!health.ok) throw new Error('Launcher exited successfully but backend is unavailable');
    const databasePath = path.join(appDataDir, 'data', 'reminders.db');
    if (!fs.existsSync(databasePath)) throw new Error('First-run database was not created');
    const logPath = path.join(appDataDir, 'logs', 'startup.log');
    if (!fs.existsSync(logPath)) throw new Error('Startup log was not created');
    process.stdout.write(JSON.stringify({ launcherExit: 0, backend: true, firstRunDatabase: true, startupLog: true, output: first.stdout.trim() }) + '\n');
  } finally {
    await stopBackend();
    await removeTempDirectory();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
