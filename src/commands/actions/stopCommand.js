const { sessions } = require('../../core/sessionManager');
const { stopPlaylistFeeder } = require('../../core/playlist_feeder');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { stopSession } = require('../../services/sessionControlService');
const { stopSpotifyPlaylistFeeder } = require('../../services/spotifyPlaylistService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    stopPlaylistFeeder(guildId);
    stopSpotifyPlaylistFeeder(guildId);

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    stopSession(session);

    return message.reply('Stopped. Queue cleared.');
  }
};
