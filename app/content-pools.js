const { previewPhraseSet, commitPhraseSelections } = require('./phrase-pools');

function requiredText(value, label, maxLength = 5000) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`请填写${label}`);
  if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function mapPool(row) {
  const itemCount = Number(row.item_count || 0);
  const usedInCycle = Number(row.used_in_cycle || 0);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    currentCycle: row.current_cycle,
    itemCount,
    usedInCycle,
    currentPosition: itemCount ? Math.min(usedInCycle + 1, itemCount) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listPools(db) {
  return db.prepare(`
    SELECT p.*,
      COUNT(CASE WHEN i.enabled = 1 THEN 1 END) AS item_count,
      COUNT(CASE WHEN i.enabled = 1 AND i.last_used_cycle >= p.current_cycle THEN 1 END) AS used_in_cycle
    FROM content_pools p
    LEFT JOIN content_items i ON i.pool_id = p.id
    GROUP BY p.id
    ORDER BY p.enabled DESC, p.id ASC
  `).all().map(mapPool);
}

function getPool(db, id) {
  const pool = listPools(db).find((item) => item.id === Number(id));
  if (!pool) throw new Error('内容池不存在');
  pool.items = db.prepare(`
    SELECT id, title, content, sort_order, enabled, last_used_cycle, use_count,
           last_used_at, created_at, updated_at
    FROM content_items WHERE pool_id = ? ORDER BY sort_order ASC
  `).all(id).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    usedInCurrentCycle: row.last_used_cycle >= pool.currentCycle,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
  return pool;
}

function createPool(db, input) {
  const name = requiredText(input.name, '内容池名称', 100);
  const description = String(input.description || '').trim().slice(0, 500);
  const timestamp = nowIso();
  const result = db.prepare(`
    INSERT INTO content_pools (name, description, enabled, current_cycle, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(name, description, input.enabled === false ? 0 : 1, timestamp, timestamp);
  return getPool(db, Number(result.lastInsertRowid));
}

function updatePool(db, id, input) {
  const existing = db.prepare('SELECT * FROM content_pools WHERE id = ?').get(id);
  if (!existing) throw new Error('内容池不存在');
  const name = input.name === undefined ? existing.name : requiredText(input.name, '内容池名称', 100);
  const description = input.description === undefined ? existing.description : String(input.description || '').trim().slice(0, 500);
  const enabled = input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0);
  db.prepare('UPDATE content_pools SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(name, description, enabled, nowIso(), id);
  return getPool(db, id);
}

function addPoolItems(db, poolId, inputItems) {
  getPool(db, poolId);
  if (!Array.isArray(inputItems)) throw new Error('内容条目格式不正确');
  const contents = inputItems.map((item) => typeof item === 'string' ? item : item.content)
    .map((value) => String(value || '').trim()).filter(Boolean);
  if (!contents.length) throw new Error('请至少填写一条内容');
  if (contents.length > 200) throw new Error('单次最多添加 200 条内容');
  contents.forEach((content) => {
    if (content.length > 5000) throw new Error('每条内容不能超过 5000 个字符');
  });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM content_items WHERE pool_id = ?').get(poolId).value;
  const insert = db.prepare(`
    INSERT INTO content_items
      (pool_id, title, content, sort_order, enabled, last_used_cycle, use_count, created_at, updated_at)
    VALUES (?, '', ?, ?, 1, 0, 0, ?, ?)
  `);
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    contents.forEach((content, index) => insert.run(poolId, content, maxOrder + index + 1, timestamp, timestamp));
    db.prepare('UPDATE content_pools SET updated_at = ? WHERE id = ?').run(timestamp, poolId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPool(db, poolId);
}

function updatePoolItem(db, poolId, itemId, input) {
  const existing = db.prepare('SELECT * FROM content_items WHERE id = ? AND pool_id = ?').get(itemId, poolId);
  if (!existing) throw new Error('内容条目不存在');
  const content = input.content === undefined ? existing.content : requiredText(input.content, '内容', 5000);
  const title = input.title === undefined ? existing.title : String(input.title || '').trim().slice(0, 200);
  const enabled = input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0);
  db.prepare('UPDATE content_items SET title = ?, content = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(title, content, enabled, nowIso(), itemId);
  return getPool(db, poolId);
}

function deletePoolItem(db, poolId, itemId) {
  const result = db.prepare('DELETE FROM content_items WHERE id = ? AND pool_id = ?').run(itemId, poolId);
  if (!result.changes) throw new Error('内容条目不存在');
  return getPool(db, poolId);
}

function deletePoolItems(db, poolId, itemIds, clearAll = false) {
  getPool(db, poolId);
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!clearAll && !ids.length) throw new Error('请先勾选要删除的内容');
  if (ids.length > 1000) throw new Error('单次最多删除 1000 条内容');
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    let result;
    if (clearAll) {
      result = db.prepare('DELETE FROM content_items WHERE pool_id = ?').run(poolId);
      db.prepare('UPDATE content_pools SET current_cycle = 1, updated_at = ? WHERE id = ?').run(timestamp, poolId);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      result = db.prepare(`DELETE FROM content_items WHERE pool_id = ? AND id IN (${placeholders})`).run(poolId, ...ids);
      db.prepare('UPDATE content_pools SET updated_at = ? WHERE id = ?').run(timestamp, poolId);
    }
    db.exec('COMMIT');
    return { deletedCount: Number(result.changes), pool: getPool(db, poolId) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reorderPoolItems(db, poolId, itemIds) {
  const pool = getPool(db, poolId);
  if (!Array.isArray(itemIds) || itemIds.length !== pool.items.length) throw new Error('排序数据不完整');
  const actual = [...pool.items.map((item) => item.id)].sort((a, b) => a - b);
  const requested = [...itemIds.map(Number)].sort((a, b) => a - b);
  if (actual.some((id, index) => id !== requested[index])) throw new Error('排序数据包含无效条目');
  const update = db.prepare('UPDATE content_items SET sort_order = ?, updated_at = ? WHERE id = ? AND pool_id = ?');
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    itemIds.forEach((id, index) => update.run(-(index + 1), timestamp, Number(id), poolId));
    itemIds.forEach((id, index) => update.run(index + 1, timestamp, Number(id), poolId));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPool(db, poolId);
}

function setPoolNextItem(db, poolId, itemId) {
  const pool = getPool(db, poolId);
  const enabledItems = pool.items.filter((item) => item.enabled);
  const selectedIndex = enabledItems.findIndex((item) => item.id === Number(itemId));
  if (selectedIndex < 0) throw new Error('请选择一条已启用的内容作为下一条');
  const timestamp = nowIso();
  const update = db.prepare('UPDATE content_items SET last_used_cycle = ?, updated_at = ? WHERE id = ? AND pool_id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    enabledItems.forEach((item, index) => {
      update.run(index < selectedIndex ? pool.currentCycle : Math.max(0, pool.currentCycle - 1), timestamp, item.id, poolId);
    });
    db.prepare('UPDATE content_pools SET updated_at = ? WHERE id = ?').run(timestamp, poolId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPool(db, poolId);
}

function resetPoolCycle(db, poolId) {
  getPool(db, poolId);
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE content_items SET last_used_cycle = 0, updated_at = ? WHERE pool_id = ?').run(timestamp, poolId);
    db.prepare('UPDATE content_pools SET current_cycle = 1, updated_at = ? WHERE id = ?').run(timestamp, poolId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPool(db, poolId);
}

function mapRule(db, row) {
  const allocations = db.prepare(`
    SELECT a.weekday, a.slot_order, a.pool_id, a.item_count, p.name AS pool_name
    FROM content_rule_allocations a JOIN content_pools p ON p.id = a.pool_id
    WHERE a.rule_id = ? ORDER BY a.weekday ASC, a.slot_order ASC
  `).all(row.id).map((item) => ({
    weekday: item.weekday,
    slotOrder: item.slot_order,
    poolId: item.pool_id,
    poolName: item.pool_name,
    itemCount: item.item_count
  }));
  return {
    id: row.id,
    name: row.name,
    messageTitle: row.message_title,
    opening: row.opening,
    closing: row.closing,
    outputMode: row.output_mode,
    layoutMode: row.layout_mode || 'spacious',
    enabled: Boolean(row.enabled),
    allocations,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listRules(db) {
  return db.prepare('SELECT * FROM content_rules ORDER BY enabled DESC, id ASC').all().map((row) => mapRule(db, row));
}

function getRule(db, id) {
  const row = db.prepare('SELECT * FROM content_rules WHERE id = ?').get(id);
  if (!row) throw new Error('内容规则不存在');
  return mapRule(db, row);
}

function validateAllocations(db, allocations) {
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('请至少设置一天的抽取规则');
  const normalized = allocations.map((item, index) => {
    const weekday = Number(item.weekday);
    const poolId = Number(item.poolId);
    const itemCount = Number(item.itemCount);
    const slotOrder = Number(item.slotOrder || index + 1);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('星期设置不正确');
    if (!Number.isInteger(poolId) || !db.prepare('SELECT 1 FROM content_pools WHERE id = ?').get(poolId)) throw new Error('抽取规则引用了不存在的内容池');
    if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 50) throw new Error('每次抽取数量必须是 1 到 50');
    return { weekday, poolId, itemCount, slotOrder };
  });
  const keys = new Set();
  normalized.forEach((item) => {
    const key = `${item.weekday}:${item.slotOrder}`;
    if (keys.has(key)) throw new Error('同一天的规则顺序不能重复');
    keys.add(key);
  });
  return normalized;
}

function saveRule(db, id, input) {
  const existing = id ? db.prepare('SELECT * FROM content_rules WHERE id = ?').get(id) : null;
  if (id && !existing) throw new Error('内容规则不存在');
  const name = input.name === undefined && existing ? existing.name : requiredText(input.name, '规则名称', 100);
  const messageTitle = input.messageTitle === undefined && existing ? existing.message_title : requiredText(input.messageTitle || '每日风险提醒', '消息标题', 200);
  const opening = input.opening === undefined && existing ? existing.opening : String(input.opening || '').trim().slice(0, 1000);
  const closing = input.closing === undefined && existing ? existing.closing : String(input.closing || '').trim().slice(0, 1000);
  const outputMode = input.outputMode === 'separate' ? 'separate' : 'combine';
  const requestedLayout = input.layoutMode === undefined && existing ? existing.layout_mode : input.layoutMode;
  const layoutMode = ['compact', 'balanced', 'spacious'].includes(requestedLayout) ? requestedLayout : 'balanced';
  const allocations = validateAllocations(db, input.allocations);
  const timestamp = nowIso();
  const insertAllocation = db.prepare(`
    INSERT INTO content_rule_allocations (rule_id, weekday, slot_order, pool_id, item_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    let ruleId = id;
    if (existing) {
      db.prepare(`UPDATE content_rules SET name = ?, message_title = ?, opening = ?, closing = ?, output_mode = ?, layout_mode = ?, enabled = ?, updated_at = ? WHERE id = ?`)
        .run(name, messageTitle, opening, closing, outputMode, layoutMode, input.enabled === false ? 0 : 1, timestamp, id);
      db.prepare('DELETE FROM content_rule_allocations WHERE rule_id = ?').run(id);
    } else {
      const result = db.prepare(`
        INSERT INTO content_rules (name, message_title, opening, closing, output_mode, layout_mode, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, messageTitle, opening, closing, outputMode, layoutMode, input.enabled === false ? 0 : 1, timestamp, timestamp);
      ruleId = Number(result.lastInsertRowid);
    }
    allocations.forEach((item) => insertAllocation.run(ruleId, item.weekday, item.slotOrder, item.poolId, item.itemCount));
    db.exec('COMMIT');
    return getRule(db, ruleId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function buildPoolState(db, poolId) {
  const pool = db.prepare('SELECT * FROM content_pools WHERE id = ? AND enabled = 1').get(poolId);
  if (!pool) throw new Error('规则中的内容池不存在或已停用');
  const items = db.prepare(`
    SELECT id, pool_id, title, content, sort_order, last_used_cycle
    FROM content_items WHERE pool_id = ? AND enabled = 1 ORDER BY sort_order ASC
  `).all(poolId).map((item) => ({ ...item }));
  if (!items.length) throw new Error(`内容池“${pool.name}”没有可用内容`);
  return { pool, currentCycle: pool.current_cycle, items };
}

function takeItems(state, count, alreadySelected) {
  if (count > state.items.length - alreadySelected.size) {
    throw new Error(`内容池“${state.pool.name}”本次抽取数量超过可用且不重复的条目数`);
  }
  const selections = [];
  while (selections.length < count) {
    let candidate = state.items.find((item) => item.last_used_cycle < state.currentCycle && !alreadySelected.has(item.id));
    if (!candidate) {
      state.currentCycle += 1;
      candidate = state.items.find((item) => item.last_used_cycle < state.currentCycle && !alreadySelected.has(item.id));
    }
    candidate.last_used_cycle = state.currentCycle;
    alreadySelected.add(candidate.id);
    selections.push({
      poolId: state.pool.id,
      poolName: state.pool.name,
      itemId: candidate.id,
      title: candidate.title,
      content: candidate.content,
      cycle: state.currentCycle,
      sortOrder: candidate.sort_order
    });
  }
  return selections;
}

function previewRule(db, ruleId, weekday, keyword = '定时通知') {
  const rule = getRule(db, ruleId);
  const day = Number(weekday);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('请选择预览星期');
  const allocations = rule.allocations.filter((item) => item.weekday === day);
  if (!allocations.length) throw new Error('这个星期还没有配置抽取规则');
  const states = new Map();
  const selectedByPool = new Map();
  const selections = [];
  allocations.forEach((allocation) => {
    if (!states.has(allocation.poolId)) states.set(allocation.poolId, buildPoolState(db, allocation.poolId));
    if (!selectedByPool.has(allocation.poolId)) selectedByPool.set(allocation.poolId, new Set());
    selections.push(...takeItems(states.get(allocation.poolId), allocation.itemCount, selectedByPool.get(allocation.poolId)));
  });
  const safeKeyword = String(keyword || '定时通知').trim() || '定时通知';
  const phraseSelections = previewPhraseSet(db);
  const phraseByKind = Object.fromEntries(phraseSelections.map((item) => [item.kind, item.content]));
  const heading = `${safeKeyword}｜${rule.messageTitle}`;
  const riskLines = selections.map((item, index) => `${index + 1}. ${item.content}`);
  let message;
  if (rule.layoutMode === 'compact') {
    message = [heading, phraseByKind.greeting, phraseByKind.opening, ...riskLines, phraseByKind.closing].join('\n');
  } else if (rule.layoutMode === 'balanced') {
    message = [heading, `${phraseByKind.greeting}\n${phraseByKind.opening}`, riskLines.join('\n'), phraseByKind.closing].join('\n\n');
  } else {
    message = [heading, phraseByKind.greeting, phraseByKind.opening, riskLines.join('\n\n'), phraseByKind.closing].join('\n\n');
  }
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    weekday: day,
    outputMode: rule.outputMode,
    layoutMode: rule.layoutMode,
    selections,
    phraseSelections,
    message,
    advancesPosition: false
  };
}

function consumeRule(db, ruleId, weekday, keyword, idempotencyKey, options = {}) {
  const key = requiredText(idempotencyKey, '唯一执行编号', 200);
  const existing = db.prepare('SELECT selections_json FROM content_consumptions WHERE idempotency_key = ?').get(key);
  if (existing) return { duplicate: true, ...JSON.parse(existing.selections_json) };
  const managesTransaction = !options.inTransaction;
  if (managesTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const preview = previewRule(db, ruleId, weekday, keyword);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO content_consumptions (idempotency_key, rule_id, weekday, selections_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, ruleId, Number(weekday), JSON.stringify(preview), timestamp);
    const updateItem = db.prepare(`
      UPDATE content_items SET last_used_cycle = ?, use_count = use_count + 1,
        last_used_at = ?, updated_at = ? WHERE id = ? AND pool_id = ?
    `);
    preview.selections.forEach((item) => updateItem.run(item.cycle, timestamp, timestamp, item.itemId, item.poolId));
    commitPhraseSelections(db, preview.phraseSelections || [], timestamp);
    const poolIds = [...new Set(preview.selections.map((item) => item.poolId))];
    poolIds.forEach((poolId) => {
      const maxCycle = Math.max(...preview.selections.filter((item) => item.poolId === poolId).map((item) => item.cycle));
      const remaining = db.prepare(`
        SELECT COUNT(*) AS total FROM content_items
        WHERE pool_id = ? AND enabled = 1 AND last_used_cycle < ?
      `).get(poolId, maxCycle).total;
      db.prepare('UPDATE content_pools SET current_cycle = ?, updated_at = ? WHERE id = ?')
        .run(remaining ? maxCycle : maxCycle + 1, timestamp, poolId);
    });
    if (managesTransaction) db.exec('COMMIT');
    return { duplicate: false, ...preview, advancesPosition: true };
  } catch (error) {
    if (managesTransaction) db.exec('ROLLBACK');
    const duplicate = db.prepare('SELECT selections_json FROM content_consumptions WHERE idempotency_key = ?').get(key);
    if (duplicate) return { duplicate: true, ...JSON.parse(duplicate.selections_json) };
    throw error;
  }
}

module.exports = {
  listPools,
  getPool,
  createPool,
  updatePool,
  addPoolItems,
  updatePoolItem,
  deletePoolItem,
  deletePoolItems,
  reorderPoolItems,
  setPoolNextItem,
  resetPoolCycle,
  listRules,
  getRule,
  saveRule,
  previewRule,
  consumeRule
};
