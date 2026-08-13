const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { startPlayerUi } = require('../../services/playerUiService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('ℹ️ No track currently playing. Want some? Play it then dumbfuck.');
    }

    const session = sessions.get(guildId);

    if (!session?.currentTrack) return message.reply('ℹ️ No track currently playing.');
    return startPlayerUi(session, message.channel);
  }
};
