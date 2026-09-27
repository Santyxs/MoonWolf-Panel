'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PANEL_URL = 'https://moonwolf-panel.onrender.com';
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');

const CLOUD_PATH = '/socket.io';
const VERSION = typeof __AGENT_VERSION__ !== 'undefined' ? __AGENT_VERSION__ : 'dev';
const LOCAL_PORT = 3000;
const AGENT_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const LOCAL_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const DEFAULT_SERVER_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(os.homedir(), 'MoonWolf');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');
const FORWARD_TIMEOUT_MS = 120_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_REPO = 'Santyxs/MoonWolf-Panel';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_DIR = path.join(os.tmpdir(), 'MoonWolf-Update');

const NATIVE_ASSET = 'native/webview.win32-x64-msvc.node';
const WEBVIEW_DATA_DIR = path.join(CONFIG_DIR, 'WebView2Data');
const UI_ASSETS = {
  '/': 'ui/index.html',
  '/index.html': 'ui/index.html',
  '/style.css': 'ui/style.css',
  '/app.js': 'ui/app.js',
};

const CSP_AGENT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TRAY_ICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABNElEQVR42s2XsQ6CMBRF+yf8mAmTq7OrswMxcXBz0w/wC4yzYdLJwbg5MZiIGkjtJWiwgZZC+yrJiaDUe9v32r4yVrmmg3sgiASxgFsmLv87YHWX+CEUJA6EZaAR1olzYsLqsCceDCRFOMq4cE9EzFHCtU5MZtpoOU75Zv7k2/WLz4b9TbQ2ANHrOefpjRfg2cYoaA2gl6d99hUGh11mLQxMJ3455j/iYDFKaQzIPbfde6UBxFgWB0g+EgPVhKuymjzcG8BUqxMnM9A0/GQhgEiTAZIkVBkgmYaqEJAsRKokJFuKm6ah7YQ0XohkYBTvyjsjntvslsZLsc4M2nw+nW1GOtCmba3QaTtWgXdNCpXOBUlTLjiriOpKMoB7fNdnFngvSr2X5X4PJt6PZn9xOPV5PH8DKeu0vPehIOQAAAAASUVORK5CYII=', 'base64');

let getAsset = null;
let isStandalone = false;

try {
  const sea = require('node:sea');
  if (typeof sea.getAsset === 'function') {
    getAsset = sea.getAsset;
    isStandalone = true;
  }
} catch {}

