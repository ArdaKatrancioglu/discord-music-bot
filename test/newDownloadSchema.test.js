const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('new download immediately persists normalized metadata and queues the original playable recording', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'new-download-'));
  const root = path.resolve(__dirname, '..');
  const script = `
    const assert = require('node:assert/strict');
    const path = require('path');
    const fs = require('fs');
    const root = ${JSON.stringify(root)};
    function mock(relative, exports) {
      const id = require.resolve(path.join(root, relative));
      require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const session = {};
    let queued;
    let indexedTrack;
    const replies = [];
    const edits = [];
    let deleted = 0;
    let startedImmediately = false;
    mock('src/core/sessionManager.js', { ensureSession: () => session, userDefaultVC: new Map() });
    mock('src/services/cacheService.js', { queueTrackIntoSession: (_s, _g, track) => { queued = track; return { startedImmediately }; } });
    mock('src/services/cacheSearchService.js', { indexCachedTrack: async (track) => { indexedTrack = track; }, searchCachedMusic: async () => ({ track: null }) });
    mock('src/services/playlistService.js', { detectIfPlaylist: async () => false });
    mock('src/services/spotifyPlaylistService.js', { isSpotifyPlaylistUrl: () => false });
    mock('src/core/youtubeMetadata.js', { extractYouTubeVideoId: () => 'bpOSxM0rNPM', classifyMetadataError: () => 'error', fetchMetadataWithFallback: async () => ({ metadata: {
      title: 'bpOSxM0rNPM', id: 'Artist - Song (Official Video)', realTitle: 'Artist - Song (Official Video)', duration: 20, artist: 'Unverified channel',
      url: 'https://youtube.com/watch?v=bpOSxM0rNPM'
    } }) });
    const filePath = path.join(path.dirname(process.env.MUSIC_INDEX_PATH), 'music', 'original.webm');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'audio');
    mock('src/services/downloadService.js', { downloadTrack: async () => ({ filePath, attemptHistory: [] }) });
    const music = require(path.join(root, 'src/core/youtubeMusicMetadata.js'));
    mock('src/core/youtubeMusicMetadata.js', { ...music, YouTubeMusicResolver: class { async resolve() { return { title: 'Song', artist: 'Artist', album: 'Album', year: 2020, musicId: 'audio-track', artists: [{ name: 'Artist', id: 'UCartist' }], artworkUrl: null }; } } });
    const { handlePlayRequest } = require(path.join(root, 'src/services/playService.js'));
    const voice = { id: 'voice', guild: { id: 'guild' } };
    const message = { guild: { id: 'guild' }, author: { id: 'user', username: 'User' }, member: { voice: { channel: voice } }, reply: async (content) => {
      replies.push(content);
      return { edit: async (payload) => { edits.push(payload.content); }, delete: async () => { deleted++; } };
    } };
    const client = { guilds: { cache: new Map([['guild', { voiceAdapterCreator: {} }]]) } };
    (async () => {
      await handlePlayRequest(client, message, 'https://youtube.com/watch?v=bpOSxM0rNPM');
      assert.deepEqual(replies, ['Finding the track…']);
      assert.deepEqual(edits, ['Preparing the track…', 'Added to queue · Artist – Song']);
      replies.length = 0;
      edits.length = 0;
      await handlePlayRequest(client, message, 'https://youtube.com/watch?v=bpOSxM0rNPM');
      assert.deepEqual(replies, ['Added to queue · Artist – Song']);
      assert.equal(edits.length, 0);
      replies.length = 0;
      startedImmediately = true;
      await handlePlayRequest(client, message, 'https://youtube.com/watch?v=bpOSxM0rNPM');
      assert.equal(replies.length, 0);
      assert.equal(deleted, 0);
      assert.equal(queued.title, 'Song');
      assert.equal(queued.artist, 'Artist');
      assert.equal(queued.id, 'bpOSxM0rNPM');
      assert.equal(queued.filePath, filePath);
      assert.equal(indexedTrack.title, 'Song');
      const library = JSON.parse(fs.readFileSync(process.env.MUSIC_INDEX_PATH, 'utf8'));
      const track = library.tracks.find(t => t.id === 'bpOSxM0rNPM');
      assert.equal(track.videoTitle, 'Artist - Song (Official Video)');
      assert.equal(track.lyrics, null);
      assert.equal(track.album, 'Album');
      assert.equal(track.filePath, filePath);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: directory,
      env: { ...process.env, MUSIC_INDEX_PATH: path.join(directory, 'library', 'index.json') },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
