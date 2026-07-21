'use strict';

let currentConfig = {};
let currentAutopilotSessionId = '';
let loadingTarget = 'optimize';
let shortcutState = null;

document.addEventListener('DOMContentLoaded', async () => {
  currentConfig = await window.api.getConfig();
  shortcutState = await window.api.getShortcutState();

  updateStatusDot();
  applyConfig();
  if (currentConfig.onboardingCompleted !== true) showOnboarding();
  document.querySelector('.content').scrollTop = 0;

  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());
  document.getElementById('btn-toggle-optimizer').addEventListener('click', handleToggleOptimizer);
  document.getElementById('btn-show-onboarding').addEventListener('click', showOnboarding);
  document.getElementById('btn-complete-onboarding').addEventListener('click', completeOnboarding);

  document.getElementById('btn-optimize').addEventListener('click', handleOptimize);
  document.getElementById('btn-suggest').addEventListener('click', handleGenerateSuggestions);
  document.getElementById('btn-paste').addEventListener('click', handlePasteFromClipboard);
  document.getElementById('btn-preview-context').addEventListener('click', handlePreviewContext);
  document.getElementById('btn-copy').addEventListener('click', handleCopyResult);
  document.getElementById('input-prompt').addEventListener('input', updatePromptCharacterCount);

  document.getElementById('btn-goto-settings').addEventListener('click', () => switchView('view-settings'));
  document.getElementById('btn-goto-ide').addEventListener('click', () => switchView('view-ide'));
  document.getElementById('btn-back-main').addEventListener('click', () => switchView('view-main'));
  document.getElementById('btn-back-main2').addEventListener('click', () => switchView('view-main'));

  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);
  document.getElementById('btn-toggle-vis').addEventListener('click', toggleKeyVisibility);
  document.getElementById('btn-browse-project').addEventListener('click', handleBrowseProject);
  document.getElementById('select-project').addEventListener('change', handleSelectProject);
  document.getElementById('btn-bind-project-scope').addEventListener('click', handleBindProjectScope);
  document.getElementById('btn-unbind-project-scope').addEventListener('click', handleUnbindProjectScope);
  document.getElementById('btn-refresh-memory').addEventListener('click', refreshMemoryStats);
  document.getElementById('btn-clear-memory').addEventListener('click', handleClearMemory);
  document.getElementById('range-quality-threshold').addEventListener('input', updateQualityThresholdLabel);

  document.querySelectorAll('.ide-card').forEach(card => {
    card.addEventListener('click', () => selectIDE(card.dataset.ide));
  });

  window.api.onNotification((data) => showToast(data.message, data.type));
  window.api.onStatusUpdate((data) => setStatusText(data.message));
  window.api.onRefineStart(() => setLoading(true, undefined, loadingTarget));
  window.api.onRefineStop(() => setLoading(false));
  window.api.onRefineComplete((data) => {
    setLoading(false);
    showResult(data.refined);
    replacePromptInput(data.refined);
  });
  window.api.onOptimizerStateChanged((state) => applyOptimizerState(state));
  window.api.onOptimizeInputHotkey(() => handleOptimize());
  window.api.onOptimizeInputWithContextHotkey(() => handleOptimizeWithContext());
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
    event.preventDefault();
    handleOptimize();
  }

  if (event.ctrlKey && event.altKey && event.code === 'Space') {
    event.preventDefault();
    handleOptimizeWithContext();
  }
});

function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  document.querySelector('.content').scrollTop = 0;
}

function updatePromptCharacterCount() {
  const input = document.getElementById('input-prompt');
  const counter = document.getElementById('prompt-character-count');
  if (input && counter) counter.textContent = `${formatNumber(input.value.length)} characters`;
}

function showOnboarding() {
  document.getElementById('onboarding-launch-startup').checked = currentConfig.launchAtStartup !== false;
  document.getElementById('onboarding').classList.remove('hidden');
}

async function completeOnboarding() {
  const launchAtStartup = document.getElementById('onboarding-launch-startup').checked;
  currentConfig = await window.api.saveConfig({ onboardingCompleted: true, launchAtStartup });
  document.getElementById('check-launch-startup').checked = launchAtStartup;
  document.getElementById('onboarding').classList.add('hidden');
  showToast('Ready. Try Ctrl+Shift+Space in any supported prompt box.', 'success');
}

