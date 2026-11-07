const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { readLibrary } = require('../src/core/libraryMigration');
const { MusicSearchIndex } = require('../src/core/musicSearchIndex');
const { trackKey } = require('../src/core/searchText');
const { libraryCacheDirectory, resolveIndexPath } = require('../src/core/libraryPaths');
const { organizeLibraryFiles } = require('../src/core/libraryCleanup');

function rebuildSearch(indexPath = resolveIndexPath()) {
  indexPath = path.resolve(indexPath);
  // Read only: a missing or corrupt index must never trigger cleanup.
  const library = readLibrary(indexPath);
  const dataDirectory = libraryCacheDirectory(indexPath);
  if (fs.existsSync(dataDirectory) && !fs.lstatSync(dataDirectory).isDirectory()) {
    throw new Error(`Cannot organize library: ${dataDirectory} is not a directory`);
  }
  const storePath = path.join(dataDirectory, 'search.sqlite');
  if (storePath === indexPath)
    throw new Error('The library index and search database cannot use the same path');
  const legacyPaths = [
    path.join(path.dirname(indexPath), 'search.sqlite'),
    path.join(path.dirname(indexPath), '.bot-data', 'search.sqlite')
  ];
  const legacyGuards = [];
  let index;
  let result;
  try {
    for (const legacyPath of legacyPaths) {
      if (legacyPath === indexPath || legacyPath === storePath || !fs.existsSync(legacyPath))
        continue;
      const guard = new DatabaseSync(legacyPath);
      legacyGuards.push(guard);
      guard.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;');
    }
    index = new MusicSearchIndex({ storePath, exclusive: true });
    result = index.synchronize(library.tracks, { rebuild: true });
    const expected = new Set(library.tracks.map(trackKey)).size;
    if (
      result.indexed !== expected ||
      index.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    ) {
      throw new Error('Search index verification failed; old files were not cleaned');
    }
    index.db.exec(
      'INSERT INTO words(words) VALUES(\'integrity-check\'); INSERT INTO trigrams(trigrams) VALUES(\'integrity-check\');'
    );
  } catch (error) {
    if (/database is locked|database is busy/i.test(error.message)) {
      throw new Error(
        'Search database is in use; stop the bot before rebuilding. No cleanup was performed.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    index?.close();
    for (const guard of legacyGuards) guard.close();
  }

  const cleanup = organizeLibraryFiles(indexPath);
  console.log('[Lexical Search]', result);
  console.log(
    `[Cleanup] Organized ${cleanup.moved.length} support file(s) into cache/ and stats/.`
  );
  for (const name of cleanup.removed) console.log(`[Cleanup] Removed ${name}`);
  for (const name of cleanup.conflicts) {
    console.warn(`[Cleanup] Kept ${name}: a different organized file already exists.`);
  }
  return { ...result, cleanup };
}

if (require.main === module) {
  try {
    rebuildSearch();
  } catch (error) {
    console.error('[Lexical Search] Rebuild failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { rebuildSearch };
