const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');

module.exports = {
  async execute({ client, message, content }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    if (!session.currentTrack) {
      return message.reply('⚠️ Nothing is currently playing.');
    }

    let times = parseInt(content.slice(2).trim()) - 1; // Subtract 1 to account for the current track

    if (session.looping && isNaN(times)) {
      session.looping = false;
      session.loopCount = 0;
      session.loopQueue = [];
      session.loopIndex = 0;
      return message.reply('➡️ Loop disabled.');
    }

    // Safety checks for loop count
    if (isNaN(times)) {
      times = 0; // Default to infinite loop if no valid number is provided
    }
    if (times < 0) {
      return message.reply('⚠️ Invalid loop count. Please provide a non-negative integer.');
    }
    if (times > 0 && times > session.queue.length) {
      times = session.queue.length;
    }
    session.looping = true;
    session.loopCount = times > 0 ? times : 0;
    session.loopQueue = [session.currentTrack, ...session.queue.slice(0, times)];
    session.loopIndex = 0;
    await message.reply(`🔂 Loop enabled for ${session.loopQueue.length} tracks.`);
    const previewTracks = session.loopQueue.slice(0, 5);
    const remainingTracks = session.loopQueue.slice(5);
    for (let i = 0; i < previewTracks.length; i++) {
      const t = previewTracks[i];
      await message.reply(
        `${i === 0 ? '▶️' : '🔁'} ${i + 1}. **${t.title}**\n🔗 ${t.url || 'URL unknown'}`
      );
    }
    if (remainingTracks.length > 0) {
      const rest = remainingTracks
        .map((t, i) => `${i + 6}. ${t.title}`)
        .join('\n');
      await message.reply(
        `And ${remainingTracks.length} more track(s):\n${rest}`
      );
    }
  }
};