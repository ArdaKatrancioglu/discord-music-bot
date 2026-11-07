const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyLexicalDiversity,
  filterRecentHistoryCandidates
} = require('../src/services/autoplayService');

test('autoplay preserves ID exclusions and uses lexical diversity without a model', async () => {
  const history = [{ id: 'recent', title: 'Do I Wanna Know?', artist: 'Arctic Monkeys' }];
  const candidates = [
    { score: 100, track: { id: 'recent', title: 'Do I Wanna Know?', artist: 'Arctic Monkeys' } },
    { score: 95, track: { id: 'copy', title: 'Do I Wanna Know?', artist: 'Arctic Monkeys' } },
    {
      score: 90,
      track: { id: 'similar', title: 'Do I Wanna Know More', artist: 'Arctic Monkeys' }
    },
    { score: 80, track: { id: 'new', title: 'Completely Different', artist: 'Another Artist' } }
  ];
  assert.equal(filterRecentHistoryCandidates(candidates, history).length, 2);
  const result = await applyLexicalDiversity(candidates.slice(1), history, {
    rejectThreshold: 0.99,
    penaltyStart: 0.5
  });
  assert.deepEqual(
    result.map((candidate) => candidate.track.id),
    ['similar', 'new']
  );
  assert.ok(result[0].diversityPenalty > 0);
  assert.equal(result[1].diversityPenalty, 0);
  assert.equal(result[1].score, result[1].baseScore);
});
