const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../database');
const {
  createPool, addPoolItems, getPool, deletePoolItems, reorderPoolItems, setPoolNextItem,
  saveRule, previewRule, consumeRule
} = require('../content-pools');
const {
  addPhraseItems, deletePhraseItems, listPhrasePools, reorderPhraseItems, setPhraseNextItem
} = require('../phrase-pools');

test('A/B pools preview sequential items, advance only after success, and deduplicate execution', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-pool-test-'));
  const db = openDatabase(path.join(tempDir, 'pool.db'));
  context.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const poolA = createPool(db, { name: 'A池', description: '高频提醒' });
  const poolB = createPool(db, { name: 'B池', description: '低频提醒' });
  addPoolItems(db, poolA.id, ['A1 内容', 'A2 内容', 'A3 内容']);
  addPoolItems(db, poolB.id, ['B1 内容', 'B2 内容']);
  addPhraseItems(db, 'greeting', ['伙伴们，大家好', '各位小伙伴']);
  addPhraseItems(db, 'opening', ['今天请留意以下事项', '请大家重点关注']);
  addPhraseItems(db, 'closing', ['感谢配合', '请及时处理']);

  const allocations = [
    { weekday: 1, slotOrder: 1, poolId: poolA.id, itemCount: 2 },
    { weekday: 2, slotOrder: 1, poolId: poolA.id, itemCount: 1 },
    { weekday: 2, slotOrder: 2, poolId: poolB.id, itemCount: 1 }
  ];
  const rule = saveRule(db, null, {
    name: '每周风险规则', messageTitle: '每日风险提醒', opening: '大家好', closing: '请及时处理。', layoutMode: 'spacious', allocations
  });

  const firstPreview = previewRule(db, rule.id, 1, '定时通知');
  assert.deepEqual(firstPreview.selections.map((item) => item.content), ['A1 内容', 'A2 内容']);
  assert.equal(firstPreview.phraseSelections.length, 3);
  assert.equal(firstPreview.message, [
    '定时通知｜每日风险提醒',
    firstPreview.phraseSelections.find((item) => item.kind === 'greeting').content,
    firstPreview.phraseSelections.find((item) => item.kind === 'opening').content,
    '1. A1 内容\n\n2. A2 内容',
    firstPreview.phraseSelections.find((item) => item.kind === 'closing').content
  ].join('\n\n'));
  assert.equal(firstPreview.advancesPosition, false);
  assert.equal(getPool(db, poolA.id).usedInCycle, 0);
  assert.equal(listPhrasePools(db).every((pool) => pool.usedInCycle === 0), true);

  const consumed = consumeRule(db, rule.id, 1, '定时通知', 'job-2026-07-20');
  assert.equal(consumed.duplicate, false);
  assert.equal(getPool(db, poolA.id).usedInCycle, 2);
  assert.equal(getPool(db, poolA.id).items[0].useCount, 1);
  assert.equal(listPhrasePools(db).every((pool) => pool.usedInCycle === 1), true);

  const duplicate = consumeRule(db, rule.id, 1, '定时通知', 'job-2026-07-20');
  assert.equal(duplicate.duplicate, true);
  assert.equal(getPool(db, poolA.id).items[0].useCount, 1);
  assert.equal(listPhrasePools(db).every((pool) => pool.items.reduce((sum, item) => sum + item.useCount, 0) === 1), true);

  const nextConsumed = consumeRule(db, rule.id, 1, '定时通知', 'job-2026-07-27');
  assert.deepEqual(nextConsumed.selections.map((item) => item.content), ['A3 内容', 'A1 内容']);
  assert.equal(new Set(nextConsumed.selections.map((item) => item.itemId)).size, 2);
  assert.equal(getPool(db, poolA.id).currentCycle, 2);
  firstPreview.phraseSelections.forEach((firstPhrase) => {
    const nextPhrase = nextConsumed.phraseSelections.find((item) => item.kind === firstPhrase.kind);
    assert.notEqual(nextPhrase.itemId, firstPhrase.itemId);
  });

  const tuesdayPreview = previewRule(db, rule.id, 2, '定时通知');
  assert.deepEqual(tuesdayPreview.selections.map((item) => item.content), ['A2 内容', 'B1 内容']);
  assert.equal(getPool(db, poolB.id).usedInCycle, 0);
});

