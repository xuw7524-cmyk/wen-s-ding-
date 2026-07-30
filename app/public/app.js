let reminders = [];
let robots = [];
let history = [];
let contentPools = [];
let contentRules = [];
let phrasePools = [];
let operationsReport = null;
let currentFilter = 'all';
let editingReminderId = null;
let selectedReminderId = null;
let selectedPoolId = null;
let selectedPhraseKind = 'greeting';
let currentSendingEnabled = false;
let loadedHandoverPackage = null;
let updateCheckStarted = false;
let securitySettings = null;
let calendarExceptions = [];
let appStatus = null;
let selectedPlanDate = null;
let reminderDirty = false;
let securityDirty = false;
let robotDirty = false;
let ruleDirty = false;
let toastTimer = null;
let poolRequestSequence = 0;

const reminderRows = document.querySelector('#reminderRows');
const reminderDialog = document.querySelector('#reminderDialog');
const robotsDialog = document.querySelector('#robotsDialog');
const actionsDialog = document.querySelector('#reminderActionsDialog');
const reminderForm = document.querySelector('#reminderForm');
const robotForm = document.querySelector('#robotForm');
const robotList = document.querySelector('#robotList');
const historyList = document.querySelector('#historyList');
const robotEditor = document.querySelector('#robotEditor');
const toast = document.querySelector('#toast');
const robotFormStatus = document.querySelector('#robotFormStatus');
const saveRobotButton = document.querySelector('#saveRobotButton');
const poolsDialog = document.querySelector('#poolsDialog');
const rulesDialog = document.querySelector('#rulesDialog');
const poolSummary = document.querySelector('#poolSummary');
const poolDialogList = document.querySelector('#poolDialogList');
const poolDetail = document.querySelector('#poolDetail');
const ruleForm = document.querySelector('#ruleForm');
const phrasePoolsDialog = document.querySelector('#phrasePoolsDialog');
const phrasePoolList = document.querySelector('#phrasePoolList');
const phrasePoolDetail = document.querySelector('#phrasePoolDetail');
const handoverDialog = document.querySelector('#handoverDialog');
const handoverPreview = document.querySelector('#handoverPreview');
const confirmHandoverImportButton = document.querySelector('#confirmHandoverImportButton');
const healthChecks = document.querySelector('#healthChecks');
const weekPlan = document.querySelector('#weekPlan');
const reminderMessagePreview = document.querySelector('#reminderMessagePreview');
const securityDialog = document.querySelector('#securityDialog');
const dayPlanDialog = document.querySelector('#dayPlanDialog');
const historyDialog = document.querySelector('#historyDialog');

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: options.signal || controller.signal,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `本地后台处理失败（${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('读取本地后台超时，请确认程序仍在运行后重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  const openDialog = document.querySelector('dialog[open]');
  (openDialog || document.body).appendChild(toast);
  toast.textContent = message;
  toast.classList.add('is-visible');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
    toastTimer = null;
  }, 3200);
}

function showRobotFormStatus(message = '', type = '') {
  robotFormStatus.textContent = message;
  robotFormStatus.className = `form-status${message ? '' : ' is-hidden'}${type ? ` ${type}` : ''}`;
}

function statusText(status) {
  return { active: '启用中', paused: '已暂停', complete: '已完成', failed: '失败' }[status] || status;
}

function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function ruleText(item) {
  if (item.calendarMode === 'monthly_workday') return `每月第 ${item.monthlyWorkdayN} 个工作日 ${item.runTime}`;
  if (item.frequency === 'daily') return `每天 ${item.runTime}`;
  if (item.frequency === 'weekly') {
    const names = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${names[item.weekday]} ${item.runTime}`;
  }
  return `${item.runDate} ${item.runTime}`;
}

function lastResultPresentation(item) {
  if (!item.lastRunAt && (!item.lastResult || item.lastResult === 'waiting')) {
    return { className: 'result-waiting', text: '等待首次发送' };
  }
  const result = item.lastResult;
  if (result === 'success') return { className: 'result-success', text: `${formatDateTime(item.lastRunAt)} 发送成功` };
  if (result === 'skipped') return { className: 'result-waiting', text: `${formatDateTime(item.lastRunAt)} 已按规则跳过` };
  if (result === 'failed_auto_paused') return { className: 'result-failed', text: '连续失败，已自动暂停' };
  if (result === 'delivery_unknown') return { className: 'result-failed', text: '发送结果未知，请核对群消息' };
  if (result === 'failed') return { className: 'result-failed', text: `${formatDateTime(item.lastRunAt)} 发送失败` };
  return { className: 'result-waiting', text: item.lastRunAt ? `${formatDateTime(item.lastRunAt)} 已处理` : '等待首次发送' };
}

function robotColor(id) {
  const colors = ['#1769e0', '#7c5ce7', '#e9822b', '#169c65', '#d24d72'];
  return colors[(Number(id) - 1) % colors.length];
}

function renderReminders() {
  const visible = reminders.filter((item) => currentFilter === 'all' || item.status === currentFilter);
  if (!visible.length) {
    reminderRows.innerHTML = `
      <tr><td colspan="6"><div class="empty-state"><strong>${reminders.length ? '当前筛选条件下没有提醒' : '还没有提醒任务'}</strong><small>${reminders.length ? '可以切换到“全部”查看' : '先添加一个机器人，再创建第一条提醒'}</small></div></td></tr>
    `;
    updateMetrics();
    return;
  }

  reminderRows.innerHTML = visible.map((item) => {
    const result = lastResultPresentation(item);
    return `
    <tr>
      <td><div class="reminder-name"><strong>${escapeHtml(item.name)}</strong><small>${item.sourceType === 'pool_rule' ? `内容池规则：${escapeHtml(item.contentRuleName || '未找到')}` : escapeHtml(item.message)}</small><small>${item.messageFormat === 'markdown' ? 'Markdown 排版' : '普通文本'}${item.atAll ? ' · @所有人' : ''}</small></div></td>
      <td><span class="robot-pill" style="--robot-color:${robotColor(item.robotId)}">${escapeHtml(item.robotName)}</span></td>
      <td><div class="cell-stack"><strong>${escapeHtml(ruleText(item))}</strong><small>下次：${escapeHtml(formatDateTime(item.nextRunAt))}</small></div></td>
      <td><span class="${result.className}">${escapeHtml(result.text)}</span></td>
      <td><span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(statusText(item.status))}</span></td>
      <td><div class="row-actions"><button class="row-button" data-action="toggle" data-id="${item.id}" aria-label="${item.enabled ? `暂停提醒 ${escapeHtml(item.name)}` : `启用提醒 ${escapeHtml(item.name)}`}">${item.enabled ? 'Ⅱ' : '▶'}</button><button class="row-button" data-action="more" data-id="${item.id}" aria-label="打开提醒 ${escapeHtml(item.name)} 的更多操作">•••</button></div></td>
    </tr>
  `; }).join('');
  updateMetrics();
}

function renderRobots() {
  if (!robots.length) {
    robotList.innerHTML = '<div class="empty-state"><strong>还没有机器人</strong><small>展开下方“添加机器人”开始配置</small></div>';
  } else {
    robotList.innerHTML = robots.map((robot) => `
      <article class="robot-card">
        <span class="robot-avatar" style="--robot-color:${robotColor(robot.id)}">${escapeHtml(robot.name.slice(0, 1))}</span>
        <div><strong>${escapeHtml(robot.name)}</strong><small>关键词：${escapeHtml(robot.keyword)} · ${escapeHtml(robot.webhookHint)}${robot.hasSecret ? ' · 已加签' : ''}</small></div>
        <div class="robot-meta"><span class="status-pill ${robot.enabled ? 'active' : 'paused'}">${robot.lastTestStatus === 'success' ? '测试成功' : robot.lastTestStatus === 'failed' ? '测试失败' : robot.enabled ? '未测试' : '已停用'}</span><div class="mini-actions"><button data-robot-action="test" data-id="${robot.id}" type="button">测试发送</button><button data-robot-action="edit" data-id="${robot.id}" type="button">编辑</button><button data-robot-action="delete" data-id="${robot.id}" type="button">删除</button></div></div>
      </article>
    `).join('');
  }
  document.querySelector('#robotCountBadge').textContent = robots.length;
  refreshRobotSelect();
  updateMetrics();
}

function renderHistory() {
  if (!history.length) {
    historyList.innerHTML = '<li class="empty-history"><div><strong>还没有发送记录</strong><small>启用真实发送后，结果会显示在这里</small></div></li>';
    updateMetrics();
    return;
  }
  historyList.innerHTML = history.slice(0, 5).map((item) => `
    <li>
      <span class="history-icon ${item.success ? 'success' : 'muted'}">${item.success ? '✓' : '—'}</span>
      <div><strong>${escapeHtml(item.reminderName)}</strong><small>${escapeHtml(item.robotName)} · ${escapeHtml(formatDateTime(item.sentAt || item.scheduledFor))}</small></div>
      <span class="result-label ${item.success ? 'success-text' : ''}">${item.success ? '发送成功' : item.success === false ? '发送失败' : '等待发送'}</span>
    </li>
  `).join('');
  updateMetrics();
}

function renderOperations() {
  if (!operationsReport) return;
  const { health, days } = operationsReport;
  const statusText = health.level === 'error'
    ? `${health.errorCount} 项需要处理`
    : health.level === 'warning'
      ? `${health.warningCount} 项需要确认`
      : '状态正常';
  const status = document.querySelector('#operationsStatus');
  status.textContent = statusText;
  status.className = `operations-status ${health.level}`;
  document.querySelector('#healthSummary').textContent = health.level === 'ok'
    ? '所有关键检查均正常'
    : `正常 ${health.okCount} 项 · 提醒 ${health.warningCount} 项 · 问题 ${health.errorCount} 项`;
  document.querySelector('#healthScore').textContent = health.level === 'ok' ? '良好' : health.level === 'warning' ? '待确认' : '需处理';
  document.querySelector('#healthScore').className = `health-score ${health.level}`;
  healthChecks.innerHTML = health.checks.map((check) => `
    <article class="health-check ${check.level}">
      <span class="check-icon" aria-hidden="true">${check.level === 'ok' ? '✓' : check.level === 'warning' ? '!' : '×'}</span>
      <div><strong>${escapeHtml(check.title)}</strong><small>${escapeHtml(check.detail)}</small></div>
    </article>
  `).join('');
  const total = days.reduce((sum, day) => sum + day.count, 0);
  document.querySelector('#weekTotal').textContent = `${total} 条`;
  weekPlan.innerHTML = days.map((day) => `
    <button type="button" class="day-plan ${day.isToday ? 'is-today' : ''} ${day.count ? 'has-items' : ''}" data-plan-date="${escapeHtml(day.date)}" aria-label="${escapeHtml(day.date)}，${day.count} 条提醒，点击查看详情">
      <div class="day-heading"><span>${day.isToday ? '今天' : escapeHtml(day.weekday)}</span><strong>${escapeHtml(day.date.slice(5).replace('-', '/'))}</strong></div>
      <span class="day-count">${day.count ? `${day.count} 条` : '无任务'}</span>
      <div class="day-items">${day.items.slice(0, 3).map((item) => `<div title="${escapeHtml(item.name)}"><time>${escapeHtml(item.time)}</time><span>${escapeHtml(item.name)}</span></div>`).join('')}${day.items.length > 3 ? `<small>另有 ${day.items.length - 3} 条</small>` : ''}</div>
    </button>
  `).join('');
}

