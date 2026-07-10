const https = require('https');

const LISTENBRAINZ_API_ROOT = 'https://api.listenbrainz.org/1';
const MUSICBRAINZ_API_ROOT = 'https://musicbrainz.org/ws/2';
const USER_AGENT =
  'discord-music-bot-autoplay/1.0 (https://github.com/ArdaKatrancioglu/discord-music-bot)';

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(options.token ? { Authorization: `Token ${options.token}` } : {})
        }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          let json;
          try {
            json = body ? JSON.parse(body) : {};
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url.hostname}: ${error.message}`));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const detail = json.error || json.message || response.statusMessage || 'request failed';
            reject(new Error(`${url.hostname} returned ${response.statusCode}: ${detail}`));
            return;
          }

          resolve(json);
        });
      }
    );

    request.setTimeout(10_000, () => request.destroy(new Error(`Request timed out: ${url}`)));
    request.on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function selectMusicBrainzRecording(response, artist, track) {
  const recordings = Array.isArray(response?.recordings) ? response.recordings : [];
  const wantedArtist = normalizeText(artist);
  const wantedTrack = normalizeText(track);

  const ranked = recordings
    .map((recording) => {
      const credits = Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : [];
      const matchingCredit =
        credits.find((credit) => normalizeText(credit?.name) === wantedArtist) || credits[0];
      const titleMatches = normalizeText(recording.title) === wantedTrack;
      const artistMatches = normalizeText(matchingCredit?.name) === wantedArtist;
      const disambiguationPenalty = recording.disambiguation ? 5 : 0;

      return {
        recordingMbid: recording.id,
        artistMbid: matchingCredit?.artist?.id,
        artist: matchingCredit?.name,
        track: recording.title,
        score:
          Number(recording.score || 0) +
          (titleMatches ? 20 : 0) +
          (artistMatches ? 20 : 0) -
          disambiguationPenalty
      };
    })
    .filter((item) => item.recordingMbid && item.artistMbid)
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

function normalizeRadioEntries(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return [];

  return Object.values(response)
    .filter(Array.isArray)
    .flatMap((entries) => entries)
    .filter((entry) => entry?.recording_mbid)
    .map((entry) => ({
      recordingMbid: entry.recording_mbid,
      artistMbid: entry.similar_artist_mbid || null,
      artist: entry.similar_artist_name || null,
      listenCount: Number(entry.total_listen_count || 0)
    }));
}

function normalizeRecordingMetadata(response, radioEntries = []) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return [];

  const radioByRecording = new Map(radioEntries.map((entry) => [entry.recordingMbid, entry]));

  return Object.entries(response)
    .map(([recordingMbid, metadata]) => {
      const radio = radioByRecording.get(recordingMbid) || {};
      const recording = metadata?.recording || {};
      const artist = metadata?.artist || {};

      return {
        source: 'listenbrainz-radio',
        type: 'track',
        recordingMbid,
        artistMbid: radio.artistMbid || artist.artists?.[0]?.artist_mbid || null,
        artist: artist.name || radio.artist || null,
        track: recording.name || null,
        listenCount: radio.listenCount || 0,
        match: Math.min(1, Math.log10((radio.listenCount || 0) + 1) / 6)
      };
    })
    .filter((candidate) => candidate.artist && candidate.track);
}

function buildMusicBrainzQuery(artist, track) {
  const escape = (value) => String(value || '').replace(/[\\"]/g, '\\$&');
  return `artist:"${escape(artist)}" AND recording:"${escape(track)}"`;
}

function createListenBrainzClient({
  token = process.env.LISTENBRAINZ_TOKEN || null,
  getJson = requestJson
} = {}) {
  async function lookupWithListenBrainz(artist, track) {
    if (!token) return null;

    const url = new URL(`${LISTENBRAINZ_API_ROOT}/metadata/lookup/`);
    url.searchParams.set('artist_name', artist);
    url.searchParams.set('recording_name', track);
    const response = await getJson(url, { token });

    return response?.artist_mbids?.[0]
      ? {
        recordingMbid: response.recording_mbid || null,
        artistMbid: response.artist_mbids[0],
        artist: response.artist_credit_name || artist,
        track: response.recording_name || track
      }
      : null;
  }

  async function lookupWithMusicBrainz(artist, track) {
    const url = new URL(`${MUSICBRAINZ_API_ROOT}/recording/`);
    url.searchParams.set('query', buildMusicBrainzQuery(artist, track));
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '5');
    const response = await getJson(url);
    return selectMusicBrainzRecording(response, artist, track);
  }

  async function resolveReference(artist, track) {
    if (token) {
      try {
        const match = await lookupWithListenBrainz(artist, track);
        if (match) return match;
      } catch (error) {
        console.warn('[ListenBrainz] Metadata lookup failed; trying MusicBrainz:', error.message);
      }
    }

    return lookupWithMusicBrainz(artist, track);
  }

  async function getArtistRadio(artistMbid) {
    const url = new URL(`${LISTENBRAINZ_API_ROOT}/lb-radio/artist/${artistMbid}`);
    url.searchParams.set('mode', 'medium');
    url.searchParams.set('max_similar_artists', '12');
    url.searchParams.set('max_recordings_per_artist', '3');
    url.searchParams.set('pop_begin', '10');
    url.searchParams.set('pop_end', '100');
    return normalizeRadioEntries(await getJson(url, { token }));
  }

  async function getRecordingMetadata(entries) {
    const recordingMbids = [
      ...new Set(entries.map((entry) => entry.recordingMbid).filter(Boolean))
    ];
    if (!recordingMbids.length) return [];

    const url = new URL(`${LISTENBRAINZ_API_ROOT}/metadata/recording/`);
    url.searchParams.set('recording_mbids', recordingMbids.join(','));
    url.searchParams.set('inc', 'artist');
    const response = await getJson(url, { token });
    return normalizeRecordingMetadata(response, entries);
  }

  async function getCandidates(reference) {
    const resolved = await resolveReference(reference.artist, reference.track);
    if (!resolved?.artistMbid) return [];

    const radioEntries = await getArtistRadio(resolved.artistMbid);
    const candidates = await getRecordingMetadata(radioEntries);

    return candidates.sort((a, b) => b.listenCount - a.listenCount).slice(0, 10);
  }

  return {
    getCandidates,
    resolveReference,
    lookupWithListenBrainz,
    lookupWithMusicBrainz,
    getArtistRadio,
    getRecordingMetadata
  };
}

module.exports = {
  createListenBrainzClient,
  normalizeRadioEntries,
  normalizeRecordingMetadata,
  selectMusicBrainzRecording
};
