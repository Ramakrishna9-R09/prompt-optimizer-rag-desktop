'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const AGENT_SCRIPT = path.join(__dirname, 'agent-integration.py');

function getPythonCommand() {
  const candidates = ['python3', 'python', 'py'];
  for (const cmd of candidates) {
    try {
      require('child_process').execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  return 'python3';
}

async function checkSDKInstalled() {
  const python = getPythonCommand();
  return new Promise((resolve) => {
    exec(`${python} -c "import google.antigravity"`, (err) => {
      resolve(!err);
    });
  });
}

async function runAgent(prompt, config) {
  const python = getPythonCommand();

  const scriptContent = `
import json
import sys

try:
    from google.antigravity import Agent, LocalAgentConfig
    HAS_SDK = True
except ImportError:
    HAS_SDK = False

prompt = sys.argv[1] if len(sys.argv) > 1 else ""
mode = sys.argv[2] if len(sys.argv) > 2 else "general"

if not HAS_SDK:
    print(json.dumps({"error": "google-antigravity SDK not installed. Run: pip install google-antigravity"}))
    sys.exit(0)

try:
    config = LocalAgentConfig()
    agent = Agent(config)
    result = agent.chat(prompt)
    print(json.dumps({"response": str(result)}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

  fs.writeFileSync(AGENT_SCRIPT, scriptContent, 'utf-8');

  return new Promise((resolve) => {
    const child = spawn(python, [AGENT_SCRIPT, prompt, config?.mode || 'general'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => {
      resolve({ error: `Failed to run Python: ${err.message}` });
    });

    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        if (stderr) {
          resolve({ error: `Antigravity error: ${stderr}` });
        } else {
          resolve({ response: stdout.trim() || 'No output from Antigravity.' });
        }
      }
    });

    setTimeout(() => {
      child.kill();
      resolve({ error: 'Antigravity agent timed out after 30 seconds.' });
    }, 30000);
  });
}

function exec(cmd) {
  return require('child_process').execSync;
}

module.exports = {
  checkSDKInstalled,
  runAgent,
  getPythonCommand
};
