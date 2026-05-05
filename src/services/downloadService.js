const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBinary, ffmpegPath, ytDlpPath } = require('../core/binaries');
const { downloadsDir } = require('../core/musicIndex');

const AUDIO_ONLY_FORMAT =
  'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio';

const VIDEO_FALLBACK_FORMAT =
  'best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best';

function buildExtractorArg() {
  return 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416';
}

function runYtDlpDownload({
  url,
  filenameTemplate,
  format,
  useAria2c = false
}) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;

    const dlArgs = [
      '--newline',
      '--ffmpeg-location',
      path.dirname(ffmpegPath) || ffmpegPath,
      '--no-playlist',
      '--force-ipv4',
      '--js-runtimes',
      'node',
      '--extractor-args',
      buildExtractorArg(),
      '-f',
      format,
      '-o',
      path.join(downloadsDir, filenameTemplate),
      url
    ];

    // Keep cookies disabled by default while using POT provider.
    // Enable only if you specifically need age/private/login-restricted videos.
    if (process.env.USE_COOKIES === 'true' && hasCookies) {
      dlArgs.push('--cookies', cookiesPath);
    }

    if (useAria2c && resolveBinary('aria2c')) {
      dlArgs.splice(
        1,
        0,
        '--downloader',
        'aria2c',
        '--downloader-args',
        'aria2c:-x 8 -k 1M'
      );
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
  return files.find((file) => file.startsWith(`${id}_${titleSan}.`));
}

async function downloadTrack({ id, titleSan, url, filenameTemplate }) {
  let firstError = null;

  try {
    await runYtDlpDownload({
      url,
      filenameTemplate,
      format: AUDIO_ONLY_FORMAT,
      useAria2c: false
    });
  } catch (error) {
    firstError = error;

    await runYtDlpDownload({
      url,
      filenameTemplate,
      format: VIDEO_FALLBACK_FORMAT,
      useAria2c: process.env.USE_ARIA2C_FOR_VIDEO_FALLBACK === 'true'
    });
  }

  const file = findDownloadedFile({ id, titleSan });

  if (!file) {
    throw {
      code: 0,
      stderrData:
        'Downloaded file not found.' +
        (firstError?.stderrData ? `\nFirst audio-only error:\n${firstError.stderrData}` : ''),
      stdoutData: firstError?.stdoutData || ''
    };
  }

  const filepath = path.join(downloadsDir, file);

  return {
    filePath: filepath,
    usedFallback: firstError !== null,
    firstError
  };
}

module.exports = {
  downloadTrack
};