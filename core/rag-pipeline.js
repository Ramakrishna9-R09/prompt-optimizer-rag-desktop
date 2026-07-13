'use strict';

const {
  retrieveMemoryAdvanced,
  formatRetrievedMemory,
  getMemoryStats,
  tokenize
} = require('./memory-store');
const {
  sanitizeInput,
  scanPromptInjection,
  wrapUntrustedContext
} = require('./rag-security');
const { getCache, setCache } = require('./pipeline-cache');

const CONTEXT_BUDGET = {
  active: 6500,
  memory: 4800,
  project: 4800,
  history: 900,
  total: 17000
};

const INTENT_PATTERNS = [
  ['debug', /\b(debug|bug|broken|error|exception|not working|fails?|failure|root cause|regression)\b/i],
  ['test', /\b(test|tests|coverage|unit test|integration test|e2e|playwright|verify)\b/i],
  ['review', /\b(review|audit|security review|code review|find issues|risk|vulnerabilit)\b/i],
  ['refactor', /\b(refactor|cleanup|restructure|simplify|technical debt|maintainability)\b/i],
  ['feature', /\b(implement|build|create|make|add|enhance|upgrade|integrate|support|feature)\b/i],
  ['explain', /\b(explain|understand|how does|walk me through|document|summarize)\b/i]
];

function routeIntent(text, explicitPurpose = 'auto') {
  if (explicitPurpose && explicitPurpose !== 'auto') return explicitPurpose;
  const cached = getCache('intent', { text: String(text || '').slice(0, 4000) });
  if (cached.hit) return cached.value;
  const match = INTENT_PATTERNS.find(([, pattern]) => pattern.test(String(text || '')));
  const intent = match?.[0] || 'general';
  setCache('intent', { text: String(text || '').slice(0, 4000) }, intent);
  return intent;
}

function extractSalientTerms(text, limit = 18) {
  const terms = tokenize(text);
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term]) => term);
}

function buildLocalHydeQueries(rawPrompt, activeContext, projectContext, intent) {
  const rawTerms = extractSalientTerms(rawPrompt, 12);
  const activeTerms = extractSalientTerms(String(activeContext || '').slice(-4500), 14);
  const projectTerms = extractSalientTerms(String(projectContext || '').slice(0, 3500), 12);
  const productTerms = Array.from(new Set([...rawTerms, ...activeTerms, ...projectTerms])).slice(0, 20);
  const core = productTerms.join(' ');

  return [
    `A previous conversation describing the same ${intent} request, product goal, current behavior, and expected outcome: ${core}`,
    `Implementation context for ${intent}: relevant application components, keyboard shortcuts, files, errors, constraints, and verification: ${core}`,
    `Prior decisions and completed work needed to continue this task without losing context: ${core}`
  ];
}

function chooseBetterRetrieval(first, second) {
  if (!second) return first;
  if ((second.confidence || 0) > (first.confidence || 0) + 0.02) return second;
  if (second.chunks.length > first.chunks.length && second.grade !== 'low') return second;
  return first;
}

function getRetrieval(query, options, memoryRevision) {
  const key = { query, options, memoryRevision };
  const cached = getCache('retrieval', key);
  if (cached.hit) return { retrieval: cached.value, cacheHit: true };
  const retrieval = retrieveMemoryAdvanced(query, options);
  setCache('retrieval', key, retrieval);
  return { retrieval, cacheHit: false };
}

function trimSection(text, maxChars, keep = 'start') {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return keep === 'end'
    ? `[older content omitted]\n${value.slice(-maxChars)}`
    : `${value.slice(0, maxChars)}\n[newer content omitted]`;
}

function combineWithinBudget(sections, maxChars) {
  const selected = [];
  let remaining = maxChars;
  for (const section of sections.filter(Boolean)) {
    if (remaining <= 0) break;
    const value = section.length > remaining
      ? `${section.slice(0, Math.max(0, remaining - 32))}\n[context budget reached]`
      : section;
    selected.push(value);
    remaining -= value.length + 36;
  }
  return selected.join('\n\n====================\n\n');
}

