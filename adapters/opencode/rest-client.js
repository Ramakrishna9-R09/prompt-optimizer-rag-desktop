'use strict';

const http = require('http');

const BASE_URL = 'http://localhost:4096';

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (postData) req.write(postData);
    req.end();
  });
}

async function getSessions() {
  return request('GET', '/api/sessions');
}

async function createSession(name) {
  return request('POST', '/api/sessions', { name });
}

async function sendPrompt(sessionId, prompt) {
  return request('POST', `/api/sessions/${sessionId}/prompt`, { content: prompt });
}

async function getSessionOutput(sessionId) {
  return request('GET', `/api/sessions/${sessionId}/output`);
}

async function healthCheck() {
  return request('GET', '/health');
}

module.exports = {
  getSessions,
  createSession,
  sendPrompt,
  getSessionOutput,
  healthCheck
};
