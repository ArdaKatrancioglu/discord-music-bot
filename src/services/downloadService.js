const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBinary, ffmpegPath, ytDlpPath } = require('../core/binaries');
const { downloadsDir } = require('../core/musicIndex');

function downloadTrack({ id, titleSan, url, filenameTemplate }) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;
    const poToken = process.env.YT_PO_TOKEN;

    const playerClient = hasCookies ? 'mweb' : 'ios';
    const extractorArg =
      hasCookies && poToken
        ? `youtube:player_client=${playerClient};po_token=${playerClient}.gvs+${poToken}`
        : `youtube:player_client=${playerClient}`;

    const dlArgs = [
      '--newline',
      '--ffmpeg-location',
      path.dirname(ffmpegPath) || ffmpegPath,
      '--no-playlist',
      '--force-ipv4',
      '--js-runtimes',
      'node',
      '--extractor-args',
      extractorArg,
      '-f',
      'bestaudio/best',
      '-o',
      path.join(downloadsDir, filenameTemplate),
      url
    ];

    if (hasCookies) {
      dlArgs.push('--cookies', cookiesPath);
    }

    if (resolveBinary('aria2c')) {
      dlArgs.splice(1, 0, '--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 16 -k 1M');
    }

    const dl = spawn(ytDlpPath, dlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

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
        const files = fs.readdirSync(downloadsDir);
        const file = files.find((f) => f.startsWith(`${id}_${titleSan}.`));

        if (!file) {
          reject({
            code: 0,
            stderrData: 'Downloaded file not found.',
            stdoutData
          });
          return;
        }

        const filepath = path.join(downloadsDir, file);
        resolve({
          filePath: filepath,
          stdoutData,
          stderrData
        });
      } else {
        reject({
          code,
          stderrData,
          stdoutData
        });
      }
    });

    dl.on('error', (error) => {
      reject({
        code: -1,
        stderrData: error.message || '',
        stdoutData
      });
    });
  });
}

module.exports = {
  downloadTrack
};
