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

    try {
      session.connection?.destroy();
    } catch {}
  }
}

module.exports = {
  sessions,
  userDefaultVC,
  ensureSession,
  playNext,
  destroyAllConnections
};
