const { handleAutoplayCommand } = require('../../services/autoplayService');

module.exports = {
  async execute({ client, message }) {
    return handleAutoplayCommand(client, message);
  }
};