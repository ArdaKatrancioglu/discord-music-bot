const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { findNextAutoplayTrack } = require('../../services/autoplayRuntimeService');
const { handlePlayRequest } = require('../../services/playService');
const { scheduleAutoplayCheck } = require('../../services/autoplaySchedulerService');

module.exports = {
  async execute({ client, message, content }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);
    if (!session) return message.reply('⚠️ There are no sessions.');

    session.autoplayClient = client;
    session.autoplayMessage = message;
    session.lastChannel = message.channel;

    const arg = content.split(/\s+/)[1]?.toLowerCase();

    if (arg === 'now') {
      if (!session.currentTrack && !session.lastAutoplayReferenceTrack) {
        return message.reply('⚠️ No reference track found for autoplay.');
      }

      await message.reply('🔎 Autoplay searching now...');

      let next;

      try {
        next = await findNextAutoplayTrack(session);
      } catch (err) {
        console.error('[AutoplayCommand] ap now failed:', err);
        return message.reply(`❌ Autoplay failed: ${err.message}`);
      }

      await message.reply(
        `✅ Autoplay selected based on **${next.referenceTrack.title}**:\n` +
          `**${next.title}**\n` +
          `Source: ${next.source}\n` +
          `Score: ${next.score}\n` +
          `🔗 ${next.url}`
      );

      return handlePlayRequest(client, message, next.url);
    }

    session.autoplay = !session.autoplay;

    if (session.autoplay) {
      scheduleAutoplayCheck(client, message, guildId, session);

      return message.reply(
        '🤖 Autoplay enabled.\n' +
          'I will add a new track when the queue is empty or the last track is close to ending.'
      );
    }

    return message.reply('➡️ Autoplay disabled.');
  }
};
