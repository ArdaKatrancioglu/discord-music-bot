const fs = require('fs');
const path = require('path');
const { libraryCacheDirectory } = require('./libraryPaths');

function regularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function organizeLibraryFiles(indexPath, { removeObsolete = true } = {}) {
  const root = path.dirname(path.resolve(indexPath));
  const dataDirectory = libraryCacheDirectory(indexPath);
  if (fs.existsSync(dataDirectory) && !fs.lstatSync(dataDirectory).isDirectory()) {
    throw new Error(`Cannot organize library: ${dataDirectory} is not a directory`);
  }
  fs.mkdirSync(dataDirectory, { recursive: true });

  const moved = [];
  const removed = [];
  const conflicts = [];
  for (const sourceDirectory of [root, path.join(root, '.bot-data')]) {
    for (const name of ['youtube-music-cache.json', 'analytics.json']) {
      const source = path.join(sourceDirectory, name);
      const destination = path.join(root, name === 'analytics.json' ? 'stats' : 'cache', name);
      if (!regularFile(source)) continue;
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(source, destination);
        moved.push(name);
      } else if (
        regularFile(destination) &&
        fs.readFileSync(source).equals(fs.readFileSync(destination))
      ) {
        fs.unlinkSync(source);
        removed.push(name);
      } else {
        // Both files may contain distinct metadata or analytics. Never overwrite either.
        conflicts.push(name);
      }
    }
  }

  const indexName = path.basename(indexPath);
  const isObsolete = (name) =>
    name !== indexName &&
    (name === 'embeddings.jsonl' ||
      name === 'embeddings.jsonl.backup' ||
      name === 'embeddings.jsonl.bak' ||
      name.startsWith('embeddings.jsonl.backup-') ||
      name === `${indexName}.backup` ||
      name === `${indexName}.bak` ||
      name.startsWith(`${indexName}.backup-`) ||
      ['search.sqlite', 'search.sqlite-wal', 'search.sqlite-shm'].includes(name));

  for (const directory of [root, path.join(root, '.bot-data')]) {
    if (!removeObsolete || !fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isObsolete(entry.name)) continue;
      fs.unlinkSync(path.join(directory, entry.name));
      removed.push(entry.name);
    }
  }
  const hidden = path.join(root, '.bot-data');
  if (fs.existsSync(hidden) && fs.lstatSync(hidden).isDirectory() && !fs.readdirSync(hidden).length)
    fs.rmdirSync(hidden);
  return { moved, removed, conflicts };
}

module.exports = { organizeLibraryFiles };
