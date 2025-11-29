// binaries.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveBinary(name) {
  const local = path.join(
    process.cwd(),
    'bin',
    process.platform === 'win32' ? `${name}.exe` : name
  );
  if (fs.existsSync(local)) return local;

  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const out = execSync(`${locator} ${name}`, {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch (_) {}

  return null;
}

const ffmpegPath = resolveBinary('ffmpeg');
const ytDlpPath = resolveBinary('yt-dlp') || resolveBinary('yt_dlp');

if (!ytDlpPath) {
  console.error('yt-dlp not found. Add it to PATH or place it next to it as bin/yt-dlp.exe.');
  process.exit(1);
}
if (!ffmpegPath) {
  console.error('ffmpeg not found. Add it to PATH or place it next to it as bin/ffmpeg.exe.');
  process.exit(1);
}

module.exports = {
  resolveBinary,
  ffmpegPath,
  ytDlpPath
};
