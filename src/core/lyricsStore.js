const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomicFile');
const { createTtml, parseTtml } = require('./ttml');

function lyricsFile(indexPath, reference) {
  if (typeof reference !== 'string' || !/^lyrics\/[A-Za-z0-9_-]+\.ttml$/.test(reference))
    return null;
  const directory = path.resolve(path.dirname(indexPath), 'lyrics');
  const file = path.resolve(path.dirname(indexPath), reference);
  // Do not allow a symlinked lyrics directory/file to escape the library.
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return null;
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return null;
  return file;
}

function readLyrics(indexPath, reference) {
  try {
    const file = lyricsFile(indexPath, reference);
    return file ? parseTtml(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function writeLyrics(indexPath, track, input) {
  if (!/^[A-Za-z0-9_-]+$/.test(track.id || '')) return null;
  const xml = createTtml(input, track.duration, { language: track.language || track.lang });
  if (!xml) return null;
  parseTtml(xml);
  const reference = `lyrics/${track.id}.ttml`;
  const file = lyricsFile(indexPath, reference);
  if (!file) throw new Error('Unsafe lyrics path');
  atomicWrite(file, xml);
  if (!readLyrics(indexPath, reference)) throw new Error('TTML verification failed');
  return reference;
}

module.exports = { lyricsFile, readLyrics, writeLyrics };
