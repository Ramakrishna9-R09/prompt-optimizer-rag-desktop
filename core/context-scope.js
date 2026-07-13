'use strict';

const GENERIC_LABELS = new Set([
  'add context', 'close', 'conversation history', 'file', 'go back', 'go forward',
  'install ide', 'loading', 'maximize', 'message input', 'minimize', 'new conversation',
  'projects', 'record voice memo', 'scheduled tasks', 'select environment', 'send message',
  'settings', 'sidebar', 'toggle sidebar', 'typeahead menu', 'view', 'window'
]);

const APP_RULES = [
  ['antigravity', /\bantigravity\b/i, 'Antigravity'],
  ['prompt-optimizer', /\bprompt optimizer\b/i, 'Prompt Optimizer'],
  ['codex', /\bcodex(?:\.exe)?\b/i, 'Codex'],
  ['cursor', /\bcursor(?:\.exe)?\b/i, 'Cursor'],
  ['vscode', /\b(?:visual studio code|code\.exe)\b/i, 'VS Code'],
  ['claude', /\bclaude\b/i, 'Claude'],
  ['chatgpt', /\bchatgpt\b/i, 'ChatGPT'],
  ['edge', /\b(?:msedge|microsoft edge)\b/i, 'Microsoft Edge'],
  ['chrome', /\b(?:chrome|google chrome)\b/i, 'Google Chrome'],
  ['firefox', /\bfirefox\b/i, 'Firefox']
];

function normalizeLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value, fallback = 'unknown') {
  const slug = normalizeLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function detectApplication(metadata = {}) {
  const processName = normalizeLabel(metadata.processName);
  const executablePath = normalizeLabel(metadata.executablePath);
  const windowTitle = normalizeLabel(metadata.windowTitle);
  const haystack = `${processName} ${executablePath} ${windowTitle}`;
  const match = APP_RULES.find(([, pattern]) => pattern.test(haystack));
  if (match) return { appId: match[0], appLabel: match[2] };

  const fallback = processName || windowTitle || 'unknown-app';
  return {
    appId: slugify(fallback, 'unknown-app'),
    appLabel: normalizeLabel(windowTitle || processName || 'Unknown application').slice(0, 80)
  };
}

function isWorkspaceCandidate(value, appLabel = '') {
  const label = normalizeLabel(value);
  const lower = label.toLowerCase();
  if (label.length < 3 || label.length > 80) return false;
  if (label.split(/\s+/).length > 12) return false;
  if (GENERIC_LABELS.has(lower)) return false;
  if (lower === normalizeLabel(appLabel).toLowerCase()) return false;
  if (/^(active window|select model|select environment|prompt to optimize)\b/i.test(label)) return false;
  if (/^(https?:|[a-z]:\\)/i.test(label)) return false;
  if (/^\d+\s*(?:mo|m|h|d)$/i.test(label)) return false;
  return true;
}

function workspaceFromTitle(windowTitle, appLabel) {
  const title = normalizeLabel(windowTitle);
  if (!title || title.toLowerCase() === normalizeLabel(appLabel).toLowerCase()) return '';
  const parts = title
    .split(/\s+(?:-|\|)\s+/)
    .map(normalizeLabel)
    .filter((part) => isWorkspaceCandidate(part, appLabel));
  return parts[0] || '';
}

function extractWorkspaceLabel(metadata = {}, context = '', appLabel = '') {
  const nearby = Array.isArray(metadata.workspaceCandidates) ? metadata.workspaceCandidates : [];
  for (const item of nearby) {
    const value = typeof item === 'string' ? item : item?.name;
    if (isWorkspaceCandidate(value, appLabel)) return normalizeLabel(value);
  }

  const fromTitle = workspaceFromTitle(metadata.windowTitle, appLabel);
  if (fromTitle) return fromTitle;

  const lines = String(context || '').split(/\r?\n/).map(normalizeLabel).filter(Boolean);
  const inputIndex = lines.findIndex((line) => /^message input$/i.test(line));
  if (inputIndex > 0) {
    for (let index = inputIndex - 1; index >= Math.max(0, inputIndex - 12); index -= 1) {
      if (isWorkspaceCandidate(lines[index], appLabel)) return lines[index];
    }
  }
  return '';
}

function deriveContextScope(metadata = {}, context = '') {
  const application = detectApplication(metadata);
  const workspaceLabel = extractWorkspaceLabel(metadata, context, application.appLabel);
  const workspaceId = workspaceLabel ? slugify(workspaceLabel) : '';
  return {
    id: workspaceId
      ? `app:${application.appId}:workspace:${workspaceId}`
      : `app:${application.appId}`,
    appId: application.appId,
    appLabel: application.appLabel,
    workspaceLabel,
    label: workspaceLabel ? `${application.appLabel} / ${workspaceLabel}` : application.appLabel
  };
}

function contextMatchesProject(context, project) {
  const haystack = normalizeLabel(context).toLowerCase().replace(/[_-]+/g, ' ');
  const values = [project?.name, project?.path && String(project.path).split(/[\\/]/).filter(Boolean).pop()]
    .map((value) => normalizeLabel(value).toLowerCase().replace(/[_-]+/g, ' '))
    .filter((value) => value.length >= 3);
  return values.some((value) => haystack.includes(value));
}

module.exports = {
  deriveContextScope,
  detectApplication,
  extractWorkspaceLabel,
  contextMatchesProject,
  slugify
};