function updateStatusDot() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const detail = document.getElementById('status-detail');
  const toggle = document.getElementById('btn-toggle-optimizer');
  const statusBar = toggle.closest('.status-bar');
  dot.classList.remove('active', 'warning');
  toggle.classList.remove('start-optimizer', 'stop-optimizer');
  statusBar?.classList.remove('optimizer-running', 'optimizer-stopped');
  if (currentConfig.optimizerEnabled === false) {
    statusBar?.classList.add('optimizer-stopped');
    text.textContent = '● Optimizer OFF';
    detail.textContent = 'Paused — Ctrl+Alt+Space will wake and run it';
    toggle.classList.add('start-optimizer');
    toggle.textContent = '▶ Start Optimizer';
    toggle.title = 'Turn on Prompt Optimizer and enable its commands';
    return;
  }
  const actionShortcutsReady = shortcutState?.registered?.optimize && shortcutState?.registered?.context;
  statusBar?.classList.add('optimizer-running');
  dot.classList.add(actionShortcutsReady === false ? 'warning' : 'active');
  text.textContent = actionShortcutsReady === false ? '● Optimizer ON — shortcut conflict' : '● Optimizer ON';
  const keyStatus = currentConfig.apiKey || currentConfig.apiKeyProtected ? 'API ready' : 'API key required';
  detail.textContent = actionShortcutsReady === false
    ? 'One or more shortcuts are used by another app'
    : `${keyStatus} • running in the system tray`;
  toggle.classList.add('stop-optimizer');
  toggle.textContent = '■ Stop Optimizer';
  toggle.title = 'Turn off Prompt Optimizer and disable its commands';
}

async function handleToggleOptimizer() {
  shortcutState = await window.api.setOptimizerEnabled(currentConfig.optimizerEnabled === false);
  applyOptimizerState(shortcutState);
}

function applyConfig() {
  const apiKeyInput = document.getElementById('input-apikey');
  const apiKeyState = document.getElementById('api-key-state');
  const hasSavedApiKey = Boolean(currentConfig.apiKey || currentConfig.apiKeyProtected);
  apiKeyInput.placeholder = hasSavedApiKey ? 'Saved securely — enter only to replace' : 'Required: enter a Groq key beginning with gsk_';
  apiKeyState.textContent = hasSavedApiKey ? '✓ API key saved securely on this computer' : '⚠ No API key saved';
  apiKeyState.className = `api-key-state ${hasSavedApiKey ? 'saved' : 'missing'}`;
  document.getElementById('select-mode').value = currentConfig.mode || 'general';
  document.getElementById('select-purpose').value = currentConfig.promptPurpose || 'auto';
  document.getElementById('select-style').value = currentConfig.refinementStyle || 'pro';
  document.getElementById('check-prompt-autopilot').checked = currentConfig.promptAutopilotEnabled !== false;
  document.getElementById('select-suggestion-count').value = String(currentConfig.promptSuggestionCount || 3);
  document.getElementById('range-quality-threshold').value = String(Math.round((currentConfig.promptAutopilotQualityThreshold || 0.78) * 100));
  document.getElementById('check-auto-send-ide').checked = currentConfig.autoSendToIDE === true;
  document.getElementById('check-local-metrics').checked = currentConfig.localUsageMetricsEnabled !== false;
  updateQualityThresholdLabel();
  document.getElementById('input-hotkey').value = currentConfig.hotkey || 'Ctrl+Shift+Space';
  document.getElementById('input-context-hotkey').value = currentConfig.contextHotkey || 'Ctrl+Alt+Space';
  document.getElementById('input-toggle-hotkey').value = currentConfig.toggleHotkey || 'Ctrl+Alt+F10';
  document.getElementById('input-project-root').value = currentConfig.projectRoot || '';
  document.getElementById('select-project-policy').value = currentConfig.projectContextPolicy || 'auto';
  document.getElementById('check-optimizer-enabled').checked = currentConfig.optimizerEnabled !== false;
  document.getElementById('check-launch-startup').checked = currentConfig.launchAtStartup !== false;
  document.getElementById('check-autocopy').checked = currentConfig.autoCopy !== false;
  document.getElementById('check-memory-rag').checked = currentConfig.memoryRagEnabled !== false;
  document.getElementById('check-cross-workspace-memory').checked = currentConfig.crossWorkspaceMemoryEnabled === true;
  document.getElementById('check-auto-learn').checked = currentConfig.autoLearnFromContext !== false;
  document.getElementById('check-project-context').checked = currentConfig.includeProjectContext !== false;
  document.getElementById('check-git-diff').checked = currentConfig.includeGitDiff !== false;
  document.getElementById('check-prompt-history').checked = currentConfig.includePromptHistory === true;
  document.getElementById('check-cross-workspace-history').checked = currentConfig.crossWorkspaceHistoryEnabled === true;
  document.getElementById('btn-optimize').disabled = currentConfig.optimizerEnabled === false;
  document.getElementById('btn-suggest').disabled = currentConfig.optimizerEnabled === false || currentConfig.promptAutopilotEnabled === false;
  renderProjects();
  renderContextScope();
  refreshMemoryStats();
  refreshProductInsights();

  document.querySelectorAll('.ide-card').forEach(card => card.classList.remove('selected'));
  if (currentConfig.selectedIDE && currentConfig.selectedIDE !== 'none') {
    const card = document.querySelector(`.ide-card[data-ide="${currentConfig.selectedIDE}"]`);
    if (card) card.classList.add('selected');
  }
}

