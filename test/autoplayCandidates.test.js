const test = require('node:test');
const assert = require('node:assert/strict');
const { collectCandidateProviders, dedupeCandidates } = require('../src/utils/autoplayCandidates');

test('deduplicates the same YouTube candidate while preserving provider provenance', () => {
  const candidates = dedupeCandidates([
    {
      source: 'lastfm-track',
      artist: 'Artist',
      candidateTrack: 'Track',
      track: { id: 'video-1', title: 'Artist - Track' },
      score: 70
    },
    {
      source: 'listenbrainz-radio',
      artist: 'Artist',
      candidateTrack: 'Track',
      recordingMbid: 'recording-1',
      track: { id: 'video-1', title: 'Artist - Track' },
      score: 65
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].sources, ['lastfm-track', 'listenbrainz-radio']);
  assert.deepEqual(
    candidates[0].provenance.map((item) => item.source),
    ['lastfm-track', 'listenbrainz-radio']
  );
  assert.equal(candidates[0].score, 70);
});

test('keeps successful provider candidates when another provider fails', async () => {
  const failures = [];
  const result = await collectCandidateProviders(
    {
      lastfm: async () => [{ source: 'lastfm-track', track: { id: 'ok' } }],
      listenbrainz: async () => {
        throw new Error('temporary failure');
      }
    },
    (provider, error) => failures.push(`${provider}: ${error.message}`)
  );

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.counts, { lastfm: 1, listenbrainz: 0 });
  assert.deepEqual(failures, ['listenbrainz: temporary failure']);
});
