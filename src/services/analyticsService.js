const fs = require('fs');
const path = require('path');
const { downloadsDir } = require('../core/musicIndex');

const analyticsPath = path.join(downloadsDir, 'analytics.json');
const RECENT_EVENT_LIMIT = 200;
const analyticsEnabled =
  process.env.ANALYTICS_DISABLED !== 'true' && !process.env.NODE_TEST_CONTEXT;

function emptyCounter() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    errors: {}
  };
}

function createEmptyAnalytics() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    totals: {
      playRequests: 0,
      searchRequests: 0,
      urlRequests: 0,
      playRequestSuccesses: 0,
      playRequestFailures: 0,
      playRequestDelegated: 0,
      playRequestCancelled: 0,
      cacheHits: 0,
      tracksStarted: 0,
      tracksCompleted: 0,
      tracksSkipped: 0,
      tracksStopped: 0,
      playbackErrors: 0,
      playbackShutdowns: 0,
      totalPlayedMs: 0,
      totalExpectedMs: 0
    },
    cacheHitsBySource: {},
    playOutcomesBySource: {},
    playFailuresByReason: {},
    playbackBySource: {},
    metadata: {
      pipelines: 0,
      successes: 0,
      failures: 0,
      cookieFallbacks: 0,
      totalDurationMs: 0,
      attempts: {
        withoutCookies: emptyCounter(),
        withCookies: emptyCounter()
      }
    },
    downloads: {
      pipelines: 0,
      successes: 0,
      failures: 0,
      fallbackSuccesses: 0,
      cookieFallbacks: 0,
      totalDurationMs: 0,
      attempts: {
        withoutCookies: {},
        withCookies: {}
      }
    },
    recentEvents: []
  };
}

function mergeCounter(value) {
  return {
    ...emptyCounter(),
    ...(value || {}),
    errors: { ...(value?.errors || {}) }
  };
}

function normalizeStrategyCounters(value) {
  return Object.fromEntries(
    Object.entries(value || {}).map(([key, counter]) => [key, mergeCounter(counter)])
  );
}

function normalizeAnalytics(value) {
  const empty = createEmptyAnalytics();
  if (!value || typeof value !== 'object') return empty;

  return {
    ...empty,
    ...value,
    totals: { ...empty.totals, ...(value.totals || {}) },
    cacheHitsBySource: { ...(value.cacheHitsBySource || {}) },
    playOutcomesBySource: { ...(value.playOutcomesBySource || {}) },
    playFailuresByReason: { ...(value.playFailuresByReason || {}) },
    playbackBySource: { ...(value.playbackBySource || {}) },
    metadata: {
      ...empty.metadata,
      ...(value.metadata || {}),
      attempts: {
        withoutCookies: mergeCounter(value.metadata?.attempts?.withoutCookies),
        withCookies: mergeCounter(value.metadata?.attempts?.withCookies)
      }
    },
    downloads: {
      ...empty.downloads,
      ...(value.downloads || {}),
      attempts: {
        withoutCookies: normalizeStrategyCounters(
          value.downloads?.attempts?.withoutCookies
        ),
        withCookies: normalizeStrategyCounters(value.downloads?.attempts?.withCookies)
      }
    },
    recentEvents: Array.isArray(value.recentEvents)
      ? value.recentEvents.slice(-RECENT_EVENT_LIMIT)
      : []
  };
}

function loadAnalytics() {
  if (!analyticsEnabled) return createEmptyAnalytics();
  try {
    if (fs.existsSync(analyticsPath)) {
      return normalizeAnalytics(JSON.parse(fs.readFileSync(analyticsPath, 'utf8')));
    }
  } catch (error) {
    console.warn('[Analytics] Existing analytics.json could not be read:', error.message);
  }
  return createEmptyAnalytics();
}

let analytics = loadAnalytics();

