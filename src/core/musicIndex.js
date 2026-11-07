const fs = require('fs');
const path = require('path');
const { parseCachedMp3Filename } = require('../utils/titleUtils');
const { atomicWrite } = require('./atomicFile');
const { migrateLocalLibrary, normalizeTrack, readLibrary } = require('./libraryMigration');
const { readLyrics, writeLyrics } = require('./lyricsStore');
const { resolveIndexPath, libraryMusicDirectory, MEDIA_FILE_PATTERN } = require('./libraryPaths');

const indexPath = resolveIndexPath();
if (
  !process.env.MUSIC_INDEX_PATH &&
  !fs.existsSync(indexPath) &&
  fs.existsSync(path.resolve('downloadedMusic/index.json'))
) {
  throw new Error(
    'Legacy downloadedMusic library detected. Rename it to data and run npm run migrate:layout before starting the bot.'
  );
}
const musicDir = libraryMusicDirectory(indexPath);
const root = path.dirname(indexPath);
if (fs.existsSync(root) && fs.readdirSync(root).some((file) => MEDIA_FILE_PATTERN.test(file))) {
  throw new Error(
    'Legacy flat media layout detected. Stop the bot and run npm run migrate:layout first.'
  );
}
fs.mkdirSync(musicDir, { recursive: true });
// A corrupt existing index must never be silently replaced with an empty library.
let index = fs.existsSync(indexPath) ? migrateLocalLibrary(indexPath) : { version: 2, tracks: [] };

function saveIndex(next) {
  atomicWrite(indexPath, JSON.stringify(next, null, 2));
  index = next;
}

for (const file of fs.readdirSync(musicDir)) {
  if (!MEDIA_FILE_PATTERN.test(file)) continue;
  const full = path.join(musicDir, file);
  const { id, titleSan, title } = parseCachedMp3Filename(file);
  const exists = index.tracks.some(
    (track) =>
      track.filePath === full ||
      (id && track.id === id) ||
      (!id && !track.id && track.titleSan === titleSan)
  );
  if (!exists)
    index.tracks.push(
      normalizeTrack({
        id,
        title,
        videoTitle: title,
        titleSan,
        filePath: full,
        url: id ? `https://www.youtube.com/watch?v=${id}` : null
      })
    );
}
saveIndex(index);

function getTrackFromCache({ id, titleSan }) {
  if (id) {
    return (
      index.tracks.find((track) => track.id === id) ||
      index.tracks.find(
        (track) =>
          !/^[A-Za-z0-9_-]{11}$/.test(track.id || '') &&
          track.filePath &&
          parseCachedMp3Filename(path.basename(track.filePath)).id === id
      ) ||
      null
    );
  }
  return titleSan ? index.tracks.find((track) => track.titleSan === titleSan) || null : null;
}

function addTrackToCache(track) {
  const next = readLibrary(indexPath);
  const position = next.tracks.findIndex(
    (item) =>
      (track.id && item.id === track.id) ||
      (track.filePath && item.filePath === track.filePath) ||
      (!track.id && !item.id && track.titleSan && item.titleSan === track.titleSan)
  );
  const merged = normalizeTrack(position >= 0 ? { ...next.tracks[position], ...track } : track);
  if (merged.lyrics && !readLyrics(indexPath, merged.lyrics)) merged.lyrics = null;
  if (position >= 0) next.tracks[position] = merged;
  else next.tracks.push(merged);
  saveIndex(next);
  return merged;
}

function updateTrackLyrics(trackId, lyrics) {
  if (!trackId) return false;
  try {
    const next = readLibrary(indexPath);
    const track = next.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    if (lyrics && typeof lyrics === 'object') {
      const reference = writeLyrics(indexPath, track, lyrics);
      if (!reference) return false;
      track.lyrics = reference;
    } else if (lyrics === null) track.lyrics = null;
    else if (readLyrics(indexPath, lyrics)) track.lyrics = lyrics;
    else return false;
    saveIndex(next);
    return true;
  } catch (error) {
    console.warn('[Lyrics Cache] Could not persist lyrics:', error.message);
    return false;
  }
}

function updateTrackLyricsOffset(trackId, lyricsOffset, titleSan) {
  try {
    const next = readLibrary(indexPath);
    const track = next.tracks.find((item) =>
      trackId ? item.id === trackId : titleSan && item.titleSan === titleSan
    );
    if (!track) return false;
    track.lyricsOffset = Number(lyricsOffset) || 0;
    saveIndex(next);
    return true;
  } catch (error) {
    console.warn('[Lyrics Offset] Could not persist offset:', error.message);
    return false;
  }
}

function listAllCachedTracksUnique() {
  return index.tracks.map((track) => ({ ...track }));
}

console.log(
  `[Init] Indexed library media: ${new Set(index.tracks.map((track) => track.filePath)).size} file(s)`
);
module.exports = {
  indexPath,
  musicDir,
  getTrackFromCache,
  addTrackToCache,
  updateTrackLyrics,
  updateTrackLyricsOffset,
  listAllCachedTracksUnique
};
