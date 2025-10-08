// index.js
require('dotenv').config();
const sodium = require('libsodium-wrappers');
const { generateDependencyReport } = require('@discordjs/voice');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const userDefaultVC = new Map();
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('TOKEN yok. .env dosyasına TOKEN=... ekleyin.');
  process.exit(1);
}

// --- Yol çözümleyici: exe yanındaki bin/ veya PATH ---
function resolveBinary(name) {
  const local = path.join(
    process.cwd(),
    'bin',
    process.platform === 'win32' ? `${name}.exe` : name
  );
  if (fs.existsSync(local)) return local;
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const out = execSync(`${locator} ${name}`, {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch (_) {}
  return null;
}

// ffmpeg ve yt-dlp yolunu bul
const ffmpegPath = resolveBinary('ffmpeg');
const ytDlpPath = resolveBinary('yt-dlp') || resolveBinary('yt_dlp');

if (!ytDlpPath) {
  console.error(
    'yt-dlp bulunamadı. PATH’e ekleyin veya bin/yt-dlp.exe olarak yanına koyun.'
  );
  process.exit(1);
}

if (!ffmpegPath) {
  console.error(
    'ffmpeg bulunamadı. PATH’e ekleyin veya bin/ffmpeg.exe olarak yanına koyun.'
  );
  process.exit(1);
}

// --- Kalıcı klasörler (exe ile aynı klasörde) ---
const downloadsDir = path.join(process.cwd(), 'downloadedMusic');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// --- Index Cache (ID-based) ---
const downloadedTracks = new Map();
for (const file of fs.readdirSync(downloadsDir)) {
  if (file.toLowerCase().endsWith('.mp3')) {
    const id = path.basename(file, '.mp3'); // sadece ID
    downloadedTracks.set(id, { title: id, filePath: path.join(downloadsDir, file) });
  }
}

console.log(`[Init] Indexed downloads: ${[...downloadedTracks.keys()]}`);

// --- Initialize Player & Client ---
let connection = null;
const player = createAudioPlayer();
let queue = [];
let currentTrack = null;
let lastChannel = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  console.log(generateDependencyReport());
});

// --- Metadata Fetch Using flat-playlist ---
function fetchMetadata(input) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--flat-playlist', '--get-id', '--get-title', input];
    const proc = spawn(ytDlpPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    let out = '';
    proc.stdout.on('data', d => (out += d));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        const lines = out.trim().split('\n');
        const id = lines.shift();
        resolve({ id, title: lines.join(' ') });
      } else reject(new Error(`yt-dlp exited ${code}`));
    });
  });
}

// --- Play Next in Queue ---
async function playNext(channel) {
  if (!queue.length) {
    currentTrack = null;
    return channel?.send?.('🛑 Queue is empty. Add more with !play <song or URL>');
  }
  const track = queue.shift();
  currentTrack = track;
  channel?.send?.(`▶️ Now playing: **${track.title}**`);
  player.play(createAudioResource(track.filePath));
}

player.on(AudioPlayerStatus.Idle, () => playNext(lastChannel));

