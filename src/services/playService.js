const { performance } = require('perf_hooks');
const { sanitizeTitle } = require('../utils/titleUtils');
const {
  getTrackFromCache,
  addTrackToCache
} = require('../core/musicIndex');
const {
  ensureSession
} = require('../core/sessionManager');
const { fetchMetadata } = require('../core/youtubeMetadata');
const {
  detectIfPlaylist,
  handlePlaylist
} = require('./playlistService');
const {
  getBoundVoiceTarget,
  setBoundVoiceTarget
} = require('./messageContextService');
const {
  queueTrackIntoSession
} = require('./cacheService');
const {
  downloadTrack
} = require('./downloadService');

async function handlePlayRequest(client, message, query) {
  await message.reply(`🎵 Request: ${query}`);

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

  let targetGuildId, targetChannelId;

  if (message.guild) {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('⚠️ Where you at? Nowhere. Join a voice channel first you dumb fuck');

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

  const t0 = performance.now();
  const input = /^(https?:\/\/|www\.)/i.test(query) ? query : `ytsearch1:${query}`;

  let meta;
  try {
    meta = await fetchMetadata(input);
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
    const track = cached;
    const result = queueTrackIntoSession(session, targetGuildId, track);

    if (!result.startedImmediately) {
      await message.reply(`🔄 Queued from cache: **${track.title}**`);
    }

    return message.reply(
      `⏱ meta ${(t1 - t0).toFixed(0)}ms, prep ${(t2 - t1).toFixed(0)}ms, cache 0ms`
    );
  }

  const link = url ? `\n🔗 ${url}` : 'A Problem Occured While Trying To Fetch URL';
  await message.reply(`⬇️ Downloading **${title}**${link}`);
  const dlStart = performance.now();

  try {
    const result = await downloadTrack({
      id,
      titleSan,
      url,
      filenameTemplate
    });

    const track = { id, title, titleSan, filePath: result.filePath, url };
    addTrackToCache(track);

    const queueResult = queueTrackIntoSession(session, targetGuildId, track);

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

    await message.reply(`❌ **Download failed.** (code ${e.code})`);
    if (e.stderrData) {
      await message.reply('```' + e.stderrData.slice(0, 1800) + '```');
    }
  }
}

module.exports = {
  handlePlayRequest
};