const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start');
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}

test('robot and reminder data persist through the local API without sending', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-reminder-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  const port = 42871;
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DINGTALK_REMINDER_DB: dbPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverError = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { serverError += chunk; });

  context.after(async () => {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('close', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  assert.equal(serverError.includes('Error'), false, serverError);

  const status = await request(baseUrl, '/api/status');
  assert.equal(status.sendingEnabled, false);

  const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=TEST_ONLY_NOT_REAL_1234';
  const createdRobot = await request(baseUrl, '/api/robots', {
    method: 'POST', body: JSON.stringify({ name: '测试机器人', keyword: '定时通知', webhook })
  });
  assert.equal(createdRobot.robot.webhookHint.endsWith('1234'), true);
  assert.equal(JSON.stringify(createdRobot).includes('TEST_ONLY_NOT_REAL'), false);

  const createdReminder = await request(baseUrl, '/api/reminders', {
    method: 'POST', body: JSON.stringify({
      name: '测试提醒', robotId: createdRobot.robot.id, message: '这只是本地测试消息',
      messageFormat: 'markdown', messageTitle: '{日期}测试标题', mentionMobiles: '13800138000',
      frequency: 'daily', runTime: '23:59', atAll: false, enabled: true, missedPolicy: 'skip',
      calendarMode: 'workdays', skipHolidays: true, pauseDates: ['2099-08-08'],
      pauseRanges: ['2099-09-01~2099-09-03'], previewConfirmRequired: true
    })
  });
  assert.equal(createdReminder.reminder.status, 'active');
  assert.equal(createdReminder.reminder.messageFormat, 'markdown');
  assert.equal(createdReminder.reminder.hasMentionTargets, true);
  assert.match(createdReminder.reminder.mentionHint, /8000/);
  assert.equal(JSON.stringify(createdReminder).includes('13800138000'), false);

  const preview = await request(baseUrl, '/api/reminders/preview', {
    method: 'POST', body: JSON.stringify({
      name: '变量预览', robotId: createdRobot.robot.id, message: '{日期} {机器人} {提醒名称}',
      messageFormat: 'markdown', messageTitle: '{星期}测试标题', mentionMobiles: '13800138000',
      frequency: 'daily', runTime: '23:59', enabled: false, missedPolicy: 'skip'
    })
  });
  assert.equal(preview.preview.format, 'markdown');
  assert.equal(preview.preview.content.includes('{日期}'), false);
  assert.match(preview.preview.content, /测试机器人 变量预览/);
  assert.match(preview.preview.mentionHint, /8000/);

  const missingDateResponse = await fetch(`${baseUrl}/api/reminders/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: '一次性预览', robotId: createdRobot.robot.id, message: '测试内容',
      frequency: 'once', runTime: '23:59', runDate: '', enabled: false, missedPolicy: 'skip'
    })
  });
  const missingDate = await missingDateResponse.json();
  assert.equal(missingDateResponse.ok, false);
  assert.equal(missingDate.error, '请选择一次性提醒的发送日期');

  await request(baseUrl, `/api/reminders/${createdReminder.reminder.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ enabled: false })
  });
  const copied = await request(baseUrl, `/api/reminders/${createdReminder.reminder.id}/copy`, { method: 'POST' });
  assert.equal(copied.reminder.status, 'paused');
  assert.equal(copied.reminder.hasMentionTargets, true);
  assert.equal(copied.reminder.calendarMode, 'workdays');
  assert.equal(copied.reminder.skipHolidays, true);
  assert.deepEqual(copied.reminder.pauseDates, ['2099-08-08']);
  assert.deepEqual(copied.reminder.pauseRanges, ['2099-09-01~2099-09-03']);
  assert.equal(copied.reminder.previewConfirmRequired, true);

  const invalidBoolean = await fetch(`${baseUrl}/api/reminders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: '非法开关', robotId: createdRobot.robot.id, message: '不会保存',
      frequency: 'daily', runTime: '23:59', enabled: 'false'
    })
  });
  assert.equal(invalidBoolean.ok, false);
  assert.match((await invalidBoolean.json()).error, /开关字段格式不正确/);

  const invalidRange = await fetch(`${baseUrl}/api/reminders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: '非法日期段', robotId: createdRobot.robot.id, message: '不会保存',
      frequency: 'daily', runTime: '23:59', enabled: false,
      pauseRanges: ['2099-09-03~2099-09-01']
    })
  });
  assert.equal(invalidRange.ok, false);
  assert.match((await invalidRange.json()).error, /结束日期不能早于开始日期/);

  const reminders = await request(baseUrl, '/api/reminders');
  assert.equal(reminders.reminders.length, 2);
  assert.equal(reminders.reminders.every((item) => item.message.includes('Webhook') === false), true);

  const databaseFiles = fs.readdirSync(tempDir).map((name) => fs.readFileSync(path.join(tempDir, name)));
  assert.equal(databaseFiles.some((buffer) => buffer.includes(Buffer.from('TEST_ONLY_NOT_REAL'))), false);
  assert.equal(databaseFiles.some((buffer) => buffer.includes(Buffer.from('13800138000'))), false);
});
