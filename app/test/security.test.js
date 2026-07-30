const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  protectText,
  unprotectText,
  validateWebhook,
  webhookHint,
  encryptMacTextWithKey,
  decryptMacTextWithKey
} = require('../security');

test('Windows current-user encryption round trip does not expose plaintext', async () => {
  const plain = 'https://oapi.dingtalk.com/robot/send?access_token=TEST_ONLY_NOT_REAL_1234';
  const encrypted = await protectText(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(encrypted.includes('TEST_ONLY_NOT_REAL'), false);
  assert.equal(await unprotectText(encrypted), plain);
});

test('Webhook validation accepts DingTalk HTTPS URL and masks the token', () => {
  const plain = 'https://oapi.dingtalk.com/robot/send?access_token=TEST_ONLY_NOT_REAL_1234';
  assert.equal(validateWebhook(plain), plain);
  assert.equal(validateWebhook(`Webhook 地址： ${plain}\n`), plain);
  assert.equal(validateWebhook(`<${plain}>`), plain);
  assert.equal(webhookHint(plain), 'oapi.dingtalk.com · •••• 1234');
});

test('Webhook validation rejects non-DingTalk URL', () => {
  assert.throws(() => validateWebhook('https://example.com/robot?access_token=1234'), /钉钉/);
});

test('macOS AES-GCM encryption round trip hides plaintext and detects tampering', () => {
  const key = crypto.randomBytes(32);
  const plain = 'https://oapi.dingtalk.com/robot/send?access_token=MAC_TEST_ONLY_5678';
  const encrypted = encryptMacTextWithKey(plain, key);
  assert.match(encrypted, /^mac-keychain-v1:/);
  assert.equal(encrypted.includes('MAC_TEST_ONLY'), false);
  assert.equal(decryptMacTextWithKey(encrypted, key), plain);
  const changed = `${encrypted.slice(0, -2)}AA`;
  assert.throws(() => decryptMacTextWithKey(changed, key));
});
