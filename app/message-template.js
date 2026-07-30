const VARIABLE_LABELS = Object.freeze({
  date: '日期',
  日期: '日期',
  weekday: '星期',
  星期: '星期',
  time: '时间',
  时间: '时间',
  robot: '机器人',
  机器人: '机器人',
  reminder: '提醒名称',
  提醒名称: '提醒名称'
});

const VARIABLE_PATTERN = /\{(date|日期|weekday|星期|time|时间|robot|机器人|reminder|提醒名称)\}/gi;

function dateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(safe);
  const get = (type) => parts.find((item) => item.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    time: `${get('hour')}:${get('minute')}`
  };
}

function renderVariables(template, context = {}) {
  const when = dateParts(context.scheduledFor);
  const values = {
    date: when.date,
    日期: when.date,
    weekday: when.weekday,
    星期: when.weekday,
    time: when.time,
    时间: when.time,
    robot: String(context.robotName || ''),
    机器人: String(context.robotName || ''),
    reminder: String(context.reminderName || ''),
    提醒名称: String(context.reminderName || '')
  };
  return String(template || '').replace(VARIABLE_PATTERN, (_, key) => values[key] ?? values[key.toLowerCase()] ?? '');
}

function parseMentionMobiles(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，;；]+/);
  const result = [];
  for (const raw of source) {
    const mobile = String(raw || '').trim().replace(/[()\-]/g, '');
    if (!mobile) continue;
    if (!/^\+?\d{5,20}$/.test(mobile)) throw new Error(`成员手机号格式不正确：${raw}`);
    if (!result.includes(mobile)) result.push(mobile);
  }
  if (result.length > 20) throw new Error('一次最多可 @ 20 位指定成员');
  return result;
}

function mentionHint(mobiles) {
  const list = parseMentionMobiles(mobiles);
  if (!list.length) return '';
  return `已保存 ${list.length} 人：${list.map((item) => `•••• ${item.slice(-4)}`).join('、')}`;
}

function normalizeMessageFormat(value) {
  return value === 'markdown' ? 'markdown' : 'text';
}

function renderMessage({ content, title, format, keyword, scheduledFor, robotName, reminderName }) {
  const { ensureKeyword } = require('./dingtalk');
  const messageFormat = normalizeMessageFormat(format);
  const context = { scheduledFor, robotName, reminderName };
  const variableContent = renderVariables(content, context).trim();
  const safeKeyword = String(keyword || '').trim();
  const renderedContent = messageFormat === 'markdown'
    ? (!safeKeyword || variableContent.includes(safeKeyword) ? variableContent : `${safeKeyword}\n\n${variableContent}`)
    : ensureKeyword(variableContent, safeKeyword);
  const renderedTitle = renderVariables(title || reminderName || '定时通知', context).trim().slice(0, 100) || '定时通知';
  return { format: messageFormat, title: renderedTitle, content: renderedContent };
}

module.exports = {
  VARIABLE_LABELS,
  renderVariables,
  renderMessage,
  parseMentionMobiles,
  mentionHint,
  normalizeMessageFormat
};
