const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeRepository, isNewerVersion, selectAsset, checkForUpdate, downloadUpdate } = require('../update');

test('GitHub update configuration normalizes repositories and compares semantic versions', () => {
  assert.equal(normalizeRepository('https://github.com/acme/wens-ding.git'), 'acme/wens-ding');
  assert.equal(isNewerVersion('v0.6.0', '0.5.0-dev'), true);
  assert.equal(isNewerVersion('v0.5.0', '0.5.0-dev'), true);
  assert.equal(isNewerVersion('v0.5.0-dev', '0.5.0'), false);
  assert.equal(isNewerVersion('v0.5.0', '0.5.0'), false);
  assert.equal(isNewerVersion('v0.4.9', '0.5.0-dev'), false);
  assert.throws(() => normalizeRepository('not-a-repository'), /用户名\/仓库名/);
});

test('GitHub update check selects the correct platform release asset and exposes its digest', async () => {
  const assets = [
    { name: 'DingDone-0.6.0-win-x64.zip', browser_download_url: 'https://github.com/acme/wens-ding/releases/download/v0.6.0/win.zip', url: 'https://api.github.com/repos/acme/wens-ding/releases/assets/123', size: 10, digest: 'sha256:abc' },
    { name: 'DingDone-0.6.0-macos-universal.tar.gz', browser_download_url: 'https://github.com/acme/wens-ding/releases/download/v0.6.0/mac.tar.gz', size: 20, digest: 'sha256:def' }
  ];
  assert.equal(selectAsset(assets, 'darwin').name.includes('macos'), true);
  const result = await checkForUpdate('acme/wens-ding', {
    platform: 'win32', currentVersion: '0.5.0-dev',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ tag_name: 'v0.6.0', name: '新版', body: '说明', html_url: 'https://github.com/acme/wens-ding/releases/tag/v0.6.0', published_at: '2026-07-17T00:00:00Z', assets })
    })
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.asset.name, 'DingDone-0.6.0-win-x64.zip');
  assert.equal(result.asset.digest, 'sha256:abc');
  assert.equal(result.asset.apiUrl, 'https://api.github.com/repos/acme/wens-ding/releases/assets/123');
});

test('update download verifies the GitHub SHA-256 digest before keeping the file', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-update-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const archive = Buffer.from('verified portable archive');
  const digest = `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`;
  const asset = {
    name: 'DingDone-0.6.0-win-x64.zip',
    browser_download_url: 'https://github.com/acme/wens-ding/releases/download/v0.6.0/win.zip',
    size: archive.length,
    digest
  };
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://api.github.com/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v0.6.0', name: '新版', body: '', html_url: 'https://github.com/acme/wens-ding/releases/tag/v0.6.0', published_at: '2026-07-17T00:00:00Z', assets: [asset] })
      };
    }
    return new Response(archive, { status: 200 });
  };
  const result = await downloadUpdate('acme/wens-ding', tempDir, {
    platform: 'win32', currentVersion: '0.5.0-dev', fetchImpl
  });
  assert.equal(fs.readFileSync(result.downloadedFile.path).equals(archive), true);
  assert.equal(result.downloadedFile.digest, digest);

  const badAsset = { ...asset, digest: `sha256:${'0'.repeat(64)}` };
  const badFetch = async (url) => String(url).startsWith('https://api.github.com/')
    ? { ok: true, status: 200, json: async () => ({ tag_name: 'v0.6.0', assets: [badAsset] }) }
    : new Response(archive, { status: 200 });
  await assert.rejects(() => downloadUpdate('acme/wens-ding', tempDir, {
    platform: 'win32', currentVersion: '0.5.0-dev', fetchImpl: badFetch
  }), /SHA-256 校验不一致/);
  assert.equal(fs.existsSync(path.join(tempDir, `${asset.name}.partial`)), false);
});

test('update download retries transient GitHub asset connection failures', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-update-retry-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const archive = Buffer.from('retry verified archive');
  const digest = `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`;
  const asset = {
    name: 'Wens-Ding-0.5.1-win-x64.zip',
    browser_download_url: 'https://github.com/acme/wens-ding/releases/download/v0.5.1/win.zip',
    size: archive.length,
    digest
  };
  let assetAttempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://api.github.com/')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.5.1', assets: [asset] }) };
    }
    assetAttempts += 1;
    if (assetAttempts === 1) throw new Error('fetch failed');
    return new Response(archive, { status: 200 });
  };
  const result = await downloadUpdate('acme/wens-ding', tempDir, {
    platform: 'win32', currentVersion: '0.5.0', fetchImpl
  });
  assert.equal(assetAttempts, 2);
  assert.equal(result.downloadedFile.digest, digest);
});

test('update download prefers the trusted GitHub release asset API', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wens-ding-update-api-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const archive = Buffer.from('official asset api archive');
  const digest = `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`;
  const asset = {
    name: 'Wens-Ding-0.5.2-win-x64.zip',
    browser_download_url: 'https://github.com/acme/wens-ding/releases/download/v0.5.2/win.zip',
    url: 'https://api.github.com/repos/acme/wens-ding/releases/assets/789',
    size: archive.length,
    digest
  };
  let requestedAssetApi = false;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.5.2', assets: [asset] }) };
    }
    requestedAssetApi = String(url) === asset.url && options.headers.Accept === 'application/octet-stream';
    return new Response(archive, { status: 200 });
  };
  const result = await downloadUpdate('acme/wens-ding', tempDir, {
    platform: 'win32', currentVersion: '0.5.1', fetchImpl
  });
  assert.equal(requestedAssetApi, true);
  assert.equal(result.downloadedFile.digest, digest);
});
