const { sessions } = require('../../core/sessionManager');
const { resolveGuildIdForBoundAwareCommand } = require('../../services/messageContextService');
const { skipSession } = require('../../services/sessionControlService');
const { findNextAutoplayTrack } = require('../../services/autoplayRuntimeService');
const { handlePlayRequest } = require('../../services/playService');

module.exports = {
  async execute({ client, message }) {
    const guildId = resolveGuildIdForBoundAwareCommand(message);

    if (!guildId) {
      return message.reply('⚠️ There are no sessions.');
    }

    const session = sessions.get(guildId);

    if (!session) {
      return message.reply('⚠️ There are no sessions.');
    }

    if (!session.currentTrack) {
      if (session.autoplay && session.queue.length === 0 && session.lastAutoplayReferenceTrack) {
        await message.reply('🤖 Nothing is playing, but autoplay is enabled. Searching from last reference...');

        const next = await findNextAutoplayTrack(session);

        if (next) {
          await message.reply(
            `✅ Autoplay selected based on **${next.referenceTrack.title}**:\n` +
            `**${next.title}**\n` +
            `🔗 ${next.url}`
          );

          return handlePlayRequest(client, message, next.url);
        }

        return message.reply('❌ Autoplay could not find a reliable next track.');
      }

      return message.reply('⚠️ Nothing to skip.');
    }

    const skipped = skipSession(session);

    await message.reply(`⏭ Skipped **${skipped || ''}**`);

    if (session.autoplay && session.queue.length === 0) {
      await message.reply('🤖 Queue is empty after skip. Autoplay searching...');

      const next = await findNextAutoplayTrack(session);

      if (next) {
        await message.reply(
          `✅ Autoplay selected based on **${next.referenceTrack.title}**:\n` +
          `**${next.title}**\n` +
          `🔗 ${next.url}`
        );

        return handlePlayRequest(client, message, next.url);
      }

      return message.reply('❌ Autoplay could not find a reliable next track.');
    }
  }
};