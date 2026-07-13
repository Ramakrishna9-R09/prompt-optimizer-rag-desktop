'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR } = require('./config');

const MEMORY_FILE = path.join(CONFIG_DIR, 'memory-index.json');
const MAX_DOCUMENTS = 500;
const MAX_CHUNKS = 2200;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 160;
const RRF_K = 60;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'but', 'can', 'could',
  'did', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'how', 'into', 'its', 'just',
  'like', 'make', 'more', 'not', 'now', 'only', 'our', 'out', 'please', 'should', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'use', 'was', 'were', 'what',
  'when', 'where', 'which', 'with', 'work', 'would', 'you', 'your'
]);

function ensureStoreDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function emptyStore() {
  return {
    version: 3,
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    documents: [],
    chunks: []
  };
}

function loadMemoryStore() {
  ensureStoreDir();
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      return {
        ...emptyStore(),
        ...parsed,
        version: 3,
        revision: Number(parsed.revision || 0),
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
        chunks: Array.isArray(parsed.chunks) ? parsed.chunks : []
      };
    }
  } catch {}

  return emptyStore();
}

function saveMemoryStore(store) {
  ensureStoreDir();
  const normalized = {
    ...store,
    version: 3,
    revision: Number(store.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    documents: store.documents.slice(-MAX_DOCUMENTS),
    chunks: store.chunks.slice(-MAX_CHUNKS)
  };
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
}

function redactSensitiveContent(content) {
  return String(content || '')
    .replace(/gsk_[A-Za-z0-9_-]{20,}/g, '[REDACTED_GROQ_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]');
}

function normalizeText(text) {
  return redactSensitiveContent(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeToken(term) {
  if (/^[a-z]+$/.test(term) && term.length > 5) {
    return term
      .replace(/(ization|ational|fulness|ousness|iveness)$/i, '')
      .replace(/(ing|edly|edly|ment|ments|tion|tions|able|ible)$/i, '')
      .replace(/(ed|es|s)$/i, '');
  }
  return term;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map((term) => normalizeToken(term.trim()))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 700);
}

function termFrequency(tokens) {
  const tf = {};
  for (const token of tokens) tf[token] = (tf[token] || 0) + 1;
  return tf;
}

function chunkText(text) {
  const clean = normalizeText(text);
  if (!clean) return [];

  const chunks = [];
  let cursor = 0;
  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + CHUNK_SIZE);
    const newline = clean.lastIndexOf('\n', end);
    if (newline > cursor + 320) end = newline;
    const chunk = clean.slice(cursor, end).trim();
    if (chunk.length >= 80) chunks.push(chunk);
    if (end >= clean.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP, cursor + 1);
  }

  return chunks;
}

function addMemoryDocument({ source = 'chat', title = '', text = '', metadata = {} }) {
  const cleanText = normalizeText(text);
  if (cleanText.length < 80) {
    return { added: 0, skipped: true, reason: 'too_short' };
  }

  const store = loadMemoryStore();
  const cleanMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
  const scopeId = String(cleanMetadata.scopeId || '').trim().slice(0, 160);
  if (scopeId) cleanMetadata.scopeId = scopeId;
  else delete cleanMetadata.scopeId;
  const hashScope = scopeId || 'legacy-unscoped';
  const documentHash = hashText(`${hashScope}\n${source}\n${title}\n${cleanText}`);
  if (store.documents.some((document) => document.hash === documentHash)) {
    return { added: 0, skipped: true, reason: 'duplicate' };
  }

  const now = new Date().toISOString();
  const documentId = `doc_${documentHash}`;
  const existingChunkHashes = new Set(
    store.chunks.map((chunk) => chunk.contentHash || hashText(normalizeText(chunk.text)))
  );
  const chunks = chunkText(cleanText)
    .map((chunk, index) => {
      const contentHash = hashText(`${hashScope}\n${chunk}`);
      const tokens = tokenize(`${title}\n${chunk}`);
      return {
        id: `chunk_${hashText(`${documentId}:${index}:${contentHash}`)}`,
        contentHash,
        documentId,
        source,
        title,
        text: chunk,
        tokens,
        tf: termFrequency(tokens),
        createdAt: now,
        metadata: cleanMetadata
      };
    })
    .filter((chunk) => !existingChunkHashes.has(chunk.contentHash));

  if (!chunks.length) {
    return { added: 0, skipped: true, reason: 'duplicate_chunks' };
  }

  store.documents.push({
    id: documentId,
    hash: documentHash,
    source,
    title,
    createdAt: now,
    chars: cleanText.length,
    chunks: chunks.length,
    metadata: cleanMetadata
  });
  store.chunks.push(...chunks);
  const saved = saveMemoryStore(store);

  return { added: chunks.length, documentId, revision: saved.revision };
}

