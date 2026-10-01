const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { ytDlpPath } = require('./binaries');

function hasCookiesFile() {
  const cookiesPath = path.join(process.cwd(), 'cookies.txt');
  return fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;
}

function classifyMetadataError(error) {
  const text = `${error?.message || ''}\n${error?.stderrData || ''}`.toLowerCase();
  if (/http error 403|403 forbidden|forbidden/.test(text)) return 'access-denied';
  if (/http error 429|too many requests|rate.?limit/.test(text)) return 'rate-limited';
  if (/private video|members-only|age.restricted|sign in to confirm/.test(text)) {
    return 'restricted';
  }
  if (/timed out|temporary failure|connection reset|network is unreachable|failed to resolve/.test(text)) {
    return 'network';
  }
  if (/no alternative results|no video/.test(text)) return 'no-results';
  return 'unknown';
}

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

function fetchMetadata(input, { excludeVideoIds = new Set(), useCookies } = {}) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = hasCookiesFile();
    const args = ['--no-playlist', '--dump-json', '--encoding', 'utf-8', '--js-runtimes', 'node'];

    const shouldUseCookies = useCookies ?? process.env.USE_COOKIES === 'true';
    if (shouldUseCookies && hasCookies) {
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
        const error = new Error(`yt-dlp exited ${code}\n${err}`);
        error.code = code;
        error.stderrData = err;
        error.stdoutData = out;
        reject(error);
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

async function callAttemptCallback(callback, attempt) {
  if (!callback) return;
  try {
    await callback(attempt);
  } catch (error) {
    console.warn('[Metadata Recovery] Attempt callback failed:', error.message);
  }
}

async function fetchMetadataWithFallback(
  input,
  {
    excludeVideoIds = new Set(),
    onAttempt,
    fetcher = fetchMetadata,
    cookiesAvailable = hasCookiesFile()
  } = {}
) {
  const cookieModes = cookiesAvailable ? [false, true] : [false];
  const attempts = [];
  let lastError = null;

  for (const useCookies of cookieModes) {
    const started = performance.now();
    try {
      const metadata = await fetcher(input, { excludeVideoIds, useCookies });
      const attempt = {
        useCookies,
        success: true,
        durationMs: performance.now() - started
      };
      attempts.push(attempt);
      await callAttemptCallback(onAttempt, attempt);
      return {
        metadata,
        attempts,
        usedCookieFallback: useCookies
      };
    } catch (error) {
      lastError = error;
      const attempt = {
        useCookies,
        success: false,
        durationMs: performance.now() - started,
        classification: classifyMetadataError(error),
        error
      };
      attempts.push(attempt);
      await callAttemptCallback(onAttempt, attempt);
    }
  }

  lastError.metadataAttempts = attempts;
  lastError.usedCookieFallback = attempts.some((attempt) => attempt.useCookies);
  throw lastError;
}

module.exports = {
  classifyMetadataError,
  extractYouTubeVideoId,
  fetchMetadata,
  fetchMetadataWithFallback,
  hasCookiesFile,
  selectMetadataResult
};
