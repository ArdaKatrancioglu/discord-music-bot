const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { readLibrary } = require('./libraryMigration');
const { atomicWrite } = require('./atomicFile');
const { organizeLibraryFiles } = require('./libraryCleanup');
const { resolveIndexPath, libraryMusicDirectory, MEDIA_FILE_PATTERN } = require('./libraryPaths');
const { parseCachedMp3Filename } = require('../utils/titleUtils');

function isFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(65536);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function sameFile(left, right) {
  const a = fs.statSync(left),
    b = fs.statSync(right);
  return (
    a.size === b.size &&
    ((a.dev === b.dev && a.ino === b.ino) || fileHash(left) === fileHash(right))
  );
}

function migrateLayout({ indexPath = resolveIndexPath(), dryRun = false, playbackRoot } = {}) {
  indexPath = path.resolve(indexPath);
  const root = path.dirname(indexPath),
    musicDir = libraryMusicDirectory(indexPath);
  const library = readLibrary(indexPath);
  for (const directory of [musicDir, path.join(root, 'cache'), path.join(root, 'stats')]) {
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory())
      throw new Error(`${directory} must be a directory`);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const media = entries
    .filter(
      (entry) =>
        entry.name !== path.basename(indexPath) &&
        entry.isFile() &&
        (MEDIA_FILE_PATTERN.test(entry.name) || /\.(part|ytdl|temp)$/i.test(entry.name))
    )
    .map((entry) => entry.name);
  const known = new Set([
    ...media,
    ...(fs.existsSync(musicDir)
      ? fs.readdirSync(musicDir).filter((name) => isFile(path.join(musicDir, name)))
      : [])
  ]);
  const tracks = library.tracks.map((track) => {
    let name =
      typeof track.filePath === 'string'
        ? path.posix.basename(track.filePath.replace(/\\/g, '/'))
        : null;
    if (!name || !known.has(name)) {
      const matches = [...known].filter(
        (filename) =>
          MEDIA_FILE_PATTERN.test(filename) &&
          track.id &&
          parseCachedMp3Filename(filename).id === track.id
      );
      if (matches.length !== 1)
        throw new Error(
          `Cannot locate a unique audio file for ${track.id || track.title}. No files were moved.`
        );
      name = matches[0];
    }
    if (!isFile(path.join(root, name)) && !isFile(path.join(musicDir, name)))
      throw new Error(`Missing audio: ${name}`);
    if (isFile(path.join(root, name)) && !media.includes(name)) media.push(name);
    return { ...track, filePath: path.join(path.resolve(playbackRoot || root), 'music', name) };
  });
  const moves = [],
    duplicates = [];
  for (const name of media) {
    const source = path.join(root, name),
      destination = path.join(musicDir, name);
    if (fs.existsSync(destination)) {
      if (!isFile(destination) || !sameFile(source, destination))
        throw new Error(`Conflicting file: ${destination}. No files were moved.`);
      duplicates.push(source);
    } else moves.push({ source, destination });
  }
  const changedPaths = tracks.filter(
    (track, index) => track.filePath !== library.tracks[index].filePath
  ).length;
  const report = {
    tracks: tracks.length,
    movedFiles: moves.length,
    updatedPaths: changedPaths,
    identicalDuplicates: duplicates.length,
    dryRun
  };
  if (dryRun) return report;

  // Keep media and index operations out of a live bot's library.
  const guards = [];
  try {
    for (const name of ['search.sqlite', '.bot-data/search.sqlite', 'cache/search.sqlite']) {
      const file = path.join(root, name);
      if (!isFile(file) || file === indexPath) continue;
      const db = new DatabaseSync(file);
      guards.push(db);
      db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;');
    }
    fs.mkdirSync(musicDir, { recursive: true });
    for (const move of moves) fs.renameSync(move.source, move.destination);
    // The unchanged source index remains readable until every media move succeeds.
    if (changedPaths) atomicWrite(indexPath, JSON.stringify({ ...library, tracks }, null, 2));
    for (const duplicate of duplicates) fs.unlinkSync(duplicate);
    report.organized = organizeLibraryFiles(indexPath, { removeObsolete: false });
    return report;
  } catch (error) {
    if (/database is locked|database is busy/i.test(error.message))
      throw new Error('Stop the bot before migrating the data layout.', { cause: error });
    throw error;
  } finally {
    for (const db of guards) db.close();
  }
}

module.exports = { migrateLayout };
