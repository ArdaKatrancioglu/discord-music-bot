const { sessions } = require('../../core/sessionManager');
const { stopPlaylistFeeder } = require('../../core/playlist_feeder');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { stopSession } = require('../../services/sessionControlService');
const { stopSpotifyPlaylistFeeder } = require('../../services/spotifyPlaylistService');

module.exports = {
  async execute({ message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    stopPlaylistFeeder(guildId);
    stopSpotifyPlaylistFeeder(guildId);

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    stopSession(session);

    return message.reply('⏹ Stopped playback, cleared queue and stopped playlist feeder.');
  }
};