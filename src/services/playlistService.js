const { spawn } = require('child_process');
const { ytDlpPath } = require('../core/binaries');
const { getPlaylistTracks } = require('../core/playlist_scraper');
const { startPlaylistFeeder } = require('../core/playlist_feeder');
const { ensureSession } = require('../core/sessionManager');

async function detectIfPlaylist(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',
      '--print', '%(id)s',
      url
    ];

    const proc = spawn(ytDlpPath, args);

    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => out += d);

    proc.on('close', code => {
      if (code !== 0) return resolve(false);

      const lines = out.trim().split(/\r?\n/).filter(Boolean);

      if (lines.length > 1) resolve(true);
      else resolve(false);
    });

    proc.on('error', reject);
  });
}

async function handlePlaylist(client, message, url) {
  const vc = message.member?.voice?.channel;
  if (!vc) return message.reply('Join a voice channel first.');

  const guildId = vc.guild.id;
  const channelId = vc.id;

  const guild = client.guilds.cache.get(guildId);
  const session = ensureSession(guildId, channelId, guild.voiceAdapterCreator);
  session.lastChannel = message.channel;

  await message.reply('⏳ Fetching Playlist...');

  let list;
  try {
    list = await getPlaylistTracks(url);
  } catch (e) {
    console.error(e);
    return message.reply('❌ There is been an error while fecthing playlist.');
  }

  await message.reply(`📜 Playlist bulundu. Parça: **${list.length}**\nBaşlatılıyor...`);

  const pushFn = async (track, guildId, channel) => {
    const query = track.url;

    try {
      await channel.send(`➕ Queue: **${track.title}**`);
      message.content = `!play ${query}`;
      client.emit('messageCreate', message);
    } catch (err) {
      console.error('Error on adding to queue:', err);
    }
  };

  startPlaylistFeeder(guildId, message.channel, list, pushFn, 30000);
}

module.exports = {
  detectIfPlaylist,
  handlePlaylist
};