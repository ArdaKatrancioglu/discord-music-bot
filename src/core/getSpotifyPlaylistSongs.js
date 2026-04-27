// binaries.js

// TODO: Do this all thing without chromimum using proper API calls.

// SpotifyImporter
    // ├── tryOfficialApi()
    // ├── tryLightweightScrape()
    // └── tryChromiumFallback() 


//     !p <spotify playlist url>
//         |
//         v
// extractSpotifyPlaylistId(url)
//         |
//         v
// spotifyApi.getPlaylistTracks(id)
//         |
//         v
// tracks = [
//   { title: "Ambitionz Az A Ridah", artists: ["2Pac"] },
//   { title: "All Eyez On Me", artists: ["2Pac", "Big Syke"] }
// ]
//         |
//         v
// queueFeeder.addEvery15Seconds(tracks)


const { chromium } = require("playwright");

async function getSpotifyPlaylistSongs(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 30000 });

  const songs = new Map();

  let sameCount = 0;
  let lastSize = 0;

  while (sameCount < 2) {
    const visibleSongs = await page.evaluate(() => {
      return [...document.querySelectorAll('[data-testid="tracklist-row"]')]
        .map(row => {
          const index =
            row.getAttribute("aria-rowindex") ||
            row.querySelector('[aria-colindex="1"]')?.innerText?.trim();

          const title = row
            .querySelector('a[href*="/track/"] div')
            ?.innerText
            ?.trim();

          const artists = [...row.querySelectorAll('a[href*="/artist/"]')]
            .map(a => a.innerText.trim())
            .filter(Boolean)
            .join(", ");

          if (!title) return null;

          return {
            index: Number(index),
            text: `${title} - ${artists}`
          };
        })
        .filter(x => x && Number.isFinite(x.index));
    });

    for (const song of visibleSongs) {
      songs.set(song.index, song.text);
    }

    //console.log("Collected:", songs.size, "Last index:", Math.max(...songs.keys()));

    if (songs.size === lastSize) {
      sameCount++;
    } else {
      sameCount = 0;
      lastSize = songs.size;
    }

    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')];
      const lastRow = rows[rows.length - 1];

      if (lastRow) {
        lastRow.scrollIntoView({ block: "end" });
      }
    });

    await page.waitForTimeout(300);

    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(300);
  }

  await browser.close();

  return [...songs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text);
}

module.exports = { getSpotifyPlaylistSongs };