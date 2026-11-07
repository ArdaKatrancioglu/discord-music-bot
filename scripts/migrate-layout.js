const path = require('path');
const { migrateLayout } = require('../src/core/libraryLayout');

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (['--index', '--playback-root'].includes(argument) && argv[index + 1]) {
      options[argument === '--index' ? 'indexPath' : 'playbackRoot'] = path.resolve(argv[++index]);
    } else throw new Error(`Unknown or incomplete option: ${argument}`);
  }
  return options;
}

if (require.main === module) {
  try {
    console.log('[Data Layout]', migrateLayout(argumentsFor(process.argv.slice(2))));
  } catch (error) {
    console.error('[Data Layout]', error.message);
    process.exitCode = 1;
  }
}

module.exports = { argumentsFor };
