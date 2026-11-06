const fs = require('fs');
const path = require('path');
const { parseCachedMp3Filename } = require('../utils/titleUtils');
const { atomicWrite, backupFile } = require('./atomicFile');
const { createTtml, parseTtml } = require('./ttml');
const { readLyrics, writeLyrics } = require('./lyricsStore');
const { applyMusicMetadata } = require('./youtubeMusicMetadata');

function normalizeTrack(track) {
  const videoTitle = track.videoTitle ?? track.displayTitle ?? track.title ?? '';
  return {
    ...track,
    id: track.id ?? null,
    title: track.title || videoTitle,
    artist: track.artist || null,
    album: track.album || null,
    year: track.year || null,
    videoTitle,
    titleSan: track.titleSan ?? '',
    filePath: track.filePath ?? null,
    url: track.url ?? null,
    duration: track.duration ?? null,
    artworkUrl: track.artworkUrl || null,
    musicId: track.musicId || null,
    lyrics: typeof track.lyrics === 'string' ? track.lyrics : null
  };
}

function readLibrary(indexPath) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index || !Array.isArray(index.tracks))
    throw new Error('Invalid library: expected tracks array');
  return index;
}

function audioExists(filePath) {
  try {
    return typeof filePath === 'string' && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function relocatedAudioPath(indexPath, track) {
  if (audioExists(track.filePath)) return track.filePath;
  const directory = path.dirname(indexPath);
  if (typeof track.filePath === 'string') {
    const filename = path.posix.basename(track.filePath.replace(/\\/g, '/'));
    const candidate = path.join(directory, filename);
    if (audioExists(candidate)) return candidate;
  }
  const matches = fs
    .readdirSync(directory)
    .filter(
      (filename) =>
        /\.(mp3|m4a|webm)$/i.test(filename) &&
        track.id &&
        parseCachedMp3Filename(filename).id === track.id &&
        audioExists(path.join(directory, filename))
    );
  return matches.length === 1 ? path.join(directory, matches[0]) : track.filePath;
}

async function migrateLibrary({
  indexPath,
  dryRun = false,
  resolver,
  batchSize = Infinity,
  offset = 0,
  overwrite = false,
  relocateAudio = false,
  onProgress = () => {}
}) {
  const original = readLibrary(indexPath);
  let backup = null;
  const stats = {
    tracks: original.tracks.length,
    convertedLyrics: 0,
    enriched: 0,
    attempted: 0,
    relocatedAudio: 0,
    missingAudio: 0,
    backup: null
  };
  const ensureBackup = () => {
    if (!dryRun && !backup) stats.backup = backup = backupFile(indexPath);
  };
  // Checkpoint each completed track; a conversion failure leaves its embedded source intact.
  for (let position = 0; position < original.tracks.length; position++) {
    const source = original.tracks[position];
    let track = normalizeTrack(source);
    if (relocateAudio) {
      const filePath = relocatedAudioPath(indexPath, track);
      if (filePath !== track.filePath) {
        track.filePath = filePath;
        stats.relocatedAudio++;
      }
    }
    if (!audioExists(track.filePath)) stats.missingAudio++;
    if (source.lyrics && typeof source.lyrics === 'object') {
      const xml = createTtml(source.lyrics, source.duration);
      if (xml) {
        parseTtml(xml);
        ensureBackup();
        track.lyrics = dryRun
          ? `lyrics/${source.id}.ttml`
          : writeLyrics(indexPath, track, source.lyrics);
        if (!track.lyrics) throw new Error(`Cannot safely migrate lyrics for ${source.id}`);
        stats.convertedLyrics++;
      }
    } else if (track.lyrics && !readLyrics(indexPath, track.lyrics)) track.lyrics = null;
    if (
      resolver &&
      position >= offset &&
      stats.attempted < batchSize &&
      (!track.artist || overwrite)
    ) {
      stats.attempted++;
      const metadata = await resolver.resolve(track);
      if (metadata) {
        track = applyMusicMetadata(track, metadata, { overwrite });
        stats.enriched++;
      }
    }
    original.tracks[position] = track;
    if (JSON.stringify(source) !== JSON.stringify(track)) {
      ensureBackup();
      if (!dryRun) atomicWrite(indexPath, JSON.stringify(original, null, 2));
    }
    onProgress({ position: position + 1, ...stats });
  }
  if (original.version !== 2) {
    ensureBackup();
    original.version = 2;
    if (!dryRun) atomicWrite(indexPath, JSON.stringify(original, null, 2));
  }
  return { ...stats, index: original };
}

// Synchronous offline upgrade for normal startup, always backed up before any changes.
function migrateLocalLibrary(indexPath) {
  const index = readLibrary(indexPath);
  const old = JSON.stringify(index);
  let backup;
  const ensureBackup = () => {
    if (!backup) backup = backupFile(indexPath);
  };
  index.tracks = index.tracks.map((source) => {
    const track = normalizeTrack(source);
    if (source.lyrics && typeof source.lyrics === 'object') {
      if (createTtml(source.lyrics, source.duration)) {
        ensureBackup();
        track.lyrics = writeLyrics(indexPath, track, source.lyrics);
        if (!track.lyrics) throw new Error(`Cannot migrate lyrics for ${track.id}`);
      }
    } else if (track.lyrics && !readLyrics(indexPath, track.lyrics)) track.lyrics = null;
    return track;
  });
  index.version = 2;
  if (JSON.stringify(index) !== old) {
    ensureBackup();
    atomicWrite(indexPath, JSON.stringify(index, null, 2));
  }
  return index;
}

module.exports = { migrateLibrary, migrateLocalLibrary, normalizeTrack, readLibrary };
