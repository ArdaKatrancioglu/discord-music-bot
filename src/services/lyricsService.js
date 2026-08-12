const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SLEEP_MS = 30000;
const MIN_REQUEST_GAP_MS = 250;
const { getTrackFromCache, updateTrackLyrics } = require('../core/musicIndex');

const lyricsCache = new Map();
// Detailed lyrics diagnostics stay disabled during normal operation.
const debugLog = () => {};
let lrclibRequestQueue = Promise.resolve();
let lastRequestStartedAt = 0;
let rateLimitUntil = 0;

function waitFor(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('LRCLIB request aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('LRCLIB request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function scheduleLrclibRequest(request, signal) {
  const previousRequest = lrclibRequestQueue.catch(() => {});
  let releaseQueue;
  lrclibRequestQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previousRequest;
  try {
    const normalGap = lastRequestStartedAt + MIN_REQUEST_GAP_MS - Date.now();
    const rateLimitGap = rateLimitUntil - Date.now();
    await waitFor(Math.max(0, normalGap, rateLimitGap), signal);
    lastRequestStartedAt = Date.now();
    return await request();
  } finally {
    releaseQueue();
  }
}

function rememberRateLimit(response) {
  if (response.status !== 429) return;
  const retryAfter = response.headers?.get?.('retry-after');
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds)) {
    rateLimitUntil = Date.now() + Math.max(0, retryAfterSeconds * 1000);
    console.warn(
      `[Lyrics] LRCLIB rate limit received; pausing requests for ${retryAfterSeconds}s.`
    );
  }
}

function formatSeconds(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}s` : 'unknown';
}

function trackLabel(track) {
  return `${track?.title || 'unknown track'} (${track?.id || track?.url || 'no id'})`;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*(official|audio|video|lyrics?|visuali[sz]er|hq|hd|4k)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*(official|audio|video|lyrics?|visuali[sz]er|hq|hd|4k)[^\]]*\]/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseTrackIdentity(track) {
  let title = String(track?.title || '').trim();
  const explicitArtist = String(track?.artist || '').trim();
  let artist = String(explicitArtist || track?.uploader || '')
    .replace(/\s+-\s+Topic$/i, '')
    .trim();

  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length > 1) {
    const inferredArtist = parts[0].trim();
    const normalizedArtist = normalize(artist).replace(/\s/g, '');
    const normalizedInferredArtist = normalize(inferredArtist).replace(/\s/g, '');
    if (
      !explicitArtist ||
      normalizedArtist.includes(normalizedInferredArtist) ||
      normalizedInferredArtist.includes(normalizedArtist)
    ) {
      artist = parts.shift().trim();
    }
    if (normalize(artist) === normalize(parts[0])) parts.shift();
    title = parts.join(' - ').trim() || title;
  }

  title = title
    .replace(
      /\s*[([][^\])]*(official\s*)?(music\s*)?(video|audio|lyrics?|visuali[sz]er|hq|hd|4k)[^\])]*[)\]]\s*/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    artist,
    album: String(track?.album || '').trim(),
    duration: Number(track?.duration) || null
  };
}

function parseLrc(input) {
  if (typeof input !== 'string') return [];

  const lines = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!timestamps.length) continue;

    const text = rawLine.replace(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g, '').trim();
    if (!text) continue;

    for (const match of timestamps) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const timestamp = minutes * 60 + seconds;
      if (!Number.isFinite(timestamp) || seconds >= 60) continue;
      lines.push({ timestamp, text });
    }
  }

  return lines.sort((a, b) => a.timestamp - b.timestamp);
}

function tokenSimilarity(left, right) {
  const a = new Set(normalize(left).split(' ').filter(Boolean));
  const b = new Set(normalize(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

function getScoreDetails(result, identity) {
  const titleScore = tokenSimilarity(result.trackName, identity.title) * 60;
  const artistScore = identity.artist
    ? tokenSimilarity(result.artistName, identity.artist) * 35
    : 0;
  const albumScore = identity.album ? tokenSimilarity(result.albumName, identity.album) * 10 : 0;
  let durationScore = 0;
  let durationDifference = null;

  if (identity.duration && Number.isFinite(Number(result.duration))) {
    durationDifference = Math.abs(Number(result.duration) - identity.duration);
    if (durationDifference <= 3) durationScore = 55;
    else if (durationDifference <= 8) durationScore = 30;
    else if (durationDifference <= 15) durationScore = 10;
    else durationScore = -Math.min(40, durationDifference);
  }

  return {
    titleScore,
    artistScore,
    albumScore,
    durationScore,
    durationDifference,
    total: titleScore + artistScore + albumScore + durationScore
  };
}

function scoreResult(result, identity) {
  return getScoreDetails(result, identity).total;
}

function logSearchResults(results, identity) {
  if (!Array.isArray(results)) {
    console.warn('[Lyrics] Malformed LRCLIB response: expected an array.', {
      receivedType: typeof results
    });
    return;
  }

  debugLog(`[Lyrics] LRCLIB returned ${results.length} candidate(s).`);
  results.forEach((result, index) => {
    const details = getScoreDetails(result || {}, identity);
    debugLog(`[Lyrics] Candidate #${index + 1}`, {
      id: result?.id ?? null,
      trackName: result?.trackName ?? null,
      artistName: result?.artistName ?? null,
      albumName: result?.albumName ?? null,
      duration: result?.duration ?? null,
      durationDifference:
        details.durationDifference === null ? null : Number(details.durationDifference.toFixed(2)),
      hasSyncedLyrics: Boolean(result?.syncedLyrics?.trim()),
      hasPlainLyrics: Boolean(result?.plainLyrics?.trim()),
      score: Number(details.total.toFixed(2)),
      scoreBreakdown: {
        title: Number(details.titleScore.toFixed(2)),
        artist: Number(details.artistScore.toFixed(2)),
        album: Number(details.albumScore.toFixed(2)),
        duration: Number(details.durationScore.toFixed(2))
      }
    });
  });
}

