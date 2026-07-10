const DEFAULT_TITLE_SIMILARITY_STRENGTH = 0.5;
const DEFAULT_TITLE_SIMILARITY_EXPONENT = 4;
const DEFAULT_TITLE_SIMILARITY_REJECT_THRESHOLD = 0.95;

function parseTitleSimilarityStrength(value, fallback = DEFAULT_TITLE_SIMILARITY_STRENGTH) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, 0), 1);
}

function parseTitleSimilarityExponent(value, fallback = DEFAULT_TITLE_SIMILARITY_EXPONENT) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, 0), 20);
}

function parseTitleSimilarityRejectThreshold(
  value,
  fallback = DEFAULT_TITLE_SIMILARITY_REJECT_THRESHOLD
) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, 0), 1);
}

const autoplayConfig = Object.freeze({
  titleSimilarityStrength: parseTitleSimilarityStrength(
    process.env.AUTOPLAY_TITLE_SIMILARITY_STRENGTH
  ),
  titleSimilarityExponent: parseTitleSimilarityExponent(
    process.env.AUTOPLAY_TITLE_SIMILARITY_EXPONENT
  ),
  titleSimilarityRejectThreshold: parseTitleSimilarityRejectThreshold(
    process.env.AUTOPLAY_TITLE_SIMILARITY_REJECT_THRESHOLD
  )
});

module.exports = {
  DEFAULT_TITLE_SIMILARITY_STRENGTH,
  DEFAULT_TITLE_SIMILARITY_EXPONENT,
  DEFAULT_TITLE_SIMILARITY_REJECT_THRESHOLD,
  parseTitleSimilarityStrength,
  parseTitleSimilarityExponent,
  parseTitleSimilarityRejectThreshold,
  autoplayConfig
};
