'use strict';

const CLOUD_URL = location.origin;
const CLOUD_PATH = '/socket.io';

const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const SHARE_TOKEN_RE = /^MW-SHARE-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const SESSION_KEY = 'moonwolf_panel_session';
const AGENT_KEY = 'moonwolf_agent_id';
const PERMISSION_KEY = 'moonwolf_panel_permission';
const SESSION_KIND_KEY = 'moonwolf_panel_kind';

const $ = id => document.getElementById(id);

const escHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const AIKAR_FLAGS = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

const STATUS_LABELS = {
  online: 'ONLINE',
  offline: 'OFFLINE',
  starting: 'STARTING...',
  restarting: 'RESTARTING...',
  stopping: 'STOPPING...',
};

const STATUS_ICONS = {
  online: '🟢',
  offline: '🔴',
  starting: '🟡',
  restarting: '🟡',
  stopping: '🟠',
};

const STATUS_LEVELS = {
  online: 'ok',
  offline: 'info',
  starting: 'info',
  restarting: 'warn',
  stopping: 'warn',
};

const SOURCE_LABELS = {
  modrinth: 'MODRINTH',
  spigot: 'SPIGOT',
  hangar: 'HANGAR',
};

/* STATE */

let cloudSocket = null;
let panelSession = sessionStorage.getItem(SESSION_KEY) || '';
let agentId = sessionStorage.getItem(AGENT_KEY) || '';
let panelPermission = sessionStorage.getItem(PERMISSION_KEY) || 'admin';
let panelKind = sessionStorage.getItem(SESSION_KIND_KEY) || 'owner';
let pairingCode = '';

let requestSequence = 0;
let connectTimer = null;
let reconnectDelay = 1000;

let currentStatus = 'offline';
let agentOnline = false;

let editor = null;
let currentFile = null;
let currentDir = '';

let currentPlugin = null;
let pluginSource = 'all';
let pluginPrice = 'all';
let pluginSearchSeq = 0;
let pluginSearchTimer = null;

let versionState = {
  software: null,
  version: null,
  builds: [],
};

const pending = new Map();
const activities = [];

let lastAgentActivityState = null;
let lastStatusActivity = null;

/* HELPERS */

function flashButton(button, label) {
  if (!button) return;

  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;

  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function spinnerBlock(message, size = 28) {
  return `
    <div class="empty-state">
      <div style="display:inline-block;animation:spin 1s linear infinite;font-size:${size}px">⟳</div>
      <div class="empty-msg">${escHtml(message)}</div>
    </div>
  `;
}

function emptyBlock(message, icon = '') {
  return `
    <div class="empty-state">
      ${icon ? `<div class="empty-icon">${icon}</div>` : ''}
      <div class="empty-msg">${escHtml(message)}</div>
    </div>
  `;
}

/* SOCKET.IO */

function ensureSocketIo() {
  if (typeof window.io === 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      'script[data-moonwolf-socketio]'
    );

    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('No se pudo cargar Socket.IO.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');

    script.src = 'https://cdn.socket.io/4.8.3/socket.io.min.js';
    script.async = true;
    script.dataset.moonwolfSocketio = '1';

    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar Socket.IO desde CDN.'));

    document.head.appendChild(script);
  });
}

/* LOGIN */

function ensureLoginGate() {
  if ($('loginGate')) return;

  const style = document.createElement('style');

  style.id = 'mw-cloud-login-style';

  style.textContent = `
    #loginGate{
      position:fixed;
      inset:0;
      z-index:99999;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#0d0f14;
      font-family:inherit
    }

    #loginGate.hidden{
      display:none
    }

    .mw-cloud-card{
      width:360px;
      max-width:90vw;
      padding:32px 28px;
      background:#171a21;
      border:1px solid #2a2e38;
      border-radius:14px;
      box-shadow:0 18px 60px rgba(0,0,0,.45);
      text-align:center
    }

    .mw-cloud-card h1{
      font-size:18px;
      color:#eee;
      margin:0 0 6px;
      letter-spacing:.05em
    }

    .mw-cloud-card p{
      margin:0 0 18px;
      color:#888;
      font-size:12px;
      line-height:1.5
    }

    .mw-cloud-card input{
      width:100%;
      box-sizing:border-box;
      padding:12px;
      background:#0d0f14;
      border:1px solid #2a2e38;
      border-radius:9px;
      color:#eee;
      font:600 14px/1.2 ui-monospace,monospace;
      text-align:center;
      letter-spacing:.12em
    }

    .mw-cloud-card button{
      width:100%;
      margin-top:12px;
      padding:11px;
      border:0;
      border-radius:9px;
      background:#6c5ce7;
      color:#fff;
      font-weight:700;
      cursor:pointer
    }

    .mw-cloud-card button:disabled{
      opacity:.55;
      cursor:default
    }

    #mwCloudError{
      min-height:18px;
      margin-top:12px;
      font-size:12px;
      color:#ff6b6b
    }

    .mw-cloud-help{
      margin-top:16px;
      color:#666;
      font-size:11px
    }

    .mw-cloud-help b{
      color:#aaa
    }
  `;

  document.head.appendChild(style);

  const gate = document.createElement('div');

  gate.id = 'loginGate';

  gate.innerHTML = `
    <div class="mw-cloud-card">
      <h1>🌙 MOONWOLF CLOUD</h1>

      <p>
        Introduce el código de emparejamiento que muestra MoonWolf Agent
        o un token de acceso compartido.
      </p>

      <input
        id="loginPassword"
        type="text"
        maxlength="28"
        spellcheck="false"
        autocomplete="off"
        placeholder="MW-PXXX-XXXX / MW-SHARE-XXXX-XXXX-XXXX-XXXX"
      >

      <button id="btnLogin">CONECTAR SERVIDOR</button>

      <div id="mwCloudError"></div>

      <div class="mw-cloud-help">
        El código de emparejamiento se usa una sola vez. Los tokens compartidos
        pueden reutilizarse hasta que caduquen o sean revocados.
      </div>
    </div>
  `;

  document.body.prepend(gate);

  $('loginPassword').addEventListener('input', event => {
    let raw = event.target.value.toUpperCase();

    if (raw.startsWith('MW-SHARE')) {
      const value = raw
        .replace(/^MW-SHARE-?/, '')
        .replace(/[^A-Z2-9]/g, '')
        .slice(0, 16);
      const groups = value.match(/.{1,4}/g) || [];
      event.target.value = `MW-SHARE-${groups.join('-')}`.replace(/-$/, '');
      return;
    }

    let value = raw.replace(/[^A-Z2-9]/g, '');

    if (value === 'M') {
      event.target.value = 'M';
      return;
    }

    if (value === 'MW') {
      event.target.value = 'MW-';
      return;
    }

    if (value.startsWith('MW')) value = value.slice(2);
    if (value.startsWith('P')) value = value.slice(1);

    const first = value.slice(0, 3);
    const second = value.slice(3, 7);

    event.target.value = `MW-P${first}${second ? `-${second}` : ''}`;
  });

  $('btnLogin').addEventListener('click', attemptLogin);

  $('loginPassword').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      attemptLogin();
    }
  });
}

function showApp() {
  ensureLoginGate();

  $('loginGate')?.classList.add('hidden');
  document.querySelector('.app')?.classList.remove('locked');
}

function showLogin(message = '') {
  ensureLoginGate();

  $('loginGate')?.classList.remove('hidden');
  document.querySelector('.app')?.classList.add('locked');

  if ($('btnLogin')) {
    $('btnLogin').disabled = false;
  }

  if ($('mwCloudError')) {
    $('mwCloudError').textContent = message;
  }

  if ($('loginPassword')) {
    $('loginPassword').value = pairingCode;
  }
}

