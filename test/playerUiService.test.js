const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlayerPayload,
  buildProgressBar,
  formatDuration,
  requestPlayerUpdate
} = require('../src/services/playerUiService');

function createSession(overrides = {}) {
  return {
    guildId: 'guild-1',
    currentTrack: {
      title: 'video-id',
      displayTitle: 'Artist - Song',
      artist: 'Artist',
      album: 'Album',
      url: 'https://www.youtube.com/watch?v=video-id',
      duration: 198,
      thumbnail: 'https://i.ytimg.com/vi/video-id/hqdefault.jpg',
      requester: { id: 'user-1', name: 'Listener' },
      lyricsOffset: 1
    },
    queue: [{ title: 'Next Artist - Next Song' }],
    player: { state: { resource: { playbackDuration: 102000 } } },
    isPaused: false,
    looping: false,
    lyricsEnabled: true,
    lyricsStatus: 'synced',
    lyricsLines: [
      { timestamp: 99, text: 'Previous' },
      { timestamp: 101, text: 'Current' },
      { timestamp: 106, text: 'Next' }
    ],
    playbackGeneration: 4,
    ...overrides
  };
}

test('duration and progress helpers produce a fixed-width readable clock', () => {
  assert.equal(formatDuration(102.9), '01:42');
  assert.equal(formatDuration(3661), '1:01:01');
  const progress = buildProgressBar(102, 198);
  assert.match(progress, /^01:42 {2}[─●]{20} {2}03:18$/);
  assert.equal([...progress.match(/[─●]/g)].length, 20);
});

test('player payload uses a native linked title, lyrics, artwork and two rows', () => {
  const payload = buildPlayerPayload(createSession());
  const embed = payload.embeds[0].toJSON();

  assert.equal(embed.author, undefined);
  assert.equal(embed.title, 'Song');
  assert.equal(embed.url, 'https://www.youtube.com/watch?v=video-id');
  assert.ok(
    embed.description.startsWith(
      '*[Artist](https://www.youtube.com/watch?v=video-id)*\n\n♪ Previous'
    )
  );
  assert.doesNotMatch(embed.description, /\\-/);
  assert.match(embed.description, /♪ Previous/);
  assert.match(embed.description, /▶ \*\*Current\*\*/);
  assert.ok(embed.description.includes('♪ Previous\n\n▶ **Current**\n\n♪ Next'));
  assert.match(embed.description, /♪ Next/);
  assert.doesNotMatch(embed.description, /Requested by:/);
  assert.doesNotMatch(JSON.stringify(embed), /Offset:/);
  assert.doesNotMatch(embed.description, /-{3,}|—{3,}/);
  assert.doesNotMatch(embed.description, /\nAlbum\n/);
  assert.doesNotMatch(embed.description, /Up Next:/);
  assert.equal(embed.footer.text, 'Up Next: Next Artist – Next Song');
  assert.equal(embed.thumbnail.url, 'https://i.ytimg.com/vi/video-id/hqdefault.jpg');
  assert.equal(payload.components.length, 2);
  assert.deepEqual(
    payload.components.map((row) => row.components.length),
    [4, 5]
  );
  const customIds = payload.components.flatMap((row) =>
    row.components.map((button) => button.data.custom_id)
  );
  assert.ok(customIds.some((id) => id.endsWith(':autoplay')));
  assert.ok(customIds.every((id) => !id.endsWith(':previous')));
  assert.equal(payload.components[0].components[1].data.label, 'Skip');
  assert.ok(payload.components.flatMap((row) => row.components).every((button) => !button.data.emoji));
});

test('unchanged player payload does not edit the Discord message twice', async () => {
  let edits = 0;
  const session = createSession({
    playerMessage: {
      id: 'message-1',
      channelId: 'channel-1',
      async edit() {
        edits++;
        return this;
      }
    }
  });

  await requestPlayerUpdate(session);
  await requestPlayerUpdate(session);
  assert.equal(edits, 1);
});

test('a stale lyrics generation cannot overwrite a newer track panel', async () => {
  let edits = 0;
  const session = createSession({
    playbackGeneration: 5,
    playerMessage: {
      id: 'message-1',
      channelId: 'channel-1',
      async edit() {
        edits++;
        return this;
      }
    }
  });

  await requestPlayerUpdate(session, { expectedPlaybackGeneration: 4 });
  assert.equal(edits, 0);
});

