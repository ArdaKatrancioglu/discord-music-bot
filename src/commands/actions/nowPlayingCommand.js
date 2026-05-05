const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('ℹ️ No track currently playing. Want some? Play it then dumbfuck.');
    }

    const session = sessions.get(guildId);

    return session?.currentTrack
      ? message.reply(
        `▶️ Now playing: **${session.currentTrack.title}**\n🔗 ${session.currentTrack.url || 'URL unknown'}`
      )
      : message.reply('ℹ️ No track currently playing.');
  }
};
