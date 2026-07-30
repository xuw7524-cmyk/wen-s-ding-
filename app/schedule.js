function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('发送时间格式不正确');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('发送时间格式不正确');
  return { hour, minute };
}

function localDate(dateValue, hour, minute) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  if (!match) throw new Error('发送日期格式不正确');
  const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute, 0, 0);
  if (
    result.getFullYear() !== Number(match[1]) ||
    result.getMonth() !== Number(match[2]) - 1 ||
    result.getDate() !== Number(match[3])
  ) {
    throw new Error('发送日期不存在');
  }
  return result;
}

function calculateNextRun(reminder, now = new Date()) {
  const { hour, minute } = parseTime(reminder.runTime);
  const frequency = reminder.frequency;

  if (frequency === 'once') {
    const candidate = localDate(reminder.runDate, hour, minute);
    return candidate > now ? candidate.toISOString() : null;
  }

  if (frequency === 'daily') {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }

  if (frequency === 'weekly') {
    const weekday = Number(reminder.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error('请选择正确的星期');
    }
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    let daysAhead = (weekday - candidate.getDay() + 7) % 7;
    if (daysAhead === 0 && candidate <= now) daysAhead = 7;
    candidate.setDate(candidate.getDate() + daysAhead);
    return candidate.toISOString();
  }

  throw new Error('不支持的重复规则');
}

function calculateNextCalendarRun(reminder, now = new Date(), exceptions = []) {
  const { nextCalendarRun } = require('./calendar');
  return nextCalendarRun({ ...reminder, calendarExceptions: exceptions }, now, calculateNextRun);
}

module.exports = { calculateNextRun, calculateNextCalendarRun, parseTime };
