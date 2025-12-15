// youtubeMetadata.js
const { spawn } = require('child_process');
const { ytDlpPath } = require('./binaries');

function fetchMetadata(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--flat-playlist',
      '--get-id',
      '--get-title',
      '--encoding', 'utf-8',
      input
    ];

    const proc = spawn(ytDlpPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    let out = '';
    proc.stdout.on('data', d => (out += d));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        const lines = out.trim().split('\n');
        const id = (lines.shift() || '').trim();
        const title = (lines.join(' ') || '').trim();
        resolve({ id, title, url: `https://www.youtube.com/watch?v=${title}` });
      } else {
        reject(new Error(`yt-dlp exited ${code}`));
      }
    });
  });
}

module.exports = {
  fetchMetadata
};
