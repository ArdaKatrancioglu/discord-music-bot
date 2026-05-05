// index.js
require('dotenv').config();
const sodium = require('libsodium-wrappers');
const { generateDependencyReport } = require('@discordjs/voice');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const { handleMessage } = require('./src/commands/commandHandler');
const { destroyAllConnections } = require('./src/core/sessionManager');
const { exec } = require('child_process');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('TOKEN is missing. Add TOKEN=... to .env file.');
  process.exit(1);
}

function stopBgutilContainer() {
  console.log('[bgutil] Stopping container...');
  exec('docker stop bgutil-pot', (err) => {
    if (err) {
      console.log('[bgutil] Failed to stop container (maybe not running)');
    } else {
      console.log('[bgutil] Container stopped.');
    }
  });
}

process.on('SIGINT', () => {
  console.log('\n[Shutdown] Caught SIGINT (Ctrl+C)');
  stopBgutilContainer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received');
  stopBgutilContainer();
  process.exit(0);
});

// Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  console.log(generateDependencyReport());
});

client.on('messageCreate', (message) => {
  // Tüm logic commandHandler içinde
  handleMessage(client, message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  destroyAllConnections();
  process.exit(0);
});
process.on('SIGTERM', () => {
  destroyAllConnections();
  process.exit(0);
});

// Başlat
(async () => {
  await sodium.ready; // AEAD/XChaCha20 hazır olsun
  client.login(TOKEN);
})();