function prepareNativeAddon() {
  if (!isStandalone || !getAsset) return;

  const runtimeDir = path.join(os.tmpdir(), 'MoonWolf-Agent', 'webviewjs');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const nativePath = path.join(runtimeDir, 'webview.win32-x64-msvc.node');

  try {
    if (!fs.existsSync(nativePath)) {
      fs.writeFileSync(nativePath, Buffer.from(getAsset(NATIVE_ASSET)));
    }
  } catch (error) {
    throw new Error(`No se pudo preparar WebViewJS: ${error.message}`);
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nativePath;
}

prepareNativeAddon();

const { Application } = require('@webviewjs/webview');

let app = null;
let window = null;
let webview = null;
let tray = null;
let notifyTimer = null;
let lastStateJson = null;
let isQuitting = false;

let stateProvider = () => ({
  version: '1.0.0',
  token: '',
  serverDir: '',
  configPath: '',
  cloudConnected: false,
  localServerReady: false,
  logs: [],
});

let actions = {};

function decodePngRgba(png) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (!png.subarray(0, 8).equals(signature)) {
    throw new Error('El icono de MoonWolf no es un PNG válido.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > png.length) {
      throw new Error('PNG de MoonWolf corrupto.');
    }

    const data = png.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width !== 32 || height !== 32) {
    throw new Error(`Tamaño de icono no compatible: ${width}x${height}.`);
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`Formato PNG no compatible: bitDepth=${bitDepth}, colorType=${colorType}.`);
  }

  if (interlaceMethod !== 0) {
    throw new Error('PNG entrelazado no compatible.');
  }

  const compressed = Buffer.concat(idat);
  const raw = zlib.inflateSync(compressed);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expectedLength = height * (stride + 1);

  if (raw.length !== expectedLength) {
    throw new Error(`Datos PNG inesperados: ${raw.length} bytes, esperados ${expectedLength}.`);
  }

  const rgba = Buffer.alloc(width * height * 4);

  let rawOffset = 0;
  let outputOffset = 0;

  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];

    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset++];

      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;

      let reconstructed;

      switch (filterType) {
        case 0: reconstructed = value; break;
        case 1: reconstructed = value + left; break;
        case 2: reconstructed = value + up; break;
        case 3: reconstructed = value + Math.floor((left + up) / 2); break;
        case 4: reconstructed = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Filtro PNG no compatible: ${filterType}.`);
      }

      current[x] = reconstructed & 0xff;
    }

    current.copy(rgba, outputOffset);
    outputOffset += stride;

    current.copy(previous);
  }

  return { data: rgba, width, height };
}

function applyWindowIcon() {
  if (!window) return;

  try {
    const icon = decodePngRgba(TRAY_ICON_PNG);

    if (typeof window.setWindowIcon === 'function') {
      window.setWindowIcon(icon.data, icon.width, icon.height);
    }

    if (process.platform === 'win32') {
      if (typeof window.setTaskbarIcon === 'function') {
        window.setTaskbarIcon(icon.data, icon.width, icon.height);
      }
    }
  } catch (error) {
    console.warn(`No se pudo aplicar el icono de MoonWolf: ${error.message}`);
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';

  return 'application/octet-stream';
}

function readUiAsset(assetName) {
  if (isStandalone && getAsset) {
    try {
      return Buffer.from(getAsset(assetName)).toString('utf8');
    } catch {}
  }

  const filePath = path.join(__dirname, assetName);
  return fs.readFileSync(filePath, 'utf8');
}

function openUrl(url) {
  try { execFile('explorer.exe', [url], { windowsHide: true }); } catch {}
}

function openFolder(folder) {
  if (!folder) return;
  try { execFile('explorer.exe', [folder], { windowsHide: true }); } catch {}
}

function openConfigFolder(configPath) {
  const folder = path.dirname(configPath || CONFIG_DIR);
  try { execFile('explorer.exe', [folder], { windowsHide: true }); } catch {}
}

function hideToTray() {
  if (!tray || !window) return false;

  try { window.hide(); return true; } catch { return false; }
}

function showFromTray() {
  if (!window) return false;

  try {
    window.show();
    window.setMinimized(false);
    window.focus();
    return true;
  } catch {
    return false;
  }
}

function quitApp() {
  if (isQuitting) return;
  isQuitting = true;

  try { actions.onQuit?.(); } catch (error) {
    console.error('[app] onQuit falló:', error?.message || error);
  }

  try { tray?.dispose(); } catch (error) {
    console.error('[app] tray.dispose falló:', error?.message || error);
  }

  try { app?.exit(); } catch (error) {
    console.error('[app] app.exit falló:', error?.message || error);
  }

  setImmediate(() => {
    try { process.exit(0); } catch {}
  });
}

function createTray() {
  if (!app || tray) return;

  try {
    tray = app.createTrayIcon({
      id: 'moonwolf-agent',
      icon: { data: TRAY_ICON_PNG },
      tooltip: 'MoonWolf Agent',
      menu: {
        items: [
          { id: 'tray-open', label: 'Abrir MoonWolf Agent' },
          { id: 'tray-quit', label: 'Salir' },
        ],
      },
      menuOnLeftClick: false,
      menuOnRightClick: true,
    });

    tray.on('click', event => {
      const button = String(event?.button || '').toLowerCase();
      const buttonState = String(event?.buttonState || '').toLowerCase();

      if (button && !button.includes('left')) return;
      if (buttonState.includes('down')) return;

      showFromTray();
    });

    tray.on('double-click', showFromTray);
  } catch {
    tray = null;
  }
}

function createWindow() {
  app = new Application();

  window = app.createBrowserWindow({
    title: 'MoonWolf Agent',
    width: 620,
    height: 720,
    minWidth: 560,
    minHeight: 650,
    resizable: true,
    maximizable: false,
    minimizable: true,
    decorations: true,
    focused: true,
  });

  applyWindowIcon();

  window.registerProtocol('moonwolf', async request => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname || '/');

      const assetName = UI_ASSETS[pathname];

      if (!assetName) {
        return new Response('Not found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Security-Policy': CSP_AGENT,
          },
        });
      }

      return new Response(readUiAsset(assetName), {
        status: 200,
        headers: {
          'Content-Type': mimeType(assetName),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': CSP_AGENT,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch (error) {
      return new Response(`MoonWolf UI error: ${error.message}`, {
        status: 500,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Security-Policy': CSP_AGENT,
        },
      });
    }
  });

  fs.mkdirSync(WEBVIEW_DATA_DIR, { recursive: true });

  const webContext = app.createWebContext({
    dataDirectory: WEBVIEW_DATA_DIR,
  });

  webview = window.createWebview({
    url: 'moonwolf://localhost/index.html',
    enableDevtools: false,
    webContext,
  });

  if (typeof webview.on === 'function') {
    webview.on('error', error => {
      console.error('[webview] error:', error?.message || error);
    });

    webview.on('crashed', () => {
      console.error('[webview] proceso de renderizado crasheado.');
    });

    webview.on('unresponsive', () => {
      console.warn('[webview] no responde.');
    });

    webview.on('responsive', () => {
      console.log('[webview] vuelve a responder.');
    });
  }

  webview.expose('native', {
    getState: () => stateProvider(),

    openPanel: () => {
      openUrl(PANEL_URL);
      return true;
    },

    openServerFolder: () => {
      openFolder(stateProvider().serverDir);
      return true;
    },

    openConfig: () => {
      openConfigFolder(stateProvider().configPath);
      return true;
    },

    setServerDir: dir =>
      typeof actions.setServerDir === 'function'
        ? actions.setServerDir(dir)
        : { ok: false, error: 'No disponible.' },

    clearLogs: () =>
      typeof actions.clearLogs === 'function' &&
      actions.clearLogs(),

    saveLogs: () =>
      typeof actions.saveLogs === 'function' &&
      actions.saveLogs(),

    hideToTray: () => hideToTray(),

    restart: () =>
      typeof actions.restart === 'function' &&
      actions.restart(),

    checkForUpdates: () =>
      typeof actions.checkForUpdates === 'function' &&
      actions.checkForUpdates(),

    applyUpdate: () =>
      typeof actions.applyUpdate === 'function'
        ? actions.applyUpdate()
        : { ok: false, error: 'No disponible.' },

    close: () => {
      quitApp();
      return true;
    },
  });

  window.on('resize', () => {
    try {
      if (window.isMinimized()) hideToTray();
    } catch {}
  });

  window.on('close', event => {
    if (isQuitting) return;

    try { event?.preventDefault?.(); } catch {}

    quitApp();
  });

  window.on('error', error => {
    console.error('[window] error:', error?.message || error);
  });

  app.on('application-close-requested', () => quitApp());

  app.on('custom-menu-click', event => {
    const id = event?.customMenuEvent?.id;

    if (id === 'tray-open') showFromTray();
    if (id === 'tray-quit') quitApp();
  });

  const ready =
    typeof app.whenReady === 'function'
      ? app.whenReady({ autoRun: false })
      : null;

  app.run({ interval: 16, ref: true });

  if (ready) {
    ready.then(createTray).catch(() => {});
  }
}

function notifyStateChanged() {
  notifyTimer = null;

  if (!webview) return;

  let stateJson;

  try {
    stateJson = JSON.stringify(stateProvider());
  } catch {
    return;
  }

  if (stateJson === lastStateJson) return;

  lastStateJson = stateJson;

  const safeJson = stateJson
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const script =
    `window.dispatchEvent(new CustomEvent(` +
    `'moonwolf-state', { detail: ${safeJson} }));`;

  try { webview.evaluateScript(script); } catch {}
}

function scheduleStateChanged() {
  if (notifyTimer !== null) return;

  notifyTimer = setTimeout(notifyStateChanged, 100);
}

function startGui(getState, guiActions = {}) {
  stateProvider = getState;
  actions = guiActions;

  createWindow();

  setTimeout(notifyStateChanged, 300);

  return {
    update: scheduleStateChanged,
    close: () => quitApp(),
  };
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function makeSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function loadConfig() {
  ensureConfigDir();

  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}

  if (!config.agentId || typeof config.agentId !== 'string') {
    config.agentId = crypto.randomUUID();
  }

  if (!AGENT_TOKEN_RE.test(config.agentToken || '')) {
    config.agentToken = makeSecret();
  }

  if (!LOCAL_TOKEN_RE.test(config.localToken || '')) {
    config.localToken = makeSecret();
  }

  if (!config.serverDir) {
    config.serverDir = DEFAULT_SERVER_DIR;
  }

  if (typeof config.autoStart !== 'boolean') {
    config.autoStart = false;
  }

  delete config.token;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForLocalServer(localUrl) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const response = await fetch(`${localUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });

      if (response.ok) return;
    } catch {}

    await wait(Math.min(250 * attempt, 1500));
  }

  throw new Error('El servidor local de MoonWolf no respondió a tiempo.');
}

