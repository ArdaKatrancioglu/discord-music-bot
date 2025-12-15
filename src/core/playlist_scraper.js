// playlist_scraper.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/* -------- Aynı resolveBinary mantığı -------- */
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

const ytDlpPath = resolveBinary('yt-dlp') || resolveBinary('yt_dlp');
if (!ytDlpPath) {
  console.error('yt-dlp not found. Add it to PATH or place it as bin/yt-dlp(.exe).');
  process.exit(1);
}

/* -------- Playlist kazıyıcı -------- */
/**
 * input: playlist URL'si veya direk playlist ID'si (RDNGLxoKOvzu4 gibi)
 * çıktı: [{ id, title, url }, ...]
 */
function getPlaylistTracks(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',                 // sadece metadata
      '--encoding', 'utf-8',
      '--print', '%(id)s\t%(title)s',    // her satır: id<TAB>title
      input
    ];

    const proc = spawn(ytDlpPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (err += d));

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}\n${err}`));
      }

      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const items = lines.map(line => {
        const [id, title] = line.split('\t');
        return {
          id: id.trim(),
          title: (title || '').trim(),
          url: `https://www.youtube.com/watch?v=${id.trim()}`
        };
      });

      resolve(items);
    });

    proc.on('error', reject);
  });
}

/* -------- CLI kullanım -------- */
// node playlist_scraper.js "https://www.youtube.com/...."
if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node playlist_scraper.js <playlistUrlOrId>');
    process.exit(1);
  }
  getPlaylistTracks(input)
    .then(list => {
      console.log(JSON.stringify(list, null, 2));
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { getPlaylistTracks };