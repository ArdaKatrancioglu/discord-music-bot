const { userDefaultVC } = require('../core/sessionManager');

function getBoundVoiceTarget(userId) {
  return userDefaultVC.get(userId) || null;
}

function setBoundVoiceTarget(userId, target) {
  userDefaultVC.set(userId, target);
}

function clearBoundVoiceTarget(userId) {
  userDefaultVC.delete(userId);
}

function resolveGuildIdForBoundAwareCommand(message) {
  let guildId = message.guild?.id;

  if (!guildId) {
    const pref = getBoundVoiceTarget(message.author.id);
    if (!pref) return null;
    guildId = pref.guildId;
  }

  return guildId;
}

module.exports = {
  getBoundVoiceTarget,
  setBoundVoiceTarget,
  clearBoundVoiceTarget,
  resolveGuildIdForBoundAwareCommand
};