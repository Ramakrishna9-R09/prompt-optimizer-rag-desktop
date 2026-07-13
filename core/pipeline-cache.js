'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR } = require('./config');

const CACHE_FILE = path.join(CONFIG_DIR, 'pipeline-cache.json');
const TIER_CONFIG = {
  intent: { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 160 },
  hyde: { ttlMs: 6 * 60 * 60 * 1000, maxEntries: 100 },
  retrieval: { ttlMs: 20 * 60 * 1000, maxEntries: 160 },
  generation: { ttlMs: 60 * 60 * 1000, maxEntries: 80 },
  final: { ttlMs: 60 * 60 * 1000, maxEntries: 80 }
};

function emptyCache() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    tiers: Object.fromEntries(Object.keys(TIER_CONFIG).map((tier) => [tier, []]))
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function cacheKey(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return emptyCache();
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    const fallback = emptyCache();
    return {
      ...fallback,
      ...parsed,
      tiers: Object.fromEntries(
        Object.keys(TIER_CONFIG).map((tier) => [
          tier,
          Array.isArray(parsed.tiers?.[tier]) ? parsed.tiers[tier] : []
        ])
      )
    };
  } catch {
    return emptyCache();
  }
}

function saveCache(cache) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const now = Date.now();
  const tiers = {};

  for (const [tier, config] of Object.entries(TIER_CONFIG)) {
    tiers[tier] = (cache.tiers[tier] || [])
      .filter((entry) => Number(entry.expiresAt) > now)
      .sort((a, b) => Number(b.lastHitAt || b.createdAt) - Number(a.lastHitAt || a.createdAt))
      .slice(0, config.maxEntries);
  }

  const normalized = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tiers
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

function getCache(tier, keyParts) {
  if (!TIER_CONFIG[tier]) return { hit: false };
  const cache = loadCache();
  const key = cacheKey(keyParts);
  const now = Date.now();
  const entry = (cache.tiers[tier] || []).find(
    (candidate) => candidate.key === key && Number(candidate.expiresAt) > now
  );

  if (!entry) return { hit: false, key };
  entry.hits = Number(entry.hits || 0) + 1;
  entry.lastHitAt = now;
  saveCache(cache);
  return { hit: true, key, value: entry.value };
}

function setCache(tier, keyParts, value, ttlMs) {
  if (!TIER_CONFIG[tier]) return value;
  const cache = loadCache();
  const key = cacheKey(keyParts);
  const now = Date.now();
  const config = TIER_CONFIG[tier];
  cache.tiers[tier] = (cache.tiers[tier] || []).filter((entry) => entry.key !== key);
  cache.tiers[tier].unshift({
    key,
    value,
    createdAt: now,
    lastHitAt: now,
    expiresAt: now + (Number(ttlMs) || config.ttlMs),
    hits: 0
  });
  saveCache(cache);
  return value;
}

function getCacheStats() {
  const cache = loadCache();
  const now = Date.now();
  const tiers = {};
  let entries = 0;
  let hits = 0;

  for (const tier of Object.keys(TIER_CONFIG)) {
    const active = (cache.tiers[tier] || []).filter((entry) => Number(entry.expiresAt) > now);
    tiers[tier] = active.length;
    entries += active.length;
    hits += active.reduce((sum, entry) => sum + Number(entry.hits || 0), 0);
  }

  return { entries, hits, tiers, updatedAt: cache.updatedAt, cacheFile: CACHE_FILE };
}

function clearPipelineCache() {
  saveCache(emptyCache());
  return getCacheStats();
}

module.exports = {
  CACHE_FILE,
  getCache,
  setCache,
  getCacheStats,
  clearPipelineCache
};
