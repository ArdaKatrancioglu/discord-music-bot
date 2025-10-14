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
const { url } = require('inspector');

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

/* ----------------------- İsimlendirme yardımcıları ----------------------- */
function sanitizeTitle(title) {
  // Unicode normalizasyonu, yasak karakterleri temizle, boşlukları tekilleştir ve _ yap
  return title
    .normalize('NFKD')
    .replace(/[\/\\:*?"<>|]+/g, '')             // Windows yasakları
    .replace(/[^\w\s\-.()&,'\[\]]+/g, '')       // dosya için güvenli karakter seti
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '_')
    .slice(0, 120);
}
function unsanitizeTitle(filePart) {
  // Tam geri dönüş garanti edilmez ama görüntüleme için yeterli
  return filePart.replace(/_/g, ' ').trim();
}
function parseCachedMp3Filename(file) {
  // Yeni biçim:  <id>_<sanitizedTitle>.mp3
  // Eski biçim:  <title>.mp3  (ID yok)
  const base = path.basename(file, '.mp3');
  const m = base.match(/^([A-Za-z0-9_-]{6,})_(.+)$/); // YouTube ID genelde 11 ama esnek bırakalım
  if (m) {
    return { id: m[1], titleSan: m[2], title: unsanitizeTitle(m[2]) };
  }
  // Legacy: baştan komple başlık
  return { id: null, titleSan: base, title: unsanitizeTitle(base) };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ----------------------- Kalıcı klasörler ----------------------- */
const downloadsDir = path.join(process.cwd(), 'downloadedMusic');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

/* ----------------------- İndirme önbelleği (global) ----------------------- */
/**
 * byId:    gerçek video ID → track
 * byTitle: (sanitize edilmiş) başlık → track  (legacy desteği + başlık tabanlı eşleşme)
 *
 * track: { id: string|null, title: string, titleSan: string, filePath: string }
 */
const downloadedById = new Map();
const downloadedByTitle = new Map();

for (const file of fs.readdirSync(downloadsDir)) {
  if (!file.toLowerCase().endsWith('.mp3')) continue;
  const full = path.join(downloadsDir, file);
  const { id, titleSan, title } = parseCachedMp3Filename(file);
  const track = { id, title, titleSan, filePath: full , url};
  if (id) downloadedById.set(id, track);
  downloadedByTitle.set(titleSan, track);
}
const uniqCount = new Set([...downloadedById.values(), ...downloadedByTitle.values()].map(t => t.filePath)).size;
console.log(`[Init] Indexed downloads: ${uniqCount} file(s)`);

/* ----------------------- Session state (guild-bazlı) ----------------------- */
// guildId -> { connection, player, queue, currentTrack, lastChannel, repeatCache, cachePool }
const sessions = new Map();
// userId -> { guildId, channelId }
const userDefaultVC = new Map();

/* ----------------------- Discord Client ----------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
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
        const id = (lines.shift() || '').trim();
        const title = (lines.join(' ') || '').trim();
        resolve({ id, title, url: `https://www.youtube.com/watch?v=${title}` });
      } else reject(new Error(`yt-dlp exited ${code}`));
    });
  });
}

/* ----------------------- Önbellek yardımcıları ----------------------- */
function getTrackFromCache({ id, titleSan }) {
  if (id && downloadedById.has(id)) return downloadedById.get(id);
  if (titleSan && downloadedByTitle.has(titleSan)) return downloadedByTitle.get(titleSan);
  return null;
}
function addTrackToCache(track) {
  if (track.id) downloadedById.set(track.id, track, url);
  downloadedByTitle.set(track.titleSan, track, url);
}
function listAllCachedTracksUnique() {
  const unique = new Map(); // key: filePath
  for (const t of downloadedByTitle.values()) unique.set(t.filePath, t);
  for (const t of downloadedById.values()) unique.set(t.filePath, t);
  return [...unique.values()];
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
    session = { connection, player, queue: [], currentTrack: null, lastChannel: null, repeatCache: false, cachePool: [] };
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
    // Sonsuz cache döngüsü aktifse yeni bir rastgele sıralama besle
    if (session.repeatCache && session.cachePool?.length) {
      session.queue = shuffle([...session.cachePool]);
    }
  }

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
    try { 
      const link = track.url ? `\n🔗 ${track.url}` : '';
      await channel.send(`▶️ Now playing: **${track.title}**${link}`); 
    } catch {}
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
        ? message.reply(`▶️ Now playing: **${session.currentTrack.title}**\n🔗 ${session.currentTrack.url || 'URL unknown'}`)
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
      session.repeatCache = false;  // sonsuz döngüyü de kapat
      session.cachePool = [];
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

    /* ---------- !cache (sonsuz rastgele çalma) ---------- */
    if (content === '!cache' || content.startsWith('!cache ')) {
      const arg = content.split(/\s+/)[1]?.toLowerCase();
      let targetGuildId, targetChannelId;

      if (message.guild) {
        const vc = message.member?.voice?.channel;
        if (!vc) return message.reply('⚠️ Önce bir ses kanalına katıl.');
        targetGuildId = vc.guild.id;
        targetChannelId = vc.id;
        userDefaultVC.set(message.author.id, { guildId: targetGuildId, channelId: targetChannelId });
      } else {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) {
          return message.reply(
            '⚠️ Henüz bir ses kanalı bağlı değil. Bir sunucuda bir ses kanalına katılıp !bind de veya orada !cache çalıştır. ' +
            '(Alternatif: DM’de !use <guildId> <channelId>)'
          );
        }
        targetGuildId = pref.guildId;
        targetChannelId = pref.channelId;
      }

      const guild = client.guilds.cache.get(targetGuildId);
      if (!guild) return message.reply('❌ Sunucu bulunamadı (botun o sunucuda olması gerek).');
      const session = ensureSession(targetGuildId, targetChannelId, guild.voiceAdapterCreator);
      session.lastChannel = message.channel;

      if (arg === 'off') {
        session.repeatCache = false;
        session.cachePool = [];
        return message.reply('🛑 Cache döngüsü devre dışı bırakıldı. (Queue aynı kaldı)');
      }

      const all = listAllCachedTracksUnique();
      if (!all.length) return message.reply('ℹ️ Önbellekte çalınacak şarkı yok.');

      session.cachePool = all;
      session.repeatCache = true;
      // Mevcut sırayı ezip yeni bir rastgele liste veriyoruz
      session.queue = shuffle([...all]);

      if (!session.currentTrack) {
        playNext(targetGuildId);
        return message.reply(`🔁 Cache (∞) başlatıldı. Parça sayısı: **${all.length}**`);
      } else {
        return message.reply(`🔁 Cache (∞) etkin. Sıraya **${all.length}** parça eklendi ve döngü açık.`);
      }
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

    // Arama/metadata
    const t0 = performance.now();
    const input = /^(https?:\/\/|www\.)/i.test(query) ? query : `ytsearch1:${query}`;

    let meta;
    try {
      meta = await fetchMetadata(input);
    } catch (e) {
      return message.reply('⚠️ Metadata error: ' + e.message);
    }
    const t1 = performance.now();

    // Doğru eşleştirme: id = gerçek video ID, title = gerçek başlık
    const id = meta.title;
    const title = meta.id;
    const url = meta.url;
    const titleSan = sanitizeTitle(title);
    const filename = `${id}_${titleSan}.mp3`;
    const filepath = path.join(downloadsDir, filename);
    const t2 = performance.now();

    // Cache kontrolü (id öncelikli, legacy için titleSan da kontrol)
    const cached = getTrackFromCache({ id, titleSan });
    if (cached) {
      const track = cached;

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

    const link = url ? `\n🔗 ${url}` : 'A Problem Occured While Trying To Fetch URL';
    await message.reply(`⬇️ Downloading **${title}**${link}`);
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
        const track = { id, title, titleSan, filePath: filepath, url };
        addTrackToCache(track);

        if (!session.currentTrack) {
          session.queue.unshift(track);
          playNext(targetGuildId);
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
