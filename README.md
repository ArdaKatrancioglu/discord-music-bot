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

- **Infinite cache playback**  
  - `!cache` starts endless random playback of your cached library  
  - `!cache off` disables the loop

- **Playback control**  
  - `!skip` → skip current track  
  - `!pause` / `!resume` → control playback  
  - `!stop` → clear queue and stop player

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

*(Optional but recommended: install **aria2c** for faster downloads.)*

### 4\. Start the Bot

Run the main bot file:

```bash
node index.js
```


## Folder Structure

The project directory structure should be:

```
project/
├── downloadedMusic/                  # Auto-created: downloaded MP3s + persistent index
│   ├── index.json                    # Cached track metadata (id, title, filename, etc.)
│   └── <id>_<sanitized>.mp3          # Downloaded audio files
│
├── node_modules/                     # Node dependencies
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

| Command | Description |
| :--- | :--- |
| `!play <query>` | Play a song by title or URL |
| `!queue` | Show the current queue |
| `!skip` | Skip current song |
| `!pause` / `!resume` | Pause or resume playback |
| `!stop` | Stop and clear the queue |
| `!bind` / `!unbind` | Bind or unbind DM commands to a voice channel |
| `!use <guildId> <channelId>` | Manually set DM binding |
| `!cache` | Start infinite random playback from cached songs |
| `!cache off` | Stop the infinite playback loop |


## Technical Notes

### URL Persistence

  * Each file’s name **encodes its YouTube ID**.
  * On startup, the bot automatically **reconstructs the YouTube URL** for cached tracks.

### Audio Quality

  * **`yt-dlp`** downloads the **`bestaudio`** format.
  * **`ffmpeg`** converts the downloaded audio to **`.mp3`**.

### Performance

  * Uses parallel downloaders (**`aria2c`** if available).
  * Utilizes **in-memory caching** for fast responses.

## Legal Notice

This bot is created **solely for personal, non-commercial use**.

It is intended as a **technical learning project** to understand:

  * How Discord bots operate
  * How audio streaming and caching work
  * How to integrate third-party tools like `yt-dlp` and `ffmpeg` in Node.js

All rights to any downloaded or streamed content belong to their respective copyright holders. Please respect the **YouTube Terms of Service** and **Discord Developer Policies** when using this bot.

***Do not share, host publicly, or distribute copyrighted material without permission.***

## AI Acknowledgment

This bot and documentation were partially generated and refined using **GPT-5, Gemini 2.5 Flash**, which assisted in structuring, debugging, and optimizing the Node.js codebase. The implementation and purpose, however, remain entirely personal and educational.

## Author

**Arda Katrancıoğlu**

Computer Science & Engineering student at TU Delft


## License

### MIT License - Personal Use Only

Copyright (c) 2025 Arda Katrancıoğlu

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to use the Software for **personal, educational, or research purposes only**, subject to the following conditions:

  * The Software shall not be used for any **commercial purposes**.
  * The Software shall not be **redistributed, sublicensed, or hosted publicly**.
  * All copyright notices and this permission notice shall be included in all copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
