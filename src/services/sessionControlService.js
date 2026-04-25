function pauseSession(session) {
  session.player.pause();
  session.isPaused = true;
}

function resumeSession(session) {
  try { session.player.unpause(); } catch {}
  session.isPaused = false;
}

function stopSession(session) {
  session.queue = [];
  session.repeatCache = false;
  session.cachePool = [];
  try { session.player.stop(); } catch {}
  session.currentTrack = null;
  session.isPaused = false;
  session.looping = false;
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