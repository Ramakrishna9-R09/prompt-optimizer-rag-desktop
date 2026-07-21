'use strict';

const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, Tray, Menu, nativeImage, dialog, shell, Notification } = require('electron');
const { execFile, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  CONFIG_DIR,
  loadConfig,
  saveConfig,
  appendPromptHistory,
  getProductMetrics,
  recordProductEvent,
  getRevenueProjection
} = require('../core/config');
const {
  refinePrompt,
  verifyApiKey,
  generateHydeQueries,
  generatePromptSuggestions
} = require('../core/groq-client');
const {
  addMemoryDocument,
  getMemoryStats,
  clearMemory
} = require('../core/memory-store');
const { prepareRagContext } = require('../core/rag-pipeline');
const { deriveContextScope, contextMatchesProject } = require('../core/context-scope');
const { getCacheStats, clearPipelineCache } = require('../core/pipeline-cache');
const { validateRefinedOutput } = require('../core/rag-security');
const { injectToCodex } = require('../adapters/codex/cli-wrapper');
const { runAgent: runAntigravity } = require('../adapters/antigravity/python-bridge');
const { sendToClaude } = require('../adapters/claude/api-client');
const { injectPrompt: injectToOpenCode } = require('../adapters/opencode/sdk-client');

let mainWindow = null;
let tray = null;
let isRefining = false;
let isCapturingInput = false;
let optimizerEnabled = loadConfig().optimizerEnabled !== false;
let lastToggleAt = 0;
let lastPipelineDiagnostics = null;
let debugLogChecked = false;
const startedHidden = process.argv.includes('--hidden');
const autopilotSessions = new Map();
const INTERNAL_CONTEXT_SCOPE = deriveContextScope({
  processName: 'Prompt Optimizer',
  windowTitle: 'Prompt Optimizer'
});

const SHORTCUTS = {
  optimize: {
    label: 'Ctrl+Shift+Space',
    accelerator: 'CommandOrControl+Shift+Space'
  },
  context: {
    label: 'Ctrl+Alt+Space',
    accelerator: 'CommandOrControl+Alt+Space'
  },
  toggle: {
    label: 'Ctrl+Alt+F10',
    accelerator: 'CommandOrControl+Alt+F10'
  }
};

const TOGGLE_DEBOUNCE_MS = 1800;

const CONTEXT_LIMITS = {
  activeWindowChars: 9000,
  memoryChars: 7000,
  projectChars: 9000,
  fileChars: 2200,
  gitStatusChars: 2500,
  gitDiffChars: 5000,
  historyChars: 1800,
  totalChars: 24000
};

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDebug(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const logPath = path.join(CONFIG_DIR, 'debug.log');
    if (!debugLogChecked) {
      debugLogChecked = true;
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
        const previousPath = path.join(CONFIG_DIR, 'debug.previous.log');
        if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
        fs.renameSync(logPath, previousPath);
      }
    }
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {
    // Logging should never block the optimizer.
  }
}

function applyLaunchAtStartup(enabled = loadConfig().launchAtStartup !== false) {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  if (!app.isPackaged) {
    logDebug('[Startup] Sign-in launch is applied only by the packaged application');
    return { supported: true, enabled: false, development: true };
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: ['--hidden']
    });
    const actual = app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] });
    logDebug(`[Startup] Windows sign-in launch ${actual.openAtLogin ? 'enabled' : 'disabled'}`);
    return { supported: true, enabled: actual.openAtLogin };
  } catch (error) {
    logDebug(`[Startup] Failed to update Windows sign-in launch: ${error.message}`);
    return { supported: true, enabled: false, error: error.message };
  }
}

process.on('uncaughtException', (error) => {
  logDebug(`[Crash] Uncaught exception: ${error?.stack || error?.message || String(error)}`);
});

process.on('unhandledRejection', (reason) => {
  logDebug(`[Crash] Unhandled rejection: ${reason?.stack || reason?.message || String(reason)}`);
});

