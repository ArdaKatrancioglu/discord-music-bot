const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createListenBrainzClient,
  normalizeRadioEntries,
  normalizeRecordingMetadata,
  selectMusicBrainzRecording
} = require('../src/services/listenBrainzService');

test('normalizes artist-radio and recording metadata into autoplay recommendations', () => {
  const radio = normalizeRadioEntries({
    'artist-1': [
      {
        recording_mbid: 'recording-1',
        similar_artist_mbid: 'artist-1',
        similar_artist_name: 'Artist One',
        total_listen_count: 1000
      }
    ]
  });

  assert.deepEqual(radio, [
    {
      recordingMbid: 'recording-1',
      artistMbid: 'artist-1',
      artist: 'Artist One',
      listenCount: 1000
    }
  ]);

  const candidates = normalizeRecordingMetadata(
    {
      'recording-1': {
        artist: { name: 'Artist One' },
        recording: { name: 'Track One' }
      }
    },
    radio
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'listenbrainz-radio');
  assert.equal(candidates[0].artist, 'Artist One');
  assert.equal(candidates[0].track, 'Track One');
  assert.equal(candidates[0].recordingMbid, 'recording-1');
});

test('selects an exact artist and track MusicBrainz result over a loose result', () => {
  const selected = selectMusicBrainzRecording(
    {
      recordings: [
        {
          id: 'loose',
          score: 100,
          title: 'A Live Version',
          'artist-credit': [{ name: 'Other Artist', artist: { id: 'other' } }]
        },
        {
          id: 'exact',
          score: 90,
          title: 'No Surprises',
          'artist-credit': [{ name: 'Radiohead', artist: { id: 'radiohead' } }]
        }
      ]
    },
    'Radiohead',
    'No Surprises'
  );

  assert.equal(selected.recordingMbid, 'exact');
  assert.equal(selected.artistMbid, 'radiohead');
});

test('uses public MusicBrainz resolution when no ListenBrainz token is configured', async () => {
  const requestedHosts = [];
  const client = createListenBrainzClient({
    token: null,
    getJson: async (url) => {
      requestedHosts.push(url.hostname);

      if (url.hostname === 'musicbrainz.org') {
        return {
          recordings: [
            {
              id: 'seed-recording',
              score: 100,
              title: 'Seed Track',
              'artist-credit': [{ name: 'Seed Artist', artist: { id: 'seed-artist' } }]
            }
          ]
        };
      }

      if (url.pathname.includes('/lb-radio/artist/')) {
        return {
          candidateArtist: [
            {
              recording_mbid: 'candidate-recording',
              similar_artist_mbid: 'candidate-artist',
              similar_artist_name: 'Candidate Artist',
              total_listen_count: 50
            }
          ]
        };
      }

      return {
        'candidate-recording': {
          artist: { name: 'Candidate Artist' },
          recording: { name: 'Candidate Track' }
        }
      };
    }
  });

  const candidates = await client.getCandidates({ artist: 'Seed Artist', track: 'Seed Track' });

  assert.deepEqual(requestedHosts, [
    'musicbrainz.org',
    'api.listenbrainz.org',
    'api.listenbrainz.org'
  ]);
  assert.equal(candidates[0].track, 'Candidate Track');
});
