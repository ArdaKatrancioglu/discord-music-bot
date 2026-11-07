const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { libraryDataFile, resolveIndexPath } = require('./libraryPaths');
const {
  normalizeText,
  tokenize,
  trackKey,
  trackFields,
  fuzzyScorers,
  scoreTrack,
  selectConfidentMatch
} = require('./searchText');

const CANDIDATE_LIMIT = 100;

class MusicSearchIndex {
  constructor({
    storePath = libraryDataFile(resolveIndexPath(), 'search.sqlite'),
    exclusive = false
  } = {}) {
    this.storePath = storePath;
    if (storePath !== ':memory:') fs.mkdirSync(path.dirname(storePath), { recursive: true });
    this.db = new DatabaseSync(storePath);
    try {
      if (exclusive) this.db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, artist TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(title, artist, tokenize='unicode61', prefix='2 3 4');
      CREATE VIRTUAL TABLE IF NOT EXISTS trigrams USING fts5(title, artist, tokenize='trigram');`);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.documents = new Map(
      this.db
        .prepare('SELECT * FROM tracks')
        .all()
        .map((row) => [row.key, row])
    );
    this.documentFrequency = new Map();
    this.refreshFrequency();
  }

  get size() {
    return this.documents.size;
  }

  refreshFrequency() {
    this.documentFrequency.clear();
    for (const row of this.documents.values()) {
      for (const token of new Set(tokenize(`${row.title} ${row.artist}`))) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
      }
    }
  }

  replaceTrack(track) {
    const key = trackKey(track),
      fields = trackFields(track);
    const old = this.documents.get(key);
    if (old && old.title === fields.title && old.artist === fields.artist) return false;
    if (old) {
      this.db.prepare('DELETE FROM words WHERE rowid=?').run(old.id);
      this.db.prepare('DELETE FROM trigrams WHERE rowid=?').run(old.id);
      this.db
        .prepare('UPDATE tracks SET title=?, artist=? WHERE id=?')
        .run(fields.title, fields.artist, old.id);
    } else {
      this.db
        .prepare('INSERT INTO tracks(key,title,artist) VALUES(?,?,?)')
        .run(key, fields.title, fields.artist);
    }
    const row = this.db.prepare('SELECT * FROM tracks WHERE key=?').get(key);
    this.db
      .prepare('INSERT INTO words(rowid,title,artist) VALUES(?,?,?)')
      .run(row.id, fields.title, fields.artist);
    this.db
      .prepare('INSERT INTO trigrams(rowid,title,artist) VALUES(?,?,?)')
      .run(row.id, fields.title, fields.artist);
    this.documents.set(key, row);
    return true;
  }

  synchronize(tracks, { rebuild = false } = {}) {
    let generated = 0,
      removed = 0;
    this.db.exec('BEGIN');
    try {
      if (rebuild) {
        this.db.exec('DELETE FROM tracks; DELETE FROM words; DELETE FROM trigrams;');
        this.documents.clear();
      }
      const keys = new Set(tracks.map(trackKey));
      for (const [key, row] of this.documents) {
        if (keys.has(key)) continue;
        this.db.prepare('DELETE FROM words WHERE rowid=?').run(row.id);
        this.db.prepare('DELETE FROM trigrams WHERE rowid=?').run(row.id);
        this.db.prepare('DELETE FROM tracks WHERE id=?').run(row.id);
        this.documents.delete(key);
        removed++;
      }
      for (const track of tracks) if (this.replaceTrack(track)) generated++;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.documents = new Map(
        this.db
          .prepare('SELECT * FROM tracks')
          .all()
          .map((row) => [row.key, row])
      );
      this.refreshFrequency();
      throw error;
    }
    if (generated || removed || rebuild) this.refreshFrequency();
    return { generated, removed, indexed: this.size };
  }

  upsert(track) {
    this.db.exec('BEGIN');
    let changed;
    try {
      changed = this.replaceTrack(track);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.documents = new Map(
        this.db
          .prepare('SELECT * FROM tracks')
          .all()
          .map((row) => [row.key, row])
      );
      throw error;
    }
    if (changed) this.refreshFrequency();
    return { generated: Number(changed), indexed: this.size };
  }

  retrieve(queryTokens, ratio) {
    if (!queryTokens.length) return [];
    const expanded = new Set(queryTokens);
    // A transposition in a short word can share no trigrams at all (edis/edsi).
    // Expand those unknown query terms against the indexed vocabulary only.
    for (const token of queryTokens) {
      if (token.length < 3 || token.length > 4 || this.documentFrequency.has(token)) continue;
      const alternatives = [...this.documentFrequency.keys()]
        .map((word) => ({ word, similarity: ratio(token, word) / 100 }))
        .filter((item) => item.similarity >= 0.72)
        .sort((a, b) => b.similarity - a.similarity || a.word.localeCompare(b.word, 'en'))
        .slice(0, 3);
      for (const item of alternatives) expanded.add(item.word);
    }
    const words = [...expanded].map((token) => `"${token}"*`).join(' OR ');
    const grams = new Set();
    for (const token of queryTokens) {
      const chars = Array.from(token);
      for (let i = 0; i <= chars.length - 3 && grams.size < 128; i++)
        grams.add(chars.slice(i, i + 3).join(''));
    }
    const wordRows = this.db
      .prepare(
        'SELECT rowid, bm25(words) AS rank FROM words WHERE words MATCH ? ORDER BY rank, rowid LIMIT ?'
      )
      .all(words, CANDIDATE_LIMIT);
    const gramRows = grams.size
      ? this.db
        .prepare(
          'SELECT rowid, bm25(trigrams) AS rank FROM trigrams WHERE trigrams MATCH ? ORDER BY rank, rowid LIMIT ?'
        )
        .all([...grams].map((gram) => `"${gram}"`).join(' OR '), CANDIDATE_LIMIT)
      : [];
    // The FTS5 trigram tokenizer cannot index one- or two-character substrings.
    const shortTokens = queryTokens.filter((token) => Array.from(token).length < 3);
    const shortRows = shortTokens.length
      ? this.db
        .prepare(
          `SELECT id AS rowid FROM tracks WHERE ${shortTokens.map(() => '(title LIKE ? OR artist LIKE ?)').join(' OR ')} ORDER BY id LIMIT ?`
        )
        .all(...shortTokens.flatMap((token) => [`%${token}%`, `%${token}%`]), CANDIDATE_LIMIT)
      : [];
    const fused = new Map();
    for (const [rows, weight] of [
      [wordRows, 0.65],
      [gramRows, 0.35],
      [shortRows, 0.1]
    ])
      rows.forEach((row, rank) => {
        const item = fused.get(row.rowid) || { rowid: row.rowid, retrievalScore: 0 };
        item.retrievalScore += weight / (60 + rank + 1);
        fused.set(row.rowid, item);
      });
    return [...fused.values()]
      .sort((a, b) => b.retrievalScore - a.retrievalScore || a.rowid - b.rowid)
      .slice(0, CANDIDATE_LIMIT);
  }

  async search(query, tracks, { limit = 5, threshold = 0.8, minimumMargin = 0.045 } = {}) {
    const phrase = normalizeText(String(query || '').slice(0, 512));
    const queryTokens = [...new Set(tokenize(phrase))];
    if (!queryTokens.length || queryTokens.length > 32)
      return {
        match: null,
        bestScore: null,
        candidates: [],
        confident: false,
        reason: queryTokens.length ? 'query too long' : 'empty query',
        margin: 0
      };
    const { tokenRatio: ratio } = await fuzzyScorers();
    this.synchronize(tracks);
    const byKey = new Map(tracks.map((track) => [trackKey(track), track]));
    const byId = new Map([...this.documents.values()].map((row) => [row.id, row]));
    const candidates = this.retrieve(queryTokens, ratio)
      .map((hit) => {
        const row = byId.get(hit.rowid);
        return {
          key: row.key,
          track: byKey.get(row.key),
          retrievalScore: hit.retrievalScore,
          ...scoreTrack(queryTokens, row, this.documentFrequency, this.size, ratio, phrase)
        };
      })
      .filter((candidate) => candidate.track)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.retrievalScore - a.retrievalScore ||
          a.key.localeCompare(b.key, 'en')
      );
    const confidence = selectConfidentMatch(candidates, { threshold, minimumMargin });
    return {
      ...confidence,
      candidates: candidates.slice(0, Math.max(0, limit)),
      candidateCount: candidates.length
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { MusicSearchIndex, CANDIDATE_LIMIT, normalizeText };
