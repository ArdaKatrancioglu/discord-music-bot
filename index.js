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

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('TOKEN yok. .env dosyasına TOKEN=... ekleyin.');
  process.exit(1);
}

/* ----------------------- Yol çözümleyici ----------------------- */
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

const ffmpegPath = resolveBinary('ffmpeg');
const ytDlpPath = resolveBinary('yt-dlp') || resolveBinary('yt_dlp');

if (!ytDlpPath) {
  console.error('yt-dlp bulunamadı. PATH’e ekleyin veya bin/yt-dlp.exe olarak yanına koyun.');
  process.exit(1);
}
if (!ffmpegPath) {
  console.error('ffmpeg bulunamadı. PATH’e ekleyin veya bin/ffmpeg.exe olarak yanına koyun.');
  process.exit(1);
}

/* ----------------------- Kalıcı klasörler ----------------------- */
const downloadsDir = path.join(process.cwd(), 'downloadedMusic');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

/* ----------------------- İndirme önbelleği (global) ----------------------- */
const downloadedTracks = new Map(); // key: id, val: { title, filePath }
for (const file of fs.readdirSync(downloadsDir)) {
  if (file.toLowerCase().endsWith('.mp3')) {
    const id = path.basename(file, '.mp3'); // dosya adı "ID.mp3" varsayımı
    downloadedTracks.set(id, { title: id, filePath: path.join(downloadsDir, file) });
  }
}
console.log(`[Init] Indexed downloads: ${[...downloadedTracks.keys()]}`);

/* ----------------------- Session state (guild-bazlı) ----------------------- */
// guildId -> { connection, player, queue, currentTrack, lastChannel }
const sessions = new Map();
// userId -> { guildId, channelId } (DM'den !play için varsayılan yönlendirme)
const userDefaultVC = new Map();

/* ----------------------- Discord Client ----------------------- */
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

/* ----------------------- Metadata (yt-dlp flat) ----------------------- */
function fetchMetadata(input) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--flat-playlist', '--get-id', '--get-title', '--encoding', 'utf-8', input];
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

/* ----------------------- Session yardımcıları ----------------------- */
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
    session = { connection, player, queue: [], currentTrack: null, lastChannel: null };
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
    session.currentTrack = null;
    if (channel?.send) {
      try { await channel.send('🛑 Queue is empty. Add more with !play <song or URL>'); } catch {}
    }
    return;
  }

  const track = session.queue.shift();
  session.currentTrack = track;
  if (channel?.send) {
    try { await channel.send(`▶️ Now playing: **${track.title}**`); } catch {}
  }
  session.player.play(createAudioResource(track.filePath));
}

