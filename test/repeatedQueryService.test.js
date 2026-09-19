const test = require('node:test');
const assert = require('node:assert/strict');
const { RepeatedQueryTracker } = require('../src/services/repeatedQueryService');

test('a repeated query excludes the previously served cached video', () => {
  const tracker = new RepeatedQueryTracker();

  const first = tracker.begin('user-1', '  House of the Rising Sun ');
  assert.equal(first.shouldTryYouTubeAlternative, false);
  tracker.markServed('user-1', 'House of the Rising Sun', { id: 'video-one' });

  const second = tracker.begin('user-1', 'house OF the rising sun');
  assert.equal(second.shouldTryYouTubeAlternative, true);
  assert.deepEqual([...second.excludedVideoIds], ['video-one']);

  tracker.markServed('user-1', 'house of the rising sun', { id: 'video-two' });
  const third = tracker.begin('user-1', 'house of the rising sun');
  assert.deepEqual([...third.excludedVideoIds], ['video-one', 'video-two']);
});

test('a different query resets repeated-query exclusions', () => {
  const tracker = new RepeatedQueryTracker();
  tracker.begin('user-1', 'first song');
  tracker.markServed('user-1', 'first song', { id: 'first-video' });

  const different = tracker.begin('user-1', 'second song');
  assert.equal(different.shouldTryYouTubeAlternative, false);
  assert.equal(different.excludedVideoIds.size, 0);
});
