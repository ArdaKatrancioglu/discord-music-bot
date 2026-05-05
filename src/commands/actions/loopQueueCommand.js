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

    if (!session.looping || !session.loopQueue?.length) {
      return message.reply('ℹ️ Loop queue is empty.');
    }

    await message.reply(`🔂 Loop queue has ${session.loopQueue.length} track(s).`);

    const previewTracks = session.loopQueue.slice(0, 5);
    const remainingTracks = session.loopQueue.slice(5);

    for (let i = 0; i < previewTracks.length; i++) {
      const t = previewTracks[i];

      const isCurrentTrack =
        session.currentTrack &&
        t.id === session.currentTrack.id &&
        t.title === session.currentTrack.title;

      await message.reply(
        `${isCurrentTrack ? '▶️' : '🔁'} ${i + 1}. **${t.title}**\n🔗 ${t.url || 'URL unknown'}`
      );
    }

    if (remainingTracks.length > 0) {
      const rest = remainingTracks.map((t, i) => `${i + 6}. ${t.title}`).join('\n');

      await message.reply(`And ${remainingTracks.length} more track(s):\n${rest}`);
    }
  }
};
