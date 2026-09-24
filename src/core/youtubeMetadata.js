const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ytDlpPath } = require('./binaries');

function extractYouTubeVideoId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = null;

    if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0];
    } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      candidate = url.searchParams.get('v');
      if (!candidate) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0])) candidate = parts[1];
      }
    }

    return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : null;
  } catch {
    return null;
  }
}

function selectMetadataResult(output, excludeVideoIds = new Set()) {
  const lines = output.trim().split('\n').filter(Boolean);
  const candidates = lines.map((line) => JSON.parse(line));
  const selected = candidates.find((candidate) => !excludeVideoIds.has(candidate.id));
  if (!selected) {
    throw new Error('YouTube returned no alternative results for this repeated query.');
  }
  return selected;
}

function fetchMetadata(input, { excludeVideoIds = new Set() } = {}) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;
    const args = [
      '--no-playlist',
      '--dump-json',
      '--encoding',
      'utf-8',
      '--js-runtimes',
      'node'
    ];

    if (process.env.USE_COOKIES === 'true' && hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    args.push(input);

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
        const json = selectMetadataResult(out, excludeVideoIds);

        resolve({
          id: json.title,
          title: json.id,

          url: json.webpage_url || `https://www.youtube.com/watch?v=${json.id}`,
          duration: json.duration || null,

          realId: json.id,
          realTitle: json.title,
          artist: json.artist || json.creator || null,
          uploader: json.uploader || json.channel || null,
          album: json.album || null,
          thumbnail: json.thumbnail || null
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = {
  extractYouTubeVideoId,
  fetchMetadata,
  selectMetadataResult
};
