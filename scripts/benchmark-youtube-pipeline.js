#!/usr/bin/env node

/*
 * Measures the actual yt-dlp invocations used by this bot. It never adds a
 * benchmark download to the music index and removes media unless --keep is set.
 *
 * Example:
 *   node scripts/benchmark-youtube-pipeline.js 'https://www.youtube.com/watch?v=...'
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { execFileSync } = require('child_process');
const { fetchMetadata } = require('../src/core/youtubeMetadata');
const { ytDlpPath, ffmpegPath, resolveBinary } = require('../src/core/binaries');
const {
  DOWNLOAD_STRATEGIES,
  classifyDownloadError,
  diagnoseDownloadError,
  runYtDlpDownload
} = require('../src/services/downloadService');

function usage(exitCode = 0) {
  const text = `
YouTube pipeline benchmark

Usage:
  node scripts/benchmark-youtube-pipeline.js <YouTube URL or search query> [options]

Options:
  --cookies=both|with|without  Cookie scenarios to measure (default: both)
  --runs=N                     Repeat each scenario N times (default: 1)
  --no-download                Measure metadata only
  --keep                       Keep downloaded benchmark media under the run directory
  --help                       Show this help

The script writes report.md and report.json under benchmark-results/. Cookie
contents are never included in either report. For comparable downloads, pass a
direct YouTube URL rather than a search query.
`;
  console.log(text.trim());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { cookies: 'both', runs: 1, download: true, keep: false, input: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--no-download') options.download = false;
    else if (arg === '--keep') options.keep = true;
    else if (arg.startsWith('--cookies=')) options.cookies = arg.slice('--cookies='.length);
    else if (arg.startsWith('--runs=')) options.runs = Number(arg.slice('--runs='.length));
    else if (!arg.startsWith('-') && !options.input) options.input = arg;
    else {
      console.error(`Unknown or extra argument: ${arg}`);
      usage(1);
    }
  }
  if (!options.input) usage(1);
  if (!['both', 'with', 'without'].includes(options.cookies)) {
    throw new Error('--cookies must be one of: both, with, without');
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error('--runs must be an integer between 1 and 10');
  }
  return options;
}

function elapsedMs(start) {
  return Math.round(performance.now() - start);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortError(error) {
  const text = String(error?.stderrData || error?.message || error || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return text.find((line) => /error|fatal/i.test(line)) || text.at(-1) || 'Unknown error';
}

function reportCell(value) {
  return String(value ?? '-')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

function commandVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\r?\n/)[0];
  } catch (error) {
    return `unavailable (${error.message})`;
  }
}

async function measureMetadata(input, useCookies) {
  const started = performance.now();
  try {
    const meta = await fetchMetadata(input, { useCookies });
    return {
      ok: true,
      elapsedMs: elapsedMs(started),
      videoId: meta.realId,
      title: meta.realTitle,
      url: meta.url,
      durationSeconds: meta.duration
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: elapsedMs(started),
      classification: classifyDownloadError(error),
      error: shortError(error)
    };
  }
}

async function measureDownload({ url, strategyKey, strategy, useCookies, outputDir, run }) {
  const started = performance.now();
  const filenameTemplate = `${strategyKey}-${useCookies ? 'cookies' : 'no-cookies'}-${run}.%(ext)s`;
  try {
    await runYtDlpDownload({
      url,
      filenameTemplate,
      format: strategy.format,
      alternateClients: Boolean(strategy.alternateClients),
      useCookies,
      outputDir,
      useAria2c:
        strategyKey !== 'preferredAudio' && process.env.USE_ARIA2C_FOR_VIDEO_FALLBACK === 'true'
    });
    const files = fs.readdirSync(outputDir);
    const bytes = files.reduce(
      (sum, file) => sum + fs.statSync(path.join(outputDir, file)).size,
      0
    );
    return { ok: true, elapsedMs: elapsedMs(started), bytes, files };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: elapsedMs(started),
      classification: classifyDownloadError(error),
      error: shortError(error),
      diagnosis: diagnoseDownloadError(error)
    };
  }
}

function makeMarkdown(report) {
  const lines = [
    '# YouTube pipeline benchmark',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Input: \`${report.input}\``,
    `- Host: ${report.environment.hostname} (${report.environment.platform})`,
    `- Node: ${report.environment.node}; yt-dlp: ${report.environment.ytDlpVersion}; ffmpeg: ${report.environment.ffmpegVersion}`,
    `- Cookies file: ${report.cookies.available ? `available (${report.cookies.bytes} bytes)` : 'not available'}`,
    `- BGUTIL_BASE_URL: \`${report.environment.bgutilBaseUrl}\``,
    '',
    '## Metadata',
    '',
    '| Cookie mode | Run | Result | Time | Video | Error |',
    '| --- | ---: | --- | ---: | --- | --- |'
  ];

  for (const item of report.metadata) {
    lines.push(
      `| ${item.cookieMode} | ${item.run} | ${item.result.ok ? 'OK' : item.result.skipped ? 'SKIPPED' : 'FAILED'} | ${item.result.elapsedMs == null ? '-' : `${item.result.elapsedMs} ms`} | ${reportCell(item.result.videoId)} | ${reportCell(item.result.error || item.result.reason)} |`
    );
  }

  if (report.downloads.length) {
    lines.push('', '## Download modes', '');
    lines.push('| Cookie mode | Mode | Run | Result | Time | Size | Error / diagnosis |');
    lines.push('| --- | --- | ---: | --- | ---: | ---: | --- |');
    for (const item of report.downloads) {
      const r = item.result;
      const detail = r.diagnosis?.length
        ? `${r.error}<br>${r.diagnosis.join('<br>')}`
        : r.error || r.reason;
      lines.push(
        `| ${item.cookieMode} | ${item.strategy.name} | ${item.run} | ${r.ok ? 'OK' : r.skipped ? 'SKIPPED' : `FAILED (${r.classification})`} | ${r.elapsedMs == null ? '-' : `${r.elapsedMs} ms`} | ${r.bytes == null ? '-' : `${(r.bytes / 1024 / 1024).toFixed(2)} MiB`} | ${reportCell(detail)} |`
      );
    }
    lines.push(
      '',
      'A mode is **possible** when its row is OK. `SKIPPED` means it could not be tested (for example, no cookies file or metadata failure), not that YouTube rejected it.'
    );
  }
  lines.push('', `Raw machine-readable data: \`${path.basename(report.jsonPath)}\`.`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cookiesPath = path.join(process.cwd(), 'cookies.txt');
  const cookiesAvailable = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;
  const cookieModes = options.cookies === 'both' ? [false, true] : [options.cookies === 'with'];
  const runDir = path.join(process.cwd(), 'benchmark-results', `youtube-${timestamp()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    input: options.input,
    options,
    cookies: {
      available: cookiesAvailable,
      bytes: cookiesAvailable ? fs.statSync(cookiesPath).size : 0
    },
    environment: {
      hostname: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      ytDlpPath,
      ytDlpVersion: commandVersion(ytDlpPath),
      ffmpegPath,
      ffmpegVersion: commandVersion(ffmpegPath, ['-version']),
      aria2cAvailable: Boolean(resolveBinary('aria2c')),
      bgutilBaseUrl: process.env.BGUTIL_BASE_URL || 'http://127.0.0.1:4416',
      useAria2cForVideoFallback: process.env.USE_ARIA2C_FOR_VIDEO_FALLBACK === 'true'
    },
    metadata: [],
    downloads: []
  };

  console.log(`Benchmark output: ${runDir}`);
  for (const useCookies of cookieModes) {
    const cookieMode = useCookies ? 'with-cookies' : 'without-cookies';
    for (let run = 1; run <= options.runs; run += 1) {
      if (useCookies && !cookiesAvailable) {
        report.metadata.push({
          cookieMode,
          run,
          result: { skipped: true, reason: 'cookies.txt is missing or empty' }
        });
        continue;
      }
      console.log(`[metadata] ${cookieMode}, run ${run}/${options.runs}`);
      const result = await measureMetadata(options.input, useCookies);
      report.metadata.push({ cookieMode, run, result });
      console.log(`  ${result.ok ? 'OK' : 'FAILED'} in ${result.elapsedMs}ms`);
    }
  }

  if (options.download) {
    for (const useCookies of cookieModes) {
      const cookieMode = useCookies ? 'with-cookies' : 'without-cookies';
      const source = report.metadata.find(
        (item) => item.cookieMode === cookieMode && item.result.ok
      )?.result;
      for (const [strategyKey, strategy] of Object.entries(DOWNLOAD_STRATEGIES)) {
        for (let run = 1; run <= options.runs; run += 1) {
          if (useCookies && !cookiesAvailable) {
            report.downloads.push({
              cookieMode,
              strategyKey,
              strategy,
              run,
              result: { skipped: true, reason: 'cookies.txt is missing or empty' }
            });
            continue;
          }
          if (!source?.url) {
            report.downloads.push({
              cookieMode,
              strategyKey,
              strategy,
              run,
              result: { skipped: true, reason: 'metadata did not produce a video URL' }
            });
            continue;
          }
          const outputDir = path.join(runDir, 'media', cookieMode, strategyKey, String(run));
          fs.mkdirSync(outputDir, { recursive: true });
          console.log(`[download] ${cookieMode}, ${strategy.name}, run ${run}/${options.runs}`);
          const result = await measureDownload({
            url: source.url,
            strategyKey,
            strategy,
            useCookies,
            outputDir,
            run
          });
          report.downloads.push({
            cookieMode,
            strategyKey,
            strategy,
            run,
            sourceVideoId: source.videoId,
            result
          });
          console.log(`  ${result.ok ? 'OK' : 'FAILED'} in ${result.elapsedMs}ms`);
          if (!options.keep) fs.rmSync(outputDir, { recursive: true, force: true });
        }
      }
    }
  }

  report.jsonPath = path.join(runDir, 'report.json');
  report.markdownPath = path.join(runDir, 'report.md');
  fs.writeFileSync(report.jsonPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(report.markdownPath, makeMarkdown(report) + '\n');
  console.log(`\nDone. Read ${report.markdownPath}`);
}

main().catch((error) => {
  console.error(`Benchmark could not start: ${error.message}`);
  process.exitCode = 1;
});
