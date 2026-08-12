// sessionControlService.js

const { clearAutoplayTimer } = require('./autoplaySchedulerService');
const { clearIdleDisconnectTimer } = require('../core/sessionManager');
const { stopLyricsWorker, wakeLyricsWorker } = require('./lyricsService');

function pauseSession(session) {
  clearIdleDisconnectTimer(session);
  if (session.player.pause()) {
    session.isPaused = true;
    session.pausedAt = Date.now();
    wakeLyricsWorker(session);
  }
}

function resumeSession(session) {
  clearIdleDisconnectTimer(session);
  try {
    if (session.player.unpause()) {
      if (session.pausedAt) session.pausedDurationMs += Date.now() - session.pausedAt;
      session.pausedAt = null;
      session.isPaused = false;
      wakeLyricsWorker(session);
    }
  } catch {}
}

function stopSession(session) {
  clearAutoplayTimer(session);
  clearIdleDisconnectTimer(session);
  stopLyricsWorker(session);
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
  session.pausedAt = null;
  session.pausedDurationMs = 0;

  try {
    session.player.stop();
  } catch {}

  session.currentTrack = null;
  session.isPaused = false;
}

function skipSession(session) {
  if (!session.currentTrack) return null;

  const skippedTitle = session.currentTrack.title;
  clearIdleDisconnectTimer(session);
  stopLyricsWorker(session);

  try {
    session.player.unpause();
  } catch {}
  session.isPaused = false;
  session.pausedAt = null;
  session.pausedDurationMs = 0;
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
