// sessionControlService.js

const { clearAutoplayTimer } = require('./autoplaySchedulerService');

function pauseSession(session) {
  session.player.pause();
  session.isPaused = true;
}

function resumeSession(session) {
  try { session.player.unpause(); } catch {}
  session.isPaused = false;
}

function stopSession(session) {
  clearAutoplayTimer(session);
  session.queue = [];

  session.repeatCache = false;
  session.cachePool = [];

  session.looping = false;
  session.loopCount = 0;
  session.loopQueue = [];
  session.loopIndex = 0;
  session.downloadGeneration++;

  session.autoplay = false;
  session.autoplayInProgress = false;
  session.lastAutoplayReferenceTrack = null;
  session.trackStartedAt = null;

  try { session.player.stop(); } catch {}

  session.currentTrack = null;
  session.isPaused = false;
}

function skipSession(session) {
  if (!session.currentTrack) return null;

  const skippedTitle = session.currentTrack.title;

  try { session.player.unpause(); } catch {}
  session.isPaused = false;
  session.looping = false;

  session.currentTrack = null;
  session.player.stop();

  return skippedTitle;
}

module.exports = {
  pauseSession,
  resumeSession,
  stopSession,
  skipSession
};