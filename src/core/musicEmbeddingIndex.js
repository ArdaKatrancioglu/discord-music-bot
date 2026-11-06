const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_THRESHOLD = 0.84;
const DEFAULT_BATCH_SIZE = 8;
const PREPROCESSING_VERSION = 3;

function normalizeVector(values) {
  const vector = Float32Array.from(values);
  let squaredLength = 0;
  for (const value of vector) squaredLength += value * value;
  const length = Math.sqrt(squaredLength);
  if (!length) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

function dotProduct(left, right) {
  if (left.length !== right.length) return -Infinity;
  let score = 0;
  for (let i = 0; i < left.length; i += 1) score += left[i] * right[i];
  return score;
}

function trackKey(track) {
  if (track.id) return `id:${track.id}`;
  if (track.filePath) return `path:${path.resolve(track.filePath)}`;
  return `title:${track.titleSan || track.title}`;
}

function embeddingTitle(track) {
  const title = String(
    track.title || track.videoTitle || track.displayTitle || track.titleSan || ''
  )
    .normalize('NFKC')
    .replace(/_/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const artist = String(track.artist || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  return artist && title ? `${title} ${artist}` : title;
}

function inputHash(input, model) {
  return crypto
    .createHash('sha256')
    .update(`${PREPROCESSING_VERSION}\0${model}\0${input}`)
    .digest('hex');
}

/**
 * Deliberately small search interface. An ANN implementation can replace this
 * class later without changing embedding persistence or the play flow.
 */
class BruteForceVectorIndex {
  constructor() {
    this.records = new Map();
    this.recordsByInputHash = new Map();
  }

  upsert(record) {
    const normalizedRecord = {
      ...record,
      embedding: normalizeVector(record.embedding)
    };
    this.records.set(record.key, normalizedRecord);
    this.recordsByInputHash.set(record.inputHash, normalizedRecord);
  }

  get(key) {
    return this.records.get(key);
  }

  getByInputHash(hash) {
    return this.recordsByInputHash.get(hash);
  }

  get size() {
    return this.records.size;
  }

  search(queryEmbedding, limit = 5) {
    const query = normalizeVector(queryEmbedding);
    const best = [];
    for (const record of this.records.values()) {
      const score = dotProduct(query, record.embedding);
      if (!Number.isFinite(score)) continue;
      best.push({ key: record.key, score });
    }
    best.sort((a, b) => b.score - a.score);
    return best.slice(0, limit);
  }
}

class MusicEmbeddingIndex {
  constructor({
    storePath,
    model = DEFAULT_MODEL,
    threshold = DEFAULT_THRESHOLD,
    batchSize = DEFAULT_BATCH_SIZE,
    createExtractor
  } = {}) {
    this.storePath =
      storePath ||
      path.join(
        path.dirname(path.resolve(process.env.MUSIC_INDEX_PATH || 'downloadedMusic/index.json')),
        'embeddings.jsonl'
      );
    this.model = model;
    this.isE5 = model.includes('multilingual-e5');
    this.threshold = threshold;
    this.batchSize = batchSize;
    this.createExtractor = createExtractor || this.#createDefaultExtractor.bind(this);
    this.vectorIndex = new BruteForceVectorIndex();
    this.initialization = null;
    this.extractorPromise = null;
    this.inferenceQueue = Promise.resolve();
    this.writeQueue = Promise.resolve();
    this.transientEmbeddingCache = new Map();
    this.transientEmbeddingCacheLimit = 512;
  }

  async #createDefaultExtractor() {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (process.env.EMBEDDING_CACHE_DIR)
      env.cacheDir = path.resolve(process.env.EMBEDDING_CACHE_DIR);
    console.log(`[Embeddings] Loading ${this.model} (q8)...`);
    return pipeline('feature-extraction', this.model, { dtype: 'q8' });
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#loadStore();
    await this.initialization;
  }

  async #loadStore() {
    if (!fs.existsSync(this.storePath)) {
      console.log('[Embeddings] Indexed entries: 0');
      return;
    }

    const lines = readline.createInterface({
      input: fs.createReadStream(this.storePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    let invalidLines = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (
          record.model === this.model &&
          record.preprocessingVersion === PREPROCESSING_VERSION &&
          record.key &&
          record.inputHash &&
          Array.isArray(record.embedding)
        ) {
          this.vectorIndex.upsert(record);
        }
      } catch {
        invalidLines += 1;
      }
    }
    if (invalidLines) {
      console.warn(`[Embeddings] Ignored ${invalidLines} incomplete/corrupt store line(s).`);
    }
    console.log(`[Embeddings] Indexed entries: ${this.vectorIndex.size}`);
  }

  #isCurrent(track) {
    const title = embeddingTitle(track);
    if (!title) return true;
    const record = this.vectorIndex.get(trackKey(track));
    return record?.inputHash === inputHash(this.#modelInput(title, 'passage'), this.model);
  }

  #modelInput(text, role) {
    return `${this.isE5 ? `${role}: ` : ''}${text}`;
  }

  async #embedTexts(texts, role = 'query') {
    if (!this.extractorPromise) this.extractorPromise = this.createExtractor();
    const run = async () => {
      const extractor = await this.extractorPromise;
      const modelInputs = texts.map((text) => this.#modelInput(text, role));
      const output = await extractor(modelInputs, { pooling: 'mean', normalize: true });
      const dimensions = output.dims.at(-1);
      if (!dimensions || output.data.length !== texts.length * dimensions) {
        throw new Error(`Unexpected embedding shape: ${output.dims.join('x')}`);
      }
      return texts.map((_, index) =>
        normalizeVector(output.data.slice(index * dimensions, (index + 1) * dimensions))
      );
    };

    const result = this.inferenceQueue.then(run, run);
    this.inferenceQueue = result.catch(() => {});
    return result;
  }

  #rememberTransient(hash, embedding) {
    if (this.transientEmbeddingCache.has(hash)) this.transientEmbeddingCache.delete(hash);
    this.transientEmbeddingCache.set(hash, embedding);
    while (this.transientEmbeddingCache.size > this.transientEmbeddingCacheLimit) {
      this.transientEmbeddingCache.delete(this.transientEmbeddingCache.keys().next().value);
    }
  }

  async embedTitles(titles) {
    await this.initialize();
    const cleanTitles = titles.map((title) =>
      String(title || '')
        .replace(/_/g, ' ')
        .trim()
    );
    const results = new Array(cleanTitles.length);
    const missingByHash = new Map();

    cleanTitles.forEach((title, index) => {
      if (!title) {
        results[index] = new Float32Array();
        return;
      }
      const hash = inputHash(this.#modelInput(title, 'query'), this.model);
      const stored = this.vectorIndex.getByInputHash(hash)?.embedding;
      const transient = this.transientEmbeddingCache.get(hash);
      if (stored || transient) {
        results[index] = stored || transient;
        return;
      }
      if (!missingByHash.has(hash)) missingByHash.set(hash, { title, indexes: [] });
      missingByHash.get(hash).indexes.push(index);
    });

    const missing = [...missingByHash.entries()];
    for (let offset = 0; offset < missing.length; offset += this.batchSize) {
      const batch = missing.slice(offset, offset + this.batchSize);
      const vectors = await this.#embedTexts(batch.map(([, item]) => item.title));
      batch.forEach(([hash, item], batchIndex) => {
        const vector = vectors[batchIndex];
        this.#rememberTransient(hash, vector);
        for (const resultIndex of item.indexes) results[resultIndex] = vector;
      });
    }

    return results;
  }

  async #persist(records) {
    if (!records.length) return;
    await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true });
    // A leading newline keeps a partially written final line from swallowing the
    // first recovered record after an interrupted process.
    const payload = `\n${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await fs.promises.appendFile(this.storePath, payload, 'utf8');
    for (const record of records) this.vectorIndex.upsert(record);
  }

  async #indexBatch(tracks) {
    const titles = tracks.map(embeddingTitle);
    const vectors = await this.#embedTexts(titles, 'passage');
    const records = tracks.map((track, index) => ({
      key: trackKey(track),
      inputText: titles[index],
      inputHash: inputHash(this.#modelInput(titles[index], 'passage'), this.model),
      preprocessingVersion: PREPROCESSING_VERSION,
      model: this.model,
      embedding: Array.from(vectors[index])
    }));
    await this.#persist(records);
  }

  async #backfill(tracks) {
    await this.initialize();
    const pendingCount = tracks.reduce(
      (count, track) => count + (embeddingTitle(track) && !this.#isCurrent(track) ? 1 : 0),
      0
    );
    console.log(
      `[Embeddings] Backfill starting: ${pendingCount} missing, ${this.vectorIndex.size} already indexed.`
    );
    if (!pendingCount) return { generated: 0, indexed: this.vectorIndex.size };

    let generated = 0;
    let batch = [];
    for (const track of tracks) {
      if (!embeddingTitle(track) || this.#isCurrent(track)) continue;
      batch.push(track);
      if (batch.length < this.batchSize) continue;
      await this.#indexBatch(batch);
      generated += batch.length;
      console.log(`[Embeddings] Backfill progress: ${generated}/${pendingCount}`);
      batch = [];
    }
    if (batch.length) {
      await this.#indexBatch(batch);
      generated += batch.length;
      console.log(`[Embeddings] Backfill progress: ${generated}/${pendingCount}`);
    }
    console.log(`[Embeddings] Backfill complete. Indexed entries: ${this.vectorIndex.size}`);
    return { generated, indexed: this.vectorIndex.size };
  }

  backfill(tracks) {
    const operation = () => this.#backfill(tracks);
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch((error) => {
      console.warn('[Embeddings] Backfill failed:', error.message);
    });
    return result;
  }

  scheduleTrack(track) {
    const operation = async () => {
      await this.initialize();
      if (!embeddingTitle(track) || this.#isCurrent(track)) return false;
      await this.#indexBatch([track]);
      console.log(`[Embeddings] Indexed new cache entry: ${trackKey(track)}`);
      return true;
    };
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch((error) => {
      console.warn('[Embeddings] Could not index cache entry:', error.message);
    });
    return result;
  }

  async search(query, tracks, { limit = 5, threshold = this.threshold } = {}) {
    await this.initialize();
    if (!query.trim() || !this.vectorIndex.size) return { match: null, candidates: [] };

    const startedAt = performance.now();
    const [queryEmbedding] = await this.#embedTexts([query]);
    const candidates = this.vectorIndex.search(queryEmbedding, this.vectorIndex.size);
    const tracksByKey = new Map(tracks.map((track) => [trackKey(track), track]));
    const hydrated = candidates
      .map((candidate) => ({ ...candidate, track: tracksByKey.get(candidate.key) }))
      .filter((candidate) => candidate.track && this.#isCurrent(candidate.track))
      .slice(0, limit);
    const best = hydrated[0] || null;
    const latency = performance.now() - startedAt;
    console.log(
      `[Semantic Search] ${latency.toFixed(1)}ms, indexed=${this.vectorIndex.size}, best=${best ? best.score.toFixed(4) : 'n/a'}`
    );
    return {
      match: best && best.score >= threshold ? best.track : null,
      bestScore: best?.score ?? null,
      candidates: hydrated
    };
  }
}

module.exports = {
  BruteForceVectorIndex,
  MusicEmbeddingIndex,
  dotProduct,
  embeddingTitle,
  normalizeVector,
  trackKey,
  PREPROCESSING_VERSION
};
