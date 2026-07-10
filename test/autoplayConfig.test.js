const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TITLE_SIMILARITY_STRENGTH,
  parseTitleSimilarityStrength
} = require('../src/config/autoplayConfig');

test('title similarity strength defaults to 0.5 and is clamped to a safe range', () => {
  assert.equal(DEFAULT_TITLE_SIMILARITY_STRENGTH, 0.5);
  assert.equal(parseTitleSimilarityStrength(undefined), 0.5);
  assert.equal(parseTitleSimilarityStrength('1'), 1);
  assert.equal(parseTitleSimilarityStrength('2'), 1);
  assert.equal(parseTitleSimilarityStrength('-1'), 0);
  assert.equal(parseTitleSimilarityStrength('invalid'), 0.5);
});
