const fs = require('fs');
const path = require('path');

function libraryCacheDirectory(indexPath) {
  return path.join(path.dirname(path.resolve(indexPath)), 'cache');
}

function resolveIndexPath() {
  return path.resolve(
    process.env.MUSIC_INDEX_PATH || path.join(process.env.BOT_DATA_DIR || 'data', 'index.json')
  );
}

function libraryMusicDirectory(indexPath) {
  return path.join(path.dirname(path.resolve(indexPath)), 'music');
}

const MEDIA_FILE_PATTERN = /\.(mp3|m4a|webm|mp4|opus|ogg|flac|wav)$/i;

function libraryDataFile(indexPath, name) {
  const directory = path.dirname(path.resolve(indexPath));
  const organized =
    name === 'analytics.json'
      ? path.join(directory, 'stats', name)
      : path.join(libraryCacheDirectory(indexPath), name);
  const hidden = path.join(directory, '.bot-data', name);
  const legacy = path.join(directory, name);
  if (fs.existsSync(organized)) return organized;
  if (fs.existsSync(hidden)) return hidden;
  if (fs.existsSync(legacy)) return legacy;
  return organized;
}

module.exports = {
  libraryCacheDirectory,
  libraryDataFile,
  libraryMusicDirectory,
  resolveIndexPath,
  MEDIA_FILE_PATTERN
};
