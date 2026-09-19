function normalizeQuery(query) {
  return String(query || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

class RepeatedQueryTracker {
  constructor() {
    this.byUser = new Map();
  }

  begin(userId, query) {
    const queryKey = normalizeQuery(query);
    let state = this.byUser.get(userId);
    if (!state || state.queryKey !== queryKey) {
      state = { queryKey, lastServedVideoId: null, excludedVideoIds: new Set() };
      this.byUser.set(userId, state);
    } else if (state.lastServedVideoId) {
      state.excludedVideoIds.add(state.lastServedVideoId);
      state.lastServedVideoId = null;
    }

    return {
      shouldTryYouTubeAlternative: state.excludedVideoIds.size > 0,
      excludedVideoIds: new Set(state.excludedVideoIds)
    };
  }

  markServed(userId, query, track) {
    const state = this.byUser.get(userId);
    if (!state || state.queryKey !== normalizeQuery(query)) return;
    state.lastServedVideoId = track?.id || null;
  }
}

module.exports = {
  RepeatedQueryTracker,
  normalizeQuery
};
