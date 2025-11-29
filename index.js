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
const { getPlaylistTracks } = require('./playlist_scraper');
const { startPlaylistFeeder, stopPlaylistFeeder } = require('./playlist_feeder');


const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('TOKEN is missing. Add TOKEN=... to .env file.');
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
  console.error('yt-dlp not found. Add it to PATH or place it next to it as bin/yt-dlp.exe.');
  process.exit(1);
}
if (!ffmpegPath) {
  console.error('ffmpeg not found. Add it to PATH or place it next to it as bin/ffmpeg.exe.');
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

      if (lines.length > 1) resolve(true);   // playlist
      else resolve(false);                   // normal video
    });

    proc.on('error', reject);
  });
}

async function handlePlaylist(message, url) {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('Ses kanalına gir.');

    let guildId = vc.guild.id;
    let channelId = vc.id;

    const guild = client.guilds.cache.get(guildId);
    const session = ensureSession(guildId, channelId, guild.voiceAdapterCreator);
    session.lastChannel = message.channel;

    await message.reply("⏳ Playlist çekiliyor...");

    let list;
    try {
        list = await getPlaylistTracks(url);
    } catch (e) {
        console.error(e);
        return message.reply("❌ Playlist okunamadı.");
    }

    await message.reply(`📜 Playlist bulundu. Parça: **${list.length}**\nBaşlatılıyor...`);

    const pushFn = async (track, guildId, channel) => {
        const query = track.url;

        try {
            await channel.send(`➕ Queue: **${track.title}**`);
            message.content = `!play ${query}`;
            client.emit("messageCreate", message);
        } catch (err) {
            console.error("Ekleme hatası:", err);
        }
    };

    startPlaylistFeeder(guildId, message.channel, list, pushFn, 30000);
}



/* ----------------------- Kalıcı klasörler ----------------------- */
const downloadsDir = path.join(process.cwd(), 'downloadedMusic');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

/* ----------------------- JSON tabanlı indirme önbelleği ----------------------- */
/**
 * JSON dosyası: downloadedMusic/index.json
 * Şema:
 * {
 *   "version": 1,
 *   "tracks": [
 *     { "id": "videoID", "title": "video name", "titleSan": "sanitized", "filePath": "/.../id_title.mp3", "url": "video link" }
 *   ]
 * }
 */
const indexPath = path.join(downloadsDir, 'index.json');

function loadIndex() {
  try {
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.tracks)) return obj;
    }
  } catch (e) {
    console.warn('[Init] Could not read index.json, will be recreated:', e.message);
  }
  return { version: 1, tracks: [] };
}

function saveIndex(idx) {
  try {
    fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Index] Could not write index.json:', e.message);
  }
}

let index = loadIndex();

// Klasördeki mp3'leri tara ve index'e ekle (mevcutsa dokunma)
for (const file of fs.readdirSync(downloadsDir)) {
  if (!file.toLowerCase().endsWith('.mp3')) continue;
  const full = path.join(downloadsDir, file);
  const { id, titleSan, title } = parseCachedMp3Filename(file);

  const exists =
    index.tracks.find(t => t.filePath === full) ||
    (id && index.tracks.find(t => t.id === id)) ||
    index.tracks.find(t => t.titleSan === titleSan);

  if (!exists) {
    index.tracks.push({
      id: id || null,
      title,
      titleSan,
      filePath: full,
      url: null // mevcut dosyalardan URL bilinmiyor
    });
  }
}
saveIndex(index);

function getTrackFromCache({ id, titleSan }) {
  if (id) {
    const byId = index.tracks.find(t => t.id === id);
    if (byId) return byId;
  }
  if (titleSan) {
    const byTitle = index.tracks.find(t => t.titleSan === titleSan);
    if (byTitle) return byTitle;
  }
  return null;
}
function addTrackToCache(track) {
  // Aynı id varsa güncelle; yoksa ekle. id yoksa titleSan/filePath ile eşle.
  const byIdIdx = track.id ? index.tracks.findIndex(t => t.id === track.id) : -1;
  const byPathIdx = index.tracks.findIndex(t => t.filePath === track.filePath);
  const byTitleIdx = index.tracks.findIndex(t => t.titleSan === track.titleSan);

  const idxToUse = byIdIdx >= 0 ? byIdIdx : (byPathIdx >= 0 ? byPathIdx : byTitleIdx);

  if (idxToUse >= 0) {
    index.tracks[idxToUse] = { ...index.tracks[idxToUse], ...track };
  } else {
    index.tracks.push(track);
  }
  saveIndex(index);
}
function listAllCachedTracksUnique() {
  return [...index.tracks];
}

