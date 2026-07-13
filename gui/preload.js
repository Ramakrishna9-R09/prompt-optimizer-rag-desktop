'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (updates) => ipcRenderer.invoke('save-config', updates),
  getShortcutState: () => ipcRenderer.invoke('get-shortcut-state'),
  setOptimizerEnabled: (enabled) => ipcRenderer.invoke('set-optimizer-enabled', enabled),
  chooseProjectFolder: () => ipcRenderer.invoke('choose-project-folder'),
  setProjectRoot: (projectRoot) => ipcRenderer.invoke('set-project-root', projectRoot),
  bindProjectToLastContext: () => ipcRenderer.invoke('bind-project-to-last-context'),
  unbindProjectFromLastContext: () => ipcRenderer.invoke('unbind-project-from-last-context'),

  verifyKey: (apiKey) => ipcRenderer.invoke('verify-key', apiKey),
  refineText: (text, context, options) => ipcRenderer.invoke('refine-text', text, context, options),
  generatePromptSuggestions: (text, context, options) => ipcRenderer.invoke('generate-prompt-suggestions', text, context, options),
  acceptPromptSuggestion: (sessionId, suggestionId, options) => ipcRenderer.invoke('accept-prompt-suggestion', sessionId, suggestionId, options),
  sendToIDE: (ide, prompt) => ipcRenderer.invoke('send-to-ide', ide, prompt),
  getProductInsights: () => ipcRenderer.invoke('get-product-insights'),
  optimizeClipboard: () => ipcRenderer.invoke('optimize-clipboard'),
  getContextPreview: (manualContext) => ipcRenderer.invoke('get-context-preview', manualContext),
  getMemoryStats: () => ipcRenderer.invoke('get-memory-stats'),
  clearMemory: () => ipcRenderer.invoke('clear-memory'),

  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  setClipboard: (text) => ipcRenderer.invoke('set-clipboard', text),

  minimize: () => ipcRenderer.invoke('minimize-window'),
  close: () => ipcRenderer.invoke('close-window'),
  quit: () => ipcRenderer.invoke('quit-app'),

  onNotification: (callback) => ipcRenderer.on('notification', (event, data) => callback(data)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, data) => callback(data)),
  onRefineStart: (callback) => ipcRenderer.on('refine-start', () => callback()),
  onRefineStop: (callback) => ipcRenderer.on('refine-stop', () => callback()),
  onRefineComplete: (callback) => ipcRenderer.on('refine-complete', (event, data) => callback(data)),
  onOptimizerStateChanged: (callback) => ipcRenderer.on('optimizer-state-changed', (event, data) => callback(data)),
  onOptimizeInputHotkey: (callback) => ipcRenderer.on('optimize-input-hotkey', () => callback()),
  onOptimizeInputWithContextHotkey: (callback) => ipcRenderer.on('optimize-input-with-context-hotkey', () => callback())
});
