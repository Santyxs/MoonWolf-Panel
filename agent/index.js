'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { startGui } = require('./gui');

const PANEL_URL = 'https://moonwolf-panel.onrender.com';
const CLOUD_PATH = '/socket.io';
const VERSION = typeof __AGENT_VERSION__ !== 'undefined' ? __AGENT_VERSION__ : 'dev';

const LOCAL_PORT = 3000;
const AGENT_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const LOCAL_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const DEFAULT_SERVER_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(os.homedir(), 'MoonWolf');
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');
const FORWARD_TIMEOUT_MS = 120_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_REPO = 'Santyxs/MoonWolf-Panel';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_DIR = path.join(os.tmpdir(), 'MoonWolf-Update');

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
      detached: true,
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
    } catch (error) {
      updateStatus = 'error';
      updateError = error.message;
      updateFilePath = null;
      logError(error, 'Error descargando actualización');
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
        gui?.update();
        return;
      }

      if (updateAvailable && updateAvailable.version === info.version && updateStatus !== 'error') {
        addLog(`Actualización v${info.version} ya detectada.`);
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
