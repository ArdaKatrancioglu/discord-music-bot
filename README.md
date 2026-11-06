# Discord Music Bot – Personal Edition

## Overview

This is a **personal-use Discord music bot** built using **Node.js**, **Discord.js**, and **yt-dlp**.  
It allows users to play, queue, pause, skip, and cache YouTube audio directly in a voice channel, with smart caching and offline playback support.

> This project is designed **only for personal and educational purposes**.  
> It is **not intended for public distribution or commercial use**.

## Features

- **Play music** directly from YouTube or by keyword search  
  (`!play <song name or YouTube URL>`)

- **Smart cache system**
  - Downloads and stores tracks as `.mp3` in the `downloadedMusic/` folder
  - Replays cached songs instantly without re-downloading
  - Filenames automatically include both the **video ID** and **song title**
  - Searches cached titles with multilingual semantic embeddings before falling back to YouTube

- **Measured YouTube recovery pipeline**
  - Metadata tries without cookies first, then retries with `cookies.txt`
  - Downloads start with preferred audio-only and progressively try broader modes
  - Every download mode is tried without cookies before its cookie fallback
  - Request, cache, metadata, download and real playback analytics persist across restarts

- **Infinite cache playback**
  - `!cache` starts endless random playback of your cached library
  - `!cache off` disables the loop

- **Playback control**
  - `!skip` → skip current track
  - `!pause` / `!resume` → control playback
  - `!stop` → clear queue and stop player

- **Synchronized lyrics**
  - `l` toggles LRCLIB lyrics for the current server session
  - Lyrics start at the current playback position and stay synchronized through pause/resume

- **Voice channel integration**
  - Automatically connects and stays synced with the voice channel
  - Supports DM binding (`!bind`, `!unbind`, `!use <guildId> <channelId>`)

- **Offline operation**  
  Once cached, tracks can be played back even without an internet connection.

- **Persistent metadata**
  - Tracks are named in the format:
    ```
    <videoID>_<sanitizedTitle>.mp3
    ```
  - The bot automatically reconstructs the YouTube URL at startup:  
    `https://www.youtube.com/watch?v=<videoID>`

## Setup Instructions

### 1. Requirements

Ensure you have the following installed:

- Node.js (v18 or later)
- ffmpeg
- yt-dlp
- A Discord bot token

### 2. Environment File

Create a `.env` file in your project root and add your bot token:

```
TOKEN=your_discord_bot_token_here
```

### 3. Install Dependencies

Install the required Node.js packages:

```bash
npm install discord.js libsodium-wrappers dotenv
```

_(Optional but recommended: install **aria2c** for faster downloads.)_

### 4\. Start the Bot Locally

Docker Desktop must be running. The `prestart` script starts the PO-token provider
container and publishes it at `127.0.0.1:4416`; the bot then starts on the host:

```bash
npm start
```

Do not set `BGUTIL_BASE_URL` for a normal local run. Its local default is
`http://127.0.0.1:4416`.

### 5\. Run Everything with Docker Compose

```bash
docker compose up --build -d
```

Inside Compose, `docker-compose.yml` explicitly sets
`BGUTIL_BASE_URL=http://bgutil-pot:4416`, using Docker's internal service name.
This is intentionally different from the local address.

### Benchmark YouTube metadata and download performance

Run this on the same server/container that runs the bot. It invokes the same
metadata and download pipeline as `!play`, records each audio format/recovery
mode separately, and writes a Markdown and JSON report below
`benchmark-results/`:

```bash
npm run benchmark:youtube -- 'artist - song title' --runs=3
```

For a text request, it uses `ytsearch1:` exactly like the first `!play`/`p`
request; a YouTube URL is passed through directly. By default it tests
metadata and all download modes once both without cookies and with
`cookies.txt`. The cookie scenario is clearly marked as skipped if that file
is absent; no cookie contents are ever written to the report. Downloads are
deleted after timing, and never enter the music cache. Use `--no-download` for
only metadata or `--keep` to retain the test media.

## Folder Structure

The project directory structure should be:

