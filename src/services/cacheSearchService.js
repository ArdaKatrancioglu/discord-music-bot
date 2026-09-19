const { MusicEmbeddingIndex } = require('../core/musicEmbeddingIndex');

const NOISE_WORDS = new Set([
  'official',
  'music',
  'video',
  'audio',
  'lyrics',
  'lyric',
  'visualizer',
  'hd',
  '4k'
]);

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const embeddingIndex = new MusicEmbeddingIndex({
  threshold: parsePositiveNumber(process.env.CACHE_SEMANTIC_THRESHOLD, 0.72),
  batchSize: Math.floor(parsePositiveNumber(process.env.CACHE_EMBEDDING_BATCH_SIZE, 8))
});

function normalizedWords(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function comparableWords(value) {
  return normalizedWords(value).filter((word) => !NOISE_WORDS.has(word));
}

function findHighConfidenceTextMatch(query, tracks) {
  const queryWords = comparableWords(query);
  if (!queryWords.length) return null;
  const queryText = queryWords.join(' ');

  const candidates = tracks
    .map((track) => {
      const titleWords = comparableWords(track.displayTitle || track.title || track.titleSan);
      const titleText = titleWords.join(' ');
      if (titleText === queryText) return { track, score: 1 };

      if (queryWords.length < 2 || !queryWords.every((word) => titleWords.includes(word))) {
        return null;
      }
      const coverage = queryWords.length / Math.max(titleWords.length, 1);
      return coverage >= 0.6 ? { track, score: coverage } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.track || null;
}

async function searchCachedMusic(query, tracks) {
  const textMatch = findHighConfidenceTextMatch(query, tracks);
  if (textMatch) return { track: textMatch, source: 'keyword', score: 1 };

  const semantic = await embeddingIndex.search(query, tracks);
  return {
    track: semantic.match,
    source: semantic.match ? 'semantic' : null,
    score: semantic.bestScore
  };
}

function startEmbeddingBackfill(tracks) {
  return embeddingIndex.backfill(tracks);
}

function scheduleTrackEmbedding(track) {
  return embeddingIndex.scheduleTrack(track);
}

function embedMusicTitles(titles) {
  return embeddingIndex.embedTitles(titles);
}

module.exports = {
  comparableWords,
  embedMusicTitles,
  findHighConfidenceTextMatch,
  scheduleTrackEmbedding,
  searchCachedMusic,
  startEmbeddingBackfill
};
