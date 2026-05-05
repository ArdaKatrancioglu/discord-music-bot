const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('ℹ️ No queue (no connected voice channel found complete retard).');
    }

    const session = sessions.get(guildId);
    if (!session || (!session.currentTrack && !session.queue.length)) {
      return message.reply('ℹ️ Queue is empty.');
    }

    const now = session.currentTrack ? `Now: **${session.currentTrack.title}**\n` : '';
    const list = session.queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');

    return message.reply(`🎶 ${now}Queue:\n${list || '(empty)'}`);
  }
};
