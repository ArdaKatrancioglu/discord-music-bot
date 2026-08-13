const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const musicIndexModule = path.resolve(__dirname, '../src/core/musicIndex.js');
const lyricsServiceModule = path.resolve(__dirname, '../src/services/lyricsService.js');

test('updateTrackLyrics changes only the matching track lyrics field', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-music-index-'));
  const downloadsDirectory = path.join(tempDirectory, 'downloadedMusic');
  fs.mkdirSync(downloadsDirectory);

  const originalIndex = {
    version: 1,
    tracks: [
      {
        id: 'track-1',
        title: 'Existing title',
        titleSan: 'Existing_title',
        filePath: '/music/track-1.webm',
        url: 'https://example.test/track-1',
        duration: 180
      },
      {
        id: 'track-2',
        title: 'Untouched track',
        titleSan: 'Untouched_track',
        filePath: '/music/track-2.webm',
        url: 'https://example.test/track-2'
      }
    ]
  };
  fs.writeFileSync(
    path.join(downloadsDirectory, 'index.json'),
    JSON.stringify(originalIndex, null, 2),
    'utf8'
  );

  const script = `
    const { updateTrackLyrics } = require(${JSON.stringify(musicIndexModule)});
    const updated = updateTrackLyrics('track-1', {
      source: 'lrclib',
      status: 'found',
      syncedLyrics: [{ time: 12.34, text: 'First line' }]
    });
    if (!updated) process.exit(1);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: tempDirectory,
    encoding: 'utf8'
  });

  try {
    assert.equal(child.status, 0, child.stderr);
    const updatedIndex = JSON.parse(
      fs.readFileSync(path.join(downloadsDirectory, 'index.json'), 'utf8')
    );
    assert.deepEqual(updatedIndex.tracks[0], {
      ...originalIndex.tracks[0],
      lyrics: {
        source: 'lrclib',
        status: 'found',
        syncedLyrics: [{ time: 12.34, text: 'First line' }]
      }
    });
    assert.deepEqual(updatedIndex.tracks[1], originalIndex.tracks[1]);
    assert.equal(updatedIndex.version, originalIndex.version);

    const cacheReadScript = `
      const { enableLyrics, disableLyrics } = require(${JSON.stringify(lyricsServiceModule)});
      let fetchCalled = false;
      global.fetch = async () => {
        fetchCalled = true;
        throw new Error('LRCLIB must not be called on a persistent cache hit');
      };
      const rendered = [];

      const track = {
        id: 'track-1',
        title: 'Existing title',
        titleSan: 'Existing_title',
        duration: 180
      };
      const session = {
        currentTrack: track,
        guildId: 'guild-1',
        playbackGeneration: 1,
        lyricsGeneration: 0,
        lyricsEnabled: false,
        player: { state: { resource: { playbackDuration: 13000 } } },
        playerMessage: {
          id: 'message-1',
          channelId: 'channel-1',
          async edit(payload) {
            const description = payload.embeds[0].toJSON().description;
            if (description.includes('First line')) {
              rendered.push(description);
              disableLyrics(session);
            }
            return this;
          }
        }
      };

      (async () => {
        enableLyrics(session, null);
        const task = session.lyricsTask;
        await task;
        if (fetchCalled) process.exit(2);
        if (!rendered[0]?.includes('▶ **First line**')) process.exit(3);
      })().catch(() => process.exit(4));
    `;
    const cacheReadChild = spawnSync(process.execPath, ['-e', cacheReadScript], {
      cwd: tempDirectory,
      encoding: 'utf8'
    });
    assert.equal(cacheReadChild.status, 0, cacheReadChild.stderr || cacheReadChild.stdout);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