function applyOptimizerState(state) {
  shortcutState = state;
  currentConfig.optimizerEnabled = state.enabled;
  if (state.hotkeys?.toggle) currentConfig.toggleHotkey = state.hotkeys.toggle;
  const checkbox = document.getElementById('check-optimizer-enabled');
  const hotkey = document.getElementById('input-toggle-hotkey');
  if (checkbox) checkbox.checked = state.enabled;
  if (hotkey && state.hotkeys?.toggle) hotkey.value = state.hotkeys.toggle;
  if (!state.enabled) setLoading(false);
  document.getElementById('btn-optimize').disabled = !state.enabled;
  document.getElementById('btn-suggest').disabled = !state.enabled || currentConfig.promptAutopilotEnabled === false;
  updateStatusDot();
}

function renderProjects() {
  const select = document.getElementById('select-project');
  const projects = Array.isArray(currentConfig.projects) ? currentConfig.projects : [];
  select.innerHTML = '';

  if (!projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No recent projects';
    select.appendChild(option);
    return;
  }

  projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.path;
    option.textContent = project.name || project.path;
    option.selected = project.path === currentConfig.projectRoot;
    select.appendChild(option);
  });
}

function renderContextScope() {
  const el = document.getElementById('last-context-scope');
  const bindButton = document.getElementById('btn-bind-project-scope');
  const unbindButton = document.getElementById('btn-unbind-project-scope');
  const scope = currentConfig.lastContextScope;
  const binding = scope?.id ? currentConfig.workspaceProjectBindings?.[scope.id] : '';
  if (!scope?.id) {
    el.textContent = 'No external workspace detected yet.';
    bindButton.disabled = true;
    unbindButton.disabled = true;
    return;
  }
  el.textContent = `${scope.label || scope.id}\n${binding ? `Bound project: ${binding}` : 'Project binding: none'}`;
  bindButton.disabled = !currentConfig.projectRoot;
  unbindButton.disabled = !binding;
}

function setStatusText(message) {
  const text = document.getElementById('status-text');
  if (message) text.textContent = message;
}

function buildConversationContext() {
  return document.getElementById('input-context')?.value.trim() || '';
}

async function handleOptimize() {
  if (currentConfig.optimizerEnabled === false) {
    showToast(`Optimizer is paused. Press ${currentConfig.toggleHotkey || 'Ctrl+Alt+F10'} to enable it.`, 'warning');
    return;
  }
  const text = document.getElementById('input-prompt').value.trim();
  if (!text) {
    showToast('Enter a prompt first.', 'warning');
    return;
  }

  setLoading(true);
  const result = await window.api.refineText(text);
  setLoading(false);

  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  if (result.refined) {
    showResult(result.refined);
    replacePromptInput(result.refined);
    currentConfig = await window.api.getConfig();
    if (result.rag) {
      setStatusText(`RAG ${result.rag.retrievalGrade} (${Math.round((result.rag.retrievalConfidence || 0) * 100)}%) - ${result.rag.retrievedChunks} memory chunks`);
    }
    if (currentConfig.autoCopy) {
      await window.api.setClipboard(result.refined);
      showToast('Optimized and copied!', 'success');
    }
  }
}