function selectBestResult(results, identity) {
  if (!Array.isArray(results)) return null;
  return (
    results
      .filter((result) => result && typeof result.syncedLyrics === 'string')
      .filter((result) => result.syncedLyrics.trim())
      .sort((a, b) => scoreResult(b, identity) - scoreResult(a, identity))[0] || null
  );
}

function cacheKey(identity) {
  return [
    normalize(identity.artist),
    normalize(identity.title),
    Math.round(identity.duration || 0)
  ].join('|');
}

function readPersistentLyrics(track) {
  const libraryTrack = getTrackFromCache({ id: track?.id, titleSan: track?.titleSan });
  const cached = libraryTrack?.lyrics;

  if (!cached) return { hit: false, libraryTrack };

  if (cached.status === 'not_found') {
    debugLog(`[Lyrics Cache] Persistent not_found hit for track ${libraryTrack.id}.`);
    return { hit: true, lines: null, libraryTrack };
  }

  if (cached.status === 'found' && Array.isArray(cached.syncedLyrics)) {
    const lines = cached.syncedLyrics
      .filter((line) => Number.isFinite(Number(line?.time)) && typeof line?.text === 'string')
      .map((line) => ({ timestamp: Number(line.time), text: line.text }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (lines.length) {
      debugLog(
        `[Lyrics Cache] Persistent found hit for track ${libraryTrack.id}: ${lines.length} line(s).`
      );
      return { hit: true, lines, libraryTrack };
    }
  }

  console.warn(`[Lyrics Cache] Invalid lyrics cache for track ${libraryTrack.id}; refreshing it.`);
  return { hit: false, libraryTrack };
}

function writePersistentLyrics(libraryTrack, lines) {
  if (!libraryTrack?.id) {
    console.warn('[Lyrics Cache] No matching library record; persistent cache write skipped.');
    return;
  }

  let lyrics;
  if (lines) {
    lyrics = {
      source: 'lrclib',
      status: 'found',
      syncedLyrics: lines.map((line) => ({ time: line.timestamp, text: line.text }))
    };
  } else {
    lyrics = {
      source: 'lrclib',
      status: 'not_found'
    };
  }

  updateTrackLyrics(libraryTrack.id, lyrics);
}

async function fetchSyncedLyrics(track, signal) {
  const identity = parseTrackIdentity(track);
  const key = cacheKey(identity);
  debugLog('[Lyrics] Track metadata resolved for search:', {
    sourceTrack: trackLabel(track),
    rawTitle: track?.title || null,
    rawArtist: track?.artist || null,
    rawUploader: track?.uploader || null,
    rawAlbum: track?.album || null,
    rawDuration: track?.duration || null,
    searchIdentity: identity,
    cacheKey: key
  });

  const persistent = readPersistentLyrics(track);
  if (persistent.hit) {
    lyricsCache.set(key, persistent.lines);
    return persistent.lines;
  }

  if (lyricsCache.has(key)) {
    const cached = lyricsCache.get(key);
    debugLog(
      `[Lyrics] Cache hit: ${cached ? `${cached.length} parsed line(s)` : 'no synced lyrics'}`
    );
    return cached;
  }

  const search = async (searchIdentity, label) => {
    const url = new URL(LRCLIB_SEARCH_URL);
    if (searchIdentity.query) {
      url.searchParams.set('q', searchIdentity.query);
    } else {
      url.searchParams.set('track_name', searchIdentity.title);
      if (searchIdentity.artist) url.searchParams.set('artist_name', searchIdentity.artist);
      if (searchIdentity.album) url.searchParams.set('album_name', searchIdentity.album);
    }

    debugLog(`[Lyrics] Queued LRCLIB request (${label}):`, url.toString());
    const response = await scheduleLrclibRequest(async () => {
      debugLog(`[Lyrics] Requesting LRCLIB (${label}):`, url.toString());
      const requestStartedAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const result = await fetch(url, {
        signal: combinedSignal,
        headers: {
          'User-Agent': 'discordmusicbot/1.0.0 (Discord music bot; LRCLIB lyrics integration)'
        }
      });

      debugLog(
        `[Lyrics] LRCLIB ${label} search responded HTTP ${result.status} in ${Date.now() - requestStartedAt}ms.`
      );
      rememberRateLimit(result);
      return result;
    }, signal);

    if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}`);
    return response.json();
  };

  let body = await search(identity, 'metadata');
  if (Array.isArray(body) && body.length === 0 && identity.artist) {
    const fallbackQuery = `${identity.artist} - ${identity.title}`;
    debugLog('[Lyrics] Metadata search returned no candidates; trying keyword fallback.', {
      fallbackQuery
    });
    body = await search({ query: fallbackQuery }, 'keyword fallback');
  }

  logSearchResults(body, identity);
  const match = selectBestResult(body, identity);
  const lines = match ? parseLrc(match.syncedLyrics) : [];

  if (!match) {
    const plainOnlyCount = Array.isArray(body)
      ? body.filter((item) => item?.plainLyrics?.trim() && !item?.syncedLyrics?.trim()).length
      : 0;
    console.warn('[Lyrics] No candidate with syncedLyrics was found.', {
      totalCandidates: Array.isArray(body) ? body.length : 0,
      plainLyricsOnlyCandidates: plainOnlyCount
    });
  } else if (!lines.length) {
    console.warn(
      '[Lyrics] Selected candidate had syncedLyrics, but no valid LRC lines were parsed.',
      {
        selectedId: match.id ?? null,
        trackName: match.trackName,
        artistName: match.artistName,
        duration: match.duration
      }
    );
  } else {
    debugLog('[Lyrics] Selected LRCLIB candidate:', {
      id: match.id ?? null,
      trackName: match.trackName,
      artistName: match.artistName,
      albumName: match.albumName,
      duration: match.duration,
      score: Number(scoreResult(match, identity).toFixed(2)),
      parsedLines: lines.length,
      firstTimestamp: formatSeconds(lines[0].timestamp),
      lastTimestamp: formatSeconds(lines.at(-1).timestamp)
    });
  }

  const result = lines.length ? lines : null;
  lyricsCache.set(key, result);
  writePersistentLyrics(persistent.libraryTrack, result);
  debugLog(`[Lyrics] Cached search result: ${result ? `${result.length} line(s)` : 'not found'}.`);
  return result;
}

function getPlaybackPosition(session) {
  const playbackDuration = session?.player?.state?.resource?.playbackDuration;
  if (Number.isFinite(playbackDuration)) return Math.max(0, playbackDuration / 1000);

  if (!session?.trackStartedAt) return 0;
  const pausedAt = session.isPaused && session.pausedAt ? session.pausedAt : Date.now();
  return Math.max(0, (pausedAt - session.trackStartedAt - (session.pausedDurationMs || 0)) / 1000);
}

function findActiveLineIndex(lines, position) {
  let low = 0;
  let high = lines.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].timestamp <= position) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function abortableWait(session, generation, milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (session.lyricsWake === finish && session.lyricsGeneration === generation) {
        session.lyricsWake = null;
      }
      resolve();
    };
    const timer = setTimeout(finish, Math.max(10, Math.min(milliseconds, MAX_SLEEP_MS)));
    session.lyricsWake = finish;
    signal.addEventListener('abort', finish, { once: true });
  });
}

function isWorkerCurrent(session, track, playbackGeneration, lyricsGeneration) {
  return (
    session.lyricsEnabled &&
    session.currentTrack === track &&
    session.playbackGeneration === playbackGeneration &&
    session.lyricsGeneration === lyricsGeneration
  );
}

function stopLyricsWorker(session) {
  if (!session) return;
  const hadActiveWorker = Boolean(session.lyricsAbortController || session.lyricsTask);
  session.lyricsGeneration = (session.lyricsGeneration || 0) + 1;
  session.lyricsAbortController?.abort();
  session.lyricsAbortController = null;
  session.lyricsWake?.();
  session.lyricsWake = null;
  session.lyricsTask = null;
  if (hadActiveWorker) {
    debugLog(`[Lyrics] Worker cancelled. New lyrics generation: ${session.lyricsGeneration}.`);
  }
}

function wakeLyricsWorker(session) {
  session?.lyricsWake?.();
}

async function runLyricsWorker(session, track, playbackGeneration, lyricsGeneration, signal) {
  let lines;
  try {
    lines = await fetchSyncedLyrics(track, signal);
  } catch (error) {
    if (signal.aborted) {
      debugLog(`[Lyrics] LRCLIB request/worker aborted for ${trackLabel(track)}.`);
      return;
    }
    if (!isWorkerCurrent(session, track, playbackGeneration, lyricsGeneration)) {
      debugLog(`[Lyrics] Ignoring stale LRCLIB result for ${trackLabel(track)}.`);
      return;
    }
    console.warn('[Lyrics] LRCLIB request failed:', error.message);
    try {
      await session.lyricsChannel?.send('Lyrics alınırken bir hata oluştu.');
    } catch {
      // Lyrics is optional; Discord send failures must not affect playback.
    }
    return;
  }

  if (!isWorkerCurrent(session, track, playbackGeneration, lyricsGeneration)) {
    debugLog(`[Lyrics] Ignoring fetched lyrics because playback changed: ${trackLabel(track)}.`);
    return;
  }
  if (!lines) {
    console.warn(`[Lyrics] Giving up for ${trackLabel(track)}: no synchronized lyrics available.`);
    try {
      await session.lyricsChannel?.send('Bu şarkı için senkronize lyrics bulunamadı.');
    } catch {
      // Lyrics is optional; Discord send failures must not affect playback.
    }
    return;
  }

  let lastSentIndex = -1;
  debugLog('[Lyrics] Synchronization started.', {
    track: trackLabel(track),
    playbackGeneration,
    lyricsGeneration,
    currentPosition: formatSeconds(getPlaybackPosition(session)),
    lineCount: lines.length
  });
  while (isWorkerCurrent(session, track, playbackGeneration, lyricsGeneration) && !signal.aborted) {
    const position = getPlaybackPosition(session);
    const activeIndex = findActiveLineIndex(lines, position);

    if (activeIndex !== lastSentIndex) {
      lastSentIndex = activeIndex;
      if (activeIndex >= 0) {
        debugLog('[Lyrics] Sending synchronized line.', {
          lineIndex: activeIndex,
          lineTimestamp: formatSeconds(lines[activeIndex].timestamp),
          playbackPosition: formatSeconds(position),
          delay: formatSeconds(position - lines[activeIndex].timestamp)
        });
        try {
          await session.lyricsChannel?.send(`♪ ${lines[activeIndex].text}`);
        } catch (error) {
          console.warn('[Lyrics] Could not send lyrics line:', error.message);
        }
      }
    }

    if (lastSentIndex >= lines.length - 1) return;
    const nextIndex = Math.max(0, lastSentIndex + 1);
    const delayMs = session.isPaused
      ? MAX_SLEEP_MS
      : Math.max(10, (lines[nextIndex].timestamp - getPlaybackPosition(session)) * 1000);
    await abortableWait(session, lyricsGeneration, delayMs, signal);
  }
}

function startLyricsWorker(session) {
  if (!session?.lyricsEnabled || !session.currentTrack) return;
  stopLyricsWorker(session);

  const track = session.currentTrack;
  const playbackGeneration = session.playbackGeneration;
  const lyricsGeneration = session.lyricsGeneration;
  const controller = new AbortController();
  debugLog('[Lyrics] Starting worker.', {
    track: trackLabel(track),
    playbackGeneration,
    lyricsGeneration,
    playbackPosition: formatSeconds(getPlaybackPosition(session))
  });
  session.lyricsAbortController = controller;
  session.lyricsTask = runLyricsWorker(
    session,
    track,
    playbackGeneration,
    lyricsGeneration,
    controller.signal
  ).finally(() => {
    if (session.lyricsGeneration === lyricsGeneration) session.lyricsTask = null;
  });
}

function enableLyrics(session, channel) {
  debugLog(`[Lyrics] Enabled for ${trackLabel(session?.currentTrack)}.`);
  session.lyricsEnabled = true;
  session.lyricsChannel = channel;
  startLyricsWorker(session);
}

function disableLyrics(session) {
  debugLog(`[Lyrics] Disabled for ${trackLabel(session?.currentTrack)}.`);
  session.lyricsEnabled = false;
  stopLyricsWorker(session);
}

module.exports = {
  disableLyrics,
  enableLyrics,
  findActiveLineIndex,
  getPlaybackPosition,
  parseLrc,
  parseTrackIdentity,
  selectBestResult,
  startLyricsWorker,
  stopLyricsWorker,
  wakeLyricsWorker
};