function startEmbeddedLocalServer(config) {
  process.env.MOONWOLF_SERVER_DIR = config.serverDir;
  process.env.MOONWOLF_PORT = String(LOCAL_PORT);
  process.env.MOONWOLF_LOCAL_AUTH_TOKEN = config.localToken;

  require('../server.js');
}

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }

  return 0;
}

async function checkForUpdate(currentVersion) {
  const response = await fetch(UPDATE_API, {
    headers: {
      'User-Agent': 'MoonWolf-Agent',
      'Accept': 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}`);
  }

  const release = await response.json();
  const match = String(release.tag_name || '').match(/^agent-v(.+)$/);

  if (!match) return null;

  const latest = match[1];

  if (compareVersions(currentVersion, latest) >= 0) {
    return null;
  }

  const asset = (release.assets || []).find(a => /\.exe$/i.test(a.name));

  if (!asset) return null;

  return {
    version: latest,
    url: asset.browser_download_url,
    size: asset.size || 0,
    name: asset.name,
    published: release.published_at || null,
  };
}

async function downloadUpdate(info, onProgress) {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });

  const dest = path.join(UPDATE_DIR, `MoonWolf-Agent-${info.version}.exe`);

  try { fs.unlinkSync(dest); } catch {}

  const response = await fetch(info.url, {
    headers: { 'User-Agent': 'MoonWolf-Agent' },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Descarga HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || info.size || 0;
  const fileStream = fs.createWriteStream(dest);

  let received = 0;
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.length;
      fileStream.write(value);

      if (onProgress && total > 0) {
        onProgress(Math.min(100, Math.round((received / total) * 100)));
      }
    }
  } finally {
    await new Promise(resolve => fileStream.end(resolve));
  }

  const stat = fs.statSync(dest);

  if (stat.size < 1024 * 1024) {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error('El archivo descargado es demasiado pequeño.');
  }

  return dest;
}

function applyUpdate(downloadedPath) {
  if (process.platform !== 'win32') {
    throw new Error('La auto-actualización solo está disponible en Windows.');
  }

  if (!fs.existsSync(downloadedPath)) {
    throw new Error('El archivo descargado no existe.');
  }

  const currentExe = process.execPath;

  if (!/\.exe$/i.test(currentExe)) {
    throw new Error('El Agent no se está ejecutando como ejecutable.');
  }

  const scriptPath = path.join(UPDATE_DIR, `apply-${Date.now()}.bat`);

  const script = [
    '@echo off',
    'setlocal',
    '',
    'set "TARGET_PID=%~1"',
    'set "SRC=%~2"',
    'set "DST=%~3"',
    '',
    ':wait',
    'tasklist /FI "PID eq %TARGET_PID%" /NH 2>NUL | findstr /R /C:"%TARGET_PID%" >NUL',
    'if errorlevel 1 goto :replace',
    'ping -n 2 127.0.0.1 >NUL',
    'goto :wait',
    '',
    ':replace',
    'ping -n 2 127.0.0.1 >NUL',
    'move /Y "%DST%" "%DST%.old" >NUL 2>&1',
    'move /Y "%SRC%" "%DST%" >NUL 2>&1',
    'if errorlevel 1 (',
    '  move /Y "%DST%.old" "%DST%" >NUL 2>&1',
    '  exit /b 1',
    ')',
    'del "%DST%.old%" >NUL 2>&1',
    'start "" "%DST%"',
    'del "%~f0" >NUL 2>&1',
  ].join('\r\n');

  fs.writeFileSync(scriptPath, script, 'utf8');

  const child = spawn(
    'cmd.exe',
    ['/c', scriptPath, String(process.pid), downloadedPath, currentExe],
    {
      windowsHide: true,
      stdio: 'ignore',
    }
  );

  child.unref();

  return true;
}

function cleanUpdateDir() {
  try {
    if (!fs.existsSync(UPDATE_DIR)) return;

    const now = Date.now();
    const MAX_AGE = 24 * 60 * 60 * 1000;

    for (const entry of fs.readdirSync(UPDATE_DIR)) {
      const full = path.join(UPDATE_DIR, entry);

      try {
        const stat = fs.statSync(full);

        if (now - stat.mtimeMs > MAX_AGE) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

async function main() {
  const config = loadConfig();
  const localUrl = `http://127.0.0.1:${LOCAL_PORT}`;

  let localServerReady = false;
  let cloudConnected = false;
  let localSocket = null;
  let cloudSocket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let updateCheckTimer = null;
  let updateNoticeTimer = null;
  let shuttingDown = false;
  let gui = null;
  let pairingCode = '';
  let pairingExpiresAt = 0;
  let pendingRestart = false;

  let updateAvailable = null;
  let updateStatus = 'idle';
  let updateProgress = 0;
  let updateError = null;
  let updateFilePath = null;
  let updateNotice = null;

  const logs = [];
  const MAX_LOGS = 500;

  cleanUpdateDir();

  function addLog(message, level = 'info') {
    logs.push({
      time: new Date().toISOString(),
      level,
      message: String(message),
    });

    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }

    gui?.update();
  }

  function logError(error, context = 'Error') {
    addLog(`${context}: ${error?.stack || error?.message || error}`, 'error');
  }

  function setUpdateNotice(message, type = 'info', ttl = 3500) {
    updateNotice = { message, type };

    clearTimeout(updateNoticeTimer);
    updateNoticeTimer = setTimeout(() => {
      updateNotice = null;
      gui?.update();
    }, ttl);

    gui?.update();
  }

  const getState = () => ({
    version: VERSION,
    agentId: config.agentId,
    pairingCode: pairingCode || '',
    pairingExpiresAt,
    serverDir: config.serverDir || '',
    configPath: CONFIG_PATH,
    cloudConnected,
    localServerReady,
    restartRequired: pendingRestart,
    updateAvailable,
    updateStatus,
    updateProgress,
    updateError,
    updateNotice,
    logs,
  });

  async function startUpdateDownload() {
    if (!updateAvailable || updateStatus === 'downloading' || updateStatus === 'ready' || updateStatus === 'installing') {
      return;
    }

    updateStatus = 'downloading';
    updateProgress = 0;
    updateError = null;
    updateFilePath = null;
    gui?.update();

    addLog(`Descargando actualización v${updateAvailable.version}...`);

    try {
      updateFilePath = await downloadUpdate(updateAvailable, progress => {
        updateProgress = progress;
        gui?.update();
      });

      updateStatus = 'ready';
      updateProgress = 100;
      addLog(`Actualización v${updateAvailable.version} lista para instalar.`);
      setUpdateNotice(`Actualización v${updateAvailable.version} descargada y lista`, 'ok', 5000);
    } catch (error) {
      updateStatus = 'error';
      updateError = error.message;
      updateFilePath = null;
      logError(error, 'Error descargando actualización');
      setUpdateNotice(`Error descargando actualización: ${error.message}`, 'err', 5000);
    }

    gui?.update();
  }

  async function runUpdateCheck() {
    if (shuttingDown) return;

    addLog(`Buscando actualizaciones (actual: v${VERSION})...`);

    try {
      const info = await checkForUpdate(VERSION);

      if (!info) {
        updateAvailable = null;
        updateStatus = 'idle';
        updateProgress = 0;
        updateError = null;
        updateFilePath = null;

        addLog(`No hay actualizaciones. Versión actual: v${VERSION}.`);
        setUpdateNotice(`Ya tienes la última versión · v${VERSION}`, 'ok');

        gui?.update();
        return;
      }

      if (updateAvailable && updateAvailable.version === info.version && updateStatus !== 'error') {
        addLog(`Actualización v${info.version} ya detectada.`);
        setUpdateNotice(`Actualización v${info.version} ya detectada`, 'info');
        return;
      }

      updateAvailable = info;
      updateStatus = 'idle';
      updateProgress = 0;
      updateError = null;

      addLog(`Actualización disponible: v${info.version} (actual: v${VERSION}).`);
      gui?.update();

      startUpdateDownload();
    } catch (error) {
      updateStatus = 'error';
      updateError = error.message;
      logError(error, 'Error buscando actualización');
      setUpdateNotice(`Error buscando actualización: ${error.message}`, 'err', 5000);
      gui?.update();
    }
  }

  function scheduleUpdateCheck() {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = setTimeout(() => {
      runUpdateCheck();
      scheduleUpdateCheck();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  function applyUpdateNow() {
    if (updateStatus === 'error') {
      updateStatus = 'idle';
      updateError = null;
      updateFilePath = null;
      gui?.update();

      startUpdateDownload();

      return { ok: true };
    }

    if (updateStatus !== 'ready' || !updateFilePath) {
      return { ok: false, error: 'La actualización aún no está lista.' };
    }

    try {
      updateStatus = 'installing';
      gui?.update();

      addLog(`Aplicando actualización v${updateAvailable.version}...`);
      setUpdateNotice('Aplicando actualización… el agent se reiniciará', 'info', 3000);

      applyUpdate(updateFilePath);

      addLog('Cerrando para aplicar la actualización...');
      gui?.update();

      setTimeout(() => {
        try { shutdown(); } catch {}
        process.exit(0);
      }, 500);

      return { ok: true };
    } catch (error) {
      updateStatus = 'error';
      updateError = error.message;
      logError(error, 'Error aplicando actualización');
      setUpdateNotice(`Error aplicando actualización: ${error.message}`, 'err', 5000);
      gui?.update();
      return { ok: false, error: error.message };
    }
  }

  gui = startGui(getState, {
    onQuit: () => {
      shutdown();
    },

    clearLogs: () => {
      logs.length = 0;
      addLog('Registro de logs limpiado.');
      return true;
    },

    saveLogs: () => {
      ensureConfigDir();

      const logPath = path.join(CONFIG_DIR, 'agent.log');
      const content = logs
        .map(entry => `[${new Date(entry.time).toLocaleString('es-ES')}] [${entry.level.toUpperCase()}] ${entry.message}`)
        .join('\n\n');

      fs.writeFileSync(logPath, content + (content ? '\n' : ''), 'utf8');
      return logPath;
    },

    setServerDir: newDir => {
      const trimmed = String(newDir || '').trim();

      if (!trimmed) {
        return { ok: false, error: 'La ruta no puede estar vacía.' };
      }

      const resolved = path.resolve(trimmed);

      if (resolved === path.resolve(config.serverDir || '')) {
        return { ok: true, changed: false, serverDir: resolved };
      }

      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch (error) {
        return { ok: false, error: `No se pudo crear la carpeta: ${error.message}` };
      }

      config.serverDir = resolved;

      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      } catch (error) {
        return { ok: false, error: `No se pudo guardar la configuración: ${error.message}` };
      }

      pendingRestart = true;

      addLog(
        `Carpeta del servidor actualizada a: ${resolved}. ` +
        'Es necesario reiniciar MoonWolf Agent para aplicar el cambio.',
        'warn'
      );
      gui.update();

      return {
        ok: true,
        changed: true,
        serverDir: resolved,
        restartRequired: true,
        message: 'Cierra y vuelve a abrir MoonWolf Agent para aplicar el cambio.',
      };
    },

    restart: () => {
      addLog('Reinicio solicitado desde la interfaz.', 'warn');
      shutdown();

      setImmediate(() => {
        try { process.exit(0); } catch {}
      });

      return true;
    },

    checkForUpdates: () => {
      runUpdateCheck();
      return true;
    },

    applyUpdate: () => applyUpdateNow(),
  });

  addLog(`MoonWolf Agent v${VERSION} iniciado.`);
  addLog(`Agent ID: ${config.agentId}`);

  try {
    addLog('Iniciando servidor local...');
    startEmbeddedLocalServer(config);
  } catch (error) {
    logError(error, 'No se pudo iniciar el servidor local');
    throw error;
  }

  try {
    await waitForLocalServer(localUrl);
    localServerReady = true;
    addLog('Servidor local iniciado correctamente.');
    gui.update();
  } catch (error) {
    localServerReady = false;
    logError(error, 'El servidor local no respondió');
    gui.update();
    throw error;
  }

  async function forwardHttp(request) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    try {
      const method = request.method || 'GET';
      const body = request.body !== undefined && request.body !== null ? JSON.stringify(request.body) : undefined;

      const response = await fetch(`${localUrl}${request.path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
        signal: controller.signal,
      });

      const bytes = Buffer.from(await response.arrayBuffer());

      return {
        id: request.id,
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        bodyBase64: bytes.toString('base64'),
      };
    } catch (error) {
      const isTimeout = error?.name === 'AbortError';

      logError(
        error,
        isTimeout
          ? `Timeout (${FORWARD_TIMEOUT_MS / 1000}s) reenviando petición`
          : 'Error reenviando petición'
      );

      return {
        id: request.id,
        ok: false,
        status: isTimeout ? 504 : 502,
        data: {
          ok: false,
          error: isTimeout
            ? `El servidor local no respondió en ${FORWARD_TIMEOUT_MS / 1000}s.`
            : error.message,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function clearPairing() {
    pairingCode = '';
    pairingExpiresAt = 0;
    gui?.update();
  }

  function connectLocalSocket() {
    localSocket?.disconnect();

    localSocket = io(localUrl, {
      auth: {
        role: 'local-agent',
        token: config.localToken,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    for (const event of ['status', 'log', 'history', 'stats']) {
      localSocket.on(event, payload => {
        if (cloudSocket?.connected) {
          cloudSocket.emit('event', {
            name: event,
            payload,
          });
        }
      });
    }

    localSocket.on('connect', () => {
      addLog('Socket local conectado.');
    });

    localSocket.on('connect_error', error => {
      addLog(`Error del Socket local: ${error?.message || error}`, 'error');
    });

    localSocket.on('disconnect', reason => {
      addLog(`Socket local desconectado${reason ? `: ${reason}` : '.'}`, 'warn');
    });
  }

  function requestPairingCode() {
    if (!cloudSocket?.connected) return;

    clearPairing();
    addLog('Solicitando código de emparejamiento...');
    cloudSocket.emit('pairing_create');
  }

  function scheduleReconnect() {
    if (shuttingDown) return;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectCloud, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connectCloud() {
    if (shuttingDown) return;

    cloudSocket?.disconnect();
    cloudConnected = false;
    clearPairing();
    addLog('Conectando con MoonWolf Cloud...');
    gui.update();

    cloudSocket = io(PANEL_URL, {
      path: CLOUD_PATH,
      transports: ['websocket'],
      auth: {
        role: 'agent',
        agentId: config.agentId,
        token: config.agentToken,
      },
      reconnection: false,
    });

    cloudSocket.on('connect', () => {
      reconnectDelay = 1000;
      cloudConnected = true;
      addLog('Conectado a MoonWolf Cloud.');
      connectLocalSocket();
      requestPairingCode();
      runUpdateCheck();
      scheduleUpdateCheck();
      gui.update();
    });

    cloudSocket.on('pairing_ready', data => {
      const code = String(data?.code || '');

      if (!PAIRING_CODE_RE.test(code)) {
        addLog('Cloud devolvió un código de emparejamiento inválido.', 'error');
        return;
      }

      pairingCode = code;
      pairingExpiresAt = Number(data?.expiresAt || 0);
      addLog(`Código de emparejamiento disponible: ${code}`);
      gui.update();
    });

    cloudSocket.on('pairing_consumed', () => {
      clearPairing();
      addLog('Código de emparejamiento utilizado. Generando uno nuevo.');
      requestPairingCode();
    });

    cloudSocket.on('rpc', async request => {
      const result = await forwardHttp(request || {});
      cloudSocket?.emit('rpc_result', result);
    });

    cloudSocket.on('connect_error', error => {
      cloudConnected = false;
      clearPairing();
      addLog(`Error de conexión con Cloud: ${error?.message || error}`, 'error');
      gui.update();
    });

    cloudSocket.on('disconnect', reason => {
      cloudConnected = false;
      clearPairing();
      addLog(`Desconectado de MoonWolf Cloud${reason ? `: ${reason}` : '.'}`, 'warn');
      gui.update();
      scheduleReconnect();
    });
  }

  function shutdown() {
    if (shuttingDown) return;

    shuttingDown = true;
    clearTimeout(reconnectTimer);
    clearTimeout(updateCheckTimer);
    clearTimeout(updateNoticeTimer);
    cloudSocket?.disconnect();
    localSocket?.disconnect();
    cloudConnected = false;
    clearPairing();
    addLog('MoonWolf Agent cerrado.');
  }

  process.on('uncaughtException', error => {
    logError(error, 'Error no controlado');
    addLog('El proceso se cerrará para evitar un estado inconsistente.', 'error');

    try { gui?.update(); } catch {}

    setTimeout(() => {
      try { shutdown(); } catch {}
      process.exit(1);
    }, 500);
  });

  process.on('unhandledRejection', reason => {
    logError(reason, 'Promesa rechazada');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown();
      process.exit(0);
    });
  }

  connectCloud();
}

main().catch(error => {
  console.error('❌ MoonWolf Agent:', error.message);
  process.exitCode = 1;
});
