const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    if (!session.currentTrack) {
      return message.reply('⚠️ Nothing is currently playing.');
    }

    session.looping = !session.looping;

    return message.reply(
      session.looping
        ? `🔂 Loop enabled for **${session.currentTrack.title}**.`
        : '➡️ Loop disabled.'
    );
  }
};