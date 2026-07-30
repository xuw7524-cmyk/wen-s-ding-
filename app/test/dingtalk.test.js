const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { ensureKeyword, signedWebhook, textPayload, markdownPayload, sendWithRetry } = require('../dingtalk');

test('keyword, @all payload and signing are composed without exposing secrets in the body', () => {
  assert.equal(ensureKeyword('每日风险提醒', '定时通知'), '定时通知｜每日风险提醒');
  assert.equal(ensureKeyword('定时通知｜每日风险提醒', '定时通知'), '定时通知｜每日风险提醒');
  assert.deepEqual(textPayload('测试内容', true), {
    msgtype: 'text', text: { content: '测试内容' },
    at: { atMobiles: [], atUserIds: [], isAtAll: true }
  });
  const url = new URL(signedWebhook('https://oapi.dingtalk.com/robot/send?access_token=fake', 'secret-value', 123456));
  assert.equal(url.searchParams.get('timestamp'), '123456');
  assert.ok(url.searchParams.get('sign'));
  assert.equal(url.searchParams.get('sign').includes('secret-value'), false);
});

test('specified member and Markdown payloads keep DingTalk mention fields', () => {
  assert.deepEqual(textPayload('测试内容', false, ['13800138000']), {
    msgtype: 'text', text: { content: '测试内容' },
    at: { atMobiles: ['13800138000'], atUserIds: [], isAtAll: false }
  });
  assert.deepEqual(markdownPayload('风险提醒', '**请检查**', false, ['13800138000']), {
    msgtype: 'markdown', markdown: { title: '风险提醒', text: '**请检查**' },
    at: { atMobiles: ['13800138000'], atUserIds: [], isAtAll: false }
  });
});

test('local mock verifies UTF-8 payload without external network', async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  const result = await sendWithRetry({
    webhook: `http://127.0.0.1:${address.port}/robot/send?access_token=fake`,
    content: '定时通知｜中文消息', atAll: true
  }, { maxAttempts: 3, delays: [0, 0, 0], sleeper: async () => {} });
  assert.equal(result.attempts, 1);
  assert.equal(result.retried, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.text.content, '定时通知｜中文消息');
  assert.equal(requests[0].body.at.isAtAll, true);
});

test('DingTalk application errors are not automatically retried to avoid duplicate messages', async (context) => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ errcode: 310000, errmsg: 'test failure' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  await assert.rejects(() => sendWithRetry({
    webhook: `http://127.0.0.1:${address.port}/robot/send?access_token=fake`,
    content: '定时通知｜不会重试'
  }, { maxAttempts: 3, delays: [0, 0, 0], sleeper: async () => {} }), /test failure/);
  assert.equal(requests, 1);
});
