// playService.js

const { performance } = require('perf_hooks');
const { sanitizeTitle, formatTrackName } = require('../utils/titleUtils');
const {
  getTrackFromCache,
  addTrackToCache,
  listAllCachedTracksUnique
} = require('../core/musicIndex');
const { ensureSession } = require('../core/sessionManager');
const {
  classifyMetadataError,
  extractYouTubeVideoId,
  fetchMetadataWithFallback
} = require('../core/youtubeMetadata');
const { detectIfPlaylist, handlePlaylist } = require('./playlistService');
const { getBoundVoiceTarget, setBoundVoiceTarget } = require('./messageContextService');
const { queueTrackIntoSession } = require('./cacheService');
const { downloadTrack } = require('./downloadService');
const { isSpotifyPlaylistUrl, handleSpotifyPlaylist } = require('./spotifyPlaylistService');
const { indexCachedTrack, searchCachedMusic } = require('./cacheSearchService');
const { RepeatedQueryTracker } = require('./repeatedQueryService');
const {
  recordCacheHit,
  recordDownloadAttempt,
  recordDownloadPipeline,
  recordMetadataAttempt,
  recordMetadataPipeline,
  recordPlayOutcome,
  recordPlayRequest
} = require('./analyticsService');

const repeatedQueries = new RepeatedQueryTracker();
const { indexPath } = require('../core/musicIndex');
const { libraryDataFile } = require('../core/libraryPaths');
const { normalizeTrack } = require('../core/libraryMigration');
const { YouTubeMusicResolver, applyMusicMetadata } = require('../core/youtubeMusicMetadata');
const musicResolver = new YouTubeMusicResolver({
  cachePath: libraryDataFile(indexPath, 'youtube-music-cache.json')
});

