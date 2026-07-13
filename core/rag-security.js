'use strict';

const { redactSensitiveContent, tokenize } = require('./memory-store');

const INJECTION_PATTERNS = [
  { id: 'ignore-instructions', pattern: /ignore\s+(all\s+)?(previous|prior|system|developer)(\s+(system|developer))?\s+instructions?/i },
  { id: 'reveal-system-prompt', pattern: /(reveal|print|show|repeat|leak)\s+(the\s+)?(system|developer)\s+(prompt|message|instructions?)/i },
  { id: 'instruction-override', pattern: /(new|replacement|override)\s+(system|developer)\s+(prompt|instructions?)/i },
  { id: 'secret-exfiltration', pattern: /(reveal|print|send|upload|exfiltrate).{0,40}(api\s*key|token|password|secret|credential)/i },
  { id: 'tool-abuse', pattern: /(run|execute).{0,30}(without|bypass).{0,30}(permission|approval|confirmation)/i }
];

function cleanControlCharacters(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function sanitizeInput(value, { maxChars = 9000, keep = 'end' } = {}) {
  const original = cleanControlCharacters(value).replace(/\r/g, '').trim();
  const redacted = redactSensitiveContent(original);
  let text = redacted;
  let truncated = false;

  if (text.length > maxChars) {
    truncated = true;
    text = keep === 'start' ? text.slice(0, maxChars) : text.slice(-maxChars);
  }

  return {
    text,
    originalChars: original.length,
    chars: text.length,
    truncated,
    redacted: redacted !== original
  };
}

function scanPromptInjection(value) {
  const text = String(value || '');
  const flags = INJECTION_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ id }) => id);

  return {
    flags,
    risk: flags.length >= 2 ? 'high' : flags.length === 1 ? 'medium' : 'low'
  };
}

function wrapUntrustedContext(label, value, metadata = {}) {
  if (!value) return '';
  const attributes = Object.entries(metadata)
    .filter(([, item]) => item !== undefined && item !== null && item !== '')
    .map(([key, item]) => `${key}="${String(item).replace(/["<>]/g, '')}"`)
    .join(' ');
  const open = attributes ? `<evidence type="${label}" ${attributes}>` : `<evidence type="${label}">`;
  return `${open}\n${value}\n</evidence>`;
}

function gradeRefinedPrompt(rawPrompt, refinedPrompt, context = '') {
  const rawTokens = Array.from(new Set(tokenize(rawPrompt))).slice(0, 24);
  const outputTokens = new Set(tokenize(refinedPrompt));
  const contextTokens = Array.from(new Set(tokenize(context))).slice(0, 40);
  const output = String(refinedPrompt || '').trim();
  const issues = [];
  let score = 0;

  if (output.length >= 80 && output.length <= 5000) score += 0.2;
  else issues.push('Output length is outside the useful prompt range.');

  if (/^(implement|debug|fix|improve|refactor|review|write|create|analyze|investigate|design|build|update|add|remove|explain|optimize)\b/i.test(output)) {
    score += 0.15;
  } else {
    issues.push('Start with a direct action verb.');
  }

  const rawCoverage = rawTokens.length
    ? rawTokens.filter((token) => outputTokens.has(token)).length / rawTokens.length
    : 1;
  score += Math.min(0.25, rawCoverage * 0.32);
  if (rawCoverage < 0.45) issues.push('Preserve more of the user\'s concrete intent and terminology.');

  const contextCoverage = contextTokens.length
    ? contextTokens.filter((token) => outputTokens.has(token)).length / contextTokens.length
    : 1;
  score += Math.min(0.15, contextCoverage * 0.45);
  if (contextTokens.length && contextCoverage < 0.12) issues.push('Ground the prompt in the supplied project or conversation context.');

  if (/\b(test|verify|validation|acceptance criteria|expected behavior|success criteria|reproduce|edge cases?)\b/i.test(output)) {
    score += 0.15;
  } else {
    issues.push('Add a concrete validation or success criterion.');
  }

  if (!/^(here('s| is)|refined prompt|sure[,!:]|certainly[,!:])/i.test(output)) score += 0.1;
  else issues.push('Remove conversational preamble.');

  return {
    score: Number(Math.min(1, score).toFixed(3)),
    rawCoverage: Number(rawCoverage.toFixed(3)),
    contextCoverage: Number(contextCoverage.toFixed(3)),
    issues
  };
}

function validateRefinedOutput(value) {
  const output = cleanControlCharacters(value).trim();
  if (!output) return { valid: false, error: 'The model returned an empty prompt.' };
  if (output.length > 6000) return { valid: false, error: 'The optimized prompt exceeded the output limit.' };

  const redacted = redactSensitiveContent(output)
    .replace(/^(here('s| is) (the |a )?(refined|improved|updated) prompt:?\s*)/i, '')
    .replace(/^(refined prompt:?\s*)/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  return {
    valid: Boolean(redacted),
    value: redacted,
    redacted: redacted !== output
  };
}

module.exports = {
  sanitizeInput,
  scanPromptInjection,
  wrapUntrustedContext,
  gradeRefinedPrompt,
  validateRefinedOutput
};
