const TITLE_METADATA_GROUP_PATTERN =
  /\b(?:official|lyrics?|audio|video|hd|4k|visuali[sz]er|clean|explicit|remaster(?:ed)?|live|acoustic|akustik|canl[ıi]|radio\s+edit|mono|stereo)\b/iu;
const TRAILING_TITLE_METADATA_PATTERN =
  /(?:\s+|\s*[-|]\s*)(?:official(?:\s+(?:music\s+)?video|\s+audio)?|lyrics?|lyric\s+video|audio|video|hd|4k|visuali[sz]er|clean|explicit|remaster(?:ed)?(?:\s+\d{2,4})?|live(?:\s+at\s+.+)?|acoustic|akustik|canl[ıi]|radio\s+edit|mono|stereo)\s*$/iu;
const FEATURING_PATTERN = /\b(?:feat(?:uring)?|ft)\.?\s+[^()[\]{}|]+/giu;
const KANA_ROMAJI = {
  'キャ': 'kya', 'キュ': 'kyu', 'キョ': 'kyo', 'シャ': 'sha', 'シュ': 'shu', 'ショ': 'sho',
  'チャ': 'cha', 'チュ': 'chu', 'チョ': 'cho', 'ニャ': 'nya', 'ニュ': 'nyu', 'ニョ': 'nyo',
  'ヒャ': 'hya', 'ヒュ': 'hyu', 'ヒョ': 'hyo', 'ミャ': 'mya', 'ミュ': 'myu', 'ミョ': 'myo',
  'リャ': 'rya', 'リュ': 'ryu', 'リョ': 'ryo', 'ギャ': 'gya', 'ギュ': 'gyu', 'ギョ': 'gyo',
  'ジャ': 'ja', 'ジュ': 'ju', 'ジョ': 'jo', 'ビャ': 'bya', 'ビュ': 'byu', 'ビョ': 'byo',
  'ピャ': 'pya', 'ピュ': 'pyu', 'ピョ': 'pyo', 'ティ': 'ti', 'ディ': 'di', 'ファ': 'fa',
  'フィ': 'fi', 'フェ': 'fe', 'フォ': 'fo', 'ウィ': 'wi', 'ウェ': 'we', 'ウォ': 'wo',
  'シ': 'shi', 'チ': 'chi', 'ツ': 'tsu', 'フ': 'fu', 'ジ': 'ji',
  'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
  'カ': 'ka', 'キ': 'ki', 'ク': 'ku', 'ケ': 'ke', 'コ': 'ko',
  'サ': 'sa', 'ス': 'su', 'セ': 'se', 'ソ': 'so',
  'タ': 'ta', 'テ': 'te', 'ト': 'to', 'ナ': 'na', 'ニ': 'ni', 'ヌ': 'nu', 'ネ': 'ne', 'ノ': 'no',
  'ハ': 'ha', 'ヒ': 'hi', 'ヘ': 'he', 'ホ': 'ho', 'マ': 'ma', 'ミ': 'mi', 'ム': 'mu', 'メ': 'me', 'モ': 'mo',
  'ヤ': 'ya', 'ユ': 'yu', 'ヨ': 'yo', 'ラ': 'ra', 'リ': 'ri', 'ル': 'ru', 'レ': 're', 'ロ': 'ro',
  'ワ': 'wa', 'ヲ': 'o', 'ン': 'n', 'ガ': 'ga', 'ギ': 'gi', 'グ': 'gu', 'ゲ': 'ge', 'ゴ': 'go',
  'ザ': 'za', 'ズ': 'zu', 'ゼ': 'ze', 'ゾ': 'zo', 'ダ': 'da', 'ヂ': 'ji', 'ヅ': 'zu', 'デ': 'de', 'ド': 'do',
  'バ': 'ba', 'ビ': 'bi', 'ブ': 'bu', 'ベ': 'be', 'ボ': 'bo', 'パ': 'pa', 'ピ': 'pi', 'プ': 'pu', 'ペ': 'pe', 'ポ': 'po'
};

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

