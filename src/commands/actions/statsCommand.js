const { EmbedBuilder } = require('discord.js');
const { latencyMonitor } = require('../../services/latencyService');
const { getAnalyticsSnapshot } = require('../../services/analyticsService');

function percentage(part, total) {
  if (!total) return 'n/a';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function average(total, count) {
  if (!count) return 'n/a';
  return `${Math.round(total / count)}ms`;
}

function duration(ms) {
  const totalSeconds = Math.round((ms || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function bytes(value) {
  if (!value) return '0 MiB';
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function attemptLine(label, counter) {
  return (
    `${label}: ${counter.successes}/${counter.attempts} success ` +
    `(${percentage(counter.successes, counter.attempts)}), avg ${average(counter.totalDurationMs, counter.attempts)}`
  );
}

module.exports = {
  async execute({ message }) {
    const data = getAnalyticsSnapshot();
    const totals = data.totals;
    const metadata = data.metadata;
    const downloads = data.downloads;
    const downloadedBytes = Object.values(downloads.attempts)
      .flatMap((strategies) => Object.values(strategies))
      .reduce((total, counter) => total + counter.totalBytes, 0);
    const lines = [
      '📊 **Music bot analytics**',
      `Since: ${data.createdAt}`,
      '',
      `Requests: ${totals.playRequests} total · ${totals.playRequestSuccesses} success · ${totals.playRequestFailures} failed · ${totals.playRequestDelegated} playlist/delegated · ${totals.playRequestCancelled} cancelled`,
      `Request success rate: ${percentage(totals.playRequestSuccesses, totals.playRequestSuccesses + totals.playRequestFailures)}`,
      `Cache hits: ${totals.cacheHits}`,
      '',
      `Playback: ${totals.tracksStarted} started · ${totals.tracksCompleted} completed · ${totals.tracksSkipped} skipped · ${totals.tracksStopped} stopped · ${totals.playbackErrors} errors`,
      `Completion rate: ${percentage(totals.tracksCompleted, totals.tracksStarted)}`,
      `Total active playback: ${duration(totals.totalPlayedMs)}`,
      '',
      `Metadata pipelines: ${metadata.successes}/${metadata.pipelines} success (${percentage(metadata.successes, metadata.pipelines)}), avg ${average(metadata.totalDurationMs, metadata.pipelines)}`,
      `Metadata cookie fallbacks: ${metadata.cookieFallbacks}`,
      attemptLine('  no-cookie', metadata.attempts.withoutCookies),
      attemptLine('  with-cookie', metadata.attempts.withCookies),
      '',
      `Download pipelines: ${downloads.successes}/${downloads.pipelines} success (${percentage(downloads.successes, downloads.pipelines)}), avg ${average(downloads.totalDurationMs, downloads.pipelines)}`,
      `Fallback successes: ${downloads.fallbackSuccesses} · cookie fallbacks: ${downloads.cookieFallbacks}`,
      `Successfully downloaded: ${bytes(downloadedBytes)}`
    ];

    for (const [mode, label] of [
      ['withoutCookies', 'no-cookie'],
      ['withCookies', 'with-cookie']
    ]) {
      const strategies = downloads.attempts[mode];
      for (const counter of Object.values(strategies)) {
        lines.push(attemptLine(`  ${label}/${counter.name}`, counter));
      }
    }

    const snapshot = latencyMonitor.snapshot();
    const milliseconds = (value) => (value === null ? 'n/a' : `${value.toFixed(1)} ms`);
    const latency = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Latency · last 180 seconds')
      .setDescription(
        'Gateway = sampled heartbeat RTT · Response = first Discord acknowledgment · Processing = full command duration'
      )
      .addFields(
        Object.entries({
          gateway: 'Discord gateway',
          eventLoop: 'Event loop lag',
          commandResponse: 'Command response',
          commandProcessing: 'Command processing'
        }).map(([key, name]) => {
          const metric = snapshot.metrics[key];
          return {
            name,
            value: `AVG ${milliseconds(metric.avg)} · P90 ${milliseconds(metric.p90)} · P99 ${milliseconds(metric.p99)} · n=${metric.count}`
          };
        })
      )
      .setFooter({ text: 'P90 needs 10 samples; P99 needs 100. Metrics are memory-only.' });
    return message.reply({ content: lines.join('\n').slice(0, 1950), embeds: [latency] });
  }
};
