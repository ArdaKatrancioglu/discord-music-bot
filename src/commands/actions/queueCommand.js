const { formatTrackName } = require('../../utils/titleUtils');
const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Join a voice channel first.');
    }

    const session = sessions.get(guildId);
    if (!session || (!session.currentTrack && !session.queue.length)) {
      return message.reply('The queue is empty.');
    }

    const now = session.currentTrack ? `Now: **${formatTrackName(session.currentTrack)}**\n` : '';
    const list = session.queue
      .slice(0, 15)
      .map((t, i) => `${i + 1}. ${formatTrackName(t)}`)
      .join('\n');

    const remaining = session.queue.length - 15;
    return message.reply(
      `${now}${list ? `\n**Up next**\n${list}` : ''}${remaining > 0 ? `\n+${remaining} more` : ''}`.slice(
        0,
        1950
      )
    );
  }
};
