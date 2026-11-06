// Every test process owns a disposable library; tests must never migrate the user's data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-test-'));
process.env.MUSIC_INDEX_PATH = path.join(directory, 'index.json');
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