function sendWindowsKeys(keys) {
  return new Promise((resolve, reject) => {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

async function getForegroundWindowHandle() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
[NativeMethods]::GetForegroundWindow().ToInt64()
`;
  return runPowerShell(script, 2000);
}

async function captureActiveInputFast() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FastCaptureNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@
$result = [ordered]@{ handle = [FastCaptureNative]::GetForegroundWindow().ToInt64(); text = ''; copied = $false }
try {
  foreach ($key in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) { [FastCaptureNative]::keybd_event($key, 0, 2, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    Start-Sleep -Milliseconds 55
    try { $result.text = [System.Windows.Forms.Clipboard]::GetText() } catch {}
    if ($result.text) { $result.copied = $true; break }
  }
} catch {}
$result | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, 3500);
  try {
    const result = JSON.parse(output || '{}');
    return {
      handle: String(result.handle || ''),
      text: String(result.text || '').trim().slice(-12000),
      descriptor: null,
      method: result.copied ? 'fast-clipboard' : 'fast-empty'
    };
  } catch {
    return { handle: '', text: '', descriptor: null, method: 'fast-failed' };
  }
}

async function getWindowContextMetadata(handle) {
  if (!handle) return {};
  const safeHandle = String(handle).replace(/[^0-9]/g, '') || '0';
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ContextWindowBounds {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}

"@

$result = [ordered]@{
  processName = ''
  executablePath = ''
  windowTitle = ''
  focusedControlType = ''
  focusedName = ''
  workspaceCandidates = @()
}

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${safeHandle})
  if ($null -ne $root) {
    $result.windowTitle = [string]$root.Current.Name
    $process = Get-Process -Id $root.Current.ProcessId
    $result.processName = [string]$process.ProcessName
    try { $result.executablePath = [string]$process.Path } catch {}

    $windowRect = New-Object ContextWindowBounds+RECT
    $hasWindowRect = [ContextWindowBounds]::GetWindowRect([IntPtr]${safeHandle}, [ref]$windowRect)
    $windowWidth = $windowRect.Right - $windowRect.Left
    $elements = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $focusedType = if ($null -ne $focused) { [string]$focused.Current.ControlType.ProgrammaticName } else { '' }
    $hasEditorFocus = $null -ne $focused -and
      $focused.Current.ProcessId -eq $root.Current.ProcessId -and
      $focused.Current.IsKeyboardFocusable -and
      $focusedType -match 'ControlType\.(Edit|Document|ComboBox)$'

    if (-not $hasEditorFocus) {
      $rankedInputs = New-Object 'System.Collections.Generic.List[object]'
      foreach ($element in $elements) {
        try {
          $controlType = [string]$element.Current.ControlType.ProgrammaticName
          $className = [string]$element.Current.ClassName
          if (-not $element.Current.IsKeyboardFocusable) { continue }
          if ($controlType -notmatch 'ControlType\.(Edit|Document|ComboBox)$' -and $className -notmatch '(?i)(edit|textbox|renderwidgethost|combobox)') { continue }
          $name = [string]$element.Current.Name
          $rect = $element.Current.BoundingRectangle
          if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
          $score = 10
          if ($name -match '(?i)(message input|prompt|chat|ask|query|composer)') { $score += 140 }
          if ($controlType -match 'ControlType\.(Edit|Document|ComboBox)$') { $score += 45 }
          if ($rect.Width -ge 240) { $score += 25 }
          if ($hasWindowRect -and $rect.Top -ge ($windowRect.Top + (($windowRect.Bottom - $windowRect.Top) * 0.35))) { $score += 25 }
          $rankedInputs.Add([pscustomobject]@{ element = $element; score = $score }) | Out-Null
        } catch {}
      }
      $selectedInput = $rankedInputs | Sort-Object score -Descending | Select-Object -First 1
      if ($null -ne $selectedInput) { $focused = $selectedInput.element }
    }

    if ($null -ne $focused -and $focused.Current.ProcessId -eq $root.Current.ProcessId) {
      $result.focusedControlType = [string]$focused.Current.ControlType.ProgrammaticName
      $result.focusedName = [string]$focused.Current.Name
      $focusRect = $focused.Current.BoundingRectangle
      $centralStart = if ($hasWindowRect -and $windowWidth -ge 500 -and $windowRect.Left -gt -30000) {
        $windowRect.Left + ($windowWidth * 0.17)
      } else {
        [Math]::Max(0, $focusRect.Left - 120)
      }
      $candidates = New-Object 'System.Collections.Generic.List[object]'

      foreach ($element in $elements) {
        try {
          $name = (($element.Current.Name -replace '\\s+', ' ').Trim())
          $rect = $element.Current.BoundingRectangle
          $distance = $focusRect.Top - $rect.Bottom
          if (
            $name.Length -ge 3 -and $name.Length -le 100 -and
            $rect.Width -gt 0 -and $rect.Height -gt 0 -and
            $rect.Left -ge $centralStart -and
            $rect.Bottom -le ($focusRect.Top + 8) -and
            $distance -ge -8 -and $distance -le 240
          ) {
            $candidates.Add([pscustomobject]@{
              name = $name
              controlType = [string]$element.Current.ControlType.ProgrammaticName
              distance = [Math]::Round($distance, 1)
            }) | Out-Null
          }
        } catch {}
      }

      $result.workspaceCandidates = @(
        $candidates |
          Sort-Object distance, @{ Expression = { $_.name.Length } } |
          Select-Object -First 12
      )
    }
  }
} catch {}

$result | ConvertTo-Json -Compress -Depth 4
`;

  const raw = await runPowerShell(script, 6500);
  try {
    const metadata = JSON.parse(raw || '{}');
    logDebug(`[Context] Active app=${metadata.processName || 'unknown'} title=${metadata.windowTitle || 'unknown'} workspaceCandidates=${metadata.workspaceCandidates?.length || 0}`);
    return metadata;
  } catch (error) {
    logDebug(`[Context] Window metadata parse failed: ${error.message}`);
    return {};
  }
}

async function getWindowContextMetadataFast(handle) {
  if (!handle) return {};
  const safeHandle = String(handle).replace(/[^0-9]/g, '') || '0';
  const script = `
Add-Type -AssemblyName UIAutomationClient
$result = [ordered]@{ processName = ''; executablePath = ''; windowTitle = ''; focusedControlType = ''; focusedName = ''; workspaceCandidates = @() }
try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${safeHandle})
  if ($null -ne $root) {
    $result.windowTitle = [string]$root.Current.Name
    $process = Get-Process -Id $root.Current.ProcessId
    $result.processName = [string]$process.ProcessName
    try { $result.executablePath = [string]$process.Path } catch {}
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused -and $focused.Current.ProcessId -eq $root.Current.ProcessId) {
      $result.focusedControlType = [string]$focused.Current.ControlType.ProgrammaticName
      $result.focusedName = [string]$focused.Current.Name
    }
  }
} catch {}
$result | ConvertTo-Json -Compress -Depth 3
`;
  const raw = await runPowerShell(script, 3500);
  try {
    const metadata = JSON.parse(raw || '{}');
    logDebug(`[Context] Fast metadata app=${metadata.processName || 'unknown'} title=${metadata.windowTitle || 'unknown'}`);
    return metadata;
  } catch {
    return {};
  }
}

async function focusWindowHandle(handle) {
  if (!handle) return;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$target = [IntPtr]${handle}
$foreground = [NativeMethods]::GetForegroundWindow()
$foregroundThread = [NativeMethods]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$targetThread = [NativeMethods]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
[NativeMethods]::AttachThreadInput($foregroundThread, $targetThread, $true) | Out-Null
[NativeMethods]::ShowWindowAsync($target, 9) | Out-Null
[NativeMethods]::BringWindowToTop($target) | Out-Null
$focused = [NativeMethods]::SetForegroundWindow($target)
[NativeMethods]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
$focused
`;
  return (await runPowerShell(script, 5000)).toLowerCase() === 'true';
}

function runPowerShell(script, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          logDebug(`[PowerShell] ${error.message}${stderr ? ` stderr=${stderr.trim()}` : ''}`);
          resolve('');
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function notify(type, message) {
  mainWindow?.webContents.send('notification', { type, message });
}

function notifyInBackground(type, message) {
  notify(type, message);
  if (mainWindow?.isFocused() || !Notification.isSupported()) return;
  try {
    new Notification({ title: 'Prompt Optimizer', body: message }).show();
  } catch (error) {
    logDebug(`[Notification] ${error.message}`);
  }
}

function reportProgress(message) {
  logDebug(`[Progress] ${message}`);
  mainWindow?.webContents.send('status-update', { message });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 600,
    resizable: true,
    frame: false,
    transparent: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/console\.groq\.com\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!startedHidden) mainWindow.show();
    registerGlobalShortcuts();
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logDebug(`[Crash] Renderer exited reason=${details.reason} code=${details.exitCode}`);
    notifyInBackground('error', 'The app window stopped unexpectedly. Click the tray icon to reopen it.');
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico'));
  tray = new Tray(icon);
  updateTrayMenu();
  tray.on('click', () => showMainWindow());
}

function updateTrayMenu() {
  if (!tray) return;
  const state = getShortcutState();
  const shortcutsReady = state.registered.optimize && state.registered.context && state.registered.toggle;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: optimizerEnabled
        ? `Status: ON${shortcutsReady ? '' : ' (shortcut conflict)'}`
        : 'Status: PAUSED',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Show', click: () => showMainWindow() },
    {
      label: `${optimizerEnabled ? 'Pause' : 'Enable'} Optimizer (${SHORTCUTS.toggle.label})`,
      click: () => toggleOptimizer()
    },
    { type: 'separator' },
    { label: 'Optimize Clipboard', enabled: optimizerEnabled, click: () => optimizeClipboard() },
    {
      label: `Optimize Active Input (${SHORTCUTS.optimize.label})`,
      enabled: optimizerEnabled,
      click: () => optimizeActiveInput(false)
    },
    {
      label: `Prompt Autopilot + RAG (${SHORTCUTS.context.label})`,
      enabled: optimizerEnabled,
      click: () => optimizeActiveInput(true)
    },
    { type: 'separator' },
    { label: 'Always-on background listener active', enabled: false }
  ]);

  tray.setToolTip(`Prompt Optimizer — ${optimizerEnabled ? (shortcutsReady ? 'ON' : 'ON, shortcut conflict') : 'PAUSED'}`);
  tray.setContextMenu(contextMenu);
}

async function optimizeClipboard() {
  if (!optimizerEnabled) {
    notify('warning', `Optimizer is paused. Press ${SHORTCUTS.toggle.label} to enable it.`);
    return;
  }
  if (isRefining || isCapturingInput) {
    notifyInBackground('warning', 'Prompt Optimizer is already working. Please wait for the current command.');
    return;
  }
  const text = clipboard.readText();
  if (!text || text.trim().length < 3) return;

  isRefining = true;
  try {
    const result = await refinePrompt(text);
    if (result.refined) {
      appendPromptHistory({ source: 'clipboard', prompt: text, refined: result.refined });
      recordProductEvent('optimization');
      clipboard.writeText(result.refined);
      mainWindow?.webContents.send('notification', {
        type: 'success',
        message: 'Optimized prompt copied to clipboard!'
      });
    }
  } catch (e) {
    console.error('[Optimizer] Error:', e.message);
  } finally {
    isRefining = false;
  }
}

function buildPromptHistoryContext(scopeId = '') {
  const config = loadConfig();
  const promptHistory = Array.isArray(config.promptHistory) ? config.promptHistory : [];
  const scopedHistory = scopeId && config.crossWorkspaceHistoryEnabled !== true
    ? promptHistory.filter((entry) => String(entry.scopeId || '') === scopeId)
    : promptHistory;
  if (!scopedHistory.length) return '';

  return scopedHistory
    .slice(-8)
    .map((entry, index) => {
      const prompt = String(entry.prompt || '').trim();
      const refined = String(entry.refined || '').trim();
      return [
        `Previous prompt ${index + 1}${entry.source ? ` (${entry.source})` : ''}:`,
        prompt,
        refined ? `Optimized result:\n${refined}` : ''
      ].filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');
}

function findProjectRoot({ scope = null, allowConfiguredProject = false } = {}) {
  const config = loadConfig();
  const candidates = [];
  const scopeId = String(scope?.id || '');
  const workspaceLabel = String(scope?.workspaceLabel || '');

  if (process.env.PROMPT_OPTIMIZER_PROJECT_ROOT) {
    candidates.push({ path: process.env.PROMPT_OPTIMIZER_PROJECT_ROOT, reason: 'environment-override' });
  }
  if (scopeId && config.workspaceProjectBindings?.[scopeId]) {
    candidates.push({ path: config.workspaceProjectBindings[scopeId], reason: 'workspace-binding' });
  }
  if (workspaceLabel) {
    for (const project of Array.isArray(config.projects) ? config.projects : []) {
      if (contextMatchesProject(workspaceLabel, project)) {
        candidates.push({ path: project.path, reason: 'workspace-name-match' });
      }
    }
  }
  if (config.projectRoot && (
    config.projectContextPolicy === 'pinned' ||
    allowConfiguredProject ||
    (workspaceLabel && contextMatchesProject(workspaceLabel, {
      name: path.basename(config.projectRoot),
      path: config.projectRoot
    }))
  )) {
    candidates.push({
      path: config.projectRoot,
      reason: config.projectContextPolicy === 'pinned'
        ? 'pinned-project'
        : allowConfiguredProject ? 'optimizer-ui-project' : 'workspace-name-match'
    });
  }
  if (!app.isPackaged && allowConfiguredProject) {
    candidates.push(
      { path: path.resolve(__dirname, '..'), reason: 'development-project' },
      { path: process.cwd(), reason: 'development-working-directory' }
    );
  }

  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate.path);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (fs.statSync(resolved).isDirectory() && isProjectRoot(resolved)) {
        return { projectRoot: resolved, reason: candidate.reason };
      }
    } catch {}
  }

  return { projectRoot: '', reason: scopeId ? 'no-workspace-match' : 'no-context-scope' };
}

function isProjectRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const markers = [
    '.git',
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'Gemfile',
    'composer.json',
    'README.md'
  ];
  return markers.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function shouldIncludeProjectFile(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const fileName = path.basename(normalized).toLowerCase();
  if (
    normalized.includes('/node_modules/') ||
    normalized.startsWith('node_modules/') ||
    normalized.includes('/vendor/') ||
    normalized.startsWith('vendor/') ||
    normalized.includes('/target/') ||
    normalized.startsWith('target/') ||
    normalized.includes('/build/') ||
    normalized.startsWith('build/') ||
    normalized.includes('/dist/') ||
    normalized.startsWith('dist/') ||
    normalized.includes('/coverage/') ||
    normalized.startsWith('coverage/') ||
    normalized.includes('/.next/') ||
    normalized.includes('/.turbo/') ||
    normalized.includes('/.cache/') ||
    normalized.includes('/__pycache__/') ||
    normalized.includes('/.git/') ||
    normalized.includes('/.prompt-optimizer/')
  ) {
    return false;
  }

  if (
    fileName.startsWith('.env') ||
    fileName.includes('secret') ||
    fileName.includes('token') ||
    fileName.includes('credential') ||
    /\.(pem|key|p12|pfx|crt|cer)$/i.test(fileName)
  ) {
    return false;
  }

  if (
    [
      'package.json',
      'README.md',
      'readme.md',
      'pyproject.toml',
      'requirements.txt',
      'Cargo.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'tsconfig.json',
      'vite.config.js',
      'next.config.js'
    ].includes(normalized)
  ) return true;

  return /\.(js|jsx|ts|tsx|mjs|cjs|json|html|css|scss|md|py|java|kt|go|rs|cs|php|rb|swift|sql|yaml|yml|toml)$/.test(normalized);
}

function redactSensitiveContent(content) {
  return String(content)
    .replace(/gsk_[A-Za-z0-9_-]{20,}/g, '[REDACTED_GROQ_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]');
}

function collectProjectFiles(root, dir = root, files = []) {
  if (files.length >= 80) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath);
    const normalized = relativePath.replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (
        ['node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'coverage', '__pycache__'].includes(entry.name) ||
        entry.name.startsWith('.cache') ||
        entry.name.startsWith('.next') ||
        entry.name.startsWith('.turbo')
      ) {
        continue;
      }
      collectProjectFiles(root, fullPath, files);
      continue;
    }

    if (entry.isFile() && shouldIncludeProjectFile(normalized)) {
      files.push(fullPath);
    }
  }

  return files;
}

function projectFilePriority(filePath, root) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const baseName = path.basename(relativePath).toLowerCase();
  const priority = [
    'README.md',
    'readme.md',
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'gui/main.js',
    'gui/renderer/app.js',
    'gui/preload.js',
    'gui/renderer/index.html',
    'core/groq-client.js',
    'core/prompts.js',
    'core/config.js',
    'package.json',
    'README.md'
  ];
  const index = priority.indexOf(relativePath);
  if (index !== -1) return index;
  if (/^(readme|package|pyproject|requirements|cargo|go\.mod|pom|build\.gradle|tsconfig)/i.test(baseName)) return priority.length;
  if (/^(src|app|pages|components|lib|core|gui|server|client|api)\//.test(relativePath)) return priority.length + 2;
  if (/test|spec/.test(relativePath.toLowerCase())) return priority.length + 8;
  return priority.length + 12;
}

function getQueryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 4)
    .slice(0, 24);
}

function scoreProjectFile(filePath, root, queryTerms) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/').toLowerCase();
  let score = 100 - projectFilePriority(filePath, root) * 8;
  for (const term of queryTerms) {
    if (relativePath.includes(term)) score += 25;
  }

  try {
    const sample = fs.readFileSync(filePath, 'utf-8').slice(0, 6000).toLowerCase();
    for (const term of queryTerms) {
      if (sample.includes(term)) score += 8;
    }
  } catch {}

  return score;
}

function runProjectCommand(root, args, maxChars = 12000) {
  try {
    const output = execFileSync(args[0], args.slice(1), {
      cwd: root,
      encoding: 'utf-8',
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }).trim();
    return output.length > maxChars ? `${output.slice(0, maxChars)}\n... [truncated]` : output;
  } catch {
    return '';
  }
}

function buildProjectStateContext(projectRoot) {
  const config = loadConfig();
  if (config.includeGitDiff === false) return '';

  const sections = [];
  const gitStatus = runProjectCommand(projectRoot, ['git', 'status', '--short'], CONTEXT_LIMITS.gitStatusChars);
  const gitDiffStat = runProjectCommand(projectRoot, ['git', 'diff', '--stat'], 2000);
  const gitDiff = runProjectCommand(projectRoot, ['git', 'diff', '--', 'core', 'gui', 'package.json'], CONTEXT_LIMITS.gitDiffChars);

  if (gitStatus) sections.push(`GIT STATUS:\n${redactSensitiveContent(gitStatus)}`);
  if (gitDiffStat) sections.push(`GIT DIFF STAT:\n${redactSensitiveContent(gitDiffStat)}`);
  if (gitDiff) sections.push(`RELEVANT GIT DIFF:\n${redactSensitiveContent(gitDiff)}`);

  return sections.join('\n\n-----\n\n');
}

function buildProjectContext(query = '', options = {}) {
  const config = loadConfig();
  if (config.includeProjectContext === false) {
    logDebug('[Context] Project context disabled');
    return { context: '', projectRoot: '', reason: 'disabled' };
  }

  const selection = findProjectRoot(options);
  const projectRoot = selection.projectRoot;
  if (!projectRoot) {
    logDebug(`[Context] Project root not selected reason=${selection.reason}`);
    return { context: '', projectRoot: '', reason: selection.reason };
  }

  const maxFileChars = CONTEXT_LIMITS.fileChars;
  const maxTotalChars = CONTEXT_LIMITS.projectChars;
  let total = 0;
  const sections = [];

  const projectStateContext = buildProjectStateContext(projectRoot);
  if (projectStateContext) {
    sections.push(`CURRENT PROJECT STATE:\n${projectStateContext}`);
    total += projectStateContext.length;
  }

  const queryTerms = getQueryTerms(query);
  const files = collectProjectFiles(projectRoot)
    .sort((a, b) => scoreProjectFile(b, projectRoot, queryTerms) - scoreProjectFile(a, projectRoot, queryTerms));

  for (const filePath of files) {
    if (total >= maxTotalChars) break;
    try {
      const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
      let content = redactSensitiveContent(fs.readFileSync(filePath, 'utf-8'));
      if (content.length > maxFileChars) {
        content = `${content.slice(0, maxFileChars)}\n... [truncated]`;
      }
      const remaining = maxTotalChars - total;
      const section = `FILE: ${relativePath}\n${content}`.slice(0, Math.max(0, remaining));
      sections.push(section);
      total += section.length;
    } catch {}
  }

  const context = sections.join('\n\n-----\n\n').slice(0, maxTotalChars);
  logDebug(`[Context] Project root: ${projectRoot}`);
  logDebug(`[Context] Project context length: ${context.length}`);
  return { context, projectRoot, reason: selection.reason };
}

function getActiveWindowTitle(context) {
  const windowLine = String(context || '').split(/\r?\n/).find((line) => /^Active window:/i.test(line.trim()));
  return windowLine
    ? windowLine.replace(/^Active window:\s*/i, '').trim()
    : 'Captured chat window';
}

function learnFromContext({ activeWindowContext = '', rawPrompt = '', refined = '', scope = null }) {
  const config = loadConfig();
  if (config.memoryRagEnabled === false || config.autoLearnFromContext === false) {
    return { added: 0, skipped: true, reason: 'disabled' };
  }

  let added = 0;
  const title = getActiveWindowTitle(activeWindowContext);
  const scopeMetadata = scope?.id ? {
    scopeId: scope.id,
    appId: scope.appId || '',
    workspaceLabel: scope.workspaceLabel || ''
  } : {};
  const activeResult = addMemoryDocument({
    source: 'active-window',
    title,
    text: activeWindowContext,
    metadata: { ...scopeMetadata, prompt: rawPrompt.slice(0, 500) }
  });
  added += activeResult.added || 0;

  if (rawPrompt && refined) {
    const promptResult = addMemoryDocument({
      source: 'optimizer-result',
      title: 'Optimized prompt outcome',
      text: `RAW PROMPT:\n${rawPrompt}\n\nREFINED PROMPT:\n${refined}`,
      metadata: scopeMetadata
    });
    added += promptResult.added || 0;
  }

  logDebug(`[Memory] Learned chunks: ${added} scope=${scope?.id || 'unscoped'}`);
  return { added };
}

async function captureActiveWindowContext(targetWindowHandle = '', metadata = {}) {
  const safeHandle = String(targetWindowHandle || '0').replace(/[^0-9]/g, '') || '0';
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

$items = New-Object 'System.Collections.Generic.List[string]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$maxItems = 120
$maxChars = ${CONTEXT_LIMITS.activeWindowChars}
$rootLeft = 0
$rootWidth = 0
$rootHeight = 0
$focused = $null

function Add-ContextText([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  $clean = (($Text -replace '\\s+', ' ').Trim())
  if ($clean.Length -lt 2) { return }
  if ($seen.Add($clean)) {
    $items.Add($clean) | Out-Null
  }
}

function Read-Element([System.Windows.Automation.AutomationElement]$Element, [int]$Depth) {
  if ($null -eq $Element -or $Depth -gt 5 -or $items.Count -ge $maxItems) { return }

  $include = $true
  $areaRatio = 0
  try {
    $rect = $Element.Current.BoundingRectangle
    if ($rootWidth -ge 700) {
      $centralStart = $rootLeft + ($rootWidth * 0.17)
      $include = $rect.Width -gt 0 -and $rect.Height -gt 0 -and $rect.Right -ge $centralStart
    }
    if ($rootWidth -gt 0 -and $rootHeight -gt 0) {
      $areaRatio = ($rect.Width * $rect.Height) / ($rootWidth * $rootHeight)
    }
  } catch {}

  if ($include) {
    try { Add-ContextText $Element.Current.Name } catch {}

    try {
      $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      Add-ContextText $valuePattern.Current.Value
    } catch {}

    try {
      if ($areaRatio -lt 0.55) {
        $textPattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        Add-ContextText $textPattern.DocumentRange.GetText($maxChars)
      }
    } catch {}
  }

  try {
    $children = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      Read-Element $child ($Depth + 1)
      if ($items.Count -ge $maxItems) { break }
    }
  } catch {}
}

try {
  $requestedHandle = [IntPtr]${safeHandle}
  $handle = if ($requestedHandle -ne [IntPtr]::Zero) { $requestedHandle } else { [NativeMethods]::GetForegroundWindow() }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($null -ne $root) {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $windowRect = New-Object NativeMethods+RECT
    $windowWidth = $windowRect.Right - $windowRect.Left
    if ([NativeMethods]::GetWindowRect($handle, [ref]$windowRect)) {
      $windowWidth = $windowRect.Right - $windowRect.Left
    }
    if ($windowWidth -ge 500 -and $windowRect.Left -gt -30000) {
      $rootLeft = $windowRect.Left
      $rootWidth = $windowWidth
      $rootHeight = $windowRect.Bottom - $windowRect.Top
    } elseif ($null -ne $focused) {
      $focusRect = $focused.Current.BoundingRectangle
      $rootLeft = [Math]::Max(0, $focusRect.Left - 120)
      $rootWidth = $focusRect.Width + 240
      $rootHeight = [Math]::Max(700, $focusRect.Height)
    }
    Add-ContextText ("Active window: " + $root.Current.Name)
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) { Read-Element $child 1 }
  }
} catch {}

$joined = ($items -join [Environment]::NewLine)
if ($joined.Length -gt $maxChars) { $joined = $joined.Substring([Math]::Max(0, $joined.Length - $maxChars)) }
$joined
`;

  const body = await runPowerShell(script, 4500);
  const scope = deriveContextScope(metadata, body);
  const identity = [
    `Active application: ${scope.appLabel}`,
    scope.workspaceLabel ? `Active workspace: ${scope.workspaceLabel}` : '',
    metadata.windowTitle ? `Active window: ${metadata.windowTitle}` : ''
  ].filter(Boolean).join('\n');
  const availableBodyChars = Math.max(0, CONTEXT_LIMITS.activeWindowChars - identity.length - 2);
  const context = `${identity}\n\n${String(body || '').slice(-availableBodyChars)}`.trim();
  logDebug(`[Context] Active window context length: ${context.length}`);
  return context;
}

function rememberContextScope(scope) {
  if (!scope?.id) return;
  const config = loadConfig();
  const previous = config.lastContextScope;
  const lastSeen = Date.parse(previous?.lastSeenAt || 0);
  const stale = !Number.isFinite(lastSeen) || Date.now() - lastSeen > 15 * 60 * 1000;
  if (previous?.id === scope.id && !stale) return;
  saveConfig({
    lastContextScope: {
      ...scope,
      lastSeenAt: new Date().toISOString()
    }
  });
}

async function buildCombinedContext(activeWindowContext, rawPrompt = '', options = {}) {
  const config = loadConfig();
  const activeContext = String(activeWindowContext || '').slice(-CONTEXT_LIMITS.activeWindowChars);
  const scope = options.scope || INTERNAL_CONTEXT_SCOPE;
  const project = buildProjectContext(`${rawPrompt}\n${activeContext}`, {
    scope,
    allowConfiguredProject: options.allowConfiguredProject === true
  });
  const historyContext = config.includePromptHistory === false
    ? ''
    : buildPromptHistoryContext(scope.id).slice(0, CONTEXT_LIMITS.historyChars);
  const prepared = await prepareRagContext({
    rawPrompt,
    activeWindowContext: activeContext,
    projectContext: project.context,
    historyContext,
    scopeId: scope.id,
    allowCrossWorkspaceMemory: config.crossWorkspaceMemoryEnabled === true,
    allowLegacyMemory: false,
    purpose: config.promptPurpose || 'auto',
    memoryMaxChars: Number(config.memoryMaxChars) || CONTEXT_LIMITS.memoryChars,
    memoryEnabled: config.memoryRagEnabled !== false,
    hydeEnabled: options.allowRemoteHyde !== false &&
      config.advancedRagEnabled !== false &&
      config.ragHydeEnabled !== false,
    hydeGenerator: generateHydeQueries,
    onProgress: options.reportProgress === false ? undefined : reportProgress
  });
  const diagnostics = {
    ...prepared.diagnostics,
    contextScope: scope,
    projectRootUsed: project.projectRoot,
    projectSelectionReason: project.reason
  };
  lastPipelineDiagnostics = diagnostics;
  logDebug(`[RAG] scope=${scope.id} project=${project.projectRoot || 'none'} projectReason=${project.reason} intent=${diagnostics.intent} mode=${diagnostics.retrievalMode} grade=${diagnostics.retrievalGrade} confidence=${diagnostics.retrievalConfidence} chunks=${diagnostics.retrievedChunks}/${diagnostics.candidateChunks} hyde=${diagnostics.hydeSource}:${diagnostics.hydeGenerated} cache=${diagnostics.retrievalCacheHit} injections=${diagnostics.injectionFlags.join(',') || 'none'} contextChars=${diagnostics.contextChars}`);
  return {
    context: prepared.context,
    projectContext: project.context,
    projectRoot: project.projectRoot,
    scope,
    diagnostics
  };
}

function pruneAutopilotSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sessionId, session] of autopilotSessions) {
    if (session.createdAt < cutoff) autopilotSessions.delete(sessionId);
  }
  while (autopilotSessions.size > 20) {
    autopilotSessions.delete(autopilotSessions.keys().next().value);
  }
}