```
project/
├── downloadedMusic/                  # Auto-created: downloaded MP3s + persistent index
│   ├── index.json                    # Cached track metadata (id, title, filename, etc.)
│   ├── embeddings.jsonl              # Restart-safe normalized title embeddings
│   └── <id>_<sanitized>.mp3          # Downloaded audio files
│
├── src/
│   ├── commands/
│   │   └── commandHandler.js         # All Discord commands (!play, !stop, !skip, etc.)
│   │
│   ├── core/
│   │   ├── binaries.js               # Platform-aware ffmpeg / yt-dlp resolver
│   │   ├── musicIndex.js             # Persistent MP3 cache & index manager
│   │   ├── playlist_feeder.js        # Feeds playlist items into queue over time
│   │   ├── playlist_scraper.js       # Extracts playlist items (URL → track list)
│   │   ├── sessionManager.js         # Voice sessions, players, queues
│   │   └── youtubeMetadata.js        # Metadata fetcher (yt-dlp flat extraction)
│   │
│   ├── utils/
│       ├── playlistUtils.js          # Playlist detection & helper utilities
│       └── titleUtils.js             # Title sanitizing, parsing, filename helpers
│
├── index.js                          # Application entry point (bot bootstrap)
│
├── .env                              # Environment variables (DISCORD_TOKEN, etc.)
└── README.md

```

## Usage Commands

| Command                      | Description                                      |
| :--------------------------- | :----------------------------------------------- |
| `!play <query>`              | Play a song by title or URL                      |
| `!queue`                     | Show the current queue                           |
| `!skip`                      | Skip current song                                |
| `!pause` / `!resume`         | Pause or resume playback                         |
| `!stop`                      | Stop and clear the queue                         |
| `!bind` / `!unbind`          | Bind or unbind DM commands to a voice channel    |
| `!use <guildId> <channelId>` | Manually set DM binding                          |
| `!cache`                     | Start infinite random playback from cached songs |
| `!cache off`                 | Stop the infinite playback loop                  |
| `l`                          | Toggle synchronized lyrics                       |
| `!stats` / `stats`           | Show pipeline and playback analytics             |

## Technical Notes

### URL Persistence

- Each file’s name **encodes its YouTube ID**.
- On startup, the bot automatically **reconstructs the YouTube URL** for cached tracks.

### Audio Quality

- **`yt-dlp`** downloads the **`bestaudio`** format.
- **`ffmpeg`** converts the downloaded audio to **`.mp3`**.

### Performance

- Uses parallel downloaders (**`aria2c`** if available).
- Runtime analytics are stored in `downloadedMusic/analytics.json`, which persists through the
  Docker volume. It records success/failure counts, timings, error classifications, fallback
  usage, downloaded bytes, cache hits, and tracks started/completed/skipped/stopped.
- Utilizes **in-memory caching** for fast responses.
- Uses the quantized multilingual E5-small retrieval model, loaded once per process. Existing tracks are
  backfilled automatically at startup; `npm run backfill:embeddings` can run the migration manually.
- `CACHE_SEMANTIC_THRESHOLD` (default `0.84`) and `CACHE_EMBEDDING_BATCH_SIZE` (default `8`)
  can be adjusted through the environment.
- Semantic cache candidates without any shared title/query token use the stricter
  `CACHE_SEMANTIC_NO_OVERLAP_THRESHOLD` (default `0.90`) and must beat the second candidate by
  `CACHE_SEMANTIC_NO_OVERLAP_MIN_MARGIN` (default `0.05`).
- Autoplay never restores exact matches from its five-track recent history. It also rejects title
  similarity at or above `AUTOPLAY_SEMANTIC_REJECT_THRESHOLD` (default `0.93`) and gradually
  penalizes similarity starting at `AUTOPLAY_SEMANTIC_PENALTY_START` (default `0.83`).

## Legal Notice

This bot is created **solely for personal, non-commercial use**.

It is intended as a **technical learning project** to understand:

- How Discord bots operate
- How audio streaming and caching work
- How to integrate third-party tools like `yt-dlp` and `ffmpeg` in Node.js

All rights to any downloaded or streamed content belong to their respective copyright holders. Please respect the **YouTube Terms of Service** and **Discord Developer Policies** when using this bot.

**_Do not share, host publicly, or distribute copyrighted material without permission._**

## AI Acknowledgment

This bot and documentation were partially generated and refined using **GPT-5, Gemini 2.5 Flash**, which assisted in structuring, debugging, and optimizing the Node.js codebase. The implementation and purpose, however, remain entirely personal and educational.

## Author

**Arda Katrancıoğlu**

Computer Science & Engineering student at TU Delft

## License

