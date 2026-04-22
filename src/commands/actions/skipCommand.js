const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { skipSession } = require('../../services/sessionControlService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session || !session.currentTrack) return message.reply('⚠️ Nothing to skip.');

    const skipped = skipSession(session);
    return message.reply(`⏭ Skipped **${skipped || ''}**`);
  }
};