// --- Commands ---
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.trim();

  if (content === '!bind') {
    if (!message.guild)
      return message.reply('Bu komutu bir sunucu içinde, bir ses kanalındayken çalıştır.');
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('Önce bir ses kanalına katıl.');
    userDefaultVC.set(message.author.id, { guildId: vc.guild.id, channelId: vc.id });
    return message.reply(`🔗 DM komutların **${vc.guild.name} › ${vc.name}** kanalına bağlandı.`);
  }

  if (content === '!unbind') {
    userDefaultVC.delete(message.author.id);
    return message.reply('🔓 DM bağın temizlendi.');
  }

  // DM'den elle hedef verme: !use <guildId> <channelId>
  if (content.startsWith('!use ')) {
    const parts = content.split(/\s+/);
    if (parts.length !== 3) return message.reply('Kullanım: !use <guildId> <channelId>');
    const [, gId, cId] = parts;
    const guild = client.guilds.cache.get(gId);
    if (!guild) return message.reply('Bot o sunucuda değil ya da önbellekte yok.');
    const ch = guild.channels.cache.get(cId);
    if (!ch || ch.type !== 2) return message.reply('Geçerli bir ses kanalı ID ver.');
    userDefaultVC.set(message.author.id, { guildId: gId, channelId: cId });
    return message.reply(`🔗 DM komutların **${guild.name} › ${ch.name}** kanalına bağlandı.`);
  }

  if (content === '!queue') {
    if (!currentTrack && !queue.length) return message.reply('ℹ️ Queue is empty.');
    const now = currentTrack ? `Now: **${currentTrack.title}**\n` : '';
    const list = queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    return message.reply(`🎶 ${now}Queue:\n${list}`);
  }

  if (content === '!np' || content === '!nowplaying') {
    return currentTrack
      ? message.reply(`▶️ Now playing: **${currentTrack.title}**`)
      : message.reply('ℹ️ No track currently playing.');
  }

  if (content === '!skip') {
    if (!currentTrack) return message.reply('⚠️ Nothing to skip.');
    player.stop();
    return message.reply(`⏭ Skipped **${currentTrack.title}**`);
  }

  if (content === '!stop') {
    queue = [];
    player.stop();
    return message.reply('⏹ Stopped playback and cleared queue (cache intact).');
  }

  if (content === '!pause') {
    player.pause();
    return message.reply('⏸ Paused playback.');
  }

  if (content === '!resume') {
    player.unpause();
    return message.reply('▶️ Resumed playback.');
  }

  if (!content.startsWith('!play ')) return;

  const query = content.slice(6).trim();
  lastChannel = message.channel;
  await message.reply(`🎵 Request: ${query}`);

  let targetGuildId, targetChannelId;
  if (message.guild) {
    // Sunucuda yazılmışsa: kullanıcının o anki ses kanalı
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('⚠️ Önce bir ses kanalına katıl.');
    targetGuildId = vc.guild.id;
    targetChannelId = vc.id;

    // DM için varsayılanı güncelle
    userDefaultVC.set(message.author.id, { guildId: targetGuildId, channelId: targetChannelId });
  } else {
    // DM’den yazılmışsa: kullanıcı için kayıtlı varsayılan
    const pref = userDefaultVC.get(message.author.id);
    if (!pref) {
      return message.reply(
        '⚠️ Henüz bir ses kanalı bağlı değil. Bir sunucuda bir ses kanalına katılıp !bind de veya orada !play çalıştır.' +
          ' (Alternatif: DM’de !use <guildId> <channelId>)'
      );
    }
    targetGuildId = pref.guildId;
    targetChannelId = pref.channelId;
  }

  // Bağlantıyı kur/yenile
  if (
    !connection ||
    connection.joinConfig.guildId !== targetGuildId ||
    connection.joinConfig.channelId !== targetChannelId
  ) {
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return message.reply('❌ Sunucu bulunamadı (botun o sunucuda olması gerek).');
    connection = joinVoiceChannel({
      channelId: targetChannelId,
      guildId: targetGuildId,
      adapterCreator: guild.voiceAdapterCreator
    });
    connection.subscribe(player);
  }

  // DM veya sunucu fark etmeksizin, metin geri bildirimlerini bu kanala gönder
  lastChannel = message.channel;

  const t0 = performance.now();
  const input = /^(https?:\/\/|www\.)/i.test(query) ? query : `ytsearch1:${query}`;

  let meta;
  try {
    meta = await fetchMetadata(input);
  } catch (e) {
    return message.reply('⚠️ Metadata error: ' + e.message);
  }
  const t1 = performance.now();

  // ---- ID-only naming ----
  const title = meta.id;
  const id = meta.title;

  // Diskte sadece ID.mp3 olsun
  const filename = `${id}.mp3`;
  const filepath = path.join(downloadsDir, filename);

  const t2 = performance.now();

  // --- Cache kontrolü: anahtar = id
  if (downloadedTracks.has(id)) {
    const track = downloadedTracks.get(id);
    if (!track.title || track.title === id) track.title = title; // ilk kez görüyorsak başlığı doldur

    if (!currentTrack) {
      queue.unshift(track);
      await message.reply(`▶️ Playing from cache: **${track.title}**`);
      playNext(message.channel);
    } else {
      queue.push(track);
      await message.reply(`🔄 Queued from cache: **${track.title}**`);
    }
    return message.reply(
      `⏱ meta ${(t1 - t0).toFixed(0)}ms, prep ${(t2 - t1).toFixed(0)}ms, cache 0ms`
    );
  }

  await message.reply(`⬇️ Downloading **${title}**`);
  const dlStart = performance.now();

  const dlArgs = [
    '--newline',
    '--ffmpeg-location',
    path.dirname(ffmpegPath) || ffmpegPath,
    '--no-playlist',
    '--cookies', path.join(process.cwd(), 'cookies.txt'),   // 👈 çerez dosyasını ekledik
    '-f',
    'bestaudio',
    '-x',
    '--audio-format',
    'mp3',
    '-o',
    filepath,
    input
  ];

  // İsteğe bağlı hızlı indirme
  if (resolveBinary('aria2c')) {
    dlArgs.splice(1, 0, '--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 16 -k 1M');
  }

  const dl = spawn(ytDlpPath, dlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let stderrData = '';
let stdoutData = '';

dl.stdout.on('data', (data) => {
  stdoutData += data.toString();
});

dl.stderr.on('data', (data) => {
  stderrData += data.toString();
});

// ✅ Detaylı loglar burada
dl.on('close', async (code) => {
  const dlEnd = performance.now();

  if (code === 0) {
    const track = { title, filePath: filepath };
    downloadedTracks.set(id, track);

    if (!currentTrack) {
      queue.unshift(track);
      playNext(message.channel);
      await message.reply(`▶️ Now playing: **${track.title}**`);
    } else {
      queue.push(track);
      await message.reply(`🔄 Queued: **${track.title}**`);
    }

    const t4 = performance.now();
    await message.reply(
      `⏱ meta ${(t1 - t0).toFixed(0)}ms, ` +
      `prep ${(t2 - t1).toFixed(0)}ms, ` +
      `download ${(dlEnd - dlStart).toFixed(0)}ms, ` +
      `total ${(t4 - t0).toFixed(0)}ms`
    );
  } else {
    console.error(`❌ [Download Error] yt-dlp exited with code ${code}`);
    console.error('----- STDERR -----');
    console.error(stderrData.trim());
    console.error('----- STDOUT -----');
    console.error(stdoutData.trim());
    console.error('------------------');

    await message.reply(`❌ **Download failed.** (code ${code})`);
    if (stderrData) {
      await message.reply('```' + stderrData.slice(0, 1800) + '```'); // Discord limitine göre kes
    }
  }
});

});

process.on('SIGINT', () => {
  try {
    connection?.destroy();
  } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  try {
    connection?.destroy();
  } catch (_) {}
  process.exit(0);
});

(async () => {
  await sodium.ready; // AEAD/XChaCha20 hazır olsun
  client.login(TOKEN);
})();
