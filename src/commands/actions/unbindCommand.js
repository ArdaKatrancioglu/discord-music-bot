const { clearBoundVoiceTarget } = require('../../services/messageContextService');

module.exports = {
  async execute({ message }) {
    clearBoundVoiceTarget(message.author.id);
    return message.reply('Voice channel unlinked.');
  }
};
