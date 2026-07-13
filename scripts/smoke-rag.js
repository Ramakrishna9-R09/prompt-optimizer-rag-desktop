'use strict';

const { prepareRagContext } = require('../core/rag-pipeline');
const { generateHydeQueries, refinePrompt } = require('../core/groq-client');

async function main() {
  const rawPrompt = 'Use the above architecture in Ctrl+Alt+Space and make it understand what I am building.';
  const activeWindowContext = `We are building Prompt Optimizer, an Electron desktop app. Ctrl+Shift+Space is the normal no-memory LLM optimizer. Ctrl+Alt+Space is the context-aware mode that must read the current chat, retrieve relevant local memory, include current project state, generate a grounded high-level prompt, and paste it into the active textbox.`;
  const projectContext = `FILE: gui/main.js\nThe Electron global shortcut invokes the advanced RAG pipeline.\nFILE: core/rag-pipeline.js\nThe pipeline routes intent, expands retrieval queries, grades memory, and builds bounded context.`;

  const prepared = await prepareRagContext({
    rawPrompt,
    activeWindowContext,
    projectContext,
    purpose: 'feature',
    hydeGenerator: generateHydeQueries
  });
  const result = await refinePrompt(rawPrompt, prepared.context, {
    forceContext: true,
    promptPurpose: 'feature',
    refinementStyle: 'pro'
  });

  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify({
    retrieval: prepared.diagnostics,
    generation: {
      model: result.model,
      outputChars: result.refined.length,
      cacheHit: result.cacheHit,
      pipeline: result.pipeline,
      startsWith: result.refined.slice(0, 80)
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
