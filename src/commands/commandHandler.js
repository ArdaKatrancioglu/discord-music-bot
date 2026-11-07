const routes = require('./registry');

const { latencyMonitor } = require('../services/latencyService');

async function handleMessage(client, message) {
  const startedAt = latencyMonitor.now();
  let finishMeasurement;
  try {
    if (message.author.bot) return;
    const content = message.content.trim();

    const route = routes.find((r) => r.matches(content));
    if (!route) return;

    finishMeasurement = latencyMonitor.measureCommand(message, ['reply'], startedAt);
    await route.handler.execute({ client, message, content });
  } catch (err) {
    console.error('[messageCreate] Handler error:', err);
    try {
      await message.reply('Something went wrong. Please try again.');
    } catch {
      // An unavailable text channel must not break command cleanup.
    }
  } finally {
    finishMeasurement?.();
  }
}

module.exports = {
  handleMessage
};
