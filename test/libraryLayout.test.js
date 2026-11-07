const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLayout } = require('../src/core/libraryLayout');
const { MusicSearchIndex } = require('../src/core/musicSearchIndex');
const { libraryDataFile, libraryMusicDirectory } = require('../src/core/libraryPaths');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracks = ['bpOSxM0rNPM_song.webm', 'D9G1VOjN_84_video.mp4'].map((filename, index) => {
    fs.writeFileSync(path.join(root, filename), `audio-${index}`);
    return {
      id: filename.slice(0, 11),
      title: `Title ${index}`,
      artist: index ? null : 'Artist',
      album: 'Album',
      titleSan: `unchanged_${index}`,
      filePath: `/old-machine/${filename}`,
      duration: 200,
      lyrics: index ? null : 'lyrics/bpOSxM0rNPM.ttml',
      custom: 'preserved'
    };
  });
  fs.writeFileSync(path.join(root, 'download.mp4.part'), 'partial data');
  fs.mkdirSync(path.join(root, 'lyrics'));
  fs.writeFileSync(path.join(root, 'lyrics', 'bpOSxM0rNPM.ttml'), 'original lyric bytes');
  fs.mkdirSync(path.join(root, '.bot-data'));
  fs.writeFileSync(path.join(root, '.bot-data', 'analytics.json'), '{"totals":{"playRequests":5}}');
  fs.writeFileSync(path.join(root, '.bot-data', 'youtube-music-cache.json'), '{"cached":true}');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'personal');
  const indexPath = path.join(root, 'index.json');
  fs.writeFileSync(
    indexPath,
    JSON.stringify({ version: 2, custom: 'root field', tracks }, null, 2)
  );
  return { root, indexPath, tracks };
}

test('layout migration moves media and support data while preserving metadata, lyrics and filenames', (t) => {
  const { root, indexPath, tracks } = fixture(t);
  const report = migrateLayout({ indexPath });
  assert.equal(report.movedFiles, 3);
  assert.equal(report.updatedPaths, 2);
  const next = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(next.custom, 'root field');
  next.tracks.forEach((track, index) => {
    const filename = path.posix.basename(tracks[index].filePath);
    assert.deepEqual(track, { ...tracks[index], filePath: path.join(root, 'music', filename) });
    assert.equal(fs.readFileSync(track.filePath, 'utf8'), `audio-${index}`);
    assert.equal(fs.existsSync(path.join(root, filename)), false);
  });
  assert.equal(
    fs.readFileSync(path.join(root, 'music', 'download.mp4.part'), 'utf8'),
    'partial data'
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'lyrics', 'bpOSxM0rNPM.ttml'), 'utf8'),
    'original lyric bytes'
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'stats', 'analytics.json'), 'utf8'),
    '{"totals":{"playRequests":5}}'
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'cache', 'youtube-music-cache.json'), 'utf8'),
    '{"cached":true}'
  );
  assert.equal(fs.existsSync(path.join(root, '.bot-data')), false);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'personal');
  assert.equal(
    libraryDataFile(indexPath, 'analytics.json'),
    path.join(root, 'stats', 'analytics.json')
  );
  assert.equal(libraryMusicDirectory(indexPath), path.join(root, 'music'));
  const before = fs.readFileSync(indexPath, 'utf8');
  assert.equal(migrateLayout({ indexPath }).movedFiles, 0);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
});

test('dry-run writes nothing and supports container playback roots', (t) => {
  const { root, indexPath } = fixture(t);
  const before = fs.readFileSync(indexPath, 'utf8');
  assert.equal(
    migrateLayout({ indexPath, dryRun: true, playbackRoot: '/app/data' }).updatedPaths,
    2
  );
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'music')), false);
  migrateLayout({ indexPath, playbackRoot: '/app/data' });
  assert.equal(
    JSON.parse(fs.readFileSync(indexPath, 'utf8')).tracks[0].filePath,
    '/app/data/music/bpOSxM0rNPM_song.webm'
  );
});

test('missing audio or conflicting destination stops before moving any files', (t) => {
  const { root, indexPath } = fixture(t);
  const before = fs.readFileSync(indexPath, 'utf8');
  fs.mkdirSync(path.join(root, 'music'));
  fs.writeFileSync(path.join(root, 'music', 'bpOSxM0rNPM_song.webm'), 'different audio');
  assert.throws(() => migrateLayout({ indexPath }), /Conflicting/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'D9G1VOjN_84_video.mp4')), true);
  fs.unlinkSync(path.join(root, 'music', 'bpOSxM0rNPM_song.webm'));
  fs.unlinkSync(path.join(root, 'D9G1VOjN_84_video.mp4'));
  assert.throws(() => migrateLayout({ indexPath }), /Cannot locate/);
  assert.equal(fs.existsSync(path.join(root, 'bpOSxM0rNPM_song.webm')), true);
});

test('interrupted media moves can resume using the unchanged index', (t) => {
  const { root, indexPath } = fixture(t);
  const before = fs.readFileSync(indexPath, 'utf8');
  const originalRename = fs.renameSync;
  let moves = 0;
  fs.renameSync = (source, destination) => {
    if (path.dirname(destination) === path.join(root, 'music') && ++moves === 2)
      throw new Error('interrupted');
    return originalRename(source, destination);
  };
  try {
    assert.throws(() => migrateLayout({ indexPath }), /interrupted/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  migrateLayout({ indexPath });
  for (const track of JSON.parse(fs.readFileSync(indexPath, 'utf8')).tracks)
    assert.equal(fs.existsSync(track.filePath), true);
});

test('active SQLite indexes prevent layout changes', (t) => {
  const { root, indexPath } = fixture(t);
  const active = new MusicSearchIndex({ storePath: path.join(root, '.bot-data', 'search.sqlite') });
  try {
    assert.throws(() => migrateLayout({ indexPath }), /Stop the bot/);
    assert.equal(fs.existsSync(path.join(root, 'music')), false);
  } finally {
    active.close();
  }
});
