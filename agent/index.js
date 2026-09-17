'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const PANEL_URL = process.env.MOONWOLF_PANEL_URL || 'https://moon-wolf-panel.vercel.app';
const LOCAL_URL = process.env.MOONWOLF_LOCAL_URL || 'http://127.0.0.1:3000';
const CONFIG_PATH = path.join(__dirname, 'agent.json');
const CODE_RE = /^MW-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function createCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i++) raw += alphabet[bytes[i] % alphabet.length];
  return `MW-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function parseEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function loadConfig() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {}

  const serverDir = readArg('--server-dir') || process.env.MOONWOLF_SERVER_DIR || config.serverDir || process.cwd();
  const code = CODE_RE.test(config.code || '') ? config.code : createCode();
  config = { ...config, code, serverDir };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function main() {
  const config = loadConfig();
  const env = parseEnv(path.join(config.serverDir, '.env'));
  const panelPassword = process.env.PANEL_PASSWORD || env.PANEL_PASSWORD || '';

  console.log('');
  console.log('🌙 MoonWolf Agent');
  console.log(`Servidor: ${config.serverDir}`);
  console.log(`Código:   ${config.code}`);
  console.log(`Panel:    ${PANEL_URL}`);
  console.log('');

  let localToken = null;
  let localSocket = null;
  let cloudSocket = null;
  let retryTimer = null;
  let retryDelay = 1000;

  async function localLogin() {
    if (localToken) return localToken;
    if (!panelPassword) {
      throw new Error('No se encontró PANEL_PASSWORD en el .env del servidor.');
    }

    const response = await fetch(`${LOCAL_URL}/api/auth/login`, {
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

  async function localRequest(request) {
    try {
      const token = await localLogin();
      const headers = { Authorization: `Bearer ${token}` };
      if (request.body !== undefined && request.body !== null) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${LOCAL_URL}${request.path}`, {
        method: request.method || 'GET',
        headers,
        body: request.body !== undefined && request.body !== null
          ? JSON.stringify(request.body)
          : undefined,
      });

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const bytes = Buffer.from(await response.arrayBuffer());

      return {
        id: request.id,
        ok: response.ok,
        status: response.status,
        contentType,
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

  function connectLocal() {
    if (localSocket) localSocket.disconnect();

    localSocket = io(LOCAL_URL, {
      autoConnect: true,
      auth: async callback => {
        try {
          callback({ token: await localLogin() });
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
          cloudSocket.emit('agent_event', { name: event, payload });
        }
      });
    }

    localSocket.on('connect_error', error => {
      if (error?.message === 'unauthorized') localToken = null;
    });
  }

  function connectCloud() {
    clearTimeout(retryTimer);

    cloudSocket = io(PANEL_URL, {
      path: '/api/socket-io/socket.io',
      transports: ['websocket'],
      auth: { role: 'agent', token: config.code },
      reconnection: false,
    });

    cloudSocket.on('connect', () => {
      retryDelay = 1000;
      console.log('✅ Conectado a MoonWolf Cloud.');
      connectLocal();
    });

    cloudSocket.on('rpc', async request => {
      const result = await localRequest(request || {});
      cloudSocket.emit('rpc_result', result);
    });

    cloudSocket.on('connect_error', error => {
      console.log(`⚠ Cloud: ${error?.message || 'error de conexión'}`);
    });

    cloudSocket.on('disconnect', reason => {
      console.log(`⚠ Cloud desconectado (${reason}).`);
      if (localSocket) localSocket.disconnect();
      retryTimer = setTimeout(connectCloud, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    });
  }

  process.on('SIGINT', () => {
    if (localSocket) localSocket.disconnect();
    if (cloudSocket) cloudSocket.disconnect();
    process.exit(0);
  });

  connectCloud();
}

main().catch(error => {
  console.error(`❌ MoonWolf Agent: ${error.message}`);
  process.exitCode = 1;
});