test('a deleted player message is recreated in the active text channel', async () => {
  let sends = 0;
  const replacement = { id: 'message-2', channelId: 'channel-1' };
  const session = createSession({
    playerMessage: {
      async edit() {
        const error = new Error('Unknown Message');
        error.code = 10008;
        throw error;
      }
    },
    lastChannel: {
      async send() {
        sends++;
        return replacement;
      }
    }
  });

  await requestPlayerUpdate(session, { force: true });
  assert.equal(sends, 1);
  assert.equal(session.playerMessage, replacement);
  assert.equal(session.playerMessageId, 'message-2');
});

test('player is reposted only when a newer channel message exists', async () => {
  let deletes = 0;
  let edits = 0;
  let sends = 0;
  const channel = {
    lastMessageId: 'new-chat-message',
    async send() {
      sends++;
      return { id: 'player-2', channelId: 'channel-1', channel: this };
    }
  };
  const session = createSession({
    playerMessage: {
      id: 'player-1',
      channelId: 'channel-1',
      channel,
      async delete() {
        deletes++;
      },
      async edit() {
        edits++;
        return this;
      }
    },
    lastChannel: channel
  });

  await requestPlayerUpdate(session, { allowRepost: true });
  assert.equal(deletes, 1);
  assert.equal(edits, 0);
  assert.equal(sends, 1);
  assert.equal(session.playerMessageId, 'player-2');

  channel.lastMessageId = 'player-2';
  session.playerMessage.edit = async function edit() {
    edits++;
    return this;
  };
  await requestPlayerUpdate(session, { force: true });
  assert.equal(deletes, 1);
  assert.equal(edits, 1);
  assert.equal(sends, 1);
});

test('paused and stopped payloads expose the correct disabled controls', () => {
  const paused = buildPlayerPayload(createSession({ isPaused: true }));
  assert.equal(paused.components[0].components[0].data.label, 'Resume');
  assert.equal(paused.components[1].components[3].data.disabled, true);

  const stopped = buildPlayerPayload(createSession({ currentTrack: null }), { stopped: true });
  assert.equal(stopped.embeds[0].toJSON().title, 'Playback stopped');
  assert.ok(stopped.components[0].components.every((button) => button.data.disabled));
  assert.ok(stopped.components[1].components.slice(0, 3).every((button) => button.data.disabled));
  assert.equal(stopped.components[1].components[3].data.disabled, false);
  assert.equal(stopped.components[1].components[4].data.disabled, true);
});

test('zero offset, hidden lyrics and cache playback omit irrelevant controls', () => {
  const lyricsOff = buildPlayerPayload(
    createSession({
      lyricsEnabled: false,
      currentTrack: {
        ...createSession().currentTrack,
        lyricsOffset: 0
      }
    })
  );
  const lyricsOffJson = JSON.stringify({
    embed: lyricsOff.embeds[0].toJSON(),
    components: lyricsOff.components.map((row) => row.toJSON())
  });
  assert.doesNotMatch(lyricsOffJson, /Offset:/);
  assert.doesNotMatch(lyricsOffJson, /offset-minus|offset-plus/);

  const cachePlayback = buildPlayerPayload(
    createSession({
      repeatCache: true,
      currentTrack: { ...createSession().currentTrack, source: 'cache' }
    })
  );
  const cacheJson = JSON.stringify(cachePlayback.components.map((row) => row.toJSON()));
  assert.doesNotMatch(cacheJson, /:autoplay/);
  assert.doesNotMatch(JSON.stringify(cachePlayback.embeds[0].toJSON().fields), /Autoplay:/);
});

test('resolved tracks display a native linked song title with a separate italic artist link', () => {
  const currentTrack = {
    title: 'Yalan',
    artist: 'Edis',
    videoTitle: 'Edis - Yalan (Official Video)',
    displayTitle: 'Old video display',
    url: 'https://youtube.com/watch?v=bpOSxM0rNPM'
  };
  const payload = buildPlayerPayload(
    createSession({
      currentTrack,
      queue: [
        {
          title: 'A documentary - Episode 2',
          artist: null,
          videoTitle: 'A documentary - Episode 2'
        }
      ]
    })
  );
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'Yalan');
  assert.equal(embed.url, 'https://youtube.com/watch?v=bpOSxM0rNPM');
  assert.ok(embed.description.startsWith('*[Edis](https://youtube.com/watch?v=bpOSxM0rNPM)*\n\n'));
  assert.doesNotMatch(embed.title, /\\-|Official Video|Old video display/);
  assert.equal(embed.footer.text, 'Up Next: A documentary - Episode 2');
});

