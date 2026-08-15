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

test('player payload uses one compact embed with linked title, lyrics, artwork and two rows', () => {
  const payload = buildPlayerPayload(createSession());
  const embed = payload.embeds[0].toJSON();

  assert.equal(embed.title, '🎵\u2003NOW PLAYING');
  assert.ok(
    embed.description.includes('[Artist — Song](https://www.youtube.com/watch?v=video-id)')
  );
  assert.match(embed.description, /♪ Previous/);
  assert.match(embed.description, /▶ \*\*Current\*\*/);
  assert.match(embed.description, /♪ Next/);
  assert.doesNotMatch(embed.description, /Requested by:/);
  assert.doesNotMatch(embed.description, /-{3,}|—{3,}/);
  assert.match(embed.description, /video-id\)\n\n♪ Previous/);
  assert.doesNotMatch(embed.description, /\nAlbum\n/);
  assert.match(embed.description, /\*Up Next: Next Artist — Next Song\*$/);
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
  assert.equal(stopped.embeds[0].toJSON().title, '⏹ Playback stopped');
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
  assert.doesNotMatch(cachePlayback.embeds[0].toJSON().fields[1].value, /Autoplay:/);
});
