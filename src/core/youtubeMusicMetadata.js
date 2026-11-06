const fs = require('fs');
const { atomicWrite } = require('./atomicFile');

const DAY = 86400000;
const asText = (value) => (typeof value === 'string' ? value : value?.toString?.() || '');
const videoId = (item) => item?.video_id || item?.id || item?.endpoint?.payload?.videoId;

function cleanMusicTitle(value, artists = []) {
  const noise =
    '(?:official\\s+(?:music\\s+)?(?:video|audio|visualizer)|music\\s+video|lyric(?:s|\\s+video)?|visualizer|hd|hq|4k(?:\\s+hd)?)';
  let title = asText(value)
    .replace(new RegExp(`\\s*[([]\\s*${noise}\\s*[)\\]]`, 'gi'), ' ')
    .replace(new RegExp(`\\s*[|｜]\\s*${noise}\\s*$`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = title.split(/\s+[-–—]\s+/);
  if (
    parts.length > 1 &&
    artists.some((artist) => comparable(artist.name) === comparable(parts[0]))
  ) {
    title = parts.slice(1).join(' - ').trim();
  }
  return title;
}

function mapMusicItem(item) {
  if (!item) return null;
  // author/shortByline is often the uploader. Only accept structured music artists.
  const artists = (item.artists || [])
    .map((artist) => ({
      id: artist.channel_id || artist.id || null,
      name: asText(artist.name).trim()
    }))
    .filter((artist) => artist.name);
  const musicType =
    item.endpoint?.payload?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
      ?.musicVideoType;
  if (
    !artists.length ||
    (!item.album?.name && !['MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV'].includes(musicType))
  )
    return null;
  const title = cleanMusicTitle(item.title, artists);
  if (!title || !videoId(item)) return null;
  const year = String(item.album?.year || item.year || '').match(/^\d{4}$/);
  const thumbnails = Array.isArray(item.thumbnail)
    ? item.thumbnail
    : item.thumbnails || item.thumbnail?.contents || [];
  return {
    title,
    artist: artists.map((artist) => artist.name).join(', '),
    artists,
    album: asText(item.album?.name).trim() || null,
    year: year ? Number(year[0]) : null,
    artworkUrl: [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null,
    musicId: videoId(item)
  };
}

function comparable(value) {
  return asText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function validatedSearchMatch(items, identity, duration) {
  if (!identity?.artist || !Number(duration)) return null;
  return (
    Array.from(items || []).find((item) => {
      const mapped = mapMusicItem(item);
      if (!mapped || !mapped.album || comparable(mapped.title) !== comparable(identity.title))
        return false;
      const artists = mapped.artists.map((artist) => comparable(artist.name)).sort();
      const expected = identity.artists.map((artist) => comparable(artist.name)).sort();
      return (
        JSON.stringify(artists) === JSON.stringify(expected) &&
        Number.isFinite(item.duration?.seconds) &&
        Math.abs(item.duration.seconds - duration) <= 8
      );
    }) || null
  );
}

function matchWatchTrack(requestedId, contents) {
  // A recommendation's own primary/counterpart relationship does not link it to our ID.
  for (const row of contents || []) {
    const primary = row.primary || row;
    const counterparts = Array.from(row.counterpart || []);
    const group = [primary, ...counterparts].filter(Boolean);
    if (!group.some((item) => videoId(item) === requestedId)) continue;
    const candidates = [...counterparts, primary].filter(Boolean);
    const selected =
      candidates.find((item) => mapMusicItem(item) && item.album?.name) ||
      candidates.find((item) => mapMusicItem(item));
    if (selected) return { item: selected, metadata: mapMusicItem(selected) };
  }
  return null;
}

async function createMusicClient() {
  const { Innertube } = await import('youtubei.js');
  const youtube = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    fetch: (input, init = {}) =>
      fetch(input, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000)
      })
  });
  return youtube.music;
}

class YouTubeMusicResolver {
  constructor({ createClient = createMusicClient, cachePath, minGapMs = 350, retries = 1 } = {}) {
    this.createClient = createClient;
    this.cachePath = cachePath;
    this.minGapMs = minGapMs;
    this.retries = retries;
    this.cache = {};
    this.queue = Promise.resolve();
    this.lastRequest = 0;
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch {
        /* refresh corrupt cache */
      }
    }
  }

  request(operation) {
    const run = async () => {
      const gap = this.lastRequest + this.minGapMs - Date.now();
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      this.lastRequest = Date.now();
      return operation();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async resolve(track, { refresh = false } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(track.id || '')) return null;
    const cached = this.cache[track.id];
    if (!refresh && cached && Date.now() - cached.at < (cached.metadata ? 30 * DAY : DAY))
      return cached.metadata
        ? {
          ...cached.metadata,
          title: cleanMusicTitle(cached.metadata.title, cached.metadata.artists)
        }
        : null;
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        if (!this.client) this.client = this.createClient();
        const client = await this.client;
        const info = await this.request(() => client.getInfo(track.id));
        const panel = await this.request(() => info.getUpNext(false));
        const match = matchWatchTrack(track.id, panel?.contents);
        let metadata = match?.metadata || null;
        let musicItem = match?.item;
        if (metadata && !metadata.album && client.search) {
          try {
            const results = await this.request(() =>
              client.search(`${metadata.title} ${metadata.artist}`, { type: 'song' })
            );
            const candidate = validatedSearchMatch(
              results.songs?.contents,
              metadata,
              track.duration || info.basic_info?.duration
            );
            if (candidate) {
              musicItem = candidate;
              metadata = mapMusicItem(candidate);
            }
          } catch {
            /* Keep direct verified metadata if optional search fails. */
          }
        }
        if (metadata && musicItem.album?.id) {
          try {
            const album = await this.request(() => client.getAlbum(musicItem.album.id));
            const yearText = asText(album.header?.year || album.header?.subtitle);
            const year = yearText.match(/\b(?:19|20)\d{2}\b/);
            if (!metadata.year && year) metadata.year = Number(year[0]);
            const images = album.header?.thumbnails || album.header?.thumbnail?.contents || [];
            metadata.artworkUrl =
              [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ||
              metadata.artworkUrl;
          } catch {
            /* Album information is optional; the verified track remains useful. */
          }
        }
        this.cache[track.id] = { at: Date.now(), metadata };
        if (this.cachePath) atomicWrite(this.cachePath, JSON.stringify(this.cache, null, 2));
        return metadata;
      } catch (error) {
        lastError = error;
        this.client = null;
      }
    }
    // Transport failures are not negative matches and must be retryable on the next run.
    console.warn(`[YouTube Music] ${track.id}: ${lastError?.message || 'lookup failed'}`);
    return null;
  }
}

function applyMusicMetadata(track, metadata, { overwrite = false } = {}) {
  if (!metadata) return track;
  const corrected = track.artist && track.videoTitle;
  if (corrected && !overwrite) return track;
  return { ...track, ...metadata, metadataSource: 'youtube-music' };
}

module.exports = {
  YouTubeMusicResolver,
  applyMusicMetadata,
  mapMusicItem,
  matchWatchTrack,
  validatedSearchMatch,
  cleanMusicTitle
};
