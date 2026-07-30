const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMessage, parseMentionMobiles, mentionHint } = require('../message-template');

test('message variables render from scheduled time and local names', () => {
  const result = renderMessage({
    content: '{日期} {星期} {时间}\n{机器人}\n{提醒名称}',
    title: '{日期} 风险提醒',
    format: 'markdown',
    keyword: '定时通知',
    scheduledFor: '2026-07-20T01:30:00.000Z',
    robotName: '运营群',
    reminderName: '每日检查'
  });
  assert.equal(result.format, 'markdown');
  assert.equal(result.title, '2026-07-20 风险提醒');
  assert.match(result.content, /^定时通知\n\n2026-07-20 星期一 09:30/);
  assert.match(result.content, /运营群\n每日检查$/);
});

test('specified member parser deduplicates and only exposes masked hints', () => {
  const mobiles = parseMentionMobiles('13800138000, 13900139000\n13800138000');
  assert.deepEqual(mobiles, ['13800138000', '13900139000']);
  assert.equal(mentionHint(mobiles), '已保存 2 人：•••• 8000、•••• 9000');
  assert.throws(() => parseMentionMobiles('不是手机号'), /格式不正确/);
});
