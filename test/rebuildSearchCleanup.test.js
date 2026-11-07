const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MusicSearchIndex } = require('../src/core/musicSearchIndex');
const { libraryDataFile } = require('../src/core/libraryPaths');

const script = path.resolve(__dirname, '../scripts/rebuild-search.js');
function runRebuild(directory, indexPath = path.join(directory, 'index.json')) {
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, MUSIC_INDEX_PATH: indexPath },
    encoding: 'utf8'
  });
}
function makeLibrary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const indexPath = path.join(directory, 'index.json');
  fs.mkdirSync(path.join(directory, 'music'));
  const audio = path.join(directory, 'music', 'bpOSxM0rNPM_original.webm');
  fs.writeFileSync(audio, 'original audio');
  fs.mkdirSync(path.join(directory, 'lyrics'));
  const lyricPath = path.join(directory, 'lyrics', 'bpOSxM0rNPM.ttml');
  const lyrics =
    '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div><p begin="00:00:01.000">A line</p></div></body></tt>';
  fs.writeFileSync(lyricPath, lyrics);
  const library = {
    version: 2,
    tracks: [
      {
        id: 'bpOSxM0rNPM',
        title: 'Do I Wanna Know?',
        artist: 'Arctic Monkeys',
        filePath: audio,
        lyrics: 'lyrics/bpOSxM0rNPM.ttml'
      }
    ]
  };
  const indexText = JSON.stringify(library, null, 2);
  fs.writeFileSync(indexPath, indexText);
  return { directory, indexPath, audio, lyricPath, lyrics, library, indexText };
}

test('rebuild safely organizes active data and removes only recognized obsolete caches and backups', async (t) => {
  const { directory, indexPath, audio, lyricPath, lyrics, library, indexText } = makeLibrary(t);
  const support = {
    'youtube-music-cache.json': '{"track":{"at":123,"metadata":null}}',
    'analytics.json': '{"totals":{"playRequests":4}}'
  };
  for (const [name, contents] of Object.entries(support))
    fs.writeFileSync(path.join(directory, name), contents);
  for (const name of [
    'embeddings.jsonl',
    'embeddings.jsonl.backup-20261107-010203',
    'index.json.backup-123-old',
    'index.json.backup',
    'index.json.bak'
  ])
    fs.writeFileSync(path.join(directory, name), 'obsolete');
  fs.writeFileSync(path.join(directory, 'personal-backup.zip'), 'personal');
  fs.writeFileSync(path.join(directory, 'unfinished.webm.part'), 'partial download');
  const oldIndex = new MusicSearchIndex({ storePath: path.join(directory, 'search.sqlite') });
  oldIndex.synchronize(library.tracks);
  oldIndex.close();
  assert.equal(
    libraryDataFile(indexPath, 'youtube-music-cache.json'),
    path.join(directory, 'youtube-music-cache.json')
  );
  const result = runRebuild(directory);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Removed index\.json\.backup-123-old/);
  assert.match(result.stdout, /Removed embeddings\.jsonl/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), indexText);
  assert.equal(fs.readFileSync(audio, 'utf8'), 'original audio');
  assert.equal(fs.readFileSync(lyricPath, 'utf8'), lyrics);
  assert.equal(fs.readFileSync(path.join(directory, 'personal-backup.zip'), 'utf8'), 'personal');
  assert.equal(
    fs.readFileSync(path.join(directory, 'unfinished.webm.part'), 'utf8'),
    'partial download'
  );
  for (const name of [
    'search.sqlite',
    'search.sqlite-wal',
    'search.sqlite-shm',
    'embeddings.jsonl',
    'embeddings.jsonl.backup-20261107-010203',
    'index.json.backup-123-old',
    'index.json.backup',
    'index.json.bak'
  ])
    assert.equal(fs.existsSync(path.join(directory, name)), false, name);
  for (const [name, contents] of Object.entries(support)) {
    assert.equal(fs.existsSync(path.join(directory, name)), false);
    assert.equal(
      fs.readFileSync(
        path.join(directory, name === 'analytics.json' ? 'stats' : 'cache', name),
        'utf8'
      ),
      contents
    );
    assert.equal(
      libraryDataFile(indexPath, name),
      path.join(directory, name === 'analytics.json' ? 'stats' : 'cache', name)
    );
  }
  const searchPath = path.join(directory, 'cache', 'search.sqlite');
  assert.equal(libraryDataFile(indexPath, 'search.sqlite'), searchPath);
  const index = new MusicSearchIndex({ storePath: searchPath });
  try {
    assert.equal(
      (await index.search('arctic monkeys wanna', library.tracks)).match.id,
      'bpOSxM0rNPM'
    );
  } finally {
    index.close();
  }
  const repeat = runRebuild(directory);
  assert.equal(repeat.status, 0, repeat.stderr || repeat.stdout);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), indexText);
  assert.equal(
    fs.readFileSync(path.join(directory, 'stats', 'analytics.json'), 'utf8'),
    support['analytics.json']
  );
});