function buildIdf(chunks) {
  const docFreq = {};
  for (const chunk of chunks) {
    const tokens = chunk.tokens?.length ? chunk.tokens : tokenize(`${chunk.title || ''}\n${chunk.text || ''}`);
    for (const token of new Set(tokens)) docFreq[token] = (docFreq[token] || 0) + 1;
  }

  const total = Math.max(chunks.length, 1);
  return (token) => Math.log(1 + (total - (docFreq[token] || 0) + 0.5) / ((docFreq[token] || 0) + 0.5));
}

function bm25Score(chunk, queryTokens, idf, averageLength) {
  if (!queryTokens.length) return 0;
  const tokens = chunk.tokens?.length ? chunk.tokens : tokenize(`${chunk.title || ''}\n${chunk.text || ''}`);
  const tf = chunk.tf && Object.keys(chunk.tf).length ? chunk.tf : termFrequency(tokens);
  const length = Math.max(tokens.length, 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  for (const token of queryTokens) {
    const frequency = Number(tf[token] || 0);
    if (!frequency) continue;
    const denominator = frequency + k1 * (1 - b + b * (length / Math.max(averageLength, 1)));
    score += idf(token) * ((frequency * (k1 + 1)) / denominator);
  }

  return score;
}

function featureHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function featureVector(tokens) {
  const vector = new Map();
  const limited = tokens.slice(0, 240);
  const add = (feature, weight) => {
    const bucket = featureHash(feature) % 384;
    vector.set(bucket, (vector.get(bucket) || 0) + weight);
  };

  limited.forEach((token, index) => {
    add(`u:${token}`, 1);
    if (index < limited.length - 1) add(`b:${token}_${limited[index + 1]}`, 1.35);
    if (token.length >= 6) {
      for (let offset = 0; offset <= Math.min(token.length - 3, 8); offset += 1) {
        add(`c:${token.slice(offset, offset + 3)}`, 0.18);
      }
    }
  });
  return vector;
}

function cosineSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [key, value] of left.entries()) dot += value * (right.get(key) || 0);
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}

function recencyScore(createdAt) {
  const ageMs = Date.now() - Date.parse(createdAt || 0);
  if (!Number.isFinite(ageMs)) return 0;
  const daysOld = Math.max(0, ageMs / 86400000);
  return Math.max(0, 1 - daysOld / 120);
}

function sourceScore(source) {
  if (source === 'active-window') return 1;
  if (source === 'optimizer-result') return 0.9;
  if (source === 'project') return 0.82;
  return 0.65;
}

function rankMap(items, scoreKey) {
  const ranked = [...items].sort((a, b) => b[scoreKey] - a[scoreKey]);
  return new Map(ranked.map((item, index) => [item.id, index + 1]));
}

function tokenCoverage(tokens, chunkTokens) {
  const query = Array.from(new Set(tokens));
  if (!query.length) return 0;
  const chunkSet = new Set(chunkTokens);
  return query.filter((token) => chunkSet.has(token)).length / query.length;
}

