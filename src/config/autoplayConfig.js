const DEFAULT_TITLE_SIMILARITY_STRENGTH = 0.5;

function parseTitleSimilarityStrength(value, fallback = DEFAULT_TITLE_SIMILARITY_STRENGTH) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, 0), 1);
}

const autoplayConfig = Object.freeze({
  titleSimilarityStrength: parseTitleSimilarityStrength(
    process.env.AUTOPLAY_TITLE_SIMILARITY_STRENGTH
  )
});

module.exports = {
  DEFAULT_TITLE_SIMILARITY_STRENGTH,
  parseTitleSimilarityStrength,
  autoplayConfig
};
