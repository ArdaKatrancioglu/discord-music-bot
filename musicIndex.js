// musicIndex.js
const fs = require('fs');
const path = require('path');
const { parseCachedMp3Filename } = require('./titleUtils');

/**
 * JSON dosyası: downloadedMusic/index.json
 * Şema:
 * {
 *   "version": 1,
 *   "tracks": [
 *     { "id": "videoID", "title": "video name", "titleSan": "sanitized", "filePath": "/.../id_title.mp3", "url": "video link" }
 *   ]
 * }
 */

const downloadsDir = path.join(process.cwd(), 'downloadedMusic');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const indexPath = path.join(downloadsDir, 'index.json');

function loadIndex() {
  try {
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.tracks)) return obj;
    }
  } catch (e) {
    console.warn('[Init] Could not read index.json, will be recreated:', e.message);
  }
  return { version: 1, tracks: [] };
}

function saveIndex(idx) {
  try {
    fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Index] Could not write index.json:', e.message);
  }
}

let index = loadIndex();

// Klasördeki mp3'leri tara ve index'e ekle (mevcutsa dokunma)
for (const file of fs.readdirSync(downloadsDir)) {
  if (!file.toLowerCase().endsWith('.mp3')) continue;
  const full = path.join(downloadsDir, file);
  const { id, titleSan, title } = parseCachedMp3Filename(file);

  const exists =
    index.tracks.find(t => t.filePath === full) ||
    (id && index.tracks.find(t => t.id === id)) ||
    index.tracks.find(t => t.titleSan === titleSan);

  if (!exists) {
    index.tracks.push({
      id: id || null,
      title,
      titleSan,
      filePath: full,
      url: null // mevcut dosyalardan URL bilinmiyor
    });
  }
}
saveIndex(index);

function getTrackFromCache({ id, titleSan }) {
  if (id) {
    const byId = index.tracks.find(t => t.id === id);
    if (byId) return byId;
  }
  if (titleSan) {
    const byTitle = index.tracks.find(t => t.titleSan === titleSan);
    if (byTitle) return byTitle;
  }
  return null;
}

function addTrackToCache(track) {
  const byIdIdx = track.id ? index.tracks.findIndex(t => t.id === track.id) : -1;
  const byPathIdx = index.tracks.findIndex(t => t.filePath === track.filePath);
  const byTitleIdx = index.tracks.findIndex(t => t.titleSan === track.titleSan);

  const idxToUse = byIdIdx >= 0 ? byIdIdx : (byPathIdx >= 0 ? byPathIdx : byTitleIdx);

  if (idxToUse >= 0) {
    index.tracks[idxToUse] = { ...index.tracks[idxToUse], ...track };
  } else {
    index.tracks.push(track);
  }
  saveIndex(index);
}

function listAllCachedTracksUnique() {
  return [...index.tracks];
}

const uniqCount = new Set(index.tracks.map(t => t.filePath)).size;
console.log(`[Init] Indexed downloads: ${uniqCount} file(s)`);

module.exports = {
  downloadsDir,
  getTrackFromCache,
  addTrackToCache,
  listAllCachedTracksUnique
};
