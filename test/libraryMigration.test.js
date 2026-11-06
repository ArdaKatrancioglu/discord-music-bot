const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  migrateLibrary,
  migrateLocalLibrary,
  readLibrary
} = require('../src/core/libraryMigration');
const { readLyrics } = require('../src/core/lyricsStore');
const { parseCachedMp3Filename } = require('../src/utils/titleUtils');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'library-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const indexPath = path.join(directory, 'collection.json');
  const audio = path.join(directory, 'bpOSxM0rNPM_original_title.webm');
  fs.writeFileSync(audio, 'untouched audio bytes');
  const tracks = [
    {
      id: 'bpOSxM0rNPM',
      title: 'Artist - Song (Official Video)',
      titleSan: 'original_title',
      filePath: audio,
      duration: 20,
      lyricsOffset: 2,
      lyrics: {
        source: 'lrclib',
        status: 'found',
        syncedLyrics: [
          { time: 1.123, text: 'İ & <hello>' },
          { time: 3, text: 'world' }
        ]
      }
    },
    { id: 'plaintrack1', title: 'Plain song', lyrics: { plainLyrics: 'Plain & simple\n你好' } },
    { id: 'nomusic1234', title: 'A movie', lyrics: { status: 'not_found' } }
  ];
  const original = { version: 1, custom: 'preserved', tracks };
  fs.writeFileSync(indexPath, JSON.stringify(original));
  return { indexPath, audio, original, directory };
}

test('migration backs up embedded source and preserves IDs, files, timing, offsets and extra fields', async (t) => {
  const { indexPath, audio, original } = fixture(t);
  const result = await migrateLibrary({ indexPath });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, 'utf8')), original);
  const index = readLibrary(indexPath);
  assert.equal(index.version, 2);
  assert.equal(index.custom, 'preserved');
  assert.deepEqual(
    index.tracks.map((track) => track.id),
    original.tracks.map((track) => track.id)
  );
  assert.equal(index.tracks[0].filePath, audio);
  assert.equal(fs.readFileSync(audio, 'utf8'), 'untouched audio bytes');
  assert.equal(index.tracks[0].lyricsOffset, 2);
  assert.equal(index.tracks[0].videoTitle, original.tracks[0].title);
  assert.equal(readLyrics(indexPath, index.tracks[0].lyrics).lines[0].timestamp, 1.123);
  assert.equal(readLyrics(indexPath, index.tracks[1].lyrics).plainLyrics, 'Plain & simple\n你好');
  assert.equal(index.tracks[2].lyrics, null);
  assert.equal(index.tracks[2].artist, null);
  assert.equal(JSON.stringify(index).includes('syncedLyrics'), false);
  const before = fs.readFileSync(indexPath, 'utf8');
  const second = await migrateLibrary({ indexPath });
  assert.equal(second.backup, null);
  assert.equal(second.convertedLyrics, 0);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  migrateLocalLibrary(indexPath);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
});

test('dry run leaves all files untouched and batch enrichment can resume without changing manual fields', async (t) => {
  const { indexPath, original, directory } = fixture(t);
  const before = fs.readFileSync(indexPath, 'utf8');
  const resolver = {
    resolve: async (track) => ({
      title: `Clean ${track.id}`,
      artist: 'Actual artist',
      album: null,
      year: null,
      artworkUrl: null,
      musicId: track.id
    })
  };
  await migrateLibrary({ indexPath, dryRun: true, resolver });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    'bpOSxM0rNPM_original_title.webm',
    'collection.json'
  ]);
  const first = await migrateLibrary({ indexPath, resolver, batchSize: 1 });
  assert.equal(first.enriched, 1);
  assert.equal(first.index.tracks[0].videoTitle, original.tracks[0].title);
  const second = await migrateLibrary({ indexPath, resolver, batchSize: 1 });
  assert.equal(second.index.tracks[1].artist, 'Actual artist');
  assert.equal(second.index.tracks[2].artist, null);
});

test('interrupted enrichment resumes with already migrated lyrics intact', async (t) => {
  const { indexPath } = fixture(t);
  let calls = 0;
  await assert.rejects(
    migrateLibrary({
      indexPath,
      resolver: {
        resolve: async () => {
          if (++calls === 2) throw new Error('interrupted');
          return { title: 'Clean', artist: 'Artist' };
        }
      }
    }),
    /interrupted/
  );
  const checkpoint = readLibrary(indexPath);
  assert.equal(checkpoint.tracks[0].title, 'Clean');
  assert.ok(readLyrics(indexPath, checkpoint.tracks[0].lyrics));
  await migrateLibrary({ indexPath });
  assert.equal(
    readLibrary(indexPath).tracks.every(
      (track) => track.lyrics === null || typeof track.lyrics === 'string'
    ),
    true
  );
});

test('corrupt index and failed TTML persistence never erase original embedded lyrics', async (t) => {
  const { indexPath, original, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'lyrics'), 'prevents directory creation');
  await assert.rejects(migrateLibrary({ indexPath }));
  assert.deepEqual(readLibrary(indexPath), original);
  fs.writeFileSync(indexPath, '{broken');
  assert.throws(() => migrateLocalLibrary(indexPath));
  assert.equal(fs.readFileSync(indexPath, 'utf8'), '{broken');
});

test('filename parsing preserves an 11-character YouTube ID with underscores for every audio extension', () => {
  for (const extension of ['webm', 'm4a', 'mp3']) {
    assert.deepEqual(parseCachedMp3Filename(`D9G1VOjN_84_Original_video_title.${extension}`), {
      id: 'D9G1VOjN_84',
      titleSan: 'Original_video_title',
      title: 'Original video title'
    });
  }
});

test('optional Docker relocation changes only paths to existing sibling audio and preserves backup paths', async (t) => {
  const { indexPath, original, audio } = fixture(t);
  const originalPath = 'C:\\Users\\old-user\\Music\\bpOSxM0rNPM_original_title.webm';
  original.tracks[0].filePath = originalPath;
  fs.writeFileSync(indexPath, JSON.stringify(original));
  const dry = await migrateLibrary({ indexPath, dryRun: true, relocateAudio: true });
  assert.equal(dry.relocatedAudio, 1);
  assert.equal(dry.index.tracks[0].filePath, audio);
  assert.equal(readLibrary(indexPath).tracks[0].filePath, originalPath);
  const result = await migrateLibrary({ indexPath, relocateAudio: true });
  assert.equal(result.relocatedAudio, 1);
  assert.equal(result.index.tracks[0].id, original.tracks[0].id);
  assert.equal(result.index.tracks[0].filePath, audio);
  assert.equal(readLibrary(result.backup).tracks[0].filePath, originalPath);
  assert.equal(
    result.index.tracks[1].filePath,
    null,
    'missing files must not receive invented paths'
  );
  assert.equal((await migrateLibrary({ indexPath, relocateAudio: true })).relocatedAudio, 0);
});
