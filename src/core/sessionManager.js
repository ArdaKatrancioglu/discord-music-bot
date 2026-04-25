// sessionManager.js
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');
const { shuffle } = require('../utils/titleUtils');
const { StreamType } = require('@discordjs/voice');

const sessions = new Map();      // guildId -> { connection, player, queue, currentTrack, lastChannel, repeatCache, cachePool, looping }
const userDefaultVC = new Map(); // userId  -> { guildId, channelId }

function attachPlayerEvents(guildId) {
  const session = sessions.get(guildId);
  if (!session || session._eventsAttached) return;
  session._eventsAttached = true;
  session.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
}

function ensureSession(guildId, channelId, adapterCreator) {
  let session = sessions.get(guildId);
  if (!session) {
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator
    });
    const player = createAudioPlayer();
    connection.subscribe(player);
    session = {
      connection,
      player,
      queue: [],
      currentTrack: null,
      lastChannel: null,
      repeatCache: false,
      cachePool: [],
      looping: false
    };
    sessions.set(guildId, session);
    attachPlayerEvents(guildId);
  } else if (
    session.connection.joinConfig.channelId !== channelId ||
    session.connection.joinConfig.guildId !== guildId
  ) {
    // Kanallar arası geçiş (aynı guild içinde)
    try {
      session.connection.destroy();
    } catch (_) {}
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

  if (!session.queue.length) {
    if (session.repeatCache && session.cachePool?.length) {
      session.queue = shuffle([...session.cachePool]);
    }
  }

  if (!session.queue.length && !(session.looping && session.currentTrack)) {
    session.currentTrack = null;
    if (channel?.send) {
      try {
        await channel.send('🛑 Queue is empty. Add more with !play <song or URL>');
      } catch {}
    }
    return;
  }

  let track;
  if (session.looping && session.currentTrack) {
    track = session.currentTrack;
  }
  else{
    track = session.queue.shift();
    session.currentTrack = track;
  }

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
  for (const [, s] of sessions.entries()) {
    try { s.connection?.destroy(); } catch {}
  }
}

module.exports = {
  sessions,
  userDefaultVC,
  ensureSession,
  playNext,
  destroyAllConnections
};
