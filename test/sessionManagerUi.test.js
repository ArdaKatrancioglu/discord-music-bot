const test = require('node:test');
const assert = require('node:assert/strict');

const {
  disconnectIfChannelEmpty,
  getRetainedPlayerUiState,
  sessions
} = require('../src/core/sessionManager');

test('voice-empty disconnect stops and retains the existing player panel', async () => {
  const guildId = 'voice-empty-ui-test';
  let edits = 0;
  let connectionDestroyed = false;
  const playerMessage = {
    id: 'player-message-1',
    channelId: 'text-channel-1',
    async edit(payload) {
      edits++;
      assert.equal(payload.embeds[0].toJSON().title, '⏹ Playback stopped');
      return this;
    }
  };
  const session = {
    guildId,
    connection: {
      joinConfig: { channelId: 'voice-channel-1', guildId },
      destroy() {
        connectionDestroyed = true;
      }
    },
    player: {
      state: {},
      stop() {}
    },
    queue: [{ title: 'queued track' }],
    currentTrack: { title: 'current track' },
    repeatCache: true,
    cachePool: [{}],
    looping: true,
    loopCount: 1,
    loopQueue: [{}],
    loopIndex: 0,
    autoplay: true,
    autoplayInProgress: false,
    downloadGeneration: 0,
    playbackGeneration: 1,
    lyricsEnabled: true,
    lyricsGeneration: 0,
    playerMessage,
    playerMessageId: playerMessage.id,
    playerChannelId: playerMessage.channelId,
    lastChannel: { async send() {} }
  };
  sessions.set(guildId, session);

  const guild = {
    channels: {
      cache: new Map([
        [
          'voice-channel-1',
          {
            members: {
              filter() {
                return { size: 0 };
              }
            }
          }
        ]
      ])
    }
  };

  const disconnected = await disconnectIfChannelEmpty(guildId, guild);

  assert.equal(disconnected, true);
  assert.equal(sessions.has(guildId), false);
  assert.equal(connectionDestroyed, true);
  assert.equal(edits, 1);
  assert.equal(session.currentTrack, null);
  assert.deepEqual(session.queue, []);
  assert.equal(getRetainedPlayerUiState(guildId).playerMessage, playerMessage);
});
