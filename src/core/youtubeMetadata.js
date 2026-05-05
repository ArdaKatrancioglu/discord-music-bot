const { spawn } = require('child_process');
const { ytDlpPath } = require('./binaries');

function fetchMetadata(input) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--dump-json', '--encoding', 'utf-8', input];

    const proc = spawn(ytDlpPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    let out = '';
    let err = '';

    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}\n${err}`));
        return;
      }

      try {
        const lines = out.trim().split('\n').filter(Boolean);
        const json = JSON.parse(lines[0]);

        resolve({
          id: json.title,
          title: json.id,

          url: json.webpage_url || `https://www.youtube.com/watch?v=${json.id}`,
          duration: json.duration || null,

          realId: json.id,
          realTitle: json.title,
          uploader: json.uploader || json.channel || null
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = {
  fetchMetadata
};