function saveAnalytics() {
  if (!analyticsEnabled) return;
  analytics.updatedAt = new Date().toISOString();
  const temporaryPath = `${analyticsPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(analytics, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaryPath, analyticsPath);
  } catch (error) {
    console.warn('[Analytics] Could not persist analytics:', error.message);
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup; the original persistence error was already logged.
    }
  }
}

function increment(map, key, amount = 1) {
  const safeKey = String(key || 'unknown');
  map[safeKey] = (map[safeKey] || 0) + amount;
}

function addRecentEvent(type, details = {}) {
  analytics.recentEvents.push({ at: new Date().toISOString(), type, ...details });
  if (analytics.recentEvents.length > RECENT_EVENT_LIMIT) {
    analytics.recentEvents.splice(0, analytics.recentEvents.length - RECENT_EVENT_LIMIT);
  }
}

function updateCounter(counter, { success, durationMs = 0, bytes = 0, classification }) {
  counter.attempts++;
  counter.totalDurationMs += Math.max(0, Math.round(durationMs));
  counter.totalBytes += Math.max(0, Math.round(bytes));
  if (success) counter.successes++;
  else {
    counter.failures++;
    increment(counter.errors, classification || 'unknown');
  }
}

function recordPlayRequest({ type }) {
  analytics.totals.playRequests++;
  if (type === 'url') analytics.totals.urlRequests++;
  else analytics.totals.searchRequests++;
  saveAnalytics();
}

function recordCacheHit({ source }) {
  analytics.totals.cacheHits++;
  increment(analytics.cacheHitsBySource, source);
  addRecentEvent('cache-hit', { source: source || 'unknown' });
  saveAnalytics();
}

function recordPlayOutcome({ outcome, source, reason, durationMs }) {
  if (outcome === 'success') {
    analytics.totals.playRequestSuccesses++;
    increment(analytics.playOutcomesBySource, source);
  } else if (outcome === 'delegated') {
    analytics.totals.playRequestDelegated++;
  } else if (outcome === 'cancelled') {
    analytics.totals.playRequestCancelled++;
  } else {
    analytics.totals.playRequestFailures++;
    increment(analytics.playFailuresByReason, reason);
  }
  addRecentEvent('play-request-outcome', {
    outcome,
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    durationMs: Math.max(0, Math.round(durationMs || 0))
  });
  saveAnalytics();
}

function recordMetadataAttempt({ useCookies, success, durationMs, classification }) {
  const mode = useCookies ? 'withCookies' : 'withoutCookies';
  updateCounter(analytics.metadata.attempts[mode], {
    success,
    durationMs,
    classification
  });
  addRecentEvent('metadata-attempt', {
    cookieMode: useCookies ? 'with-cookies' : 'without-cookies',
    success,
    durationMs: Math.round(durationMs),
    ...(classification ? { classification } : {})
  });
  saveAnalytics();
}

function recordMetadataPipeline({ success, durationMs, usedCookieFallback, classification }) {
  analytics.metadata.pipelines++;
  analytics.metadata.totalDurationMs += Math.max(0, Math.round(durationMs));
  if (success) analytics.metadata.successes++;
  else analytics.metadata.failures++;
  if (usedCookieFallback) analytics.metadata.cookieFallbacks++;
  addRecentEvent('metadata-pipeline', {
    success,
    durationMs: Math.round(durationMs),
    usedCookieFallback: Boolean(usedCookieFallback),
    ...(classification ? { classification } : {})
  });
  saveAnalytics();
}

function downloadCounter(useCookies, strategyKey, strategyName) {
  const mode = useCookies ? 'withCookies' : 'withoutCookies';
  const counters = analytics.downloads.attempts[mode];
  counters[strategyKey] = mergeCounter(counters[strategyKey]);
  counters[strategyKey].name = strategyName;
  return counters[strategyKey];
}

function recordDownloadAttempt({
  useCookies,
  strategyKey,
  strategyName,
  success,
  durationMs,
  bytes,
  classification
}) {
  const counter = downloadCounter(useCookies, strategyKey, strategyName);
  updateCounter(counter, { success, durationMs, bytes, classification });
  addRecentEvent('download-attempt', {
    cookieMode: useCookies ? 'with-cookies' : 'without-cookies',
    strategy: strategyKey,
    success,
    durationMs: Math.round(durationMs),
    bytes: Math.max(0, Math.round(bytes || 0)),
    ...(classification ? { classification } : {})
  });
  saveAnalytics();
}

function recordDownloadPipeline({
  success,
  durationMs,
  attemptCount,
  usedCookieFallback,
  classification
}) {
  analytics.downloads.pipelines++;
  analytics.downloads.totalDurationMs += Math.max(0, Math.round(durationMs));
  if (success) {
    analytics.downloads.successes++;
    if (attemptCount > 1) analytics.downloads.fallbackSuccesses++;
  } else {
    analytics.downloads.failures++;
  }
  if (usedCookieFallback) analytics.downloads.cookieFallbacks++;
  addRecentEvent('download-pipeline', {
    success,
    durationMs: Math.round(durationMs),
    attemptCount,
    usedCookieFallback: Boolean(usedCookieFallback),
    ...(classification ? { classification } : {})
  });
  saveAnalytics();
}

function sourceForTrack(track) {
  return track?.source || (track?.filePath ? 'library' : 'unknown');
}

function recordPlaybackStart(session, track) {
  analytics.totals.tracksStarted++;
  increment(analytics.playbackBySource, sourceForTrack(track));
  addRecentEvent('playback-start', {
    source: sourceForTrack(track),
    durationSeconds: Number(track?.duration) || null
  });
  saveAnalytics();
  session.playbackAnalyticsRecordedGeneration = null;
}

function recordPlaybackEnd(session, reason) {
  if (!session?.currentTrack || !session.trackStartedAt) return null;
  if (session.playbackAnalyticsRecordedGeneration === session.playbackGeneration) return null;

  const now = Date.now();
  const activePauseMs = session.pausedAt ? now - session.pausedAt : 0;
  const playedMs = Math.max(
    0,
    now - session.trackStartedAt - (session.pausedDurationMs || 0) - activePauseMs
  );
  const expectedMs = Math.max(0, (Number(session.currentTrack.duration) || 0) * 1000);

  session.playbackAnalyticsRecordedGeneration = session.playbackGeneration;
  analytics.totals.totalPlayedMs += Math.round(playedMs);
  analytics.totals.totalExpectedMs += Math.round(expectedMs);
  if (reason === 'completed') analytics.totals.tracksCompleted++;
  else if (reason === 'skipped') analytics.totals.tracksSkipped++;
  else if (reason === 'error') analytics.totals.playbackErrors++;
  else if (reason === 'shutdown') analytics.totals.playbackShutdowns++;
  else analytics.totals.tracksStopped++;

  addRecentEvent('playback-end', {
    reason,
    source: sourceForTrack(session.currentTrack),
    playedMs: Math.round(playedMs),
    expectedMs: Math.round(expectedMs)
  });
  saveAnalytics();
  return { playedMs, expectedMs };
}

function getAnalyticsSnapshot() {
  return JSON.parse(JSON.stringify(analytics));
}

module.exports = {
  analyticsPath,
  recordPlayRequest,
  recordPlayOutcome,
  recordCacheHit,
  recordMetadataAttempt,
  recordMetadataPipeline,
  recordDownloadAttempt,
  recordDownloadPipeline,
  recordPlaybackStart,
  recordPlaybackEnd,
  getAnalyticsSnapshot
};
