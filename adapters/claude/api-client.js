'use strict';

const { getApiKey } = require('../../core/config');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function sendToClaude(prompt, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY || getApiKey();
  if (!apiKey) {
    return { error: 'No Anthropic API key found. Set ANTHROPIC_API_KEY or save in settings.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt || 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error?.message || `HTTP ${res.status}`;
      return { error: `Anthropic error: ${msg}` };
    }

    const data = await res.json();
    const content = data.content?.[0]?.text;
    return { response: content || 'Empty response from Claude.' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { error: 'Claude request timed out.' };
    }
    return { error: `Network error: ${err.message}` };
  }
}

module.exports = { sendToClaude };
