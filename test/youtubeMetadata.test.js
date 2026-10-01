const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractYouTubeVideoId,
  fetchMetadataWithFallback,
  selectMetadataResult
} = require('../src/core/youtubeMetadata');

test('metadata falls back from cookieless to cookies and records both attempts', async () => {
  const modes = [];
  const attempts = [];
  const expected = { realId: 'video-id' };

  const result = await fetchMetadataWithFallback('ytsearch1:test song', {
    cookiesAvailable: true,
    fetcher: async (_input, { useCookies }) => {
      modes.push(useCookies);
      if (!useCookies) throw new Error('Sign in to confirm');
      return expected;
    },
    onAttempt: (attempt) => attempts.push(attempt)
  });

  assert.deepEqual(modes, [false, true]);
  assert.equal(result.metadata, expected);
  assert.equal(result.usedCookieFallback, true);
  assert.deepEqual(
    attempts.map(({ useCookies, success }) => [useCookies, success]),
    [
      [false, false],
      [true, true]
    ]
  );
});

test('metadata never attempts cookies when cookies.txt is unavailable', async () => {
  const modes = [];

  await assert.rejects(
    fetchMetadataWithFallback('ytsearch1:test song', {
      cookiesAvailable: false,
      fetcher: async (_input, { useCookies }) => {
        modes.push(useCookies);
        throw new Error('network failed');
      }
    }),
    /network failed/
  );

  assert.deepEqual(modes, [false]);
});

test('extractYouTubeVideoId supports common YouTube URL formats', () => {
  const id = 'D9G1VOjN_84';
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${id}&list=abc`), id);
  assert.equal(extractYouTubeVideoId(`https://youtu.be/${id}?si=abc`), id);
  assert.equal(extractYouTubeVideoId(`www.youtube.com/shorts/${id}`), id);
  assert.equal(extractYouTubeVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(extractYouTubeVideoId('https://example.com/watch?v=D9G1VOjN_84'), null);
  assert.equal(extractYouTubeVideoId('not a URL'), null);
});

test('selectMetadataResult skips video IDs rejected by repeated queries', () => {
  const output = [
    JSON.stringify({ id: 'first-id', title: 'First result' }),
    JSON.stringify({ id: 'second-id', title: 'Second result' })
  ].join('\n');

  assert.equal(selectMetadataResult(output, new Set(['first-id'])).id, 'second-id');
  assert.throws(
    () => selectMetadataResult(output, new Set(['first-id', 'second-id'])),
    /no alternative results/
  );
});
