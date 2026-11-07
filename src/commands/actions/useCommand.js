const { setBoundVoiceTarget } = require('../../services/messageContextService');

module.exports = {
  async execute({ client, message, content }) {
    const parts = content.split(/\s+/);
    if (parts.length !== 3) {
      return message.reply('Use `!use <guildId> <channelId>`.');
    }

    const [, gId, cId] = parts;
    const guild = client.guilds.cache.get(gId);
    if (!guild) return message.reply('This server isn’t available.');

    const ch = guild.channels.cache.get(cId);
    if (!ch || ch.type !== 2) return message.reply('Enter a valid voice channel ID.');

    setBoundVoiceTarget(message.author.id, {
      guildId: gId,
      channelId: cId
    });

    return message.reply(`Connected to **${guild.name} › ${ch.name}**.`);
  }
};
