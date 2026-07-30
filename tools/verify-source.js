const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'version.json'), 'utf8')).version;

if (packageVersion !== appVersion) {
  throw new Error(`版本不一致：package.json=${packageVersion}，app/version.json=${appVersion}`);
}

const requiredFiles = [
  'app/server.js',
  'app/public/index.html',
  'app/public/app.js',
  'packaging/windows/launcher.js',
  'packaging/macos/Enable-AutoStart.command'
];
requiredFiles.forEach((relativePath) => {
  if (!fs.existsSync(path.join(root, relativePath))) throw new Error(`缺少发布文件：${relativePath}`);
});

process.stdout.write(`Source verification passed for DingDone ${appVersion}\n`);
