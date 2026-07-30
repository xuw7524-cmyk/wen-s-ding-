const { createHmac } = require('node:crypto');

function ensureKeyword(content, keyword) {
  const text = String(content || '').trim();
  const safeKeyword = String(keyword || '').trim();
  if (!safeKeyword || text.startsWith(safeKeyword)) return text;
  return `${safeKeyword}｜${text}`;
}

function signedWebhook(webhook, secret, timestamp = Date.now()) {
  const url = new URL(webhook);
  if (!secret) return url.toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

function mentionBlock(atAll = false, atMobiles = [], atUserIds = []) {
  return {
    atMobiles: Array.isArray(atMobiles) ? atMobiles : [],
    atUserIds: Array.isArray(atUserIds) ? atUserIds : [],
    isAtAll: Boolean(atAll)
  };
}

function textPayload(content, atAll = false, atMobiles = [], atUserIds = []) {
  return {
    msgtype: 'text',
    text: { content },
    at: mentionBlock(atAll, atMobiles, atUserIds)
  };
}

function markdownPayload(title, content, atAll = false, atMobiles = [], atUserIds = []) {
  return {
    msgtype: 'markdown',
    markdown: { title: String(title || '定时通知').slice(0, 100), text: content },
    at: mentionBlock(atAll, atMobiles, atUserIds)
  };
}

function messagePayload({ format, title, content, atAll, atMobiles, atUserIds }) {
  return format === 'markdown'
    ? markdownPayload(title, content, atAll, atMobiles, atUserIds)
    : textPayload(content, atAll, atMobiles, atUserIds);
}

async function sendDingTalk({ webhook, secret, content, title, format = 'text', atAll, atMobiles, atUserIds, fetchImpl = fetch, timeoutMs = 10000 }) {
  const url = signedWebhook(webhook, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(messagePayload({ format, title, content, atAll, atMobiles, atUserIds })),
      signal: controller.signal
    });
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { errmsg: raw || '钉钉返回了无法识别的内容' };
    }
    if (!response.ok || Number(data.errcode) !== 0) {
      const error = new Error(data.errmsg || `钉钉请求失败（HTTP ${response.status}）`);
      error.code = data.errcode === undefined ? `HTTP_${response.status}` : String(data.errcode);
      error.response = data;
      throw error;
    }
    return { errcode: Number(data.errcode), errmsg: data.errmsg || 'ok', response: data };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('钉钉请求超时，无法确认群里是否已经收到；为避免重复，本次不会自动重试');
      timeoutError.code = 'TIMEOUT';
      timeoutError.deliveryUnknown = true;
      throw timeoutError;
    }
    const causeCode = error.cause?.code || error.code;
    error.safeToRetry = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode);
    if (!error.safeToRetry && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(causeCode)) error.deliveryUnknown = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWithRetry(options, { maxAttempts = 3, delays = [0, 1000, 3000], sleeper } = {}) {
  const sleep = sleeper || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    if (attempt > 1) await sleep(delays[attempt - 1] || 0);
    try {
      const result = await sendDingTalk(options);
      return { ...result, attempts: attempt, retried: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (!error.safeToRetry) break;
    }
  }
  lastError.attempts = attemptsMade;
  throw lastError;
}

module.exports = { ensureKeyword, signedWebhook, textPayload, markdownPayload, messagePayload, sendDingTalk, sendWithRetry };