function setSession(session, id, permission = 'admin', kind = 'owner') {
  panelSession = String(session || '');
  agentId = String(id || '');
  panelPermission = String(permission || 'admin');
  panelKind = String(kind || 'owner');

  if (panelSession) {
    sessionStorage.setItem(SESSION_KEY, panelSession);
    sessionStorage.setItem(PERMISSION_KEY, panelPermission);
    sessionStorage.setItem(SESSION_KIND_KEY, panelKind);
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PERMISSION_KEY);
    sessionStorage.removeItem(SESSION_KIND_KEY);
  }

  if (agentId) {
    sessionStorage.setItem(AGENT_KEY, agentId);
  } else {
    sessionStorage.removeItem(AGENT_KEY);
  }
}

function clearSession() {
  setSession('', '', 'admin', 'owner');
  pairingCode = '';
}

const PERMISSION_RANK = { read: 1, control: 2, admin: 3 };
function hasPermission(required) {
  return (PERMISSION_RANK[panelPermission] || 0) >= (PERMISSION_RANK[required] || 99);
}

async function attemptLogin() {
  const input = $('loginPassword');
  const button = $('btnLogin');

  const code = String(input?.value || '')
    .trim()
    .toUpperCase();

  if (!PAIRING_CODE_RE.test(code) && !SHARE_TOKEN_RE.test(code)) {
    if ($('mwCloudError')) {
      $('mwCloudError').textContent =
        'Código inválido. Usa MW-PXXX-XXXX o un token MW-SHARE-...';
    }

    return;
  }

  button.disabled = true;

  if ($('mwCloudError')) {
    $('mwCloudError').textContent = 'Emparejando...';
  }

  pairingCode = code;

  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok || !data.session || !data.agent?.id) {
      throw new Error(data.error || 'No se pudo emparejar el panel.');
    }

    setSession(
      data.session,
      data.agent.id,
      data.permission || 'admin',
      data.kind || 'owner'
    );
    pairingCode = '';

    await connectCloud(true);

    if ($('mwCloudError')) {
      $('mwCloudError').textContent = '';
    }
  } catch (error) {
    pairingCode = '';

    if ($('mwCloudError')) {
      $('mwCloudError').textContent = error.message;
    }

    button.disabled = false;
  }
}

/* CLOUD CONNECTION */

function clearPending(errorMessage) {
  for (const [, resolve] of pending) {
    resolve({
      id: null,
      ok: false,
      status: 503,
      data: {
        ok: false,
        error: errorMessage,
      },
    });
  }

  pending.clear();
}

