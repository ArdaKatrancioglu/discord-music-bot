const path = require('path');

let fuzzyPromise;
function fuzzyScorers() {
  fuzzyPromise ||= Promise.all([
    import('rapidfuzz-js/fuzz'),
    import('rapidfuzz-js/jaro-winkler')
  ]).then(([fuzz, jaro]) => ({
    ...fuzz,
    tokenRatio: (left, right) =>
      Math.max(fuzz.ratio(left, right), 97 * jaro.normalizedSimilarity(left, right))
  }));
  return fuzzyPromise;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/(?<=\p{L})['’](?=\p{L})/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function trackKey(track) {
  if (track.id) return `id:${track.id}`;
  if (track.filePath) return `path:${path.resolve(track.filePath)}`;
  return `title:${track.titleSan || track.title}`;
}

function trackFields(track) {
  return {
    title: normalizeText(track.title || track.videoTitle || track.displayTitle || track.titleSan),
    artist: normalizeText(track.artist)
  };
}

function tokenSimilarity(query, token, ratio) {
  if (query === token) return 1;
  if (query.length >= 2 && token.startsWith(query)) return 0.94;
  if (query.length >= 2 && token.includes(query)) return 0.9;
  if (Math.min(query.length, token.length) < 3) return 0;
  return ratio(query, token) / 100;
}

function scoreTrack(
  queryTokens,
  fields,
  documentFrequency,
  documentCount,
  ratio,
  phrase = queryTokens.join(' ')
) {
  const titleTokens = [...new Set(tokenize(fields.title))];
  const artistTokens = [...new Set(tokenize(fields.artist))];
  const weights = queryTokens.map(
    (token) => 1 + Math.log(1 + (documentCount + 0.5) / ((documentFrequency.get(token) || 0) + 0.5))
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const targets = [
    ...titleTokens.map((token, index) => ({ field: 'title', token, slots: [`title:${index}`] })),
    ...artistTokens.map((token, index) => ({ field: 'artist', token, slots: [`artist:${index}`] }))
  ];
  // Join adjacent tokens only for an exact compact query token (K/DA -> kda,
  // POP/STARS -> popstars). The consumed slots still cannot match twice.
  for (const [field, tokens] of [
    ['title', titleTokens],
    ['artist', artistTokens]
  ]) {
    for (let start = 0; start < tokens.length - 1; start++) {
      for (let length = 2; length <= 3 && start + length <= tokens.length; length++) {
        const token = tokens.slice(start, start + length).join('');
        if (queryTokens.includes(token))
          targets.push({
            field,
            token,
            slots: Array.from({ length }, (_, index) => `${field}:${start + index}`)
          });
      }
    }
  }
  const edges = [];
  queryTokens.forEach((query, queryIndex) =>
    targets.forEach((target, targetIndex) => {
      const similarity = tokenSimilarity(query, target.token, ratio);
      if (similarity >= 0.68)
        edges.push({ queryIndex, targetIndex, similarity, field: target.field });
    })
  );
  edges.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      weights[b.queryIndex] - weights[a.queryIndex] ||
      a.queryIndex - b.queryIndex ||
      a.targetIndex - b.targetIndex
  );
  const usedQueries = new Set(),
    usedTargets = new Set();
  const assigned = [];
  for (const edge of edges) {
    if (
      usedQueries.has(edge.queryIndex) ||
      targets[edge.targetIndex].slots.some((slot) => usedTargets.has(slot))
    )
      continue;
    usedQueries.add(edge.queryIndex);
    for (const slot of targets[edge.targetIndex].slots) usedTargets.add(slot);
    assigned.push(edge);
  }
  let weightedQuality = 0,
    matchedWeight = 0;
  const fieldWeights = { title: 0, artist: 0 },
    fieldQuality = { title: 0, artist: 0 },
    counts = { title: 0, artist: 0 };
  for (const match of assigned) {
    const weight = weights[match.queryIndex];
    matchedWeight += weight;
    weightedQuality += weight * match.similarity;
    fieldWeights[match.field] += weight;
    fieldQuality[match.field] += weight * match.similarity;
    counts[match.field] += targets[match.targetIndex].slots.length;
  }
  const coverage = totalWeight ? matchedWeight / totalWeight : 0;
  const quality = totalWeight ? weightedQuality / totalWeight : 0;
  let fieldRelevance = 0;
  for (const field of ['title', 'artist']) {
    const length = field === 'title' ? titleTokens.length : artistTokens.length;
    if (!fieldWeights[field]) continue;
    const relevance = fieldQuality[field] / fieldWeights[field];
    const completeness = counts[field] / Math.max(1, length);
    fieldRelevance +=
      (fieldWeights[field] / matchedWeight) * relevance * (0.8 + 0.2 * completeness);
  }
  const exactPhrase =
    phrase === fields.title ||
    phrase === fields.artist ||
    phrase === `${fields.title} ${fields.artist}`.trim() ||
    phrase === `${fields.artist} ${fields.title}`.trim();
  const partialPhrase = [fields.title, fields.artist].some((field) =>
    ` ${field} `.includes(` ${phrase} `)
  );
  const phraseBonus = exactPhrase ? 0.1 : partialPhrase ? 0.045 : 0;
  const unmatchedPenalty = (1 - coverage) * 0.28;
  const score = Math.max(
    0,
    Math.min(
      1,
      0.65 * quality + 0.15 * fieldRelevance + 0.1 * coverage + phraseBonus - unmatchedPenalty
    )
  );
  return {
    score,
    quality,
    coverage,
    exactPhrase,
    fieldWeights: {
      title: matchedWeight ? fieldWeights.title / matchedWeight : 0,
      artist: matchedWeight ? fieldWeights.artist / matchedWeight : 0
    },
    unmatchedTokens: queryTokens.filter((_, index) => !usedQueries.has(index))
  };
}

function selectConfidentMatch(candidates, { threshold = 0.8, minimumMargin = 0.045 } = {}) {
  const best = candidates[0],
    second = candidates[1];
  const margin = best ? best.score - (second?.score || 0) : 0;
  const absolute = best && best.score >= threshold && best.quality >= 0.8 && best.coverage >= 0.85;
  const confident = Boolean(absolute && margin >= minimumMargin);
  return {
    match: confident ? best.track : null,
    bestScore: best?.score ?? null,
    margin,
    confident,
    reason: !best
      ? 'no candidates'
      : !absolute
        ? 'low match quality'
        : !confident
          ? 'ambiguous candidates'
          : 'accepted'
  };
}

module.exports = {
  normalizeText,
  tokenize,
  trackKey,
  trackFields,
  fuzzyScorers,
  scoreTrack,
  selectConfidentMatch
};
