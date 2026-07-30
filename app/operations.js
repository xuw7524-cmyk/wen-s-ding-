const { parseTime } = require('./schedule');
const { dateKey, occursOnDate } = require('./calendar');

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function reminderOccursOn(reminder, day, exceptions = []) {
  if (!reminder.enabled || reminder.status !== 'active') return false;
  return occursOnDate(reminder, day, exceptions);
}

function buildSevenDayPlan(reminders, now = new Date(), exceptions = []) {
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    const items = reminders.filter((reminder) => reminderOccursOn(reminder, day, exceptions)).map((reminder) => {
      const { hour, minute } = parseTime(reminder.runTime);
      const scheduled = new Date(day);
      scheduled.setHours(hour, minute, 0, 0);
      return { reminder, scheduled };
    }).filter(({ scheduled }) => scheduled > now).sort((a, b) => a.scheduled - b.scheduled).map(({ reminder, scheduled }) => ({
      reminderId: reminder.id,
      name: reminder.name,
      robotId: reminder.robotId,
      robotName: reminder.robotName,
      time: reminder.runTime,
      scheduledFor: scheduled.toISOString(),
      sourceType: reminder.sourceType,
      atAll: Boolean(reminder.atAll)
    }));
    days.push({
      date: dateKey(day),
      weekday: weekdayNames[day.getDay()],
      isToday: offset === 0,
      count: items.length,
      items
    });
  }
  return days;
}

function buildHealthReport(input, now = new Date()) {
  const robots = input.robots || [];
  const reminders = input.reminders || [];
  const history = input.history || [];
  const pools = input.pools || [];
  const checks = [];
  const push = (id, level, title, detail) => checks.push({ id, level, title, detail });

  if (input.autoStartEnabled && input.supervised) push('recovery', 'ok', '后台自动恢复正常', 'Windows 登录后会自动启动，异常退出后会重新运行');
  else push('recovery', 'warning', '后台恢复尚未完整开启', '建议开启登录自启和异常恢复，避免关机重启后漏发');

  if (input.sendingEnabled) push('sending', 'ok', '真实发送已启用', '到点后将按启用中的提醒发送');
  else push('sending', 'warning', '真实发送目前关闭', '可以安全编辑和预览，但任何提醒都不会发到群里');

  const enabledRobots = robots.filter((robot) => robot.enabled);
  if (!enabledRobots.length) push('robots', 'error', '没有可用机器人', '请先保存并启用至少一个钉钉机器人');
  else {
    const untested = enabledRobots.filter((robot) => robot.lastTestStatus !== 'success');
    push('robots', untested.length ? 'warning' : 'ok', untested.length ? `${untested.length} 个机器人尚未测试成功` : '机器人连接已验证', untested.length ? '正式启用前建议逐个完成测试发送' : '已启用机器人最近测试成功');
  }

  const activeReminders = reminders.filter((reminder) => reminder.enabled && reminder.status === 'active');
  if (!activeReminders.length) push('reminders', 'warning', '当前没有启用中的提醒', '已有提醒不会自动发送，需确认后手动启用');
  else push('reminders', 'ok', `${activeReminders.length} 条提醒正在排期`, '未来计划会显示在右侧七日视图中');

  const robotMap = new Map(robots.map((robot) => [robot.id, robot]));
  const unavailableTargets = activeReminders.filter((reminder) => !robotMap.get(reminder.robotId)?.enabled);
  if (unavailableTargets.length) push('targets', 'error', `${unavailableTargets.length} 条提醒的机器人不可用`, '请修改目标机器人或重新启用机器人');

  const emptyPools = pools.filter((pool) => pool.enabled && pool.itemCount === 0);
  if (emptyPools.length) push('pools', 'warning', `${emptyPools.length} 个启用内容池为空`, '使用这些池的任务无法生成完整内容');

  const scheduleGroups = new Map();
  activeReminders.filter((item) => item.nextRunAt).forEach((item) => {
    const key = `${item.robotId}:${item.nextRunAt}`;
    scheduleGroups.set(key, (scheduleGroups.get(key) || 0) + 1);
  });
  const duplicateCount = [...scheduleGroups.values()].filter((count) => count > 1).reduce((total, count) => total + count, 0);
  if (duplicateCount) push('duplicates', 'warning', `${duplicateCount} 条提醒时间与目标完全相同`, '请确认是否确实需要同一时间连续发送');

  const failureSince = now.getTime() - 24 * 60 * 60 * 1000;
  const recentFailures = history.filter((item) => item.success === false && new Date(item.createdAt || item.sentAt || 0).getTime() >= failureSince);
  if (recentFailures.length) push('failures', 'error', `最近 24 小时有 ${recentFailures.length} 次失败`, '可在最近发送记录中查看失败原因并重试');

  const rank = { error: 2, warning: 1, ok: 0 };
  const level = checks.reduce((highest, check) => rank[check.level] > rank[highest] ? check.level : highest, 'ok');
  return {
    level,
    errorCount: checks.filter((item) => item.level === 'error').length,
    warningCount: checks.filter((item) => item.level === 'warning').length,
    okCount: checks.filter((item) => item.level === 'ok').length,
    checks
  };
}

function buildOperationsReport(input, now = new Date()) {
  return {
    generatedAt: now.toISOString(),
    health: buildHealthReport(input, now),
    days: buildSevenDayPlan(input.reminders || [], now, input.exceptions || [])
  };
}

module.exports = { dateKey, buildSevenDayPlan, buildHealthReport, buildOperationsReport };
