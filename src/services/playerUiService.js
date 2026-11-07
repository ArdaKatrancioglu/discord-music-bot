const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const {
  findActiveLineIndex,
  getLyricsPosition,
  getPlaybackPosition,
  parseTrackIdentity
} = require('./lyricsService');
const { formatTrackName: formatDisplayName } = require('../utils/titleUtils');

const PLAYER_CUSTOM_ID_PREFIX = 'music-player:';
const PROGRESS_SEGMENTS = 20;
const PLAYER_UPDATE_WHEN_LAST_MS = 3000;
const PLAYER_UPDATE_WHEN_NOT_LAST_MS = 10000;

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
  const bar = Array.from({ length: segments }, (_, index) => (index === marker ? '●' : '─')).join(
    ''
  );
  const durationLabel = safeDuration ? formatDuration(safeDuration) : '--:--';
  return `${formatDuration(safePosition)}  ${bar}  ${durationLabel}`;
}

function escapeMarkdown(value) {
  return String(value || '').replace(/([\\`*_{}[\]<>|~])/g, '\\$1');
}

function getDisplayIdentity(track) {
  if (track?.videoTitle !== undefined) return track;
  const displayTrack = {
    ...track,
    title:
      track?.videoTitle !== undefined
        ? track?.title
        : track?.displayTitle || track?.realTitle || track?.title
  };
  return parseTrackIdentity(displayTrack);
}

function getArtworkUrl(track) {
  if (track?.artworkUrl) return track.artworkUrl;
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

function getUpNextTrack(session) {
  if (session.looping && session.loopQueue?.length) {
    return session.loopQueue[(session.loopIndex + 1) % session.loopQueue.length] || null;
  }
  return session.queue?.[0] || null;
}

function formatTrackName(track) {
  if (!track) return 'Queue empty';
  return formatDisplayName(getDisplayIdentity(track));
}

function buildLyricsText(session) {
  if (!session.lyricsEnabled) return null;
  if (session.lyricsStatus === 'plain' && session.lyricsPlainText) {
    return escapeMarkdown(session.lyricsPlainText).slice(0, 2600);
  }
  if (session.lyricsStatus === 'loading') return 'Loading lyrics…';
  if (session.lyricsStatus !== 'synced' || !session.lyricsLines?.length) {
    return 'Lyrics unavailable.';
  }

  const position = getLyricsPosition(session);
  const activeIndex = findActiveLineIndex(session.lyricsLines, position);
  const activeLine = session.lyricsLines[activeIndex];
  const nextLine = session.lyricsLines[activeIndex + 1];
  const nextTime = nextLine?.timestamp ?? Number(session.currentTrack?.duration);
  // Start-only lyrics cannot tell us when singing stops. Hold the line for
  // ten seconds before marking a long interval as instrumental.
  const explicitEnd = Number(activeLine?.end);
  const lineEnd =
    activeLine && explicitEnd > activeLine.timestamp && explicitEnd < nextTime
      ? explicitEnd
      : (activeLine?.timestamp ?? 0) + 10;
  const instrumental = activeLine
    ? Boolean(nextLine) &&
      nextTime - activeLine.timestamp > 10 &&
      position >= lineEnd &&
      position < nextTime
    : nextTime > 10;
  if (instrumental) {
    return [
      activeLine ? `♪ ${escapeMarkdown(activeLine.text)}` : null,
      '▶ **♪**',
      nextLine ? `♪ ${escapeMarkdown(nextLine.text)}` : null
    ]
      .filter(Boolean)
      .join('\n\n');
  }
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

function buildPlayerPayload(session, { stopped = false } = {}) {
  const disabled = stopped || !session.currentTrack;
  const embed = new EmbedBuilder().setColor(disabled ? 0x747f8d : 0x5865f2);

  if (disabled) {
    embed.setTitle('Playback stopped').setDescription('Ready for the next track.');
  } else {
    const track = session.currentTrack;
    const identity = getDisplayIdentity(track);
    const displayTitle = String(identity.title || track.title || 'Unknown track').trim();
    // Discord's embed title is already emphasized and links to the embed URL.
    // Avoid nested Markdown links, which can expose escapes in some clients.
    const title = displayTitle.slice(0, 256).replace(/[\uD800-\uDBFF]$/, '');
    embed.setTitle(title);
    try {
      const url = new URL(track.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') embed.setURL(url.href);
    } catch {
      // Keep the title readable when a legacy track has no valid URL.
    }
    const description = [];
    const artist = String(identity.artist || '').trim();
    if (artist) {
      const label = escapeMarkdown(artist);
      // Keep the artist secondary to the song title while preserving its link.
      const url = embed.data.url;
      const linkUrl = url?.replace(/\(/g, '%28').replace(/\)/g, '%29');
      description.push(linkUrl ? `*[${label}](${linkUrl})*` : `*${label}*`);
    }

    const upNext = getUpNextTrack(session);

    const lyricsText = buildLyricsText(session);
    if (lyricsText) description.push(lyricsText);

    const position = getPlaybackPosition(session);
    const progress = buildProgressBar(position, track.duration);
    const statusParts = [];
    if (Number.isFinite(Number(session.volume))) {
      statusParts.push(`🔊 Volume: ${Math.round(Number(session.volume))}%`);
    }

    embed.setDescription(description.join('\n\n'));
    embed.addFields({ name: '\u200b', value: progress });
    if (statusParts.length) {
      embed.addFields({ name: '\u200b', value: statusParts.join('  •  ') });
    }
    if (upNext) embed.setFooter({ text: `Up Next: ${formatTrackName(upNext)}` });
    const artworkUrl = getArtworkUrl(track);
    if (artworkUrl) embed.setThumbnail(artworkUrl);
  }

  const pauseButton = new ButtonBuilder()
    .setCustomId(playerCustomId(session, 'pause'))
    .setStyle(ButtonStyle.Secondary)
    .setLabel(session.isPaused ? 'Resume' : 'Pause')
    .setDisabled(disabled);

  const firstRowButtons = [
    pauseButton,
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'skip'))
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Skip')
      .setDisabled(disabled)
  ];
  if (!disabled && session.lyricsEnabled) {
    firstRowButtons.push(
      new ButtonBuilder()
        .setCustomId(playerCustomId(session, 'offset-minus'))
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Lyrics −1s'),
      new ButtonBuilder()
        .setCustomId(playerCustomId(session, 'offset-plus'))
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Lyrics +1s')
    );
  }
  const firstRow = new ActionRowBuilder().addComponents(firstRowButtons);

  const repeatActive = !disabled && session.looping;
  const lyricsActive = !disabled && session.lyricsEnabled;
  const secondRowButtons = [
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'stop'))
      .setStyle(ButtonStyle.Danger)
      .setLabel('Stop')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'repeat'))
      .setStyle(repeatActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setLabel('Repeat')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'lyrics'))
      .setStyle(lyricsActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setLabel('Lyrics')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(playerCustomId(session, 'cache'))
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Library')
      .setDisabled(!disabled)
  ];
  if (!session.repeatCache && session.currentTrack?.source !== 'cache') {
    secondRowButtons.push(
      new ButtonBuilder()
        .setCustomId(playerCustomId(session, 'autoplay'))
        .setStyle(session.autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel('Autoplay')
        .setDisabled(disabled)
    );
  }
  const secondRow = new ActionRowBuilder().addComponents(secondRowButtons);

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
  if (
    !options.force &&
    signature === session.playerUiSignature &&
    (playerIsLastMessage || !options.allowRepost)
  ) {
    return session.playerMessage;
  }

  if (session.playerMessage && !playerIsLastMessage && options.allowRepost) {
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

function isPlayerLastMessage(session) {
  const channel = session?.playerMessage?.channel || session?.lastChannel;
  return Boolean(
    session?.playerMessage &&
    (!channel?.lastMessageId || channel.lastMessageId === session.playerMessage.id)
  );
}

function schedulePlayerUiUpdate(session) {
  stopPlayerUiUpdater(session);
  if (!session?.currentTrack) return;

  const delay = isPlayerLastMessage(session)
    ? PLAYER_UPDATE_WHEN_LAST_MS
    : PLAYER_UPDATE_WHEN_NOT_LAST_MS;
  const allowRepost = !isPlayerLastMessage(session);
  const expectedPlaybackGeneration = session.playbackGeneration;
  session.playerUiTimer = setTimeout(async () => {
    session.playerUiTimer = null;
    try {
      await requestPlayerUpdate(session, { expectedPlaybackGeneration, allowRepost });
    } finally {
      if (session.currentTrack && session.playbackGeneration === expectedPlaybackGeneration) {
        schedulePlayerUiUpdate(session);
      }
    }
  }, delay);
  session.playerUiTimer.unref?.();
}

async function startPlayerUi(session, channel) {
  if (channel) session.lastChannel = channel;
  stopPlayerUiUpdater(session);
  const message = await requestPlayerUpdate(session, {
    force: true,
    expectedPlaybackGeneration: session.playbackGeneration,
    channel
  });
  schedulePlayerUiUpdate(session);
  return message;
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

async function restoreCacheSessionFromInteraction(interaction, guildId) {
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) return null;
  const member =
    guild.members.cache.get(interaction.user.id) ||
    (await guild.members.fetch(interaction.user.id).catch(() => null));
  const voiceChannelId = member?.voice?.channelId;
  if (!voiceChannelId) return null;

  const { ensureSession } = require('../core/sessionManager');
  const session = ensureSession(guildId, voiceChannelId, guild.voiceAdapterCreator);
  session.lastChannel = interaction.channel;
  session.autoplayClient = interaction.client;
  if (!session.playerMessage) {
    session.playerMessage = interaction.message;
    session.playerMessageId = interaction.message.id;
    session.playerChannelId = interaction.message.channelId;
    session.playerUiSignature = null;
  }
  return session;
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
  let session = guildId ? sessions.get(guildId) : null;
  if (!session && action === 'cache') {
    session = await restoreCacheSessionFromInteraction(interaction, guildId);
  }
  if (!session) {
    await rejectInteraction(
      interaction,
      action === 'cache' ? 'Join a voice channel first.' : 'This player is no longer active.'
    );
    return true;
  }
  if (!(await userCanControl(interaction, session, guildId))) {
    await rejectInteraction(interaction, 'Join the player’s voice channel to use its controls.');
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
    else enableLyrics(session, session.lastChannel, interaction);
  } else if (action === 'cache') {
    const { startCachePlayback } = require('./cacheService');
    const result = await startCachePlayback(session, guildId);
    if (!result.startedImmediately) {
      await interaction.followUp({
        content:
          result.reason === 'empty'
            ? 'The library is empty. Play a song to add it.'
            : 'Stop playback to shuffle the library.',
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (action === 'offset-minus' || action === 'offset-plus') {
    const direction = action === 'offset-plus' ? 1 : -1;
    const currentOffset = Number(session.currentTrack?.lyricsOffset) || 0;
    const nextOffset = Math.max(-15, Math.min(15, currentOffset + direction));
    session.currentTrack.lyricsOffset = nextOffset;
    const { updateTrackLyricsOffset } = require('../core/musicIndex');
    updateTrackLyricsOffset(session.currentTrack.id, nextOffset, session.currentTrack.titleSan);
    require('./lyricsService').wakeLyricsWorker(session);
    await requestPlayerUpdate(session, { force: true });
  } else if (action === 'autoplay') {
    const { clearAutoplayTimer, scheduleAutoplayCheck } = require('./autoplaySchedulerService');
    session.autoplay = !session.autoplay;
    if (session.autoplay) {
      session.autoplayClient = session.autoplayClient || interaction.client;
      scheduleAutoplayCheck(session.autoplayClient, session.autoplayMessage, guildId, session);
    } else {
      clearAutoplayTimer(session);
    }
    await requestPlayerUpdate(session, { force: true });
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