### MIT License - Personal Use Only

Copyright (c) 2025 Arda Katrancıoğlu

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to use the Software for **personal, educational, or research purposes only**, subject to the following conditions:

- The Software shall not be used for any **commercial purposes**.
- The Software shall not be **redistributed, sublicensed, or hosted publicly**.
- All copyright notices and this permission notice shall be included in all copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## Music library v2

Playback and downloads continue to use the original YouTube recording and existing audio
paths. YouTube Music metadata is resolved through `youtubei.js`; no Python service or
additional music metadata provider is used. The existing Spotify playlist importer and
Last.fm recommendation feature are unchanged.

The index remains at `downloadedMusic/index.json` by default. Set `MUSIC_INDEX_PATH`
to use another index; lyrics and embedding storage are placed beside that index.
The document contains `{ "version": 2, "tracks": [...] }`, retaining other existing
application fields. A track has this shape (values are illustrative):

```json
{
  "id": "bpOSxM0rNPM",
  "title": "Do I Wanna Know?",
  "artist": "Arctic Monkeys",
  "artists": [{ "id": "artist-channel-id", "name": "Arctic Monkeys" }],
  "album": "AM",
  "year": 2013,
  "videoTitle": "Arctic Monkeys - Do I Wanna Know? (Official Video)",
  "titleSan": "Arctic_Monkeys_-_Do_I_Wanna_Know_(Official_Video)",
  "filePath": "/existing/path/to/audio.webm",
  "url": "https://www.youtube.com/watch?v=bpOSxM0rNPM",
  "duration": 266,
  "artworkUrl": null,
  "musicId": "pqrUQrAcfo4",
  "metadataSource": "youtube-music",
  "lyrics": "lyrics/bpOSxM0rNPM.ttml",
  "lyricsOffset": 0
}
```

Unknown scalar metadata uses `null`. `artists` and `metadataSource` are optional and
added on a successful resolution. Existing application fields such as `thumbnail`
and `lyricsOffset` are retained. For unrecognized recordings, `title` retains the
original fallback title and `artist`/`album` remain empty; it is not a verified song
identity. Legacy filename-only records cannot recover punctuation or an exact video
title that was never saved. Existing malformed legacy IDs are preserved rather than
silently changing their identities; the filename parser now correctly reads exactly
11 ID characters for new records.

### Migration

Stop the bot before running a migration: the bot and migration must not write the same
index concurrently. Install dependencies with `npm ci`, then run:

```sh
# Inspect the offline schema/lyrics conversion without changing files.
npm run migrate:library -- --dry-run --offline

# Convert storage and enrich up to 20 unresolved tracks per run.
npm run migrate:library -- --batch-size 20

# Repeat to continue; resolved tracks and valid TTML files are retained.
npm run migrate:library -- --batch-size 20

# Rebuild changed/missing vectors; unchanged inputs are reused.
npm run backfill:embeddings
```

Options: `--index /path/to/index.json`, `--dry-run`, `--offline`,
`--batch-size N`, `--offset N` (zero-based track position), and
`--overwrite-metadata` (explicitly replace existing artist/title corrections).
Dry runs can perform lookups unless `--offline` is supplied, but write no files.
Network failures leave entries usable and retryable. Confirmed negative matches are
cached for one day; successful metadata for 30 days in `youtube-music-cache.json`.
Metadata lookups are serialized with a minimum gap and at most one retry. Optional
song searches require a directly verified identity, the same title/version and artist
set, and a duration within eight seconds. Unrelated watch-playlist recommendations
are never used. A linked counterpart can supply the song identity without changing
which recording plays. Release years come from music/album metadata, not upload dates.

Before any index conversion, a sibling `index.json.backup-<timestamp>-<uuid>` file
preserves the source. TTML and JSON use temporary files, fsync, and atomic renames.
Each migrated track is checkpointed, so interrupted runs resume without reconverting
successful entries. Restore a backup only while the bot is stopped; keep the `lyrics`
directory with the corresponding index. Backups contain embedded lyrics when the
source had them. No audio file is renamed, removed, or downloaded by migration.
Normal startup also performs the backed-up offline conversion for legacy indexes;
run the CLI to add network metadata. Corrupt indexes fail visibly instead of being
overwritten with an empty library.

### Lyrics and search

