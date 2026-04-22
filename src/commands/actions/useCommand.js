const { setBoundVoiceTarget } = require('../../services/messageContextService');

module.exports = {
  async execute({ client, message, content }) {
    const parts = content.split(/\s+/);
    if (parts.length !== 3) {
      return message.reply('Error! Unknown format.\nExpected format: !use <guildId> <channelId>');
    }

    const [, gId, cId] = parts;
    const guild = client.guilds.cache.get(gId);
    if (!guild) return message.reply('The bot is not on that server or is not cached.');

    const ch = guild.channels.cache.get(cId);
    if (!ch || ch.type !== 2) return message.reply('Provide a valid voice channel ID dumbass.');

    setBoundVoiceTarget(message.author.id, {
      guildId: gId,
      channelId: cId
    });

    return message.reply(`🔗 DM commands are linked to channel **${guild.name} › ${ch.name}**.`);
  }
};