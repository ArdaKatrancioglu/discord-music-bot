const test = require('node:test');
const assert = require('node:assert/strict');
const { extractYouTubeVideoId, selectMetadataResult } = require('../src/core/youtubeMetadata');

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