const uniqCount = new Set(index.tracks.map(t => t.filePath)).size;
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
        return message.reply('Run this command while on a voice channel within a server stupid fuck.');
      const vc = message.member?.voice?.channel;
      if (!vc) return message.reply('Where you at? Nowhere. Join a voice channel first you dumb fuck');
      userDefaultVC.set(message.author.id, { guildId: vc.guild.id, channelId: vc.id });
      return message.reply(`🔗 DM commands are connected to channel **${vc.guild.name} › ${vc.name}**.`);
    }

    if (content === '!unbind') {
      userDefaultVC.delete(message.author.id);
      return message.reply('🔓 Your DM link has been cleared.');
    }

    // DM'den elle hedef verme: !use <guildId> <channelId>
    if (content.startsWith('!use ')) {
      const parts = content.split(/\s+/);
      if (parts.length !== 3) return message.reply('Error! Unknown format.\nExpected format: !use <guildId> <channelId>');
      const [, gId, cId] = parts;
      const guild = client.guilds.cache.get(gId);
      if (!guild) return message.reply('The bot is not on that server or is not cached.');
      const ch = guild.channels.cache.get(cId);
      if (!ch || ch.type !== 2) return message.reply('Provide a valid voice channel ID dumbass.');
      userDefaultVC.set(message.author.id, { guildId: gId, channelId: cId });
      return message.reply(`🔗 DM commands are linked to channel **${guild.name} › ${ch.name}**.`);
    }

    /* ---------- Görüntüleme Komutları (guild/DM fark etmez) ---------- */
    if (content === '!queue') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('ℹ️ No queue (no connected voice channel found complete retard).');
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
        if (!pref) return message.reply('ℹ️ No track currently playing. Want some? Play it then dumbfuck.');
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
        if (!pref) return message.reply('⚠️ There are no sessions.');
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
        if (!pref) return message.reply('⚠️ There are no sessions.');
        guildId = pref.guildId;
      }

      // ❗❗ Playlist feeder'ı burada durduruyoruz
      stopPlaylistFeeder(guildId);

      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ There are no sessions.');

      session.queue = [];
      session.repeatCache = false;
      session.cachePool = [];
      session.player.stop();

      return message.reply('⏹ Stopped playback, cleared queue and stopped playlist feeder.');
    }


    if (content === '!pause') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ There are no sessions.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ There are no sessions.');
      session.player.pause();
      return message.reply('⏸ Paused playback.');
    }

    if (content === '!resume') {
      let guildId = message.guild?.id;
      if (!guildId) {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) return message.reply('⚠️ There are no sessions.');
        guildId = pref.guildId;
      }
      const session = sessions.get(guildId);
      if (!session) return message.reply('⚠️ There are no sessions.');
      session.player.unpause();
      return message.reply('▶️ Resumed playback.');
    }

    /* ---------- !cache (sonsuz rastgele çalma) ---------- */
    if (content === '!cache' || content.startsWith('!cache ')) {
      const arg = content.split(/\s+/)[1]?.toLowerCase();
      let targetGuildId, targetChannelId;

      if (message.guild) {
        const vc = message.member?.voice?.channel;
        if (!vc) return message.reply('⚠️ Where you at? Nowhere. Join a voice channel first you dumb fuck');
        targetGuildId = vc.guild.id;
        targetChannelId = vc.id;
        userDefaultVC.set(message.author.id, { guildId: targetGuildId, channelId: targetChannelId });
      } else {
        const pref = userDefaultVC.get(message.author.id);
        if (!pref) {
          return message.reply(
            '⚠️ No voice channel is connected yet dumbass. Join a voice channel on a server and !bind it or run !cache there. ' +
            '(Alternative: !use <guildId> <channelId> in DM)'
          );
        }
        targetGuildId = pref.guildId;
        targetChannelId = pref.channelId;
      }

      const guild = client.guilds.cache.get(targetGuildId);
      if (!guild) return message.reply('❌ Server not found (bot must be on that server).');
      const session = ensureSession(targetGuildId, targetChannelId, guild.voiceAdapterCreator);
      session.lastChannel = message.channel;

      if (arg === 'off') {
        session.repeatCache = false;
        session.cachePool = [];
        return message.reply('🛑 Cache loop disabled. (Queue remains the same)');
      }

      const all = listAllCachedTracksUnique();
      if (!all.length) return message.reply('ℹ️ There are no songs in the cache to play. Play some songs to cache it bitch. Jkjk');

      session.cachePool = all;
      session.repeatCache = true;
      // Mevcut sırayı ezip yeni bir rastgele liste veriyoruz
      session.queue = shuffle([...all]);

      if (!session.currentTrack) {
        playNext(targetGuildId);
        return message.reply(`🔁 Cache initialized. Number of parts: **${all.length}**`);
      } else {
        return message.reply(`🔁 Cache (∞) is enabled. **${all.length}** tracks have been added to the queue and looping is on.`);
      }
    }

    if (content.startsWith('!playlist ')) {
      const url = content.slice('!playlist '.length).trim();
      return handlePlaylist(message, url);
    }



    /* ---------- !play ---------- */
    if (!content.startsWith('!play ')) return;

    const query = content.slice(6).trim();
    await message.reply(`🎵 Request: ${query}`);

    /* -----------------------------------------
    * PLAYLIST OTOMATİK TESPİT
    * ----------------------------------------- */
    if (/youtube\.com|youtu\.be/.test(query)) {
        try {
            const isPlaylist = await detectIfPlaylist(query);

            if (isPlaylist) {
              await message.reply("📃 Playlist algılandı. Playlist moduna geçiyorum...");
              return handlePlaylist(message, query);
            }
        } catch (e) {
            console.error("Playlist kontrol hatası:", e);
        }
    }

    // Hedef guild/channel belirle
    let targetGuildId, targetChannelId;
    if (message.guild) {
      const vc = message.member?.voice?.channel;
      if (!vc) return message.reply('⚠️ Where you at? Nowhere. Join a voice channel first you dumb fuck');
      targetGuildId = vc.guild.id;
      targetChannelId = vc.id;

      // DM için varsayılanı güncelle
      userDefaultVC.set(message.author.id, { guildId: targetGuildId, channelId: targetChannelId });
    } else {
      const pref = userDefaultVC.get(message.author.id);
      if (!pref) {
        return message.reply(
          '⚠️ No voice channel is connected yet. Join a voice channel on a server and !bind it or run !play there. ' +
          '(Alternative: !use <guildId> <channelId> in DM)'
        );
      }
      targetGuildId = pref.guildId;
      targetChannelId = pref.channelId;
    }

    // Session al/oluştur (guild-bazlı)
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return message.reply('❌ Server not found (bot must be on that server).');
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

const cookiesPath = path.join(process.cwd(), 'cookies.txt');
const hasCookies = fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0;
const poToken = process.env.YT_PO_TOKEN; // opsiyonel: sadece mweb + GVS için

const playerClient = hasCookies ? 'mweb' : 'ios';
const extractorArg =
  hasCookies && poToken
    ? `youtube:player_client=${playerClient};po_token=${playerClient}.gvs+${poToken}`
    : `youtube:player_client=${playerClient}`;

const dlArgs = [
  '--newline',
  '--ffmpeg-location', path.dirname(ffmpegPath) || ffmpegPath,
  '--no-playlist',
  '--force-ipv4',
  '--js-runtimes', 'node',
  '--extractor-args', extractorArg,
  '-f', 'ba/bestaudio/best',
  '-x', '--audio-format', 'mp3',
  '-o', filepath,
  url
];

// cookies sadece destekleyen client'ta ver
if (hasCookies) {
  dlArgs.push('--cookies', cookiesPath);
}





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
    try { await message.reply('⚠️ An unexpected error occurred. What have you done?'); } catch {}
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
