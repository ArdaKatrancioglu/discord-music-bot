const { listAllCachedTracksUnique } = require('../core/musicIndex');
const { ensureSession, playNext, clearIdleDisconnectTimer } = require('../core/sessionManager');
const { shuffle } = require('../utils/titleUtils');
const { getBoundVoiceTarget, setBoundVoiceTarget } = require('./messageContextService');
const { recordPlaybackEnd } = require('./analyticsService');

function queueTrackIntoSession(session, guildId, track) {
  clearIdleDisconnectTimer(session);

  if (!session.currentTrack || session.isPaused) {
    if (session.currentTrack && session.isPaused) recordPlaybackEnd(session, 'stopped');
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

  session.autoplay = false;
  require('./autoplaySchedulerService').clearAutoplayTimer(session);
  session.cachePool = all.map((track) => ({ ...track, source: 'cache' }));
  session.repeatCache = true;
  session.queue = shuffle([...session.cachePool]);
  await playNext(guildId);
  return { startedImmediately: true, reason: null, trackCount: all.length };
}

async function handleCacheCommand(client, message, content) {
  const arg = content.split(/\s+/)[1]?.toLowerCase();
  let targetGuildId, targetChannelId;

  if (message.guild) {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('Join a voice channel first.');

    targetGuildId = vc.guild.id;
    targetChannelId = vc.id;

    setBoundVoiceTarget(message.author.id, {
      guildId: targetGuildId,
      channelId: targetChannelId
    });
  } else {
    const pref = getBoundVoiceTarget(message.author.id);
    if (!pref) {
      return message.reply('Link a voice channel with `!bind` on the server first.');
    }
    targetGuildId = pref.guildId;
    targetChannelId = pref.channelId;
  }

  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) return message.reply('This server isn’t available.');

  const session = ensureSession(targetGuildId, targetChannelId, guild.voiceAdapterCreator);
  session.lastChannel = message.channel;
  session.autoplayClient = client;
  session.autoplayMessage = message;

  if (arg === 'off') {
    session.repeatCache = false;
    session.cachePool = [];
    return message.reply('Library shuffle off.');
  }

  const all = listAllCachedTracksUnique();
  if (!all.length) return message.reply('The library is empty. Play a song to add it.');

  if (!session.currentTrack) {
    await startCachePlayback(session, targetGuildId);
    return message.reply('Shuffling the library.');
  } else {
    session.autoplay = false;
    require('./autoplaySchedulerService').clearAutoplayTimer(session);
    session.cachePool = all.map((track) => ({ ...track, source: 'cache' }));
    session.repeatCache = true;
    session.queue = shuffle([...session.cachePool]);
    return message.reply('Shuffling the library.');
  }
}

module.exports = {
  queueTrackIntoSession,
  startCachePlayback,
  handleCacheCommand
};
