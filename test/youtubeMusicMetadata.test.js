const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YouTubeMusicResolver,
  mapMusicItem,
  matchWatchTrack,
  applyMusicMetadata,
  validatedSearchMatch
} = require('../src/core/youtubeMusicMetadata');
const musicType = {
  watchEndpointMusicSupportedConfigs: {
    watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
  }
};
function item(id, extra = {}) {
  return {
    video_id: id,
    title: 'Song (Remix)',
    artists: [
      { name: 'Artist A', channel_id: 'UCa' },
      { name: 'Artist B', channel_id: 'UCb' }
    ],
    album: { id: 'MPRalbum', name: 'Album', year: '2020' },
    duration: { seconds: 180 },
    thumbnail: [
      { url: 'small', width: 10 },
      { url: 'large', width: 100 }
    ],
    ...extra
  };
}

test('maps structured multiple artists, album/year/artwork, and no uploader', () => {
  const metadata = mapMusicItem(item('original-id', { author: 'Unrelated uploader' }));
  assert.equal(metadata.artist, 'Artist A, Artist B');
  assert.equal(metadata.artists.length, 2);
  assert.equal(metadata.title, 'Song (Remix)');
  assert.equal(metadata.year, 2020);
  assert.equal(metadata.artworkUrl, 'large');
  assert.equal(mapMusicItem(item('id', { artists: [], author: 'Uploader' })), null);
});

test('finds direct ID after recommendations and uses only linked counterparts', () => {
  const direct = item('original-id');
  assert.equal(
    matchWatchTrack('original-id', [item('unrelated'), direct]).metadata.musicId,
    'original-id'
  );
  const wrapper = {
    primary: item('original-id', { album: undefined, endpoint: { payload: musicType } }),
    counterpart: [item('audio-id')]
  };
  assert.equal(
    matchWatchTrack('original-id', [item('unrelated'), wrapper]).metadata.musicId,
    'audio-id'
  );
  assert.equal(matchWatchTrack('audio-id', [wrapper]).metadata.musicId, 'audio-id');
  assert.equal(matchWatchTrack('missing', [wrapper, item('unrelated')]), null);
});

test('missing album can resolve a typed music track; a non-music uploader cannot', () => {
  assert.equal(
    mapMusicItem(item('id', { album: undefined, endpoint: { payload: musicType } })).album,
    null
  );
  assert.equal(mapMusicItem(item('id', { album: undefined })), null);
  assert.equal(mapMusicItem({ video_id: 'movie', title: 'Movie', author: 'Channel' }), null);
});

test('optional search checks title/version, every artist and playable duration', () => {
  const identity = mapMusicItem(item('id'));
  assert.equal(
    validatedSearchMatch([item('wrong', { title: 'Song' }), item('right')], identity, 181).video_id,
    'right'
  );
  assert.equal(
    validatedSearchMatch([item('wrong', { duration: { seconds: 240 } })], identity, 180),
    null
  );
  assert.equal(
    validatedSearchMatch([item('wrong', { artists: [{ name: 'Artist A' }] })], identity, 180),
    null
  );
});

test('resolver caches successful and non-music responses, bounds failures and preserves manual edits', async () => {
  let calls = 0;
  const resolver = new YouTubeMusicResolver({
    minGapMs: 0,
    createClient: async () => ({
      async getInfo() {
        calls++;
        return { getUpNext: async () => ({ contents: [item('bpOSxM0rNPM')] }) };
      }
    })
  });
  const track = { id: 'bpOSxM0rNPM' };
  assert.equal((await resolver.resolve(track)).title, 'Song (Remix)');
  await resolver.resolve(track);
  assert.equal(calls, 1);
  const manual = { ...track, videoTitle: 'Video', title: 'Corrected', artist: 'Manual artist' };
  assert.deepEqual(applyMusicMetadata(manual, mapMusicItem(item('new'))), manual);
  assert.equal(
    applyMusicMetadata(manual, mapMusicItem(item('new')), { overwrite: true }).artist,
    'Artist A, Artist B'
  );
  let failures = 0;
  const broken = new YouTubeMusicResolver({
    minGapMs: 0,
    retries: 1,
    createClient: async () => {
      failures++;
      throw new Error('offline');
    }
  });
  assert.equal(await broken.resolve(track), null);
  assert.equal(failures, 2);
  const nonMusic = new YouTubeMusicResolver({
    minGapMs: 0,
    createClient: async () => ({
      getInfo: async () => ({ getUpNext: async () => ({ contents: [item('unrelated')] }) })
    })
  });
  assert.equal(await nonMusic.resolve(track), null);
});

test('cleans only video decorations and verified artist prefixes while preserving musical versions', () => {
  const { cleanMusicTitle } = require('../src/core/youtubeMusicMetadata');
  const artists = [{ name: 'Sezen Aksu' }];
  assert.equal(cleanMusicTitle('Sezen Aksu - Zalim (Official Audio)', artists), 'Zalim');
  assert.equal(cleanMusicTitle('Song (Remix) (Official Video)', artists), 'Song (Remix)');
  assert.equal(
    cleanMusicTitle('Song (Live at Wembley) [4K HD]', artists),
    'Song (Live at Wembley)'
  );
  assert.equal(cleanMusicTitle('Someone - A title', artists), 'Someone - A title');
});
