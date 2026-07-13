'use strict';

const { spawn, exec } = require('child_process');
const { loadConfig, saveConfig } = require('../../core/config');

function isCodexInstalled() {
  return new Promise((resolve) => {
    exec('codex --version', (err, stdout) => {
      resolve(!err && stdout.includes('codex'));
    });
  });
}

async function runCodexHeadless(prompt) {
  const installed = await isCodexInstalled();
  if (!installed) {
    return { error: 'Codex CLI not found. Install with: npm install -g @openai/codex' };
  }

  return new Promise((resolve) => {
    const child = spawn('codex', ['--headless', prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => {
      resolve({ error: `Failed to run Codex: ${err.message}` });
    });

    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        resolve({ error: `Codex exited with code ${code}: ${stderr}` });
      } else {
        resolve({ response: stdout.trim() || 'Codex completed with no output.' });
      }
    });

    setTimeout(() => {
      child.kill();
      resolve({ error: 'Codex timed out after 60 seconds.' });
    }, 60000);
  });
}

async function injectToCodex(prompt) {
  const config = loadConfig();
  config.lastCodexPrompt = prompt;
  saveConfig(config);

  return runCodexHeadless(prompt);
}

module.exports = {
  isCodexInstalled,
  runCodexHeadless,
  injectToCodex
};
