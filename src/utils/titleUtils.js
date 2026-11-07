// titleUtils.js
const path = require('path');

function formatTrackName(track) {
  const title = String(
    track?.title || track?.videoTitle || track?.displayTitle || 'Unknown track'
  ).trim();
  const artist = String(track?.artist || '').trim();
  return artist ? `${artist} – ${title}` : title;
}

function sanitizeTitle(title) {
  return title
    .normalize('NFKD')
    .replace(/[/\\:*?"<>|]+/g, '') // Windows yasakları
    .replace(/[^\w\s\-.()&,'[\]]+/g, '') // dosya için güvenli karakter seti
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '_')
    .slice(0, 120);
}

function unsanitizeTitle(filePart) {
  return filePart.replace(/_/g, ' ').trim();
}

function parseCachedMp3Filename(file) {
  // Yeni biçim:  <id>_<sanitizedTitle>.mp3
  // Eski biçim:  <title>.mp3  (ID yok)
  const base = path.basename(file, path.extname(file));
  const m = base.match(/^([A-Za-z0-9_-]{11})_(.+)$/); // YouTube ID genelde 11 ama esnek bırakalım
  if (m) {
    return { id: m[1], titleSan: m[2], title: unsanitizeTitle(m[2]) };
  }
  // Legacy: baştan komple başlık
  return { id: null, titleSan: base, title: unsanitizeTitle(base) };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  formatTrackName,
  sanitizeTitle,
  unsanitizeTitle,
  parseCachedMp3Filename,
  shuffle
};