function renderHistoryDialog() {
  const box = document.querySelector('#historyDialogList');
  box.innerHTML = history.length ? history.map((item) => `
    <article class="history-detail-card ${item.success === false ? 'failed' : item.success ? 'success' : 'skipped'}">
      <header><strong>${escapeHtml(item.reminderName)}</strong><span>${item.success ? '发送成功' : item.success === false ? '发送失败' : '跳过 / 待核对'}</span></header>
      <p>${escapeHtml(item.robotName)} · 计划 ${escapeHtml(formatDateTime(item.scheduledFor))}${item.sentAt ? ` · 实际 ${escapeHtml(formatDateTime(item.sentAt))}` : ''}</p>
      <pre>${escapeHtml(item.contentPreview || '没有消息内容记录')}</pre>
      <small>返回：${escapeHtml(item.responseCode || '—')} · ${escapeHtml(item.responseMessage || '没有附加说明')}${item.retried ? ' · 已重试' : ' · 未重试'}</small>
    </article>
  `).join('') : '<div class="empty-state"><strong>还没有发送记录</strong><small>正式发送、跳过和失败结果会显示在这里</small></div>';
}

function renderPoolSummary() {
  const riskHtml = contentPools.length ? contentPools.map((pool) => {
      const progress = pool.itemCount ? Math.round((pool.usedInCycle / pool.itemCount) * 100) : 0;
      return `
        <article class="pool-summary-card">
          <strong>${escapeHtml(pool.name)}</strong><small>第 ${pool.currentCycle} 轮</small>
          <small>${pool.itemCount ? `下次位置 ${pool.currentPosition} / ${pool.itemCount}` : '暂无内容'}</small><small>已使用 ${pool.usedInCycle} 条</small>
          <div class="pool-progress"><span style="width:${progress}%"></span></div>
        </article>
      `;
    }).join('') : '<div class="empty-state"><strong>还没有风险内容池</strong><small>建议先创建 A池 和 B池</small></div>';
  const phraseHtml = phrasePools.length ? `
    <div class="pool-section-label">三套顺序话术池</div>
    ${phrasePools.map((pool) => `
      <article class="pool-summary-card">
        <strong>${escapeHtml(pool.displayName)}</strong><small>第 ${pool.currentCycle} 轮</small>
        <small>${pool.itemCount ? `${pool.itemCount} 条 · 下次位置 ${pool.currentPosition}` : '等待录入话术'}</small><small>本轮已用 ${pool.usedInCycle}</small>
      </article>
    `).join('')}
  ` : '';
  poolSummary.innerHTML = riskHtml + phraseHtml;
  renderPoolDialogList();
  refreshRuleAndPreviewSelects();
}

function renderPoolDialogList() {
  if (!contentPools.length) {
    poolDialogList.innerHTML = '<div class="empty-state"><small>创建第一个内容池</small></div>';
    return;
  }
  poolDialogList.innerHTML = contentPools.map((pool) => `
    <button class="pool-select-button ${pool.id === selectedPoolId ? 'is-active' : ''}" data-pool-id="${pool.id}" type="button">
      <strong>${escapeHtml(pool.name)}</strong><small>${pool.itemCount} 条 · 第 ${pool.currentCycle} 轮</small>
    </button>
  `).join('');
}

function renderPoolDetail(pool) {
  const enabledItems = pool.items.filter((item) => item.enabled);
  const nextItem = enabledItems.find((item) => !item.usedInCurrentCycle) || enabledItems[0];
  poolDetail.innerHTML = `
    <div class="pool-detail-head">
      <div><h3>${escapeHtml(pool.name)}</h3><p>${escapeHtml(pool.description || '暂无说明')} · 当前第 ${pool.currentCycle} 轮 · 下次位置 ${pool.currentPosition || 0}</p></div>
      <div class="pool-tools"><button class="small-button" data-pool-action="select-all" type="button">全选</button><button class="small-button" data-pool-action="delete-selected" type="button">删除勾选</button><button class="small-button delete" data-pool-action="clear-items" type="button">清空内容</button><button class="small-button" data-pool-action="reset" type="button">重置一轮</button><button class="small-button delete" data-pool-action="delete-pool" type="button">删除池</button></div>
    </div>
    <form class="bulk-entry" id="bulkItemsForm">
      <label class="field"><span>批量录入内容</span><textarea name="bulkText" required placeholder="在这里粘贴二三十条内容。默认每个空行分隔一条。"></textarea></label>
      <div class="bulk-entry-side">
        <label class="field"><span>分隔方式</span><select name="splitMode"><option value="paragraph">空行分隔</option><option value="line">每行一条</option></select></label>
        <button class="button button-primary" type="submit">批量加入</button>
      </div>
    </form>
    ${enabledItems.length ? `<div class="next-item-control"><label><span>下一次从这里开始</span><select data-pool-next-item>${enabledItems.map((item) => `<option value="${item.id}" ${item.id === nextItem?.id ? 'selected' : ''}>第 ${pool.items.indexOf(item) + 1} 条 · ${escapeHtml(item.content.slice(0, 36))}</option>`).join('')}</select></label><button class="small-button" data-pool-action="set-next" type="button">设为下一条</button><small>排序不会自动改进度；需要时在这里指定新的起点。</small></div>` : ''}
    <div class="content-item-list">
      ${pool.items.length ? pool.items.map((item, index) => `
        <article class="content-item ${item.enabled ? '' : 'is-disabled'}">
          <input class="item-check" data-item-select type="checkbox" value="${item.id}" aria-label="选择第 ${index + 1} 条内容" />
          <span class="item-number">${index + 1}</span>
          <div><p>${escapeHtml(item.content)}</p><small>${item.usedInCurrentCycle ? '本轮已使用' : '本轮待使用'} · 累计 ${item.useCount} 次${item.lastUsedAt ? ` · 上次 ${escapeHtml(formatDateTime(item.lastUsedAt))}` : ''}</small></div>
          <div class="item-actions"><button data-item-action="move-up" data-id="${item.id}" type="button" ${index === 0 ? 'disabled' : ''}>↑ 上移</button><button data-item-action="move-down" data-id="${item.id}" type="button" ${index === pool.items.length - 1 ? 'disabled' : ''}>↓ 下移</button><button data-item-action="edit" data-id="${item.id}" type="button">编辑</button><button data-item-action="toggle" data-id="${item.id}" type="button">${item.enabled ? '停用' : '启用'}</button><button class="delete" data-item-action="delete" data-id="${item.id}" type="button">删除</button></div>
        </article>
      `).join('') : '<div class="empty-state"><strong>当前内容池还是空的</strong><small>可以一次粘贴二三十条，按空行自动拆分</small></div>'}
    </div>
  `;
}

function renderPhrasePoolList() {
  phrasePoolList.innerHTML = phrasePools.map((pool) => `
    <button class="pool-select-button ${pool.kind === selectedPhraseKind ? 'is-active' : ''}" data-phrase-kind="${pool.kind}" type="button">
      <strong>${escapeHtml(pool.displayName)}</strong><small>${pool.itemCount} 条 · 第 ${pool.currentCycle} 轮</small>
    </button>
  `).join('');
}

function renderPhrasePoolDetail(pool) {
  const enabledItems = pool.items.filter((item) => item.enabled);
  const nextItem = enabledItems.find((item) => !item.usedInCurrentCycle) || enabledItems[0];
  phrasePoolDetail.innerHTML = `
    <div class="pool-detail-head">
      <div><h3>${escapeHtml(pool.displayName)}</h3><p>按当前顺序循环 · 当前第 ${pool.currentCycle} 轮 · 本轮已使用 ${pool.usedInCycle} 条</p></div>
      <div class="pool-tools"><button class="small-button" data-phrase-pool-action="select-all" type="button">全选</button><button class="small-button" data-phrase-pool-action="delete-selected" type="button">删除勾选</button><button class="small-button delete" data-phrase-pool-action="clear-items" type="button">清空话术</button><button class="small-button" data-phrase-pool-action="reset" type="button">重置一轮</button></div>
    </div>
    <form class="bulk-entry" id="bulkPhrasesForm">
      <label class="field"><span>批量录入${escapeHtml(pool.displayName)}内容</span><textarea name="bulkText" required placeholder="每个空行分隔一条，也可以选择每行一条。"></textarea></label>
      <div class="bulk-entry-side">
        <label class="field"><span>分隔方式</span><select name="splitMode"><option value="paragraph">空行分隔</option><option value="line">每行一条</option></select></label>
        <button class="button button-primary" type="submit">批量加入</button>
      </div>
    </form>
    ${enabledItems.length ? `<div class="next-item-control"><label><span>下一次从这里开始</span><select data-phrase-next-item>${enabledItems.map((item) => `<option value="${item.id}" ${item.id === nextItem?.id ? 'selected' : ''}>第 ${pool.items.indexOf(item) + 1} 条 · ${escapeHtml(item.content.slice(0, 36))}</option>`).join('')}</select></label><button class="small-button" data-phrase-pool-action="set-next" type="button">设为下一条</button><small>新增话术默认排在末尾；可先上下移动，再指定下一条。</small></div>` : ''}
    <div class="content-item-list">
      ${pool.items.length ? pool.items.map((item, index) => `
        <article class="content-item ${item.enabled ? '' : 'is-disabled'}">
          <input class="item-check" data-phrase-select type="checkbox" value="${item.id}" aria-label="选择第 ${index + 1} 条话术" />
          <span class="item-number">${index + 1}</span>
          <div><p>${escapeHtml(item.content)}</p><small>${item.usedInCurrentCycle ? '本轮已使用' : '本轮待使用'} · 累计 ${item.useCount} 次${item.lastUsedAt ? ` · 上次 ${escapeHtml(formatDateTime(item.lastUsedAt))}` : ''}</small></div>
          <div class="item-actions"><button data-phrase-action="move-up" data-id="${item.id}" type="button" ${index === 0 ? 'disabled' : ''}>↑ 上移</button><button data-phrase-action="move-down" data-id="${item.id}" type="button" ${index === pool.items.length - 1 ? 'disabled' : ''}>↓ 下移</button><button data-phrase-action="edit" data-id="${item.id}" type="button">编辑</button><button data-phrase-action="toggle" data-id="${item.id}" type="button">${item.enabled ? '停用' : '启用'}</button><button class="delete" data-phrase-action="delete" data-id="${item.id}" type="button">删除</button></div>
        </article>
      `).join('') : '<div class="empty-state"><strong>这套话术池还是空的</strong><small>批量粘贴后，会按排序从第 1 条开始循环</small></div>'}
    </div>
  `;
}

