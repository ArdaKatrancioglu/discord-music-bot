const { listAllCachedTracksUnique } = require('../src/core/musicIndex');
const { startEmbeddingBackfill } = require('../src/services/cacheSearchService');

startEmbeddingBackfill(listAllCachedTracksUnique()).catch((error) => {
  console.error('[Embeddings] Backfill failed:', error);
  process.exitCode = 1;
});