test('instrumental markers cover long intros and gaps without changing lyric timing', () => {
  const lines = [
    { timestamp: 15, text: 'First line' },
    { timestamp: 40, text: 'Second line' },
    { timestamp: 45, text: 'Third line' }
  ];
  const original = JSON.stringify(lines);
  for (const [position, expected] of [
    [0, '▶ **♪**\n\n♪ First line'],
    [15, '▶ **First line**'],
    [24, '▶ **First line**'],
    [25, '♪ First line\n\n▶ **♪**\n\n♪ Second line'],
    [39, '▶ **♪**'],
    [40, '▶ **Second line**'],
    [44, '▶ **Second line**']
  ]) {
    const session = createSession({
      currentTrack: { title: 'Song', lyricsOffset: 0 },
      lyricsLines: lines,
      player: { state: { resource: { playbackDuration: position * 1000 } } }
    });
    assert.ok(buildPlayerPayload(session).embeds[0].toJSON().description.includes(expected));
  }
  assert.equal(JSON.stringify(lines), original);
});

test('instrumental gaps honor explicit line ends and lyric offsets', () => {
  const session = createSession({
    currentTrack: { title: 'Song', lyricsOffset: -4 },
    lyricsLines: [
      { timestamp: 0, end: 5, text: 'First' },
      { timestamp: 20, text: 'Next' }
    ],
    player: { state: { resource: { playbackDuration: 8000 } } }
  });
  assert.match(buildPlayerPayload(session).embeds[0].toJSON().description, /▶ \*\*First\*\*/);
  session.player.state.resource.playbackDuration = 9000;
  assert.match(buildPlayerPayload(session).embeds[0].toJSON().description, /▶ \*\*♪\*\*/);
});

test('the final lyric remains active throughout a long outro', () => {
  const session = createSession({
    currentTrack: { title: 'Song', duration: 120, lyricsOffset: 0 },
    lyricsLines: [{ timestamp: 15, end: 20, text: 'Last line' }],
    player: { state: { resource: { playbackDuration: 90000 } } }
  });
  const embed = buildPlayerPayload(session).embeds[0].toJSON();
  assert.match(embed.description, /▶ \*\*Last line\*\*/);
  assert.doesNotMatch(embed.description, /▶ \*\*♪\*\*/);
});

test('empty queues omit Up Next while loop queues still show the next track', () => {
  const empty = buildPlayerPayload(createSession({ queue: [] })).embeds[0].toJSON();
  assert.doesNotMatch(empty.description, /Up Next|Queue empty/);
  assert.equal(empty.footer, undefined);
  const looping = buildPlayerPayload(
    createSession({
      queue: [],
      looping: true,
      loopIndex: 0,
      loopQueue: [{ title: 'First' }, { title: 'Second' }]
    })
  ).embeds[0].toJSON();
  assert.equal(looping.footer.text, 'Up Next: Second');
});

test('tracks without a URL retain a readable title', () => {
  const currentTrack = { title: 'Yalan', artist: 'Edis', videoTitle: 'Video', url: null };
  const embed = buildPlayerPayload(createSession({ currentTrack })).embeds[0].toJSON();
  assert.equal(embed.title, 'Yalan');
  assert.equal(embed.url, undefined);
  assert.ok(embed.description.startsWith('*Edis*\n\n'));
});

test('parentheses in song names remain unchanged and the YouTube URL stays clickable', () => {
  const currentTrack = {
    title: 'Zehir (feat. Pango)',
    artist: 'manifest',
    videoTitle: 'Zehir official video',
    url: 'https://www.youtube.com/watch?v=xM4Msflqxi0'
  };
  const session = createSession({ currentTrack });
  session.lyricsLines[1].text = 'A lyric (with parentheses)';
  const embed = buildPlayerPayload(session).embeds[0].toJSON();
  assert.equal(embed.title, 'Zehir (feat. Pango)');
  assert.equal(embed.url, currentTrack.url);
  assert.match(embed.description, /A lyric \(with parentheses\)/);
  assert.doesNotMatch(JSON.stringify(embed), /\\\\[()]/);
});
