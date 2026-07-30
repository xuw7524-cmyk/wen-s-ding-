const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function writeString(buffer, offset, length, value) {
  Buffer.from(String(value), 'utf8').copy(buffer, offset, 0, length);
}

function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, '0') + '\0';
  writeString(buffer, offset, length, text);
}

function splitTarPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: '' };
  const parts = normalized.split('/');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Archive path is too long: ${relativePath}`);
}

function tarHeader(relativePath, stat, isDirectory, executable) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(relativePath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, isDirectory || executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, isDirectory ? 0 : stat.size);
  writeOctal(header, 136, 12, Math.floor(stat.mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  header[156] = isDirectory ? 0x35 : 0x30;
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'wheel');
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function collect(root, current = root) {
  const entries = [];
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name);
    const stat = fs.statSync(absolute);
    entries.push({ absolute, relative: path.relative(path.dirname(root), absolute), stat });
    if (stat.isDirectory()) entries.push(...collect(root, absolute));
  }
  return entries;
}

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node create-tar-gz.js <source-directory> <output.tar.gz>');
const root = path.resolve(source);
const blocks = [];
for (const entry of [{ absolute: root, relative: path.basename(root), stat: fs.statSync(root) }, ...collect(root)]) {
  const isDirectory = entry.stat.isDirectory();
  const normalizedPath = entry.relative.replace(/\\/g, '/');
  const archivePath = isDirectory ? `${normalizedPath}/` : normalizedPath;
  const executable = /(?:^|\/)(?:node|[^/]+\.command)$/.test(archivePath);
  blocks.push(tarHeader(archivePath, entry.stat, isDirectory, executable));
  if (!isDirectory) {
    const content = fs.readFileSync(entry.absolute);
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
}
blocks.push(Buffer.alloc(1024));
fs.writeFileSync(path.resolve(output), zlib.gzipSync(Buffer.concat(blocks), { level: 9 }));
