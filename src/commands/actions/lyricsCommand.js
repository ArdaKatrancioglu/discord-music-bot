const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { disableLyrics, enableLyrics } = require('../../services/lyricsService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);
    const session = guildId ? sessions.get(guildId) : null;

    if (!session?.currentTrack) {
      return message.reply('Nothing is playing.');
    }

    if (session.lyricsEnabled) {
      disableLyrics(session);
      return message.reply('Lyrics off.');
    }

    enableLyrics(session, message.channel);
    return message.reply('Lyrics on.');
  }
};