test('message layout can be compact, balanced, or spacious', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-layout-test-'));
  const db = openDatabase(path.join(tempDir, 'layout.db'));
  context.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const pool = createPool(db, { name: '排版池' });
  addPoolItems(db, pool.id, ['风险一', '风险二']);
  addPhraseItems(db, 'greeting', ['大家好']);
  addPhraseItems(db, 'opening', ['请留意以下事项']);
  addPhraseItems(db, 'closing', ['感谢配合']);
  const input = {
    name: '排版规则', messageTitle: '排版测试', layoutMode: 'compact',
    allocations: [{ weekday: 1, slotOrder: 1, poolId: pool.id, itemCount: 2 }]
  };
  let rule = saveRule(db, null, input);
  const compact = previewRule(db, rule.id, 1, '定时通知');
  assert.equal(compact.layoutMode, 'compact');
  assert.equal(compact.message.includes('\n\n'), false);

  rule = saveRule(db, rule.id, { ...input, layoutMode: 'balanced' });
  const balanced = previewRule(db, rule.id, 1, '定时通知');
  assert.equal(balanced.layoutMode, 'balanced');
  assert.match(balanced.message, /1\. 风险一\n2\. 风险二/);
  assert.doesNotMatch(balanced.message, /1\. 风险一\n\n2\. 风险二/);

  rule = saveRule(db, rule.id, { ...input, layoutMode: 'spacious' });
  const spacious = previewRule(db, rule.id, 1, '定时通知');
  assert.equal(spacious.layoutMode, 'spacious');
  assert.match(spacious.message, /1\. 风险一\n\n2\. 风险二/);
});

test('content and phrase pools support selected deletion and clear all', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-bulk-delete-test-'));
  const db = openDatabase(path.join(tempDir, 'bulk-delete.db'));
  context.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const pool = createPool(db, { name: '批量删除池' });
  const populated = addPoolItems(db, pool.id, ['内容1', '内容2', '内容3']);
  const selected = deletePoolItems(db, pool.id, [populated.items[0].id, populated.items[2].id]);
  assert.equal(selected.deletedCount, 2);
  assert.deepEqual(selected.pool.items.map((item) => item.content), ['内容2']);
  const cleared = deletePoolItems(db, pool.id, [], true);
  assert.equal(cleared.deletedCount, 1);
  assert.equal(cleared.pool.items.length, 0);

  addPhraseItems(db, 'greeting', ['称呼1', '称呼2', '称呼3']);
  const phrases = listPhrasePools(db).find((item) => item.kind === 'greeting');
  const phraseSelected = deletePhraseItems(db, 'greeting', [phrases.items[1].id]);
  assert.equal(phraseSelected.deletedCount, 1);
  assert.equal(phraseSelected.pool.items.length, 2);
  const phraseCleared = deletePhraseItems(db, 'greeting', [], true);
  assert.equal(phraseCleared.deletedCount, 2);
  assert.equal(phraseCleared.pool.items.length, 0);
});

test('content and phrase pools can reorder and explicitly choose the next item', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-reorder-test-'));
  const db = openDatabase(path.join(tempDir, 'reorder.db'));
  context.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const pool = createPool(db, { name: '可排序内容池' });
  let populated = addPoolItems(db, pool.id, ['旧1', '旧2', '旧3']);
  addPhraseItems(db, 'greeting', ['旧称呼1', '旧称呼2']);
  addPhraseItems(db, 'opening', ['开头']);
  addPhraseItems(db, 'closing', ['结尾']);
  const rule = saveRule(db, null, {
    name: '排序规则', messageTitle: '排序测试', layoutMode: 'compact',
    allocations: [{ weekday: 1, slotOrder: 1, poolId: pool.id, itemCount: 1 }]
  });

  consumeRule(db, rule.id, 1, '定时通知', 'before-reorder');
  populated = addPoolItems(db, pool.id, ['新内容']);
  const newContent = populated.items.find((item) => item.content === '新内容');
  const contentOrder = [newContent.id, ...populated.items.filter((item) => item.id !== newContent.id).map((item) => item.id)];
  const reorderedContent = reorderPoolItems(db, pool.id, contentOrder);
  assert.deepEqual(reorderedContent.items.map((item) => item.content), ['新内容', '旧1', '旧2', '旧3']);
  setPoolNextItem(db, pool.id, newContent.id);

  let greetings = listPhrasePools(db).find((item) => item.kind === 'greeting');
  greetings = addPhraseItems(db, 'greeting', ['新称呼']);
  const newGreeting = greetings.items.find((item) => item.content === '新称呼');
  const greetingOrder = [newGreeting.id, ...greetings.items.filter((item) => item.id !== newGreeting.id).map((item) => item.id)];
  const reorderedGreetings = reorderPhraseItems(db, 'greeting', greetingOrder);
  assert.deepEqual(reorderedGreetings.items.map((item) => item.content), ['新称呼', '旧称呼1', '旧称呼2']);
  setPhraseNextItem(db, 'greeting', newGreeting.id);

  const preview = previewRule(db, rule.id, 1, '定时通知');
  assert.equal(preview.selections[0].content, '新内容');
  assert.equal(preview.phraseSelections.find((item) => item.kind === 'greeting').content, '新称呼');
  assert.equal(getPool(db, pool.id).currentPosition, 1, 'preview must not advance the content cursor');
  assert.equal(listPhrasePools(db).find((item) => item.kind === 'greeting').currentPosition, 1, 'preview must not advance the phrase cursor');

  consumeRule(db, rule.id, 1, '定时通知', 'after-reorder');
  const nextPreview = previewRule(db, rule.id, 1, '定时通知');
  assert.equal(nextPreview.selections[0].content, '旧1');
  assert.equal(nextPreview.phraseSelections.find((item) => item.kind === 'greeting').content, '旧称呼1');
});