async function handleOptimizeWithContext() {
  if (currentConfig.promptAutopilotEnabled !== false) {
    return handleGenerateSuggestions();
  }
  if (currentConfig.optimizerEnabled === false) {
    showToast(`Optimizer is paused. Press ${currentConfig.toggleHotkey || 'Ctrl+Alt+F10'} to enable it.`, 'warning');
    return;
  }
  const text = document.getElementById('input-prompt').value.trim();
  if (!text) {
    showToast('Enter a prompt first.', 'warning');
    return;
  }

  setLoading(true, 'Using context...');
  const result = await window.api.refineText(text, buildConversationContext(), {
    forceContext: true,
    promptPurpose: currentConfig.promptPurpose || 'auto',
    refinementStyle: currentConfig.refinementStyle || 'pro'
  });
  setLoading(false);

  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  if (result.refined) {
    showResult(result.refined);
    replacePromptInput(result.refined);
    currentConfig = await window.api.getConfig();
    if (currentConfig.autoCopy) {
      await window.api.setClipboard(result.refined);
      showToast('Context-aware prompt copied!', 'success');
    } else {
      showToast('Context-aware prompt ready.', 'success');
    }
  }
}

async function handleGenerateSuggestions() {
  if (currentConfig.optimizerEnabled === false) {
    showToast(`Optimizer is paused. Press ${currentConfig.toggleHotkey || 'Ctrl+Alt+F10'} to enable it.`, 'warning');
    return;
  }
  if (currentConfig.promptAutopilotEnabled === false) {
    showToast('Prompt Autopilot is disabled in Settings.', 'warning');
    return;
  }
  const text = document.getElementById('input-prompt').value.trim();
  if (!text) {
    showToast('Enter a prompt first.', 'warning');
    return;
  }

  setLoading(true, 'Generating suggestions...', 'suggest');
  const result = await window.api.generatePromptSuggestions(text, buildConversationContext(), {
    promptPurpose: currentConfig.promptPurpose || 'auto',
    refinementStyle: currentConfig.refinementStyle || 'pro'
  });
  setLoading(false);

  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  renderPromptSuggestions(result);
  const grade = result.rag?.retrievalGrade || 'live context';
  setStatusText(`Autopilot ranked ${result.suggestions.length} candidates - RAG ${grade}`);
  await refreshProductInsights();
}

function renderPromptSuggestions(result) {
  currentAutopilotSessionId = result.sessionId;
  const section = document.getElementById('suggestions-section');
  const list = document.getElementById('suggestions-list');
  const summary = document.getElementById('suggestions-summary');
  const model = document.getElementById('suggestions-model');
  list.replaceChildren();

  const threshold = Math.round((result.pipeline?.qualityThreshold || currentConfig.promptAutopilotQualityThreshold || 0.78) * 100);
  summary.textContent = `${result.suggestions.length} candidates, ${threshold}% quality gate`;
  model.textContent = result.cacheHit ? 'Cached' : (result.model || 'AI ranked');

  result.suggestions.forEach((suggestion, index) => {
    const card = document.createElement('article');
    card.className = `suggestion-card${index === 0 ? ' best' : ''}`;
    card.dataset.suggestionId = suggestion.id;

    const titleRow = document.createElement('div');
    titleRow.className = 'suggestion-title-row';
    const title = document.createElement('div');
    title.className = 'suggestion-title';
    title.textContent = `${index === 0 ? 'Best: ' : ''}${suggestion.title}`;
    const score = document.createElement('span');
    score.className = 'quality-badge';
    score.textContent = `${Math.round((suggestion.qualityScore || 0) * 100)}%`;
    titleRow.append(title, score);

    const strategy = document.createElement('div');
    strategy.className = 'suggestion-strategy';
    strategy.textContent = suggestion.strategy;
    const prompt = document.createElement('div');
    prompt.className = 'suggestion-prompt';
    prompt.textContent = suggestion.prompt;

    const actions = document.createElement('div');
    actions.className = 'suggestion-actions';
    const useButton = document.createElement('button');
    useButton.className = 'btn small';
    useButton.textContent = 'Use Prompt';
    useButton.addEventListener('click', () => acceptPromptSuggestion(suggestion.id, false));
    const sendButton = document.createElement('button');
    sendButton.className = 'btn small';
    sendButton.textContent = 'Send to IDE';
    sendButton.disabled = !currentConfig.selectedIDE || currentConfig.selectedIDE === 'none';
    sendButton.addEventListener('click', () => acceptPromptSuggestion(suggestion.id, true));
    actions.append(useButton, sendButton);

    card.append(titleRow, strategy, prompt, actions);
    list.appendChild(card);
  });
  section.classList.remove('hidden');
}

