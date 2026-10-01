const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDownloadAttemptPlan,
  classifyDownloadError,
  diagnoseDownloadError,
  recoveryStrategiesFor,
  summarizeAttempt
} = require('../src/services/downloadService');

test('download plan tries each strategy without cookies before its cookie fallback', () => {
  const plan = buildDownloadAttemptPlan({ cookiesAvailable: true });

  assert.deepEqual(
    plan.slice(0, 4).map(({ strategyKey, useCookies }) => [strategyKey, useCookies]),
    [
      ['preferredAudio', false],
      ['preferredAudio', true],
      ['anyAudio', false],
      ['anyAudio', true]
    ]
  );
  assert.equal(plan.at(-1).strategyKey, 'ytDlpDefault');
  assert.equal(plan.at(-1).useCookies, true);
});

test('download plan omits cookie attempts when cookies.txt is unavailable', () => {
  const plan = buildDownloadAttemptPlan({ cookiesAvailable: false });

  assert.deepEqual(
    plan.map(({ strategyKey, useCookies }) => [strategyKey, useCookies]),
    [
      ['preferredAudio', false],
      ['anyAudio', false],
      ['alternateClient', false],
      ['alternateLowBandwidth', false],
      ['ytDlpDefault', false]
    ]
  );
});

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

test('retry diagnostics expose the actual yt-dlp error instead of only the exit code', () => {
  const attempt = summarizeAttempt(
    { name: 'preferred audio-only format' },
    {
      code: 1,
      stderrData: '[youtube] Loading player\nERROR: Sign in to confirm you are not a bot\n',
      stdoutData: ''
    }
  );

  assert.equal(attempt.code, 1);
  assert.equal(attempt.message, 'ERROR: Sign in to confirm you are not a bot');
});

test('403 diagnostics explain the failed media request and expose format and client context', () => {
  const details = diagnoseDownloadError({
    code: 1,
    stderrData: 'ERROR: unable to download video data: HTTP Error 403: Forbidden',
    stdoutData:
      '[youtube] abc: Downloading android vr player API JSON\n' +
      '[info] abc: Downloading 1 format(s): 251\n'
  });

  assert.match(details.join('\n'), /media CDN rejected/);
  assert.match(details.join('\n'), /Rejected format: 251/);
  assert.match(details.join('\n'), /Player client\(s\): android vr/);
  assert.match(details.join('\n'), /PO token/);
});