async function connectCloud(manual = false) {
  clearTimeout(connectTimer);

  if (!panelSession || !agentId) {
    showLogin('Empareja este panel con un MoonWolf Agent.');

    return Promise.reject(
      new Error('Código de conexión inválido.')
    );
  }

  if (cloudSocket?.connected) {
    showApp();
    return;
  }

  await ensureSocketIo();

  if (cloudSocket) {
    try {
      cloudSocket.disconnect();
    } catch {}
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;

      settled = true;
      fn(value);
    };

    cloudSocket = io(CLOUD_URL, {
      autoConnect: false,
      path: CLOUD_PATH,
      transports: ['websocket'],
      reconnection: false,

      auth: callback => {
        callback({
          role: 'panel',
          session: panelSession,
        });
      },
    });

    cloudSocket.once('connect', () => {
      reconnectDelay = 1000;

      showApp();

      addActivity(
        'Conectado a MoonWolf Cloud',
        'ok',
        '☁️'
      );

      finish(resolve);
    });

    cloudSocket.once('connect_error', error => {
      const message =
        error?.message ||
        'No se pudo conectar con MoonWolf Cloud.';

      addActivity(message, 'warn', '⚠️');

      if (/unauthorized/i.test(message)) {
        clearSession();
        showLogin('La sesión del panel ha caducado. Introduce un nuevo código.');
      }

      finish(reject, new Error(message));
    });

    cloudSocket.on('cloud_ready', data => {
      setAgentOnline(Boolean(data?.agentOnline));
    });

    cloudSocket.on('agent_status', data => {
      setAgentOnline(Boolean(data?.online));
    });

    cloudSocket.on('session_info', data => {
      panelPermission = String(data?.permission || panelPermission || 'admin');
      panelKind = String(data?.kind || panelKind || 'owner');
      sessionStorage.setItem(PERMISSION_KEY, panelPermission);
      sessionStorage.setItem(SESSION_KIND_KEY, panelKind);
      renderSettings();
    });

    cloudSocket.on('share_revoked', () => {
      clearSession();
      showLogin('Este acceso compartido ha sido revocado.');
    });

    cloudSocket.on('status', setStatus);
    cloudSocket.on('log', appendLog);

    cloudSocket.on('history', logs => {
      const consoleEl = $('console');

      if (!consoleEl) return;

      consoleEl.innerHTML = '';

      (Array.isArray(logs) ? logs : []).forEach(appendLog);
    });

    cloudSocket.on('stats', updateStats);

    cloudSocket.on('rpc_result', result => {
      const resolveRequest = pending.get(result?.id);

      if (!resolveRequest) return;

      pending.delete(result.id);
      resolveRequest(result);
    });

    cloudSocket.on('disconnect', reason => {
      setAgentOnline(false);

      currentStatus = 'offline';
      updateStatusUi('offline');

      clearPending('Conexión con MoonWolf Cloud perdida.');

      addActivity(
        `Cloud desconectado (${reason})`,
        'warn',
        '⚠️'
      );

      if (manual) {
        showLogin(
          'La conexión se cerró. Comprueba que el Agent esté ejecutándose.'
        );
      }

      clearTimeout(connectTimer);

      connectTimer = setTimeout(() => {
        connectCloud(false).catch(() => {});
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    cloudSocket.connect();
  });
}

/* RPC / API */

async function cloudApi(pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${panelSession}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(pathname, { ...init, headers });
  let data = null;

  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Error HTTP ${response.status}`);
  }

  return data;
}

function rpcHttp(pathname, init = {}) {
  if (!cloudSocket?.connected) {
    return Promise.reject(
      new Error('MoonWolf Cloud no está conectado.')
    );
  }

  const id = `${Date.now()}-${++requestSequence}`;

  const request = {
    id,
    method: String(init.method || 'GET').toUpperCase(),
    path: pathname,
    body: init.body ?? undefined,
  };

  return new Promise(resolve => {
    pending.set(id, resolve);
    cloudSocket.emit('rpc', request);
  });
}

function decodeResultBody(result) {
  if (result?.bodyBase64 === undefined) {
    return null;
  }

  const binary = atob(result.bodyBase64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function api(pathname, init = {}) {
  const result = await rpcHttp(pathname, init);

  const status = result?.status || 500;
  const contentType = result?.contentType || 'application/json';

  if (result?.bodyBase64 !== undefined) {
    const bytes = decodeResultBody(result);
    const text = new TextDecoder().decode(bytes);

    if (
      contentType.includes('application/json') ||
      contentType.includes('text/')
    ) {
      try {
        return JSON.parse(text);
      } catch {
        return {
          ok: status >= 200 && status < 300,
          status,
          content: text,
        };
      }
    }
  }

  return result?.data || {
    ok: Boolean(result?.ok),
    status,
    error: 'Respuesta vacía.',
  };
}

function postJSON(pathname, body) {
  return api(pathname, {
    method: 'POST',
    body,
  });
}

/* AGENT STATUS */

function setAgentOnline(online) {
  const nextState = Boolean(online);

  if (agentOnline === nextState) {
    updateAgentUi(nextState);
    updateStatusUi(currentStatus);
    return;
  }

  agentOnline = nextState;
  updateAgentUi(nextState);
  updateStatusUi(currentStatus);

  if (nextState) {
    if (lastAgentActivityState !== true) {
      addActivity('MoonWolf Agent conectado', 'ok', '🟢');
    }

    lastAgentActivityState = true;
  } else {
    if (lastAgentActivityState !== false) {
      addActivity('MoonWolf Agent desconectado', 'warn', '🔴');
    }

    lastAgentActivityState = false;
  }
}

function updateAgentUi(online) {
  const elements = [
    $('agentStatus'),
    $('sbAgentStatus'),
    $('agentConnectionStatus'),
  ];

  for (const element of elements) {
    if (!element) continue;

    element.classList.toggle('online', Boolean(online));
    element.classList.toggle('offline', !online);

    if (element.dataset && element.dataset.agentStatus !== undefined) {
      element.dataset.agentStatus = online ? 'online' : 'offline';
    }
  }

  const textElements = [
    $('agentStatusText'),
    $('sbAgentStatusText'),
  ];

  for (const element of textElements) {
    if (!element) continue;

    element.textContent = online ? 'AGENT ONLINE' : 'AGENT OFFLINE';
  }
}

/* SERVER / TERMINAL */

function updateStatusUi(status) {
  status = STATUS_LABELS[status] ? status : 'offline';

  currentStatus = status;

  const statusEl = $('sbStatus');

  if (statusEl) {
    statusEl.className = `sb-status ${status}`;
  }

  const statusText = $('sbStatusText');

  if (statusText) {
    statusText.textContent =
      STATUS_LABELS[status] || String(status).toUpperCase();
  }

  const startButton = $('btnStart');

  if (startButton) {
    startButton.disabled = status !== 'offline' || !agentOnline;
  }

  const stopButton = $('btnStop');

  if (stopButton) {
    stopButton.disabled = status !== 'online' || !agentOnline;
  }

  const restartButton = $('btnRestart');

  if (restartButton) {
    restartButton.disabled = status !== 'online' || !agentOnline;
  }

  const stats = $('statsGrid');

  if (stats) {
    stats.classList.toggle('hidden', status === 'offline');
    stats.classList.toggle('visible', status !== 'offline');
  }
}

function setStatus(status) {
  updateStatusUi(status);

  const normalized = STATUS_LABELS[status] ? status : 'offline';

  if (lastStatusActivity === normalized) {
    return;
  }

  lastStatusActivity = normalized;

  addActivity(
    STATUS_LABELS[normalized] || normalized,
    STATUS_LEVELS[normalized] || 'info',
    STATUS_ICONS[normalized] || '📌'
  );
}

function updateStats(stats = {}) {
  const players = Number(stats.players);
  const maxPlayers = Number(stats.maxPlayers);
  const tps = Number(stats.tps);
  const processMemory = Number(stats.processMemory);
  const cpuUsage = Number(stats.cpuUsage);

  const safePlayers = Number.isFinite(players) ? players : 0;
  const safeMaxPlayers = Number.isFinite(maxPlayers) ? maxPlayers : 0;
  const safeTps = Number.isFinite(tps) ? tps : 20;
  const safeProcessMemory = Number.isFinite(processMemory) ? processMemory : 0;
  const safeCpu = Number.isFinite(cpuUsage) ? cpuUsage : 0;

  if ($('statPlayers')) {
    $('statPlayers').innerHTML =
      `${safePlayers}<span class="stat-unit">/${safeMaxPlayers}</span>`;
  }

  const tpsEl = $('statTps');

  if (tpsEl) {
    tpsEl.className =
      `stat-value ${
        safeTps < 15
          ? 'tps-bad'
          : safeTps < 18
            ? 'tps-warn'
            : 'tps-good'
      }`;

    tpsEl.innerHTML = `${safeTps}<span class="stat-unit"> tps</span>`;
  }

  if ($('statUptime')) {
    $('statUptime').textContent = stats.uptime || '0h 0m';
  }

  if ($('statMemProc')) {
    $('statMemProc').innerHTML =
      `${safeProcessMemory}<span class="stat-unit"> MB</span>`;
  }

  const sys = stats.sysMemory || { used: 0, total: 0 };

  const used = Number(sys.used);
  const total = Number(sys.total);

  const safeUsed = Number.isFinite(used) ? used : 0;
  const safeTotal = Number.isFinite(total) ? total : 0;

  if ($('statMemSys')) {
    $('statMemSys').innerHTML =
      `${safeUsed}/${safeTotal}<span class="stat-unit"> GB</span>`;
  }

  if ($('statCpu')) {
    $('statCpu').innerHTML =
      `${safeCpu}<span class="stat-unit"> %</span>`;
  }
}

function appendLog(entry) {
  const consoleEl = $('console');

  if (!consoleEl) return;

  const div = document.createElement('div');

  div.className = `log-line ${entry?.type || 'info'}`;

  div.innerHTML =
    `<span class="log-time">${escHtml(entry?.time || '--:--:--')}</span>` +
    `<span class="log-text">${escHtml(entry?.line || '')}</span>`;

  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

async function startServer() {
  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  const data = await api('/api/start', { method: 'POST' });

  if (!data.ok) {
    toast(data.error || 'Error al arrancar', 'err');
  }
}

async function stopServer() {
  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  const data = await api('/api/stop', { method: 'POST' });

  if (!data.ok) {
    toast(data.error || 'Error al detener', 'err');
  }
}

async function restartServer() {
  if (currentStatus === 'restarting' || currentStatus === 'stopping') {
    return;
  }

  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  const data = await api('/api/restart', { method: 'POST' });

  if (!data.ok) {
    toast(data.error || 'Error al reiniciar', 'err');
  }
}

async function sendCmd() {
  const input = $('cmdInput');
  const cmd = input?.value.trim();

  if (!cmd) return;

  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  input.value = '';

  const data = await postJSON('/api/command', { cmd });

  if (!data.ok) {
    toast(data.error || 'Error al enviar comando', 'err');
  }
}

/* FILE MANAGER */

function fileIcon(type) {
  return {
    dir: '📁',
    jar: '☕',
    log: '📋',
    file: '📄',
  }[type] || '📄';
}

function populateFiles(dir = '') {
  currentDir = dir;

  const list = $('fileList');

  if (!list) return;

  list.innerHTML = spinnerBlock('Cargando...');

  renderBreadcrumb(dir);

  api(`/api/files?dir=${encodeURIComponent(dir)}`)
    .then(data => {
      if (!data.ok) {
        throw new Error(data.error || 'No se pudo leer la carpeta.');
      }

      const items = Array.isArray(data.items) ? data.items.slice() : [];

      items.sort(
        (a, b) =>
          (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );

      if (!items.length) {
        list.innerHTML = emptyBlock('Carpeta vacía', '📂');
        return;
      }

      list.innerHTML = items
        .map(item => `
          <div
            class="file-row"
            data-name="${escHtml(item.name)}"
            data-type="${escHtml(item.type)}"
          >
            <span class="file-icon">${fileIcon(item.type)}</span>
            <span class="file-name">${escHtml(item.name)}</span>
            <span class="file-size">${escHtml(item.size)}</span>
            <span class="file-date">${escHtml(item.date)}</span>
          </div>
        `)
        .join('');

      list.querySelectorAll('.file-row').forEach(row => {
        row.addEventListener('dblclick', () => {
          const name = row.dataset.name;
          const type = row.dataset.type;

          const rel = currentDir ? `${currentDir}/${name}` : name;

          if (type === 'dir') {
            populateFiles(rel);
          } else if (type !== 'jar') {
            openFile(rel);
          }
        });

        row.addEventListener('contextmenu', event =>
          openFileContext(event, row.dataset.name, row.dataset.type)
        );
      });
    })
    .catch(error => {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" style="color:var(--red)">⚠</div>
          <div class="empty-msg">${escHtml(error.message)}</div>
        </div>
      `;
    });
}

