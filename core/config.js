'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CONFIG_DIR = process.env.PROMPT_OPTIMIZER_CONFIG_DIR
  ? path.resolve(process.env.PROMPT_OPTIMIZER_CONFIG_DIR)
  : path.join(os.homedir(), '.prompt-optimizer');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_PRODUCT_METRICS = {
  schemaVersion: 1,
  totalOptimizations: 0,
  contextOptimizations: 0,
  autopilotSessions: 0,
  suggestionsGenerated: 0,
  suggestionsAccepted: 0,
  ideHandoffs: 0,
  firstUsedAt: '',
  lastUsedAt: '',
  activeDays: []
};

const DEFAULT_COMMERCIAL_PLAN = {
  currency: 'USD',
  targetAnnualRevenue: 1000000,
  proMonthlyPrice: 24,
  teamSeatMonthlyPrice: 49,
  targetProSubscribers: 2500,
  targetTeamSeats: 500
};

const DEFAULT_CONFIG = {
  configVersion: 3,
  apiKey: '',
  apiKeyProtected: '',
  mode: 'general', // 'general' | 'context' | 'code'
  refinementStyle: 'pro', // 'fast' | 'pro' | 'architect'
  promptPurpose: 'auto', // 'auto' | 'feature' | 'debug' | 'refactor' | 'test' | 'review' | 'explain'
  optimizerEnabled: true,
  hotkey: 'Ctrl+Shift+Space',
  contextHotkey: 'Ctrl+Alt+Space',
  toggleHotkey: 'Ctrl+Alt+F10',
  projectRoot: '',
  projects: [],
  projectContextPolicy: 'auto', // 'auto' | 'pinned'
  workspaceProjectBindings: {},
  lastContextScope: null,
  memoryRagEnabled: true,
  crossWorkspaceMemoryEnabled: false,
  crossWorkspaceHistoryEnabled: false,
  advancedRagEnabled: true,
  ragHydeEnabled: true,
  selfReflectionEnabled: true,
  autoLearnFromContext: true,
  memoryMaxChars: 7000,
  includeProjectContext: true,
  includeGitDiff: true,
  includePromptHistory: false,
  autoCopy: true,
  autoInject: false,
  promptAutopilotEnabled: true,
  promptSuggestionCount: 3,
  promptAutopilotQualityThreshold: 0.78,
  autoSendToIDE: false,
  localUsageMetricsEnabled: true,
  productMetrics: { ...DEFAULT_PRODUCT_METRICS },
  commercialPlan: { ...DEFAULT_COMMERCIAL_PLAN },
  selectedIDE: 'none', // 'none' | 'codex' | 'vscode' | 'cursor' | 'antigravity' | 'claude' | 'opencode'
  theme: 'dark',
  promptHistory: []
};

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeConfig(config) {
  const productMetrics = {
    ...DEFAULT_PRODUCT_METRICS,
    ...(config.productMetrics && typeof config.productMetrics === 'object' ? config.productMetrics : {})
  };
  productMetrics.activeDays = Array.isArray(productMetrics.activeDays)
    ? productMetrics.activeDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day))).slice(-90)
    : [];
  for (const key of ['totalOptimizations', 'contextOptimizations', 'autopilotSessions', 'suggestionsGenerated', 'suggestionsAccepted', 'ideHandoffs']) {
    productMetrics[key] = Math.max(0, Math.floor(Number(productMetrics[key]) || 0));
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
    configVersion: DEFAULT_CONFIG.configVersion,
    promptSuggestionCount: Math.round(clampNumber(config.promptSuggestionCount, 3, 2, 4)),
    promptAutopilotQualityThreshold: clampNumber(config.promptAutopilotQualityThreshold, 0.78, 0.6, 0.95),
    projectContextPolicy: config.projectContextPolicy === 'pinned' ? 'pinned' : 'auto',
    crossWorkspaceMemoryEnabled: config.crossWorkspaceMemoryEnabled === true,
    crossWorkspaceHistoryEnabled: config.crossWorkspaceHistoryEnabled === true,
    workspaceProjectBindings: config.workspaceProjectBindings && typeof config.workspaceProjectBindings === 'object' && !Array.isArray(config.workspaceProjectBindings)
      ? Object.fromEntries(Object.entries(config.workspaceProjectBindings)
        .filter(([scopeId, projectRoot]) => /^app:[a-z0-9:-]+$/i.test(scopeId) && typeof projectRoot === 'string' && projectRoot.trim())
        .slice(0, 50))
      : {},
    lastContextScope: config.lastContextScope && typeof config.lastContextScope === 'object'
      ? {
          id: String(config.lastContextScope.id || '').slice(0, 160),
          appId: String(config.lastContextScope.appId || '').slice(0, 80),
          appLabel: String(config.lastContextScope.appLabel || '').slice(0, 80),
          workspaceLabel: String(config.lastContextScope.workspaceLabel || '').slice(0, 120),
          label: String(config.lastContextScope.label || '').slice(0, 180),
          lastSeenAt: String(config.lastContextScope.lastSeenAt || '')
        }
      : null,
    productMetrics,
    commercialPlan: {
      ...DEFAULT_COMMERCIAL_PLAN,
      ...(config.commercialPlan && typeof config.commercialPlan === 'object' ? config.commercialPlan : {})
    }
  };
}

function runEncodedPowerShell(script, input) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      input,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#< CLIXML') && !line.startsWith('<Objs '))
    .pop() || '';
}

