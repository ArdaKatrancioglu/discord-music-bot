const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBinary, ffmpegPath, ytDlpPath } = require('../core/binaries');
const { downloadsDir } = require('../core/musicIndex');

const AUDIO_ONLY_FORMAT = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio';
const ANY_AUDIO_FORMAT = 'bestaudio*/best*[acodec!=none]/best';
const LOW_BANDWIDTH_AUDIO_FORMAT = 'worstaudio*/worst*[acodec!=none]/worst';

const DOWNLOAD_STRATEGIES = {
  preferredAudio: {
    name: 'preferred audio-only format',
    format: AUDIO_ONLY_FORMAT
  },
  anyAudio: {
    name: 'any available format containing audio',
    format: ANY_AUDIO_FORMAT
  },
  ytDlpDefault: {
    name: 'yt-dlp automatic format selection',
    format: null
  },
  alternateClient: {
    name: 'alternate YouTube clients with any audio',
    format: ANY_AUDIO_FORMAT,
    alternateClients: true
  },
  alternateLowBandwidth: {
    name: 'alternate YouTube clients with low-bandwidth audio',
    format: LOW_BANDWIDTH_AUDIO_FORMAT,
    alternateClients: true
  }
};

function buildExtractorArg() {
  // Local runs reach the published Docker port through loopback. Docker Compose
  // overrides this with http://bgutil-pot:4416 for container-to-container traffic.
  const baseUrl = process.env.BGUTIL_BASE_URL || 'http://127.0.0.1:4416';
  return `youtubepot-bgutilhttp:base_url=${baseUrl}`;
}

function buildExtractorArgs(alternateClients = false) {
  const args = [buildExtractorArg()];
  if (alternateClients) {
    args.push('youtube:player_client=default,mweb,web_safari,tv_downgraded,web_embedded');
  }
  return args;
}

