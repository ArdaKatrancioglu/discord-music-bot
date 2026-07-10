const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TITLE_SIMILARITY_STRENGTH,
  DEFAULT_TITLE_SIMILARITY_EXPONENT,
  DEFAULT_TITLE_SIMILARITY_REJECT_THRESHOLD,
  parseTitleSimilarityStrength,
  parseTitleSimilarityExponent,
  parseTitleSimilarityRejectThreshold
} = require('../src/config/autoplayConfig');

test('title similarity strength defaults to 0.5 and is clamped to a safe range', () => {
  assert.equal(DEFAULT_TITLE_SIMILARITY_STRENGTH, 0.5);
  assert.equal(parseTitleSimilarityStrength(undefined), 0.5);
  assert.equal(parseTitleSimilarityStrength('1'), 1);
  assert.equal(parseTitleSimilarityStrength('2'), 1);
  assert.equal(parseTitleSimilarityStrength('-1'), 0);
  assert.equal(parseTitleSimilarityStrength('invalid'), 0.5);
});

test('title similarity exponent and reject threshold have safe configurable ranges', () => {
  assert.equal(DEFAULT_TITLE_SIMILARITY_EXPONENT, 4);
  assert.equal(parseTitleSimilarityExponent(undefined), 4);
  assert.equal(parseTitleSimilarityExponent('8'), 8);
  assert.equal(parseTitleSimilarityExponent('-2'), 0);
  assert.equal(parseTitleSimilarityExponent('99'), 20);

  assert.equal(DEFAULT_TITLE_SIMILARITY_REJECT_THRESHOLD, 0.95);
  assert.equal(parseTitleSimilarityRejectThreshold(undefined), 0.95);
  assert.equal(parseTitleSimilarityRejectThreshold('0.9'), 0.9);
  assert.equal(parseTitleSimilarityRejectThreshold('-1'), 0);
  assert.equal(parseTitleSimilarityRejectThreshold('2'), 1);
});
