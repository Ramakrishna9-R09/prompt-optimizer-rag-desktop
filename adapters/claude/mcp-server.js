'use strict';

const { refinePrompt } = require('../../core/groq-client');
const readline = require('readline');

const SERVER_INFO = {
  name: 'prompt-optimizer',
  version: '1.0.0'
};

const TOOLS = [
  {
    name: 'optimize_prompt',
    description: 'Optimize a rough prompt into a precise, well-structured prompt for better AI responses. Supports general, context-aware, and code-specific modes.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The rough prompt to optimize'
        },
        context: {
          type: 'string',
          description: 'Optional conversation context for context-aware optimization'
        },
        mode: {
          type: 'string',
          enum: ['general', 'context', 'code'],
          description: 'Optimization mode: general (default), context (uses conversation history), or code (code-specific prompts)'
        }
      },
      required: ['text']
    }
  }
];

async function handleRequest(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    };
  }

  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (request.method === 'tools/list') {
    return { tools: TOOLS };
  }

  if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params;

    if (name === 'optimize_prompt') {
      const result = await refinePrompt(args.text, args.context);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: result.refined }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  return null;
}

async function startMCPServer() {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await handleRequest(request);
      if (response !== null) {
        const jsonrpc = {
          jsonrpc: '2.0',
          id: request.id,
          result: response
        };
        process.stdout.write(JSON.stringify(jsonrpc) + '\n');
      }
    } catch (err) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err.message }
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => process.exit(0));

  process.stderr.write('[Prompt Optimizer MCP] Server started\n');
}

if (require.main === module) {
  startMCPServer();
}

module.exports = { startMCPServer, handleRequest, TOOLS };