function jaccardSimilarity(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function gradeRetrieval(chunks) {
  if (!chunks.length) return { grade: 'low', confidence: 0, topScore: 0, averageScore: 0 };
  const scores = chunks.map((chunk) => Number(chunk.relevance || 0));
  const topScore = scores[0] || 0;
  const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const confidence = Math.min(1, topScore * 0.65 + averageScore * 0.35 + Math.min(chunks.length, 4) * 0.035);
  const grade = confidence >= 0.58 ? 'high' : confidence >= 0.34 ? 'medium' : 'low';
  return {
    grade,
    confidence: Number(confidence.toFixed(3)),
    topScore: Number(topScore.toFixed(3)),
    averageScore: Number(averageScore.toFixed(3))
  };
}

function retrieveMemoryAdvanced(query, {
  expandedQueries = [],
  intent = 'general',
  limit = 8,
  maxChars = 7000,
  scopeId = '',
  allowCrossWorkspace = false,
  allowLegacy = false
} = {}) {
  const store = loadMemoryStore();
  const normalizedScopeId = String(scopeId || '').trim();
  const allChunks = store.chunks || [];
  const chunks = normalizedScopeId && allowCrossWorkspace !== true
    ? allChunks.filter((chunk) => {
        const chunkScope = String(chunk.metadata?.scopeId || '').trim();
        return chunkScope === normalizedScopeId || (allowLegacy === true && !chunkScope);
      })
    : allChunks;
  if (!chunks.length) {
    return {
      chunks: [],
      documentCount: 0,
      totalChars: 0,
      queryTerms: [],
      queries: [],
      retrievalMode: 'hybrid-bm25-local-vector-rrf',
      intent,
      candidates: 0,
      totalCandidates: allChunks.length,
      scopeId: normalizedScopeId,
      revision: store.revision,
      ...gradeRetrieval([])
    };
  }

  const queries = [query, ...expandedQueries]
    .map((item) => normalizeText(item))
    .filter((item, index, all) => item && all.indexOf(item) === index)
    .slice(0, 5);
  const queryTokenSets = queries.map((item) => Array.from(new Set(tokenize(item))).slice(0, 100));
  const primaryTokens = queryTokenSets[0] || [];
  const allQueryTokens = Array.from(new Set(queryTokenSets.flat())).slice(0, 180);
  const idf = buildIdf(chunks);
  const averageLength = chunks.reduce((sum, chunk) => sum + (chunk.tokens?.length || tokenize(chunk.text).length), 0) / chunks.length;
  const primaryVector = featureVector(allQueryTokens);

  const candidates = chunks.map((chunk) => {
    const chunkTokens = chunk.tokens?.length ? chunk.tokens : tokenize(`${chunk.title || ''}\n${chunk.text || ''}`);
    const lexicalScores = queryTokenSets.map((tokens) => bm25Score(chunk, tokens, idf, averageLength));
    const lexical = (lexicalScores[0] || 0) + Math.max(0, ...lexicalScores.slice(1)) * 0.55;
    const semantic = cosineSimilarity(primaryVector, featureVector(chunkTokens));
    return {
      ...chunk,
      tokens: chunkTokens,
      lexical,
      semantic,
      coverage: tokenCoverage(primaryTokens, chunkTokens),
      expandedCoverage: tokenCoverage(allQueryTokens, chunkTokens),
      recency: recencyScore(chunk.createdAt),
      sourceTrust: sourceScore(chunk.source)
    };
  });

  const lexicalRanks = rankMap(candidates, 'lexical');
  const semanticRanks = rankMap(candidates, 'semantic');
  const maxLexical = Math.max(0.0001, ...candidates.map((candidate) => candidate.lexical));
  const maxRrf = 2 / (RRF_K + 1);

  const reranked = candidates.map((candidate) => {
    const rrf = (1 / (RRF_K + lexicalRanks.get(candidate.id))) +
      (1 / (RRF_K + semanticRanks.get(candidate.id)));
    const lexicalNormalized = candidate.lexical / maxLexical;
    const relevance = Math.min(1,
      lexicalNormalized * 0.34 +
      candidate.semantic * 0.24 +
      candidate.coverage * 0.18 +
      candidate.expandedCoverage * 0.08 +
      (rrf / maxRrf) * 0.08 +
      candidate.recency * 0.04 +
      candidate.sourceTrust * 0.04
    );
    return { ...candidate, rrf, relevance };
  }).sort((a, b) => b.relevance - a.relevance);

  const selected = [];
  const usedDocuments = new Set();
  const perDocument = new Map();
  let total = 0;

  for (const chunk of reranked) {
    if (selected.length >= limit || total >= maxChars) break;
    if (chunk.relevance < 0.16) continue;
    if ((perDocument.get(chunk.documentId) || 0) >= 2) continue;
    if (selected.some((item) => jaccardSimilarity(item.tokens, chunk.tokens) > 0.82)) continue;

    const text = chunk.text.slice(0, Math.max(0, maxChars - total));
    if (!text.trim()) break;
    selected.push({
      source: chunk.source,
      title: chunk.title,
      text,
      score: Number((chunk.relevance * 100).toFixed(1)),
      relevance: Number(chunk.relevance.toFixed(3)),
      lexicalScore: Number(chunk.lexical.toFixed(3)),
      vectorScore: Number(chunk.semantic.toFixed(3)),
      createdAt: chunk.createdAt,
      documentId: chunk.documentId,
      scopeId: String(chunk.metadata?.scopeId || ''),
      tokens: chunk.tokens
    });
    usedDocuments.add(chunk.documentId);
    perDocument.set(chunk.documentId, (perDocument.get(chunk.documentId) || 0) + 1);
    total += text.length;
  }

  const grading = gradeRetrieval(selected);
  return {
    chunks: selected.map(({ tokens, ...chunk }) => chunk),
    documentCount: usedDocuments.size,
    totalChars: total,
    queryTerms: allQueryTokens.slice(0, 32),
    queries,
    retrievalMode: 'hybrid-bm25-local-vector-rrf',
    intent,
    candidates: candidates.length,
    totalCandidates: allChunks.length,
    scopeId: normalizedScopeId,
    revision: store.revision,
    ...grading
  };
}

function retrieveMemory(query, options = {}) {
  return retrieveMemoryAdvanced(query, options);
}

function formatRetrievedMemory(retrieval) {
  if (!retrieval?.chunks?.length) return '';

  return retrieval.chunks
    .map((chunk, index) => [
      `<memory-evidence rank="${index + 1}" source="${chunk.source}" relevance="${chunk.relevance}" title="${String(chunk.title || 'Untitled').replace(/["<>]/g, '')}">`,
      chunk.text,
      '</memory-evidence>'
    ].join('\n'))
    .join('\n\n-----\n\n');
}

function getMemoryStats() {
  const store = loadMemoryStore();
  const chars = (store.chunks || []).reduce((sum, chunk) => sum + String(chunk.text || '').length, 0);
  const scopeIds = new Set();
  let unscopedChunks = 0;
  for (const chunk of store.chunks || []) {
    const scopeId = String(chunk.metadata?.scopeId || '').trim();
    if (scopeId) scopeIds.add(scopeId);
    else unscopedChunks += 1;
  }
  return {
    documents: store.documents.length,
    chunks: store.chunks.length,
    scopes: scopeIds.size,
    unscopedChunks,
    chars,
    revision: store.revision,
    updatedAt: store.updatedAt,
    memoryFile: MEMORY_FILE
  };
}

function clearMemory() {
  saveMemoryStore(emptyStore());
  return getMemoryStats();
}

function removeMemoryDocuments(documentIds) {
  const ids = new Set((Array.isArray(documentIds) ? documentIds : [documentIds]).filter(Boolean));
  if (!ids.size) return { removedDocuments: 0, removedChunks: 0, ...getMemoryStats() };

  const store = loadMemoryStore();
  const documentsBefore = store.documents.length;
  const chunksBefore = store.chunks.length;
  store.documents = store.documents.filter((document) => !ids.has(document.id));
  store.chunks = store.chunks.filter((chunk) => !ids.has(chunk.documentId));
  saveMemoryStore(store);
  return {
    removedDocuments: documentsBefore - store.documents.length,
    removedChunks: chunksBefore - store.chunks.length,
    ...getMemoryStats()
  };
}

module.exports = {
  MEMORY_FILE,
  addMemoryDocument,
  retrieveMemory,
  retrieveMemoryAdvanced,
  formatRetrievedMemory,
  getMemoryStats,
  clearMemory,
  removeMemoryDocuments,
  redactSensitiveContent,
  tokenize,
  gradeRetrieval
};
