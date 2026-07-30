const KINDS = ['greeting', 'opening', 'closing'];
const PLACEHOLDERS = {
  greeting: '{请先录入称呼池}',
  opening: '{请先录入开头话术池}',
  closing: '{请先录入结束语池}'
};

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error('话术池类型不正确');
}

function nowIso() {
  return new Date().toISOString();
}

function listPhrasePools(db) {
  return db.prepare('SELECT * FROM phrase_pools ORDER BY CASE kind WHEN \'greeting\' THEN 1 WHEN \'opening\' THEN 2 ELSE 3 END').all()
    .map((pool) => {
      const items = db.prepare(`
        SELECT id, content, sort_order, enabled, last_used_cycle, use_count, last_used_at, created_at, updated_at
        FROM phrase_items WHERE kind = ? ORDER BY sort_order ASC, id ASC
      `).all(pool.kind).map((item) => ({
        id: item.id,
        content: item.content,
        sortOrder: item.sort_order,
        enabled: Boolean(item.enabled),
        usedInCurrentCycle: item.last_used_cycle >= pool.current_cycle,
        useCount: item.use_count,
        lastUsedAt: item.last_used_at,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }));
      const enabledItems = items.filter((item) => item.enabled);
      const usedInCycle = enabledItems.filter((item) => item.usedInCurrentCycle).length;
      return {
        kind: pool.kind,
        displayName: pool.display_name,
        currentCycle: pool.current_cycle,
        lastItemId: pool.last_item_id,
        itemCount: enabledItems.length,
        usedInCycle,
        currentPosition: enabledItems.length ? Math.min(usedInCycle + 1, enabledItems.length) : 0,
        items
      };
    });
}

function getPhrasePool(db, kind) {
  assertKind(kind);
  const pool = listPhrasePools(db).find((item) => item.kind === kind);
  if (!pool) throw new Error('话术池不存在');
  return pool;
}

function addPhraseItems(db, kind, inputItems) {
  assertKind(kind);
  if (!Array.isArray(inputItems)) throw new Error('话术内容格式不正确');
  const contents = inputItems.map((item) => typeof item === 'string' ? item : item.content)
    .map((value) => String(value || '').trim()).filter(Boolean);
  if (!contents.length) throw new Error('请至少填写一条话术');
  if (contents.length > 200) throw new Error('单次最多添加 200 条话术');
  contents.forEach((content) => {
    if (content.length > 1000) throw new Error('每条话术不能超过 1000 个字符');
  });
  const timestamp = nowIso();
  const insert = db.prepare(`
    INSERT INTO phrase_items (kind, content, sort_order, enabled, last_used_cycle, use_count, created_at, updated_at)
    VALUES (?, ?, ?, 1, 0, 0, ?, ?)
  `);
  const maxOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM phrase_items WHERE kind = ?').get(kind).value);
  db.exec('BEGIN IMMEDIATE');
  try {
    contents.forEach((content, index) => insert.run(kind, content, maxOrder + index + 1, timestamp, timestamp));
    db.prepare('UPDATE phrase_pools SET updated_at = ? WHERE kind = ?').run(timestamp, kind);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPhrasePool(db, kind);
}

function updatePhraseItem(db, kind, itemId, input) {
  assertKind(kind);
  const existing = db.prepare('SELECT * FROM phrase_items WHERE id = ? AND kind = ?').get(itemId, kind);
  if (!existing) throw new Error('话术不存在');
  const content = input.content === undefined ? existing.content : String(input.content || '').trim();
  if (!content) throw new Error('话术不能为空');
  if (content.length > 1000) throw new Error('每条话术不能超过 1000 个字符');
  const enabled = input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0);
  db.prepare('UPDATE phrase_items SET content = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(content, enabled, nowIso(), itemId);
  return getPhrasePool(db, kind);
}

function deletePhraseItem(db, kind, itemId) {
  assertKind(kind);
  const result = db.prepare('DELETE FROM phrase_items WHERE id = ? AND kind = ?').run(itemId, kind);
  if (!result.changes) throw new Error('话术不存在');
  return getPhrasePool(db, kind);
}

function reorderPhraseItems(db, kind, itemIds) {
  const pool = getPhrasePool(db, kind);
  if (!Array.isArray(itemIds) || itemIds.length !== pool.items.length) throw new Error('排序数据不完整');
  const actual = [...pool.items.map((item) => item.id)].sort((a, b) => a - b);
  const requested = [...itemIds.map(Number)].sort((a, b) => a - b);
  if (actual.some((id, index) => id !== requested[index])) throw new Error('排序数据包含无效话术');
  const update = db.prepare('UPDATE phrase_items SET sort_order = ?, updated_at = ? WHERE id = ? AND kind = ?');
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    itemIds.forEach((id, index) => update.run(-(index + 1), timestamp, Number(id), kind));
    itemIds.forEach((id, index) => update.run(index + 1, timestamp, Number(id), kind));
    db.prepare('UPDATE phrase_pools SET updated_at = ? WHERE kind = ?').run(timestamp, kind);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPhrasePool(db, kind);
}

function setPhraseNextItem(db, kind, itemId) {
  const pool = getPhrasePool(db, kind);
  const enabledItems = pool.items.filter((item) => item.enabled);
  const selectedIndex = enabledItems.findIndex((item) => item.id === Number(itemId));
  if (selectedIndex < 0) throw new Error('请选择一条已启用的话术作为下一条');
  const timestamp = nowIso();
  const update = db.prepare('UPDATE phrase_items SET last_used_cycle = ?, updated_at = ? WHERE id = ? AND kind = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    enabledItems.forEach((item, index) => {
      update.run(index < selectedIndex ? pool.currentCycle : Math.max(0, pool.currentCycle - 1), timestamp, item.id, kind);
    });
    db.prepare('UPDATE phrase_pools SET last_item_id = NULL, updated_at = ? WHERE kind = ?').run(timestamp, kind);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPhrasePool(db, kind);
}

