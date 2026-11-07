const { setBoundVoiceTarget } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    if (!message.guild) return message.reply('Join a server voice channel, then use `!bind`.');

    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('Join a voice channel first.');

    setBoundVoiceTarget(message.author.id, {
      guildId: vc.guild.id,
      channelId: vc.id
    });

    return message.reply(`Connected to **${vc.guild.name} › ${vc.name}**.`);
  }
};
