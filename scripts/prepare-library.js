const path = require('path');
const { argumentsFor, runMigration } = require('./migrate-library');
const { MusicEmbeddingIndex } = require('../src/core/musicEmbeddingIndex');

async function prepareLibrary(options) {
  const result = await runMigration(options);
  if (options.dryRun) {
    console.log('[Prepare] Dry run: embedding generation skipped; no files changed.');
    return result;
  }
  const embeddingIndex = new MusicEmbeddingIndex({
    storePath: path.join(path.dirname(options.indexPath), 'embeddings.jsonl')
  });
  const embeddings = await embeddingIndex.backfill(result.index.tracks);
  const recognized = result.index.tracks.filter((track) => track.artist).length;
  console.log(
    `[Prepare] ${recognized}/${result.tracks} recognized music tracks; other videos retain their fallback titles.`
  );
  console.log(
    `[Prepare] Embeddings: ${embeddings.generated} generated, ${embeddings.indexed} indexed.`
  );
  if (result.missingAudio) {
    throw new Error(
      `${result.missingAudio} audio file(s) are unavailable. Mount the complete downloadedMusic directory and retry with --relocate-audio.`
    );
  }
  console.log('[Prepare] Library ready. Start the bot with docker compose up -d.');
  return { ...result, embeddings };
}

if (require.main === module) {
  prepareLibrary(argumentsFor(process.argv.slice(2))).catch((error) => {
    console.error('[Prepare]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { prepareLibrary };
