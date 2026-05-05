// scripts/start-bgutil.js
const { execSync } = require('child_process');

const CONTAINER_NAME = 'bgutil-pot';
const IMAGE_NAME = 'brainicism/bgutil-ytdlp-pot-provider';
const PORT = '4416';

function run(command, options = {}) {
  return execSync(command, {
    stdio: options.silent ? 'pipe' : 'inherit',
    encoding: 'utf8'
  });
}

function dockerAvailable() {
  try {
    run('docker info', { silent: true });
    return true;
  } catch {
    return false;
  }
}

function containerExists() {
  try {
    const output = run(`docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format "{{.Names}}"`, {
      silent: true
    });

    return output.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

function containerRunning() {
  try {
    const output = run(`docker ps --filter "name=^/${CONTAINER_NAME}$" --format "{{.Names}}"`, {
      silent: true
    });

    return output.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

function startExistingContainer() {
  console.log(`[bgutil] Starting existing container: ${CONTAINER_NAME}`);
  run(`docker start ${CONTAINER_NAME}`);
}

function createAndStartContainer() {
  console.log(`[bgutil] Creating container: ${CONTAINER_NAME}`);

  run(
    [
      'docker run -d',
      `--name ${CONTAINER_NAME}`,
      '--restart unless-stopped',
      `-p ${PORT}:${PORT}`,
      IMAGE_NAME
    ].join(' ')
  );
}

function main() {
  if (!dockerAvailable()) {
    console.error(
      '[bgutil] Docker is not running or not available. Start Docker Desktop first, then run npm start again.'
    );
    process.exit(1);
  }

  if (containerRunning()) {
    console.log(`[bgutil] Container already running: ${CONTAINER_NAME}`);
    return;
  }

  if (containerExists()) {
    startExistingContainer();
    return;
  }

  createAndStartContainer();
}

main();