const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { argumentsFor } = require('../scripts/migrate-library');

test('preparation accepts Docker relocation and metadata batch options', () => {
  const options = argumentsFor(['--relocate-audio', '--batch-size', '50', '--offset', '100']);
  assert.equal(options.relocateAudio, true);
  assert.equal(options.batchSize, 50);
  assert.equal(options.offset, 100);
  assert.equal(argumentsFor([]).batchSize, undefined, 'full library has no default limit');
});

test('prepares a mixed 550-entry library before lexical indexing, supports dry-run, resume and missing-audio reporting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-library-test-'));
  const indexPath = path.join(directory, 'index.json');
  fs.mkdirSync(path.join(directory, 'music'));
  const tracks = Array.from({ length: 550 }, (_, position) => {
    const filename = `audio-${position}.webm`;
    fs.writeFileSync(path.join(directory, 'music', filename), 'audio');
    return {
      id: String(position).padStart(11, '0'),
      title: `Video ${position}`,
      titleSan: `Video_${position}`,
      filePath: `/old-machine/${filename}`
    };
  });
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, tracks }));
  const original = fs.readFileSync(indexPath, 'utf8');
  const moduleRoot = path.resolve(__dirname, '..');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('fs');
    const path = require('path');
    const root = ${JSON.stringify(moduleRoot)};
    const indexPath = process.env.MUSIC_INDEX_PATH;
    const providerPath = require.resolve(path.join(root, 'src/core/youtubeMusicMetadata.js'));
    const provider = require(providerPath);
    let metadataCalls = 0;
    require.cache[providerPath].exports = { ...provider, YouTubeMusicResolver: class {
      async resolve(track) {
        metadataCalls++;
        const position = Number(track.id);
        return position % 10 === 0 ? null : { title: 'Song ' + position, artist: 'Artist ' + position };
      }
    } };
    const { prepareLibrary } = require(path.join(root, 'scripts/prepare-library.js'));
    (async () => {
      const before = fs.readFileSync(indexPath, 'utf8');
      await prepareLibrary({ indexPath, dryRun: true, offline: true, relocateAudio: true });
      assert.equal(fs.existsSync(path.join(path.dirname(indexPath), 'search.sqlite')), false);
      assert.equal(fs.existsSync(path.join(path.dirname(indexPath), 'cache')), false);
      assert.equal(metadataCalls, 0);
      assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
      const result = await prepareLibrary({ indexPath, relocateAudio: true });
      assert.equal(result.attempted, 550);
      assert.equal(result.enriched, 495);
      assert.equal(result.relocatedAudio, 550);
      assert.equal(result.missingAudio, 0);
      assert.equal(metadataCalls, 550);
      assert.equal(result.index.tracks[0].title, 'Video 0');
      assert.equal(JSON.parse(fs.readFileSync(result.backup, 'utf8')).tracks[0].filePath, '/old-machine/audio-0.webm');
      const checkpoint = fs.readFileSync(indexPath, 'utf8');
      const repeat = await prepareLibrary({ indexPath, offline: true, relocateAudio: true });
      assert.equal(fs.readFileSync(indexPath, 'utf8'), checkpoint);
      assert.equal(repeat.search.generated, 0);
      assert.equal(repeat.search.indexed, 550);
      const { MusicSearchIndex } = require(path.join(root, 'src/core/musicSearchIndex.js'));
      const lexical = new MusicSearchIndex({ storePath: path.join(path.dirname(indexPath), 'cache', 'search.sqlite') });
      const found = await lexical.search('Song 1 Artist 1', result.index.tracks);
      assert.equal(found.match.id, '00000000001');
      lexical.close();
      assert.equal(metadataCalls, 550);
      fs.unlinkSync(result.index.tracks[0].filePath);
      await assert.rejects(prepareLibrary({ indexPath, offline: true }), /1 audio file/);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: directory,
      env: { ...process.env, MUSIC_INDEX_PATH: indexPath },
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(original.includes('/old-machine/'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
