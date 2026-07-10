function candidateKey(candidate) {
  const track = candidate?.track || {};
  const url = track.webpage_url || track.url;
  if (url) return `url:${url}`;

  const id = track.id || track.videoId;
  if (id) return `id:${id}`;

  const title = String(track.title || '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return title ? `title:${title}` : null;
}

function provenanceFor(candidate) {
  if (Array.isArray(candidate.provenance) && candidate.provenance.length) {
    return candidate.provenance;
  }

  return [
    {
      source: candidate.source,
      artist: candidate.artist || null,
      track: candidate.candidateTrack || null,
      recordingMbid: candidate.recordingMbid || null,
      query: candidate.query || null
    }
  ];
}

function dedupeCandidates(candidates) {
  const byKey = new Map();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        sources: [...new Set(candidate.sources || [candidate.source])],
        provenance: provenanceFor(candidate)
      });
      continue;
    }

    const combinedProvenance = [...existing.provenance, ...provenanceFor(candidate)];
    const provenanceKeys = new Set();
    existing.provenance = combinedProvenance.filter((item) => {
      const provenanceKey = `${item.source}|${item.artist}|${item.track}|${item.recordingMbid}`;
      if (provenanceKeys.has(provenanceKey)) return false;
      provenanceKeys.add(provenanceKey);
      return true;
    });
    existing.sources = [
      ...new Set([...existing.sources, ...(candidate.sources || [candidate.source])])
    ];

    if (Number(candidate.score || 0) > Number(existing.score || 0)) {
      existing.score = candidate.score;
      existing.source = candidate.source;
      existing.artist = candidate.artist;
      existing.query = candidate.query;
      existing.recordingMbid = candidate.recordingMbid;
    }
  }

  return [...byKey.values()];
}

async function collectCandidateProviders(providers, onFailure = () => {}) {
  const entries = Object.entries(providers);
  const settled = await Promise.allSettled(entries.map(([, provider]) => provider()));
  const candidates = [];
  const counts = {};

  settled.forEach((result, index) => {
    const providerName = entries[index][0];
    if (result.status === 'fulfilled') {
      const providerCandidates = Array.isArray(result.value) ? result.value : [];
      counts[providerName] = providerCandidates.length;
      candidates.push(...providerCandidates);
      return;
    }

    counts[providerName] = 0;
    onFailure(providerName, result.reason);
  });

  return { candidates, counts };
}

module.exports = {
  candidateKey,
  dedupeCandidates,
  collectCandidateProviders
};