function storeAutopilotSession({ rawPrompt, activeWindowContext, ragResult, result, source }) {
  pruneAutopilotSessions();
  const sessionId = randomUUID();
  autopilotSessions.set(sessionId, {
    sessionId,
    rawPrompt,
    activeWindowContext,
    context: ragResult?.context || '',
    scope: ragResult?.scope || null,
    diagnostics: ragResult?.diagnostics || null,
    suggestions: result.suggestions,
    source,
    accepted: false,
    createdAt: Date.now()
  });
  return sessionId;
}

function serializeAutopilotRun(run) {
  return {
    sessionId: run.sessionId,
    suggestions: run.result.suggestions,
    best: run.result.best,
    model: run.result.model,
    durationMs: run.result.durationMs,
    cacheHit: run.result.cacheHit,
    pipeline: run.result.pipeline,
    scope: run.ragResult?.scope || null,
    rag: run.ragResult?.diagnostics || null
  };
}

async function runPromptAutopilot(rawPrompt, activeWindowContext = '', options = {}) {
  const config = loadConfig();
  const ragResult = options.ragResult || await buildCombinedContext(activeWindowContext, rawPrompt, {
    allowRemoteHyde: options.allowRemoteHyde !== false,
    reportProgress: options.reportProgress !== false,
    scope: options.scope,
    allowConfiguredProject: options.allowConfiguredProject === true
  });
  if (options.reportProgress !== false) reportProgress('Generating and ranking AI prompt suggestions...');
  const result = await generatePromptSuggestions(rawPrompt, ragResult.context, {
    promptPurpose: options.promptPurpose || config.promptPurpose,
    refinementStyle: options.refinementStyle || config.refinementStyle,
    suggestionCount: config.promptSuggestionCount,
    qualityThreshold: config.promptAutopilotQualityThreshold
  });
  if (result.error) return { error: result.error, ragResult };

  const sessionId = storeAutopilotSession({
    rawPrompt,
    activeWindowContext,
    ragResult,
    result,
    source: options.source || 'autopilot'
  });
  recordProductEvent('suggestions-generated', { count: result.suggestions.length });
  logDebug(`[Autopilot] session=${sessionId} candidates=${result.suggestions.length} best=${result.best?.id || 'none'} quality=${result.best?.qualityScore ?? 'n/a'} gate=${Boolean(result.pipeline?.qualityGatePassed)} cache=${Boolean(result.cacheHit)}`);
  return { sessionId, result, ragResult };
}

