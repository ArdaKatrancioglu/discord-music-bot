const { formatTrackName } = require('../../utils/titleUtils');
const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    if (!session.looping || !session.loopQueue?.length) {
      return message.reply('Repeat is off.');
    }

    const list = session.loopQueue
      .slice(0, 15)
      .map((track, index) => `${index + 1}. ${formatTrackName(track)}`)
      .join('\n');
    const remaining = session.loopQueue.length - 15;
    return message.reply(
      (`**Repeat queue**\n${list}` + (remaining > 0 ? `\n+${remaining} more` : '')).slice(0, 1950)
    );
  }
};
