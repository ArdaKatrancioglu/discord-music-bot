const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MusicSearchIndex } = require('../src/core/musicSearchIndex');
const { normalizeText, tokenize } = require('../src/core/searchText');

const songs = [
  { id: 'arctic', title: 'Do I Wanna Know?', artist: 'Arctic Monkeys' },
  { id: 'enemy', title: 'Enemy', artist: 'Imagine Dragons, JID' },
  { id: 'edis', title: 'Yalan', artist: 'Edis' },
  { id: 'turkish', title: 'İşte Öyle Bir Şey', artist: 'Erol Evgin' },
  { id: 'nonmusic', title: 'A documentary about ancient history', artist: null },
  { id: 'version', title: 'Enemy live remix cover', artist: 'Another Band' }
];

test('normalization preserves meaningful words and multilingual letters', () => {
  assert.equal(normalizeText('  İŞTE – ÖYLE! BİR ŞEY '), 'iste oyle bir sey');
  assert.equal(normalizeText('Don\'t Stop'), 'dont stop');
  assert.deepEqual(tokenize('你好 世界'), ['你好', '世界']);
  assert.deepEqual(tokenize('Enemy (Live Remix Cover)'), ['enemy', 'live', 'remix', 'cover']);
});

test('field-aware retrieval handles order, artist-only queries, partials, misspellings and non-music', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  for (const [query, expected] of [
    ['Arctic Monkeys do I wanna know', 'arctic'],
    ['know wanna monkeys arctic', 'arctic'],
    ['arctci monkys wanna', 'arctic'],
    ['edis yalan', 'edis'],
    ['edsi yalan', 'edis'],
    ['edsi', 'edis'],
    ['arct monk wanna', 'arctic'],
    ['Erol Evgin', 'turkish'],
    ['iste oyle bir sey', 'turkish'],
    ['ancient history documentary', 'nonmusic'],
    ['Enemy JID Imagine Dragons', 'enemy'],
    ['live remix cover another band', 'version']
  ]) {
    const result = await index.search(query, songs);
    assert.equal(result.match?.id, expected, `${query}: ${JSON.stringify(result)}`);
    assert.ok(result.candidateCount <= 100);
  }
});

test('confidence rejects weak, uncovered and ambiguous nearest candidates', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  for (const query of [
    'totally unrelated song',
    'yalan edis completely unrelated words',
    '!!!',
    ''
  ]) {
    assert.equal((await index.search(query, songs)).match, null, query);
  }
  const ambiguous = await index.search('Same Song', [
    { id: 'one', title: 'Same Song', artist: 'One' },
    { id: 'two', title: 'Same Song', artist: 'Two' }
  ]);
  assert.equal(ambiguous.match, null);
  assert.equal(ambiguous.reason, 'ambiguous candidates');
  assert.equal(ambiguous.margin, 0);
  assert.equal(ambiguous.candidates.length, 2);
});

test('query assignment is field-aware and unmatched tokens lower scores', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  const complete = await index.search('Arctic Monkeys wanna know', songs);
  assert.ok(complete.candidates[0].fieldWeights.title > 0);
  assert.ok(complete.candidates[0].fieldWeights.artist > 0);
  const missing = await index.search('Arctic Monkeys wanna know bananas', songs);
  assert.ok(missing.bestScore < complete.bestScore);
  assert.ok(missing.candidates[0].unmatchedTokens.includes('bananas'));
  const artist = await index.search('Arctic Monkeys', songs);
  assert.equal(artist.candidates[0].fieldWeights.artist, 1);
});

test('index updates, deletion and restart reuse current metadata without modifying audio', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-search-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'search.sqlite');
  let index = new MusicSearchIndex({ storePath });
  assert.equal(index.synchronize(songs).generated, songs.length);
  assert.equal(index.synchronize(songs).generated, 0);
  index.close();
  index = new MusicSearchIndex({ storePath });
  try {
    assert.equal(index.synchronize(songs).generated, 0);
    const updated = songs.map((track) =>
      track.id === 'edis'
        ? { ...track, title: 'Corrected Song', videoTitle: 'Noisy old video' }
        : track
    );
    assert.equal(index.synchronize(updated).generated, 1);
    assert.equal((await index.search('Corrected Song Edis', updated)).match.id, 'edis');
    index.upsert({ id: 'extra', title: 'New Download', artist: 'New Artist' });
    assert.equal(index.size, songs.length + 1);
    assert.equal(index.synchronize(updated.slice(1)).removed, 2);
    assert.equal(
      index.synchronize(updated.slice(1), { rebuild: true }).generated,
      songs.length - 1
    );
  } finally {
    index.close();
  }
});

test('FTS5 retrieval caps candidates at 100 and uses trigrams for a wholly misspelled word', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  const tracks = Array.from({ length: 586 }, (_, i) => ({
    id: `track-${i}`,
    title: `Common Song ${i}`,
    artist: `Artist ${i}`
  }));
  tracks.push({ id: 'typo', title: 'Thunder', artist: 'Imagine Dragons' });
  const broad = await index.search('common', tracks, { limit: 100 });
  assert.equal(broad.candidateCount, 100);
  assert.equal(broad.match, null);
  const typo = await index.search('thundre', tracks);
  assert.equal(typo.match?.id, 'typo');
  assert.equal(
    index.db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE sql LIKE \'%fts5%\'').get().n,
    2
  );
});

test('short non-Latin substrings are retrievable and metadata versions have no special ranking rules', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  assert.equal(
    (await index.search('世界', [{ id: 'unicode', title: '你好世界', artist: null }])).match?.id,
    'unicode'
  );
  const same = await index.search('Song', [
    { id: 'a', title: 'Song live', artist: 'Artist' },
    { id: 'b', title: 'Song blue', artist: 'Artist' }
  ]);
  assert.equal(same.candidates[0].score, same.candidates[1].score);
  assert.equal(same.match, null);
});

test('compact punctuation/whitespace variants match without discarding meaningful metadata', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  const tracks = [{ id: 'kda', title: 'POP/STARS', artist: 'K/DA' }, ...songs];
  assert.equal((await index.search('kda popstars', tracks)).match?.id, 'kda');
  assert.equal((await index.search('arcticmonkeys wanna know', tracks)).match?.id, 'arctic');
});

test('exact phrase bonuses retain meaningful repeated words', async (t) => {
  const index = new MusicSearchIndex({ storePath: ':memory:' });
  t.after(() => index.close());
  const tracks = [
    { id: 'repeated', title: 'Bye Bye Bye', artist: 'Artist' },
    { id: 'single', title: 'Bye', artist: 'Another Artist' }
  ];
  assert.equal((await index.search('bye bye bye', tracks)).match?.id, 'repeated');
});