function selectPhrasePool(kind) {
  selectedPhraseKind = kind;
  renderPhrasePoolList();
  const pool = phrasePools.find((item) => item.kind === kind);
  if (pool) renderPhrasePoolDetail(pool);
}

async function selectPool(poolId) {
  const requestedId = Number(poolId);
  selectedPoolId = requestedId;
  const sequence = ++poolRequestSequence;
  renderPoolDialogList();
  const data = await api(`/api/content-pools/${requestedId}`);
  if (sequence !== poolRequestSequence || selectedPoolId !== requestedId) return;
  renderPoolDetail(data.pool);
}

function poolOptions(selectedId, allowEmpty = true) {
  const empty = allowEmpty ? '<option value="">不使用</option>' : '';
  return empty + contentPools.filter((pool) => pool.enabled).map((pool) => `
    <option value="${pool.id}" ${Number(selectedId) === pool.id ? 'selected' : ''}>${escapeHtml(pool.name)}</option>
  `).join('');
}

function renderWeekdayRuleRows(rule = null) {
  const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const displayOrder = [1, 2, 3, 4, 5, 6, 0];
  document.querySelector('#weekdayRuleRows').innerHTML = displayOrder.map((weekday) => {
    const allocations = (rule?.allocations || []).filter((item) => item.weekday === weekday).slice(0, 2);
    const first = allocations[0] || {};
    const second = allocations[1] || {};
    return `
      <div class="weekday-rule-row" data-weekday="${weekday}">
        <strong>${dayNames[weekday]}</strong>
        <select data-slot="1" aria-label="${dayNames[weekday]}第一个内容池">${poolOptions(first.poolId)}</select>
        <input data-count="1" type="number" min="0" max="50" value="${first.itemCount || 0}" aria-label="${dayNames[weekday]}第一个池抽取数量" />
        <select data-slot="2" aria-label="${dayNames[weekday]}第二个内容池">${poolOptions(second.poolId)}</select>
        <input data-count="2" type="number" min="0" max="50" value="${second.itemCount || 0}" aria-label="${dayNames[weekday]}第二个池抽取数量" />
      </div>
    `;
  }).join('');
}

function refreshRuleAndPreviewSelects() {
  const editor = document.querySelector('#ruleEditorSelect');
  const editorValue = editor.value;
  editor.innerHTML = '<option value="">＋ 新建规则</option>' + contentRules.map((rule) => `<option value="${rule.id}">${escapeHtml(rule.name)}</option>`).join('');
  if (contentRules.some((rule) => String(rule.id) === editorValue)) editor.value = editorValue;
  const previewSelect = document.querySelector('#previewRuleSelect');
  const previewValue = previewSelect.value;
  previewSelect.innerHTML = contentRules.length
    ? contentRules.map((rule) => `<option value="${rule.id}">${escapeHtml(rule.name)}</option>`).join('')
    : '<option value="">请先设置星期规则</option>';
  if (contentRules.some((rule) => String(rule.id) === previewValue)) previewSelect.value = previewValue;
  const reminderSelect = reminderForm.elements.contentRuleId;
  const reminderValue = reminderSelect.value;
  reminderSelect.innerHTML = contentRules.length
    ? contentRules.map((rule) => `<option value="${rule.id}">${escapeHtml(rule.name)}</option>`).join('')
    : '<option value="">请先创建内容池规则</option>';
  if (contentRules.some((rule) => String(rule.id) === reminderValue)) reminderSelect.value = reminderValue;
}

function resetRuleForm(rule = null) {
  ruleForm.reset();
  ruleForm.elements.ruleId.value = rule ? String(rule.id) : '';
  ruleForm.elements.name.value = rule?.name || '';
  ruleForm.elements.messageTitle.value = rule?.messageTitle || '每日风险提醒';
  ruleForm.elements.layoutMode.value = rule?.layoutMode || 'balanced';
  document.querySelector('#deleteRuleButton').classList.toggle('is-hidden', !rule);
  renderWeekdayRuleRows(rule);
  ruleDirty = false;
}

function collectRuleAllocations() {
  const allocations = [];
  document.querySelectorAll('.weekday-rule-row').forEach((row) => {
    [1, 2].forEach((slot) => {
      const poolId = Number(row.querySelector(`[data-slot="${slot}"]`).value);
      const itemCount = Number(row.querySelector(`[data-count="${slot}"]`).value);
      if (poolId && itemCount > 0) allocations.push({
        weekday: Number(row.dataset.weekday), slotOrder: slot, poolId, itemCount
      });
    });
  });
  return allocations;
}

function refreshRobotSelect() {
  const select = reminderForm.elements.robotId;
  const previous = select.value;
  const enabledRobots = robots.filter((robot) => robot.enabled);
  select.innerHTML = enabledRobots.length
    ? enabledRobots.map((robot) => `<option value="${robot.id}">${escapeHtml(robot.name)}</option>`).join('')
    : '<option value="">请先添加并启用机器人</option>';
  if (enabledRobots.some((robot) => String(robot.id) === previous)) select.value = previous;
  const previewSelect = document.querySelector('#previewRobotSelect');
  const previewPrevious = previewSelect.value;
  previewSelect.innerHTML = enabledRobots.length
    ? enabledRobots.map((robot) => `<option value="${robot.id}">${escapeHtml(robot.name)}</option>`).join('')
    : '<option value="">暂无可用机器人</option>';
  if (enabledRobots.some((robot) => String(robot.id) === previewPrevious)) previewSelect.value = previewPrevious;
}

function updateMetrics() {
  const active = reminders.filter((item) => item.status === 'active').length;
  const inactive = reminders.length - active;
  const today = new Date();
  const todayCount = reminders.filter((item) => {
    if (!item.nextRunAt) return false;
    const next = new Date(item.nextRunAt);
    return next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth() && next.getDate() === today.getDate();
  }).length;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const successCount = history.filter((item) => item.success && new Date(item.createdAt || item.sentAt).getTime() >= sevenDaysAgo).length;
  document.querySelector('#activeMetric').textContent = active;
  document.querySelector('#inactiveMetric').textContent = inactive;
  document.querySelector('#todayMetric').textContent = todayCount;
  document.querySelector('#successMetric').textContent = successCount;
  document.querySelector('#activeMetricDetail').textContent = robots.length ? `${robots.length} 个机器人已保存` : '尚未添加机器人';
  document.querySelector('#todayMetricDetail').textContent = todayCount ? '后台已计算下次运行时间' : '今天暂无任务';
  document.querySelector('#successMetricDetail').textContent = history.length ? `最近 7 天成功 ${successCount} 次` : '尚无发送记录';
}

