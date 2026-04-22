const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { resumeSession } = require('../../services/sessionControlService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    resumeSession(session);
    return message.reply('▶️ Resumed playback.');
  }
};