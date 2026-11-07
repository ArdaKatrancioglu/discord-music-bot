const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { findNextAutoplayTrack } = require('../../services/autoplayRuntimeService');
const { handlePlayRequest } = require('../../services/playService');
const {
  clearAutoplayTimer,
  scheduleAutoplayCheck
} = require('../../services/autoplaySchedulerService');
const { requestPlayerUpdate } = require('../../services/playerUiService');

module.exports = {
  async execute({ client, message, content }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    session.autoplayClient = client;
    session.autoplayMessage = message;
    session.lastChannel = message.channel;

    const arg = content.split(/\s+/)[1]?.toLowerCase();

    if (arg === 'now') {
      if (!session.currentTrack && !session.lastAutoplayReferenceTrack) {
        return message.reply('Play a song before starting autoplay.');
      }

      await message.reply('Finding the next song…');

      let next;

      try {
        next = await findNextAutoplayTrack(session);
      } catch (err) {
        console.error('[AutoplayCommand] ap now failed:', err);
        return message.reply('Couldn’t start autoplay. Please try again.');
      }

      if (!next) return message.reply('No suitable next track found.');
      return handlePlayRequest(client, message, next.url);
    }

    session.autoplay = !session.autoplay;

    if (session.autoplay) {
      scheduleAutoplayCheck(client, message, guildId, session);
      requestPlayerUpdate(session, { force: true }).catch(() => {});

      return message.reply('Autoplay on.');
    }

    clearAutoplayTimer(session);
    requestPlayerUpdate(session, { force: true }).catch(() => {});
    return message.reply('Autoplay off.');
  }
};