async function prepareRagContext({
  rawPrompt,
  activeWindowContext = '',
  projectContext = '',
  historyContext = '',
  scopeId = '',
  allowCrossWorkspaceMemory = false,
  allowLegacyMemory = false,
  purpose = 'auto',
  memoryMaxChars = CONTEXT_BUDGET.memory,
  memoryEnabled = true,
  hydeEnabled = true,
  hydeGenerator,
  onProgress
}) {
  const raw = sanitizeInput(rawPrompt, { maxChars: 5000, keep: 'start' });
  const active = sanitizeInput(activeWindowContext, { maxChars: CONTEXT_BUDGET.active, keep: 'end' });
  const project = sanitizeInput(projectContext, { maxChars: CONTEXT_BUDGET.project, keep: 'start' });
  const history = sanitizeInput(historyContext, { maxChars: CONTEXT_BUDGET.history, keep: 'end' });
  const scans = {
    raw: scanPromptInjection(raw.text),
    active: scanPromptInjection(active.text),
    project: scanPromptInjection(project.text),
    history: scanPromptInjection(history.text)
  };

  onProgress?.('Routing intent and searching memory...');
  const intentCache = getCache('intent', { text: raw.text });
  const intent = routeIntent(raw.text, purpose);
  const memoryStats = memoryEnabled ? getMemoryStats() : { chunks: 0, revision: -1 };
  const localHyde = buildLocalHydeQueries(raw.text, active.text, project.text, intent);
  const retrievalQuery = `${raw.text}\n${extractSalientTerms(active.text, 24).join(' ')}\n${extractSalientTerms(project.text, 20).join(' ')}`;
  const retrievalOptions = {
    expandedQueries: localHyde,
    intent,
    limit: 10,
    maxChars: Math.min(Number(memoryMaxChars) || CONTEXT_BUDGET.memory, CONTEXT_BUDGET.memory),
    scopeId: String(scopeId || ''),
    allowCrossWorkspace: allowCrossWorkspaceMemory === true,
    allowLegacy: allowLegacyMemory === true
  };
  const baselineResult = memoryEnabled
    ? getRetrieval(retrievalQuery, retrievalOptions, memoryStats.revision)
    : {
        cacheHit: false,
        retrieval: {
          chunks: [], documentCount: 0, totalChars: 0, queryTerms: [], queries: [],
          retrievalMode: 'disabled', intent, candidates: 0, revision: -1,
          totalCandidates: 0, scopeId: String(scopeId || ''),
          grade: 'low', confidence: 0, topScore: 0, averageScore: 0
        }
      };
  let retrieval = baselineResult.retrieval;
  let retrievalCacheHit = baselineResult.cacheHit;
  let hydeSource = 'local';
  let hydeCacheHit = false;
  let generatedHyde = [];

  const promptIsSparse = new Set(tokenize(raw.text)).size < 8;
  const shouldGenerateHyde = hydeEnabled && retrieval.candidates > 0 &&
    typeof hydeGenerator === 'function' && (retrieval.grade === 'low' || promptIsSparse);

  if (shouldGenerateHyde) {
    onProgress?.('Expanding the request against earlier conversations...');
    const hydeKey = {
      raw: raw.text,
      intent,
      scopeId: String(scopeId || ''),
      contextTerms: extractSalientTerms(`${active.text}\n${project.text}`, 24)
    };
    const cachedHyde = getCache('hyde', hydeKey);
    if (cachedHyde.hit) {
      generatedHyde = cachedHyde.value;
      hydeCacheHit = true;
    } else {
      try {
        generatedHyde = await hydeGenerator({
          rawPrompt: raw.text,
          intent,
          contextSummary: `${trimSection(active.text, 1800, 'end')}\n${trimSection(project.text, 1200, 'start')}`
        });
      } catch {
        generatedHyde = [];
      }
      if (generatedHyde.length) setCache('hyde', hydeKey, generatedHyde);
    }

    if (generatedHyde.length) {
      hydeSource = 'adaptive-llm';
      const expandedOptions = {
        ...retrievalOptions,
        expandedQueries: [...generatedHyde, ...localHyde].slice(0, 5)
      };
      const expandedResult = getRetrieval(retrievalQuery, expandedOptions, memoryStats.revision);
      retrieval = chooseBetterRetrieval(retrieval, expandedResult.retrieval);
      retrievalCacheHit = retrievalCacheHit || expandedResult.cacheHit;
    }
  }

  onProgress?.('Grading and spotlighting relevant context...');
  const memoryText = retrieval.confidence >= 0.16 ? formatRetrievedMemory(retrieval) : '';
  const injectionFlags = Array.from(new Set(Object.values(scans).flatMap((scan) => scan.flags)));
  const purposeText = `CONTEXT SCOPE: ${String(scopeId || 'unscoped')}\nPIPELINE ROUTE: ${intent}\nRETRIEVAL GRADE: ${retrieval.grade} (${retrieval.confidence})`;
  const sections = [
    purposeText,
    active.text ? wrapUntrustedContext('live-active-window', trimSection(active.text, CONTEXT_BUDGET.active, 'end'), {
      priority: 'highest',
      injectionRisk: scans.active.risk
    }) : '',
    memoryText ? wrapUntrustedContext('retrieved-memory', trimSection(memoryText, CONTEXT_BUDGET.memory, 'start'), {
      retrieval: retrieval.retrievalMode,
      grade: retrieval.grade,
      confidence: retrieval.confidence
    }) : '',
    project.text ? wrapUntrustedContext('current-project', trimSection(project.text, CONTEXT_BUDGET.project, 'start'), {
      priority: 'current-state',
      injectionRisk: scans.project.risk
    }) : '',
    history.text ? wrapUntrustedContext('optimizer-history', trimSection(history.text, CONTEXT_BUDGET.history, 'end'), {
      priority: 'low'
    }) : ''
  ];
  const context = combineWithinBudget(sections, CONTEXT_BUDGET.total);

  return {
    context,
    intent,
    retrieval,
    sanitizedPrompt: raw.text,
    diagnostics: {
      intent,
      scopeId: String(scopeId || ''),
      crossWorkspaceMemory: allowCrossWorkspaceMemory === true,
      intentCacheHit: intentCache.hit,
      retrievalMode: retrieval.retrievalMode,
      retrievalGrade: retrieval.grade,
      retrievalConfidence: retrieval.confidence,
      retrievedChunks: retrieval.chunks.length,
      candidateChunks: retrieval.candidates,
      totalMemoryChunks: retrieval.totalCandidates ?? memoryStats.chunks,
      memoryRevision: memoryStats.revision,
      hydeSource,
      hydeGenerated: generatedHyde.length,
      hydeCacheHit,
      retrievalCacheHit,
      injectionFlags,
      redactions: [raw, active, project, history].filter((item) => item.redacted).length,
      contextChars: context.length,
      activeChars: active.chars,
      projectChars: project.chars,
      memoryChars: retrieval.totalChars
    }
  };
}

module.exports = {
  CONTEXT_BUDGET,
  routeIntent,
  extractSalientTerms,
  buildLocalHydeQueries,
  prepareRagContext
};
