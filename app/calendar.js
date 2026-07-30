function dateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === value ? date : null;
}

function makeExceptionMap(exceptions = []) {
  return new Map((Array.isArray(exceptions) ? exceptions : []).map((item) => [item.date, item.type]));
}

function isWorkday(date, exceptionMap) {
  const type = exceptionMap.get(dateKey(date));
  if (type === 'holiday' || type === 'pause') return false;
  if (type === 'workday') return true;
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function isPaused(date, pauseDates = [], pauseRanges = []) {
  const key = dateKey(date);
  if ((Array.isArray(pauseDates) ? pauseDates : []).includes(key)) return true;
  return (Array.isArray(pauseRanges) ? pauseRanges : []).some((range) => {
    const [start, end] = String(range).split('~').map((v) => v.trim());
    return start && end && key >= start && key <= end;
  });
}

function isSendable(date, reminder, exceptions = []) {
  const exceptionMap = makeExceptionMap(exceptions);
  const type = exceptionMap.get(dateKey(date));
  if (isPaused(date, reminder.pauseDates, reminder.pauseRanges)) return false;
  if (type === 'pause') return false;
  const mode = reminder.calendarMode || 'calendar_days';
  if (mode === 'workdays' || mode === 'monthly_workday') return isWorkday(date, exceptionMap);
  if (reminder.skipHolidays && type === 'holiday') return false;
  return true;
}

function isNthWorkday(date, n, reminder, exceptions = []) {
  if (!isWorkday(date, makeExceptionMap(exceptions)) || !isSendable(date, reminder, exceptions)) return false;
  let count = 0;
  for (let day = 1; day <= date.getDate(); day += 1) {
    const candidate = new Date(date.getFullYear(), date.getMonth(), day);
    if (isWorkday(candidate, makeExceptionMap(exceptions)) && isSendable(candidate, reminder, exceptions)) count += 1;
  }
  return count === Math.max(1, Number(n || 1));
}

function occursOnDate(reminder, date, exceptions = []) {
  if (!isSendable(date, reminder, exceptions)) return false;
  const mode = reminder.calendarMode || 'calendar_days';
  if (mode === 'monthly_workday') {
    return isNthWorkday(date, reminder.monthlyWorkdayN, reminder, exceptions);
  }
  if (reminder.frequency === 'daily') return true;
  if (reminder.frequency === 'weekly') return Number(reminder.weekday) === date.getDay();
  return reminder.frequency === 'once' && reminder.runDate === dateKey(date);
}

function nextSendDate(start, reminder, exceptions = [], predicate = () => true) {
  const date = new Date(start);
  for (let i = 0; i < 370; i += 1) {
    if (isSendable(date, reminder, exceptions) && predicate(date)) return new Date(date);
    date.setDate(date.getDate() + 1);
  }
  throw new Error('日历规则在未来一年内没有可发送日期');
}

function nextCalendarRun(reminder, now, baseCalculate) {
  const mode = reminder.calendarMode || 'calendar_days';
  const exceptions = reminder.calendarExceptions || [];
  if (mode === 'monthly_workday') {
    const n = Math.max(1, Number(reminder.monthlyWorkdayN || 1));
    const cursor = new Date(now);
    cursor.setDate(1);
    for (let month = 0; month < 14; month += 1) {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      let count = 0;
      for (let day = 0; day < 31; day += 1) {
        const candidate = new Date(first.getFullYear(), first.getMonth(), day + 1);
        if (candidate.getMonth() !== first.getMonth()) break;
        if (isSendable(candidate, reminder, exceptions) && isWorkday(candidate, makeExceptionMap(exceptions))) count += 1;
        if (count === n) {
          const [hour, minute] = String(reminder.runTime).split(':').map(Number);
          candidate.setHours(hour, minute, 0, 0);
          if (candidate > now) return candidate.toISOString();
          break;
        }
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    throw new Error('每月工作日规则无法计算下次发送时间');
  }
  const candidateIso = baseCalculate({ ...reminder, calendarMode: 'calendar_days' }, now);
  if (!candidateIso) return null;
  const candidate = new Date(candidateIso);
  if (isSendable(candidate, reminder, exceptions)) return candidate.toISOString();
  if (reminder.frequency === 'once') return null;
  const [hour, minute] = String(reminder.runTime).split(':').map(Number);
  const next = nextSendDate(candidate, reminder, exceptions, (date) => {
    if (reminder.frequency === 'weekly') return date.getDay() === Number(reminder.weekday);
    return true;
  });
  next.setHours(hour, minute, 0, 0);
  return next.toISOString();
}

module.exports = {
  dateKey,
  parseDateKey,
  makeExceptionMap,
  isWorkday,
  isPaused,
  isSendable,
  isNthWorkday,
  occursOnDate,
  nextCalendarRun
};
