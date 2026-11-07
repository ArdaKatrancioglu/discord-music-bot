// index.js
require('dotenv').config();
const sodium = require('libsodium-wrappers');
const { generateDependencyReport } = require('@discordjs/voice');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const { handleMessage } = require('./src/commands/commandHandler');
const {
  PLAYER_CUSTOM_ID_PREFIX,
  handlePlayerInteraction
} = require('./src/services/playerUiService');
const { destroyAllConnections, disconnectIfChannelEmpty } = require('./src/core/sessionManager');
const { listAllCachedTracksUnique } = require('./src/core/musicIndex');
const { initializeCachedSearch, closeCachedSearch } = require('./src/services/cacheSearchService');
const { latencyMonitor } = require('./src/services/latencyService');
const { exec } = require('child_process');

const TOKEN = process.env.TOKEN;
const useAria2c = process.env.USE_ARIA2C_FOR_VIDEO_FALLBACK;
const lastFmApiKey = process.env.LASTFM_API_KEY;
const useCookies = process.env.USE_COOKIES;

if (!TOKEN || !useAria2c || !lastFmApiKey || !useCookies) {
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
  latencyMonitor.stop();
  closeCachedSearch();
  stopBgutilContainer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received');
  latencyMonitor.stop();
  closeCachedSearch();
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

latencyMonitor.start(client);

client.once('ready', () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  console.log(generateDependencyReport());
});

client.on('messageCreate', (message) => {
  // Tüm logic commandHandler içinde
  handleMessage(client, message);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith(PLAYER_CUSTOM_ID_PREFIX)) return;
  const finishMeasurement = latencyMonitor.measureCommand(interaction, [
    'reply',
    'deferReply',
    'deferUpdate',
    'update'
  ]);
  try {
    await handlePlayerInteraction(interaction);
  } catch (error) {
    console.error('[Player UI] Interaction failed:', error);
  } finally {
    finishMeasurement();
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const guildId = guild?.id;
  if (!guildId) return;

  await disconnectIfChannelEmpty(guildId, guild);
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
  initializeCachedSearch(listAllCachedTracksUnique()).catch((error) => {
    console.warn('[Lexical Search] Startup indexing failed:', error.message);
  });
  client.login(TOKEN);
})();
