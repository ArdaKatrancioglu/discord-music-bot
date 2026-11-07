const { argumentsFor, runMigration } = require('./migrate-library');
const { MusicSearchIndex } = require('../src/core/musicSearchIndex');
const { libraryDataFile } = require('../src/core/libraryPaths');

async function prepareLibrary(options) {
  const result = await runMigration(options);
  if (options.dryRun) {
    console.log('[Prepare] Dry run: search indexing skipped; no files changed.');
    return result;
  }
  const searchIndex = new MusicSearchIndex({
    storePath: libraryDataFile(options.indexPath, 'search.sqlite')
  });
  let search;
  try {
    search = searchIndex.synchronize(result.index.tracks);
  } finally {
    searchIndex.close();
  }
  const recognized = result.index.tracks.filter((track) => track.artist).length;
  console.log(
    `[Prepare] ${recognized}/${result.tracks} recognized music tracks; other videos retain their fallback titles.`
  );
  console.log(`[Prepare] Search: ${search.generated} updated, ${search.indexed} indexed.`);
  if (result.missingAudio) {
    throw new Error(
      `${result.missingAudio} audio file(s) are unavailable. Mount the complete data directory and retry with --relocate-audio.`
    );
  }
  console.log('[Prepare] Library ready. Start the bot with docker compose up -d.');
  return { ...result, search };
}

if (require.main === module) {
  prepareLibrary(argumentsFor(process.argv.slice(2))).catch((error) => {
    console.error('[Prepare]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { prepareLibrary };
