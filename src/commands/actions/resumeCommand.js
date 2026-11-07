const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { resumeSession } = require('../../services/sessionControlService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    resumeSession(session);
    return message.reply('Playing.');
  }
};
