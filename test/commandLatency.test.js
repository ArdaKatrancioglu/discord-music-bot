const test = require('node:test');
const assert = require('node:assert/strict');
const registryPath = require.resolve('../src/commands/registry');
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: [
    {
      matches: (content) => content === '!test',
      handler: {
        async execute({ message }) {
          await message.reply('response');
        }
      }
    },
    {
      matches: (content) => content === '!fail',
      handler: {
        async execute() {
          throw new Error('test failure');
        }
      }
    }
  ]
};
const { handleMessage } = require('../src/commands/commandHandler');
const { latencyMonitor } = require('../src/services/latencyService');

test('only routed commands are timed, including the error reply, and reply methods are restored', async () => {
  const message = { author: { bot: false }, content: 'unrelated', async reply() {} };
  const original = message.reply;
  await handleMessage({}, message);
  assert.equal(latencyMonitor.snapshot().metrics.commandProcessing.count, 0);
  message.content = '!test';
  await handleMessage({}, message);
  assert.equal(message.reply, original);
  assert.equal(latencyMonitor.snapshot().metrics.commandResponse.count, 1);
  message.content = '!fail';
  await handleMessage({}, message);
  assert.equal(message.reply, original);
  assert.equal(latencyMonitor.snapshot().metrics.commandResponse.count, 2);
  assert.equal(latencyMonitor.snapshot().metrics.commandProcessing.count, 2);
});
