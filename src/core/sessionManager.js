const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');

const { shuffle } = require('../utils/titleUtils');
const {
  clearAutoplayTimer,
  scheduleAutoplayCheck
} = require('../services/autoplaySchedulerService');

const sessions = new Map();
const userDefaultVC = new Map();
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

function clearIdleDisconnectTimer(session) {
  if (session?.idleDisconnectTimer) {
    clearTimeout(session.idleDisconnectTimer);
    session.idleDisconnectTimer = null;
  }
}

function scheduleIdleDisconnect(guildId, session) {
  clearIdleDisconnectTimer(session);

  session.idleDisconnectTimer = setTimeout(async () => {
    const activeSession = sessions.get(guildId);
    if (!activeSession || activeSession !== session) return;
    if (activeSession.currentTrack || activeSession.queue.length > 0) return;
    if (activeSession.autoplay) return;

    try {
      await activeSession.lastChannel?.send(
        '🛑 Since ya\'ll is not doing nothin\' for 2 minutes i\'m out.'
      );
    } catch {}

    clearAutoplayTimer(activeSession);
    clearIdleDisconnectTimer(activeSession);

    try {
      activeSession.connection?.destroy();
    } catch {}

    sessions.delete(guildId);
  }, IDLE_TIMEOUT_MS);
}

async function disconnectIfChannelEmpty(guildId, guild) {
  const session = sessions.get(guildId);
  if (!session || !guild) return false;

  const channelId = session.connection?.joinConfig?.channelId;
  if (!channelId) return false;

  const voiceChannel = guild.channels?.cache?.get(channelId);
  if (!voiceChannel?.members) return false;

  const nonBotMembers = voiceChannel.members.filter((member) => !member.user?.bot);
  if (nonBotMembers.size > 0) return false;

  clearAutoplayTimer(session);
  clearIdleDisconnectTimer(session);

  try {
    session.player.stop();
  } catch {}

  try {
    await session.lastChannel?.send('👋 Ses kanalında kimse kalmadığı için kanaldan çıktım.');
  } catch {}

  try {
    session.connection?.destroy();
  } catch {}

  sessions.delete(guildId);
  return true;
}

function attachPlayerEvents(guildId) {
  const session = sessions.get(guildId);
  if (!session || session._eventsAttached) return;

  session._eventsAttached = true;
  session.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
}

function createSession(guildId, channelId, adapterCreator) {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session = {
    connection,
    player,

    queue: [],
    currentTrack: null,
    lastChannel: null,

    repeatCache: false,
    cachePool: [],

    looping: false,
    loopCount: 0,
    loopQueue: [],
    loopIndex: 0,

    downloadGeneration: 0,

    autoplay: false,
    autoplayInProgress: false,
    autoplayLookaheadSeconds: 60,
    autoplayTimer: null,
    autoplayClient: null,
    autoplayMessage: null,
    lastAutoplayReferenceTrack: null,
    trackStartedAt: null,
    idleDisconnectTimer: null,

    recentHistory: [],
    recentHistoryLimit: 5
  };

  sessions.set(guildId, session);
  attachPlayerEvents(guildId);

  return session;
}

function ensureSession(guildId, channelId, adapterCreator) {
  let session = sessions.get(guildId);

  if (!session) {
    return createSession(guildId, channelId, adapterCreator);
  }

  if (
    session.connection.joinConfig.channelId !== channelId ||
    session.connection.joinConfig.guildId !== guildId
  ) {
    try {
      session.connection.destroy();
    } catch {}

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator
    });

    connection.subscribe(session.player);
    session.connection = connection;
  }

  return session;
}

async function playNext(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;

  const channel = session.lastChannel;
  clearIdleDisconnectTimer(session);

  if (!session.queue.length && session.repeatCache && session.cachePool?.length) {
    session.queue = shuffle([...session.cachePool]);
  }

  if (!session.queue.length && !(session.looping && session.currentTrack)) {
    session.currentTrack = null;
    clearAutoplayTimer(session);

    if (channel?.send) {
      try {
        await channel.send('🛑 Queue is empty. Add more with !play <song or URL>');
      } catch {}
    }

    scheduleIdleDisconnect(guildId, session);
    return;
  }

  let track;

  if (session.looping && session.currentTrack && session.loopQueue.length) {
    session.loopIndex = (session.loopIndex + 1) % session.loopQueue.length;
    track = session.loopQueue[session.loopIndex];
  } else {
    track = session.queue.shift();
  }

  if (!track) return;

  session.currentTrack = track;
  session.trackStartedAt = Date.now();
  session.lastAutoplayReferenceTrack = track;

  if (track?.url) {
    const limit = session.recentHistoryLimit || 5;

    session.recentHistory = [
      track,
      ...(session.recentHistory || []).filter((t) => {
        if (!t) return false;
        if (track.url && t.url === track.url) return false;
        if (track.id && t.id === track.id) return false;
        return true;
      })
    ].slice(0, limit);
  }

  clearAutoplayTimer(session);

  scheduleAutoplayCheck(session.autoplayClient, session.autoplayMessage, guildId, session);

  if (channel?.send) {
    try {
      const link = track.url ? `\n🔗 ${track.url}` : '';
      await channel.send(`▶️ Now playing: **${track.title}**${link}`);
    } catch {}
  }

  const isWebm = track.filePath.endsWith('.webm');

  session.player.play(
    createAudioResource(track.filePath, {
      inputType: isWebm ? StreamType.WebmOpus : StreamType.Arbitrary
    })
  );
}

function destroyAllConnections() {
  for (const [, session] of sessions.entries()) {
    clearAutoplayTimer(session);
    clearIdleDisconnectTimer(session);

    try {
      session.connection?.destroy();
    } catch {}
  }

  sessions.clear();
}

module.exports = {
  sessions,
  userDefaultVC,
  ensureSession,
  playNext,
  destroyAllConnections,
  clearIdleDisconnectTimer,
  disconnectIfChannelEmpty
};
