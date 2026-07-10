const TITLE_METADATA_GROUP_PATTERN =
  /\b(?:official|lyrics?|audio|video|hd|4k|visuali[sz]er|clean|explicit|remaster(?:ed)?|live|acoustic|akustik|canl[ıi]|radio\s+edit|mono|stereo)\b/iu;
const TRAILING_TITLE_METADATA_PATTERN =
  /(?:\s+|\s*[-|]\s*)(?:official(?:\s+(?:music\s+)?video|\s+audio)?|lyrics?|lyric\s+video|audio|video|hd|4k|visuali[sz]er|clean|explicit|remaster(?:ed)?(?:\s+\d{2,4})?|live(?:\s+at\s+.+)?|acoustic|akustik|canl[ıi]|radio\s+edit|mono|stereo)\s*$/iu;
const FEATURING_PATTERN = /\b(?:feat(?:uring)?|ft)\.?\s+[^()[\]{}|]+/giu;

function unicodeCaseFold(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ');
}

function stripLeadingArtist(title, artist) {
  if (!artist) return title;

  const foldedArtist = unicodeCaseFold(artist)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const foldedTitle = unicodeCaseFold(title);

  for (const separator of [' - ', ' – ', ' — ', ' | ', ': ']) {
    const index = foldedTitle.indexOf(separator);
    if (index === -1) continue;

    const prefix = foldedTitle
      .slice(0, index)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (prefix === foldedArtist) return foldedTitle.slice(index + separator.length);
  }

  return title;
}

function normalizeAutoplayTitle(title, { artist } = {}) {
  if (title === undefined || title === null) return '';

  let normalized = unicodeCaseFold(title).replace(/&(?:amp|#38);/g, '&');
  normalized = stripLeadingArtist(normalized, artist);

  normalized = normalized
    .replace(FEATURING_PATTERN, ' ')
    .replace(/[([{][^()[\]{}]*[)\]}]/gu, (group) =>
      TITLE_METADATA_GROUP_PATTERN.test(group) ? ' ' : group
    );

  return normalized
    .replace(TRAILING_TITLE_METADATA_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenDiceSimilarity(left, right) {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));

  if (!leftTokens.size || !rightTokens.size) return 0;

  let intersectionSize = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersectionSize += 1;
  }

  return (2 * intersectionSize) / (leftTokens.size + rightTokens.size);
}

function bigramDiceSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const counts = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }

  let matches = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const available = counts.get(bigram) || 0;
    if (!available) continue;

    matches += 1;
    counts.set(bigram, available - 1);
  }

  return (2 * matches) / (left.length + right.length - 2);
}

function calculateTitleSimilarity(referenceTitle, candidateTitle, options = {}) {
  const reference = normalizeAutoplayTitle(referenceTitle, {
    artist: options.referenceArtist
  });
  const candidate = normalizeAutoplayTitle(candidateTitle, {
    artist: options.candidateArtist
  });

  if (!reference || !candidate) return 0;
  if (reference === candidate) return 1;

  return Math.min(
    1,
    Math.max(tokenDiceSimilarity(reference, candidate), bigramDiceSimilarity(reference, candidate))
  );
}

function applyTitleSimilarityPenalty(baseScore, referenceTitle, candidateTitle, strength, options) {
  const safeBaseScore = Math.max(0, Number(baseScore) || 0);
  const safeStrength = Math.min(Math.max(Number(strength) || 0, 0), 1);
  const titleSimilarity = calculateTitleSimilarity(referenceTitle, candidateTitle, options);
  const titleSimilarityMultiplier = Math.max(0, 1 - safeStrength * titleSimilarity);
  const score = Math.max(0, safeBaseScore * titleSimilarityMultiplier);

  return {
    baseScore: safeBaseScore,
    titleSimilarity,
    titleSimilarityMultiplier,
    score
  };
}

module.exports = {
  normalizeAutoplayTitle,
  calculateTitleSimilarity,
  applyTitleSimilarityPenalty
};