async function handlePlayRequest(client, message, query) {
  const requestStartedAt = performance.now();
  const queryIsUrl = /^(https?:\/\/|www\.)/i.test(query);
  let playOutcomeRecorded = false;
  const finishPlayRequest = ({ outcome, source, reason }) => {
    if (playOutcomeRecorded) return;
    playOutcomeRecorded = true;
    recordPlayOutcome({
      outcome,
      source,
      reason,
      durationMs: performance.now() - requestStartedAt
    });
  };
  recordPlayRequest({ type: queryIsUrl ? 'url' : 'search' });
  const requester = {
    id: message.author.id,
    name: message.member?.displayName || message.author.globalName || message.author.username
  };
  let statusMessage;
  async function respond(content) {
    if (statusMessage?.edit) return statusMessage.edit({ content });
    return message.reply(content);
  }
  async function finishStatus(startedImmediately, track) {
    if (startedImmediately) {
      await statusMessage?.delete?.().catch(() => {});
    } else {
      await respond(`Added to queue · ${formatTrackName(track)}`);
    }
  }

  if (isSpotifyPlaylistUrl(query)) {
    finishPlayRequest({ outcome: 'delegated', source: 'spotify-playlist' });
    return handleSpotifyPlaylist(client, message, query);
  }

  let targetGuildId, targetChannelId;

  if (message.guild) {
    const vc = message.member?.voice?.channel;
    if (!vc) {
      finishPlayRequest({ outcome: 'failure', reason: 'no-voice-channel' });
      return message.reply('Join a voice channel first.');
    }

    targetGuildId = vc.guild.id;
    targetChannelId = vc.id;

    setBoundVoiceTarget(message.author.id, {
      guildId: targetGuildId,
      channelId: targetChannelId
    });
  } else {
    const pref = getBoundVoiceTarget(message.author.id);
    if (!pref) {
      finishPlayRequest({ outcome: 'failure', reason: 'no-bound-voice-channel' });
      return message.reply('Link a voice channel with `!bind` on the server first.');
    }

    targetGuildId = pref.guildId;
    targetChannelId = pref.channelId;
  }

  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) {
    finishPlayRequest({ outcome: 'failure', reason: 'guild-not-found' });
    return message.reply('This server isn’t available.');
  }

  const session = ensureSession(targetGuildId, targetChannelId, guild.voiceAdapterCreator);
  session.lastChannel = message.channel;
  session.autoplayClient = client;
  session.autoplayMessage = message;

  const repeatState = queryIsUrl
    ? { shouldTryYouTubeAlternative: false, excludedVideoIds: new Set() }
    : repeatedQueries.begin(message.author.id, query);

  async function useCachedTrack(cached, { meta = null, matchSource = 'exact' } = {}) {
    if (!cached.duration && meta?.duration) {
      cached.duration = meta.duration;
      addTrackToCache(cached);
    }
    const track = {
      ...cached,
      source: 'cache',
      displayTitle: cached.title,
      artist: cached.artist || null,
      uploader: meta?.uploader || cached.uploader || null,
      album: cached.album || null,
      thumbnail: meta?.thumbnail || cached.thumbnail || null,
      requester
    };
    const result = queueTrackIntoSession(session, targetGuildId, track);
    recordCacheHit({ source: matchSource });
    finishPlayRequest({ outcome: 'success', source: 'cache' });
    await finishStatus(result.startedImmediately, track);
    if (!queryIsUrl) repeatedQueries.markServed(message.author.id, query, track);
    return matchSource;
  }

  // YouTube URLs carry the stable cache key. Avoid yt-dlp entirely on an ID hit.
  const urlVideoId = queryIsUrl ? extractYouTubeVideoId(query) : null;
  if (urlVideoId) {
    const cachedById = getTrackFromCache({ id: urlVideoId });
    if (cachedById) {
      await useCachedTrack(cachedById, { matchSource: 'youtube-id' });
      return;
    }
  }

  if (/youtube\.com|youtu\.be/.test(query)) {
    try {
      const isPlaylist = await detectIfPlaylist(query);
      if (isPlaylist) {
        finishPlayRequest({ outcome: 'delegated', source: 'youtube-playlist' });
        return handlePlaylist(client, message, query);
      }
    } catch (e) {
      console.error('Playlist kontrol hatası:', e);
    }
  }

  // Retrieve and rerank local title/artist matches before searching YouTube.
  if (!queryIsUrl && !repeatState.shouldTryYouTubeAlternative) {
    try {
      const cacheSearch = await searchCachedMusic(query, listAllCachedTracksUnique());
      if (cacheSearch.track) {
        await useCachedTrack(cacheSearch.track, { matchSource: cacheSearch.source });
        return;
      }
    } catch (error) {
      // An unavailable local search index must not break normal YouTube search.
      console.warn('[Lexical Search] Falling back to YouTube:', error.message);
    }
  }

  statusMessage = await message.reply('Finding the track…');

  const t0 = performance.now();
  const input = queryIsUrl
    ? query
    : `${repeatState.shouldTryYouTubeAlternative ? 'ytsearch10' : 'ytsearch1'}:${query}`;

  let meta;
  let metadataResult;
  try {
    metadataResult = await fetchMetadataWithFallback(input, {
      excludeVideoIds: repeatState.excludedVideoIds,
      onAttempt: (attempt) => {
        recordMetadataAttempt({
          useCookies: attempt.useCookies,
          success: attempt.success,
          durationMs: attempt.durationMs,
          classification: attempt.classification
        });
      }
    });
    meta = metadataResult.metadata;
    recordMetadataPipeline({
      success: true,
      durationMs: performance.now() - t0,
      usedCookieFallback: metadataResult.usedCookieFallback
    });
  } catch (e) {
    recordMetadataPipeline({
      success: false,
      durationMs: performance.now() - t0,
      usedCookieFallback: Boolean(e.usedCookieFallback),
      classification: classifyMetadataError(e)
    });
    finishPlayRequest({ outcome: 'failure', reason: 'metadata-failed' });
    console.error('[Metadata Error]', e);
    return respond('Couldn’t find this track. Try another title or link.');
  }

  const id = meta.title;
  const title = meta.id;
  const url = meta.url;
  const titleSan = sanitizeTitle(title);
  const filenameTemplate = `${id}_${titleSan}.%(ext)s`;

  const cached = getTrackFromCache({ id, titleSan });
  if (cached) {
    await useCachedTrack(cached, { meta });
    return;
  }

  await respond('Preparing the track…');
  const dlStart = performance.now();
  const generationAtStart = session.downloadGeneration || 0;

  try {
    const result = await downloadTrack({
      id,
      titleSan,
      url,
      filenameTemplate,
      onRetry: async ({ failedAttempt }) => {
        console.warn('[Download Retry]', failedAttempt);
        await respond('Taking a little longer. Trying again…');
      },
      onAttempt: (attempt) => {
        recordDownloadAttempt({
          useCookies: attempt.useCookies,
          strategyKey: attempt.strategyKey,
          strategyName: attempt.strategy,
          success: attempt.success,
          durationMs: attempt.durationMs,
          bytes: attempt.bytes,
          classification: attempt.classification
        });
      }
    });

    recordDownloadPipeline({
      success: true,
      durationMs: performance.now() - dlStart,
      attemptCount: result.attemptHistory.length,
      usedCookieFallback: result.attemptHistory.some((attempt) => attempt.useCookies)
    });

    if ((session.downloadGeneration || 0) !== generationAtStart) {
      finishPlayRequest({ outcome: 'cancelled', reason: 'session-stopped-during-download' });
      await statusMessage?.delete?.().catch(() => {});
      return;
    }

    let libraryTrack = normalizeTrack({
      id,
      title,
      videoTitle: meta.realTitle || title,
      titleSan,
      filePath: result.filePath,
      url,
      duration: meta.duration || null,
      displayTitle: meta.realTitle || title,
      thumbnail: meta.thumbnail || null
    });
    libraryTrack = applyMusicMetadata(libraryTrack, await musicResolver.resolve(libraryTrack));
    addTrackToCache(libraryTrack);
    try {
      await indexCachedTrack(libraryTrack);
    } catch (error) {
      console.warn(
        '[Lexical Search] New track will be retried by index synchronization:',
        error.message
      );
    }

    const track = {
      ...libraryTrack,
      source: 'download',
      artist: libraryTrack.artist,
      uploader: meta.uploader || null,
      album: libraryTrack.album,
      requester
    };

    if ((session.downloadGeneration || 0) !== generationAtStart) {
      finishPlayRequest({ outcome: 'cancelled', reason: 'session-stopped-during-metadata' });
      await statusMessage?.delete?.().catch(() => {});
      return;
    }

    const queueResult = queueTrackIntoSession(session, targetGuildId, track);
    finishPlayRequest({ outcome: 'success', source: 'download' });
    if (!queryIsUrl) repeatedQueries.markServed(message.author.id, query, track);

    await finishStatus(queueResult.startedImmediately, track);
  } catch (e) {
    recordDownloadPipeline({
      success: false,
      durationMs: performance.now() - dlStart,
      attemptCount: e.attemptHistory?.length || e.attempts?.length || 0,
      usedCookieFallback: Boolean(e.attemptHistory?.some((attempt) => attempt.useCookies)),
      classification: e.classification || 'unknown'
    });
    finishPlayRequest({ outcome: 'failure', reason: 'download-failed' });
    console.error(`❌ [Download Error] yt-dlp exited with code ${e.code}`);
    console.error('----- STDERR -----');
    console.error((e.stderrData || '').trim());
    console.error('----- STDOUT -----');
    console.error((e.stdoutData || '').trim());
    console.error('------------------');

    await respond('Couldn’t play this track. Try another link.');
  }
}

module.exports = {
  handlePlayRequest
};
