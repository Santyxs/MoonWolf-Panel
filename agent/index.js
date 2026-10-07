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
const DEFAULT_SERVER_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(os.homedir(), 'MoonWolf', 'server');
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');
const FORWARD_TIMEOUT_MS = 120_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_REPO = 'Santyxs/MoonWolf-Panel';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_DIR = path.join(CONFIG_DIR, 'updates');

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function makeSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function atomicWriteFileSync(filePath, data, options = 'utf8') {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fd = null;

  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, data, options);
    
    try { fs.fsyncSync(fd); } catch {}

    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function writeConfig(config) {
  const serialized = JSON.stringify(config, null, 2);

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const current = fs.readFileSync(CONFIG_PATH, 'utf8');
      JSON.parse(current);
      atomicWriteFileSync(`${CONFIG_PATH}.bak`, current, 'utf8');
    }
  } catch {}

  atomicWriteFileSync(CONFIG_PATH, serialized, 'utf8');
}

function loadConfig() {
  ensureConfigDir();

  const readJsonObject = filePath => {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  };

  let config = readJsonObject(CONFIG_PATH);

  if (!config) {
    const backupPath = `${CONFIG_PATH}.bak`;
    const backup = readJsonObject(backupPath);

    if (backup) {
      console.warn(
        `[config] ${CONFIG_PATH} ilegible; recuperado desde ${backupPath}. ` +
        'Se conservará el agentId original.'
      );
      config = backup;
    } else if (fs.existsSync(CONFIG_PATH)) {
      const quarantine = `${CONFIG_PATH}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(CONFIG_PATH, quarantine);
        console.warn(
          `[config] ${CONFIG_PATH} corrupto y sin backup válido; ` +
          `movido a ${quarantine}. Se generará un agentId nuevo.`
        );
      } catch (error) {
        console.warn(
          `[config] No se pudo aislar ${CONFIG_PATH}: ${error?.message || error}`
        );
      }
    }
  }

  config = config || {};

  if (!config.agentId || typeof config.agentId !== 'string') {
    config.agentId = crypto.randomUUID();
  }

  if (!AGENT_TOKEN_RE.test(config.agentToken || '')) {
    config.agentToken = makeSecret();
  }

  if (!LOCAL_TOKEN_RE.test(config.localToken || '')) {
    config.localToken = makeSecret();
  }

  if (typeof config.sessionSecret !== 'string' || config.sessionSecret.length < 32) {
    const legacySecretPath = path.join(__dirname, '.moonwolf-session-secret');

    try {
      const legacySecret = fs.readFileSync(legacySecretPath, 'utf8').trim();

      if (legacySecret.length >= 32) {
        config.sessionSecret = legacySecret;
        try {
          fs.unlinkSync(legacySecretPath);
        } catch {}
      }
    } catch {}

    if (typeof config.sessionSecret !== 'string' || config.sessionSecret.length < 32) {
      config.sessionSecret = makeSecret();
    }
  }

  if (!config.serverDir) {
    config.serverDir = DEFAULT_SERVER_DIR;
  }

  if (typeof config.autoStart !== 'boolean') {
    config.autoStart = false;
  }

  delete config.token;

  writeConfig(config);
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
  process.env.MOONWOLF_SESSION_SECRET = config.sessionSecret;

  return require('../server.js');
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
      ...(process.env.MOONWOLF_GH_TOKEN
        ? { 'Authorization': `Bearer ${process.env.MOONWOLF_GH_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}`);
  }

  const release = await response.json();
  const match = String(release.tag_name || '').match(/^(?:agent-)?v?(.+)$/i);

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

  return new Promise((resolve, reject) => {
    fileStream.on('error', error => {
      reader.cancel().catch(() => {});
      try { fs.unlinkSync(dest); } catch {}
      reject(new Error(`Error escribiendo archivo: ${error.message}`));
    });

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          received += value.length;
          const writable = fileStream.write(value);

          if (onProgress && total > 0) {
            onProgress(Math.min(100, Math.round((received / total) * 100)));
          }

          if (!writable) {
            await new Promise(res => fileStream.once('drain', res));
          }
        }

        fileStream.end(() => {
          try {
            const stat = fs.statSync(dest);

            if (stat.size < 1024 * 1024) {
              try { fs.unlinkSync(dest); } catch {}
              reject(new Error('El archivo descargado es demasiado pequeño.'));
              return;
            }

            resolve(dest);
          } catch (error) {
            reject(new Error(`Error verificando archivo: ${error.message}`));
          }
        });
      } catch (error) {
        fileStream.destroy();
        try { fs.unlinkSync(dest); } catch {}
        reject(new Error(`Error descargando: ${error.message}`));
      }
    })();
  });
}

async function runAsUpdater(oldPid, oldExe) {
  const selfPath = process.execPath;

  const isAlive = pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline && isAlive(oldPid)) {
    await wait(200);
  }

  await wait(3000);

  let lastError = null;

  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      fs.copyFileSync(selfPath, oldExe);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await wait(2000);
    }
  }

  if (lastError) {
    try {
      spawn(oldExe, [], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } catch {}

    process.exit(1);
  }

  try {
    spawn(oldExe, [], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch (error) {
    process.exit(1);
  }

  process.exit(0);
}

function applyUpdate(downloadedPath) {
  if (process.platform !== 'win32') {
    throw new Error('La auto-actualización solo está disponible en Windows.');
  }

  if (VERSION === 'dev') {
    throw new Error('La auto-actualización solo funciona en el binario compilado.');
  }

  if (!fs.existsSync(downloadedPath)) {
    throw new Error('El archivo descargado no existe.');
  }

  const currentExe = process.execPath;

  if (!/\.exe$/i.test(currentExe)) {
    throw new Error('El Agent no se está ejecutando como ejecutable.');
  }

  fs.mkdirSync(UPDATE_DIR, { recursive: true });

  const updaterPath = path.join(UPDATE_DIR, 'updater.exe');

  try { fs.unlinkSync(updaterPath); } catch {}

  fs.copyFileSync(downloadedPath, updaterPath);

  const child = spawn(
    updaterPath,
    ['--self-update', String(process.pid), currentExe],
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
  if (!fs.existsSync(UPDATE_DIR)) return;

  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000;

  let entries;

  try {
    entries = fs.readdirSync(UPDATE_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(UPDATE_DIR, entry);

    let stat;

    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs <= MAX_AGE) continue;

    try { fs.chmodSync(full, 0o666); } catch {}

    try {
      fs.unlinkSync(full);
    } catch (error) {
      try { console.warn(`[cleanUpdateDir] No se pudo borrar ${entry}: ${error.message}`); } catch {}
    }
  }
}

async function main() {
  const selfUpdateIdx = process.argv.indexOf('--self-update');

  if (selfUpdateIdx !== -1) {
    const oldPid = Number(process.argv[selfUpdateIdx + 1]);
    const oldExe = String(process.argv[selfUpdateIdx + 2] || '');

    if (Number.isFinite(oldPid) && /\.exe$/i.test(oldExe)) {
      await runAsUpdater(oldPid, oldExe);
      return;
    }

    process.exit(1);
  }

  const waitPidIdx = process.argv.indexOf('--wait-pid');

  if (waitPidIdx !== -1) {
    const waitPid = Number(process.argv[waitPidIdx + 1]);
    const limit = Date.now() + 60_000;

    while (Number.isFinite(waitPid) && Date.now() < limit) {
      try { process.kill(waitPid, 0); } catch { break; }
      await wait(200);
    }

    await wait(1500);
  }

  const config = loadConfig();
  const localUrl = `http://127.0.0.1:${LOCAL_PORT}`;

  let localServerReady = false;
  let cloudConnected = false;
  let localSocket = null;
  let cloudSocket = null;
  let localServerApi = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let updateCheckTimer = null;
  let updateNoticeTimer = null;
  let shuttingDown = false;
  let gui = null;
  let pairingCode = '';
  let pairingExpiresAt = 0;
  let pairingRenewTimer = null;
  let pendingRestart = false;
  let cloudConnectionAttempt = 0;
  let pairingRequestCount = 0;

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

  async function applyUpdateNow() {
    if (updateStatus === 'error') {
      updateStatus = 'idle';
      updateError = null;
      updateFilePath = null;
      gui?.update();

      await startUpdateDownload();

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

      await Promise.resolve(applyUpdate(updateFilePath));

      addLog('Cerrando para aplicar la actualización...');
      gui?.update();

      setTimeout(() => {
        try { gui?.close?.(); } catch { try { process.exit(0); } catch {} }
      }, 1000);

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
    onQuit: async () => {
      try { await localServerApi?.stopMinecraft?.(); } catch {}
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

      atomicWriteFileSync(logPath, content + (content ? '\n' : ''), 'utf8');
      return logPath;
    },

    setServerDir: async newDir => {
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
        writeConfig(config);
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

      (async () => {
        try { await localServerApi?.stopMinecraft?.(); } catch {}

        shutdown();

        try {
          if (VERSION !== 'dev' && /\.exe$/i.test(process.execPath)) {
            spawn(process.execPath, ['--wait-pid', String(process.pid)], {
              detached: true,
              windowsHide: true,
              stdio: 'ignore',
            }).unref();
          }
        } catch {}

        process.exit(0);
      })();

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
    localServerApi = startEmbeddedLocalServer(config);
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
      const method = (request.method || 'GET').toUpperCase();
      const parsedPath = new URL(String(request.path || ''), 'http://moonwolf.invalid');

      if (parsedPath.origin !== 'http://moonwolf.invalid' || !parsedPath.pathname.startsWith('/api/')) {
        throw new Error('Ruta RPC no válida.');
      }

      const safeRequestPath = parsedPath.pathname + parsedPath.search;
      
      let isBinaryBody = Buffer.isBuffer(request.body) ||
        request.body instanceof Uint8Array ||
        request.body instanceof ArrayBuffer;

      if (!isBinaryBody && request.body && typeof request.body === 'object' && request.body.type === 'Buffer' && Array.isArray(request.body.data)) {
        isBinaryBody = true;
        request.body = Buffer.from(request.body.data);
      }

      let body;
      let contentType;

      if (isBinaryBody) {
        body = Buffer.from(request.body);
        contentType = 'application/octet-stream';
      } else if (request.body !== undefined && request.body !== null) {
        if (typeof request.body === 'string') {
          body = request.body;
        } else {
          body = JSON.stringify(request.body);
        }
        contentType = 'application/json';
      }

      const fetchHeaders = {
        'X-MoonWolf-Token': config.localToken,
      };

      if (request.headers && typeof request.headers === 'object') {
        for (const [key, val] of Object.entries(request.headers)) {
          const lower = key.toLowerCase();
          if (lower !== 'host' && lower !== 'content-length' && lower !== 'x-moonwolf-token') {
            fetchHeaders[key] = val;
          }
        }
      }

      const fetchOptions = {
        method,
        headers: fetchHeaders,
        signal: controller.signal,
      };

      if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
        fetchOptions.body = body;
        if (contentType && !fetchHeaders['content-type'] && !fetchHeaders['Content-Type']) {
          fetchOptions.headers['Content-Type'] = contentType;
        }
      }

      const response = await fetch(`${localUrl}${safeRequestPath}`, fetchOptions);

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
    clearTimeout(pairingRenewTimer);
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

    for (const event of ['status', 'log', 'log_batch', 'history', 'stats']) {
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

    pairingRequestCount++;
    addLog(
      `[diagnóstico] Solicitud de pairing #${pairingRequestCount} ` +
      `(socket=${cloudSocket.id || 'sin-id'}, pid=${process.pid})`
    );
    clearPairing();
    addLog('Solicitando código de emparejamiento...');
    cloudSocket.emit('pairing_create');
  }

  function scheduleReconnect() {
    if (shuttingDown) return;

    clearTimeout(reconnectTimer);
    addLog(
      `[diagnóstico] Reconexión programada en ${reconnectDelay}ms ` +
      `(pid=${process.pid}, agentId=${config.agentId})`,
      'warn'
    );
    reconnectTimer = setTimeout(connectCloud, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connectCloud() {
    if (shuttingDown) return;

    cloudSocket?.disconnect();
    cloudConnected = false;
    clearPairing();
    cloudConnectionAttempt++;
    addLog(
      `[diagnóstico] Conectando con MoonWolf Cloud (intento #${cloudConnectionAttempt}, ` +
      `pid=${process.pid}, agentId=${config.agentId}, version=${VERSION})...`
    );
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
      addLog(
        `[diagnóstico] Socket Cloud conectado: socket=${cloudSocket.id}, ` +
        `transport=${cloudSocket.io?.engine?.transport?.name || 'desconocido'}`
      );
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
      const serverTtlMs = Number(data?.ttlMs || 0);
      const serverExpiresAt = Number(data?.expiresAt || 0);
      const ttlMs = Number.isFinite(serverTtlMs) && serverTtlMs > 0
        ? serverTtlMs
        : Math.max(0, serverExpiresAt - Date.now());
      pairingExpiresAt = Date.now() + ttlMs;

      addLog(
        `[diagnóstico] Pairing recibido: socket=${cloudSocket.id || 'sin-id'}, ` +
        `ttl=${ttlMs}ms, expira-local=${pairingExpiresAt ? new Date(pairingExpiresAt).toISOString() : 'desconocido'}`
      );

      clearTimeout(pairingRenewTimer);
      pairingRenewTimer = setTimeout(
        requestPairingCode,
        Math.max(5000, ttlMs - 20_000)
      );
      addLog(`Código de emparejamiento disponible: ${code}`);
      gui.update();
    });

    cloudSocket.on('pairing_consumed', () => {
      addLog(`[diagnóstico] Pairing consumido por el panel (socket=${cloudSocket.id || 'sin-id'}).`);
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
      addLog(
        `[diagnóstico] connect_error: name=${error?.name || 'n/a'}, ` +
        `message=${error?.message || error}, description=${error?.description || 'n/a'}`,
        'error'
      );
      addLog(`Error de conexión con Cloud: ${error?.message || error}`, 'error');
      gui.update();
    });

    cloudSocket.on('disconnect', reason => {
      cloudConnected = false;
      clearPairing();
      addLog(
        `[diagnóstico] Socket Cloud desconectado: reason=${reason || 'sin-motivo'}, ` +
        `socket=${cloudSocket?.id || 'sin-id'}, active=${!shuttingDown}`,
        'warn'
      );
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