function romanizeKana(text) {
  const katakana = String(text || '').replace(/[ぁ-ゖ]/gu, (character) =>
    String.fromCodePoint(character.codePointAt(0) + 0x60)
  );
  let output = '';

  for (let index = 0; index < katakana.length; index += 1) {
    const pair = katakana.slice(index, index + 2);
    if (KANA_ROMAJI[pair]) {
      output += KANA_ROMAJI[pair];
      index += 1;
      continue;
    }

    const character = katakana[index];
    if (character === 'ッ') {
      const next = KANA_ROMAJI[katakana.slice(index + 1, index + 3)] || KANA_ROMAJI[katakana[index + 1]];
      output += next?.[0] || '';
    } else if (character === 'ー') {
      output += output.match(/[aeiou]$/u)?.[0] || '';
    } else {
      output += KANA_ROMAJI[character] || character;
    }
  }

  return output;
}

function phoneticTitleKey(title) {
  return romanizeKana(title)
    .replace(/[^a-z]/giu, '')
    .toLowerCase()
    .replace(/[aeiouywh]/gu, '')
    .replace(/l/gu, 'r')
    .replace(/(.)\1+/gu, '$1');
}

function hasArtistEvidence(candidateTitle, referenceArtist, candidateArtist) {
  const artist = normalizeAutoplayTitle(referenceArtist);
  if (!artist) return false;

  const candidateArtistNormalized = normalizeAutoplayTitle(candidateArtist);
  const candidateWithArtist = normalizeAutoplayTitle(candidateTitle);
  return candidateArtistNormalized === artist || candidateWithArtist.split(' ').includes(artist);
}

function calculateTitleSimilarity(referenceTitle, candidateTitle, options = {}) {
  const reference = normalizeAutoplayTitle(referenceTitle, {
    artist: options.referenceArtist
  });
  const candidate = normalizeAutoplayTitle(candidateTitle, {
    artist: options.candidateArtist || options.referenceArtist
  });

  if (!reference || !candidate) return 0;
  if (reference === candidate) return 1;

  const lexicalSimilarity = Math.min(
    1,
    Math.max(tokenDiceSimilarity(reference, candidate), bigramDiceSimilarity(reference, candidate))
  );

  const referenceHasKana = /[ぁ-ゖァ-ヺ]/u.test(reference);
  const candidateHasKana = /[ぁ-ゖァ-ヺ]/u.test(candidate);
  const referencePhoneticKey = phoneticTitleKey(reference);
  const candidatePhoneticKey = phoneticTitleKey(candidate);
  const isCrossScriptPhoneticMatch =
    referenceHasKana !== candidateHasKana &&
    referencePhoneticKey.length >= 2 &&
    referencePhoneticKey === candidatePhoneticKey &&
    hasArtistEvidence(candidateTitle, options.referenceArtist, options.candidateArtist);

  return isCrossScriptPhoneticMatch ? Math.max(0.98, lexicalSimilarity) : lexicalSimilarity;
}

function exponentialPenalty(similarity, exponent) {
  if (similarity <= 0) return 0;
  if (similarity >= 1) return 1;
  if (!exponent) return similarity;

  return Math.expm1(exponent * similarity) / Math.expm1(exponent);
}

function applyTitleSimilarityPenalty(baseScore, referenceTitle, candidateTitle, strength, options = {}) {
  const safeBaseScore = Math.max(0, Number(baseScore) || 0);
  const safeStrength = Math.min(Math.max(Number(strength) || 0, 0), 1);
  const titleSimilarity = calculateTitleSimilarity(referenceTitle, candidateTitle, options);
  const titleSimilarityExponent = Math.min(
    Math.max(Number(options.exponent) || 0, 0),
    20
  );
  const titleSimilarityPenalty = exponentialPenalty(titleSimilarity, titleSimilarityExponent);
  const titleSimilarityMultiplier = Math.max(0, 1 - safeStrength * titleSimilarityPenalty);
  const score = Math.max(0, safeBaseScore * titleSimilarityMultiplier);

  return {
    baseScore: safeBaseScore,
    titleSimilarity,
    titleSimilarityPenalty,
    titleSimilarityExponent,
    titleSimilarityMultiplier,
    score
  };
}

module.exports = {
  normalizeAutoplayTitle,
  calculateTitleSimilarity,
  exponentialPenalty,
  applyTitleSimilarityPenalty
};