function updateScheduleFields() {
  const monthly = reminderForm.elements.calendarMode.value === 'monthly_workday';
  if (monthly) reminderForm.elements.frequency.value = 'daily';
  reminderForm.querySelectorAll('[name="frequency"]').forEach((radio) => {
    radio.disabled = monthly && radio.value !== 'daily';
  });
  const frequency = reminderForm.elements.frequency.value;
  const once = frequency === 'once';
  const dateInput = reminderForm.elements.date;
  document.querySelector('#dateField').classList.toggle('is-hidden', !once);
  document.querySelector('#weekdayField').classList.toggle('is-hidden', frequency !== 'weekly');
  dateInput.required = once;
  dateInput.min = localDateInputValue(new Date());
  if (once && !dateInput.value) dateInput.value = nearestOnceDate();
  document.querySelector('#monthlyWorkdayField')?.classList.toggle('is-hidden', !monthly);
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function nearestOnceDate() {
  const now = new Date();
  const candidate = new Date(now);
  const [hour, minute] = String(reminderForm.elements.time.value || '09:30').split(':').map(Number);
  candidate.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 30, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  return localDateInputValue(candidate);
}

function updateMessageSourceFields() {
  const sourceType = reminderForm.elements.sourceType.value;
  const fixed = sourceType === 'fixed';
  document.querySelector('#fixedMessageField').classList.toggle('is-hidden', !fixed);
  document.querySelector('#contentRuleField').classList.toggle('is-hidden', fixed);
  reminderForm.elements.message.required = fixed;
  reminderForm.elements.contentRuleId.required = !fixed;
}

function updateMessageFormatFields() {
  const markdown = reminderForm.elements.messageFormat.value === 'markdown';
  document.querySelector('#messageTitleField').classList.toggle('is-hidden', !markdown);
}

function collectReminderPayload() {
  const data = new FormData(reminderForm);
  return {
    name: data.get('name'),
    robotId: Number(data.get('robotId')),
    message: data.get('message'),
    sourceType: data.get('sourceType'),
    contentRuleId: Number(data.get('contentRuleId')) || null,
    messageFormat: data.get('messageFormat'),
    messageTitle: data.get('messageTitle'),
    mentionMobiles: '',
    frequency: data.get('frequency'),
    runDate: data.get('date'),
    runTime: data.get('time'),
    weekday: Number(data.get('weekday')),
    atAll: data.get('atAll') === 'on',
    enabled: data.get('enabled') === 'on',
    missedPolicy: data.get('catchUp') === 'on' ? 'catch_up' : 'skip'
    ,calendarMode: data.get('calendarMode') || 'calendar_days'
    ,monthlyWorkdayN: Number(data.get('monthlyWorkdayN') || 1)
    ,skipHolidays: data.get('skipHolidays') === 'on'
    ,pauseDates: data.get('pauseDates') || ''
    ,pauseRanges: data.get('pauseRanges') || ''
    ,previewConfirmRequired: data.get('previewConfirmRequired') === 'on'
  };
}

function reminderPayloadFromItem(item) {
  return {
    name: item.name,
    robotId: item.robotId,
    message: item.message,
    sourceType: item.sourceType,
    contentRuleId: item.contentRuleId,
    messageFormat: item.messageFormat,
    messageTitle: item.messageTitle,
    mentionMobiles: '',
    frequency: item.frequency,
    runDate: item.runDate,
    runTime: item.runTime,
    weekday: item.weekday,
    atAll: item.atAll,
    enabled: item.enabled,
    missedPolicy: item.missedPolicy,
    calendarMode: item.calendarMode,
    monthlyWorkdayN: item.monthlyWorkdayN,
    skipHolidays: item.skipHolidays,
    pauseDates: item.pauseDates,
    pauseRanges: item.pauseRanges,
    previewConfirmRequired: item.previewConfirmRequired
  };
}

function resetReminderForm() {
  editingReminderId = null;
  reminderForm.reset();
  reminderForm.elements.frequency.value = 'daily';
  reminderForm.elements.sourceType.value = 'fixed';
  reminderForm.elements.messageFormat.value = 'text';
  reminderForm.elements.enabled.checked = true;
  reminderForm.elements.calendarMode.value = 'calendar_days';
  reminderForm.elements.monthlyWorkdayN.value = '1';
  reminderForm.elements.skipHolidays.checked = false;
  reminderForm.elements.previewConfirmRequired.checked = false;
  reminderMessagePreview.classList.add('is-hidden');
  reminderMessagePreview.innerHTML = '';
  document.querySelector('#saveReminderButton').textContent = '保存提醒';
  reminderDialog.querySelector('h2').textContent = '新建提醒';
  updateScheduleFields();
  updateMessageSourceFields();
  updateMessageFormatFields();
  refreshRobotSelect();
  reminderDirty = false;
}

function openReminderEditor(item = null) {
  if (!robots.some((robot) => robot.enabled)) {
    robotsDialog.showModal();
    robotEditor.open = true;
    showToast('请先添加一个机器人，再创建提醒');
    return;
  }
  resetReminderForm();
  reminderDialog.showModal();
  reminderDialog.scrollTop = 0;
  if (item) {
    editingReminderId = item.id;
    reminderForm.elements.name.value = item.name;
    reminderForm.elements.robotId.value = String(item.robotId);
    reminderForm.elements.message.value = item.message;
    reminderForm.elements.sourceType.value = item.sourceType || 'fixed';
    reminderForm.elements.contentRuleId.value = item.contentRuleId ? String(item.contentRuleId) : '';
    reminderForm.elements.messageFormat.value = item.messageFormat || 'text';
    reminderForm.elements.messageTitle.value = item.messageTitle || '';
    reminderForm.elements.frequency.value = item.frequency;
    reminderForm.elements.date.value = item.runDate || '';
    reminderForm.elements.time.value = item.runTime;
    reminderForm.elements.weekday.value = String(item.weekday ?? 1);
    reminderForm.elements.atAll.checked = item.atAll;
    reminderForm.elements.enabled.checked = item.enabled;
    reminderForm.elements.catchUp.checked = item.missedPolicy === 'catch_up';
    reminderForm.elements.calendarMode.value = item.calendarMode || 'calendar_days';
    reminderForm.elements.monthlyWorkdayN.value = item.monthlyWorkdayN || 1;
    reminderForm.elements.skipHolidays.checked = Boolean(item.skipHolidays);
    reminderForm.elements.pauseDates.value = (item.pauseDates || []).join(', ');
    reminderForm.elements.pauseRanges.value = (item.pauseRanges || []).join(', ');
    reminderForm.elements.previewConfirmRequired.checked = Boolean(item.previewConfirmRequired);
    document.querySelector('#saveReminderButton').textContent = '保存修改';
    reminderDialog.querySelector('h2').textContent = '编辑提醒';
    updateScheduleFields();
    updateMessageSourceFields();
    updateMessageFormatFields();
  }
  reminderDirty = false;
}

function resetRobotEditor() {
  robotForm.reset();
  robotForm.elements.id.value = '';
  robotForm.elements.keyword.value = '定时通知';
  robotForm.elements.webhook.required = true;
  document.querySelector('#robotEditorSummary').textContent = '＋ 添加机器人';
  document.querySelector('#saveRobotButton').textContent = '保存机器人';
  document.querySelector('#webhookHelp').textContent = '新机器人必须填写；保存后只能看到末尾 4 位。';
  document.querySelector('#cancelRobotEdit').classList.add('is-hidden');
  showRobotFormStatus();
  robotDirty = false;
}

function editRobot(robot) {
  robotForm.elements.id.value = robot.id;
  robotForm.elements.name.value = robot.name;
  robotForm.elements.keyword.value = robot.keyword;
  robotForm.elements.webhook.value = '';
  robotForm.elements.webhook.required = false;
  robotForm.elements.secret.value = '';
  document.querySelector('#robotEditorSummary').textContent = `编辑：${robot.name}`;
  document.querySelector('#saveRobotButton').textContent = '保存修改';
  document.querySelector('#webhookHelp').textContent = '如不更换 Webhook，请留空；签名密钥同样留空则保持不变。';
  document.querySelector('#cancelRobotEdit').classList.remove('is-hidden');
  robotEditor.open = true;
  robotForm.elements.name.focus();
  robotDirty = false;
}

function closeRobotsDialog() {
  if (robotDirty && !window.confirm('机器人还有未保存的修改，确定放弃并关闭吗？')) return;
  robotDirty = false;
  robotsDialog.close();
}

function closeRulesDialog() {
  if (ruleDirty && !window.confirm('星期规则还有未保存的修改，确定放弃并关闭吗？')) return false;
  ruleDirty = false;
  rulesDialog.close();
  return true;
}

async function reloadData() {
  const results = await Promise.allSettled([
    api('/api/robots'), api('/api/reminders'), api('/api/history'), api('/api/status'),
    api('/api/content-pools'), api('/api/content-rules'), api('/api/phrase-pools'), api('/api/operations'), api('/api/security')
  ]);
  const statusResult = results[3];
  if (statusResult.status === 'rejected') throw statusResult.reason;
  const value = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
  const robotsData = value(0, { robots });
  const remindersData = value(1, { reminders });
  const historyData = value(2, { history });
  const statusData = statusResult.value;
  const poolsData = value(4, { pools: contentPools });
  const rulesData = value(5, { rules: contentRules });
  const phraseData = value(6, { pools: phrasePools });
  const operationsData = value(7, operationsReport);
  const securityData = value(8, { settings: securitySettings || {}, exceptions: calendarExceptions });
  robots = robotsData.robots || [];
  reminders = remindersData.reminders || [];
  history = historyData.history || [];
  contentPools = poolsData.pools || [];
  contentRules = rulesData.rules || [];
  phrasePools = phraseData.pools || [];
  operationsReport = operationsData;
  securitySettings = securityData.settings || {};
  calendarExceptions = securityData.exceptions || [];
  appStatus = statusData;
  currentSendingEnabled = statusData.sendingEnabled;
  renderRobots();
  renderReminders();
  renderHistory();
  renderPoolSummary();
  if (operationsReport) renderOperations();
  document.querySelector('#topCurrentVersion').textContent = statusData.currentVersion;
  const emergencyStopped = securitySettings.global_emergency_stop === 'true';
  const pausedToday = securitySettings.pause_today === localDateInputValue(new Date());
  const effectivelySending = currentSendingEnabled && !emergencyStopped && !pausedToday && !statusData.handoverPending;
  document.querySelector('#sidebarServiceState').textContent = effectivelySending ? '运行中' : currentSendingEnabled ? '已拦截' : '仅保存';
  document.querySelector('.status-dot').classList.remove('offline');
  document.querySelector('#systemStateTitle').textContent = statusData.handoverPending
    ? '等待本机接管确认'
    : emergencyStopped
      ? '全局紧急停止已开启'
      : pausedToday
        ? '今天的全部消息已暂停'
        : currentSendingEnabled ? '后台定时发送已启用' : '本地后台正常 · 发送未启用';
  const runningDetail = effectivelySending
    ? '到点后将自动发送并记录结果'
    : currentSendingEnabled
      ? '总发送已开启，但当前安全设置会拦截消息'
      : '可安全配置和预览，不会发群消息';
  const recoveryDetail = statusData.autoStartEnabled && statusData.supervised ? ' · 登录自启和异常恢复已开启' : '';
  document.querySelector('#systemStateDetail').textContent = statusData.databaseReady ? `${runningDetail}${recoveryDetail}` : '数据库未就绪';
  const toggle = document.querySelector('#toggleSendingButton');
  toggle.disabled = Boolean(statusData.handoverPending);
  toggle.textContent = currentSendingEnabled ? '停止真实发送' : '启用真实发送';
  toggle.classList.toggle('is-stop', currentSendingEnabled);
  document.querySelector('#handoverPendingCard').classList.toggle('is-hidden', !statusData.handoverPending);
  document.querySelector('#safetyBanner').textContent = statusData.handoverPending
    ? '交接配置已导入：全部提醒保持暂停，完成机器人测试并确认本机接管前不会自动发送'
    : emergencyStopped
      ? '全局紧急停止已开启：提醒会保留原排期，但在关闭紧急停止前不会发送'
      : pausedToday
        ? '今天暂停全部消息：今天到期的计划会记录为跳过，明天自动恢复正常排期'
        : currentSendingEnabled
      ? '真实定时发送已启用：后台会按照已启用任务自动向钉钉群发送消息'
      : '本地保存已启用，钉钉发送仍处于关闭状态；当前不会发送任何群消息';
  const failedSections = results.filter((result) => result.status === 'rejected').length;
  if (failedSections) {
    document.querySelector('#operationsStatus').textContent = `${failedSections} 个区域读取失败`;
    document.querySelector('#operationsStatus').className = 'operations-status warning';
  }
  if (!updateCheckStarted) {
    updateCheckStarted = true;
    checkUpdatesQuietly();
  }
  if (poolsDialog.open && selectedPoolId) await selectPool(selectedPoolId);
  if (phrasePoolsDialog.open) selectPhrasePool(selectedPhraseKind);
}

function handoverSummaryHtml(summary) {
  return `<strong>交接包读取成功</strong>
    机器人 ${summary.robots} 个 · 提醒 ${summary.reminders} 条 · 内容池 ${summary.contentPools} 个 · 内容 ${summary.contentItems} 条<br>
    话术 ${summary.phraseItems} 条 · 星期规则 ${summary.rules} 套 · 原启用提醒 ${summary.desiredActiveReminders} 条<br>
    ${summary.includesWebhooks ? '✓ 包含 Webhook；导入后仍需在新电脑测试机器人' : '⚠ 不包含 Webhook；导入后需要重新填写'}`;
}

async function loadUpdatePanel(checkNow = false) {
  const status = await api('/api/update');
  const currentVersionLabel = document.querySelector('#currentVersionLabel');
  if (currentVersionLabel) currentVersionLabel.textContent = status.currentVersion;
  document.querySelector('#topCurrentVersion').textContent = status.currentVersion;
  document.querySelector('#updateConfigForm').elements.repository.value = status.repository || '';
  if (!status.repository) {
    document.querySelector('#updateResult').innerHTML = `<small>当前版本：${escapeHtml(status.currentVersion)} · 尚未配置 GitHub 发布仓库</small>`;
    return;
  }
  if (!checkNow) return;
  const resultBox = document.querySelector('#updateResult');
  resultBox.textContent = '正在连接 GitHub 检查更新…';
  const result = await api('/api/update/check', { method: 'POST', body: '{}' });
  const assetText = result.asset
    ? `<button class="small-button" id="downloadUpdateButton" type="button">一键安全下载 ${escapeHtml(result.asset.name)}</button>${result.asset.digest ? `<br><small>发布校验值：${escapeHtml(result.asset.digest)}</small>` : ''}`
    : '这次 Release 没有找到适合当前系统的发布文件';
  const releaseNotes = result.releaseNotes
    ? `<details class="release-notes"><summary>查看新版说明</summary><pre>${escapeHtml(result.releaseNotes)}</pre></details>`
    : '';
  resultBox.innerHTML = result.updateAvailable
    ? `<strong>发现可用的新版本</strong>
      <div class="version-comparison"><span class="version-chip">当前 ${escapeHtml(result.currentVersion)}</span><span class="version-chip available">新版 ${escapeHtml(result.latestVersion)}</span></div>
      ${assetText}<small class="update-guide">当前只负责安全下载：下载后停止旧后台、解压并启动新版。机器人、提醒和内容保存在独立数据目录，不会随程序包删除。</small>${releaseNotes}`
    : `<strong>当前已经是最新版</strong><div class="version-comparison"><span class="version-chip">当前 ${escapeHtml(result.currentVersion)}</span><span class="version-chip available">GitHub 最新 ${escapeHtml(result.latestVersion)}</span></div>`;
  renderTopUpdateState(result);
}

function renderTopUpdateState(result) {
  const updateButton = document.querySelector('#updateButton');
  updateButton.classList.toggle('is-hidden', !result?.updateAvailable);
  document.querySelector('#topLatestVersion').textContent = result?.updateAvailable ? result.latestVersion : '';
}

async function checkUpdatesQuietly() {
  try {
    const status = await api('/api/update');
    if (!status.repository) return;
    const result = await api('/api/update/check', { method: 'POST', body: '{}' });
    renderTopUpdateState(result);
  } catch {}
}

async function openHandoverDialog(showUpdate = false) {
  handoverDialog.showModal();
  try {
    await loadUpdatePanel(true);
    if (showUpdate) document.querySelector('#updateCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#newReminderButton').addEventListener('click', () => openReminderEditor());
document.querySelector('#sideGuideButton').addEventListener('click', () => {
  document.querySelector('#guideDialog').showModal();
  document.querySelector('#guideDialog').scrollTop = 0;
});
document.querySelector('#closeGuideButton').addEventListener('click', () => document.querySelector('#guideDialog').close());
document.querySelector('#finishGuideButton').addEventListener('click', () => document.querySelector('#guideDialog').close());
document.querySelector('#handoverButton').addEventListener('click', () => openHandoverDialog(false));
document.querySelector('#updateButton').addEventListener('click', () => openHandoverDialog(true));
document.querySelector('#closeHandoverButton').addEventListener('click', () => handoverDialog.close());
function activateSideNav(item) {
  document.querySelectorAll('.side-nav-item').forEach((navItem) => navItem.classList.toggle('is-active', navItem === item));
}

function openRulesDialog() {
  if (!contentPools.length) {
    poolsDialog.showModal();
    showToast('请先创建至少一个内容池');
    return;
  }
  resetRuleForm(contentRules[0] || null);
  rulesDialog.showModal();
  rulesDialog.scrollTop = 0;
}

document.querySelectorAll('.side-nav-item').forEach((item) => item.addEventListener('click', () => activateSideNav(item)));
document.querySelector('#sideRobotsButton')?.addEventListener('click', () => { robotsDialog.showModal(); robotsDialog.scrollTop = 0; });
document.querySelector('#sideRulesButton')?.addEventListener('click', openRulesDialog);
document.querySelector('#manageRobotsButton').addEventListener('click', () => { robotsDialog.showModal(); robotsDialog.scrollTop = 0; });
document.querySelector('#closeRobotsButton').addEventListener('click', closeRobotsDialog);
document.querySelector('#closeActionsButton').addEventListener('click', () => actionsDialog.close());
document.querySelector('#managePoolsButton').addEventListener('click', async () => {
  poolsDialog.showModal();
  poolsDialog.scrollTop = 0;
  if (contentPools.length) await selectPool(selectedPoolId || contentPools[0].id);
});
document.querySelector('#closePoolsButton').addEventListener('click', () => poolsDialog.close());
document.querySelector('#managePhrasePoolsButton').addEventListener('click', () => {
  renderPhrasePoolList();
  selectPhrasePool(selectedPhraseKind);
  phrasePoolsDialog.showModal();
  phrasePoolsDialog.scrollTop = 0;
});
document.querySelector('#closePhrasePoolsButton').addEventListener('click', () => phrasePoolsDialog.close());
document.querySelector('#manageRulesButton').addEventListener('click', openRulesDialog);
document.querySelector('#cancelRobotEdit').addEventListener('click', () => {
  if (robotDirty && !window.confirm('机器人还有未保存的修改，确定放弃吗？')) return;
  resetRobotEditor();
});
robotForm.addEventListener('input', () => { robotDirty = true; });
robotForm.addEventListener('change', () => { robotDirty = true; });
robotsDialog.addEventListener('cancel', (event) => {
  if (!robotDirty) return;
  event.preventDefault();
  closeRobotsDialog();
});
reminderForm.addEventListener('input', () => { reminderDirty = true; });
reminderForm.addEventListener('change', () => { reminderDirty = true; });
reminderDialog.addEventListener('cancel', (event) => {
  if (!reminderDirty) return;
  event.preventDefault();
  if (window.confirm('提醒还有未保存的修改，确定放弃并关闭吗？')) {
    reminderDirty = false;
    reminderDialog.close();
  }
});
document.querySelector('#scheduleType').addEventListener('change', updateScheduleFields);
document.querySelector('#calendarMode').addEventListener?.('change', updateScheduleFields);
document.querySelector('#messageSourceType').addEventListener('change', updateMessageSourceFields);
document.querySelector('#messageFormatType').addEventListener('change', updateMessageFormatFields);

weekPlan.addEventListener('click', (event) => {
  const button = event.target.closest('[data-plan-date]');
  if (!button || !operationsReport) return;
  const day = operationsReport.days.find((item) => item.date === button.dataset.planDate);
  if (!day) return;
  selectedPlanDate = day.date;
  document.querySelector('#dayPlanTitle').textContent = `${day.date} · ${day.isToday ? '今天' : day.weekday}`;
  document.querySelector('#dayPlanDetail').innerHTML = day.items.length ? day.items.map((item) => `
    <article class="day-plan-task">
      <div><time>${escapeHtml(item.time)}</time><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.robotName)} · ${item.sourceType === 'pool_rule' ? '内容池规则' : '固定消息'}</small></div>
      <div class="mini-actions"><button type="button" data-day-action="edit" data-id="${item.reminderId}">编辑</button><button type="button" data-day-action="toggle" data-id="${item.reminderId}">暂停</button></div>
    </article>
  `).join('') : '<div class="empty-state"><strong>这一天没有待发送提醒</strong><small>可以直接为这一天创建一次性提醒</small></div>';
  dayPlanDialog.showModal();
  dayPlanDialog.scrollTop = 0;
});

document.querySelector('#dayPlanDetail').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-day-action]');
  if (!button) return;
  const reminder = reminders.find((item) => item.id === Number(button.dataset.id));
  if (!reminder) return;
  dayPlanDialog.close();
  if (button.dataset.dayAction === 'edit') {
    openReminderEditor(reminder);
    return;
  }
  try {
    await api(`/api/reminders/${reminder.id}/status`, {
      method: 'PATCH', body: JSON.stringify({ enabled: false })
    });
    await reloadData();
    showToast(`“${reminder.name}”已暂停`);
  } catch (error) { showToast(error.message); }
});

