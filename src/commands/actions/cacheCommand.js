const { handleCacheCommand } = require('../../services/cacheService');

module.exports = {
  async execute({ client, message, content }) {
    return handleCacheCommand(client, message, content);
  }
};
