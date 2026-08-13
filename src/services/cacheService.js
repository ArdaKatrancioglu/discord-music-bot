const { listAllCachedTracksUnique } = require('../core/musicIndex');
const { ensureSession, playNext, clearIdleDisconnectTimer } = require('../core/sessionManager');
const { shuffle } = require('../utils/titleUtils');
const { getBoundVoiceTarget, setBoundVoiceTarget } = require('./messageContextService');

function queueTrackIntoSession(session, guildId, track) {
  clearIdleDisconnectTimer(session);

  if (!session.currentTrack || session.isPaused) {
    session.queue.unshift(track);
    session.isPaused = false;
    playNext(guildId);
    return { startedImmediately: true };
  } else {
    session.queue.push(track);
    return { startedImmediately: false };
  }
}

async function startCachePlayback(session, guildId) {
  if (session.currentTrack) {
    return { startedImmediately: false, reason: 'playing', trackCount: 0 };
  }

  const all = listAllCachedTracksUnique();
  if (!all.length) {
    return { startedImmediately: false, reason: 'empty', trackCount: 0 };
  }

  session.cachePool = all;
  session.repeatCache = true;
  session.queue = shuffle([...all]);
  await playNext(guildId);
  return { startedImmediately: true, reason: null, trackCount: all.length };
}

async function handleCacheCommand(client, message, content) {
  const arg = content.split(/\s+/)[1]?.toLowerCase();
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
        '⚠️ No voice channel is connected yet dumbass. Join a voice channel on a server and !bind it or run !cache there. ' +
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

  if (arg === 'off') {
    session.repeatCache = false;
    session.cachePool = [];
    return message.reply('🛑 Cache loop disabled. (Queue remains the same)');
  }

  const all = listAllCachedTracksUnique();
  if (!all.length)
    return message.reply(
      'ℹ️ There are no songs in the cache to play. Play some songs to cache it bitch. Jkjk'
    );

  if (!session.currentTrack) {
    await startCachePlayback(session, targetGuildId);
    return message.reply(`🔁 Cache initialized. Number of parts: **${all.length}**`);
  } else {
    session.cachePool = all;
    session.repeatCache = true;
    session.queue = shuffle([...all]);
    return message.reply(
      `🔁 Cache (∞) is enabled. **${all.length}** tracks have been added to the queue and looping is on.`
    );
  }
}

module.exports = {
  queueTrackIntoSession,
  startCachePlayback,
  handleCacheCommand
};