document.querySelector('#createReminderForDayButton').addEventListener('click', () => {
  const date = selectedPlanDate;
  dayPlanDialog.close();
  openReminderEditor();
  if (!reminderDialog.open || !date) return;
  reminderForm.elements.frequency.value = 'once';
  reminderForm.elements.date.value = date;
  updateScheduleFields();
  reminderDirty = false;
});
document.querySelector('#closeDayPlanButton').addEventListener('click', () => dayPlanDialog.close());
document.querySelector('#finishDayPlanButton').addEventListener('click', () => dayPlanDialog.close());

document.querySelector('#viewAllHistoryButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    button.textContent = '正在读取…';
    const result = await api('/api/history?limit=500');
    const summaryHistory = history;
    history = result.history || [];
    renderHistoryDialog();
    history = summaryHistory;
    historyDialog.showModal();
    historyDialog.scrollTop = 0;
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '查看全部记录';
  }
});
document.querySelector('#closeHistoryButton').addEventListener('click', () => historyDialog.close());
document.querySelector('#finishHistoryButton').addEventListener('click', () => historyDialog.close());

document.querySelectorAll('[data-message-variable]').forEach((button) => button.addEventListener('click', () => {
  const preferred = document.activeElement === reminderForm.elements.messageTitle
    ? reminderForm.elements.messageTitle
    : reminderForm.elements.message;
  const target = reminderForm.elements.sourceType.value === 'pool_rule' && reminderForm.elements.messageFormat.value === 'markdown'
    ? reminderForm.elements.messageTitle
    : preferred;
  const value = button.dataset.messageVariable;
  const start = Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
  const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : target.value.length;
  target.value = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
  target.focus();
  target.setSelectionRange?.(start + value.length, start + value.length);
}));

