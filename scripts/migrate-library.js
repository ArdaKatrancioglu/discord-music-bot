const path = require('path');
const { migrateLibrary } = require('../src/core/libraryMigration');
const { YouTubeMusicResolver } = require('../src/core/youtubeMusicMetadata');
const { libraryDataFile, resolveIndexPath } = require('../src/core/libraryPaths');

function argumentsFor(argv) {
  const options = { dryRun: false, offline: false, overwrite: false };
  const names = { '--index': 'indexPath', '--batch-size': 'batchSize', '--offset': 'offset' };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--offline') options.offline = true;
    else if (argument === '--overwrite-metadata') options.overwrite = true;
    else if (argument === '--relocate-audio') options.relocateAudio = true;
    else if (names[argument] && argv[i + 1]) options[names[argument]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${argument}`);
  }
  for (const name of ['batchSize', 'offset']) {
    if (options[name] === undefined) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < (name === 'batchSize' ? 1 : 0))
      throw new Error(`Invalid ${name}`);
  }
  options.indexPath = path.resolve(options.indexPath || resolveIndexPath());
  return options;
}

async function runMigration(options) {
  if (!options.offline)
    options.resolver = new YouTubeMusicResolver({
      // Dry runs must not create even a metadata cache on disk.
      cachePath: options.dryRun
        ? undefined
        : libraryDataFile(options.indexPath, 'youtube-music-cache.json')
    });
  let lastLog = 0;
  const result = await migrateLibrary({
    ...options,
    onProgress: ({ position, tracks, enriched, attempted }) => {
      if (Date.now() - lastLog > 10000) {
        console.log(`[Migration] ${position}/${tracks}, metadata: ${enriched}/${attempted}`);
        lastLog = Date.now();
      }
    }
  });
  const { index, ...report } = result;
  console.log(`[Migration] Library version: ${index.version}`);
  console.log(JSON.stringify({ dryRun: options.dryRun, ...report }, null, 2));
  console.log(
    'Run npm run rebuild:search to refresh the lexical index, or use prepare:library to do both.'
  );
  return result;
}

if (require.main === module)
  runMigration(argumentsFor(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { argumentsFor, runMigration };
