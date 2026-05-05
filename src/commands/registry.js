const bindCommand = require('./actions/bindCommand');
const unbindCommand = require('./actions/unbindCommand');
const useCommand = require('./actions/useCommand');
const queueCommand = require('./actions/queueCommand');
const nowPlayingCommand = require('./actions/nowPlayingCommand');
const skipCommand = require('./actions/skipCommand');
const stopCommand = require('./actions/stopCommand');
const pauseCommand = require('./actions/pauseCommand');
const resumeCommand = require('./actions/resumeCommand');
const cacheCommand = require('./actions/cacheCommand');
const playlistCommand = require('./actions/playlistCommand');
const playCommand = require('./actions/playCommand');
const loopCommand = require('./actions/loopCommand');
const loopQueueCommand = require('./actions/loopQueueCommand');
const autoplayCommand = require('./actions/autoplayCommand');

module.exports = [
  {
    matches: (content) => content === '!bind',
    handler: bindCommand
  },
  {
    matches: (content) => content === '!unbind',
    handler: unbindCommand
  },
  {
    matches: (content) => content.startsWith('!use '),
    handler: useCommand
  },
  {
    matches: (content) => content === '!queue',
    handler: queueCommand
  },
  {
    matches: (content) => content === '!np' || content === '!nowplaying',
    handler: nowPlayingCommand
  },
  {
    matches: (content) =>
      content === 's' ||
      content === 'sikip' ||
      content === 'skips' ||
      content === 'sikips',
    handler: skipCommand
  },
  {
    matches: (content) => content === 'ss',
    handler: stopCommand
  },
  {
    matches: (content) => content === 'pp',
    handler: pauseCommand
  },
  {
    matches: (content) => content === '!resume' || content === 'res',
    handler: resumeCommand
  },
  {
    matches: (content) =>
      content === '!cache' ||
      content.startsWith('!cache ') ||
      content === 'c',
    handler: cacheCommand
  },
  {
    matches: (content) => content.startsWith('!playlist '),
    handler: playlistCommand
  },
  {
    matches: (content) =>
      content === 'ap' ||
      content.startsWith('ap ') ||
      content === '!autoplay' ||
      content.startsWith('!autoplay '),
    handler: autoplayCommand
  },
  {
    matches: (content) => content.startsWith('p '),
    handler: playCommand
  },
  {
    matches: (content) => content.startsWith('lq'),
    handler: loopQueueCommand
  },
  {
    matches: (content) => content.startsWith('l'),
    handler: loopCommand
  },
];