function markAutopilotAccepted(session, suggestion) {
  if (!session.accepted) {
    session.accepted = true;
    recordProductEvent('autopilot-accepted', { context: Boolean(session.diagnostics) });
  }
  appendPromptHistory({
    source: session.source || 'autopilot',
    prompt: session.rawPrompt,
    refined: suggestion.prompt,
    scopeId: session.scope?.id,
    appId: session.scope?.appId,
    workspaceLabel: session.scope?.workspaceLabel
  });
  if (session.activeWindowContext) {
    learnFromContext({
      activeWindowContext: session.activeWindowContext,
      rawPrompt: session.rawPrompt,
      refined: suggestion.prompt,
      scope: session.scope
    });
  }
}

async function acceptAutopilotSuggestion(sessionId, suggestionId, options = {}) {
  if (!optimizerEnabled) {
    return { error: `Optimizer is paused. Press ${SHORTCUTS.toggle.label} to enable it.` };
  }
  pruneAutopilotSessions();
  const session = autopilotSessions.get(sessionId);
  if (!session) return { error: 'This suggestion session expired. Generate fresh suggestions.' };
  const suggestion = session.suggestions.find((candidate) => candidate.id === suggestionId);
  if (!suggestion) return { error: 'The selected prompt suggestion was not found.' };

  markAutopilotAccepted(session, suggestion);
  const config = loadConfig();
  if (options.copy !== false && config.autoCopy !== false) clipboard.writeText(suggestion.prompt);

  let ide = null;
  if (options.sendToIDE === true || (config.autoSendToIDE === true && config.selectedIDE !== 'none')) {
    ide = await sendToIDE(config.selectedIDE, suggestion.prompt, { announce: options.announce !== false });
    if (ide.error && options.sendToIDE === true) return { error: ide.error, suggestion };
  }
  return { suggestion, ide, metrics: getProductMetrics() };
}

