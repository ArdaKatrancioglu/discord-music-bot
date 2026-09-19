const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BruteForceVectorIndex,
  MusicEmbeddingIndex,
  normalizeVector
} = require('../src/core/musicEmbeddingIndex');
const {
  findHighConfidenceTextMatch,
  selectSemanticCacheMatch
} = require('../src/services/cacheSearchService');

function fakeExtractorFactory(callLog) {
  const vectors = {
    'Imagine Dragons Enemy': [1, 0, 0],
    'Arctic Monkeys Do I Wanna Know Official Video': [0, 1, 0],
    'Autoplay Candidate': [0, 0.5, 0.5],
    'enemy song': [0.95, 0.05, 0],
    'completely unrelated': [0, 0, 1]
  };
  return async () => async (texts) => {
    callLog.push([...texts]);
    const rows = texts.map((text) => vectors[text]);
    return { dims: [rows.length, 3], data: Float32Array.from(rows.flat()) };
  };
}

test('brute-force index uses normalized dot product', () => {
  const index = new BruteForceVectorIndex();
  index.upsert({ key: 'close', embedding: [10, 0] });
  index.upsert({ key: 'far', embedding: [0, 2] });

  assert.deepEqual(
    index.search([4, 0], 2).map((item) => item.key),
    ['close', 'far']
  );
  assert.ok(Math.abs(index.search([4, 0], 1)[0].score - 1) < 1e-6);
  assert.deepEqual(Array.from(normalizeVector([0, 0])), [0, 0]);
});

test('backfill is persistent, batched, and restart-safe', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-embeddings-'));
  const storePath = path.join(temporaryDirectory, 'embeddings.jsonl');
  const tracks = [
    { id: 'enemy-id', title: 'Imagine Dragons Enemy' },
    { id: 'arctic-id', title: 'Arctic Monkeys Do I Wanna Know Official Video' }
  ];
  const firstCalls = [];
  const first = new MusicEmbeddingIndex({
    storePath,
    model: 'test-model',
    batchSize: 2,
    threshold: 0.8,
    createExtractor: fakeExtractorFactory(firstCalls)
  });

  try {
    assert.deepEqual(await first.backfill(tracks), { generated: 2, indexed: 2 });
    assert.equal(firstCalls.length, 1);
    assert.equal((await first.backfill(tracks)).generated, 0);
    assert.equal(firstCalls.length, 1, 'existing vectors must not be regenerated');

    await first.embedTitles(['Imagine Dragons Enemy']);
    assert.equal(firstCalls.length, 1, 'generic title embedding must reuse the persistent store');
    await first.embedTitles(['Autoplay Candidate']);
    await first.embedTitles(['Autoplay Candidate']);
    assert.equal(firstCalls.length, 2, 'transient autoplay titles must be embedded only once');

    const semanticHit = await first.search('enemy song', tracks);
    assert.equal(semanticHit.match.id, 'enemy-id');
    const rejected = await first.search('completely unrelated', tracks);
    assert.equal(rejected.match, null, 'nearest result below threshold must be rejected');

    const restartCalls = [];
    const restarted = new MusicEmbeddingIndex({
      storePath,
      model: 'test-model',
      batchSize: 1,
      createExtractor: fakeExtractorFactory(restartCalls)
    });
    assert.equal((await restarted.backfill(tracks)).generated, 0);
    assert.equal(restartCalls.length, 0, 'a restart must reuse completed records');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('high-confidence keyword lookup ignores common video-title noise', () => {
  const expected = {
    id: 'arctic-id',
    title: 'Arctic Monkeys - Do I Wanna Know? (Official Video)'
  };
  const tracks = [expected, { id: 'other', title: 'Another Song' }];

  assert.equal(findHighConfidenceTextMatch('Arctic Monkeys do I wanna know', tracks), expected);
  assert.equal(findHighConfidenceTextMatch('unrelated words', tracks), null);
});

test('semantic cache confidence rejects a high-scoring unrelated short title', () => {
  const decision = selectSemanticCacheMatch(
    'dar ankara',
    [
      { score: 0.818, track: { title: 'Bak' } },
      { score: 0.77, track: { title: 'Another Song' } }
    ],
    { overlapThreshold: 0.84, strictThreshold: 0.9, strictMinimumMargin: 0.05 }
  );

  assert.equal(decision.match, null);
  assert.equal(decision.hasTokenOverlap, false);
  assert.equal(decision.reason, 'below threshold');
});

test('semantic cache confidence keeps strong overlap and unambiguous cross-language matches', () => {
  const overlapping = selectSemanticCacheMatch('house rising sun', [
    { score: 0.87, track: { title: 'House of the Rising Sun' } },
    { score: 0.81, track: { title: 'Unrelated' } }
  ]);
  assert.equal(overlapping.match.title, 'House of the Rising Sun');

  const crossLanguage = selectSemanticCacheMatch('my enemy', [
    { score: 0.92, track: { title: 'Düşmanım' } },
    { score: 0.7, track: { title: 'Başka Şarkı' } }
  ]);
  assert.equal(crossLanguage.match.title, 'Düşmanım');

  const ambiguous = selectSemanticCacheMatch('my enemy', [
    { score: 0.92, track: { title: 'Düşmanım' } },
    { score: 0.89, track: { title: 'Rakibim' } }
  ]);
  assert.equal(ambiguous.match, null);
  assert.equal(ambiguous.reason, 'ambiguous nearest neighbors');
});