test('corrupt or missing library and failed search creation never delete existing backups', (t) => {
  const { directory, indexPath } = makeLibrary(t);
  const backup = path.join(directory, 'index.json.backup-123-old');
  const embeddings = path.join(directory, 'embeddings.jsonl');
  fs.writeFileSync(backup, 'preserve backup');
  fs.writeFileSync(embeddings, 'preserve embeddings');
  fs.writeFileSync(indexPath, '{invalid');
  assert.notEqual(runRebuild(directory).status, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'preserve backup');
  assert.equal(fs.readFileSync(embeddings, 'utf8'), 'preserve embeddings');
  fs.unlinkSync(indexPath);
  assert.notEqual(runRebuild(directory).status, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'preserve backup');
  fs.writeFileSync(indexPath, '{"version":2,"tracks":[]}');
  fs.mkdirSync(path.join(directory, 'cache'));
  fs.writeFileSync(path.join(directory, 'cache', 'search.sqlite'), 'not a database');
  assert.notEqual(runRebuild(directory).status, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'preserve backup');
  assert.equal(fs.readFileSync(embeddings, 'utf8'), 'preserve embeddings');
});

test('conflicting cache files are retained instead of overwriting metadata or analytics', (t) => {
  const { directory } = makeLibrary(t);
  fs.mkdirSync(path.join(directory, 'stats'));
  fs.writeFileSync(path.join(directory, 'analytics.json'), 'old analytics');
  fs.writeFileSync(path.join(directory, 'stats', 'analytics.json'), 'different analytics');
  const result = runRebuild(directory);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Kept analytics\.json/);
  assert.equal(fs.readFileSync(path.join(directory, 'analytics.json'), 'utf8'), 'old analytics');
  assert.equal(
    fs.readFileSync(path.join(directory, 'stats', 'analytics.json'), 'utf8'),
    'different analytics'
  );
});

test('custom index names are protected even when they match an obsolete filename', (t) => {
  const { directory, library } = makeLibrary(t);
  const indexPath = path.join(directory, 'embeddings.jsonl');
  const original = JSON.stringify(library);
  fs.writeFileSync(indexPath, original);
  const result = runRebuild(directory, indexPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), original);
});

test('analytics continue using the organized file after a rebuild and process restart', (t) => {
  const { directory, indexPath } = makeLibrary(t);
  fs.writeFileSync(
    path.join(directory, 'analytics.json'),
    JSON.stringify({ totals: { playRequests: 4 } })
  );
  const rebuilt = runRebuild(directory);
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  const service = path.resolve(__dirname, '../src/services/analyticsService.js');
  const program = `const analytics = require(${JSON.stringify(service)}); analytics.recordPlayRequest({type:'search'}); process.stdout.write(analytics.analyticsPath);`;
  const env = { ...process.env, MUSIC_INDEX_PATH: indexPath, ANALYTICS_DISABLED: 'false' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['-e', program], {
    cwd: directory,
    env,
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const organized = path.join(directory, 'stats', 'analytics.json');
  assert.ok(child.stdout.endsWith(organized));
  assert.equal(JSON.parse(fs.readFileSync(organized, 'utf8')).totals.playRequests, 5);
  assert.equal(fs.existsSync(path.join(directory, 'analytics.json')), false);
});

test('rebuild refuses to clean up when either search database is in use', (t) => {
  const { directory, library } = makeLibrary(t);
  const backup = path.join(directory, 'index.json.backup-123-old');
  fs.writeFileSync(backup, 'backup');
  fs.writeFileSync(path.join(directory, 'embeddings.jsonl'), 'legacy');
  const oldPath = path.join(directory, 'search.sqlite');
  const old = new MusicSearchIndex({ storePath: oldPath });
  old.synchronize(library.tracks);
  const busyLegacy = runRebuild(directory);
  assert.notEqual(busyLegacy.status, 0);
  assert.match(busyLegacy.stderr, /stop the bot/);
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.existsSync(path.join(directory, 'embeddings.jsonl')), true);
  old.close();
  const success = runRebuild(directory);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  fs.writeFileSync(backup, 'new backup');
  const organized = new MusicSearchIndex({
    storePath: path.join(directory, 'cache', 'search.sqlite')
  });
  const busyOrganized = runRebuild(directory);
  assert.notEqual(busyOrganized.status, 0);
  assert.match(busyOrganized.stderr, /stop the bot/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'new backup');
  organized.close();
});
