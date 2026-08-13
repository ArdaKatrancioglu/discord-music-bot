const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const { findActiveLineIndex, getPlaybackPosition, parseTrackIdentity } = require('./lyricsService');

const PLAYER_CUSTOM_ID_PREFIX = 'music-player:';
const PROGRESS_SEGMENTS = 20;
const PROGRESS_UPDATE_MS = 10000;

function playerCustomId(session, action) {
  return `${PLAYER_CUSTOM_ID_PREFIX}${session.guildId}:${action}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function buildProgressBar(position, duration, segments = PROGRESS_SEGMENTS) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safePosition = Math.max(0, Number(position) || 0);
  const ratio = safeDuration ? Math.min(1, safePosition / safeDuration) : 0;
  const marker = Math.min(segments - 1, Math.floor(ratio * segments));
  const bar = Array.from({ length: segments }, (_, index) => (index === marker ? '●' : '━')).join(
    ''
  );
  const durationLabel = safeDuration ? formatDuration(safeDuration) : '--:--';
  return `${formatDuration(safePosition)}  ${bar}  ${durationLabel}`;
}

function escapeMarkdown(value) {
  return String(value || '').replace(/([\\`*_{}[\]()<>#+\-.!|])/g, '\\$1');
}

function getDisplayIdentity(track) {
  const displayTrack = {
    ...track,
    title: track?.displayTitle || track?.realTitle || track?.title
  };
  return parseTrackIdentity(displayTrack);
}

function getArtworkUrl(track) {
  if (track?.thumbnail) return track.thumbnail;
  if (!track?.url) return null;
  try {
    const url = new URL(track.url);
    let videoId = null;
    if (url.hostname === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0];
    if (url.hostname.endsWith('youtube.com')) videoId = url.searchParams.get('v');
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

function buildLyricsText(session) {
  if (!session.lyricsEnabled) return null;
  if (session.lyricsStatus === 'loading') return 'Searching for synchronized lyrics…';
  if (session.lyricsStatus !== 'synced' || !session.lyricsLines?.length) {
    return 'Synchronized lyrics are unavailable for this track.';
  }

  const activeIndex = findActiveLineIndex(session.lyricsLines, getPlaybackPosition(session));
  const center = Math.max(0, activeIndex);
  const start = Math.max(0, center - 1);
  const end = Math.min(session.lyricsLines.length - 1, center + 1);
  const rendered = [];

  for (let index = start; index <= end; index++) {
    const line = escapeMarkdown(session.lyricsLines[index].text);
    if (index === activeIndex) rendered.push(`▶ **${line}**`);
    else rendered.push(`♪ ${line}`);
  }

  return rendered.join('\n\n');
}

function getLyricsLabel(session) {
  if (!session.lyricsEnabled) return 'Off';
  if (session.lyricsStatus === 'synced') return 'Synced';
  if (session.lyricsStatus === 'loading') return 'Loading';
  return 'Unavailable';
}

function getRepeatLabel(session) {
  if (!session.looping) return 'Off';
  return session.loopQueue?.length > 1 ? 'Queue' : 'Track';
}

function buildPlayerPayload(session, { stopped = false } = {}) {
  const disabled = stopped || !session.currentTrack;
  const embed = new EmbedBuilder().setColor(disabled ? 0x747f8d : 0x5865f2);

  if (disabled) {
    embed.setTitle('⏹ Playback stopped').setDescription('The player is ready for another track.');
  } else {
    const track = session.currentTrack;
    const identity = getDisplayIdentity(track);
    const displayTitle = identity.artist
      ? `${identity.artist} — ${identity.title}`
      : identity.title || track.title || 'Unknown track';
    const linkedTitle = track.url
      ? `[${escapeMarkdown(displayTitle)}](${track.url})`
      : `**${escapeMarkdown(displayTitle)}**`;
    const description = [linkedTitle];
    if (identity.album) description.push(escapeMarkdown(identity.album));

    const lyricsText = buildLyricsText(session);
    if (lyricsText) description.push(lyricsText);

    const position = getPlaybackPosition(session);
    const progress = buildProgressBar(position, track.duration);
    const statusParts = [];
    if (Number.isFinite(Number(session.volume))) {
      statusParts.push(`🔊 Volume: ${Math.round(Number(session.volume))}%`);
    }
    statusParts.push(`Lyrics: ${getLyricsLabel(session)}`);
    statusParts.push(`🔁 Repeat: ${getRepeatLabel(session)}`);

    embed
      .setTitle('🎵 NOW PLAYING')
      .setDescription(description.join('\n\n'))
      .addFields(
        { name: '\u200b', value: progress },
        { name: '\u200b', value: statusParts.join('  •  ') }
      );
    const artworkUrl = getArtworkUrl(track);
    if (artworkUrl) embed.setThumbnail(artworkUrl);
  }

  const pauseButton = new ButtonBuilder()
    .setCustomId(playerCustomId(session, 'pause'))
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(session.isPaused ? '▶️' : '⏸️')
    .setLabel(session.isPaused ? 'Resume' : 'Pause')
    .setDisabled(disabled);

  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'previous'))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏮️')
      .setDisabled(true),
    pauseButton,
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'skip'))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏭️')
      .setDisabled(disabled)
  );

  const repeatActive = !disabled && session.looping;
  const lyricsActive = !disabled && session.lyricsEnabled;
  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'stop'))
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⏹️')
      .setLabel('Stop')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'repeat'))
      .setStyle(repeatActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setEmoji('🔁')
      .setLabel('Repeat')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'lyrics'))
      .setStyle(lyricsActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setEmoji('📜')
      .setLabel('Lyrics')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'cache'))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('💾')
      .setLabel('Cache')
      .setDisabled(!disabled)
  );

  return { embeds: [embed], components: [firstRow, secondRow] };
}