`lyrics` is only a portable `lyrics/<permanent-id>.ttml` path or `null`; no persistent
found/not-found flag remains. Existing source timestamps and offsets survive migration.
TTML uses the W3C namespace, standard timing attributes, Unicode/XML escaping,
line ends from the next distinct timestamp or available recording duration, and
untimed paragraphs for plain lyrics. Real structured word times can be stored as
spans; line-only LRCLIB results never receive invented word times. The parser supports
this generated TTML subset, not arbitrary TTML styling or parent-relative timing.

Lyrics consumers parse local TTML to runtime arrays. Missing or corrupt files trigger
a new LRCLIB lookup with clean title, artist, album and playable duration. Plain lyrics
are shown without synchronized highlighting. Failed lookups are cached only briefly
in memory, allowing later retries. New candidates with a duration difference over eight
seconds, unrelated title/artist, or timestamps beyond the playable recording are
rejected. Duration agreement cannot detect equal-length edits or guarantee alignment;
no automatic timing shift is applied, and the existing offset controls remain available.

Embeddings use `Xenova/multilingual-e5-small`, mean pooling and unit normalization.
Recognized tracks use `<title> <artist>` (for example, `Do I Wanna Know? Arctic Monkeys`); unresolved videos use their fallback
title. Retrieval uses `passage:` for tracks and `query:` for queries, following the
[model's retrieval conventions](https://huggingface.co/intfloat/multilingual-e5-small).
The actual model input, model name, and preprocessing version determine `inputHash`.
Old `titleHash` records and stale vectors are ignored; changed tracks regenerate on
backfill/startup. Exact normalized title/artist matches take priority over semantic
scores. The append-only embedding file may retain ignored historical records.

`npm test` runs deterministic mocked API, storage, migration, embedding, and playback
regressions against temporary libraries, without modifying local downloaded music.

### Docker: prepare an existing server library

Keep the server's existing `downloadedMusic` directory, including its index, audio,
lyrics and caches. Deploy the updated source code and install the server's `.env` and
`cookies.txt` beside `docker-compose.yml`. These credentials are excluded from the image.
If you do not use cookies, create an empty `cookies.txt` before running Compose.

Run from that directory on the server:

```sh
docker compose stop discord-bot
docker compose build discord-bot

# Optional preview; no metadata network requests and no file changes.
docker compose run --rm --no-deps discord-bot npm run prepare:library -- --dry-run --offline --relocate-audio

# Process the full index (including a 550-entry library), then rebuild embeddings.
docker compose run --rm --no-deps discord-bot npm run prepare:library -- --relocate-audio

docker compose up -d
docker compose logs -f discord-bot
```

`prepare:library` performs migration, YouTube Music enrichment and embedding backfill
in that order. There is no default track limit. It uses the same backup, request
throttling and checkpoint behavior as `migrate:library`. Rerun the command after an
interruption; it reuses completed metadata and vectors. Recognized metadata corrections
are preserved unless `--overwrite-metadata` is explicitly supplied. Non-music videos
and unrecognized songs keep their fallback titles and remain in the library.

`--relocate-audio` is for changing machines or entering Docker: if an old absolute audio
path is missing, it looks for the same filename beside `index.json`, or a single audio
file with the same video ID. Only an existing file can replace the old path. No audio
is downloaded or renamed. The old path is retained in the index backup. If audio is
still missing, preparation reports a nonzero exit code after saving completed work.

To limit one run to 50 unresolved metadata lookups, add `--batch-size 50`. To start at
another position, add `--offset 50` (zero-based). A full preparation without these flags
is simplest for an established library. It can take several minutes depending on
YouTube responses; unsuccessful recognition does not imply the video is a song.

The model is downloaded on first use and retained in the `embedding-models` Docker
volume, controlled by `EMBEDDING_CACHE_DIR`. The index, TTML files and vectors remain in
the host's mounted `downloadedMusic` folder. Compose `up` starts the bot; run the
preparation command beforehand when enriching an existing server library.

Embedding preprocessing version 3 uses the text `Do I Wanna Know? Arctic Monkeys`.
The E5 model receives its internal `passage:` prefix for library vectors and `query:`
for searches. `embeddings.jsonl` now stores `inputText` so each track's source text is
inspectable. The version change invalidates older vectors once. Discord's player,
queue, loop previews and notifications display **Do I Wanna Know? – Arctic Monkeys** when
artist metadata exists; videos without artist metadata display their original title.
