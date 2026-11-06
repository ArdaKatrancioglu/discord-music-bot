const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { addTrackToCache, getTrackFromCache, indexPath } = require('../src/core/musicIndex');
const {
  fetchSyncedLyrics,
  selectBestResult,
  parseTrackIdentity
} = require('../src/services/lyricsService');
const { readLyrics } = require('../src/core/lyricsStore');

test('lyrics reads TTML, refetches missing/corrupt files with clean metadata and stores only a relative path', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  const track = {
    id: 'lyricstest1',
    title: 'Clean title - Remix',
    artist: 'Actual artist',
    album: 'Album',
    duration: 20,
    videoTitle: 'Uploader Official Video',
    filePath: '/audio/unchanged.webm',
    titleSan: 'old_file',
    lyrics: null
  };
  addTrackToCache(track);
  global.fetch = async (url) => {
    requests++;
    assert.equal(url.searchParams.get('track_name'), track.title);
    assert.equal(url.searchParams.get('artist_name'), track.artist);
    assert.equal(url.searchParams.get('album_name'), track.album);
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          trackName: track.title,
          artistName: track.artist,
          duration: 20,
          syncedLyrics: '[00:01.2345]İ & 世界\n[00:03]second'
        }
      ]
    };
  };
  try {
    assert.equal((await fetchSyncedLyrics(track))[0].timestamp, 1.2345);
    const cached = getTrackFromCache({ id: track.id });
    assert.equal(cached.lyrics, 'lyrics/lyricstest1.ttml');
    const file = path.join(path.dirname(indexPath), cached.lyrics);
    assert.equal(readLyrics(indexPath, cached.lyrics).lines[0].text, 'İ & 世界');
    await fetchSyncedLyrics(track);
    assert.equal(requests, 1);
    fs.writeFileSync(file, 'broken');
    await fetchSyncedLyrics(track);
    assert.equal(requests, 2);
    fs.unlinkSync(file);
    await fetchSyncedLyrics(track);
    assert.equal(requests, 3);
    assert.equal(getTrackFromCache({ id: track.id }).filePath, track.filePath);
  } finally {
    global.fetch = originalFetch;
  }
});

test('plain-only LRCLIB results persist as untimed TTML', async () => {
  const originalFetch = global.fetch;
  const track = {
    id: 'plainlyric1',
    title: 'Plain title',
    artist: 'Artist',
    videoTitle: 'Video',
    duration: 20
  };
  addTrackToCache(track);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        trackName: track.title,
        artistName: track.artist,
        duration: 20,
        plainLyrics: 'Plain lyrics 世界'
      }
    ]
  });
  try {
    assert.equal(await fetchSyncedLyrics(track), null);
    const local = getTrackFromCache({ id: track.id });
    assert.equal(readLyrics(indexPath, local.lyrics).plainLyrics, 'Plain lyrics 世界');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lyrics rejects incompatible durations and artists and preserves verified titles containing dashes', () => {
  const identity = { title: 'Song', artist: 'Artist', duration: 200 };
  const candidate = {
    trackName: 'Song',
    artistName: 'Artist',
    duration: 120,
    syncedLyrics: '[00:01]line'
  };
  assert.equal(selectBestResult([candidate], identity), null);
  assert.equal(
    selectBestResult([{ ...candidate, duration: 200, artistName: 'Someone else' }], identity),
    null
  );
  assert.equal(
    selectBestResult(
      [{ ...candidate, duration: 200, syncedLyrics: '[04:00]impossible' }],
      identity
    ),
    null
  );
  assert.equal(
    parseTrackIdentity({ title: 'Song - Remix', artist: 'Artist', videoTitle: 'Video' }).title,
    'Song - Remix'
  );
  assert.equal(
    parseTrackIdentity({ title: 'Video without artist', uploader: 'Channel' }).artist,
    ''
  );
});
