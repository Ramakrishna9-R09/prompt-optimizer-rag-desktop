'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_CONFIG_DIR = path.join(os.homedir(), '.codex');
const CODEX_CONFIG_FILE = path.join(CODEX_CONFIG_DIR, 'config.toml');

function readCodexConfig() {
  try {
    if (fs.existsSync(CODEX_CONFIG_FILE)) {
      return fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
    }
  } catch (e) {
    console.error('[Codex Config] Read error:', e.message);
  }
  return '';
}

function writeCodexConfig(content) {
  if (!fs.existsSync(CODEX_CONFIG_DIR)) {
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CODEX_CONFIG_FILE, content, 'utf-8');
}

function addAgentInstructions(instructions) {
  const projectDir = process.cwd();
  const agentsFile = path.join(projectDir, 'AGENTS.md');

  let existing = '';
  try {
    if (fs.existsSync(agentsFile)) {
      existing = fs.readFileSync(agentsFile, 'utf-8');
    }
  } catch (e) {}

  const marker = '<!-- prompt-optimizer -->';
  const block = `${marker}\n${instructions}\n${marker}`;

  if (existing.includes(marker)) {
    const regex = new RegExp(`${marker}[\\s\\S]*?${marker}`, 'g');
    const updated = existing.replace(regex, block);
    fs.writeFileSync(agentsFile, updated, 'utf-8');
  } else {
    const separator = existing ? '\n\n' : '';
    fs.writeFileSync(agentsFile, existing + separator + block + '\n', 'utf-8');
  }

  return { success: true, file: agentsFile };
}

function removeAgentInstructions() {
  const projectDir = process.cwd();
  const agentsFile = path.join(projectDir, 'AGENTS.md');

  try {
    if (fs.existsSync(agentsFile)) {
      let content = fs.readFileSync(agentsFile, 'utf-8');
      const regex = /<!-- prompt-optimizer -->[\s\S]*?<!-- prompt-optimizer -->\n?/g;
      content = content.replace(regex, '').trim();
      if (content) {
        fs.writeFileSync(agentsFile, content + '\n', 'utf-8');
      } else {
        fs.unlinkSync(agentsFile);
      }
    }
  } catch (e) {}

  return { success: true };
}

module.exports = {
  readCodexConfig,
  writeCodexConfig,
  addAgentInstructions,
  removeAgentInstructions
};
