// playService.js

const { performance } = require('perf_hooks');
const { MessageFlags } = require('discord.js');
const { sanitizeTitle } = require('../utils/titleUtils');
const {
  getTrackFromCache,
  addTrackToCache,
  listAllCachedTracksUnique
} = require('../core/musicIndex');
const { ensureSession } = require('../core/sessionManager');
const { extractYouTubeVideoId, fetchMetadata } = require('../core/youtubeMetadata');
const { detectIfPlaylist, handlePlaylist } = require('./playlistService');
const { getBoundVoiceTarget, setBoundVoiceTarget } = require('./messageContextService');
const { queueTrackIntoSession } = require('./cacheService');
const { downloadTrack } = require('./downloadService');
const { isSpotifyPlaylistUrl, handleSpotifyPlaylist } = require('./spotifyPlaylistService');
const { scheduleTrackEmbedding, searchCachedMusic } = require('./cacheSearchService');
const { RepeatedQueryTracker } = require('./repeatedQueryService');

const repeatedQueries = new RepeatedQueryTracker();

async function handlePlayRequest(client, message, query) {
  const queryIsUrl = /^(https?:\/\/|www\.)/i.test(query);
  const requester = {
    id: message.author.id,
    name: message.member?.displayName || message.author.globalName || message.author.username
  };
  await message.reply(
    queryIsUrl
      ? { content: `🎵 Request: <${query}>`, flags: MessageFlags.SuppressEmbeds }
      : `🎵 Request: ${query}`
  );

  if (isSpotifyPlaylistUrl(query)) {
    return handleSpotifyPlaylist(client, message, query);
  }

  let targetGuildId, targetChannelId;

  if (message.guild) {
    const vc = message.member?.voice?.channel;
    if (!vc)
      return message.reply('⚠️ Where you at? Nowhere. Join a voice channel first you dumb fuck');

    targetGuildId = vc.guild.id;
    targetChannelId = vc.id;

    setBoundVoiceTarget(message.author.id, {
      guildId: targetGuildId,
      channelId: targetChannelId
    });
  } else {
    const pref = getBoundVoiceTarget(message.author.id);
    if (!pref) {
      return message.reply(
        '⚠️ No voice channel is connected yet. Join a voice channel on a server and !bind it or run !play there. ' +
          '(Alternative: !use <guildId> <channelId> in DM)'
      );
    }

    targetGuildId = pref.guildId;
    targetChannelId = pref.channelId;
  }

  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) return message.reply('❌ Server not found (bot must be on that server).');

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
      displayTitle: meta?.realTitle || cached.displayTitle || cached.title,
      artist: meta?.artist || cached.artist || null,
      uploader: meta?.uploader || cached.uploader || null,
      album: meta?.album || cached.album || null,
      thumbnail: meta?.thumbnail || cached.thumbnail || null,
      requester
    };
    const result = queueTrackIntoSession(session, targetGuildId, track);
    if (!result.startedImmediately) {
      await message.reply(`🔄 Queued from cache: **${track.title}**`);
    }
    if (!queryIsUrl) repeatedQueries.markServed(message.author.id, query, track);
    return matchSource;
  }

  // YouTube URLs carry the stable cache key. Avoid yt-dlp entirely on an ID hit.
  const urlVideoId = queryIsUrl ? extractYouTubeVideoId(query) : null;
  if (urlVideoId) {
    const cachedById = getTrackFromCache({ id: urlVideoId });
    if (cachedById) {
      await useCachedTrack(cachedById, { matchSource: 'youtube-id' });
      return message.reply('⏱ cache 0ms (YouTube ID match)');
    }
  }

  if (/youtube\.com|youtu\.be/.test(query)) {
    try {
      const isPlaylist = await detectIfPlaylist(query);
      if (isPlaylist) {
        await message.reply('📃 Playlist algılandı. Playlist moduna geçiyorum...');
        return handlePlaylist(client, message, query);
      }
    } catch (e) {
      console.error('Playlist kontrol hatası:', e);
    }
  }

  // For text queries, retain cheap high-confidence keyword matching and only
  // embed the query when that does not find a cached track.
  if (!queryIsUrl && !repeatState.shouldTryYouTubeAlternative) {
    try {
      const cacheSearch = await searchCachedMusic(query, listAllCachedTracksUnique());
      if (cacheSearch.track) {
        await useCachedTrack(cacheSearch.track, { matchSource: cacheSearch.source });
        const score = cacheSearch.score == null ? '' : `, score ${cacheSearch.score.toFixed(3)}`;
        return message.reply(`⏱ cache hit (${cacheSearch.source}${score})`);
      }
    } catch (error) {
      // A missing/unavailable local model should not break normal YouTube search.
      console.warn('[Semantic Search] Falling back to YouTube:', error.message);
    }
  }

  if (repeatState.shouldTryYouTubeAlternative) {
    await message.reply('🔄 Same query again — trying a different YouTube result this time.');
  }

  const t0 = performance.now();
  const input = queryIsUrl
    ? query
    : `${repeatState.shouldTryYouTubeAlternative ? 'ytsearch10' : 'ytsearch1'}:${query}`;

  let meta;
  try {
    meta = await fetchMetadata(input, {
      excludeVideoIds: repeatState.excludedVideoIds
    });
  } catch (e) {
    return message.reply('⚠️ Metadata error: ' + e.message);
  }
  const t1 = performance.now();

  const id = meta.title;
  const title = meta.id;
  const url = meta.url;
  const titleSan = sanitizeTitle(title);
  const filenameTemplate = `${id}_${titleSan}.%(ext)s`;
  const t2 = performance.now();

  const cached = getTrackFromCache({ id, titleSan });
  if (cached) {
    await useCachedTrack(cached, { meta });
    return message.reply(
      `⏱ meta ${(t1 - t0).toFixed(0)}ms, prep ${(t2 - t1).toFixed(0)}ms, cache 0ms`
    );
  }

  const downloadTitle = meta.realTitle || title;
  const linkedTitle = url ? `[${downloadTitle}](${url})` : `**${downloadTitle}**`;
  await message.reply({
    content: `⬇️ Downloading ${linkedTitle}`,
    flags: MessageFlags.SuppressEmbeds
  });
  const dlStart = performance.now();
  const generationAtStart = session.downloadGeneration || 0;

  try {
    const result = await downloadTrack({
      id,
      titleSan,
      url,
      filenameTemplate,
      onRetry: async ({ failedAttempt, nextStrategy, attemptNumber }) => {
        await message.reply(
          `⚠️ Download attempt failed (${failedAttempt.classification}). ` +
            `Trying recovery #${attemptNumber}: **${nextStrategy}**…`
        );
      }
    });

    if ((session.downloadGeneration || 0) !== generationAtStart) {
      return;
    }

    const libraryTrack = {
      id,
      title,
      titleSan,
      filePath: result.filePath,
      url,
      duration: meta.duration || null,
      displayTitle: meta.realTitle || title,
      thumbnail: meta.thumbnail || null
    };
    addTrackToCache(libraryTrack);
    try {
      await scheduleTrackEmbedding(libraryTrack);
    } catch (error) {
      console.warn('[Embeddings] New track will be retried by backfill:', error.message);
    }

    const track = {
      ...libraryTrack,
      artist: meta.artist || null,
      uploader: meta.uploader || null,
      album: meta.album || null,
      requester
    };

    const queueResult = queueTrackIntoSession(session, targetGuildId, track);
    if (!queryIsUrl) repeatedQueries.markServed(message.author.id, query, track);

    if (!queueResult.startedImmediately) {
      await message.reply(`🔄 Queued: **${track.title}**`);
    }

    const dlEnd = performance.now();
    const t4 = performance.now();

    await message.reply(
      `⏱ meta ${(t1 - t0).toFixed(0)}ms, ` +
        `prep ${(t2 - t1).toFixed(0)}ms, ` +
        `download ${(dlEnd - dlStart).toFixed(0)}ms, ` +
        `total ${(t4 - t0).toFixed(0)}ms`
    );
  } catch (e) {
    console.error(`❌ [Download Error] yt-dlp exited with code ${e.code}`);
    console.error('----- STDERR -----');
    console.error((e.stderrData || '').trim());
    console.error('----- STDOUT -----');
    console.error((e.stdoutData || '').trim());
    console.error('------------------');

    const classification = e.classification ? `, ${e.classification}` : '';
    await message.reply(
      `❌ **Download failed after recovery attempts.** (code ${e.code}${classification})`
    );
    if (e.stderrData) {
      await message.reply('```' + e.stderrData.slice(0, 1800) + '```');
    }
  }
}

module.exports = {
  handlePlayRequest
};
