'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PANEL_URL = process.env.MOONWOLF_PANEL_URL || 'https://moon-wolf-panel.vercel.app';
const CLOUD_PATH = process.env.MOONWOLF_CLOUD_PATH || '/api/socket-io/socket.io';
const DEFAULT_SERVER_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(os.homedir(), 'MoonWolf');
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');
const TOKEN_RE = /^MW-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function makeToken() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length];
  return `MW-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function loadConfig() {
  ensureConfigDir();
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}

  if (!TOKEN_RE.test(config.token || '')) config.token = makeToken();
  if (!config.serverDir) config.serverDir = DEFAULT_SERVER_DIR;
  if (typeof config.autoStart !== 'boolean') config.autoStart = false;
  if (typeof config.startLocalServer !== 'boolean') config.startLocalServer = false;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function parseEnv(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function findNode() {
  if (process.env.MOONWOLF_NODE) return process.env.MOONWOLF_NODE;
  if (process.platform !== 'win32') return process.execPath;

  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
  }
  if (process.env.ProgramFilesW6432 && process.env.ProgramFilesW6432 !== process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFilesW6432, 'nodejs', 'node.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  }
  candidates.push('node.exe');

  for (const candidate of candidates) {
    if (candidate.endsWith('node.exe') && path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    return candidate;
  }

  return 'node.exe';
}

function spawnLocalServer(config) {
  if (!config.startLocalServer) return null;

  const serverScript = path.join(config.serverDir, 'server.js');
  if (!fs.existsSync(serverScript)) {
    console.error(`[MoonWolf] No existe ${serverScript}; startLocalServer queda desactivado.`);
    return null;
  }

  const child = spawn(findNode(), [serverScript], {
    cwd: config.serverDir,
    env: { ...process.env },
    windowsHide: true,
    stdio: 'ignore',
    detached: false,
  });

  child.on('exit', code => {
    console.log(`[MoonWolf] server.js terminó (${code ?? 'sin código'}).`);
  });
  child.on('error', error => {
    console.error('[MoonWolf] No se pudo arrancar server.js:', error.message);
  });
  return child;
}

async function main() {
  const config = loadConfig();
  const localUrl = process.env.MOONWOLF_LOCAL_URL || 'http://127.0.0.1:3000';
  const env = parseEnv(path.join(config.serverDir, '.env'));
  const panelPassword = process.env.PANEL_PASSWORD || env.PANEL_PASSWORD || '';

  if (env.PANEL_PASSWORD && !process.env.PANEL_PASSWORD) {
    process.env.PANEL_PASSWORD = env.PANEL_PASSWORD;
  }
  if (env.SESSION_SECRET && !process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = env.SESSION_SECRET;
  }

  console.log('');
  console.log('🌙 MoonWolf Agent');
  console.log(`Código: ${config.token}`);
  console.log(`Servidor: ${config.serverDir}`);
  console.log(`Cloud: ${PANEL_URL}`);
  console.log('');

  const localChild = spawnLocalServer(config);
  let localToken = null;
  let localSocket = null;
  let cloudSocket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let shuttingDown = false;

  async function loginLocal() {
    if (localToken) return localToken;
    if (!panelPassword) throw new Error('Falta PANEL_PASSWORD en el .env del servidor.');

    const response = await fetch(`${localUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: panelPassword }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.token) {
      throw new Error(data.error || `Login local rechazado (${response.status})`);
    }
    localToken = data.token;
    return localToken;
  }

  async function forwardHttp(request) {
    try {
      const token = await loginLocal();
      const headers = { Authorization: `Bearer ${token}` };
      if (request.body !== undefined && request.body !== null) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${localUrl}${request.path}`, {
        method: request.method || 'GET',
        headers,
        body:
          request.body !== undefined && request.body !== null
            ? JSON.stringify(request.body)
            : undefined,
      });
      const type = response.headers.get('content-type') || 'application/octet-stream';
      const bytes = Buffer.from(await response.arrayBuffer());

      return {
        id: request.id,
        ok: response.ok,
        status: response.status,
        contentType: type,
        bodyBase64: bytes.toString('base64'),
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        status: 502,
        data: { ok: false, error: error.message },
      };
    }
  }

  function connectLocalSocket() {
    localSocket?.disconnect();
    localSocket = io(localUrl, {
      auth: async callback => {
        try {
          callback({ token: await loginLocal() });
        } catch {
          callback({ token: '' });
        }
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    for (const event of ['status', 'log', 'history', 'stats']) {
      localSocket.on(event, payload => {
        if (cloudSocket?.connected) {
          cloudSocket.emit('event', { name: event, payload });
        }
      });
    }

    localSocket.on('connect_error', error => {
      if (error?.message === 'unauthorized') localToken = null;
    });
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

    cloudSocket = io(PANEL_URL, {
      path: CLOUD_PATH,
      transports: ['websocket'],
      auth: { role: 'agent', token: config.token },
      reconnection: false,
    });

    cloudSocket.on('connect', () => {
      reconnectDelay = 1000;
      console.log('✅ MoonWolf Cloud conectado.');
      connectLocalSocket();
    });

    cloudSocket.on('rpc', async request => {
      const result = await forwardHttp(request || {});
      cloudSocket?.emit('rpc_result', result);
    });

    cloudSocket.on('connect_error', error => {
      console.log(`⚠ Cloud: ${error?.message || 'error de conexión'}`);
    });

    cloudSocket.on('disconnect', reason => {
      console.log(`⚠ Cloud desconectado (${reason}).`);
      scheduleReconnect();
    });
  }

  function shutdown() {
    shuttingDown = true;
    clearTimeout(reconnectTimer);
    cloudSocket?.disconnect();
    localSocket?.disconnect();
    if (localChild && !localChild.killed) localChild.kill();
  }

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  connectCloud();
}

main().catch(error => {
  console.error('❌ MoonWolf Agent:', error.message);
  process.exitCode = 1;
});
