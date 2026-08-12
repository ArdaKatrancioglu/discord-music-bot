const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { disableLyrics, enableLyrics } = require('../../services/lyricsService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);
    const session = guildId ? sessions.get(guildId) : null;

    if (!session?.currentTrack) {
      return message.reply('Şu anda çalan bir şarkı yok.');
    }

    if (session.lyricsEnabled) {
      disableLyrics(session);
      return message.reply('Lyrics kapatıldı.');
    }

    enableLyrics(session, message.channel);
    return message.reply('Lyrics açıldı.');
  }
};