document.querySelector('#previewReminderButton').addEventListener('click', async () => {
  if (!reminderForm.reportValidity()) return;
  try {
    reminderMessagePreview.classList.remove('is-hidden');
    reminderMessagePreview.innerHTML = '<small>正在生成完整预览…</small>';
    const result = await api('/api/reminders/preview', { method: 'POST', body: JSON.stringify(collectReminderPayload()) });
    const preview = result.preview;
    reminderMessagePreview.innerHTML = `
      <header><strong>${escapeHtml(preview.title)}</strong><span>${preview.format === 'markdown' ? 'Markdown' : '普通文本'}</span></header>
      <pre>${escapeHtml(preview.content)}</pre>
      <footer>模拟发送时间：${escapeHtml(formatDateTime(preview.scheduledFor))}${preview.atAll ? ' · @所有人' : ' · 不 @ 成员'}</footer>
    `;
  } catch (error) {
    reminderMessagePreview.classList.add('is-hidden');
    showToast(error.message);
  }
});

function renderExceptionList() {
  const exceptionList = document.querySelector('#exceptionList');
  if (!exceptionList) return;
  exceptionList.innerHTML = calendarExceptions.length
    ? calendarExceptions.map((item) => `<span class="exception-chip">${escapeHtml(item.date)} · ${escapeHtml({ holiday: '节假日', workday: '调休上班', pause: '暂停' }[item.type])}${item.label ? ` · ${escapeHtml(item.label)}` : ''}<button type="button" data-delete-exception="${escapeHtml(item.date)}" aria-label="删除 ${escapeHtml(item.date)} 日期例外">×</button></span>`).join('')
    : '<small>还没有日期例外。</small>';
}

function renderSecurityForm() {
  if (!securitySettings) return;
  const form = document.querySelector('#securityForm');
  form.elements.globalEmergencyStop.checked = securitySettings.global_emergency_stop === 'true';
  form.elements.pauseToday.checked = securitySettings.pause_today === localDateInputValue(new Date());
  form.elements.duplicateDetection.checked = securitySettings.duplicate_detection !== 'false';
  form.elements.queueSeconds.value = securitySettings.queue_seconds || '0';
  form.elements.duplicateWindowMinutes.value = securitySettings.duplicate_window_minutes || '60';
  form.elements.sameRobotLimit.value = securitySettings.same_robot_limit || '3';
  form.elements.sameRobotWindowMinutes.value = securitySettings.same_robot_window_minutes || '10';
  form.elements.failurePauseThreshold.value = securitySettings.failure_pause_threshold || '3';
  renderExceptionList();
  securityDirty = false;
}

document.querySelector('#sideSettingsButton').addEventListener('click', () => { renderSecurityForm(); securityDialog.showModal(); });
function closeSecurityDialog() {
  if (securityDirty && !window.confirm('安全设置还有未保存的修改，确定放弃并关闭吗？')) return;
  securityDirty = false;
  securityDialog.close();
}
document.querySelector('#closeSecurityButton').addEventListener('click', closeSecurityDialog);
document.querySelector('#cancelSecurityButton').addEventListener('click', closeSecurityDialog);
document.querySelector('#securityForm').addEventListener('input', (event) => {
  if (!['exceptionDate', 'exceptionType', 'exceptionLabel'].includes(event.target.name)) securityDirty = true;
});
securityDialog.addEventListener('cancel', (event) => {
  if (!securityDirty) return;
  event.preventDefault();
  closeSecurityDialog();
});
document.querySelector('#securityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/security', { method: 'PUT', body: JSON.stringify({
      global_emergency_stop: form.elements.globalEmergencyStop.checked,
      pause_today: form.elements.pauseToday.checked ? localDateInputValue(new Date()) : '',
      duplicate_detection: form.elements.duplicateDetection.checked,
      queue_seconds: Number(form.elements.queueSeconds.value),
      duplicate_window_minutes: Number(form.elements.duplicateWindowMinutes.value),
      same_robot_limit: Number(form.elements.sameRobotLimit.value),
      same_robot_window_minutes: Number(form.elements.sameRobotWindowMinutes.value),
      failure_pause_threshold: Number(form.elements.failurePauseThreshold.value)
    }) });
    securityDirty = false;
    await reloadData(); renderSecurityForm(); showToast('安全中心设置已保存');
  } catch (error) { showToast(error.message); }
});
document.querySelector('#addExceptionButton')?.addEventListener('click', async () => {
  const form = document.querySelector('#securityForm');
  if (!form.elements.exceptionDate.value) { showToast('请选择日期'); return; }
  try {
    const result = await api('/api/calendar/exceptions', { method: 'POST', body: JSON.stringify({ date: form.elements.exceptionDate.value, type: form.elements.exceptionType.value, label: form.elements.exceptionLabel.value }) });
    calendarExceptions = result.exceptions || [];
    operationsReport = await api('/api/operations');
    renderOperations();
    renderExceptionList();
    form.elements.exceptionDate.value = '';
    form.elements.exceptionLabel.value = '';
    showToast('日历例外已保存，所有启用提醒的下次时间已重新计算');
  } catch (error) { showToast(error.message); }
});
document.querySelector('#exceptionList')?.addEventListener('click', async (event) => {
  const date = event.target.dataset.deleteException;
  if (!date) return;
  const result = await api(`/api/calendar/exceptions/${date}`, { method: 'DELETE' });
  calendarExceptions = result.exceptions || [];
  operationsReport = await api('/api/operations');
  renderOperations();
  renderExceptionList();
  showToast('日期例外已删除，提醒排期已重新计算');
});

document.querySelectorAll('.filter-chip').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('.filter-chip.is-active').classList.remove('is-active');
    button.classList.add('is-active');
    currentFilter = button.dataset.filter;
    renderReminders();
  });
});

reminderForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') {
    event.preventDefault();
    if (reminderDirty && !window.confirm('提醒还有未保存的修改，确定放弃并关闭吗？')) return;
    reminderDirty = false;
    reminderDialog.close();
    return;
  }
  event.preventDefault();
  if (!reminderForm.reportValidity()) return;
  const payload = collectReminderPayload();
  const saveButton = document.querySelector('#saveReminderButton');
  try {
    saveButton.disabled = true;
    saveButton.textContent = '正在保存…';
    await api(editingReminderId ? `/api/reminders/${editingReminderId}` : '/api/reminders', {
      method: editingReminderId ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    reminderDirty = false;
    reminderDialog.close();
    const message = editingReminderId ? '提醒修改已保存' : '提醒已保存到本机数据库';
    resetReminderForm();
    await reloadData();
    showToast(currentSendingEnabled ? `${message}；已启用的任务将按排期发送` : `${message}；总发送仍处于关闭状态`);
  } catch (error) {
    showToast(error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = editingReminderId ? '保存修改' : '保存提醒';
  }
});

robotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!robotForm.reportValidity()) return;
  showRobotFormStatus();
  const data = new FormData(robotForm);
  const id = data.get('id');
  if (!id && !data.get('webhook')) {
    showToast('请填写 Webhook 地址');
    return;
  }
  const payload = { name: data.get('name'), keyword: data.get('keyword') };
  if (data.get('webhook')) payload.webhook = data.get('webhook');
  if (data.get('secret')) payload.secret = data.get('secret');
  try {
    saveRobotButton.disabled = true;
    saveRobotButton.textContent = '正在加密保存…';
    await api(id ? `/api/robots/${id}` : '/api/robots', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload)
    });
    resetRobotEditor();
    await reloadData();
    robotEditor.open = true;
    showRobotFormStatus('保存成功：机器人已经加密写入本机数据库。现在可以点击上方机器人卡片中的“测试发送”。', 'success');
    showToast('机器人已加密保存；发送功能仍未启用');
  } catch (error) {
    showRobotFormStatus(`保存失败：${error.message}`, 'error');
    showToast(error.message);
  } finally {
    saveRobotButton.disabled = false;
    saveRobotButton.textContent = id ? '保存修改' : '保存机器人';
  }
});

