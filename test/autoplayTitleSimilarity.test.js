const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAutoplayTitle,
  calculateTitleSimilarity,
  applyTitleSimilarityPenalty
} = require('../src/utils/autoplayTitleSimilarity');

test('identical titles receive the maximum configured penalty', () => {
  const result = applyTitleSimilarityPenalty(100, 'Midnight City', 'Midnight City', 0.5);

  assert.equal(result.titleSimilarity, 1);
  assert.equal(result.titleSimilarityMultiplier, 0.5);
  assert.equal(result.score, 50);
});

test('case, punctuation and presentation metadata do not hide an identical title', () => {
  const similarity = calculateTitleSimilarity(
    'Beyoncé - Halo (Official Video)',
    'BEYONCÉ: HALO!!! [Remastered 2024]',
    { referenceArtist: 'Beyoncé', candidateArtist: 'Beyoncé' }
  );

  assert.equal(similarity, 1);
});

test('completely different titles keep their base score', () => {
  const result = applyTitleSimilarityPenalty(80, 'Midnight City', 'Ocean Eyes', 0.5);

  assert.equal(result.titleSimilarity, 0);
  assert.equal(result.titleSimilarityMultiplier, 1);
  assert.equal(result.score, 80);
});

test('titles with shared words receive a partial rather than an exact-title penalty', () => {
  const similarity = calculateTitleSimilarity('Dancing in the Dark', 'Dancing in the Moonlight');

  assert.ok(similarity > 0);
  assert.ok(similarity < 1);
});

test('missing titles are treated as unknown and do not reduce the score', () => {
  for (const [referenceTitle, candidateTitle] of [
    ['', 'Some Song'],
    ['Some Song', null],
    [undefined, undefined]
  ]) {
    const result = applyTitleSimilarityPenalty(75, referenceTitle, candidateTitle, 0.5);

    assert.equal(result.titleSimilarity, 0);
    assert.equal(result.score, 75);
  }
});

test('strength 1 reproduces score * (1 - similarity) and never goes negative', () => {
  const result = applyTitleSimilarityPenalty(100, 'Same Song', 'Same Song', 1);
  const negative = applyTitleSimilarityPenalty(-20, 'A', 'B', 1);

  assert.equal(result.score, 0);
  assert.equal(result.titleSimilarityMultiplier, 0);
  assert.equal(negative.score, 0);
});

test('normalization handles Unicode, whitespace, featuring and metadata noise', () => {
  assert.equal(
    normalizeAutoplayTitle('  STRAẞE…  (Live) [Official Video] feat. Guest  '),
    'strasse'
  );

  assert.equal(normalizeAutoplayTitle('Live Forever'), 'live forever');
});
