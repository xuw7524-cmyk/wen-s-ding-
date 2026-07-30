const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const baseDir = path.resolve(__dirname, '..', '..');
const bundledRuntimePath = path.join(baseDir, 'runtime', 'node.exe');
const runtimePath = fs.existsSync(bundledRuntimePath) ? bundledRuntimePath : process.execPath;
const serverPath = path.join(baseDir, 'app', 'server.js');
const localAppData = process.env.LOCALAPPDATA
  || path.join(process.env.USERPROFILE || baseDir, 'AppData', 'Local');
const appDataDir = path.join(localAppData, 'DingTalkReminderManager');
const logDir = path.join(appDataDir, 'logs');
const logPath = path.join(logDir, 'startup.log');
const pidPath = path.join(appDataDir, 'backend.pid');
const autoStartMarkerPath = path.join(appDataDir, 'autostart-enabled.json');
const watchdogPath = path.join(baseDir, 'packaging', 'windows', 'watchdog.js');
const port = Number(process.env.PORT || 4173);
const url = `http://127.0.0.1:${port}/`;
const healthUrl = `http://127.0.0.1:${port}/health`;
const expectedVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(baseDir, 'app', 'version.json'), 'utf8')).version; }
  catch { return null; }
})();

function fail(message, detail = '') {
  fs.mkdirSync(logDir, { recursive: true });
  const report = [
    `[${new Date().toISOString()}] ${message}`,
    detail,
    `Package: ${baseDir}`,
    `Runtime: ${runtimePath}`,
    `Server exists: ${fs.existsSync(serverPath)}`
  ].filter(Boolean).join('\r\n');
  fs.appendFileSync(logPath, `${report}\r\n`, 'utf8');
  process.stderr.write(`\n启动失败：${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.stderr.write(`\n诊断日志：${logPath}\n`);
  process.exitCode = 1;
}

function healthCheck(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(healthUrl, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try { return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { return resolve(null); }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

function isThisInstance(info) {
  if (!info || info.appId !== 'wens-ding') return false;
  if (expectedVersion && info.version !== expectedVersion) return false;
  return path.resolve(String(info.instancePath || '')).toLowerCase() === baseDir.toLowerCase();
}

function openBrowser() {
  if (process.env.WENS_DING_NO_BROWSER === '1' || process.argv.includes('--background')) return;
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '', url], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  browser.unref();
}

function startWatchdogIfEnabled() {
  if (!fs.existsSync(autoStartMarkerPath) || !fs.existsSync(watchdogPath)) return false;
  const watchdog = spawn(runtimePath, [watchdogPath], {
    cwd: baseDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  watchdog.on('error', () => {});
  watchdog.unref();
  return true;
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (isThisInstance(await healthCheck())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

(async () => {
  process.stdout.write('正在启动 DingDone，请稍候……\n');
  if (!fs.existsSync(runtimePath) || !fs.existsSync(serverPath)) {
    fail('程序文件不完整。请先右键 ZIP 选择“全部解压”，再从解压后的文件夹启动。');
    return;
  }

  const watchdogRequested = startWatchdogIfEnabled();

  const existingInstance = await healthCheck();
  if (existingInstance && isThisInstance(existingInstance)) {
    process.stdout.write('后台已经在运行，正在打开页面。\n');
    openBrowser();
    return;
  }
  if (existingInstance) {
    fail(
      '端口 4173 正由另一份 DingDone 或其他程序占用。',
      `当前包：${expectedVersion || '未知版本'}\n占用程序：${existingInstance.version || '未知版本'}\n请先用原程序的停止入口关闭旧后台，再启动当前版本。`
    );
    return;
  }

  if (watchdogRequested) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (isThisInstance(await healthCheck())) {
        process.stdout.write('自动守护已启动，正在打开页面。\n');
        openBrowser();
        return;
      }
    }
  }

  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Starting DingDone\r\n`, 'utf8');
  const logHandle = fs.openSync(logPath, 'a');
  let child;
  let spawnError = null;
  try {
    child = spawn(runtimePath, [serverPath], {
      cwd: baseDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logHandle, logHandle],
      env: { ...process.env, DINGTALK_REMINDER_PRODUCTION: '1' }
    });
    child.on('error', (error) => { spawnError = error; });
    fs.writeFileSync(pidPath, String(child.pid), 'utf8');
    child.unref();
  } catch (error) {
    fs.closeSync(logHandle);
    fail('后台运行核心被 Windows 或安全软件阻止。', error.message);
    return;
  }
  fs.closeSync(logHandle);

  if (await waitUntilReady()) {
    process.stdout.write('启动成功，正在打开管理页面。\n');
    openBrowser();
    return;
  }

  if (spawnError) {
    fail('后台运行核心被 Windows 或安全软件阻止。', spawnError.message);
    return;
  }

  let recentLog = '';
  try {
    recentLog = fs.readFileSync(logPath, 'utf8').slice(-4000);
  } catch {}
  fail('后台在 20 秒内没有启动成功。可能被安全软件拦截，或 4173 端口被其他程序占用。', recentLog);
})().catch((error) => fail('启动器发生未预期错误。', error.stack || error.message));