function classifyDownloadError(error) {
  const text = `${error?.stderrData || ''}\n${error?.stdoutData || ''}`.toLowerCase();
  if (/requested format is not available|no video formats found/.test(text)) {
    return 'format-unavailable';
  }
  if (/http error 403|403 forbidden|forbidden/.test(text)) return 'access-denied';
  if (/http error 429|too many requests|rate.?limit/.test(text)) return 'rate-limited';
  if (/private video|members-only|age.restricted|sign in to confirm/.test(text)) {
    return 'restricted';
  }
  if (/no space left on device|disk quota exceeded/.test(text)) return 'storage';
  if (
    /timed out|temporary failure|connection reset|network is unreachable|failed to resolve/.test(
      text
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

function diagnoseDownloadError(error) {
  const output = `${error?.stderrData || ''}\n${error?.stdoutData || ''}`;
  const details = [];

  if (/unable to download video data:.*403|http error 403|403 forbidden/i.test(output)) {
    details.push('YouTube metadata was retrieved, but its media CDN rejected the audio-data request.');

    const format = output.match(/Downloading \d+ format\(s\):\s*([^\r\n]+)/i)?.[1];
    if (format) details.push(`Rejected format: ${format.trim()}.`);

    const clients = [...output.matchAll(/Downloading ([^\r\n]+?) player API JSON/gi)].map(
      (match) => match[1].trim()
    );
    if (clients.length) details.push(`Player client(s): ${[...new Set(clients)].join(', ')}.`);

    if (/android vr player API JSON/i.test(output)) {
      details.push(
        'Likely cause: the Android VR client produced a media URL without a valid PO token, or YouTube rejected the token/IP/client combination.'
      );
    } else {
      details.push(
        'Likely causes: missing/invalid PO token, token and IP/client mismatch, an expired signed media URL, or YouTube blocking the current IP.'
      );
    }
    details.push(
      'YouTube returns only “Forbidden” here, so the exact server-side rule cannot be known from the HTTP response.'
    );
  }

  return details;
}

function recoveryStrategiesFor(error) {
  switch (classifyDownloadError(error)) {
  case 'format-unavailable':
    return [
      DOWNLOAD_STRATEGIES.anyAudio,
      DOWNLOAD_STRATEGIES.ytDlpDefault,
      DOWNLOAD_STRATEGIES.alternateClient,
      DOWNLOAD_STRATEGIES.alternateLowBandwidth
    ];
  case 'access-denied':
    return [
      DOWNLOAD_STRATEGIES.alternateClient,
      DOWNLOAD_STRATEGIES.alternateLowBandwidth,
      DOWNLOAD_STRATEGIES.ytDlpDefault
    ];
  case 'network':
  case 'unknown':
    return [
      DOWNLOAD_STRATEGIES.anyAudio,
      DOWNLOAD_STRATEGIES.alternateClient,
      DOWNLOAD_STRATEGIES.ytDlpDefault
    ];
  default:
    return [];
  }
}

function runYtDlpDownload({
  url,
  filenameTemplate,
  format,
  useAria2c = false,
  alternateClients = false
}) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;

    const dlArgs = [
      '--newline',
      '--verbose',
      '--ffmpeg-location',
      path.dirname(ffmpegPath) || ffmpegPath,
      '--no-playlist',
      '--force-ipv4',
      '--check-formats',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      '--retry-sleep',
      '1',
      '--js-runtimes',
      'node'
    ];

    for (const extractorArg of buildExtractorArgs(alternateClients)) {
      dlArgs.push('--extractor-args', extractorArg);
    }

    if (format) dlArgs.push('-f', format);
    dlArgs.push('-o', path.join(downloadsDir, filenameTemplate), url);

    // Keep cookies disabled by default while using POT provider.
    // Enable only if you specifically need age/private/login-restricted videos.
    if (process.env.USE_COOKIES === 'true' && hasCookies) {
      dlArgs.push('--cookies', cookiesPath);
    }

    if (useAria2c && resolveBinary('aria2c')) {
      dlArgs.splice(1, 0, '--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 8 -k 1M');
    }

    const dl = spawn(ytDlpPath, dlArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrData = '';
    let stdoutData = '';

    dl.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    dl.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    dl.on('close', (code) => {
      if (code === 0) {
        resolve({
          stdoutData,
          stderrData
        });
      } else {
        reject({
          code,
          stderrData,
          stdoutData,
          format
        });
      }
    });

    dl.on('error', (error) => {
      reject({
        code: -1,
        stderrData: error.message || '',
        stdoutData,
        format
      });
    });
  });
}

function findDownloadedFile({ id, titleSan }) {
  const files = fs.readdirSync(downloadsDir);
  return files.find(
    (file) =>
      file.startsWith(`${id}_${titleSan}.`) &&
      /\.(mp3|m4a|webm|mp4|opus|ogg|wav)$/i.test(file) &&
      fs.statSync(path.join(downloadsDir, file)).size > 0
  );
}

function summarizeAttempt(strategy, error) {
  const stderrLines = String(error.stderrData || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const stdoutLines = String(error.stdoutData || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...stderrLines]
    .reverse()
    .find((line) => /(?:^|\b)(?:error|fatal)(?:\b|:)/i.test(line));
  const finalLine = errorLine || stderrLines.at(-1) || stdoutLines.at(-1);

  return {
    strategy: strategy.name,
    classification: classifyDownloadError(error),
    code: error.code,
    message: finalLine || `yt-dlp exited with code ${error.code}`,
    details: diagnoseDownloadError(error)
  };
}

async function downloadTrack({ id, titleSan, url, filenameTemplate, onRetry }) {
  const attempts = [];
  const queuedStrategies = [DOWNLOAD_STRATEGIES.preferredAudio];
  const attemptedNames = new Set();
  let lastError = null;

  while (queuedStrategies.length) {
    const strategy = queuedStrategies.shift();
    if (attemptedNames.has(strategy.name)) continue;
    attemptedNames.add(strategy.name);

    try {
      await runYtDlpDownload({
        url,
        filenameTemplate,
        format: strategy.format,
        alternateClients: strategy.alternateClients,
        useAria2c:
          strategy !== DOWNLOAD_STRATEGIES.preferredAudio &&
          process.env.USE_ARIA2C_FOR_VIDEO_FALLBACK === 'true'
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const attempt = summarizeAttempt(strategy, error);
      attempts.push(attempt);
      console.warn(
        `[Download Recovery] ${attempt.strategy} failed (${attempt.classification}, code ${attempt.code}): ${attempt.message}`
      );
      if (attempt.details.length) {
        console.warn('[Download Recovery] Diagnosis:\n- ' + attempt.details.join('\n- '));
      }
      if (error.stderrData?.trim()) {
        console.warn('[Download Recovery] yt-dlp stderr:\n' + error.stderrData.trim());
      }
      if (error.stdoutData?.trim()) {
        console.warn('[Download Recovery] yt-dlp stdout:\n' + error.stdoutData.trim());
      }

      const recoveryStrategies = recoveryStrategiesFor(error);
      if (!recoveryStrategies.length) {
        queuedStrategies.length = 0;
      } else {
        queuedStrategies.push(...recoveryStrategies);
      }
      const nextStrategy = queuedStrategies.find((item) => !attemptedNames.has(item.name));
      if (nextStrategy && onRetry) {
        try {
          await onRetry({
            failedAttempt: attempt,
            nextStrategy: nextStrategy.name,
            attemptNumber: attempts.length + 1
          });
        } catch (callbackError) {
          console.warn('[Download Recovery] Could not send retry status:', callbackError.message);
        }
      }
    }
  }

  const file = findDownloadedFile({ id, titleSan });

  if (!file) {
    const diagnostic = attempts
      .map(
        (attempt, index) =>
          `${index + 1}. ${attempt.strategy}: ${attempt.classification} (${attempt.message})`
      )
      .join('\n');
    throw {
      code: lastError?.code ?? 0,
      classification: lastError ? classifyDownloadError(lastError) : 'missing-output',
      stderrData: diagnostic || 'Downloaded file not found after yt-dlp reported success.',
      stdoutData: lastError?.stdoutData || '',
      attempts
    };
  }

  const filepath = path.join(downloadsDir, file);

  return {
    filePath: filepath,
    usedFallback: attempts.length > 0,
    attempts,
    strategy: [...attemptedNames].at(-1)
  };
}

module.exports = {
  classifyDownloadError,
  diagnoseDownloadError,
  recoveryStrategiesFor,
  summarizeAttempt,
  downloadTrack
};