function addProjectToConfig(projectRoot) {
  const resolved = path.resolve(projectRoot);
  const current = loadConfig();
  const projects = Array.isArray(current.projects) ? current.projects : [];
  const name = path.basename(resolved) || resolved;
  const nextProjects = [
    { name, path: resolved, updatedAt: new Date().toISOString() },
    ...projects.filter((project) => path.resolve(project.path) !== resolved)
  ].slice(0, 20);
  return saveConfig({ projectRoot: resolved, projects: nextProjects });
}

async function readFocusedInputText(targetWindowHandle) {
  const safeHandle = String(targetWindowHandle || '0').replace(/[^0-9]/g, '') || '0';
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$result = [ordered]@{
  automationId = ''; name = ''; controlType = ''; className = ''
  focusable = $false; sameProcess = $false
  x = 0; y = 0; width = 0; height = 0; text = ''; selectionSource = ''
}

function Test-PromptInput([System.Windows.Automation.AutomationElement]$Element) {
  if ($null -eq $Element) { return $false }
  try {
    $controlType = [string]$Element.Current.ControlType.ProgrammaticName
    $className = [string]$Element.Current.ClassName
    return $Element.Current.IsKeyboardFocusable -and (
      $controlType -match 'ControlType\.(Edit|Document|ComboBox)$' -or
      $className -match '(?i)(edit|richedit|textbox|renderwidgethost|combobox)'
    )
  } catch { return $false }
}

function Read-PromptInput([System.Windows.Automation.AutomationElement]$Element) {
  try {
    $textCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text
    )
    $textElements = $Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
    $bestText = ''
    $bestArea = 0
    foreach ($textElement in $textElements) {
      try {
        $name = [string]$textElement.Current.Name
        $rect = $textElement.Current.BoundingRectangle
        $area = $rect.Width * $rect.Height
        if ($name -and $area -gt $bestArea) { $bestArea = $area; $bestText = $name }
      } catch {}
    }
    if ($bestText) { return $bestText }
  } catch {}
  try {
    $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$valuePattern.Current.Value
  } catch {
    try {
      $textPattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      return [string]$textPattern.DocumentRange.GetText(12000)
    } catch {}
  }
  return ''
}

try {
  $target = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${safeHandle})
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  $selected = $null
  if ($null -ne $target -and $null -ne $focused -and $focused.Current.ProcessId -eq $target.Current.ProcessId -and (Test-PromptInput $focused)) {
    $selected = $focused
    $result.selectionSource = 'focused'
  } elseif ($null -ne $target) {
    $ranked = New-Object 'System.Collections.Generic.List[object]'
    $elements = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $targetRect = $target.Current.BoundingRectangle
    foreach ($element in $elements) {
      try {
        if (-not (Test-PromptInput $element)) { continue }
        $name = [string]$element.Current.Name
        $controlType = [string]$element.Current.ControlType.ProgrammaticName
        $rect = $element.Current.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
        $score = 10
        if ($name -match '(?i)(message input|prompt|chat|ask|query|composer)') { $score += 140 }
        if ($controlType -match 'ControlType\.(Edit|Document|ComboBox)$') { $score += 45 }
        if ($rect.Width -ge 240) { $score += 25 }
        if ($rect.Top -ge ($targetRect.Top + ($targetRect.Height * 0.35))) { $score += 25 }
        $ranked.Add([pscustomobject]@{ element = $element; score = $score }) | Out-Null
      } catch {}
    }
    $match = $ranked | Sort-Object score -Descending | Select-Object -First 1
    if ($null -ne $match) {
      $selected = $match.element
      $result.selectionSource = 'window-fallback'
    }
  }

  if ($null -ne $selected) {
    $result.automationId = $selected.Current.AutomationId
    $result.name = $selected.Current.Name
    $result.controlType = $selected.Current.ControlType.ProgrammaticName
    $result.className = $selected.Current.ClassName
    $result.focusable = $selected.Current.IsKeyboardFocusable
    $result.sameProcess = $null -ne $target -and $selected.Current.ProcessId -eq $target.Current.ProcessId
    $rect = $selected.Current.BoundingRectangle
    $result.x = $rect.X
    $result.y = $rect.Y
    $result.width = $rect.Width
    $result.height = $rect.Height
    $result.text = Read-PromptInput $selected
  }
} catch {}

$result | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, 5000);
  try {
    const result = JSON.parse(output);
    const supportedControl = /ControlType\.(Edit|Document|ComboBox)$/i.test(String(result.controlType || '')) ||
      /(edit|richedit|textbox|renderwidgethost|combobox)/i.test(String(result.className || ''));
    if (result.sameProcess && result.focusable && supportedControl) {
      return {
        text: String(result.text || '').trim().slice(-12000),
        descriptor: {
          automationId: String(result.automationId || ''),
          name: String(result.name || ''),
          controlType: String(result.controlType || ''),
          className: String(result.className || ''),
          x: Number(result.x) || 0,
          y: Number(result.y) || 0,
          width: Number(result.width) || 0,
          height: Number(result.height) || 0
        }
      };
    }
  } catch {}
  return { text: '', descriptor: null };
}

async function readActiveInputText(targetWindowHandle) {
  const accessibleInput = await readFocusedInputText(targetWindowHandle);
  if (accessibleInput.text) {
    logDebug(`[Shortcuts] Focused input read through UI Automation: ${accessibleInput.text.length}`);
    return accessibleInput;
  }

  const previousClipboard = clipboard.readText();
  clipboard.writeText('');
  await focusWindowHandle(targetWindowHandle);
  await delay(220);
  await sendWindowsKeys('^a');
  await delay(140);
  await sendWindowsKeys('^c');
  let selectedText = '';
  for (let attempt = 0; attempt < 5 && !selectedText; attempt += 1) {
    await delay(120);
    selectedText = clipboard.readText();
  }

  if (selectedText) {
    logDebug(`[Shortcuts] Focused input read through clipboard fallback: ${selectedText.length}`);
    return {
      text: selectedText.trim().slice(-12000),
      descriptor: accessibleInput.descriptor
    };
  }

  clipboard.writeText(previousClipboard);
  return { text: '', descriptor: accessibleInput.descriptor };
}

async function pasteToCapturedInput(targetWindowHandle, descriptor, text) {
  const safeHandle = String(targetWindowHandle || '0').replace(/[^0-9]/g, '') || '0';
  const encodedDescriptor = Buffer.from(JSON.stringify(descriptor || {}), 'utf-8').toString('base64');
  const encodedText = Buffer.from(String(text || ''), 'utf-8').toString('base64');
  try {
    clipboard.writeText(text);
  } catch {}
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PromptOptimizerInputNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint target, bool value);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@

$descriptorJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDescriptor}'))
$descriptor = $descriptorJson | ConvertFrom-Json
$replacement = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))
$result = [ordered]@{
  focused = $false; foreground = $false; observed = ''; clipboardLength = 0
  selectedName = ''; selectedType = ''; focusedName = ''; staleModifiers = ''; method = ''; score = 0
}

function Read-RenderedInputText([System.Windows.Automation.AutomationElement]$Element) {
  try {
    $textCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text
    )
    $textElements = $Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
    $bestText = ''
    $bestArea = 0
    foreach ($textElement in $textElements) {
      try {
        $name = [string]$textElement.Current.Name
        if (-not $name) { continue }
        if ($name -eq $replacement) { return $name }
        $rect = $textElement.Current.BoundingRectangle
        $area = $rect.Width * $rect.Height
        if ($area -gt $bestArea) { $bestArea = $area; $bestText = $name }
      } catch {}
    }
    if ($bestText) { return $bestText }
  } catch {}
  try {
    $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$valuePattern.Current.Value
  } catch {
    try {
      $textPattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      return [string]$textPattern.DocumentRange.GetText(12000)
    } catch {}
  }
  return ''
}