robotList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-robot-action]');
  if (!button) return;
  const robot = robots.find((item) => item.id === Number(button.dataset.id));
  if (!robot) return;
  if (button.dataset.robotAction === 'edit') {
    editRobot(robot);
    return;
  }
  if (button.dataset.robotAction === 'test') {
    if (!window.confirm(`即将向“${robot.name}”真实发送一条连接测试消息。确定继续吗？`)) return;
    try {
      showToast('正在发送测试消息，请稍候…');
      await api(`/api/robots/${robot.id}/test`, {
        method: 'POST', body: JSON.stringify({ atAll: false })
      });
      await reloadData();
      showToast('钉钉测试消息发送成功');
    } catch (error) {
      await reloadData();
      showToast(error.message);
    }
    return;
  }
  if (!window.confirm(`确定删除机器人“${robot.name}”吗？`)) return;
  try {
    await api(`/api/robots/${robot.id}`, { method: 'DELETE' });
    await reloadData();
    showToast('机器人已删除');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#toggleSendingButton').addEventListener('click', async () => {
  const enable = !currentSendingEnabled;
  if (enable && !window.confirm('启用后，所有“启用中”且到达时间的提醒都会真实发送到钉钉群。请确认已经完成测试发送。是否继续？')) return;
  try {
    const data = await api('/api/settings/sending', {
      method: 'POST',
      body: JSON.stringify({ enabled: enable, confirm: enable ? 'ENABLE_REAL_SENDING' : undefined })
    });
    currentSendingEnabled = data.sendingEnabled;
    await reloadData();
    showToast(currentSendingEnabled ? '真实定时发送已启用' : '真实定时发送已停止');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#handoverExportForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  if (password !== form.elements.passwordConfirm.value) {
    showToast('两次输入的交接密码不一致');
    return;
  }
  try {
    const result = await api('/api/handover/export', {
      method: 'POST', body: JSON.stringify({ password, includeWebhooks: form.elements.includeWebhooks.checked })
    });
    const blob = new Blob([JSON.stringify(result.package)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = result.fileName;
    link.click();
    URL.revokeObjectURL(link.href);
    form.reset();
    form.elements.includeWebhooks.checked = true;
    showToast('加密交接包已生成，请把文件和密码分开发给接手人');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#handoverInspectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.file.files[0];
  if (!file) return;
  try {
    loadedHandoverPackage = JSON.parse(await file.text());
    const result = await api('/api/handover/inspect', {
      method: 'POST', body: JSON.stringify({ package: loadedHandoverPackage, password: form.elements.password.value })
    });
    handoverPreview.innerHTML = handoverSummaryHtml(result.summary);
    handoverPreview.classList.remove('is-hidden');
    confirmHandoverImportButton.classList.remove('is-hidden');
  } catch (error) {
    loadedHandoverPackage = null;
    handoverPreview.classList.add('is-hidden');
    confirmHandoverImportButton.classList.add('is-hidden');
    showToast(error.message);
  }
});

confirmHandoverImportButton.addEventListener('click', async () => {
  if (!loadedHandoverPackage) return;
  if (!window.confirm('导入会先备份这台电脑的数据库，再用交接包替换机器人、提醒和内容配置。导入后全部暂停。确定继续吗？')) return;
  const password = document.querySelector('#handoverInspectForm').elements.password.value;
  try {
    showToast('正在备份并导入，请稍候…');
    await api('/api/handover/import', {
      method: 'POST', body: JSON.stringify({ package: loadedHandoverPackage, password, confirm: 'REPLACE_AND_PAUSE' })
    });
    loadedHandoverPackage = null;
    document.querySelector('#handoverInspectForm').reset();
    handoverPreview.classList.add('is-hidden');
    confirmHandoverImportButton.classList.add('is-hidden');
    await reloadData();
    showToast('导入完成：全部提醒已暂停，请先测试机器人');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#completeHandoverButton').addEventListener('click', async () => {
  if (!window.confirm('请确认：旧电脑已经停止 Wen\'s Ding，且新电脑相关机器人已经测试成功。确定由本机正式接管吗？')) return;
  try {
    const result = await api('/api/handover/complete', {
      method: 'POST', body: JSON.stringify({ confirm: 'OLD_DEVICE_STOPPED_AND_TAKE_OVER' })
    });
    await reloadData();
    showToast(`接管完成，恢复 ${result.activatedReminders} 条原启用提醒`);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#updateConfigForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const repository = event.currentTarget.elements.repository.value;
  try {
    await api('/api/update/config', { method: 'POST', body: JSON.stringify({ repository }) });
    await loadUpdatePanel(true);
  } catch (error) {
    showToast(error.message);
    document.querySelector('#updateResult').textContent = error.message;
  }
});

document.querySelector('#updateResult').addEventListener('click', async (event) => {
  if (event.target.id !== 'downloadUpdateButton') return;
  const button = event.target;
  try {
    button.disabled = true;
    button.textContent = '正在下载并校验…';
    const result = await api('/api/update/download', { method: 'POST', body: '{}' });
    const link = document.createElement('a');
    link.href = result.downloadUrl;
    link.download = result.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    button.textContent = '下载完成';
    showToast('新版已通过 SHA-256 校验并下载；按新版说明替换程序即可，个人数据不会丢失');
  } catch (error) {
    button.disabled = false;
    button.textContent = '重新下载新版';
    showToast(error.message);
  }
});

reminderRows.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const reminder = reminders.find((item) => item.id === Number(button.dataset.id));
  if (!reminder) return;
  if (button.dataset.action === 'more') {
    selectedReminderId = reminder.id;
    document.querySelector('#actionReminderName').textContent = reminder.name;
    actionsDialog.showModal();
    return;
  }
  try {
    await api(`/api/reminders/${reminder.id}/status`, {
      method: 'PATCH', body: JSON.stringify({ enabled: !reminder.enabled })
    });
    await reloadData();
    showToast(`${reminder.name}已${reminder.enabled ? '暂停' : '启用'}`);
  } catch (error) {
    showToast(error.message);
  }
});

actionsDialog.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-reminder-action]');
  if (!button) return;
  const reminder = reminders.find((item) => item.id === selectedReminderId);
  if (!reminder) return;
  const action = button.dataset.reminderAction;
  actionsDialog.close();
  if (action === 'edit') {
    openReminderEditor(reminder);
    return;
  }
  if (action === 'confirm-preview') {
    try {
      const result = await api('/api/reminders/preview', {
        method: 'POST',
        body: JSON.stringify(reminderPayloadFromItem(reminder))
      });
      const preview = result.preview;
      const accepted = window.confirm(
        `请完整核对将要发送的消息：\n\n${preview.title ? `${preview.title}\n\n` : ''}${preview.content}\n\n计划时间：${formatDateTime(preview.scheduledFor)}\n\n确认内容正确并允许后台按规则发送吗？`
      );
      if (!accepted) {
        showToast('尚未确认，后台不会发送这条需确认的提醒');
        return;
      }
      await api(`/api/reminders/${reminder.id}/confirm-preview`, { method: 'POST' });
      await reloadData();
      showToast('完整预览已确认；只有再次编辑内容或规则时才需要重新确认');
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'delete' && !window.confirm(`确定删除提醒“${reminder.name}”吗？`)) return;
  try {
    if (action === 'copy') await api(`/api/reminders/${reminder.id}/copy`, { method: 'POST' });
    if (action === 'delete') await api(`/api/reminders/${reminder.id}`, { method: 'DELETE' });
    await reloadData();
    showToast(action === 'copy' ? '已复制一份，副本默认暂停' : '提醒已删除');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#createPoolForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const result = await api('/api/content-pools', {
      method: 'POST', body: JSON.stringify({ name: data.get('name'), description: data.get('description') })
    });
    form.reset();
    await reloadData();
    await selectPool(result.pool.id);
    showToast('内容池已创建');
  } catch (error) {
    showToast(error.message);
  }
});

poolDialogList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pool-id]');
  if (!button) return;
  selectPool(button.dataset.poolId).catch((error) => showToast(error.message));
});

poolDetail.addEventListener('submit', async (event) => {
  if (event.target.id !== 'bulkItemsForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api(`/api/content-pools/${selectedPoolId}/items`, {
      method: 'POST',
      body: JSON.stringify({ bulkText: data.get('bulkText'), splitMode: data.get('splitMode') })
    });
    event.target.reset();
    await reloadData();
    renderPoolDetail(result.pool);
    showToast(`已加入内容，现在池内共有 ${result.pool.itemCount} 条`);
  } catch (error) {
    showToast(error.message);
  }
});

poolDetail.addEventListener('click', async (event) => {
  const poolAction = event.target.closest('[data-pool-action]');
  const itemAction = event.target.closest('[data-item-action]');
  if (!poolAction && !itemAction) return;
  const currentPoolName = contentPools.find((pool) => pool.id === selectedPoolId)?.name || '当前内容池';
  try {
    if (poolAction?.dataset.poolAction === 'select-all') {
      poolDetail.querySelectorAll('[data-item-select]').forEach((checkbox) => { checkbox.checked = true; });
      return;
    }
    if (poolAction?.dataset.poolAction === 'delete-selected') {
      const itemIds = [...poolDetail.querySelectorAll('[data-item-select]:checked')].map((checkbox) => Number(checkbox.value));
      if (!itemIds.length) {
        showToast('请先勾选要删除的内容');
        return;
      }
      if (!window.confirm(`确定删除勾选的 ${itemIds.length} 条内容吗？`)) return;
      const result = await api(`/api/content-pools/${selectedPoolId}/items`, {
        method: 'DELETE', body: JSON.stringify({ itemIds })
      });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast(`已删除 ${result.deletedCount} 条内容`);
      return;
    }
    if (poolAction?.dataset.poolAction === 'clear-items') {
      if (!window.confirm(`确定清空“${currentPoolName}”里的全部内容吗？内容池本身会保留。`)) return;
      const result = await api(`/api/content-pools/${selectedPoolId}/items`, {
        method: 'DELETE', body: JSON.stringify({ clearAll: true })
      });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast(`已清空 ${result.deletedCount} 条内容`);
      return;
    }
    if (poolAction?.dataset.poolAction === 'reset') {
      if (!window.confirm(`确定把“${currentPoolName}”重置到第 1 轮、第 1 条吗？累计使用次数会保留。`)) return;
      const result = await api(`/api/content-pools/${selectedPoolId}/reset`, { method: 'POST' });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast('内容池轮次已重置');
      return;
    }
    if (poolAction?.dataset.poolAction === 'set-next') {
      const itemId = Number(poolDetail.querySelector('[data-pool-next-item]')?.value);
      const result = await api(`/api/content-pools/${selectedPoolId}/next`, {
        method: 'POST', body: JSON.stringify({ itemId })
      });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast(`下次将从第 ${result.pool.currentPosition} 条开始`);
      return;
    }
    if (poolAction?.dataset.poolAction === 'delete-pool') {
      if (!window.confirm(`确定删除内容池“${currentPoolName}”及其中所有内容吗？`)) return;
      await api(`/api/content-pools/${selectedPoolId}`, { method: 'DELETE' });
      selectedPoolId = null;
      poolDetail.innerHTML = '<div class="empty-state"><strong>请选择一个内容池</strong></div>';
      await reloadData();
      showToast('内容池已删除');
      return;
    }
    const itemId = Number(itemAction.dataset.id);
    const poolData = await api(`/api/content-pools/${selectedPoolId}`);
    const item = poolData.pool.items.find((entry) => entry.id === itemId);
    if (!item) return;
    if (itemAction.dataset.itemAction === 'move-up' || itemAction.dataset.itemAction === 'move-down') {
      const ids = poolData.pool.items.map((entry) => entry.id);
      const index = ids.indexOf(itemId);
      const target = itemAction.dataset.itemAction === 'move-up' ? index - 1 : index + 1;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      const result = await api(`/api/content-pools/${selectedPoolId}/reorder`, {
        method: 'POST', body: JSON.stringify({ itemIds: ids })
      });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast('顺序已更新');
      return;
    }
    if (itemAction.dataset.itemAction === 'edit') {
      const content = window.prompt('修改这条内容：', item.content);
      if (content === null || !content.trim()) return;
      const result = await api(`/api/content-pools/${selectedPoolId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ content })
      });
      renderPoolDetail(result.pool);
      showToast('内容已修改');
    }
    if (itemAction.dataset.itemAction === 'toggle') {
      const result = await api(`/api/content-pools/${selectedPoolId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled })
      });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast(item.enabled ? '内容已停用' : '内容已启用');
    }
    if (itemAction.dataset.itemAction === 'delete') {
      if (!window.confirm('确定删除这条内容吗？')) return;
      const result = await api(`/api/content-pools/${selectedPoolId}/items/${itemId}`, { method: 'DELETE' });
      await reloadData();
      renderPoolDetail(result.pool);
      showToast('内容已删除');
    }
  } catch (error) {
    showToast(error.message);
  }
});

