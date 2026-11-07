const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { skipSession } = require('../../services/sessionControlService');
const { findNextAutoplayTrack } = require('../../services/autoplayRuntimeService');
const { handlePlayRequest } = require('../../services/playService');

module.exports = {
  async execute({ client, message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);

    if (!session) {
      return message.reply('Nothing is playing.');
    }

    if (!session.currentTrack) {
      if (session.autoplay && session.queue.length === 0 && session.lastAutoplayReferenceTrack) {
        await message.reply('Finding the next song…');

        const next = await findNextAutoplayTrack(session);

        if (next) {
          return handlePlayRequest(client, message, next.url);
        }

        return message.reply('No suitable next track found.');
      }

      return message.reply('Nothing to skip.');
    }

    const skipped = skipSession(session);

    await message.reply(`Skipped · ${skipped || 'Track'}`);

    if (session.autoplay && session.queue.length === 0) {
      await message.reply('Finding the next song…');

      const next = await findNextAutoplayTrack(session);

      if (next) {
        return handlePlayRequest(client, message, next.url);
      }

      return message.reply('No suitable next track found.');
    }
  }
};