function payloadSignature(payload) {
  return JSON.stringify({
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((row) => row.toJSON())
  });
}

function isUnknownMessage(error) {
  return error?.code === 10008 || error?.rawError?.code === 10008;
}

async function writePlayerMessage(session, options = {}) {
  const expectedGeneration = options.expectedPlaybackGeneration;
  if (expectedGeneration !== undefined && expectedGeneration !== session.playbackGeneration) {
    return null;
  }

  const payload = buildPlayerPayload(session, options);
  const signature = payloadSignature(payload);
  const activeChannel = session.playerMessage?.channel || options.channel || session.lastChannel;
  const playerIsLastMessage =
    !session.playerMessage ||
    !activeChannel?.lastMessageId ||
    activeChannel.lastMessageId === session.playerMessage.id;
  if (!options.force && signature === session.playerUiSignature && playerIsLastMessage) {
    return session.playerMessage;
  }

  if (session.playerMessage && !playerIsLastMessage) {
    try {
      await session.playerMessage.delete();
      session.playerMessage = null;
      session.playerMessageId = null;
      session.playerChannelId = null;
      session.playerUiSignature = null;
    } catch (error) {
      if (isUnknownMessage(error)) {
        session.playerMessage = null;
        session.playerMessageId = null;
        session.playerChannelId = null;
        session.playerUiSignature = null;
      } else {
        console.warn('[Player UI] Could not move player message to the bottom:', error.message);
      }
    }
  }

  if (session.playerMessage) {
    try {
      const edited = await session.playerMessage.edit(payload);
      session.playerMessage = edited || session.playerMessage;
      session.playerMessageId = session.playerMessage.id;
      session.playerChannelId = session.playerMessage.channelId;
      session.playerUiSignature = signature;
      return session.playerMessage;
    } catch (error) {
      console.warn('[Player UI] Could not edit player message:', error.message);
      if (!isUnknownMessage(error)) return null;
      session.playerMessage = null;
      session.playerMessageId = null;
      session.playerChannelId = null;
    }
  }

  const channel = activeChannel || options.channel || session.lastChannel;
  if (!channel?.send) return null;
  try {
    const message = await channel.send(payload);
    session.playerMessage = message;
    session.playerMessageId = message.id;
    session.playerChannelId = message.channelId;
    session.playerUiSignature = signature;
    return message;
  } catch (error) {
    console.warn('[Player UI] Could not create player message:', error.message);
    return null;
  }
}