function protectSecret(secret) {
  if (!secret || process.platform !== 'win32') return '';

  try {
    return runEncodedPowerShell(`
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`, secret);
  } catch {
    return '';
  }
}

function unprotectSecret(protectedSecret) {
  if (!protectedSecret || process.platform !== 'win32') return '';

  try {
    return runEncodedPowerShell(`
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($encoded)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($plain)
`, protectedSecret);
  } catch {
    return '';
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      const normalized = normalizeConfig(saved);
      if (saved.configVersion !== normalized.configVersion) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
      }
      return normalized;
    }
  } catch (e) {
    console.error('[Config] Failed to load:', e.message);
  }
  return normalizeConfig(DEFAULT_CONFIG);
}

function saveConfig(updates) {
  ensureConfigDir();
  const current = loadConfig();
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'apiKey') && normalizedUpdates.apiKey) {
    const protectedKey = protectSecret(normalizedUpdates.apiKey);
    if (protectedKey) {
      normalizedUpdates.apiKeyProtected = protectedKey;
      normalizedUpdates.apiKey = '';
    }
  }
  const merged = normalizeConfig({ ...current, ...normalizedUpdates });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function summarizeProductMetrics(metrics) {
  const now = Date.now();
  const activeDays = Array.isArray(metrics.activeDays) ? metrics.activeDays : [];
  const countSince = (days) => activeDays.filter((day) => {
    const timestamp = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(timestamp) && timestamp >= now - days * 24 * 60 * 60 * 1000;
  }).length;
  const sessions = Number(metrics.autopilotSessions) || 0;
  const accepted = Number(metrics.suggestionsAccepted) || 0;

  return {
    ...DEFAULT_PRODUCT_METRICS,
    ...metrics,
    activeDays7: countSince(7),
    activeDays30: countSince(30),
    suggestionAcceptanceRate: sessions ? Number((accepted / sessions).toFixed(3)) : 0
  };
}

function getProductMetrics() {
  return summarizeProductMetrics(loadConfig().productMetrics || DEFAULT_PRODUCT_METRICS);
}

function recordProductEvent(event, options = {}) {
  const current = loadConfig();
  if (current.localUsageMetricsEnabled === false) return summarizeProductMetrics(current.productMetrics);

  const metrics = { ...DEFAULT_PRODUCT_METRICS, ...(current.productMetrics || {}) };
  const count = Math.max(1, Math.min(10, Math.round(Number(options.count) || 1)));
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const activeDays = Array.from(new Set([...(metrics.activeDays || []), day])).slice(-90);

  switch (event) {
    case 'optimization':
      metrics.totalOptimizations += 1;
      if (options.context === true) metrics.contextOptimizations += 1;
      break;
    case 'context-optimization':
      metrics.contextOptimizations += 1;
      break;
    case 'suggestions-generated':
      metrics.autopilotSessions += 1;
      metrics.suggestionsGenerated += count;
      break;
    case 'suggestion-accepted':
      metrics.suggestionsAccepted += 1;
      break;
    case 'autopilot-accepted':
      metrics.suggestionsAccepted += 1;
      metrics.totalOptimizations += 1;
      if (options.context === true) metrics.contextOptimizations += 1;
      break;
    case 'ide-handoff':
      metrics.ideHandoffs += 1;
      break;
    default:
      return summarizeProductMetrics(metrics);
  }

  metrics.firstUsedAt = metrics.firstUsedAt || now.toISOString();
  metrics.lastUsedAt = now.toISOString();
  metrics.activeDays = activeDays;
  const saved = saveConfig({ productMetrics: metrics });
  return summarizeProductMetrics(saved.productMetrics);
}

function getRevenueProjection() {
  const plan = loadConfig().commercialPlan;
  const projectedAnnualRevenue = 12 * (
    Number(plan.proMonthlyPrice) * Number(plan.targetProSubscribers) +
    Number(plan.teamSeatMonthlyPrice) * Number(plan.targetTeamSeats)
  );
  return {
    ...plan,
    projectedAnnualRevenue,
    targetMet: projectedAnnualRevenue >= Number(plan.targetAnnualRevenue)
  };
}

function appendPromptHistory(entry) {
  const current = loadConfig();
  const promptHistory = Array.isArray(current.promptHistory) ? current.promptHistory : [];
  const cleanEntry = {
    source: entry.source || 'optimizer',
    prompt: String(entry.prompt || '').trim().slice(0, 4000),
    refined: String(entry.refined || '').trim().slice(0, 4000),
    scopeId: String(entry.scopeId || '').trim().slice(0, 160),
    appId: String(entry.appId || '').trim().slice(0, 80),
    workspaceLabel: String(entry.workspaceLabel || '').trim().slice(0, 120),
    createdAt: entry.createdAt || new Date().toISOString()
  };

  if (!cleanEntry.prompt && !cleanEntry.refined) return current;

  return saveConfig({
    promptHistory: [...promptHistory, cleanEntry].slice(-20)
  });
}

function getApiKey() {
  const config = loadConfig();
  const protectedKey = unprotectSecret(config.apiKeyProtected);
  return protectedKey || config.apiKey;
}

function setApiKey(key) {
  saveConfig({ apiKey: key });
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEFAULT_PRODUCT_METRICS,
  DEFAULT_COMMERCIAL_PLAN,
  loadConfig,
  saveConfig,
  appendPromptHistory,
  getProductMetrics,
  recordProductEvent,
  getRevenueProjection,
  getApiKey,
  setApiKey
};
