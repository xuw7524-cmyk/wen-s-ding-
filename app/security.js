const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const scriptPath = path.join(__dirname, 'scripts', 'protect-data.ps1');
const MAC_KEYCHAIN_SERVICE = "Wen's Ding Encryption Key";
const MAC_CIPHER_PREFIX = 'mac-keychain-v1';
const MAC_CIPHER_AAD = Buffer.from("Wen's Ding local secrets v1", 'utf8');
let macKeyPromise = null;

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(options.timeoutMessage || '本机安全服务响应超时'));
    }, options.timeoutMs || 10000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(options.stdin || '');
  });
}

function runProtection(mode, inputBase64) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Mode', mode
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Windows 加密操作超时'));
    }, 10000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`无法启动 Windows 加密服务：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Windows 加密失败：${stderr.trim() || `退出码 ${code}`}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(inputBase64);
  });
}

function macKeychainAccount() {
  try {
    return os.userInfo().username || 'local-user';
  } catch {
    return 'local-user';
  }
}

async function loadOrCreateMacKey() {
  const account = macKeychainAccount();
  const findArgs = ['find-generic-password', '-a', account, '-s', MAC_KEYCHAIN_SERVICE, '-w'];
  let result;
  try {
    result = await runProcess('/usr/bin/security', findArgs);
  } catch (error) {
    throw new Error(`无法访问 macOS 钥匙串：${error.message}`);
  }

  let encodedKey = result.code === 0 ? result.stdout : '';
  if (!encodedKey) {
    encodedKey = crypto.randomBytes(32).toString('base64');
    const addArgs = [
      'add-generic-password', '-U',
      '-a', account,
      '-s', MAC_KEYCHAIN_SERVICE,
      '-w', encodedKey
    ];
    const added = await runProcess('/usr/bin/security', addArgs);
    if (added.code !== 0) {
      throw new Error(`无法在 macOS 钥匙串中保存本机密钥：${added.stderr || `退出码 ${added.code}`}`);
    }
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('macOS 钥匙串中的本机密钥格式无效');
  return key;
}

function getMacKey() {
  if (!macKeyPromise) macKeyPromise = loadOrCreateMacKey();
  return macKeyPromise;
}

function encryptMacTextWithKey(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Mac 加密密钥必须是 32 字节');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAC_CIPHER_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAC_CIPHER_PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptMacTextWithKey(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Mac 解密密钥必须是 32 字节');
  const parts = String(value).split(':');
  if (parts.length !== 4 || parts[0] !== MAC_CIPHER_PREFIX) {
    throw new Error('这条敏感数据不是当前 Mac 支持的加密格式');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAC_CIPHER_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function protectText(value) {
  if (!value) return null;
  if (process.platform === 'darwin') return encryptMacTextWithKey(value, await getMacKey());
  if (process.platform !== 'win32') throw new Error('当前版本仅支持 Windows 和 macOS 本机加密');
  const plainBase64 = Buffer.from(String(value), 'utf8').toString('base64');
  return runProtection('protect', plainBase64);
}

async function unprotectText(value) {
  if (!value) return null;
  if (process.platform === 'darwin') return decryptMacTextWithKey(value, await getMacKey());
  if (process.platform !== 'win32') throw new Error('当前版本仅支持 Windows 和 macOS 本机解密');
  const plainBase64 = await runProtection('unprotect', String(value));
  return Buffer.from(plainBase64, 'base64').toString('utf8');
}

function validateWebhook(value) {
  let normalized = String(value || '')
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/&amp;/gi, '&');
  const urlMatch = normalized.match(/https:\/\/[^\s<>"'`]+/i);
  if (urlMatch) normalized = urlMatch[0];
  normalized = normalized.replace(/\s+/g, '').replace(/[)>\]}，。；;]+$/g, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Webhook 地址格式不正确：请复制以 https:// 开头的完整机器人 Webhook，而不是只复制 access_token');
  }
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('dingtalk.com')) {
    throw new Error('请输入钉钉提供的 HTTPS Webhook 地址');
  }
  if (!url.searchParams.get('access_token')) {
    throw new Error('Webhook 地址中缺少 access_token');
  }
  return url.toString();
}

function webhookHint(value) {
  const url = new URL(value);
  const token = url.searchParams.get('access_token') || '';
  return `${url.hostname} · •••• ${token.slice(-4).toUpperCase()}`;
}

module.exports = {
  protectText,
  unprotectText,
  validateWebhook,
  webhookHint,
  encryptMacTextWithKey,
  decryptMacTextWithKey
};
