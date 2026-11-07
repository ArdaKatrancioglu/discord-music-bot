const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { startPlayerUi } = require('../../services/playerUiService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);

    if (!session?.currentTrack) return message.reply('Nothing is playing.');
    return startPlayerUi(session, message.channel);
  }
};
