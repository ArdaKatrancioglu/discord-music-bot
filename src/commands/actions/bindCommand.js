const { setBoundVoiceTarget } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    if (!message.guild)
      return message.reply('Run this command while on a voice channel within a server stupid fuck.');

    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('Where you at? Nowhere. Join a voice channel first you dumb fuck');

    setBoundVoiceTarget(message.author.id, {
      guildId: vc.guild.id,
      channelId: vc.id
    });

    return message.reply(`🔗 DM commands are connected to channel **${vc.guild.name} › ${vc.name}**.`);
  }
};