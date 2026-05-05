const { findNextAutoplayTrack } = require('./autoplayRuntimeService');

function clearAutoplayTimer(session) {
  if (session.autoplayTimer) {
    clearTimeout(session.autoplayTimer);
    session.autoplayTimer = null;
  }
}

function scheduleAutoplayCheck(client, message, guildId, session) {
  clearAutoplayTimer(session);

  if (!client || !message) return;
  if (!session.autoplay) return;
  if (session.autoplayInProgress) return;
  if (!session.currentTrack) return;

  // Autoplay only prepares a new song when the queue is empty.
  // If the queue has songs, it waits until the last queued song becomes current.
  if (session.queue.length > 0) return;

  const duration = Number(session.currentTrack.duration);
  const startedAt = session.trackStartedAt;

  if (!duration || !startedAt) return;

  const lookaheadSeconds = session.autoplayLookaheadSeconds || 60;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const remainingSeconds = duration - elapsedSeconds;
  const delayMs = Math.max(0, (remainingSeconds - lookaheadSeconds) * 1000);

  session.autoplayTimer = setTimeout(async () => {
    session.autoplayTimer = null;

    if (!session.autoplay) return;
    if (session.autoplayInProgress) return;
    if (!session.currentTrack) return;

    // User may have queued something manually while the timer was waiting.
    if (session.queue.length > 0) return;

    try {
      if (session.lastChannel?.send) {
        await session.lastChannel.send(
          `🤖 Autoplay preparing next track based on **${session.currentTrack.title}**...`
        );
      }

      const next = await findNextAutoplayTrack(session);

      if (!next) {
        if (session.lastChannel?.send) {
          await session.lastChannel.send('❌ Autoplay could not find a reliable next track.');
        }
        return;
      }

      if (session.lastChannel?.send) {
        await session.lastChannel.send(
          `✅ Autoplay selected based on **${next.referenceTrack.title}**:\n` +
          `**${next.title}**\n` +
          `Source: ${next.source}\n` +
          `Score: ${next.score}\n` +
          `🔗 ${next.url}`
        );
      }

      message.content = `p ${next.url}`;
      client.emit('messageCreate', message);
    } catch (err) {
        console.error('[Autoplay Scheduler Error]', err);

        if (session.lastChannel?.send) {
            try {
            await session.lastChannel.send(`❌ Autoplay scheduler failed: ${err.message}`);
            } catch {}
        }
    }
  }, delayMs);
}

module.exports = {
  clearAutoplayTimer,
  scheduleAutoplayCheck
};