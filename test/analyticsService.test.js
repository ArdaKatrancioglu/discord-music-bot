const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ANALYTICS_DISABLED = 'true';
const {
  getAnalyticsSnapshot,
  recordDownloadAttempt,
  recordDownloadPipeline,
  recordMetadataAttempt,
  recordMetadataPipeline,
  recordPlaybackEnd,
  recordPlaybackStart,
  recordPlayOutcome,
  recordPlayRequest
} = require('../src/services/analyticsService');

test('analytics aggregates request, pipeline and playback outcomes', () => {
  recordPlayRequest({ type: 'search' });
  recordPlayOutcome({ outcome: 'success', source: 'download', durationMs: 3200 });
  recordMetadataAttempt({ useCookies: false, success: false, durationMs: 1000, classification: 'restricted' });
  recordMetadataAttempt({ useCookies: true, success: true, durationMs: 2000 });
  recordMetadataPipeline({ success: true, durationMs: 3000, usedCookieFallback: true });
  recordDownloadAttempt({
    useCookies: false,
    strategyKey: 'preferredAudio',
    strategyName: 'preferred audio-only format',
    success: true,
    durationMs: 500,
    bytes: 1024
  });
  recordDownloadPipeline({
    success: true,
    durationMs: 500,
    attemptCount: 1,
    usedCookieFallback: false
  });

  const session = {
    currentTrack: { duration: 10, source: 'download' },
    trackStartedAt: Date.now() - 5000,
    pausedAt: null,
    pausedDurationMs: 0,
    playbackGeneration: 1,
    playbackAnalyticsRecordedGeneration: null
  };
  recordPlaybackStart(session, session.currentTrack);
  recordPlaybackEnd(session, 'skipped');

  const data = getAnalyticsSnapshot();
  assert.equal(data.totals.playRequests, 1);
  assert.equal(data.totals.playRequestSuccesses, 1);
  assert.equal(data.metadata.cookieFallbacks, 1);
  assert.equal(data.metadata.attempts.withoutCookies.failures, 1);
  assert.equal(data.metadata.attempts.withCookies.successes, 1);
  assert.equal(data.downloads.attempts.withoutCookies.preferredAudio.successes, 1);
  assert.equal(data.downloads.attempts.withoutCookies.preferredAudio.totalBytes, 1024);
  assert.equal(data.totals.tracksStarted, 1);
  assert.equal(data.totals.tracksSkipped, 1);
  assert.ok(data.totals.totalPlayedMs >= 4900);
});

test('playback end is recorded only once per playback generation', () => {
  const session = {
    currentTrack: { duration: 10 },
    trackStartedAt: Date.now() - 1000,
    pausedAt: null,
    pausedDurationMs: 0,
    playbackGeneration: 99,
    playbackAnalyticsRecordedGeneration: null
  };

  recordPlaybackStart(session, session.currentTrack);
  assert.ok(recordPlaybackEnd(session, 'completed'));
  assert.equal(recordPlaybackEnd(session, 'completed'), null);
});