function Set-PromptOptimizerClipboard([string]$Value) {
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($Value)
      if ([System.Windows.Forms.Clipboard]::GetText() -eq $Value) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 125
  }
  return $false
}

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${safeHandle})
  $ranked = New-Object 'System.Collections.Generic.List[object]'
  $elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $elements) {
    try {
      if (-not $element.Current.IsKeyboardFocusable) { continue }
      $controlType = [string]$element.Current.ControlType.ProgrammaticName
      $className = [string]$element.Current.ClassName
      if ($controlType -notmatch 'ControlType\.(Edit|Document|ComboBox)$' -and $className -notmatch '(edit|richedit|textbox|renderwidgethost|combobox)') { continue }

      $score = 1
      $name = [string]$element.Current.Name
      $automationId = [string]$element.Current.AutomationId
      $rect = $element.Current.BoundingRectangle
      if ($descriptor.automationId -and $automationId -eq [string]$descriptor.automationId) { $score += 160 }
      if ($descriptor.name -and $name -eq [string]$descriptor.name) { $score += 90 }
      if ($descriptor.controlType -and $controlType -eq [string]$descriptor.controlType) { $score += 35 }
      if ($descriptor.className -and $className -eq [string]$descriptor.className) { $score += 25 }
      $distance = [Math]::Abs($rect.X - [double]$descriptor.x) + [Math]::Abs($rect.Y - [double]$descriptor.y)
      if ($distance -le 12) { $score += 60 }
      elseif ($distance -le 100) { $score += 30 }
      elseif ($distance -le 300) { $score += 10 }
      $ranked.Add([pscustomobject]@{ element = $element; score = $score; name = $name; type = $controlType }) | Out-Null
    } catch {}
  }

  $selected = $ranked | Sort-Object score -Descending | Select-Object -First 1
  if ($null -ne $selected) {
    $target = [IntPtr]${safeHandle}
    $foreground = [PromptOptimizerInputNative]::GetForegroundWindow()
    $foregroundThread = [PromptOptimizerInputNative]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
    $targetThread = [PromptOptimizerInputNative]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
    [PromptOptimizerInputNative]::AttachThreadInput($foregroundThread, $targetThread, $true) | Out-Null
    [PromptOptimizerInputNative]::ShowWindowAsync($target, 9) | Out-Null
    [PromptOptimizerInputNative]::BringWindowToTop($target) | Out-Null
    [PromptOptimizerInputNative]::SetForegroundWindow($target) | Out-Null
    [PromptOptimizerInputNative]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
    if (-not (Set-PromptOptimizerClipboard $replacement)) { throw 'Clipboard is temporarily unavailable.' }
    $result.clipboardLength = [System.Windows.Forms.Clipboard]::GetText().Length
    $selected.element.SetFocus()
    $selectedRect = $selected.element.Current.BoundingRectangle
    $cursor = New-Object PromptOptimizerInputNative+POINT
    [PromptOptimizerInputNative]::GetCursorPos([ref]$cursor) | Out-Null
    $clickX = [int]($selectedRect.X + [Math]::Min(60, $selectedRect.Width / 2))
    $clickY = [int]($selectedRect.Y + [Math]::Min(60, $selectedRect.Height / 2))
    [PromptOptimizerInputNative]::SetCursorPos($clickX, $clickY) | Out-Null
    [PromptOptimizerInputNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    $selected.element.SetFocus()
    Start-Sleep -Milliseconds 220
    $result.foreground = [PromptOptimizerInputNative]::GetForegroundWindow() -eq $target
    try { $result.focusedName = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name } catch {}
    $stale = New-Object 'System.Collections.Generic.List[string]'
    foreach ($modifier in @(
      @{ key = 0x10; name = 'shift' }, @{ key = 0x11; name = 'ctrl' }, @{ key = 0x12; name = 'alt' },
      @{ key = 0x5B; name = 'lwin' }, @{ key = 0x5C; name = 'rwin' }
    )) {
      if (([PromptOptimizerInputNative]::GetAsyncKeyState($modifier.key) -band 0x8000) -ne 0) {
        $stale.Add($modifier.name) | Out-Null
      }
      [PromptOptimizerInputNative]::keybd_event($modifier.key, 0, 2, [UIntPtr]::Zero)
    }
    $result.staleModifiers = $stale -join ','
    Start-Sleep -Milliseconds 100
    [PromptOptimizerInputNative]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 130
    [PromptOptimizerInputNative]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
    [PromptOptimizerInputNative]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 750
    [PromptOptimizerInputNative]::SetCursorPos($cursor.X, $cursor.Y) | Out-Null
    $result.focused = $true
    $result.selectedName = $selected.name
    $result.selectedType = $selected.type
    $result.score = $selected.score
    $result.method = 'keybd-event'
    $result.observed = Read-RenderedInputText $selected.element
    if ($result.observed -ne $replacement) {
      try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.AppActivate([int]$root.Current.ProcessId) | Out-Null
        if (-not (Set-PromptOptimizerClipboard $replacement)) { throw 'Clipboard is temporarily unavailable.' }
        $selected.element.SetFocus()
        Start-Sleep -Milliseconds 220
        $shell.SendKeys('^a')
        Start-Sleep -Milliseconds 130
        $shell.SendKeys('^v')
        Start-Sleep -Milliseconds 750
        $result.method = 'wscript-fallback'
        $result.observed = Read-RenderedInputText $selected.element
      } catch {}
    }
  }
} catch {}

