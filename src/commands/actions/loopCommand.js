const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { requestPlayerUpdate } = require('../../services/playerUiService');

module.exports = {
  async execute({ message, content }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('Nothing is playing.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('Nothing is playing.');

    if (!session.currentTrack) {
      return message.reply('Nothing is playing.');
    }

    let times = parseInt(content.slice(2).trim()) - 1; // Subtract 1 to account for the current track

    if (session.looping && isNaN(times)) {
      session.looping = false;
      session.loopCount = 0;
      session.loopQueue = [];
      session.loopIndex = 0;
      requestPlayerUpdate(session, { force: true }).catch(() => {});
      return message.reply('Repeat off.');
    }

    // Safety checks for loop count
    if (isNaN(times)) {
      times = 0; // Default to infinite loop if no valid number is provided
    }
    if (times < 0) {
      return message.reply('Use a positive number of tracks.');
    }
    if (times > 0 && times > session.queue.length) {
      times = session.queue.length;
    }
    session.looping = true;
    session.loopCount = times > 0 ? times : 0;
    session.loopQueue = [session.currentTrack, ...session.queue.slice(0, times)];
    session.loopIndex = 0;
    requestPlayerUpdate(session, { force: true }).catch(() => {});
    return message.reply(
      `Repeat on · ${session.loopQueue.length} track${session.loopQueue.length === 1 ? '' : 's'}`
    );
  }
};
