const { MusicSearchIndex } = require('../core/musicSearchIndex');
const { tokenize } = require('../core/searchText');

let index;
function getIndex() {
  index ||= new MusicSearchIndex();
  return index;
}

async function searchCachedMusic(query, tracks) {
  const result = await getIndex().search(query, tracks);
  return {
    track: result.match,
    source: result.match ? (result.candidates[0]?.exactPhrase ? 'keyword' : 'lexical') : null,
    score: result.bestScore
  };
}

async function initializeCachedSearch(tracks) {
  return getIndex().synchronize(tracks);
}

async function indexCachedTrack(track) {
  return getIndex().upsert(track);
}

function closeCachedSearch() {
  index?.close();
  index = null;
}

module.exports = {
  comparableWords: tokenize,
  searchCachedMusic,
  initializeCachedSearch,
  indexCachedTrack,
  closeCachedSearch
};
