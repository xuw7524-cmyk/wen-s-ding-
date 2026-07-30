const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function localVersion() {
  if (process.env.WENS_DING_VERSION) return process.env.WENS_DING_VERSION;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
  } catch {
    return '0.0.0-dev';
  }
}

const CURRENT_VERSION = localVersion();

function normalizeRepository(value) {
  const repository = String(value || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub 仓库格式应为“用户名/仓库名”');
  }
  return repository;
}

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) throw new Error(`无法识别版本号：${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] || null
  };
}

function isNewerVersion(latest, current = CURRENT_VERSION) {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index];
  }
  // 同一数字版本下，正式版高于任何预发布版本，例如 0.5.0 > 0.5.0-dev。
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  if (!a.prerelease && !b.prerelease) return false;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true }) > 0;
}

function assetPattern(platform) {
  if (platform === 'win32') return /win(?:dows)?[-_. ]?x64.*\.zip$/i;
  if (platform === 'darwin') return /mac(?:os)?[-_. ]?(?:universal|all).*(?:\.tar\.gz|\.zip)$/i;
  return null;
}

function selectAsset(assets, platform = process.platform) {
  const pattern = assetPattern(platform);
  if (!pattern) return null;
  return (Array.isArray(assets) ? assets : []).find((asset) => pattern.test(String(asset.name || ''))) || null;
}

async function checkForUpdate(repositoryInput, options = {}) {
  const repository = normalizeRepository(repositoryInput);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持检查更新');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DingDone/${CURRENT_VERSION}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new Error(`无法连接 GitHub 检查更新：${error.message}`);
  }
  if (response.status === 404) throw new Error('没有找到公开的 GitHub Release，请检查仓库地址和是否已经发布版本');
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
  const release = await response.json();
  const asset = selectAsset(release.assets, options.platform || process.platform);
  return {
    repository,
    currentVersion: options.currentVersion || CURRENT_VERSION,
    latestVersion: String(release.tag_name || '').replace(/^v/i, ''),
    updateAvailable: isNewerVersion(release.tag_name, options.currentVersion || CURRENT_VERSION),
    releaseName: release.name || release.tag_name,
    releaseNotes: String(release.body || '').slice(0, 5000),
    releasePage: release.html_url,
    publishedAt: release.published_at,
    asset: asset ? {
      name: asset.name,
      size: asset.size,
      downloadUrl: asset.browser_download_url,
      apiUrl: asset.url || null,
      digest: asset.digest || null
    } : null
  };
}

async function downloadUpdate(repositoryInput, destinationDir, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const update = await checkForUpdate(repositoryInput, options);
  if (!update.updateAvailable) throw new Error('当前已经是最新版，不需要下载');
  if (!update.asset) throw new Error('最新 Release 没有适合当前系统的发布文件');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(update.asset.digest || ''))) {
    throw new Error('发布文件缺少 SHA-256 校验值，为安全起见未下载');
  }
  if (Number(update.asset.size) <= 0 || Number(update.asset.size) > 500 * 1024 * 1024) {
    throw new Error('发布文件大小异常');
  }
  const downloadUrl = new URL(update.asset.downloadUrl);
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com') {
    throw new Error('发布文件下载地址不是可信的 GitHub HTTPS 地址');
  }
  let assetFetchUrl = update.asset.downloadUrl;
  let assetFetchHeaders = { 'User-Agent': `DingDone/${CURRENT_VERSION}` };
  if (update.asset.apiUrl) {
    const apiUrl = new URL(update.asset.apiUrl);
    if (apiUrl.protocol !== 'https:' || apiUrl.hostname !== 'api.github.com' || !/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(apiUrl.pathname)) {
      throw new Error('发布文件 API 地址不是可信的 GitHub HTTPS 地址');
    }
    assetFetchUrl = update.asset.apiUrl;
    assetFetchHeaders = {
      ...assetFetchHeaders,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  fs.mkdirSync(destinationDir, { recursive: true });
  const safeName = path.basename(update.asset.name);
  const finalPath = path.join(destinationDir, safeName);
  const tempPath = `${finalPath}.partial`;
  fs.rmSync(tempPath, { force: true });
  let response;
  try {
    let lastFetchError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetchImpl(assetFetchUrl, {
          headers: assetFetchHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(120000)
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        lastFetchError = null;
        break;
      } catch (error) {
        lastFetchError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    if (lastFetchError) throw lastFetchError;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    const actualDigest = `sha256:${hash.digest('hex')}`;
    if (actualDigest.toLowerCase() !== update.asset.digest.toLowerCase()) {
      fs.rmSync(tempPath, { force: true });
      throw new Error('下载文件的 SHA-256 校验不一致，文件已删除');
    }
    fs.rmSync(finalPath, { force: true });
    fs.renameSync(tempPath, finalPath);
    return { ...update, downloadedFile: { name: safeName, path: finalPath, digest: actualDigest } };
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (String(error.message).includes('SHA-256')) throw error;
    throw new Error(`新版下载失败：${error.message}`);
  }
}

module.exports = {
  CURRENT_VERSION,
  normalizeRepository,
  isNewerVersion,
  selectAsset,
  checkForUpdate,
  downloadUpdate
};
