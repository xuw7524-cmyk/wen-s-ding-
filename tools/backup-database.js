const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

async function main() {
  const sourcePath = path.resolve(process.argv[2] || 'data/reminders.db');
  const destinationPath = path.resolve(process.argv[3] || 'data/reminders.backup.db');
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  process.stdout.write(`${destinationPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
