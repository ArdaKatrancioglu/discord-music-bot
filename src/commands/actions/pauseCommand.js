const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { pauseSession } = require('../../services/sessionControlService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    pauseSession(session);
    return message.reply('Paused.');
  }
};
