const { findAutoplayCandidate } = require('./autoplayService');

function getAutoplayReferenceTrack(session) {
  if (session.queue?.length > 0) {
    return session.queue[session.queue.length - 1];
  }

  if (session.currentTrack) {
    return session.currentTrack;
  }

  if (session.lastAutoplayReferenceTrack) {
    return session.lastAutoplayReferenceTrack;
  }

  return null;
}

function shouldPrepareAutoplay(session) {
  if (!session.autoplay) return false;
  if (session.autoplayInProgress) return false;
  if (session.queue.length > 0) return false;
  if (!session.currentTrack) return true;

  if (!session.currentTrack.duration || !session.trackStartedAt) {
    return false;
  }

  const elapsedSeconds = (Date.now() - session.trackStartedAt) / 1000;
  const remainingSeconds = session.currentTrack.duration - elapsedSeconds;

  return remainingSeconds <= (session.autoplayLookaheadSeconds || 60);
}

async function findNextAutoplayTrack(session) {
  if (!session.autoplay) {
    throw new Error('Autoplay is disabled.');
  }

  if (session.autoplayInProgress) {
    throw new Error('Autoplay lookup is already in progress.');
  }

  const referenceTrack = getAutoplayReferenceTrack(session);

  if (!referenceTrack) {
    throw new Error('No autoplay reference track found.');
  }

  if (!referenceTrack.url) {
    throw new Error(`Autoplay reference track has no URL: ${referenceTrack.title || 'unknown title'}`);
  }

  session.autoplayInProgress = true;

  try {
    const historyUrls = [
      referenceTrack.url,
      ...(session.queue || []).map(t => t.url).filter(Boolean),
      ...(session.loopQueue || []).map(t => t.url).filter(Boolean),
      session.currentTrack?.url
    ].filter(Boolean);

    const result = await findAutoplayCandidate(referenceTrack.url, historyUrls);

    if (!result) {
      throw new Error('Autoplay candidate search returned no result.');
    }

    if (!result.selected) {
      throw new Error('Autoplay could not find a reliable candidate.');
    }

    const selected = result.selected;
    const url = selected.track.webpage_url || selected.track.url;

    if (!url) {
      throw new Error(`Selected autoplay candidate has no URL: ${selected.track.title || 'unknown title'}`);
    }

    return {
      url,
      title: selected.track.title,
      source: selected.source,
      score: selected.score,
      referenceTrack
    };
  } finally {
    session.autoplayInProgress = false;
  }
}

module.exports = {
  getAutoplayReferenceTrack,
  shouldPrepareAutoplay,
  findNextAutoplayTrack
};