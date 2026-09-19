const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyEmbeddingDiversity,
  filterRecentHistoryCandidates
} = require('../src/services/autoplayService');

test('autoplay never keeps an exact track from recent history', () => {
  const candidates = [
    {
      score: 90,
      track: { id: 'recent-id', title: 'Recent Song', webpage_url: 'https://youtu.be/recent' }
    },
    {
      score: 80,
      track: { id: 'new-id', title: 'New Song', webpage_url: 'https://youtu.be/new' }
    }
  ];
  const history = [{ id: 'recent-id', title: 'Recent Song', url: 'https://youtu.be/recent' }];

  assert.deepEqual(
    filterRecentHistoryCandidates(candidates, history).map((candidate) => candidate.track.id),
    ['new-id']
  );
});

test('embedding diversity rejects near-duplicates and penalizes similar candidates', async () => {
  const vectors = new Map([
    ['Near Duplicate', [1, 0]],
    ['Somewhat Similar', [0.8, 0.6]],
    ['Different Direction', [0, 1]],
    ['Recently Played', [1, 0]]
  ]);
  const embedTitles = async (titles) =>
    titles.map((title) => Float32Array.from(vectors.get(title)));
  const candidates = [
    { score: 100, track: { title: 'Near Duplicate' } },
    { score: 90, track: { title: 'Somewhat Similar' } },
    { score: 80, track: { title: 'Different Direction' } }
  ];

  const scored = await applyEmbeddingDiversity(candidates, [{ title: 'Recently Played' }], {
    embedTitles,
    rejectThreshold: 0.86,
    penaltyStart: 0.45
  });

  assert.deepEqual(
    scored.map((candidate) => candidate.track.title),
    ['Somewhat Similar', 'Different Direction']
  );
  assert.ok(Math.abs(scored[0].maxRecentSimilarity - 0.8) < 1e-6);
  assert.ok(scored[0].diversityPenalty > 0);
  assert.equal(scored[1].diversityPenalty, 0);
  assert.equal(scored[1].score, scored[1].baseScore);
});

test('embedding diversity only considers the five most recent tracks', async () => {
  const requestedTitles = [];
  const embedTitles = async (titles) => {
    requestedTitles.push(...titles);
    return titles.map(() => Float32Array.from([0, 1]));
  };

  await applyEmbeddingDiversity(
    [{ score: 10, track: { title: 'Candidate' } }],
    Array.from({ length: 7 }, (_, index) => ({ title: `History ${index + 1}` })),
    { embedTitles }
  );

  assert.deepEqual(requestedTitles, [
    'Candidate',
    'History 1',
    'History 2',
    'History 3',
    'History 4',
    'History 5'
  ]);
});
