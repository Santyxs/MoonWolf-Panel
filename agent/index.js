'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { startGui } = require('./gui');

const PANEL_URL = 'https://moonwolf-panel.onrender.com';
const CLOUD_PATH = '/socket.io';
const VERSION = '1.0';
const LOCAL_PORT = 3000;
const AGENT_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const LOCAL_TOKEN_RE = /^[A-Za-z0-9_-]{43,}$/;
const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const DEFAULT_SERVER_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(os.homedir(), 'MoonWolf');
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');

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

      if (response.ok) {
        return;
      }
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

async function main() {
  const config = loadConfig();
  const localUrl = `http://127.0.0.1:${LOCAL_PORT}`;

  let localServerReady = false;
  let cloudConnected = false;
  let localSocket = null;
  let cloudSocket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let shuttingDown = false;
  let gui = null;
  let pairingCode = '';
  let pairingExpiresAt = 0;

  const logs = [];
  const MAX_LOGS = 500;

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
    logs,
  });

  gui = startGui(getState, {
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

      addLog(`Carpeta del servidor actualizada a: ${resolved}. Reinicia MoonWolf Agent para aplicar el cambio.`, 'warn');
      gui.update();

      return { ok: true, changed: true, serverDir: resolved, restartRequired: true };
    },
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
    try {
      const method = request.method || 'GET';
      const body = request.body !== undefined && request.body !== null ? JSON.stringify(request.body) : undefined;

      const response = await fetch(`${localUrl}${request.path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
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
      logError(error, 'Error reenviando petición');
      return {
        id: request.id,
        ok: false,
        status: 502,
        data: {
          ok: false,
          error: error.message,
        },
      };
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
    if (shuttingDown) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectCloud, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connectCloud() {
    if (shuttingDown) {
      return;
    }

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
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearTimeout(reconnectTimer);
    cloudSocket?.disconnect();
    localSocket?.disconnect();
    cloudConnected = false;
    clearPairing();
    addLog('MoonWolf Agent cerrado.');
  }

  process.on('uncaughtException', error => {
    logError(error, 'Error no controlado');
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