/* ----------------------- Komutlar ----------------------- */
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    const content = message.content.trim();

    /* ---------- Bağla/Çöz ---------- */
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

    /* ---------- Görüntüleme Komutları (guild/DM fark etmez) ---------- */
    if (content === '!queue') {
      // Hangi session?
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('ℹ️ Queue yok (bağlı bir ses kanalı da bulunamadı).');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session || (!session.currentTrack && !session.queue.length)) {
        return message.reply('ℹ️ Queue is empty.');
      }
      const now = session.currentTrack ? `Now: **${session.currentTrack.title}**\n` : '';
      const list = session.queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      return message.reply(`🎶 ${now}Queue:\n${list || '(empty)'}`);
    }

    if (content === '!np' || content === '!nowplaying') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('ℹ️ No track currently playing.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      return session?.currentTrack
        ? message.reply(`▶️ Now playing: **${session.currentTrack.title}**`)
        : message.reply('ℹ️ No track currently playing.');
    }

    if (content === '!skip') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ Hiçbir oturum yok.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session || !session.currentTrack) return message.reply('⚠️ Nothing to skip.');
      session.player.stop(); // Idle -> playNext
      return message.reply(`⏭ Skipped **${session.currentTrack.title}**`);
    }

    if (content === '!stop') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ Hiçbir oturum yok.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ Hiçbir oturum yok.');
      session.queue = [];
      session.player.stop(); // Idle -> playNext (boş queue: "Queue is empty" mesajını atar)
      return message.reply('⏹ Stopped playback and cleared queue (cache intact).');
    }

    if (content === '!pause') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ Hiçbir oturum yok.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ Hiçbir oturum yok.');
      session.player.pause();
      return message.reply('⏸ Paused playback.');
    }

    if (content === '!resume') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ Hiçbir oturum yok.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ Hiçbir oturum yok.');
      session.player.unpause();
      return message.reply('▶️ Resumed playback.');
    }

    /* ---------- !play ---------- */
    if (!content.startsWith('!play ')) return;

    const query = content.slice(6).trim();
    await message.reply(`🎵 Request: ${query}`);

    // Hedef guild/channel belirle
    let targetGuildId, targetChannelId;
    if (message.guild) {
      const vc = message.member?.voice?.channel;
      if (!vc) return message.reply('⚠️ Önce bir ses kanalına katıl.');
      targetGuildId = vc.guild.id;
      targetChannelId = vc.id;

      // DM için varsayılanı güncelle
      userDefaultVC.set(message.author.id, { guildId: targetGuildId, channelId: targetChannelId });
    } else {
      const pref = userDefaultVC.get(message.author.id);
      if (!pref) {
        return message.reply(
          '⚠️ Henüz bir ses kanalı bağlı değil. Bir sunucuda bir ses kanalına katılıp !bind de veya orada !play çalıştır. ' +
          '(Alternatif: DM’de !use <guildId> <channelId>)'
        );
      }
      targetGuildId = pref.guildId;
      targetChannelId = pref.channelId;
    }

    // Session al/oluştur (guild-bazlı)
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return message.reply('❌ Sunucu bulunamadı (botun o sunucuda olması gerek).');
    const session = ensureSession(targetGuildId, targetChannelId, guild.voiceAdapterCreator);

    // Metin geri bildirim kanalı bu mesajın geldiği kanal olsun
    session.lastChannel = message.channel;

    // Arama/indir & cache
    const t0 = performance.now();
    const input = /^(https?:\/\/|www\.)/i.test(query) ? query : `ytsearch1:${query}`;

    let meta;
    try {
      meta = await fetchMetadata(input);
    } catch (e) {
      return message.reply('⚠️ Metadata error: ' + e.message);
    }
    const t1 = performance.now();

    // ---- ID-only naming (mevcut mantığı koruyoruz) ----
    // Not: Bu iki satırda "id/title" takası önceki kodla uyumluluk için bilerek korunmuştur.
    const title = meta.id;
    const id = meta.title;

    const filename = `${id}.mp3`;
    const filepath = path.join(downloadsDir, filename);

    const t2 = performance.now();

    // Cache kontrolü
    if (downloadedTracks.has(id)) {
      const track = downloadedTracks.get(id);
      if (!track.title || track.title === id) track.title = title; // ilk kez görüyorsak başlığı doldur

      if (!session.currentTrack) {
        session.queue.unshift(track);
        await message.reply(`▶️ Playing from cache: **${track.title}**`);
        playNext(targetGuildId);
      } else {
        session.queue.push(track);
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
      '--cookies', path.join(process.cwd(), 'cookies.txt'),
      '-f',
      'bestaudio',
      '-x',
      '--audio-format',
      'mp3',
      '-o',
      filepath,
      input
    ];

    if (resolveBinary('aria2c')) {
      dlArgs.splice(1, 0, '--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 16 -k 1M');
    }

    const dl = spawn(ytDlpPath, dlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrData = '';
    let stdoutData = '';
    dl.stdout.on('data', (data) => { stdoutData += data.toString(); });
    dl.stderr.on('data', (data) => { stderrData += data.toString(); });

    dl.on('close', async (code) => {
      const dlEnd = performance.now();

      if (code === 0) {
        const track = { title, filePath: filepath };
        downloadedTracks.set(id, track);

        if (!session.currentTrack) {
          session.queue.unshift(track);
          playNext(targetGuildId);
          await message.reply(`▶️ Now playing: **${track.title}**`);
        } else {
          session.queue.push(track);
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
          await message.reply('```' + stderrData.slice(0, 1800) + '```');
        }
      }
    });
  } catch (err) {
    console.error('[messageCreate] Handler error:', err);
    try { await message.reply('⚠️ Beklenmeyen bir hata oluştu. (loglara bak)'); } catch {}
  }
});

/* ----------------------- Kapanış ----------------------- */
function destroyAllConnections() {
  for (const [gid, s] of sessions.entries()) {
    try { s.connection?.destroy(); } catch {}
  }
}
process.on('SIGINT', () => { destroyAllConnections(); process.exit(0); });
process.on('SIGTERM', () => { destroyAllConnections(); process.exit(0); });

/* ----------------------- Başlat ----------------------- */
(async () => {
  await sodium.ready; // AEAD/XChaCha20 hazır olsun
  client.login(TOKEN);
})();
