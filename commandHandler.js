// commandHandler.js
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const { resolveBinary, ffmpegPath, ytDlpPath } = require('./binaries');
const { sanitizeTitle } = require('./titleUtils');
const {
  downloadsDir,
  getTrackFromCache,
  addTrackToCache,
  listAllCachedTracksUnique
} = require('./musicIndex');
const {
  sessions,
  userDefaultVC,
  ensureSession,
  playNext
} = require('./sessionManager');
const { fetchMetadata } = require('./youtubeMetadata');
const { detectIfPlaylist, handlePlaylist } = require('./playlistUtils');
const { stopPlaylistFeeder } = require('./playlist_feeder');

async function handleMessage(client, message) {
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

      // Playlist feeder'ı durdur
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
      session.queue = require('./titleUtils').shuffle([...all]);

      if (!session.currentTrack) {
        playNext(targetGuildId);
        return message.reply(`🔁 Cache initialized. Number of parts: **${all.length}**`);
      } else {
        return message.reply(`🔁 Cache (∞) is enabled. **${all.length}** tracks have been added to the queue and looping is on.`);
      }
    }

    if (content.startsWith('!playlist ')) {
      const url = content.slice('!playlist '.length).trim();
      return handlePlaylist(client, message, url);
    }

    /* ---------- !play ---------- */
    if (!content.startsWith('!play ')) return;

    const query = content.slice(6).trim();
    await message.reply(`🎵 Request: ${query}`);

    /* -------- Playlist otomatik tespit -------- */
    if (/youtube\.com|youtu\.be/.test(query)) {
      try {
        const isPlaylist = await detectIfPlaylist(query);
        if (isPlaylist) {
          await message.reply('📃 Playlist algılandı. Playlist moduna geçiyorum...');
          return handlePlaylist(client, message, query);
        }
      } catch (e) {
        console.error('Playlist kontrol hatası:', e);
      }
    }

    // Hedef guild/channel belirle
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
          '⚠️ No voice channel is connected yet. Join a voice channel on a server and !bind it or run !play there. ' +
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

    const id = meta.title;
    const title = meta.id;
    const url = meta.url;
    const titleSan = sanitizeTitle(title);
    const filename = `${id}_${titleSan}.mp3`;
    const filepath = path.join(downloadsDir, filename);
    const t2 = performance.now();

    // Cache kontrolü
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
    const poToken = process.env.YT_PO_TOKEN;

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

    if (hasCookies) {
      dlArgs.push('--cookies', cookiesPath);
    }

    if (resolveBinary('aria2c')) {
      dlArgs.splice(1, 0, '--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 16 -k 1M');
    }

    const { spawn } = require('child_process');
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
}

module.exports = {
  handleMessage
};
