const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the existing playback coordinator with voice output and Discord UI mocked.
const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const resources = [];
require.cache[voicePath].exports = {
  ...voice,
  createAudioResource(filePath, options) {
    const resource = { filePath, options };
    resources.push(resource);
    return resource;
  }
};
const ui = require('../src/services/playerUiService');
ui.startPlayerUi = async () => {};
const { sessions, playNext } = require('../src/core/sessionManager');
const { normalizeTrack } = require('../src/core/libraryMigration');

test('migrated songs and non-music videos play using their original downloaded path and ID', async () => {
  for (const source of [
    {
      id: 'bpOSxM0rNPM',
      title: 'Song',
      artist: 'Artist',
      videoTitle: 'Official Video',
      filePath: '/original/song.webm',
      url: 'https://youtube.com/watch?v=bpOSxM0rNPM',
      lyrics: 'lyrics/bpOSxM0rNPM.ttml'
    },
    { id: 'nonmusic123', title: 'Movie', filePath: '/original/movie.mp3' }
  ]) {
    const track = normalizeTrack(source);
    let played;
    const session = {
      guildId: source.id,
      queue: [track],
      currentTrack: null,
      playbackGeneration: 0,
      lyricsGeneration: 0,
      lyricsEnabled: false,
      recentHistory: [],
      player: {
        play(resource) {
          played = resource;
        }
      }
    };
    sessions.set(source.id, session);
    try {
      await playNext(source.id);
      assert.equal(session.currentTrack.id, source.id);
      assert.equal(played.filePath, source.filePath);
      assert.equal(
        played.options.inputType,
        source.filePath.endsWith('.webm') ? voice.StreamType.WebmOpus : voice.StreamType.Arbitrary
      );
      assert.equal(session.playbackGeneration, 1);
    } finally {
      sessions.delete(source.id);
    }
  }
  assert.equal(resources.length, 2);
});
