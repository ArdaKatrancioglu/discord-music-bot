const routes = require('./registry');

const BLACKLIST = new Set([
  '612376795462762510',
]);

async function handleMessage(client, message) {
  try {
    if (message.author.bot) return;
    const content = message.content.trim();

    // if (BLACKLIST.has(message.author.id)) {
    //   return message.reply('yarrami ye tms');
    // }

    const route = routes.find(r => r.matches(content));
    if (!route) return;

    await route.handler.execute({ client, message, content });
  } catch (err) {
    console.error('[messageCreate] Handler error:', err);
    try { await message.reply('⚠️ An unexpected error occurred. What have you done?'); } catch {}
  }
}

module.exports = {
  handleMessage
};