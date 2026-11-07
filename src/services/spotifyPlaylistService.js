// spotifyPlaylistService.js

const { getSpotifyPlaylistSongs } = require('../core/getSpotifyPlaylistSongs');

const spotifyFeeders = new Map();

function isSpotifyPlaylistUrl(input) {
  return /^https?:\/\/open\.spotify\.com\/playlist\//i.test(input);
}

function stopSpotifyPlaylistFeeder(guildId) {
  const feeder = spotifyFeeders.get(guildId);
  if (!feeder) return;

  clearTimeout(feeder.timer);
  spotifyFeeders.delete(guildId);
}

async function handleSpotifyPlaylist(client, message, url) {
  const guildId = message.guild?.id;

  if (!guildId) {
    return message.reply('Start this playlist from a server voice channel.');
  }

  const vc = message.member?.voice?.channel;
  if (!vc) {
    return message.reply('Join a voice channel first.');
  }

  stopSpotifyPlaylistFeeder(guildId);

  await message.reply('Loading playlist…');

  let songs;
  try {
    songs = await getSpotifyPlaylistSongs(url);
  } catch (e) {
    console.error('[Spotify Playlist Error]', e);
    return message.reply('Couldn’t load this playlist. Try another link.');
  }

  if (!songs.length) {
    return message.reply('This playlist is empty.');
  }

  await message.reply(`Playlist ready · ${songs.length} tracks`);

  const state = {
    songs,
    index: 0,
    timer: null
  };

  async function tick() {
    if (state.index >= state.songs.length) {
      spotifyFeeders.delete(guildId);
      try {
        await message.channel.send('Playlist added.');
      } catch {
        // The playlist is complete even if its notification cannot be delivered.
      }
      return;
    }

    const query = state.songs[state.index];
    state.index++;

    try {
      message.content = `p ${query}`;
      client.emit('messageCreate', message);
    } catch (err) {
      console.error('[Spotify Feeder Error]', err);
    }

    state.timer = setTimeout(tick, 15000);
  }

  spotifyFeeders.set(guildId, state);
  tick();
}

module.exports = {
  isSpotifyPlaylistUrl,
  handleSpotifyPlaylist,
  stopSpotifyPlaylistFeeder
};