async function acceptPromptSuggestion(suggestionId, sendToIDE) {
  if (!currentAutopilotSessionId) {
    showToast('Generate fresh suggestions first.', 'warning');
    return;
  }
  if (sendToIDE && (!currentConfig.selectedIDE || currentConfig.selectedIDE === 'none')) {
    showToast('Select an IDE first.', 'warning');
    return;
  }

  setLoading(true, sendToIDE ? 'Sending to IDE...' : 'Applying prompt...', 'suggest');
  const result = await window.api.acceptPromptSuggestion(currentAutopilotSessionId, suggestionId, {
    copy: true,
    sendToIDE
  });
  setLoading(false);
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  showResult(result.suggestion.prompt);
  replacePromptInput(result.suggestion.prompt);
  document.querySelectorAll('.suggestion-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.suggestionId === suggestionId);
  });
  currentConfig = await window.api.getConfig();
  await refreshProductInsights();
  showToast(result.ide?.success ? `Prompt sent to ${result.ide.ide}.` : 'Prompt selected and copied.', 'success');
}

async function handlePasteFromClipboard() {
  const text = await window.api.getClipboard();
  if (text) {
    document.getElementById('input-prompt').value = text;
    updatePromptCharacterCount();
    showToast('Pasted from clipboard.', 'info');
  } else {
    showToast('Clipboard is empty.', 'warning');
  }
}

