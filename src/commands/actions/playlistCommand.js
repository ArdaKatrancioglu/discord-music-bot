const { handlePlaylist } = require('../../services/playlistService');

module.exports = {
  async execute({ client, message, content }) {
    const url = content.slice('!playlist '.length).trim();
    return handlePlaylist(client, message, url);
  }
};