phrasePoolList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-phrase-kind]');
  if (button) selectPhrasePool(button.dataset.phraseKind);
});

phrasePoolDetail.addEventListener('submit', async (event) => {
  if (event.target.id !== 'bulkPhrasesForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    await api(`/api/phrase-pools/${selectedPhraseKind}/items`, {
      method: 'POST',
      body: JSON.stringify({ bulkText: data.get('bulkText'), splitMode: data.get('splitMode') })
    });
    event.target.reset();
    await reloadData();
    selectPhrasePool(selectedPhraseKind);
    showToast('话术已加入末尾，可上下移动调整顺序');
  } catch (error) {
    showToast(error.message);
  }
});

phrasePoolDetail.addEventListener('click', async (event) => {
  const poolAction = event.target.closest('[data-phrase-pool-action]');
  const itemAction = event.target.closest('[data-phrase-action]');
  if (!poolAction && !itemAction) return;
  try {
    if (poolAction?.dataset.phrasePoolAction === 'select-all') {
      phrasePoolDetail.querySelectorAll('[data-phrase-select]').forEach((checkbox) => { checkbox.checked = true; });
      return;
    }
    if (poolAction?.dataset.phrasePoolAction === 'delete-selected') {
      const itemIds = [...phrasePoolDetail.querySelectorAll('[data-phrase-select]:checked')].map((checkbox) => Number(checkbox.value));
      if (!itemIds.length) {
        showToast('请先勾选要删除的话术');
        return;
      }
      if (!window.confirm(`确定删除勾选的 ${itemIds.length} 条话术吗？`)) return;
      const result = await api(`/api/phrase-pools/${selectedPhraseKind}/items`, {
        method: 'DELETE', body: JSON.stringify({ itemIds })
      });
      await reloadData();
      selectPhrasePool(selectedPhraseKind);
      showToast(`已删除 ${result.deletedCount} 条话术`);
      return;
    }
    if (poolAction?.dataset.phrasePoolAction === 'clear-items') {
      if (!window.confirm('确定清空这套话术池的全部内容吗？')) return;
      const result = await api(`/api/phrase-pools/${selectedPhraseKind}/items`, {
        method: 'DELETE', body: JSON.stringify({ clearAll: true })
      });
      await reloadData();
      selectPhrasePool(selectedPhraseKind);
      showToast(`已清空 ${result.deletedCount} 条话术`);
      return;
    }
    if (poolAction?.dataset.phrasePoolAction === 'reset') {
      if (!window.confirm('确定把这套话术池重置到第 1 轮吗？累计使用次数会保留。')) return;
      await api(`/api/phrase-pools/${selectedPhraseKind}/reset`, { method: 'POST' });
      await reloadData();
      selectPhrasePool(selectedPhraseKind);
      showToast('话术池轮次已重置');
      return;
    }
    if (poolAction?.dataset.phrasePoolAction === 'set-next') {
      const itemId = Number(phrasePoolDetail.querySelector('[data-phrase-next-item]')?.value);
      const result = await api(`/api/phrase-pools/${selectedPhraseKind}/next`, {
        method: 'POST', body: JSON.stringify({ itemId })
      });
      await reloadData();
      selectPhrasePool(selectedPhraseKind);
      showToast(`下次将从第 ${result.pool.currentPosition} 条开始`);
      return;
    }
    const pool = phrasePools.find((entry) => entry.kind === selectedPhraseKind);
    const item = pool?.items.find((entry) => entry.id === Number(itemAction.dataset.id));
    if (!item) return;
    if (itemAction.dataset.phraseAction === 'move-up' || itemAction.dataset.phraseAction === 'move-down') {
      const ids = pool.items.map((entry) => entry.id);
      const index = ids.indexOf(item.id);
      const target = itemAction.dataset.phraseAction === 'move-up' ? index - 1 : index + 1;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await api(`/api/phrase-pools/${selectedPhraseKind}/reorder`, {
        method: 'POST', body: JSON.stringify({ itemIds: ids })
      });
      await reloadData();
      selectPhrasePool(selectedPhraseKind);
      showToast('话术顺序已更新');
      return;
    }
    if (itemAction.dataset.phraseAction === 'edit') {
      const content = window.prompt('修改这条话术：', item.content);
      if (content === null || !content.trim()) return;
      await api(`/api/phrase-pools/${selectedPhraseKind}/items/${item.id}`, {
        method: 'PATCH', body: JSON.stringify({ content })
      });
      showToast('话术已修改');
    }
    if (itemAction.dataset.phraseAction === 'toggle') {
      await api(`/api/phrase-pools/${selectedPhraseKind}/items/${item.id}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled })
      });
      showToast(item.enabled ? '话术已停用' : '话术已启用');
    }
    if (itemAction.dataset.phraseAction === 'delete') {
      if (!window.confirm('确定删除这条话术吗？')) return;
      await api(`/api/phrase-pools/${selectedPhraseKind}/items/${item.id}`, { method: 'DELETE' });
      showToast('话术已删除');
    }
    await reloadData();
    selectPhrasePool(selectedPhraseKind);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#ruleEditorSelect').addEventListener('change', (event) => {
  if (ruleDirty && !window.confirm('当前星期规则还有未保存的修改，确定放弃并切换吗？')) {
    event.target.value = ruleForm.elements.ruleId.value;
    return;
  }
  const rule = contentRules.find((item) => item.id === Number(event.target.value));
  resetRuleForm(rule || null);
});

ruleForm.addEventListener('input', (event) => {
  if (event.target.name !== 'ruleId') ruleDirty = true;
});
ruleForm.addEventListener('change', (event) => {
  if (event.target.name !== 'ruleId') ruleDirty = true;
});
rulesDialog.addEventListener('cancel', (event) => {
  if (!ruleDirty) return;
  event.preventDefault();
  closeRulesDialog();
});

document.querySelector('#deleteRuleButton').addEventListener('click', async () => {
  const ruleId = Number(ruleForm.elements.ruleId.value);
  const rule = contentRules.find((item) => item.id === ruleId);
  if (!rule || !window.confirm(`确定删除星期规则“${rule.name}”吗？删除后相关内容池将不再被这个规则占用。`)) return;
  try {
    await api(`/api/content-rules/${ruleId}`, { method: 'DELETE' });
    await reloadData();
    resetRuleForm();
    showToast('星期规则已删除，现在可以删除不再使用的内容池');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#weekdayRuleRows').addEventListener('change', (event) => {
  if (!event.target.matches('[data-slot]')) return;
  const slot = event.target.dataset.slot;
  const count = event.target.closest('.weekday-rule-row').querySelector(`[data-count="${slot}"]`);
  if (event.target.value && Number(count.value) === 0) count.value = 1;
  if (!event.target.value) count.value = 0;
});

ruleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    closeRulesDialog();
    return;
  }
  if (!ruleForm.reportValidity()) return;
  const data = new FormData(ruleForm);
  const id = data.get('ruleId');
  const allocations = collectRuleAllocations();
  if (!allocations.length) {
    showToast('请至少为一天选择内容池并设置抽取数量');
    return;
  }
  try {
    await api(id ? `/api/content-rules/${id}` : '/api/content-rules', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: data.get('name'), messageTitle: data.get('messageTitle'), layoutMode: data.get('layoutMode'),
        outputMode: 'combine', allocations
      })
    });
    await reloadData();
    ruleDirty = false;
    rulesDialog.close();
    showToast('星期规则已保存，可以生成完整预览');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#generatePreviewButton').addEventListener('click', async () => {
  const ruleId = Number(document.querySelector('#previewRuleSelect').value);
  const robotId = Number(document.querySelector('#previewRobotSelect').value);
  const weekday = Number(document.querySelector('#previewWeekday').value);
  if (!ruleId) {
    showToast('请先设置星期规则');
    return;
  }
  const robot = robots.find((item) => item.id === robotId);
  if (!robot) {
    showToast('请选择用于预览的目标机器人');
    return;
  }
  try {
    const data = await api(`/api/content-rules/${ruleId}/preview`, {
      method: 'POST', body: JSON.stringify({ weekday, keyword: robot.keyword })
    });
    const preview = document.querySelector('#messagePreview');
    preview.classList.remove('empty-preview');
    preview.textContent = data.preview.message;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      preview.animate(
        [{ opacity: .58 }, { opacity: 1 }],
        { duration: 160, easing: 'cubic-bezier(.23, 1, .32, 1)' }
      );
    }
    showToast(`预览已生成，共抽取 ${data.preview.selections.length} 条；内容池位置未推进`);
  } catch (error) {
    showToast(error.message);
  }
});

resetReminderForm();
resetRobotEditor();
function markBackendDisconnected(error, showMessage = false) {
  document.querySelector('.status-dot').classList.add('offline');
  document.querySelector('#systemStateTitle').textContent = '本地后台连接失败';
  document.querySelector('#systemStateDetail').textContent = '自动恢复开启时通常会在 10 秒左右恢复；也可重新双击启动入口';
  document.querySelector('#toggleSendingButton').disabled = true;
  if (showMessage) showToast(error.message);
}

reloadData().catch((error) => markBackendDisconnected(error, true));
setInterval(() => {
  if (document.hidden) return;
  reloadData().catch((error) => markBackendDisconnected(error, false));
}, 30000);