function renderBreadcrumb(dir) {
  const trail = $('crumbTrail');

  if (!trail) return;

  const parts = dir ? dir.split('/').filter(Boolean) : [];

  let acc = '';

  trail.innerHTML = parts
    .map((part, index) => {
      acc += (index ? '/' : '') + part;

      return ` / <span class="crumb" data-path="${escHtml(acc)}">${escHtml(part)}</span>`;
    })
    .join('');

  trail.querySelectorAll('.crumb').forEach(crumb => {
    crumb.addEventListener('click', () => populateFiles(crumb.dataset.path));
  });
}

function openFileContext(event, name, type) {
  event.preventDefault();

  document.querySelector('.file-ctx-menu')?.remove();

  const rel = currentDir ? `${currentDir}/${name}` : name;

  const menu = document.createElement('div');

  menu.className = 'file-ctx-menu';
  menu.style.position = 'fixed';
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 260)}px`;

  menu.innerHTML = `
    ${type !== 'dir' ? '<div class="ctx-item" data-action="open">✏️ Abrir</div>' : ''}
    <div class="ctx-item" data-action="rename">✏️ Renombrar</div>
    <div class="ctx-item" data-action="copy">📋 Copiar</div>
    <div class="ctx-item" data-action="move">📦 Mover</div>
    ${type !== 'dir' ? '<div class="ctx-item" data-action="download">⬇️ Descargar</div>' : ''}
    <div class="ctx-item" data-action="compress">🗜️ Comprimir (.zip)</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">🗑️ Eliminar</div>
  `;

  document.body.appendChild(menu);

  menu.addEventListener('click', async click => {
    const action = click.target.closest('.ctx-item')?.dataset.action;

    if (!action) return;

    menu.remove();

    try {
      if (action === 'open') {
        return openFile(rel);
      }

      if (action === 'rename') {
        const newName = prompt(`Nuevo nombre para "${name}":`, name);

        if (!newName || newName === name) {
          return;
        }

        const data = await postJSON('/api/files/rename', {
          path: rel,
          newName,
        });

        if (!data.ok) {
          throw new Error(data.error);
        }
      }

      if (action === 'copy') {
        const dest = prompt(
          `Ruta relativa de destino para "${name}":`,
          currentDir || ''
        );

        if (dest === null) return;

        const target = dest
          ? `${dest.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`
          : name;

        const data = await postJSON('/api/files/copy', {
          path: rel,
          dest: target,
        });

        if (!data.ok) {
          throw new Error(data.error);
        }
      }

      if (action === 'move') {
        const dest = prompt(
          `Carpeta relativa de destino para "${name}":`,
          currentDir || ''
        );

        if (dest === null) return;

        const target = dest
          ? `${dest.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`
          : name;

        const data = await postJSON('/api/files/move', {
          path: rel,
          dest: target,
        });

        if (!data.ok) {
          throw new Error(data.error);
        }
      }

      if (action === 'download') {
        return downloadFile(rel, name);
      }

      if (action === 'compress') {
        const data = await postJSON('/api/files/compress', {
          path: rel,
          name,
        });

        if (!data.ok) {
          throw new Error(data.error);
        }
      }

      if (action === 'delete') {
        if (!confirm(`¿Eliminar "${name}"?`)) {
          return;
        }

        const data = await postJSON('/api/files/delete', {
          path: rel,
          isDir: type === 'dir',
        });

        if (!data.ok) {
          throw new Error(data.error);
        }
      }

      toast('✅ Operación completada', 'ok');

      populateFiles(currentDir);
    } catch (error) {
      toast(`❌ ${error.message}`, 'err');
    }
  });

  setTimeout(() => {
    document.addEventListener('click', () => menu.remove(), { once: true });
  }, 0);
}

async function downloadFile(rel, filename) {
  const result = await rpcHttp(
    `/api/files/download?path=${encodeURIComponent(rel)}`
  );

  if (!result?.bodyBase64) {
    toast(
      result?.data?.error || 'No se pudo descargar el archivo.',
      'err'
    );

    return;
  }

  const bytes = decodeResultBody(result);

  const blob = new Blob([bytes], {
    type: result.contentType || 'application/octet-stream',
  });

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openFile(rel) {
  try {
    const data = await api(
      `/api/files/content?path=${encodeURIComponent(rel)}`
    );

    if (!data.ok) {
      throw new Error(data.error);
    }

    currentFile = rel;

    if ($('filesTablePanel')) {
      $('filesTablePanel').style.display = 'none';
    }

    if ($('filesEditorPanel')) {
      $('filesEditorPanel').style.display = '';
    }

    if ($('editorFileName')) {
      $('editorFileName').innerHTML =
        `📄 ${escHtml(data.filename || rel.split('/').pop())}`;
    }

    if ($('edSaveMsg')) {
      $('edSaveMsg').textContent = '';
    }

    if (editor) {
      editor.toTextArea?.();
    }

    $('editorContainer').innerHTML = '<textarea id="mwEditorArea"></textarea>';

    const ext = String(rel.split('.').pop() || '').toLowerCase();

    const mode = {
      yml: 'yaml',
      yaml: 'yaml',
      json: 'javascript',
      js: 'javascript',
      xml: 'xml',
      properties: 'properties',
      conf: 'properties',
      cfg: 'properties',
      sh: 'shell',
      bat: 'shell',
      cmd: 'shell',
    }[ext] || 'text/plain';

    if (window.CodeMirror) {
      editor = CodeMirror.fromTextArea($('mwEditorArea'), {
        lineNumbers: true,
        mode,
        theme: 'dracula',
        lineWrapping: false,
        viewportMargin: Infinity,
      });

      editor.setValue(data.content || '');

      editor.on('cursorActivity', updateEditorStatus);

      updateEditorStatus();
    } else {
      $('mwEditorArea').value = data.content || '';
    }
  } catch (error) {
    toast(`❌ ${error.message}`, 'err');
  }
}

function updateEditorStatus() {
  if (!editor) return;

  const cursor = editor.getCursor();

  if ($('edLine')) {
    $('edLine').textContent = cursor.line + 1;
  }

  if ($('edCol')) {
    $('edCol').textContent = cursor.ch + 1;
  }

  if ($('edLines')) {
    $('edLines').textContent = editor.lineCount();
  }
}

async function saveCurrentFile() {
  if (!currentFile) return;

  const content = editor
    ? editor.getValue()
    : $('mwEditorArea')?.value || '';

  const data = await postJSON('/api/files/content', {
    path: currentFile,
    content,
  });

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
    return;
  }

  if ($('edSaveMsg')) {
    $('edSaveMsg').textContent = 'Guardado';
  }

  toast('💾 Archivo guardado', 'ok');
}

/* PLUGINS */

async function pluginSearch() {
  const query = $('plgSearchInput')?.value.trim();

  if (!query) return;

  clearTimeout(pluginSearchTimer);
  const searchId = ++pluginSearchSeq;

  $('plgResults').innerHTML = spinnerBlock('Buscando...', 32);

  try {
    const data = await api(
      `/api/plugins/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(pluginSource)}&price=${encodeURIComponent(pluginPrice)}`
    );

    // Si mientras tanto se lanzó otra búsqueda, se descarta esta respuesta.
    if (searchId !== pluginSearchSeq) return;

    if (!data.ok) {
      throw new Error(data.error);
    }

    // Filtro de precio también en el cliente: Modrinth y Hangar son siempre
    // gratuitos, así que PREMIUM solo deja plugins de pago de SpigotMC.
    const results = (data.results || []).filter(plugin => {
      const isPremium =
        plugin.source === 'spigot' &&
        (Boolean(plugin.premium) || Number(plugin.price) > 0);

      if (pluginPrice === 'premium') return isPremium;
      if (pluginPrice === 'free') return !isPremium;

      return true;
    });

    renderPluginResults(results, data.errors || []);
  } catch (error) {
    if (searchId !== pluginSearchSeq) return;
    $('plgResults').innerHTML = emptyBlock(error.message);
  }
}

function renderPluginResults(results, errors) {
  const formatDownloads = value => {
    const n = Number(value) || 0;

    if (n >= 1e6) {
      return `${(n / 1e6).toFixed(1)}M`;
    }

    if (n >= 1000) {
      return `${Math.round(n / 1000)}k`;
    }

    return String(n);
  };

  const warning = errors.length
    ? `<div class="plg-warn-bar">⚠ ${errors.map(escHtml).join(' · ')}</div>`
    : '';

  const cards = results
    .map((plugin, index) => {
      const tag = SOURCE_LABELS[plugin.source] || String(plugin.source || '').toUpperCase();

      const external = plugin.external
        ? '<span class="plg-src-badge mc">🔗 EXTERNO</span>'
        : '';

      const premium = plugin.premium
        ? '<span class="plg-src-badge mc">💰 PREMIUM</span>'
        : '';

      return `
        <div class="plg-card" data-index="${index}">
          <div class="plg-card-top">
            ${
              plugin.icon
                ? `<img class="plg-card-icon" src="${escHtml(plugin.icon)}" width="42" height="42" loading="lazy" onerror="this.outerHTML='<div class=&quot;plg-card-icon-placeholder&quot;>🧩</div>'">`
                : '<div class="plg-card-icon-placeholder">🧩</div>'
            }

            <div class="plg-card-info">
              <div class="plg-card-name">${escHtml(plugin.name)}</div>

              <div class="plg-card-tags">
                <span class="plg-src-badge ${escHtml(plugin.source)}">${escHtml(tag)}</span>
                ${premium}
                ${external}
                <span class="plg-src-badge dl">⬇ ${formatDownloads(plugin.downloads)}</span>
              </div>
            </div>
          </div>

          <div class="plg-card-desc">${escHtml(plugin.description || '')}</div>

          <div class="plg-card-footer">
            <span></span>
            <button class="plg-versions-btn">Ver versiones →</button>
          </div>
        </div>
      `;
    })
    .join('');

  $('plgResults').innerHTML =
    warning +
    (cards
      ? `<div class="plg-grid">${cards}</div>`
      : emptyBlock('Sin resultados'));

  $('plgResults').querySelectorAll('.plg-card').forEach(card => {
    card.addEventListener('click', () =>
      openPluginVersions(results[Number(card.dataset.index)])
    );
  });
}

function closePluginModal() {
  if ($('plgVersionModal')) {
    $('plgVersionModal').style.display = 'none';
  }
}

async function openPluginVersions(plugin) {
  currentPlugin = plugin;

  const modal = $('plgVersionModal');

  // El modal debe colgar de <body>: dentro de .main queda atrapado en su
  // contexto de apilamiento (z-index: 1) y el sidebar lo tapa.
  if (modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }

  modal.style.display = '';

  const icon = $('plgModalIcon');

  if (plugin.icon) {
    icon.src = plugin.icon;
    icon.style.display = '';
  } else {
    icon.removeAttribute('src');
    icon.style.display = 'none';
  }

  $('plgModalName').textContent = plugin.name;

  $('plgModalMeta').textContent =
    `${plugin.source.toUpperCase()} · ${plugin.downloads || 0} descargas`;

  $('plgModalBody').innerHTML = spinnerBlock('Cargando versiones...');

  try {
    const data = await api(
      `/api/plugins/versions?id=${encodeURIComponent(plugin.id)}&source=${encodeURIComponent(plugin.source)}`
    );

    if (!data.ok) {
      throw new Error(data.error);
    }

    const versions = data.versions || [];
    const fmtDate = ts => (ts ? new Date(ts).toLocaleString('es-ES') : '');

    $('plgModalBody').innerHTML = versions.length
      ? `<div class="plg-ver-list">${versions.map((version, index) => {
          const number = version.versionNumber || version.name || 'Versión';
          const showName = version.name && version.name !== number;
          const changelog = version.changelog
            ? version.changelogIsHtml
              ? `<div class="plg-ver-changelog">${version.changelog}</div>`
              : `<div class="plg-ver-changelog">${escHtml(version.changelog)}</div>`
            : '';

          return `
            <div class="plg-ver-row">
              <div class="plg-ver-left">
                <div class="plg-ver-number">${escHtml(number)}</div>
                ${showName ? `<div class="plg-ver-name">${escHtml(version.name)}</div>` : ''}
                ${changelog}
              </div>
              <div class="plg-ver-right">
                <div class="plg-ver-meta">
                  ${version.published ? `<span class="plg-vm">📅 ${escHtml(fmtDate(version.published))}</span>` : ''}
                  ${version.downloads != null ? `<span class="plg-vm">⬇ ${escHtml(version.downloads)}</span>` : ''}
                  ${(version.gameVersions || []).slice(0, 4).map(g => `<span class="plg-vm">${escHtml(g)}</span>`).join('')}
                </div>
                ${
                  version.isExternal
                    ? `<a class="plg-dl-btn external" href="${escHtml(version.externalUrl)}" target="_blank" rel="noopener">ABRIR ↗</a>`
                    : `<button class="plg-dl-btn" data-version="${index}">INSTALAR</button>`
                }
              </div>
            </div>
          `;
        }).join('')}</div>`
      : emptyBlock('No hay versiones.');

    $('plgModalBody').querySelectorAll('[data-version]').forEach(button => {
      button.addEventListener('click', () =>
        installPlugin(versions[Number(button.dataset.version)], button)
      );
    });
  } catch (error) {
    $('plgModalBody').innerHTML = emptyBlock(error.message);
  }
}

async function installPlugin(version, button) {
  const file =
    (version.files || []).find(item => item.primary) || version.files?.[0];

  if (!file?.url) {
    toast('Esta versión requiere instalación externa.', 'err');
    return;
  }

  const filename =
    file.filename ||
    `${String(currentPlugin?.name || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_')}.jar`;

  if (button) {
    button.classList.add('loading');
    button.textContent = 'INSTALANDO...';
  }

  const data = await postJSON('/api/plugins/install', {
    url: file.url,
    filename,
  });

  if (!data.ok) {
    if (button) {
      button.classList.remove('loading');
      button.classList.add('err');
      button.textContent = 'ERROR';
    }

    toast(`❌ ${data.error}`, 'err');
    return;
  }

  if (button) {
    button.classList.remove('loading');
    button.classList.add('done');
    button.textContent = '✓ INSTALADO';
  }

  toast(`✅ ${filename} instalado`, 'ok');

  loadInstalledPlugins();
}

async function loadInstalledPlugins() {
  const element = $('plgInstalledList');

  if (!element) return;

  element.innerHTML = spinnerBlock('Cargando...');

  const data = await api('/api/plugins/installed');

  if (!data.ok) {
    element.innerHTML = emptyBlock(data.error);
    return;
  }

  const plugins = data.plugins || [];

  element.innerHTML = plugins.length
    ? plugins.map(plugin => `
        <div class="plg-inst-row">
          <span class="plg-inst-icon">☕</span>
          <div class="plg-inst-info">
            <div class="plg-inst-name">${escHtml(plugin.filename)}</div>
            <div class="plg-inst-meta">${escHtml(plugin.size)} · ${escHtml(plugin.modified)}</div>
          </div>
          <button class="icon-btn" title="Eliminar" data-delete-plugin="${escHtml(plugin.filename)}">🗑</button>
        </div>
      `).join('')
    : emptyBlock('No hay plugins .jar instalados.', '📂');

  element.querySelectorAll('[data-delete-plugin]').forEach(button => {
    button.addEventListener('click', async () => {
      const filename = button.dataset.deletePlugin;

      if (!confirm(`¿Eliminar ${filename}?`)) {
        return;
      }

      const result = await api(
        `/api/plugins/installed/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      );

      if (!result.ok) {
        toast(`❌ ${result.error}`, 'err');
      } else {
        loadInstalledPlugins();
      }
    });
  });
}

/* MINECRAFT VERSIONS */

async function loadSoftware() {
  const data = await api('/api/versions/software');

  if (!data.ok) {
    throw new Error(data.error);
  }

  const list = data.software || [];

  const element = $('versionList');

  if (!element) return;

  const groups = [
    ['server', 'Servidores'],
    ['proxy', 'Proxies'],
  ];

  element.innerHTML = `
    <div style="padding:16px">
      <div id="mwCurrentJar" style="margin-bottom:16px"></div>

      ${groups.map(([category, label]) => {
        const items = list.filter(sw => sw.category === category);

        if (!items.length) return '';

        return `
          <div class="ver-sw-category">
            <div class="ver-sw-cat-label">${label}</div>
            <div class="ver-sw-row">
              ${items.map(sw => `
                <div
                  class="ver-sw-card ${sw.external ? 'ver-sw-external' : ''}"
                  style="--sw-color:${escHtml(sw.color || '#00c8ff')}"
                  ${sw.external ? '' : `data-software="${escHtml(sw.id)}"`}
                >
                  <div class="ver-sw-name">${escHtml(sw.label)}</div>
                  <div class="ver-sw-desc">${escHtml(sw.desc || '')}</div>
                  ${sw.external ? `<a class="ver-ext-link" href="${escHtml(sw.external)}" target="_blank" rel="noopener">Descargar ↗</a>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}

      <div id="mwVersionDetails" style="margin-top:18px"></div>
    </div>
  `;

  element.querySelectorAll('[data-software]').forEach(card => {
    card.addEventListener('click', () => {
      element.querySelectorAll('.ver-sw-card').forEach(item =>
        item.classList.toggle('active', item === card)
      );

      selectSoftware(
        card.dataset.software,
        list.find(sw => sw.id === card.dataset.software)
      );
    });
  });

  const current = await api('/api/versions/current');

  if (current.ok && $('mwCurrentJar')) {
    $('mwCurrentJar').innerHTML = `
      <div class="ver-current-badge">
        <span class="vcb-dot" style="background:${current.exists ? 'var(--green)' : 'var(--red)'}"></span>
        server.jar:
        ${
          current.exists
            ? `${escHtml(current.size)} · ${escHtml(current.modified)}`
            : 'no encontrado'
        }
      </div>
    `;
  }
}

async function selectSoftware(id, meta) {
  versionState = {
    software: id,
    version: null,
    builds: [],
  };

  const details = $('mwVersionDetails');

  details.innerHTML = `
    <div class="ver-step-label">${escHtml((meta?.label || id).toUpperCase())} · VERSIONES</div>
    <div class="ver-loading">Cargando versiones...</div>
  `;

  const data = await api(
    `/api/versions/list?software=${encodeURIComponent(id)}`
  );

  if (!data.ok) {
    details.innerHTML = emptyBlock(data.error);
    return;
  }

  const versions = data.versions || [];

  details.innerHTML = `
    <div class="ver-step">
      <div class="ver-step-label">${escHtml((meta?.label || id).toUpperCase())} · VERSIONES</div>
      <div class="ver-version-bar">
        <input
          id="mwVersionSearch"
          class="ver-search-input"
          placeholder="Buscar versión..."
        >
        <div id="mwVersionPills" class="ver-version-grid"></div>
      </div>
    </div>

    <div id="mwBuilds"></div>
  `;

  const renderVersions = list => {
    $('mwVersionPills').innerHTML = list
      .map(version => `
        <button
          class="ver-pill ${version === versionState.version ? 'active' : ''}"
          data-version="${escHtml(version)}"
        >${escHtml(version)}</button>
      `)
      .join('');

    $('mwVersionPills').querySelectorAll('[data-version]').forEach(button => {
      button.addEventListener('click', () => {
        $('mwVersionPills').querySelectorAll('.ver-pill').forEach(item =>
          item.classList.toggle('active', item === button)
        );

        selectVersion(button.dataset.version);
      });
    });
  };

  renderVersions(versions);

  $('mwVersionSearch').addEventListener('input', event => {
    const query = event.target.value.toLowerCase();

    renderVersions(
      query
        ? versions.filter(version => version.toLowerCase().includes(query))
        : versions
    );
  });
}

async function selectVersion(version) {
  versionState.version = version;

  $('mwBuilds').innerHTML = '<div class="ver-loading">Cargando builds...</div>';

  const data = await api(
    `/api/versions/builds?software=${encodeURIComponent(versionState.software)}&version=${encodeURIComponent(version)}`
  );

  if (!data.ok) {
    $('mwBuilds').innerHTML = emptyBlock(data.error);
    return;
  }

  versionState.builds = data.builds || [];

  const builds = versionState.builds;

  $('mwBuilds').innerHTML = builds.length
    ? `
      <div class="panel">
        ${builds.map((build, index) => {
          const channel = String(build.channel || 'STABLE').toLowerCase();
          const channelClass = channel === 'stable' ? 'stable' : 'experimental';

          return `
            <div class="ver-build-row ${index === 0 ? 'ver-build-latest' : ''}">
              <div class="ver-build-left">
                <div class="ver-build-num">
                  ${
                    versionState.software === 'fabric'
                      ? `Loader ${escHtml(build.loaderVersion)}`
                      : `Build #${escHtml(build.build)}`
                  }
                  ${index === 0 ? '<span class="ver-latest-tag">ÚLTIMA</span>' : ''}
                </div>
                ${build.time ? `<div class="ver-build-time">${escHtml(new Date(build.time).toLocaleString('es-ES'))}</div>` : ''}
                ${build.changes ? `<div class="ver-build-changes">${escHtml(build.changes)}</div>` : ''}
              </div>
              <div class="ver-build-right">
                <span class="ver-channel ${channelClass}">${escHtml(String(build.channel || 'STABLE').toUpperCase())}</span>
                <button class="ver-install-btn" data-build="${index}">INSTALAR</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `
    : emptyBlock('No hay builds disponibles.');

  $('mwBuilds').querySelectorAll('[data-build]').forEach(button => {
    button.addEventListener('click', () =>
      installServerBuild(versionState.builds[Number(button.dataset.build)])
    );
  });
}

async function installServerBuild(build) {
  if (!confirm(
    `Actualizar server.jar a ${versionState.software} ${versionState.version}?`
  )) {
    return;
  }

  const data = await postJSON('/api/versions/install', {
    software: versionState.software,
    version: versionState.version,
    build: build.build,
    url: build.url,
    loaderVersion: build.loaderVersion,
  });

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
  } else {
    toast(`✅ ${data.note || 'server.jar actualizado'}`, 'ok');
  }
}

/* STARTUP */

async function loadStartup() {
  const element = $('startupList');

  if (!element) return;

  element.innerHTML = spinnerBlock('Cargando configuración...');

  const data = await api('/api/startup');

  if (!data.ok) {
    element.innerHTML = emptyBlock(data.error);
    return;
  }

  const cfg = data.config || {};
  const jars = Array.isArray(data.jars) ? data.jars : [];
  const hasCurrentJar = jars.includes(cfg.jar);
  const port = data.serverPort;

  element.innerHTML = `
    <div class="startup-form">

      <div class="form-group">
        <label class="form-label">Archivo .jar del servidor</label>
        ${
          jars.length
            ? `
              <select id="stJar" class="form-select">
                ${jars.map(jar => `
                  <option value="${escHtml(jar)}" ${jar === cfg.jar ? 'selected' : ''}>${escHtml(jar)}</option>
                `).join('')}
              </select>
              <div class="form-hint">
                Se lanzará este archivo al pulsar ARRANCAR.
                ${!hasCurrentJar ? ` El configurado actualmente ("${escHtml(cfg.jar)}") no está en la carpeta — elige uno de la lista y guarda.` : ''}
              </div>
            `
            : `
              <div class="form-hint" style="color:var(--red)">
                No se encontró ningún .jar en la carpeta del servidor. Sube uno desde Archivos o instala uno desde Versiones.
              </div>
            `
        }
      </div>

      <div class="form-group">
        <label class="form-label">Ejecutable de Java</label>
        <input id="stJavaPath" class="form-input" type="text" placeholder="java" value="${escHtml(cfg.javaPath || 'java')}">
        <div class="form-hint">Déjalo en "java" salvo que necesites otra versión, p. ej. "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe".</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Memoria mínima (MB)</label>
          <input id="stMinMem" class="form-input" type="number" min="256" step="256" value="${escHtml(cfg.minMemoryMb ?? 1024)}">
        </div>
        <div class="form-group">
          <label class="form-label">Memoria máxima (MB)</label>
          <input id="stMaxMem" class="form-input" type="number" min="256" step="256" value="${escHtml(cfg.maxMemoryMb ?? 2048)}">
        </div>
      </div>

      <div class="form-group">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <label class="form-label" style="margin-bottom:0">Argumentos JVM extra (antes de "-jar")</label>
          <button type="button" class="small-btn" id="btnAikarFlags" style="font-size:10px;padding:4px 9px;flex-shrink:0">⚡ Usar Aikar's Flags</button>
        </div>
        <input id="stArgs" class="form-input" type="text" placeholder="-XX:+UseG1GC" value="${escHtml(cfg.extraArgs || '')}">
        <div class="form-hint">Flags de la JVM (recolector de basura, memoria avanzada...). Se insertan justo antes de "-jar".</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Puerto del servidor</label>
          <input id="stPort" class="form-input" type="number" min="1" max="65535" placeholder="25565" value="${port ?? ''}">
          <div class="form-hint">Se guarda como server-port en server.properties.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Comando de parada</label>
          <input id="stStopCmd" class="form-input" type="text" placeholder="stop" value="${escHtml(cfg.stopCommand || 'stop')}">
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-name">Reinicio automático si se cae</div>
          <div class="setting-desc">Relanza el servidor si el proceso termina de forma inesperada (no cuenta pulsar DETENER).</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="stAutoRestart" ${cfg.autoRestartOnCrash ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="setting-row" style="border-bottom:none">
        <div>
          <div class="setting-name">Arranque automático</div>
          <div class="setting-desc">Inicia el servidor en cuanto MoonWolf Panel/Agent se ponga en marcha.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="stAutoStart" ${cfg.autoStartOnBoot ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <button class="save-btn" id="btnSaveStartup" ${jars.length ? '' : 'disabled'}>💾 GUARDAR</button>
    </div>
  `;

  $('btnSaveStartup')?.addEventListener('click', saveStartup);

  $('btnAikarFlags')?.addEventListener('click', () => {
    const input = $('stArgs');

    if (!input) return;

    input.value = AIKAR_FLAGS;
    toast('⚡ Flags de Aikar aplicados — recuerda GUARDAR', 'ok');
  });
}

async function saveStartup() {
  const jarSelect = $('stJar');

  if (!jarSelect || !jarSelect.value) {
    toast('❌ No hay ningún .jar seleccionable', 'err');
    return;
  }

  const portValue = $('stPort')?.value.trim();

  const body = {
    jar: jarSelect.value,
    javaPath: $('stJavaPath')?.value.trim() || 'java',
    minMemoryMb: Number($('stMinMem')?.value) || 1024,
    maxMemoryMb: Number($('stMaxMem')?.value) || 2048,
    extraArgs: $('stArgs')?.value.trim() || '',
    programArgs: $('stProgramArgs')?.value.trim() || '',
    stopCommand: $('stStopCmd')?.value.trim() || 'stop',
    autoRestartOnCrash: Boolean($('stAutoRestart')?.checked),
    autoStartOnBoot: Boolean($('stAutoStart')?.checked),
    serverPort: portValue ? Number(portValue) : undefined,
  };

  const button = $('btnSaveStartup');

  if (button) {
    button.disabled = true;
    button.textContent = 'GUARDANDO...';
  }

  const data = await postJSON('/api/startup', body);

  if (button) {
    button.disabled = false;
    button.textContent = '💾 GUARDAR';
  }

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
    return;
  }

  toast('✅ Configuración de arranque guardada', 'ok');
  loadStartup();
}

/* NAVIGATION */

function switchView(id) {
  document
    .querySelectorAll('.view')
    .forEach(view => view.classList.remove('active'));

  document
    .querySelectorAll('.sb-item')
    .forEach(item => item.classList.remove('active'));

  $(`view-${id}`)?.classList.add('active');

  document
    .querySelector(`.sb-item[data-view="${id}"]`)
    ?.classList.add('active');

  switch (id) {
    case 'files':
      populateFiles(currentDir);
      break;

    case 'versions':
      loadSoftware().catch(error => toast(error.message, 'err'));
      break;

    case 'plugins':
      loadInstalledPlugins();
      break;

    case 'startup':
      loadStartup();
      break;

    case 'activitylog':
      renderActivity();
      break;

    case 'settings':
      renderSettings();
      break;
  }
}

/* ACTIVITY */

function addActivity(message, level = 'info', icon = '📌') {
  activities.push({
    message,
    level,
    icon,
    time: new Date().toLocaleTimeString('es-ES'),
  });

  if (activities.length > 200) {
    activities.shift();
  }

  if ($('view-activitylog')?.classList.contains('active')) {
    renderActivity();
  }
}

function renderActivity() {
  const element = $('activityList');

  if (!element) return;

  element.innerHTML = activities.length
    ? activities
        .slice()
        .reverse()
        .map(item => `
          <div class="act-row">
            <span class="act-icon">${escHtml(item.icon)}</span>
            <div class="act-body">
              <div class="act-msg">${escHtml(item.message)}</div>
              <div class="act-time">${escHtml(item.time)}</div>
            </div>
            <span class="act-level ${escHtml(item.level)}">${escHtml(String(item.level).toUpperCase())}</span>
          </div>
        `)
        .join('')
    : emptyBlock('No hay actividad todavía.');
}

/* SETTINGS */

async function loadShareTokens() {
  if (panelKind !== 'owner' || panelPermission !== 'admin') return;

  const list = $('shareTokenList');
  if (!list) return;

  try {
    const data = await cloudApi('/api/share-tokens');
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];

    list.innerHTML = tokens.length
      ? tokens.map(token => {
          const expiry = token.expiresAt
            ? new Date(token.expiresAt).toLocaleString('es-ES')
            : 'Nunca';
          return `
            <div class="setting-row" style="align-items:flex-start">
              <div style="min-width:0;flex:1">
                <div class="setting-name">${escHtml(token.label)}</div>
                <div class="setting-desc">
                  ${token.permission === 'control' ? '🎮 Control' : '👁️ Solo lectura'} · Caduca: ${escHtml(expiry)}
                </div>
              </div>
              <button class="small-btn" data-revoke-share="${escHtml(token.id)}">Revocar</button>
            </div>
          `;
        }).join('')
      : emptyBlock('No hay accesos compartidos activos.');

    list.querySelectorAll('[data-revoke-share]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await cloudApi(`/api/share-tokens/${encodeURIComponent(button.dataset.revokeShare)}`, { method: 'DELETE' });
          toast('Acceso revocado.', 'ok');
          await loadShareTokens();
        } catch (error) {
          toast(error.message, 'err');
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    list.innerHTML = emptyBlock(error.message);
  }
}

function bindShareSettings() {
  if (panelKind !== 'owner' || panelPermission !== 'admin') return;

  $('btnCreateShare')?.addEventListener('click', async () => {
    const button = $('btnCreateShare');
    button.disabled = true;

    try {
      const data = await cloudApi('/api/share-tokens', {
        method: 'POST',
        body: JSON.stringify({
          label: $('shareLabel')?.value || '',
          permission: $('sharePermission')?.value || 'read',
          expires: $('shareExpiry')?.value || 'never',
        }),
      });

      const token = data.token;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(token);
          copied = true;
        }
      } catch {}

      $('shareCreatedToken').textContent = token;
      $('shareCreatedBox').style.display = '';
      $('shareLabel').value = '';
      toast(copied ? 'Token creado y copiado al portapapeles.' : 'Token creado. Cópialo antes de cerrar esta pantalla.', 'ok');
      await loadShareTokens();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('btnCopyShareToken')?.addEventListener('click', async event => {
    const token = $('shareCreatedToken')?.textContent || '';
    try {
      await navigator.clipboard.writeText(token);
      flashButton(event.currentTarget, 'Copiado');
    } catch {
      toast('No se pudo copiar el token.', 'err');
    }
  });

  loadShareTokens();
}

function renderSettings() {
  const element = $('settingsList');

  if (!element) return;

  element.innerHTML = `
    <div class="settings-section">
      <div class="setting-row">
        <div>
          <div class="setting-name">MoonWolf Cloud</div>
          <div class="setting-desc">WebSocket</div>
        </div>
        <span>${agentOnline ? '🟢 Agent conectado' : '🔴 Agent desconectado'}</span>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-name">Agent conectado</div>
          <div class="setting-desc">Identificador de la instalación</div>
        </div>
        <code style="font-size:11px">${escHtml(agentId || '—')}</code>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-name">Conexión</div>
          <div class="setting-desc">MoonWolf Cloud / Render WebSocket</div>
        </div>
        <span>${cloudSocket?.connected ? '🟢 ONLINE' : '🔴 OFFLINE'}</span>
      </div>
    </div>

    ${panelKind === 'owner' && panelPermission === 'admin' ? `
      <div class="settings-section">
        <div class="settings-title">🔐 ACCESOS COMPARTIDOS</div>
        <div class="setting-desc" style="margin-bottom:12px">Crea accesos para otras personas sin compartir tu código de propietario.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <input id="shareLabel" class="form-input" placeholder="Nombre (ej. Paco)" maxlength="60">
          <select id="sharePermission" class="form-select">
            <option value="read">👁️ Solo lectura</option>
            <option value="control">🎮 Control</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <select id="shareExpiry" class="form-select" style="flex:1">
            <option value="never">Sin caducidad</option>
            <option value="1h">1 hora</option>
            <option value="1d">1 día</option>
            <option value="7d">7 días</option>
            <option value="30d">30 días</option>
          </select>
          <button class="small-btn" id="btnCreateShare">Crear token</button>
        </div>
        <div id="shareCreatedBox" style="display:none;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
          <div class="setting-desc" style="margin-bottom:5px">TOKEN CREADO — se muestra una sola vez aquí</div>
          <div style="display:flex;gap:8px;align-items:center">
            <code id="shareCreatedToken" style="font-size:11px;word-break:break-all;flex:1"></code>
            <button class="small-btn" id="btnCopyShareToken">Copiar</button>
          </div>
        </div>
        <div id="shareTokenList"></div>
      </div>
    ` : ''}

    <div class="settings-section">
      <button class="small-btn" id="btnDisconnectCloud">Desconectar</button>
    </div>
  `;

  $('btnDisconnectCloud')?.addEventListener('click', () => {
    cloudSocket?.disconnect();

    setAgentOnline(false);

    currentStatus = 'offline';
    updateStatusUi('offline');

    clearSession();

    showLogin('Desconectado.');
  });

  bindShareSettings();
}

/* TOAST */

function toast(message, type = 'info') {
  const element = $('toast');

  if (!element) return;

  element.textContent = message;

  element.className = `toast show ${type}`;

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    element.className = 'toast';
  }, 3000);
}

/* EVENTS */

function bindEvents() {
  ensureLoginGate();

  document.querySelectorAll('.sb-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });

  $('btnStart')?.addEventListener('click', startServer);
  $('btnStop')?.addEventListener('click', stopServer);
  $('btnRestart')?.addEventListener('click', restartServer);
  $('btnSendCmd')?.addEventListener('click', sendCmd);

  $('cmdInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      sendCmd();
    }
  });

  document.querySelectorAll('.quick-btn').forEach(button => {
    button.addEventListener('click', () => {
      const input = $('cmdInput');

      if (!input) return;

      input.value = button.dataset.cmd || '';

      sendCmd();
    });
  });

  $('btnClearConsole')?.addEventListener('click', () => {
    if ($('console')) {
      $('console').innerHTML = '';
    }
  });

  $('crumbHome')?.addEventListener('click', () => populateFiles(''));

  $('btnEditorBack')?.addEventListener('click', () => {
    if ($('filesEditorPanel')) {
      $('filesEditorPanel').style.display = 'none';
    }

    if ($('filesTablePanel')) {
      $('filesTablePanel').style.display = '';
    }

    if (editor?.toTextArea) {
      editor.toTextArea();
    }

    editor = null;
    currentFile = null;
  });

  $('btnSaveFile')?.addEventListener('click', saveCurrentFile);

  document.addEventListener('keydown', event => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 's' &&
      currentFile
    ) {
      event.preventDefault();
      saveCurrentFile();
    }

    if (event.key === 'Escape') {
      closePluginModal();
    }
  });

  document.querySelectorAll('.plg-source').forEach(button => {
    button.addEventListener('click', () => {
      pluginSource = button.dataset.source;

      document.querySelectorAll('.plg-source').forEach(item =>
        item.classList.toggle('active', item === button)
      );
    });
  });

  document.querySelectorAll('.plg-price').forEach(button => {
    button.addEventListener('click', () => {
      pluginPrice = button.dataset.price;

      document.querySelectorAll('.plg-price').forEach(item =>
        item.classList.toggle('active', item === button)
      );

      if ($('plgTabSearchNote')) {
        $('plgTabSearchNote').style.display = pluginPrice === 'all' ? 'none' : '';
      }

      // Si ya hay una búsqueda escrita, se relanza con el nuevo filtro.
      if ($('plgSearchInput')?.value.trim()) {
        pluginSearch();
      }
    });
  });

  document.querySelectorAll('.plg-tab-btn').forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab;

      document.querySelectorAll('.plg-tab-btn').forEach(item =>
        item.classList.toggle('active', item === button)
      );

      if ($('plgTabSearch')) {
        $('plgTabSearch').style.display = tab === 'search' ? '' : 'none';
      }

      if ($('plgTabInstalled')) {
        $('plgTabInstalled').style.display = tab === 'installed' ? '' : 'none';
      }

      if (tab === 'installed') {
        loadInstalledPlugins();
      }
    });
  });

  $('btnPluginSearch')?.addEventListener('click', pluginSearch);

  // Búsqueda mientras se escribe (con retardo para no saturar las APIs).
  $('plgSearchInput')?.addEventListener('input', () => {
    clearTimeout(pluginSearchTimer);

    if ($('plgSearchInput').value.trim().length < 2) return;

    pluginSearchTimer = setTimeout(pluginSearch, 450);
  });

  $('plgSearchInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      pluginSearch();
    }
  });

  $('btnRefreshInstalled')?.addEventListener('click', loadInstalledPlugins);

  $('btnClosePlgModal')?.addEventListener('click', closePluginModal);

  $('plgVersionModal')?.addEventListener('click', event => {
    if (event.target === $('plgVersionModal')) {
      closePluginModal();
    }
  });

  updateAgentUi(agentOnline);
  updateStatusUi(currentStatus);

  if (panelSession && agentId) {
    connectCloud(false).catch(() =>
      showLogin('La sesión no es válida. Introduce un nuevo código de emparejamiento.')
    );
  } else {
    showLogin('');
  }
}

/* START */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents, { once: true });
} else {
  bindEvents();
}
