'use strict';

const { spawn } = require('child_process');
const http = require('http');
const { loadConfig, saveConfig } = require('../../core/config');

let opencodeProcess = null;
let serverPort = 4096;

async function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${serverPort}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  const running = await isServerRunning();
  if (running) return true;

  return new Promise((resolve) => {
    opencodeProcess = spawn('opencode', ['serve', '--port', String(serverPort)], {
      stdio: 'ignore',
      detached: true
    });

    opencodeProcess.on('error', () => resolve(false));
    opencodeProcess.unref();

    setTimeout(async () => {
      const ok = await isServerRunning();
      resolve(ok);
    }, 3000);
  });
}

async function sendPrompt(prompt, sessionName) {
  const running = await isServerRunning();
  if (!running) {
    const started = await startServer();
    if (!started) return { error: 'Could not start OpenCode server. Is opencode installed?' };
  }

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      prompt: prompt,
      session: sessionName || `optimizer-${Date.now()}`
    });

    const req = http.request({
      hostname: 'localhost',
      port: serverPort,
      path: '/api/prompt',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ success: true, response: data.response || data.output || body });
        } catch {
          resolve({ success: true, response: body });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `OpenCode connection failed: ${err.message}` });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: 'OpenCode request timed out.' });
    });

    req.write(postData);
    req.end();
  });
}

async function injectPrompt(prompt) {
  const config = loadConfig();
  config.lastOpenCodePrompt = prompt;
  saveConfig(config);

  return sendPrompt(prompt, 'prompt-optimizer');
}

function stopServer() {
  if (opencodeProcess) {
    opencodeProcess.kill();
    opencodeProcess = null;
  }
}

module.exports = {
  isServerRunning,
  startServer,
  sendPrompt,
  injectPrompt,
  stopServer
};