function requestPlayerUpdate(session, options = {}) {
  if (!session) return Promise.resolve(null);
  const previous = session.playerUiUpdateQueue || Promise.resolve();
  const update = previous.catch(() => {}).then(() => writePlayerMessage(session, options));
  session.playerUiUpdateQueue = update.catch(() => {});
  return update;
}

function startPlayerUi(session, channel) {
  if (channel) session.lastChannel = channel;
  stopPlayerUiUpdater(session);
  session.playerUiTimer = setInterval(() => {
    requestPlayerUpdate(session, {
      expectedPlaybackGeneration: session.playbackGeneration
    }).catch(() => {});
  }, PROGRESS_UPDATE_MS);
  session.playerUiTimer.unref?.();
  return requestPlayerUpdate(session, {
    force: true,
    expectedPlaybackGeneration: session.playbackGeneration,
    channel
  });
}

function stopPlayerUiUpdater(session) {
  if (session?.playerUiTimer) clearInterval(session.playerUiTimer);
  if (session) session.playerUiTimer = null;
}

async function userCanControl(interaction, session, guildId) {
  const voiceChannelId = session.connection?.joinConfig?.channelId;
  if (!voiceChannelId) return false;
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) return false;
  const member =
    guild.members.cache.get(interaction.user.id) ||
    (await guild.members.fetch(interaction.user.id).catch(() => null));
  return member?.voice?.channelId === voiceChannelId;
}

async function rejectInteraction(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function handlePlayerInteraction(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith(PLAYER_CUSTOM_ID_PREFIX)) {
    return false;
  }

  const { sessions } = require('../core/sessionManager');
  const idParts = interaction.customId.slice(PLAYER_CUSTOM_ID_PREFIX.length).split(':');
  const [guildId, action] = idParts;
  const session = guildId ? sessions.get(guildId) : null;
  if (!session) {
    await rejectInteraction(interaction, 'This player session is no longer active.');
    return true;
  }
  if (!(await userCanControl(interaction, session, guildId))) {
    await rejectInteraction(
      interaction,
      'You need to be in the same voice channel to control the player.'
    );
    return true;
  }

  await interaction.deferUpdate();
  const {
    pauseSession,
    resumeSession,
    skipSession,
    stopSession
  } = require('./sessionControlService');

  if (action === 'pause') {
    if (session.isPaused) resumeSession(session);
    else pauseSession(session);
  } else if (action === 'skip') {
    skipSession(session);
  } else if (action === 'stop') {
    const { stopPlaylistFeeder } = require('../core/playlist_feeder');
    const { stopSpotifyPlaylistFeeder } = require('./spotifyPlaylistService');
    stopPlaylistFeeder(guildId);
    stopSpotifyPlaylistFeeder(guildId);
    stopSession(session);
  } else if (action === 'repeat') {
    if (session.looping) {
      session.looping = false;
      session.loopCount = 0;
      session.loopQueue = [];
      session.loopIndex = 0;
    } else if (session.currentTrack) {
      session.looping = true;
      session.loopCount = 0;
      session.loopQueue = [session.currentTrack];
      session.loopIndex = 0;
    }
  } else if (action === 'lyrics') {
    const { disableLyrics, enableLyrics } = require('./lyricsService');
    if (session.lyricsEnabled) disableLyrics(session);
    else enableLyrics(session, session.lastChannel);
  } else if (action === 'cache') {
    const { startCachePlayback } = require('./cacheService');
    const result = await startCachePlayback(session, guildId);
    if (!result.startedImmediately) {
      await interaction.followUp({
        content:
          result.reason === 'empty'
            ? 'There are no cached tracks available.'
            : 'Stop the current track before starting cache playback.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (action === 'repeat') await requestPlayerUpdate(session, { force: true });
  return true;
}

module.exports = {
  PLAYER_CUSTOM_ID_PREFIX,
  buildPlayerPayload,
  buildProgressBar,
  formatDuration,
  handlePlayerInteraction,
  requestPlayerUpdate,
  startPlayerUi,
  stopPlayerUiUpdater
};