function deletePhraseItems(db, kind, itemIds, clearAll = false) {
  assertKind(kind);
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!clearAll && !ids.length) throw new Error('请先勾选要删除的话术');
  if (ids.length > 1000) throw new Error('单次最多删除 1000 条话术');
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    let result;
    if (clearAll) {
      result = db.prepare('DELETE FROM phrase_items WHERE kind = ?').run(kind);
      db.prepare('UPDATE phrase_pools SET current_cycle = 1, last_item_id = NULL, updated_at = ? WHERE kind = ?').run(timestamp, kind);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      result = db.prepare(`DELETE FROM phrase_items WHERE kind = ? AND id IN (${placeholders})`).run(kind, ...ids);
      db.prepare('UPDATE phrase_pools SET last_item_id = CASE WHEN last_item_id IN (' + placeholders + ') THEN NULL ELSE last_item_id END, updated_at = ? WHERE kind = ?')
        .run(...ids, timestamp, kind);
    }
    db.exec('COMMIT');
    return { deletedCount: Number(result.changes), pool: getPhrasePool(db, kind) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function resetPhrasePool(db, kind) {
  assertKind(kind);
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE phrase_items SET last_used_cycle = 0, updated_at = ? WHERE kind = ?').run(timestamp, kind);
    db.prepare('UPDATE phrase_pools SET current_cycle = 1, last_item_id = NULL, updated_at = ? WHERE kind = ?').run(timestamp, kind);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPhrasePool(db, kind);
}

function previewPhrase(db, kind) {
  assertKind(kind);
  const pool = db.prepare('SELECT * FROM phrase_pools WHERE kind = ?').get(kind);
  const items = db.prepare(`
    SELECT id, content, last_used_cycle FROM phrase_items
    WHERE kind = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC
  `).all(kind);
  if (!items.length) {
    return { kind, displayName: pool.display_name, itemId: null, content: PLACEHOLDERS[kind], cycle: pool.current_cycle, missing: true };
  }
  let cycle = pool.current_cycle;
  let eligible = items.filter((item) => item.last_used_cycle < cycle);
  if (!eligible.length) {
    cycle += 1;
    eligible = [...items];
  }
  const item = eligible[0];
  return {
    kind,
    displayName: pool.display_name,
    itemId: item.id,
    content: item.content,
    cycle,
    missing: false
  };
}

function previewPhraseSet(db) {
  return KINDS.map((kind) => previewPhrase(db, kind));
}

function commitPhraseSelections(db, selections, timestamp = nowIso()) {
  const updateItem = db.prepare(`
    UPDATE phrase_items SET last_used_cycle = ?, use_count = use_count + 1,
      last_used_at = ?, updated_at = ? WHERE id = ? AND kind = ?
  `);
  selections.filter((item) => !item.missing && item.itemId).forEach((item) => {
    updateItem.run(item.cycle, timestamp, timestamp, item.itemId, item.kind);
    const remaining = db.prepare(`
      SELECT COUNT(*) AS total FROM phrase_items
      WHERE kind = ? AND enabled = 1 AND last_used_cycle < ?
    `).get(item.kind, item.cycle).total;
    db.prepare('UPDATE phrase_pools SET current_cycle = ?, last_item_id = ?, updated_at = ? WHERE kind = ?')
      .run(remaining ? item.cycle : item.cycle + 1, item.itemId, timestamp, item.kind);
  });
}

module.exports = {
  KINDS,
  listPhrasePools,
  getPhrasePool,
  addPhraseItems,
  updatePhraseItem,
  deletePhraseItem,
  deletePhraseItems,
  reorderPhraseItems,
  setPhraseNextItem,
  resetPhrasePool,
  previewPhraseSet,
  commitPhraseSelections
};
