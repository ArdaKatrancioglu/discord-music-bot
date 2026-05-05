const { handlePlayRequest } = require('../../services/playService');

module.exports = {
  async execute({ client, message, content }) {
    const query = content.slice(2).trim();
    return handlePlayRequest(client, message, query);
  }
};
