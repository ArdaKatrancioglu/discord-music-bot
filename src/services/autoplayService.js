const { execFile } = require('child_process');
const https = require('https');
const { sessions } = require('../core/sessionManager');
const { ytDlpPath } = require('../core/binaries');
const { dotProduct } = require('../core/musicEmbeddingIndex');
const { embedMusicTitles } = require('./cacheSearchService');
const { resolveGuildIdForBoundAwareCommand } = require('./messageContextService');

const LASTFM_API_KEY = process.env.LASTFM_API_KEY || null;
const MAX_YT_RESULTS = 20;
const AUTOPLAY_RECENT_TRACK_LIMIT = 5;
const numericSetting = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= -1 && parsed <= 1 ? parsed : fallback;
};
const AUTOPLAY_SEMANTIC_REJECT_THRESHOLD = numericSetting(
  process.env.AUTOPLAY_SEMANTIC_REJECT_THRESHOLD,
  0.93
);
const AUTOPLAY_SEMANTIC_PENALTY_START = numericSetting(
  process.env.AUTOPLAY_SEMANTIC_PENALTY_START,
  0.83
);
const AUTOPLAY_MAX_DIVERSITY_PENALTY = 45;

function execYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(ytDlpPath, args, { maxBuffer: 1024 * 1024 * 80 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function getYtMetadata(url) {
  const stdout = await execYtDlp(['--dump-json', '--no-playlist', url]);
  return JSON.parse(stdout);
}

function ytSearch(query, maxResults = 20) {
  return new Promise((resolve, reject) => {
    execFile(
      ytDlpPath,
      [`ytsearch${maxResults}:${query}`, '--dump-json', '--no-playlist', '--flat-playlist'],
      { maxBuffer: 1024 * 1024 * 80 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }

        const results = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        resolve(results);
      }
    );
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'discord-music-bot-autoplay/1.0'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(error);
            }
          });
        }
      )
      .on('error', reject);
  });
}

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeNoise(text) {
  return String(text || '')
    .replace(/\(official.*?\)/gi, '')
    .replace(/\[official.*?\]/gi, '')
    .replace(/\(lyrics?\)/gi, '')
    .replace(/\[lyrics?\]/gi, '')
    .replace(/\(audio\)/gi, '')
    .replace(/\[audio\]/gi, '')
    .replace(/\(hd\)/gi, '')
    .replace(/\[hd\]/gi, '')
    .replace(/\(clean\)/gi, '')
    .replace(/\[clean\]/gi, '')
    .replace(/\(explicit\)/gi, '')
    .replace(/\[explicit\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTrackTitleForLastFm(title) {
  return String(title || '')
    .replace(/\(.*?joy\s*t[uü]rk.*?\)/gi, '')
    .replace(/\[.*?joy\s*t[uü]rk.*?\]/gi, '')
    .replace(/\(.*?akustik.*?\)/gi, '')
    .replace(/\[.*?akustik.*?\]/gi, '')
    .replace(/\(.*?acoustic.*?\)/gi, '')
    .replace(/\[.*?acoustic.*?\]/gi, '')
    .replace(/\(.*?live.*?\)/gi, '')
    .replace(/\[.*?live.*?\]/gi, '')
    .replace(/\(.*?canl[ıi].*?\)/gi, '')
    .replace(/\[.*?canl[ıi].*?\]/gi, '')
    .replace(/\(.*?official.*?\)/gi, '')
    .replace(/\[.*?official.*?\]/gi, '')
    .replace(/\(.*?audio.*?\)/gi, '')
    .replace(/\[.*?audio.*?\]/gi, '')
    .replace(/\(.*?video.*?\)/gi, '')
    .replace(/\[.*?video.*?\]/gi, '')
    .replace(/\(.*?lyrics?.*?\)/gi, '')
    .replace(/\[.*?lyrics?.*?\]/gi, '')
    .replace(/\(.*?sözleri.*?\)/gi, '')
    .replace(/\[.*?sözleri.*?\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function guessArtistTrack(metadata) {
  const directArtist = metadata.artist || metadata.creator;
  const directTrack = metadata.track || metadata.alt_title;

  if (directArtist && directTrack) {
    return {
      artist: directArtist,
      track: cleanTrackTitleForLastFm(directTrack),
      rawTrack: directTrack,
      source: 'yt-dlp artist/track fields',
      confidence: 90
    };
  }

  const title = removeNoise(metadata.title || '');
  const uploader = metadata.uploader || metadata.channel || '';
  const separators = [' - ', ' – ', ' — ', ' | '];

  for (const sep of separators) {
    if (title.includes(sep)) {
      const [left, ...rest] = title.split(sep);
      const right = rest.join(sep);

      if (left && right) {
        return {
          artist: left.trim(),
          track: cleanTrackTitleForLastFm(right.trim()),
          rawTrack: right.trim(),
          source: `title split by "${sep.trim()}"`,
          confidence: 70
        };
      }
    }
  }

  if (norm(uploader).endsWith('topic')) {
    return {
      artist: uploader.replace(/- Topic$/i, '').trim(),
      track: cleanTrackTitleForLastFm(title),
      rawTrack: title,
      source: 'YouTube Topic channel',
      confidence: 65
    };
  }

  return {
    artist: uploader,
    track: cleanTrackTitleForLastFm(title),
    rawTrack: title,
    source: 'fallback uploader + title',
    confidence: 35
  };
}

function metadataConfidence(metadata, parsed) {
  let score = 0;

  if (metadata.artist) score += 30;
  if (metadata.track) score += 30;
  if (parsed.confidence >= 70) score += 20;
  if (metadata.categories?.length > 0) score += 10;
  if (metadata.tags?.length >= 3) score += 10;
  if (metadata.duration && metadata.duration >= 90 && metadata.duration <= 600) score += 10;

  return Math.min(score, 100);
}

function splitArtists(artist) {
  return String(artist || '')
    .split(/\s*(?:&|,|feat\.?|ft\.?|with| x |\/)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

async function getLastFmSimilarTracks(artist, track) {
  if (!LASTFM_API_KEY) return [];

  const url =
    'https://ws.audioscrobbler.com/2.0/?' +
    new URLSearchParams({
      method: 'track.getSimilar',
      artist,
      track,
      autocorrect: '1',
      limit: '10',
      api_key: LASTFM_API_KEY,
      format: 'json'
    }).toString();

  const json = await httpGetJson(url);

  if (json.error) return [];

  const tracks = json?.similartracks?.track;
  if (!Array.isArray(tracks)) return [];

  return tracks.map((item) => ({
    artist: item.artist?.name,
    track: item.name,
    match: Number(item.match || 0),
    type: 'track'
  }));
}

async function getLastFmSimilarArtists(artist) {
  if (!LASTFM_API_KEY) return [];

  const url =
    'https://ws.audioscrobbler.com/2.0/?' +
    new URLSearchParams({
      method: 'artist.getSimilar',
      artist,
      autocorrect: '1',
      limit: '10',
      api_key: LASTFM_API_KEY,
      format: 'json'
    }).toString();

  const json = await httpGetJson(url);

  if (json.error) return [];

  const artists = json?.similarartists?.artist;
  if (!Array.isArray(artists)) return [];

  return artists.map((item) => ({
    artist: item.name,
    track: null,
    match: Number(item.match || 0),
    type: 'artist'
  }));
}

function isSameOrVariant(candidate, parsed) {
  const title = norm(candidate.title);
  const cleanTrack = norm(parsed.track);
  const rawTrack = norm(parsed.rawTrack || parsed.track);
  const artist = norm(parsed.artist);

  const tracksToCheck = [...new Set([cleanTrack, rawTrack].filter((t) => t.length >= 3))];

  for (const track of tracksToCheck) {
    if (title.includes(track)) return true;

    const trackWords = track.split(' ').filter((w) => w.length >= 3);
    const hits = trackWords.filter((w) => title.includes(w)).length;

    if (trackWords.length >= 2 && hits / trackWords.length >= 0.75) {
      return true;
    }

    if (artist && title.includes(artist) && hits >= 1 && trackWords.length <= 2) {
      return true;
    }
  }

  return false;
}

function rejectReason(candidate, parsed, history) {
  const title = norm(candidate.title);
  const url = candidate.webpage_url || candidate.url;

  if (history.has(url)) return 'already in history';
  if (isSameOrVariant(candidate, parsed)) return 'same song or variant';

  const badWords = [
    'reaction',
    'review',
    'tutorial',
    'karaoke',
    'instrumental',
    'slowed',
    'reverb',
    'nightcore',
    'remix',
    '1 hour',
    '10 hours',
    'loop',
    'full album',
    'playlist'
  ];

  for (const word of badWords) {
    if (title.includes(word)) return `bad keyword: ${word}`;
  }

  if (candidate.duration && candidate.duration > 600) return `too long: ${candidate.duration}s`;
  if (candidate.duration && candidate.duration < 60) return `too short: ${candidate.duration}s`;

  return null;
}

function scoreCandidate(candidate, parsed, source) {
  const title = norm(candidate.title);
  const uploader = norm(candidate.uploader || candidate.channel || '');
  const artist = norm(parsed.artist);

  let score = 0;

  if (source === 'lastfm-track') score += 65;
  if (source === 'lastfm-artist') score += 50;
  if (source === 'ytsearch') score += 10;

  if (artist && title.includes(artist)) score += 10;
  if (artist && uploader.includes(artist)) score += 10;
  if (title.includes('official') || title.includes('resmi')) score += 8;
  if (title.includes('audio')) score += 6;
  if (candidate.duration >= 120 && candidate.duration <= 420) score += 10;

  if (typeof candidate.view_count === 'number') {
    if (candidate.view_count > 100_000_000) score += 12;
    else if (candidate.view_count > 10_000_000) score += 8;
    else if (candidate.view_count > 1_000_000) score += 4;
  }

  return score;
}

function buildFallbackQueries(metadata, parsed) {
  const artist = parsed.artist;
  const track = parsed.track;

  const tags = Array.isArray(metadata.tags)
    ? metadata.tags
      .map(norm)
      .filter((tag) => tag.length >= 3)
      .filter((tag) => !norm(track).includes(tag))
      .filter((tag) => !tag.includes('official'))
      .filter((tag) => !tag.includes('audio'))
      .filter((tag) => !tag.includes('lyrics'))
      .slice(0, 3)
    : [];

  const categories = Array.isArray(metadata.categories)
    ? metadata.categories
      .map(norm)
      .filter((cat) => cat.length >= 3)
      .slice(0, 2)
    : [];

  const queries = [];

  if (parsed.confidence >= 65 && artist) {
    queries.push(`${artist} songs`);
    queries.push(`${artist} radio`);
  }

  if (parsed.confidence >= 70 && artist && tags.length > 0) {
    queries.push(`${artist} ${tags.join(' ')} songs`);
  }

  if (categories.length > 0 && artist && parsed.confidence >= 65) {
    queries.push(`${artist} ${categories.join(' ')} music`);
  }

  if (parsed.confidence < 50 && track) {
    queries.push(`${track} music`);
  }

  return [...new Set(queries)].slice(0, 4);
}

async function getCandidatesFromLastFm(parsed, history) {
  if (!LASTFM_API_KEY || parsed.confidence < 65) return [];

  const artists = splitArtists(parsed.artist);
  const cleanTrack = cleanTrackTitleForLastFm(parsed.track);

  let similar = [];

  for (const artist of artists) {
    const result = await getLastFmSimilarTracks(artist, cleanTrack);
    if (result.length > 0) {
      similar = result;
      break;
    }
  }

  if (similar.length === 0) {
    for (const artist of artists) {
      const result = await getLastFmSimilarArtists(artist);
      if (result.length > 0) {
        similar = result;
        break;
      }
    }
  }

  const candidates = [];

  for (const item of similar.slice(0, 5)) {
    const query = item.track
      ? `${item.artist} ${item.track} official audio`
      : `${item.artist} songs official audio`;

    const results = await ytSearch(query, 5);

    for (const result of results) {
      const reason = rejectReason(result, parsed, history);
      if (reason) continue;

      const source = item.type === 'track' ? 'lastfm-track' : 'lastfm-artist';
      let score = scoreCandidate(result, parsed, source);
      score += Math.round(Number(item.match || 0) * 20);

      candidates.push({
        source,
        query,
        track: result,
        score
      });

      break;
    }
  }

  return candidates;
}

async function getCandidatesFromFallback(metadata, parsed, history) {
  const queries = buildFallbackQueries(metadata, parsed);
  const candidates = [];

  for (const query of queries) {
    const results = await ytSearch(query, MAX_YT_RESULTS);

    for (const result of results) {
      const reason = rejectReason(result, parsed, history);
      if (reason) continue;

      candidates.push({
        source: 'ytsearch',
        query,
        track: result,
        score: scoreCandidate(result, parsed, 'ytsearch')
      });
    }
  }

  return candidates;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];

  for (const c of candidates) {
    const url = c.track.webpage_url || c.track.url;
    const key = url || norm(c.track.title);

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(c);
  }

  return out;
}

function normalizeTrackIdentity(track) {
  return {
    url: track?.url || track?.webpage_url || null,
    id: track?.id || track?.videoId || null,
    title: norm(track?.title || '')
  };
}

function isInRecentHistory(candidate, historyTracks = []) {
  const candidateIdentity = normalizeTrackIdentity({
    url: candidate.track.webpage_url || candidate.track.url,
    id: candidate.track.id || candidate.track.videoId,
    title: candidate.track.title
  });

  for (const track of historyTracks) {
    const historyIdentity = normalizeTrackIdentity(track);

    if (
      candidateIdentity.url &&
      historyIdentity.url &&
      candidateIdentity.url === historyIdentity.url
    ) {
      return true;
    }

    if (candidateIdentity.id && historyIdentity.id && candidateIdentity.id === historyIdentity.id) {
      return true;
    }

    if (
      candidateIdentity.title &&
      historyIdentity.title &&
      candidateIdentity.title === historyIdentity.title
    ) {
      return true;
    }
  }

  return false;
}

function filterRecentHistoryCandidates(candidates, historyTracks = []) {
  if (!historyTracks.length) return candidates;

  return candidates.filter((candidate) => !isInRecentHistory(candidate, historyTracks));
}

function autoplayTitle(track) {
  return String(track?.displayTitle || track?.title || '').trim();
}

async function applyEmbeddingDiversity(
  candidates,
  historyTracks = [],
  {
    embedTitles = embedMusicTitles,
    rejectThreshold = AUTOPLAY_SEMANTIC_REJECT_THRESHOLD,
    penaltyStart = AUTOPLAY_SEMANTIC_PENALTY_START
  } = {}
) {
  const recentTracks = historyTracks.slice(0, AUTOPLAY_RECENT_TRACK_LIMIT);
  if (!candidates.length || !recentTracks.length) return candidates;

  const candidateTitles = candidates.map((candidate) => autoplayTitle(candidate.track));
  const historyTitles = recentTracks.map(autoplayTitle).filter(Boolean);
  if (!historyTitles.length) return candidates;

  const vectors = await embedTitles([...candidateTitles, ...historyTitles]);
  const candidateVectors = vectors.slice(0, candidateTitles.length);
  const historyVectors = vectors.slice(candidateTitles.length);
  const scored = [];

  candidates.forEach((candidate, index) => {
    const candidateVector = candidateVectors[index];
    if (!candidateVector?.length) {
      scored.push({
        ...candidate,
        baseScore: candidate.score,
        diversityPenalty: 0,
        maxRecentSimilarity: null
      });
      return;
    }
    let maxRecentSimilarity = -1;
    for (const historyVector of historyVectors) {
      if (!historyVector?.length) continue;
      maxRecentSimilarity = Math.max(
        maxRecentSimilarity,
        dotProduct(candidateVector, historyVector)
      );
    }

    if (maxRecentSimilarity >= rejectThreshold) return;
    const penaltyRange = Math.max(rejectThreshold - penaltyStart, 0.01);
    const penaltyRatio = Math.max(
      0,
      Math.min(1, (maxRecentSimilarity - penaltyStart) / penaltyRange)
    );
    const diversityPenalty = Math.round(penaltyRatio * AUTOPLAY_MAX_DIVERSITY_PENALTY);
    scored.push({
      ...candidate,
      score: candidate.score - diversityPenalty,
      baseScore: candidate.score,
      diversityPenalty,
      maxRecentSimilarity
    });
  });

  const keptSimilarities = scored
    .map((candidate) => candidate.maxRecentSimilarity)
    .filter((similarity) => similarity != null);
  const bestSimilarity = keptSimilarities.length ? Math.max(...keptSimilarities) : null;
  console.log(
    `[Autoplay Embeddings] recent=${historyTitles.length}, candidates=${candidates.length}, ` +
      `rejected=${candidates.length - scored.length}, highest-kept-similarity=${bestSimilarity == null ? 'n/a' : bestSimilarity.toFixed(4)}`
  );
  return scored;
}

function selectCandidateRoulette(candidates) {
  if (!candidates.length) return null;
  if (candidates.length === 1) {
    return {
      ...candidates[0],
      selectionWeight: 1
    };
  }

  const scores = candidates.map((candidate) => Number(candidate.score || 0));
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  const minWeight = 0.15;

  const weighted = candidates.map((candidate) => {
    const score = Number(candidate.score || 0);

    let normalized = 1;

    if (maxScore !== minScore) {
      normalized = (score - minScore) / (maxScore - minScore);
    }

    const selectionWeight = minWeight + normalized * (1 - minWeight);

    return {
      ...candidate,
      selectionWeight
    };
  });

  const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.selectionWeight, 0);
  let roll = Math.random() * totalWeight;

  for (const candidate of weighted) {
    roll -= candidate.selectionWeight;

    if (roll <= 0) {
      return candidate;
    }
  }

  return weighted[weighted.length - 1];
}

function selectAutoplayCandidate(candidates, selectionMode = 'roulette') {
  if (!candidates.length) return null;

  if (selectionMode === 'best') {
    return candidates[0];
  }

  return selectCandidateRoulette(candidates);
}

async function findAutoplayCandidate(currentUrl, historyUrls = [], options = {}) {
  const history = new Set([currentUrl, ...historyUrls]);
  const historyTracks = options.historyTracks || [];
  const selectionMode = options.selectionMode || 'roulette';

  const metadata = await getYtMetadata(currentUrl);
  const parsed = guessArtistTrack(metadata);
  const confidence = metadataConfidence(metadata, parsed);

  let candidates = [];
  let usedLastFm = false;
  let usedFallback = false;

  if (LASTFM_API_KEY && parsed.confidence >= 65) {
    candidates = await getCandidatesFromLastFm(parsed, history);
    usedLastFm = candidates.length > 0;
  }

  if (candidates.length === 0) {
    candidates = await getCandidatesFromFallback(metadata, parsed, history);
    usedFallback = true;
  }

  candidates = filterRecentHistoryCandidates(dedupeCandidates(candidates), historyTracks);

  // Never restore exact recent-history matches. If Last.fm only produced items
  // from the recent loop, widen the search instead.
  if (candidates.length === 0 && usedLastFm) {
    const fallbackCandidates = await getCandidatesFromFallback(metadata, parsed, history);
    candidates = filterRecentHistoryCandidates(dedupeCandidates(fallbackCandidates), historyTracks);
    usedFallback = true;
  }

  try {
    candidates = await applyEmbeddingDiversity(candidates, historyTracks);
    if (candidates.length === 0 && usedLastFm && !usedFallback) {
      const fallbackCandidates = filterRecentHistoryCandidates(
        dedupeCandidates(await getCandidatesFromFallback(metadata, parsed, history)),
        historyTracks
      );
      candidates = await applyEmbeddingDiversity(fallbackCandidates, historyTracks);
    }
  } catch (error) {
    console.warn('[Autoplay Embeddings] Diversity scoring unavailable:', error.message);
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected = selectAutoplayCandidate(candidates, selectionMode);

  return {
    metadata,
    parsed,
    confidence,
    selected,
    candidates
  };
}

async function handleAutoplayCommand(client, message) {
  const guildId = resolveGuildIdForBoundAwareCommand(message);

  if (!guildId) {
    return message.reply('⚠️ There are no sessions.');
  }

  const session = sessions.get(guildId);
  if (!session) return message.reply('⚠️ There are no sessions.');

  if (!session.currentTrack) {
    return message.reply('⚠️ Nothing is currently playing.');
  }

  if (!session.currentTrack.url) {
    return message.reply('⚠️ Current track has no YouTube URL, autoplay cannot inspect it.');
  }

  await message.reply(`🔎 Finding autoplay candidate for **${session.currentTrack.title}**...`);

  const historyUrls = [
    ...(session.queue || []).map((t) => t.url).filter(Boolean),
    ...(session.loopQueue || []).map((t) => t.url).filter(Boolean)
  ];

  let result;
  try {
    result = await findAutoplayCandidate(session.currentTrack.url, historyUrls, {
      historyTracks: session.recentHistory || []
    });
  } catch (e) {
    console.error('[Autoplay Error]', e.stderr || e);
    return message.reply('❌ Autoplay lookup failed.');
  }

  const selected = result.selected;

  if (!selected) {
    return message.reply('❌ No reliable autoplay candidate found.');
  }

  const url = selected.track.webpage_url || selected.track.url;

  await message.reply(
    `✅ Autoplay selected:\n**${selected.track.title}**\nSource: ${selected.source}\nScore: ${selected.score}\n🔗 ${url}`
  );

  message.content = `p ${url}`;
  client.emit('messageCreate', message);
}

module.exports = {
  applyEmbeddingDiversity,
  filterRecentHistoryCandidates,
  handleAutoplayCommand,
  findAutoplayCandidate
};
