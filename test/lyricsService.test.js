const test = require('node:test');
const assert = require('node:assert/strict');

const {
  disableLyrics,
  enableLyrics,
  findActiveLineIndex,
  getPlaybackPosition,
  parseLrc,
  parseTrackIdentity,
  selectBestResult
} = require('../src/services/lyricsService');

test('parseLrc parses timestamps, supports repeated tags, and ignores invalid or empty lines', () => {
  assert.deepEqual(
    parseLrc(
      '[ar:Artist]\n[00:12.34] First line\n[00:17.810][00:18.00] Second line\n[00:61.00] Invalid\n[00:20.00]   '
    ),
    [
      { timestamp: 12.34, text: 'First line' },
      { timestamp: 17.81, text: 'Second line' },
      { timestamp: 18, text: 'Second line' }
    ]
  );
});

test('findActiveLineIndex returns the latest timestamp at or before playback', () => {
  const lines = [
    { timestamp: 39.2, text: 'previous' },
    { timestamp: 42.1, text: 'current' },
    { timestamp: 46.8, text: 'next' }
  ];

  assert.equal(findActiveLineIndex(lines, 38), -1);
  assert.equal(findActiveLineIndex(lines, 42.6), 1);
  assert.equal(findActiveLineIndex(lines, 46.8), 2);
});

test('getPlaybackPosition prefers the audio resource playback clock', () => {
  const session = {
    player: { state: { resource: { playbackDuration: 135400 } } },
    trackStartedAt: Date.now() - 999999
  };
  assert.equal(getPlaybackPosition(session), 135.4);
});

test('getPlaybackPosition fallback subtracts accumulated and current pause time', () => {
  const now = Date.now();
  const session = {
    player: { state: {} },
    trackStartedAt: now - 20000,
    pausedDurationMs: 3000,
    pausedAt: now - 2000,
    isPaused: true
  };
  assert.ok(Math.abs(getPlaybackPosition(session) - 15) < 0.05);
});

test('parseTrackIdentity removes common YouTube title decorations', () => {
  assert.deepEqual(
    parseTrackIdentity({
      title: 'Arctic Monkeys - Do I Wanna Know? (Official Video)',
      artist: 'Arctic Monkeys - Topic',
      duration: 266
    }),
    { title: 'Do I Wanna Know?', artist: 'Arctic Monkeys', album: '', duration: 266 }
  );
});

test('parseTrackIdentity prefers an artist-title prefix over a decorated uploader name', () => {
  assert.deepEqual(
    parseTrackIdentity({
      title: 'Erol Evgin - İşte Öyle Bir Şey (Official Video)',
      uploader: 'Erol Evgin VEVO',
      duration: 220
    }),
    { title: 'İşte Öyle Bir Şey', artist: 'Erol Evgin', album: '', duration: 220 }
  );
});

test('parseTrackIdentity does not mistake an unrelated uploader for the artist', () => {
  assert.deepEqual(
    parseTrackIdentity({
      title: 'Hadise - Yaz Günü (Official Video)',
      uploader: 'paga play',
      duration: 218
    }),
    { title: 'Yaz Günü', artist: 'Hadise', album: '', duration: 218 }
  );
});

test('parseTrackIdentity removes standalone quality labels', () => {
  assert.deepEqual(
    parseTrackIdentity({
      title: 'Five Finger Death Punch - House of The Rising Sun (Audio) (HQ)',
      uploader: 'Black Fire',
      duration: 248
    }),
    {
      title: 'House of The Rising Sun',
      artist: 'Five Finger Death Punch',
      album: '',
      duration: 248
    }
  );
});

test('selectBestResult prioritizes artist and close duration among synced results', () => {
  const syncedLyrics = '[00:01.00] line';
  const selected = selectBestResult(
    [
      {
        trackName: 'Song',
        artistName: 'Wrong Artist',
        duration: 180,
        syncedLyrics
      },
      {
        trackName: 'Song',
        artistName: 'Right Artist',
        duration: 201,
        syncedLyrics
      },
      {
        trackName: 'Song',
        artistName: 'Right Artist',
        duration: 200,
        plainLyrics: 'plain only',
        syncedLyrics: null
      }
    ],
    { title: 'Song', artist: 'Right Artist', album: '', duration: 200 }
  );

  assert.equal(selected.artistName, 'Right Artist');
  assert.equal(selected.duration, 201);
});

test('lyrics worker starts from the current playback line instead of the beginning', async () => {
  const originalFetch = global.fetch;
  const renderedDescriptions = [];
  const track = { title: 'Unique Worker Test Song', artist: 'Test Artist', duration: 180 };
  const session = {
    currentTrack: track,
    playbackGeneration: 1,
    lyricsGeneration: 0,
    lyricsEnabled: false,
    guildId: 'guild-1',
    player: { state: { resource: { playbackDuration: 135400 } } },
    playerMessage: {
      id: 'message-1',
      channelId: 'channel-1',
      async edit(payload) {
        const description = payload.embeds[0].toJSON().description;
        renderedDescriptions.push(description);
        if (description.includes('line B')) disableLyrics(session);
        return this;
      }
    }
  };

  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [
        {
          trackName: track.title,
          artistName: track.artist,
          duration: track.duration,
          syncedLyrics: '[02:11.30] line A\n[02:15.10] line B\n[02:19.80] line C'
        }
      ];
    }
  });

  try {
    enableLyrics(session, null);
    const task = session.lyricsTask;
    await task;
    assert.ok(renderedDescriptions.some((description) => description.includes('▶ **line B**')));
    assert.ok(renderedDescriptions.every((description) => !description.includes('▶ **line A**')));
  } finally {
    disableLyrics(session);
    global.fetch = originalFetch;
  }
});

test('lyrics search falls back to a keyword query when metadata search is empty', async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  const track = {
    title: 'Fallback Artist - Unique Fallback Song (Official Video)',
    uploader: 'Unrelated Channel',
    duration: 180
  };
  const session = {
    currentTrack: track,
    playbackGeneration: 1,
    lyricsGeneration: 0,
    lyricsEnabled: false,
    guildId: 'guild-1',
    player: { state: { resource: { playbackDuration: 1500 } } },
    playerMessage: {
      id: 'message-1',
      channelId: 'channel-1',
      async edit(payload) {
        if (payload.embeds[0].toJSON().description.includes('fallback line')) {
          disableLyrics(session);
        }
        return this;
      }
    }
  };

  global.fetch = async (url) => {
    requestedUrls.push(url.toString());
    return {
      ok: true,
      status: 200,
      async json() {
        if (requestedUrls.length === 1) return [];
        return [
          {
            trackName: 'Unique Fallback Song',
            artistName: 'Fallback Artist',
            duration: 180,
            syncedLyrics: '[00:01.00] fallback line'
          }
        ];
      }
    };
  };

  try {
    enableLyrics(session, null);
    await session.lyricsTask;

    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0], /track_name=Unique\+Fallback\+Song/);
    assert.match(requestedUrls[0], /artist_name=Fallback\+Artist/);
    assert.match(requestedUrls[1], /q=Fallback\+Artist\+-\+Unique\+Fallback\+Song/);
    assert.doesNotMatch(requestedUrls[1], /artist_name=/);
  } finally {
    disableLyrics(session);
    global.fetch = originalFetch;
  }
});
