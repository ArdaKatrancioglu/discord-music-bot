const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { pauseSession } = require('../../services/sessionControlService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    pauseSession(session);
    return message.reply('⏸ Paused playback.');
  }
};
