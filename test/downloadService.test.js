const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDownloadError, recoveryStrategiesFor } = require('../src/services/downloadService');

function errorWith(message) {
  return { code: 1, stderrData: `ERROR: ${message}`, stdoutData: '' };
}

test('download errors are classified into actionable recovery groups', () => {
  assert.equal(
    classifyDownloadError(errorWith('Requested format is not available')),
    'format-unavailable'
  );
  assert.equal(classifyDownloadError(errorWith('HTTP Error 403: Forbidden')), 'access-denied');
  assert.equal(
    classifyDownloadError(errorWith('HTTP Error 429: Too Many Requests')),
    'rate-limited'
  );
  assert.equal(classifyDownloadError(errorWith('No space left on device')), 'storage');
});

test('missing formats retry broader selectors and alternate clients', () => {
  const strategies = recoveryStrategiesFor(
    errorWith('Requested format is not available. Use --list-formats')
  );

  assert.deepEqual(
    strategies.map((strategy) => strategy.name),
    [
      'any available format containing audio',
      'yt-dlp automatic format selection',
      'alternate YouTube clients with any audio',
      'alternate YouTube clients with low-bandwidth audio'
    ]
  );
});

test('non-recoverable errors do not trigger wasteful retries', () => {
  assert.deepEqual(recoveryStrategiesFor(errorWith('HTTP Error 429: Too Many Requests')), []);
  assert.deepEqual(recoveryStrategiesFor(errorWith('Private video')), []);
  assert.deepEqual(recoveryStrategiesFor(errorWith('No space left on device')), []);
});
