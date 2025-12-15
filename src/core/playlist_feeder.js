// playlist_feeder.js
const feeders = new Map(); 
// guildId -> { timer, list, index, channel }

function startPlaylistFeeder(guildId, channel, list, pushFn, interval = 30000) {
  stopPlaylistFeeder(guildId);

  const state = {
    list,
    index: 0,
    channel,
    timer: null
  };

  function tick() {
    if (state.index >= state.list.length) {
      channel.send("🎵 Playlist finished.");
      stopPlaylistFeeder(guildId);
      return;
    }

    const track = state.list[state.index];
    state.index++;

    pushFn(track, guildId, channel);
    
    state.timer = setTimeout(tick, interval);
  }

  // start immediately
  tick();

  feeders.set(guildId, state);
}

function stopPlaylistFeeder(guildId) {
  const f = feeders.get(guildId);
  if (!f) return;
  clearTimeout(f.timer);
  feeders.delete(guildId);
}

module.exports = { startPlaylistFeeder, stopPlaylistFeeder };
