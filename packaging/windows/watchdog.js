const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
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
const watchdogLog = path.join(logDir, 'watchdog.log');
const backendLog = path.join(logDir, 'backend.log');
const watchdogPidPath = path.join(appDataDir, 'watchdog.pid');
const backendPidPath = path.join(appDataDir, 'backend.pid');
const port = Number(process.env.PORT || 4173);
const pipeName = '\\\\.\\pipe\\wens-ding-watchdog';

fs.mkdirSync(logDir, { recursive: true });

function rotateLog(filePath, maximumBytes = 1024 * 1024) {
  try {
    if (fs.statSync(filePath).size < maximumBytes) return;
    const previous = `${filePath}.previous`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(filePath, previous);
  } catch {}
}

function log(message) {
  rotateLog(watchdogLog);
  fs.appendFileSync(watchdogLog, `[${new Date().toISOString()}] ${message}\r\n`, 'utf8');
}

function healthCheck(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/api/status`, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(response.statusCode === 200 && body.includes('databaseReady')));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

let starting = false;
async function ensureBackend() {
  if (starting || await healthCheck()) return;
  starting = true;
  rotateLog(backendLog);
  const logHandle = fs.openSync(backendLog, 'a');
  try {
    const child = spawn(runtimePath, [serverPath], {
      cwd: baseDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logHandle, logHandle],
      env: { ...process.env, DINGTALK_REMINDER_PRODUCTION: '1', WENS_DING_SUPERVISED: '1' }
    });
    child.on('error', (error) => log(`Backend start failed: ${error.message}`));
    fs.writeFileSync(backendPidPath, String(child.pid), 'utf8');
    child.unref();
    log(`Backend start requested with PID ${child.pid}`);
  } catch (error) {
    log(`Backend start failed: ${error.message}`);
  } finally {
    fs.closeSync(logHandle);
    starting = false;
  }
}

const lockServer = net.createServer();
lockServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0);
  log(`Watchdog lock failed: ${error.message}`);
  process.exit(1);
});
lockServer.listen(pipeName, () => {
  fs.writeFileSync(watchdogPidPath, String(process.pid), 'utf8');
  log(`Watchdog started with PID ${process.pid}`);
  ensureBackend();
});

const timer = setInterval(ensureBackend, 10000);
function shutdown() {
  clearInterval(timer);
  try { fs.rmSync(watchdogPidPath, { force: true }); } catch {}
  lockServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  log(`Watchdog error: ${error.stack || error.message}`);
});
process.on('unhandledRejection', (error) => {
  log(`Watchdog rejection: ${error?.stack || error}`);
});