async function handlePreviewContext() {
  setStatusText('Building context preview...');
  const manualContext = document.getElementById('input-context')?.value.trim() || '';
  const result = await window.api.getContextPreview(manualContext);
  const box = document.getElementById('context-preview-box');
  const content = document.getElementById('context-preview-content');
  const last = result.stats?.lastPipeline;
  const pipeline = last
    ? `Scope: ${last.contextScope?.label || last.scopeId || 'unscoped'}\nProject: ${last.projectRootUsed || 'none'} (${last.projectSelectionReason || 'not selected'})\nPipeline: ${last.intent} | ${last.retrievalMode} | grade ${last.retrievalGrade} (${Math.round((last.retrievalConfidence || 0) * 100)}%) | ${last.retrievedChunks} chunks\n`
    : '';
  const stats = result.stats ? `Memory index: ${result.stats.documents} docs, ${result.stats.chunks} chunks, ${formatNumber(result.stats.chars)} chars\n${pipeline}` : '';
  content.textContent = `${stats}Total context: ${formatNumber(result.length)} characters\n\n${result.preview || 'No context available.'}`;
  box.classList.remove('hidden');
  updateStatusDot();
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function updateQualityThresholdLabel() {
  const range = document.getElementById('range-quality-threshold');
  const output = document.getElementById('quality-threshold-value');
  if (range && output) output.textContent = `${range.value}%`;
}

async function refreshProductInsights() {
  const el = document.getElementById('product-metrics');
  const optimizationMetric = document.getElementById('main-metric-optimizations');
  const acceptanceMetric = document.getElementById('main-metric-acceptance');
  const timeMetric = document.getElementById('main-metric-time');
  if (!window.api.getProductInsights) return;
  if (currentConfig.localUsageMetricsEnabled === false) {
    if (el) el.textContent = 'Local usage counters are disabled.';
    if (optimizationMetric) optimizationMetric.textContent = '—';
    if (acceptanceMetric) acceptanceMetric.textContent = '—';
    if (timeMetric) timeMetric.textContent = '—';
    return;
  }
  const insights = await window.api.getProductInsights();
  const metrics = insights.metrics || {};
  const estimatedMinutesSaved = (Number(metrics.totalOptimizations) || 0) * 3;
  const acceptanceRate = Math.round((Number(metrics.suggestionAcceptanceRate) || 0) * 100);
  if (el) el.textContent = `Optimizations: ${formatNumber(metrics.totalOptimizations)} | Autopilot sessions: ${formatNumber(metrics.autopilotSessions)}\nAccepted suggestions: ${formatNumber(metrics.suggestionsAccepted)} (${acceptanceRate}%) | IDE handoffs: ${formatNumber(metrics.ideHandoffs)}\nActive days (30d): ${formatNumber(metrics.activeDays30)} | Estimated time saved: ${formatNumber(estimatedMinutesSaved)} min`;
  if (optimizationMetric) optimizationMetric.textContent = formatNumber(metrics.totalOptimizations);
  if (acceptanceMetric) acceptanceMetric.textContent = `${acceptanceRate}%`;
  if (timeMetric) timeMetric.textContent = estimatedMinutesSaved >= 60
    ? `${(estimatedMinutesSaved / 60).toFixed(1)}h`
    : `${estimatedMinutesSaved}m`;
}

async function refreshMemoryStats() {
  const el = document.getElementById('memory-stats');
  if (!el || !window.api.getMemoryStats) return;
  const stats = await window.api.getMemoryStats();
  const updated = stats.updatedAt ? new Date(stats.updatedAt).toLocaleString() : 'never';
  const cache = stats.cache ? `${stats.cache.entries} cached stages, ${stats.cache.hits} hits` : 'cache unavailable';
  const rag = stats.lastPipeline
    ? `\nLast scope: ${stats.lastPipeline.contextScope?.label || stats.lastPipeline.scopeId || 'unscoped'}\nLast RAG: ${stats.lastPipeline.intent}, ${stats.lastPipeline.retrievalGrade} (${Math.round((stats.lastPipeline.retrievalConfidence || 0) * 100)}%), ${stats.lastPipeline.retrievedChunks} chunks, ${stats.lastPipeline.hydeSource}`
    : '\nLast RAG: waiting for Ctrl+Alt+Space';
  el.textContent = `Memory: ${stats.documents} docs, ${stats.chunks} chunks, ${formatNumber(stats.chars)} chars\nCache: ${cache}${rag}\nUpdated: ${updated}`;
}

async function handleClearMemory() {
  const stats = await window.api.clearMemory();
  const el = document.getElementById('memory-stats');
  if (el) {
    el.textContent = `Memory: ${stats.documents} docs, ${stats.chunks} chunks, ${formatNumber(stats.chars)} chars\nCache: cleared\nLast RAG: waiting for Ctrl+Alt+Space`;
  }
  showToast('Memory cleared.', 'success');
}

async function handleBrowseProject() {
  currentConfig = await window.api.chooseProjectFolder();
  if (currentConfig.error) {
    showToast(currentConfig.error, 'error');
    return;
  }
  applyConfig();
  showToast('Project selected.', 'success');
}

async function handleSelectProject(event) {
  const projectRoot = event.target.value;
  if (!projectRoot) return;
  const result = await window.api.setProjectRoot(projectRoot);
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  currentConfig = result;
  applyConfig();
  showToast('Project activated.', 'success');
}

async function handleBindProjectScope() {
  const result = await window.api.bindProjectToLastContext();
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  currentConfig = result;
  applyConfig();
  showToast('Project bound to detected workspace.', 'success');
}

async function handleUnbindProjectScope() {
  const result = await window.api.unbindProjectFromLastContext();
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  currentConfig = result;
  applyConfig();
  showToast('Workspace binding removed.', 'success');
}

async function handleCopyResult() {
  const result = document.getElementById('result-content').textContent;
  if (result) {
    await window.api.setClipboard(result);
    showToast('Copied to clipboard!', 'success');
  }
}

function showResult(text) {
  const box = document.getElementById('result-box');
  const content = document.getElementById('result-content');
  content.textContent = text;
  box.classList.remove('hidden');
}

function replacePromptInput(text) {
  const input = document.getElementById('input-prompt');
  input.value = text;
  updatePromptCharacterCount();
  input.focus();
  input.select();
}

function setLoading(loading, label = 'Optimizing...', target = loadingTarget) {
  const optimizeButton = document.getElementById('btn-optimize');
  const suggestionButton = document.getElementById('btn-suggest');
  if (loading) {
    loadingTarget = target || 'optimize';
    optimizeButton.disabled = true;
    suggestionButton.disabled = true;
    const activeButton = loadingTarget === 'suggest' ? suggestionButton : optimizeButton;
    activeButton.innerHTML = `<span class="loading-spinner"></span> ${label || 'Working...'}`;
  } else {
    loadingTarget = 'optimize';
    optimizeButton.disabled = currentConfig.optimizerEnabled === false;
    suggestionButton.disabled = currentConfig.optimizerEnabled === false || currentConfig.promptAutopilotEnabled === false;
    optimizeButton.textContent = 'Optimize';
    suggestionButton.textContent = 'AI Suggestions';
  }
}

async function handleSaveSettings() {
  const apiKey = document.getElementById('input-apikey').value.trim();
  const mode = document.getElementById('select-mode').value;
  const promptPurpose = document.getElementById('select-purpose').value;
  const refinementStyle = document.getElementById('select-style').value;
  const promptAutopilotEnabled = document.getElementById('check-prompt-autopilot').checked;
  const promptSuggestionCount = Number(document.getElementById('select-suggestion-count').value);
  const promptAutopilotQualityThreshold = Number(document.getElementById('range-quality-threshold').value) / 100;
  const projectRoot = document.getElementById('input-project-root').value.trim();
  const projectContextPolicy = document.getElementById('select-project-policy').value;
  const optimizerEnabled = document.getElementById('check-optimizer-enabled').checked;
  const autoCopy = document.getElementById('check-autocopy').checked;
  const autoSendToIDE = document.getElementById('check-auto-send-ide').checked;
  const localUsageMetricsEnabled = document.getElementById('check-local-metrics').checked;
  const launchAtStartup = document.getElementById('check-launch-startup').checked;
  const memoryRagEnabled = document.getElementById('check-memory-rag').checked;
  const crossWorkspaceMemoryEnabled = document.getElementById('check-cross-workspace-memory').checked;
  const autoLearnFromContext = document.getElementById('check-auto-learn').checked;
  const includeProjectContext = document.getElementById('check-project-context').checked;
  const includeGitDiff = document.getElementById('check-git-diff').checked;
  const includePromptHistory = document.getElementById('check-prompt-history').checked;
  const crossWorkspaceHistoryEnabled = document.getElementById('check-cross-workspace-history').checked;

  const updates = {
    mode,
    promptPurpose,
    refinementStyle,
    promptAutopilotEnabled,
    promptSuggestionCount,
    promptAutopilotQualityThreshold,
    projectContextPolicy,
    optimizerEnabled,
    autoCopy,
    autoSendToIDE,
    localUsageMetricsEnabled,
    launchAtStartup,
    memoryRagEnabled,
    crossWorkspaceMemoryEnabled,
    autoLearnFromContext,
    includeProjectContext,
    includeGitDiff,
    includePromptHistory,
    crossWorkspaceHistoryEnabled
  };

  if (apiKey) {
    if (!apiKey.startsWith('gsk_')) {
      showSettingsStatus('Key should start with "gsk_"', 'error');
      return;
    }
    const valid = await window.api.verifyKey(apiKey);
    if (!valid) {
      showSettingsStatus('Invalid key. Check console.groq.com', 'error');
      return;
    }
    updates.apiKey = apiKey;
  }

  if (projectRoot && projectRoot !== currentConfig.projectRoot) {
    const result = await window.api.setProjectRoot(projectRoot);
    if (result.error) {
      showSettingsStatus(result.error, 'error');
      return;
    }
    currentConfig = result;
  }

  currentConfig = await window.api.saveConfig(updates);
  updateStatusDot();
  applyConfig();
  showSettingsStatus(apiKey ? 'API key verified and saved securely.' : 'Settings saved. Existing API key kept.', 'success');
  document.getElementById('input-apikey').value = '';
}

function showSettingsStatus(msg, type) {
  const el = document.getElementById('settings-status');
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  setTimeout(() => { el.className = 'status-msg hidden'; }, 4000);
}

function toggleKeyVisibility() {
  const input = document.getElementById('input-apikey');
  const icon = document.getElementById('eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = '&#128064;';
  } else {
    input.type = 'password';
    icon.innerHTML = '&#128065;';
  }
}

function selectIDE(ide) {
  document.querySelectorAll('.ide-card').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`.ide-card[data-ide="${ide}"]`);
  if (card) card.classList.add('selected');

  currentConfig.selectedIDE = ide;
  window.api.saveConfig({ selectedIDE: ide });
  document.querySelectorAll('.suggestion-actions .btn:last-child').forEach((button) => {
    button.disabled = false;
  });

  const status = document.getElementById('ide-status');
  status.textContent = `Selected: ${ide.charAt(0).toUpperCase() + ide.slice(1)}`;
  status.className = 'status-msg info';
  setTimeout(() => { status.className = 'status-msg hidden'; }, 3000);
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast hidden'; }, 3500);
}