$result | ConvertTo-Json -Compress
`;

  await focusWindowHandle(targetWindowHandle);
  await delay(220);
  const output = await runPowerShell(script, 6500);
  try {
    const result = JSON.parse(output || '{}');
    const normalize = (value) => String(value || '').replace(/\r\n/g, '\n').trim();
    return {
      ...result,
      success: result.focused === true && normalize(result.observed) === normalize(text)
    };
  } catch {
    return { success: false, focused: false, observed: '' };
  }
}

async function pasteActiveInputFast(targetWindowHandle) {
  const safeHandle = String(targetWindowHandle || '0').replace(/[^0-9]/g, '') || '0';
  if (safeHandle === '0') return { success: false, focused: false, method: 'fast-no-target' };
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FastPasteNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@
$target = [IntPtr]${safeHandle}
$current = [FastPasteNative]::GetForegroundWindow()
$currentThread = [FastPasteNative]::GetWindowThreadProcessId($current, [IntPtr]::Zero)
$targetThread = [FastPasteNative]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
[FastPasteNative]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
[FastPasteNative]::ShowWindowAsync($target, 9) | Out-Null
[FastPasteNative]::BringWindowToTop($target) | Out-Null
[FastPasteNative]::SetForegroundWindow($target) | Out-Null
[FastPasteNative]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
foreach ($key in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) { [FastPasteNative]::keybd_event($key, 0, 2, [UIntPtr]::Zero) }
Start-Sleep -Milliseconds 90
$sent = $false
try {
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  $sent = $true
} catch {}
Start-Sleep -Milliseconds 160
[ordered]@{ focused = ([FastPasteNative]::GetForegroundWindow() -eq $target); sent = $sent; method = 'fast-sendkeys' } | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, 3500);
  try {
    const result = JSON.parse(output || '{}');
    return { ...result, success: result.focused === true && result.sent === true };
  } catch {
    return { success: false, focused: false, method: 'fast-failed' };
  }
}

async function replaceActiveInputText(targetWindowHandle, descriptor, text) {
  const fastResult = await pasteActiveInputFast(targetWindowHandle);
  logDebug(`[Shortcuts] Paste fast method=${fastResult.method} focused=${Boolean(fastResult.focused)} sent=${Boolean(fastResult.sent)} success=${Boolean(fastResult.success)}`);
  if (fastResult.success) return { ...fastResult, attempts: 1 };
  let lastResult = { success: false, focused: false, observed: '' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    lastResult = await pasteToCapturedInput(targetWindowHandle, descriptor, text);
    logDebug(`[Shortcuts] Paste attempt=${attempt} method=${lastResult.method || 'unknown'} foreground=${Boolean(lastResult.foreground)} focused=${Boolean(lastResult.focused)} focusedName=${lastResult.focusedName || 'unknown'} staleModifiers=${lastResult.staleModifiers || 'none'} verified=${Boolean(lastResult.success)} target=${lastResult.selectedName || 'unknown'} type=${lastResult.selectedType || 'unknown'} clipboardLength=${Number(lastResult.clipboardLength) || 0} observedLength=${String(lastResult.observed || '').length}`);
    if (lastResult.success) return { ...lastResult, attempts: attempt };
    await delay(300);
  }
  return { ...lastResult, attempts: 2 };
}

async function optimizeActiveInput(useConversationContext = false) {
  const commandStartedAt = Date.now();
  if (!optimizerEnabled) {
    setOptimizerEnabled(true, { announce: false });
    notifyInBackground('success', 'Optimizer awakened by command. Running now.');
  }
  if (isRefining || isCapturingInput) {
    logDebug('[Shortcuts] Command ignored because another command is active');
    notifyInBackground('warning', 'Already optimizing. Please wait for the current command to finish.');
    return;
  }
  logDebug(`[Shortcuts] Triggered ${useConversationContext ? SHORTCUTS.context.label : SHORTCUTS.optimize.label}`);
  reportProgress(useConversationContext ? 'Reading active chat and project context...' : 'Reading active prompt...');

  if (mainWindow?.isFocused()) {
    mainWindow.webContents.send(useConversationContext ? 'optimize-input-with-context-hotkey' : 'optimize-input-hotkey');
    return;
  }

  isCapturingInput = true;
  let targetWindowHandle = '';
  let activeInput = { text: '', descriptor: null };
  let windowMetadata = {};
  let contextScope = null;
  let activeWindowContext = '';
  try {
    const previousClipboard = clipboard.readText();
    clipboard.writeText('');
    const fastCapture = await captureActiveInputFast();
    targetWindowHandle = fastCapture.handle || await getForegroundWindowHandle();
    logDebug(`[Shortcuts] Target window handle: ${targetWindowHandle || 'unknown'}`);
    if (!targetWindowHandle) throw new Error('Could not detect the active window. Click the prompt box and try again.');
    if (fastCapture.text) {
      activeInput = { text: fastCapture.text, descriptor: null };
      logDebug(`[Shortcuts] Active input captured through ${fastCapture.method}: ${fastCapture.text.length}`);
    } else {
      clipboard.writeText(previousClipboard);
      activeInput = await readActiveInputText(targetWindowHandle);
    }
    windowMetadata = useConversationContext ? await getWindowContextMetadataFast(targetWindowHandle) : {};
    contextScope = useConversationContext ? deriveContextScope(windowMetadata) : null;
    if (contextScope) {
      rememberContextScope(contextScope);
      logDebug(`[Context] Scope detected: ${contextScope.id} (${contextScope.label})`);
    }
    activeWindowContext = useConversationContext
      ? await captureActiveWindowContext(targetWindowHandle, windowMetadata)
      : '';
  } catch (error) {
    logDebug(`[Shortcuts] Input capture failed: ${error.message}`);
    notifyInBackground('error', error.message);
    return;
  } finally {
    isCapturingInput = false;
  }
  const text = activeInput.text;
  logDebug(`[Performance] captureMs=${Date.now() - commandStartedAt} inputLength=${text.length}`);
  if (!text || text.trim().length < 3) {
    notifyInBackground('warning', 'No text found. Click inside the prompt box, type or select text, then try again.');
    return;
  }

  isRefining = true;
  mainWindow?.webContents.send('refine-start');

  try {
    const config = loadConfig();
    let ragResult = null;
    let autopilotRun = null;
    let result;

    if (useConversationContext && config.promptAutopilotEnabled !== false) {
      autopilotRun = await runPromptAutopilot(text, activeWindowContext, {
        source: 'context-autopilot-hotkey',
        allowRemoteHyde: true,
        scope: contextScope,
        allowConfiguredProject: false
      });
      ragResult = autopilotRun.ragResult;
      result = autopilotRun.error
        ? { error: autopilotRun.error }
        : {
            refined: autopilotRun.result.best.prompt,
            model: autopilotRun.result.model,
            durationMs: autopilotRun.result.durationMs,
            cacheHit: autopilotRun.result.cacheHit,
            pipeline: {
              ...autopilotRun.result.pipeline,
              autopilot: true,
              qualityScore: autopilotRun.result.best.qualityScore
            }
          };
    } else {
      ragResult = useConversationContext
        ? await buildCombinedContext(activeWindowContext, text, {
            allowRemoteHyde: true,
            scope: contextScope,
            allowConfiguredProject: false
          })
        : null;
      const context = ragResult?.context;
      logDebug(`[Shortcuts] Calling optimizer. context=${useConversationContext} contextLength=${context?.length || 0}`);
      reportProgress(useConversationContext ? 'Generating and quality-checking the prompt...' : 'Optimizing prompt...');
      result = await refinePrompt(text, context, {
        forceContext: useConversationContext,
        promptPurpose: config.promptPurpose,
        refinementStyle: config.refinementStyle
      });
    }
    logDebug(`[Shortcuts] Optimizer result: ${result.refined ? `refinedLength=${result.refined.length} model=${result.model || 'unknown'} durationMs=${result.durationMs ?? 'n/a'} cache=${Boolean(result.cacheHit)} reflected=${Boolean(result.pipeline?.reflected)} quality=${result.pipeline?.qualityScore ?? 'n/a'}` : `error=${result.error || 'empty'}`}`);

    if (result.error) {
      showMainWindow();
      mainWindow?.webContents.send('notification', { type: 'error', message: result.error });
      return;
    }

    if (result.refined) {
      const autopilotSession = autopilotRun ? autopilotSessions.get(autopilotRun.sessionId) : null;
      if (autopilotSession) {
        markAutopilotAccepted(autopilotSession, autopilotRun.result.best);
      } else {
        appendPromptHistory({
          source: useConversationContext ? 'context-hotkey' : 'hotkey',
          prompt: text,
          refined: result.refined,
          scopeId: contextScope?.id,
          appId: contextScope?.appId,
          workspaceLabel: contextScope?.workspaceLabel
        });
      }
      if (useConversationContext && !autopilotSession) {
        learnFromContext({
          activeWindowContext,
          rawPrompt: text,
          refined: result.refined,
          scope: contextScope
        });
      }
      if (!autopilotSession) {
        recordProductEvent('optimization', { context: useConversationContext });
      }
      clipboard.writeText(result.refined);
      reportProgress('Returning to original input...');
      const insertion = await replaceActiveInputText(targetWindowHandle, activeInput.descriptor, result.refined);
      logDebug(`[Shortcuts] Paste ${insertion.success ? 'verified' : 'failed'} attempts=${insertion.attempts}`);
      logDebug(`[Performance] totalMs=${Date.now() - commandStartedAt} modelMs=${result.durationMs ?? 'n/a'} insertionMethod=${insertion.method || 'verified-uia'}`);
      reportProgress(insertion.success
        ? 'Optimized prompt inserted.'
        : 'Optimized prompt copied. Automatic insertion needs focus.');
      let ideResult = null;
      if (config.autoSendToIDE === true && config.selectedIDE !== 'none') {
        ideResult = await sendToIDE(config.selectedIDE, result.refined, { announce: false });
        if (ideResult.error) logDebug(`[IDE] Automatic handoff failed: ${ideResult.error}`);
      }
      mainWindow?.webContents.send('notification', {
        type: insertion.success ? 'success' : 'warning',
        message: insertion.success
          ? useConversationContext
            ? `${autopilotRun ? `Autopilot selected ${autopilotRun.result.best.title} (${Math.round(autopilotRun.result.best.qualityScore * 100)}%). ` : ''}Prompt inserted. RAG grade: ${ragResult?.diagnostics?.retrievalGrade || 'live context only'}${ideResult?.success ? ` and sent to ${ideResult.ide}` : ''}.`
            : 'Optimized prompt inserted into active input.'
          : 'Prompt copied, but the active textbox could not be replaced. Press Ctrl+V to insert it.'
      });
    }
  } catch (e) {
    showMainWindow();
    mainWindow?.webContents.send('notification', { type: 'error', message: e.message });
  } finally {
    isRefining = false;
    mainWindow?.webContents.send('refine-stop');
  }
}

function registerShortcut(shortcut, action) {
  if (globalShortcut.isRegistered(shortcut.accelerator)) return true;
  const registered = globalShortcut.register(shortcut.accelerator, action);
  logDebug(`[Shortcuts] ${shortcut.label}: ${registered ? 'registered' : 'failed'}`);
  return registered;
}

function unregisterShortcut(shortcut) {
  if (!globalShortcut.isRegistered(shortcut.accelerator)) return;
  globalShortcut.unregister(shortcut.accelerator);
  logDebug(`[Shortcuts] ${shortcut.label}: unregistered`);
}

function registerActionShortcuts() {
  const registrations = [
    { shortcut: SHORTCUTS.optimize, action: () => optimizeActiveInput(false) },
    { shortcut: SHORTCUTS.context, action: () => optimizeActiveInput(true) }
  ];
  return registrations
    .filter(({ shortcut, action }) => !registerShortcut(shortcut, action))
    .map(({ shortcut }) => shortcut.label);
}

function unregisterActionShortcuts() {
  unregisterShortcut(SHORTCUTS.optimize);
  unregisterShortcut(SHORTCUTS.context);
}

function getShortcutState() {
  return {
    enabled: optimizerEnabled,
    hotkeys: {
      optimize: SHORTCUTS.optimize.label,
      context: SHORTCUTS.context.label,
      toggle: SHORTCUTS.toggle.label
    },
    registered: {
      optimize: globalShortcut.isRegistered(SHORTCUTS.optimize.accelerator),
      context: globalShortcut.isRegistered(SHORTCUTS.context.accelerator),
      toggle: globalShortcut.isRegistered(SHORTCUTS.toggle.accelerator)
    }
  };
}

function broadcastOptimizerState() {
  mainWindow?.webContents.send('optimizer-state-changed', getShortcutState());
}

function setOptimizerEnabled(enabled, { persist = true, announce = true } = {}) {
  optimizerEnabled = Boolean(enabled);
  if (persist) saveConfig({ optimizerEnabled });

  const failed = registerActionShortcuts();

  updateTrayMenu();
  broadcastOptimizerState();
  logDebug(`[Shortcuts] Optimizer ${optimizerEnabled ? 'enabled' : 'paused'}; toggle remains active`);

  if (failed.length) {
    notifyInBackground('error', `Optimizer enabled, but shortcut registration failed: ${failed.join(', ')}.`);
  } else if (announce) {
    notifyInBackground(
      optimizerEnabled ? 'success' : 'info',
      optimizerEnabled
        ? `Optimizer enabled. ${SHORTCUTS.optimize.label} and ${SHORTCUTS.context.label} are active.`
        : `Optimizer paused. Press ${SHORTCUTS.toggle.label} to enable it again.`
    );
  }
  return getShortcutState();
}

function toggleOptimizer() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    logDebug('[Shortcuts] Toggle ignored because the previous toggle is still settling');
    return getShortcutState();
  }
  lastToggleAt = now;
  return setOptimizerEnabled(!optimizerEnabled);
}

function registerGlobalShortcuts() {
  const toggleRegistered = registerShortcut(SHORTCUTS.toggle, () => toggleOptimizer());
  const failed = registerActionShortcuts();

  updateTrayMenu();
  broadcastOptimizerState();

  if (!toggleRegistered) {
    notify('error', `Toggle shortcut ${SHORTCUTS.toggle.label} could not be registered.`);
  }
  if (failed.length) {
    notify('error', `Shortcut not registered: ${failed.join(', ')}. Another app may be using it.`);
  } else if (optimizerEnabled) {
    notify('success', `${SHORTCUTS.optimize.label} and ${SHORTCUTS.context.label} are ready. ${SHORTCUTS.toggle.label} pauses or resumes them.`);
  } else {
    notify('info', `Optimizer is paused. ${SHORTCUTS.toggle.label} remains active.`);
  }
}

async function sendToIDE(ide, prompt, options = {}) {
  const validation = validateRefinedOutput(prompt);
  if (!validation.valid) return { error: validation.error || 'The prompt is not valid for IDE handoff.' };
  if (!ide || ide === 'none') return { error: 'Select an IDE before sending the prompt.' };

  try {
    let result;
    switch (ide) {
      case 'codex':
        result = await injectToCodex(validation.value);
        break;
      case 'vscode':
        clipboard.writeText(validation.value);
        await shell.openExternal('vscode://');
        result = { response: 'VS Code opened and the optimized prompt was copied to the clipboard.' };
        break;
      case 'cursor':
        clipboard.writeText(validation.value);
        await shell.openExternal('cursor://');
        result = { response: 'Cursor opened and the optimized prompt was copied to the clipboard.' };
        break;
      case 'antigravity':
        result = await runAntigravity(validation.value, loadConfig());
        break;
      case 'opencode':
        result = await injectToOpenCode(validation.value);
        break;
      case 'claude':
        result = await sendToClaude(validation.value, 'Execute the supplied optimized software task carefully and report verification results.');
        break;
      default:
        return { error: `Unsupported IDE integration: ${ide}` };
    }
    if (result?.error) throw new Error(result.error);

    recordProductEvent('ide-handoff');
    const response = String(result?.response || '').trim().slice(0, 4000);
    const handoff = { success: true, ide, response };
    if (options.announce !== false) notifyInBackground('success', `Prompt sent to ${ide}.`);
    return handoff;
  } catch (e) {
    const error = `Failed to send to ${ide}: ${e.message}`;
    if (options.announce !== false) notifyInBackground('error', error);
    return { error, ide };
  }
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (event, updates = {}) => {
  const saved = saveConfig(updates);
  if (Object.prototype.hasOwnProperty.call(updates, 'optimizerEnabled')) {
    setOptimizerEnabled(saved.optimizerEnabled, { persist: false, announce: false });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'launchAtStartup')) {
    applyLaunchAtStartup(saved.launchAtStartup);
  }
  return loadConfig();
});
ipcMain.handle('get-shortcut-state', () => getShortcutState());
ipcMain.handle('set-optimizer-enabled', (event, enabled) => setOptimizerEnabled(enabled));
ipcMain.handle('get-product-insights', () => ({
  metrics: getProductMetrics(),
  revenueProjection: getRevenueProjection()
}));
ipcMain.handle('generate-prompt-suggestions', async (event, text, context, options = {}) => {
  if (!optimizerEnabled) {
    return { error: `Optimizer is paused. Press ${SHORTCUTS.toggle.label} to enable it.` };
  }
  const config = loadConfig();
  if (config.promptAutopilotEnabled === false) {
    return { error: 'Prompt Autopilot is disabled in Settings.' };
  }
  if (isRefining) return { error: 'Another optimization is already running.' };

  isRefining = true;
  mainWindow?.webContents.send('refine-start');
  try {
    const run = await runPromptAutopilot(text, context || '', {
      source: 'context-autopilot-ui',
      promptPurpose: options.promptPurpose,
      refinementStyle: options.refinementStyle,
      allowRemoteHyde: true,
      scope: INTERNAL_CONTEXT_SCOPE,
      allowConfiguredProject: true
    });
    return run.error ? { error: run.error } : serializeAutopilotRun(run);
  } catch (error) {
    return { error: error.message };
  } finally {
    isRefining = false;
    mainWindow?.webContents.send('refine-stop');
  }
});
ipcMain.handle('accept-prompt-suggestion', (event, sessionId, suggestionId, options = {}) => (
  acceptAutopilotSuggestion(sessionId, suggestionId, options)
));
ipcMain.handle('send-to-ide', (event, ide, prompt) => sendToIDE(ide, prompt));

ipcMain.handle('choose-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select project folder',
    properties: ['openDirectory']
  });

  if (result.canceled || !result.filePaths[0]) {
    return loadConfig();
  }

  return addProjectToConfig(result.filePaths[0]);
});

ipcMain.handle('set-project-root', (event, projectRoot) => {
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    return { error: 'Project folder does not exist.' };
  }
  if (!isProjectRoot(projectRoot)) {
    return { error: 'Folder does not look like a project. Choose a folder with .git, README, package.json, pyproject.toml, go.mod, etc.' };
  }
  return addProjectToConfig(projectRoot);
});

ipcMain.handle('bind-project-to-last-context', () => {
  const config = loadConfig();
  const scopeId = String(config.lastContextScope?.id || '');
  const projectRoot = String(config.projectRoot || '');
  if (!scopeId) {
    return { error: `Use ${SHORTCUTS.context.label} once in the target workspace before creating a binding.` };
  }
  if (!projectRoot || !isProjectRoot(projectRoot)) {
    return { error: 'Select a valid project folder before creating a workspace binding.' };
  }
  return saveConfig({
    workspaceProjectBindings: {
      ...(config.workspaceProjectBindings || {}),
      [scopeId]: path.resolve(projectRoot)
    }
  });
});

ipcMain.handle('unbind-project-from-last-context', () => {
  const config = loadConfig();
  const scopeId = String(config.lastContextScope?.id || '');
  if (!scopeId) return { error: 'No detected workspace is available.' };
  const bindings = { ...(config.workspaceProjectBindings || {}) };
  delete bindings[scopeId];
  return saveConfig({ workspaceProjectBindings: bindings });
});

ipcMain.handle('verify-key', async (event, apiKey) => {
  return verifyApiKey(apiKey);
});

ipcMain.handle('refine-text', async (event, text, context, options) => {
  if (!optimizerEnabled) {
    return { error: `Optimizer is paused. Press ${SHORTCUTS.toggle.label} to enable it.` };
  }
  let effectiveContext = context;
  let ragResult = null;
  if (options?.forceContext) {
    ragResult = await buildCombinedContext(context || '', text, {
      allowRemoteHyde: true,
      scope: INTERNAL_CONTEXT_SCOPE,
      allowConfiguredProject: true
    });
    effectiveContext = ragResult.context;
  }

  const result = await refinePrompt(text, effectiveContext, options);
  if (result.refined) {
    appendPromptHistory({
      source: options?.forceContext ? 'context-ui' : 'ui',
      prompt: text,
      refined: result.refined,
      scopeId: options?.forceContext ? INTERNAL_CONTEXT_SCOPE.id : '',
      appId: options?.forceContext ? INTERNAL_CONTEXT_SCOPE.appId : '',
      workspaceLabel: ''
    });
    if (options?.forceContext) {
      learnFromContext({
        activeWindowContext: context || '',
        rawPrompt: text,
        refined: result.refined,
        scope: INTERNAL_CONTEXT_SCOPE
      });
    }
    recordProductEvent('optimization', { context: options?.forceContext === true });
  }
  return {
    ...result,
    rag: ragResult?.diagnostics || null
  };
});

ipcMain.handle('get-context-preview', async (event, manualContext) => {
  const ragResult = await buildCombinedContext(manualContext || '', manualContext || '', {
    allowRemoteHyde: false,
    reportProgress: false,
    scope: INTERNAL_CONTEXT_SCOPE,
    allowConfiguredProject: true
  });
  const context = ragResult.context;
  const stats = {
    ...getMemoryStats(),
    cache: getCacheStats(),
    lastPipeline: ragResult.diagnostics
  };
  const preview = context.length > 12000 ? `${context.slice(0, 12000)}\n... [preview truncated]` : context;
  return {
    length: context.length,
    preview,
    stats
  };
});

ipcMain.handle('get-memory-stats', () => ({
  ...getMemoryStats(),
  cache: getCacheStats(),
  lastPipeline: lastPipelineDiagnostics
}));
ipcMain.handle('clear-memory', () => {
  const memory = clearMemory();
  const cache = clearPipelineCache();
  lastPipelineDiagnostics = null;
  return { ...memory, cache, lastPipeline: null };
});

ipcMain.handle('optimize-clipboard', async () => {
  if (!optimizerEnabled) {
    return { error: `Optimizer is paused. Press ${SHORTCUTS.toggle.label} to enable it.` };
  }
  const text = clipboard.readText();
  if (!text || text.trim().length < 3) {
    return { error: 'Clipboard is empty or too short.' };
  }
  return refinePrompt(text);
});

ipcMain.handle('get-clipboard', () => clipboard.readText());
ipcMain.handle('set-clipboard', (event, text) => clipboard.writeText(text));

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('close-window', () => mainWindow?.hide());
ipcMain.handle('quit-app', () => { app.isQuitting = true; app.quit(); });

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.promptoptimizer.desktop');
  applyLaunchAtStartup();
  registerGlobalShortcuts();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // This is a tray application. It should remain available after its window closes.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
