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
let priceFilter = 'all';

let versionState = {
  software: null,
  softwareLabel: null,
  version: null,
  builds: [],
};

const pending = new Map();
const activities = [];

let lastAgentActivityState = null;
let lastStatusActivity = null;

/* SOCKET.IO */

function ensureSocketIo() {
  if (typeof window.io === 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-moonwolf-socketio]');

    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('No se pudo cargar Socket.IO.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');

    script.src = '/socket.io/socket.io.js';
    script.async = true;
    script.dataset.moonwolfSocketio = '1';

    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar Socket.IO.'));

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
  button.textContent = 'Emparejando...';

  if ($('mwCloudError')) {
    $('mwCloudError').textContent = '';
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

    button.textContent = 'CONECTAR SERVIDOR';
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
    showLogin('Empareja este panel con MoonWolf Agent.');

    return Promise.reject(new Error('Código de conexión inválido.'));
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

      addActivity('Conectado a MoonWolf Cloud', 'ok', '☁️');

      finish(resolve);
    });

    cloudSocket.once('connect_error', error => {
      const message =
        error?.message || 'No se pudo conectar con MoonWolf Cloud.';

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

      addActivity(`Cloud desconectado (${reason})`, 'warn', '⚠️');

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
    return Promise.reject(new Error('MoonWolf Cloud no está conectado.'));
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
  return api(pathname, { method: 'POST', body });
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

  const textElements = [$('agentStatusText'), $('sbAgentStatusText')];

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
    $('statPlayers').innerHTML = `${safePlayers}<span class="stat-unit">/${safeMaxPlayers}</span>`;
  }

  const tpsEl = $('statTps');

  if (tpsEl) {
    tpsEl.className = `stat-value ${
      safeTps < 15 ? 'tps-bad' : safeTps < 18 ? 'tps-warn' : 'tps-good'
    }`;

    tpsEl.innerHTML = `${safeTps}<span class="stat-unit"> tps</span>`;
  }

  if ($('statUptime')) {
    $('statUptime').textContent = stats.uptime || '0h 0m';
  }

  if ($('statMemProc')) {
    $('statMemProc').innerHTML = `${safeProcessMemory}<span class="stat-unit"> MB</span>`;
  }

  const sys = stats.sysMemory || { used: 0, total: 0 };

  const used = Number(sys.used);
  const total = Number(sys.total);

  const safeUsed = Number.isFinite(used) ? used : 0;
  const safeTotal = Number.isFinite(total) ? total : 0;

  if ($('statMemSys')) {
    $('statMemSys').innerHTML = `${safeUsed}/${safeTotal}<span class="stat-unit"> GB</span>`;
  }

  if ($('statCpu')) {
    $('statCpu').innerHTML = `${safeCpu}<span class="stat-unit"> %</span>`;
  }
}

/* ══════════════════════════════════════════════
   FILTRO DE LOGS
   ══════════════════════════════════════════════ */
const LOG_IGNORE_PATTERNS = [
  /Thread RCON Client \/127\.0\.0\.1 (started|shutting down)/i,
];

function shouldIgnoreLog(line) {
  const text = String(line || '');

  return LOG_IGNORE_PATTERNS.some(re => re.test(text));
}

function appendLog(entry) {
  const consoleEl = $('console');

  if (!consoleEl) return;

  const line = String(entry?.line || '');

  if (shouldIgnoreLog(line)) {
    return;
  }

  const div = document.createElement('div');

  div.className = `log-line ${entry?.type || 'info'}`;

  div.innerHTML =
    `<span class="log-time">${escHtml(entry?.time || '--:--:--')}</span>` +
    `<span class="log-text">${escHtml(line)}</span>`;

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

  list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon" style="display:inline-block;animation:spin 1s linear infinite">⟳</div>
      <div class="empty-msg">Cargando...</div>
    </div>
  `;

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
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📂</div>
            <div class="empty-msg">Carpeta vacía</div>
          </div>
        `;

        return;
      }

      list.innerHTML = items
        .map(
          item => `
          <div class="file-row" data-name="${escHtml(item.name)}" data-type="${escHtml(item.type)}">
            <span class="file-name" style="flex:1">
              ${fileIcon(item.type)}
              <span>${escHtml(item.name)}</span>
            </span>
            <span style="width:90px;text-align:right;color:var(--muted2)">${escHtml(item.size)}</span>
            <span style="width:140px;text-align:right;color:var(--muted2)">${escHtml(item.date)}</span>
          </div>
        `
        )
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

      return `
        /
        <span class="crumb" data-path="${escHtml(acc)}">${escHtml(part)}</span>
      `;
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
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  menu.innerHTML = `
    ${type !== 'dir' ? '<div class="ctx-item" data-action="open">📂 Abrir</div>' : ''}
    <div class="ctx-item" data-action="rename">✏️ Renombrar</div>
    <div class="ctx-item" data-action="copy">📋 Copiar</div>
    <div class="ctx-item" data-action="move">🔀 Mover</div>
    ${type !== 'dir' ? '<div class="ctx-item" data-action="download">⬇️ Descargar</div>' : ''}
    <div class="ctx-item" data-action="compress">🗜️ Comprimir</div>
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

        if (!data.ok) throw new Error(data.error);
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

        if (!data.ok) throw new Error(data.error);
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

        if (!data.ok) throw new Error(data.error);
      }

      if (action === 'download') {
        return downloadFile(rel, name);
      }

      if (action === 'compress') {
        const data = await postJSON('/api/files/compress', {
          path: rel,
          name,
        });

        if (!data.ok) throw new Error(data.error);
      }

      if (action === 'delete') {
        if (!confirm(`¿Eliminar "${name}"?`)) {
          return;
        }

        const data = await postJSON('/api/files/delete', {
          path: rel,
          isDir: type === 'dir',
        });

        if (!data.ok) throw new Error(data.error);
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

const FILE_UPLOAD_CHUNK_SIZE = 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;

  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }

  return btoa(binary);
}

function normalizeUploadRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
}

async function uploadOneFile(file, relativePath, progressState) {
  const relPath = normalizeUploadRelativePath(relativePath || file.name);

  if (!relPath) {
    throw new Error(`Nombre de archivo no válido: ${file.name}`);
  }

  const target = currentDir
    ? `${currentDir.replace(/\\/g, '/').replace(/\/$/, '')}/${relPath}`
    : relPath;

  const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${progressState.index}`;
  let offset = 0;

  while (offset < file.size || (file.size === 0 && offset === 0)) {
    const end = file.size === 0 ? 0 : Math.min(offset + FILE_UPLOAD_CHUNK_SIZE, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const data = await postJSON('/api/files/upload-chunk', {
      uploadId,
      path: target,
      offset,
      totalSize: file.size,
      chunkBase64: bytesToBase64(bytes),
      final: end >= file.size,
      overwrite: true,
    });

    if (!data.ok) {
      throw new Error(data.error || `No se pudo subir ${file.name}`);
    }

    if (file.size === 0) {
      offset = 1;
      break;
    }

    offset = end;
    progressState.doneBytes += bytes.length;
    const percent = progressState.totalBytes > 0
      ? Math.round((progressState.doneBytes / progressState.totalBytes) * 100)
      : 100;

    toast(`⬆️ Subiendo ${progressState.index + 1}/${progressState.totalFiles}: ${percent}%`, 'info');
  }

  progressState.index += 1;
}

async function uploadSelectedFiles(fileList) {
  const files = Array.from(fileList || {}).filter(file => file && typeof file.size === 'number');

  if (!files.length) return;

  const progressState = {
    index: 0,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    doneBytes: 0,
  };

  try {
    for (const file of files) {
      const relative = file.webkitRelativePath || file.name;
      await uploadOneFile(file, relative, progressState);
    }

    toast(`✅ ${files.length} ${files.length === 1 ? 'archivo subido' : 'archivos subidos'} correctamente`, 'ok');
    populateFiles(currentDir);
  } catch (error) {
    toast(`❌ ${error.message}`, 'err');
  }
}

async function downloadFile(rel, filename) {
  const result = await rpcHttp(
    `/api/files/download?path=${encodeURIComponent(rel)}`
  );

  if (!result?.bodyBase64) {
    toast(result?.data?.error || 'No se pudo descargar el archivo.', 'err');
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
      $('editorFileName').innerHTML = `📄 ${escHtml(
        data.filename || rel.split('/').pop()
      )}`;
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

  if ($('edLine')) $('edLine').textContent = cursor.line + 1;
  if ($('edCol')) $('edCol').textContent = cursor.ch + 1;
  if ($('edLines')) $('edLines').textContent = editor.lineCount();
}

async function saveCurrentFile() {
  if (!currentFile) return;

  const content = editor ? editor.getValue() : $('mwEditorArea')?.value || '';

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

  $('plgResults').innerHTML = `
    <div class="empty-state">
      <div style="font-size:32px;animation:spin 1s linear infinite">⟳</div>
      <div class="empty-msg">Buscando...</div>
    </div>
  `;

  try {
    const data = await api(
      `/api/plugins/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(pluginSource)}`
    );

    if (!data.ok) {
      throw new Error(data.error);
    }

    let results = data.results || [];

    if (priceFilter === 'free') {
      results = results.filter(plugin => !plugin.premium);
    } else if (priceFilter === 'premium') {
      results = results.filter(plugin => plugin.premium);
    }

    renderPluginResults(results, data.errors || []);
  } catch (error) {
    $('plgResults').innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(error.message)}</div>
      </div>
    `;
  }
}

function renderPluginResults(results, errors) {
  const formatDownloads = value => {
    const n = Number(value) || 0;

    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;

    return String(n);
  };

  const warning = errors.length
    ? `<div class="plg-warn-bar">⚠ ${errors.map(escHtml).join(' · ')}</div>`
    : '';

  const cards = results
    .map((plugin, index) => {
      const tag = ({ modrinth: 'MODRINTH', spigot: 'SPIGOT', hangar: 'HANGAR' })[plugin.source] || String(plugin.source || '').toUpperCase();
      const external = plugin.external
        ? '<span class="plg-src-badge">🔗 EXTERNO</span>'
        : '';
      const premium = plugin.premium
        ? '<span class="plg-src-badge">💰 PREMIUM</span>'
        : '';

      return `
        <div class="plg-card" data-index="${index}">
          <div class="plg-card-top">
            ${
              plugin.icon
                ? `<img class="plg-card-icon" src="${escHtml(plugin.icon)}" width="42" height="42" loading="lazy">`
                : `<div class="plg-card-icon-placeholder">🧩</div>`
            }
            <div class="plg-card-info">
              <div class="plg-card-name">${escHtml(plugin.name)}</div>
              <div class="plg-card-tags">
                <span class="plg-src-badge ${escHtml(plugin.source)}">${tag}</span>
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
      : `<div class="empty-state"><div class="empty-msg">Sin resultados</div></div>`);

  $('plgResults')
    .querySelectorAll('.plg-card')
    .forEach(card => {
      card.addEventListener('click', () =>
        openPluginVersions(results[Number(card.dataset.index)])
      );
    });
}

async function openPluginVersions(plugin) {
  currentPlugin = plugin;

  $('plgVersionModal').style.display = '';
  $('plgModalIcon').src = plugin.icon || '';
  $('plgModalName').textContent = plugin.name;
  $('plgModalMeta').textContent = `${plugin.source.toUpperCase()} · ${plugin.downloads || 0} descargas`;

  $('plgModalBody').innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Cargando versiones...</div>
    </div>
  `;

  try {
    const data = await api(
      `/api/plugins/versions?id=${encodeURIComponent(plugin.id)}&source=${encodeURIComponent(plugin.source)}`
    );

    if (!data.ok) {
      throw new Error(data.error);
    }

    const versions = data.versions || [];

    if (!versions.length) {
      $('plgModalBody').innerHTML = '<div class="empty-state"><div class="empty-msg">No hay versiones.</div></div>';
      return;
    }

    $('plgModalBody').innerHTML = versions
      .map((version, index) => {
        const published = version.published
          ? new Date(version.published).toLocaleString('es-ES')
          : '';

        const changelog = version.changelog
          ? `<div class="plg-ver-changelog">${version.changelogIsHtml
              ? version.changelog
              : escHtml(version.changelog)}</div>`
          : '';

        const action = version.isExternal
          ? `<a class="plg-dl-btn external" href="${escHtml(version.externalUrl)}" target="_blank" rel="noopener">ABRIR</a>`
          : `<button class="plg-dl-btn" data-version="${index}">INSTALAR</button>`;

        return `
          <div class="plg-ver-row">
            <div class="plg-ver-left">
              <div class="plg-ver-number">${escHtml(version.versionNumber || version.name || 'Versión')}</div>
              ${published ? `<div class="plg-ver-meta"><span class="plg-vm">${escHtml(published)}</span></div>` : ''}
              ${changelog}
            </div>
            <div class="plg-ver-right">
              ${action}
            </div>
          </div>
        `;
      })
      .join('');

    $('plgModalBody')
      .querySelectorAll('[data-version]')
      .forEach(button => {
        button.addEventListener('click', () =>
          installPlugin(versions[Number(button.dataset.version)])
        );
      });
  } catch (error) {
    $('plgModalBody').innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(error.message)}</div>
      </div>
    `;
  }
}

async function installPlugin(version) {
  const file = (version.files || []).find(item => item.primary) || version.files?.[0];

  if (!file?.url) {
    toast('Esta versión requiere instalación externa.', 'err');
    return;
  }

  const filename =
    file.filename ||
    `${String(currentPlugin?.name || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_')}.jar`;

  $('plgModalBody').insertAdjacentHTML(
    'afterbegin',
    '<div class="plg-warn-bar">📥 Instalando...</div>'
  );

  const data = await postJSON('/api/plugins/install', {
    url: file.url,
    filename,
  });

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
    return;
  }

  toast(`✅ ${filename} instalado`, 'ok');

  loadInstalledPlugins();
}

async function loadInstalledPlugins() {
  const element = $('plgInstalledList');

  if (!element) return;

  element.innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Cargando...</div>
    </div>
  `;

  const data = await api('/api/plugins/installed');

  if (!data.ok) {
    element.innerHTML = `<div class="empty-state">${escHtml(data.error)}</div>`;
    return;
  }

  element.innerHTML =
    (data.plugins || [])
      .map(
        plugin => `
        <div class="installed-plugin-row">
          <div>
            <strong>☕ ${escHtml(plugin.filename)}</strong>
            <div style="font-size:11px;color:var(--muted2)">${escHtml(plugin.size)} · ${escHtml(plugin.modified)}</div>
          </div>
          <button class="small-btn danger" data-delete-plugin="${escHtml(plugin.filename)}">Eliminar</button>
        </div>
      `
      )
      .join('') ||
    `<div class="empty-state">No hay plugins .jar instalados.</div>`;

  element.querySelectorAll('[data-delete-plugin]').forEach(button => {
    button.addEventListener('click', async () => {
      const filename = button.dataset.deletePlugin;

      if (!confirm(`¿Eliminar ${filename}?`)) {
        return;
      }

      const data = await api(
        `/api/plugins/installed/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      );

      if (!data.ok) {
        toast(`❌ ${data.error}`, 'err');
      } else {
        loadInstalledPlugins();
      }
    });
  });
}

/* ══════════════════════════════════════════════
   VERSIONS & SOFTWARE
   ══════════════════════════════════════════════ */

let versionCatalog = [];
let versionCurrent = {
  software: '',
  version: '',
  build: '',
};

function versionFindSoftware(id) {
  return versionCatalog.find(item => item.id === id) || {
    id,
    label: id,
    desc: '',
  };
}

function versionCategoryName(category) {
  if (category === 'plugins') return 'Versiones de plugins';
  if (category === 'mods' || category === 'mod') return 'Versiones de mods';
  if (category === 'proxy') return 'Versiones de proxy';
  if (category === 'hybrid') return 'Versiones de híbridos';
  if (category === 'vanilla') return 'Versiones de Vanilla';
  return 'Servidores de Minecraft';
}

function renderVersionSoftwareCard(software) {
  return `
    <button type="button" class="ver-software-card" data-software="${escHtml(software.id)}">
      <div class="ver-software-icon">${software.icon || '📦'}</div>
      <div class="ver-software-content">
        <div class="ver-software-name">${escHtml(software.label || software.name || software.id)}</div>
        <div class="ver-software-desc">${escHtml(software.desc || software.description || '')}</div>
      </div>
      <div class="ver-software-arrow">›</div>
    </button>
  `;
}

function renderVersionSoftware() {
  const container = $('versionList');
  if (!container) return;

  if (!versionCatalog.length) {
    container.innerHTML = `
      <div class="ver-empty">
        <div class="ver-empty-icon">📦</div>
        <div class="ver-empty-title">No se han podido cargar los servidores</div>
        <div class="ver-empty-text">Comprueba que el Agent esté conectado y vuelve a intentarlo.</div>
        <button type="button" class="btn btn-primary ver-retry-btn" id="verRetry">Reintentar</button>
      </div>
    `;
    $('verRetry')?.addEventListener('click', () => loadVersionState());
    return;
  }

  const groups = {};
  for (const item of versionCatalog) {
    const category = item.category || 'plugins';
    (groups[category] ||= []).push(item);
  }

  const categoryOrder = ['plugins', 'mods', 'proxy', 'hybrid', 'vanilla'];
  const categoryIcon = {
    plugins: '🧩',
    mods: '🧵',
    proxy: '🌐',
    hybrid: '🔀',
    vanilla: '🌿',
  };

  const orderedGroups = categoryOrder
    .filter(category => groups[category]?.length)
    .map(category => [category, groups[category]]);

  container.innerHTML = `
    <div class="ver-hero">
      <div class="ver-hero-icon">📦</div>
      <div>
        <div class="ver-hero-title">Versiones de Minecraft</div>
        <div class="ver-hero-description">Selecciona una categoría, el software y después la versión que quieres instalar.</div>
      </div>
    </div>

    ${orderedGroups.map(([category, items]) => `
      <section class="ver-category">
        <div class="ver-category-header">
          <div class="ver-category-icon">${categoryIcon[category] || '📦'}</div>
          <div class="ver-category-name">${escHtml(versionCategoryName(category))}</div>
          <div class="ver-category-count">${items.length} disponibles</div>
        </div>
        <div class="ver-software-grid">
          ${items.map(renderVersionSoftwareCard).join('')}
        </div>
      </section>
    `).join('')}
  `;

  container.querySelectorAll('[data-software]').forEach(card => {
    card.addEventListener('click', () => selectVersionSoftware(card.dataset.software));
  });
}

async function selectVersionSoftware(software) {
  const item = versionFindSoftware(software);
  const container = $('versionList');
  if (!container) return;

  container.innerHTML = `
    <div class="ver-panel-head">
      <button type="button" class="btn ver-back-btn" id="verBack">← Volver</button>
      <div>
        <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)}</div>
        <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
      </div>
    </div>
    <div class="ver-loading">Cargando versiones de ${escHtml(item.label || software)}…</div>
  `;

  $('verBack')?.addEventListener('click', renderVersionSoftware);

  if (item.external && !['paper', 'purpur', 'folia', 'fabric', 'vanilla'].includes(software)) {
    container.querySelector('.ver-loading').outerHTML = `
      <div class="ver-empty">
        <div class="ver-empty-icon">🌐</div>
        <div class="ver-empty-title">Descarga externa</div>
        <div class="ver-empty-text">MoonWolf no dispone de una API de versiones para este software.</div>
        <a class="btn btn-primary" href="${escHtml(item.external)}" target="_blank" rel="noopener noreferrer">Abrir web oficial ↗</a>
      </div>
    `;
    return;
  }

  try {
    const data = await api(`/api/versions/list?software=${encodeURIComponent(software)}`);

    if (!data?.ok) {
      throw new Error(data?.error || 'No se pudieron cargar las versiones.');
    }

    const versions = Array.isArray(data.versions) ? data.versions : [];

    if (!versions.length) {
      throw new Error('La API no devolvió ninguna versión disponible.');
    }

    versionCurrent.software = software;

    container.innerHTML = `
      <div class="ver-panel-head">
        <button type="button" class="btn ver-back-btn" id="verBack">← Volver</button>
        <div>
          <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)}</div>
          <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
        </div>
      </div>

      <div class="ver-version-header">
        <div style="padding-left:28px">
          <div class="ver-section-title">Versiones disponibles</div>
          <div class="ver-section-subtitle">${versions.length} versiones encontradas</div>
        </div>
        <input id="verVersionSearch" class="ver-search" type="search" placeholder="Buscar versión…">
      </div>

      <div class="ver-version-grid" id="verVersionGrid"></div>
    `;

    $('verBack')?.addEventListener('click', renderVersionSoftware);

    const grid = $('verVersionGrid');

    const drawVersions = (filter = '') => {
      const q = filter.trim().toLowerCase();
      const filtered = versions.filter(v => String(v).toLowerCase().includes(q));

      grid.innerHTML = filtered.map(v => `
        <button type="button" class="ver-version-card ${String(v) === String(versionCurrent.version) && software === versionCurrent.software ? 'current' : ''}" data-version="${escHtml(v)}">
          <span>${escHtml(v)}</span>
          ${String(v) === String(versionCurrent.version) && software === versionCurrent.software ? '<small>ACTUAL</small>' : ''}
        </button>
      `).join('') || `<div class="ver-no-results">No hay versiones que coincidan.</div>`;

      grid.querySelectorAll('[data-version]').forEach(btn => {
        btn.addEventListener('click', () => selectVersionBuilds(software, btn.dataset.version, item));
      });
    };

    $('verVersionSearch')?.addEventListener('input', e => drawVersions(e.target.value));
    drawVersions();

  } catch (error) {
    const box = container.querySelector('.ver-loading');
    if (box) {
      box.className = 'ver-empty';
      box.innerHTML = `
        <div class="ver-empty-icon">⚠️</div>
        <div class="ver-empty-title">No se pudieron cargar las versiones</div>
        <div class="ver-empty-text">${escHtml(error.message || 'Error desconocido')}</div>
        <button type="button" class="btn btn-primary" id="verRetrySoftware">Reintentar</button>
      `;
      $('verRetrySoftware')?.addEventListener('click', () => selectVersionSoftware(software));
    }
  }
}

async function selectVersionBuilds(software, version, item = versionFindSoftware(software)) {
  const container = $('versionList');
  if (!container) return;

  versionCurrent.software = software;
  versionCurrent.version = version;
  versionCurrent.build = '';

  container.innerHTML = `
    <div class="ver-panel-head">
      <button type="button" class="btn ver-back-btn" id="verBackVersions">← Versiones</button>
      <div>
        <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)} ${escHtml(version)}</div>
        <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
      </div>
    </div>
    <div class="ver-loading">Cargando builds de ${escHtml(version)}…</div>
  `;

  $('verBackVersions')?.addEventListener('click', () => selectVersionSoftware(software));

  try {
    const data = await api(
      `/api/versions/builds?software=${encodeURIComponent(software)}&version=${encodeURIComponent(version)}`
    );

    if (!data?.ok) {
      throw new Error(data?.error || 'No se pudieron cargar los builds.');
    }

    const builds = Array.isArray(data.builds) ? data.builds : [];

    if (!builds.length) {
      throw new Error('No hay builds disponibles para esta versión.');
    }

    versionCurrent.build = builds[0]?.build ?? '';

    container.innerHTML = `
      <div class="ver-panel-head">
        <button type="button" class="btn ver-back-btn" id="verBackVersions">← Versiones</button>
        <div>
          <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)} ${escHtml(version)}</div>
          <div class="ver-panel-subtitle">${builds.length} builds disponibles</div>
        </div>
      </div>

      <div class="ver-build-list">
        ${builds.map((b, index) => `
          <div class="ver-build-item ${index === 0 ? 'selected' : ''}" data-build="${escHtml(b.build)}">
            <div class="ver-build-main">
              <div class="ver-build-title">Build ${escHtml(b.build)}</div>
              <div class="ver-build-meta">
                <span>${escHtml(b.channel || 'STABLE')}</span>
                ${b.loaderVersion ? `<span>Loader ${escHtml(b.loaderVersion)}</span>` : ''}
                ${b.time ? `<span>${escHtml(new Date(b.time).toLocaleString('es-ES'))}</span>` : ''}
              </div>
              ${b.changes ? `<div class="ver-build-changes">${escHtml(b.changes)}</div>` : ''}
              ${b.sha256 ? `<div class="ver-build-sha">SHA-256: ${escHtml(b.sha256)}</div>` : ''}
            </div>
            <button type="button" class="btn ${b.installable === false ? '' : 'btn-primary'} ver-install-btn" data-build-index="${index}" ${b.installable === false ? 'disabled' : ''}>
              ${b.installable === false ? 'Solo información' : (software === 'fabric' || software === 'neoforge' ? 'Preparar instalación' : 'Instalar')}
            </button>
          </div>
        `).join('')}
      </div>
    `;

    $('verBackVersions')?.addEventListener('click', () => selectVersionSoftware(software));

    container.querySelectorAll('[data-build-index]').forEach(button => {
      button.addEventListener('click', () => {
        const build = builds[Number(button.dataset.buildIndex)];
        if (build?.installable === false) return;
        installVersionSelection(software, version, build);
      });
    });
  } catch (error) {
    const box = container.querySelector('.ver-loading');
    if (box) {
      box.className = 'ver-empty';
      box.innerHTML = `
        <div class="ver-empty-icon">⚠️</div>
        <div class="ver-empty-title">No se pudieron cargar los builds</div>
        <div class="ver-empty-text">${escHtml(error.message || 'Error desconocido')}</div>
        <button type="button" class="btn btn-primary" id="verRetryBuilds">Reintentar</button>
      `;
      $('verRetryBuilds')?.addEventListener('click', () => selectVersionBuilds(software, version, item));
    }
  }
}

async function installVersionSelection(software, version, build) {
  const label = versionFindSoftware(software).label || software;
  const buildLabel = build?.build !== undefined ? `Build ${build.build}` : 'versión seleccionada';

  if (!confirm(`¿Quieres instalar ${label} ${version} (${buildLabel})?`)) return;

  try {
    toast('⏳ Descargando e instalando...', 'info');

    const data = await postJSON('/api/versions/install', {
      software,
      version,
      build: build?.build ?? '',
      url: build?.url || '',
      loaderVersion: build?.loaderVersion || '',
    });

    if (!data?.ok) {
      throw new Error(data?.error || 'No se pudo instalar la versión.');
    }

    if (data.type === 'fabric-installer' || data.type === 'forge-installer' || data.type === 'neoforge-installer') {
      const name = data.type === 'forge-installer' ? 'Forge' : (data.type === 'neoforge-installer' ? 'NeoForge' : 'Fabric');
      toast(`⚠️ ${name} preparado. Revisa el comando indicado antes de ejecutarlo.`, 'info');
      alert(
        `${name} ${version} preparado.\n\n` +
        `${data.note || ''}\n\n` +
        `Comando:\n${data.installCmd || 'No disponible'}`
      );
    } else {
      toast(`✅ ${label} ${version} instalado correctamente.`, 'ok');
    }

    await loadVersionState();
  } catch (error) {
    toast(`❌ ${error.message}`, 'err');
  }
}

async function loadVersionState() {
  const container = $('versionList');
  if (container) {
    container.innerHTML = `
      <div class="ver-loading-page">
        <div class="ver-loading-spinner">⟳</div>
        <div>Cargando catálogo de versiones…</div>
      </div>
    `;
  }

  try {
    const [softwareData, startupData] = await Promise.all([
      api('/api/versions/software'),
      api('/api/startup'),
    ]);

    if (!softwareData?.ok) {
      throw new Error(softwareData?.error || 'No se pudo cargar el catálogo de software.');
    }

    versionCatalog = Array.isArray(softwareData.software)
      ? softwareData.software.map(item => ({
          ...item,
          icon:
            item.id === 'paper' ? '📄' :
            item.id === 'purpur' ? '🟣' :
            item.id === 'folia' ? '🌱' :
            item.id === 'fabric' ? '🧵' :
            item.id === 'forge' ? '🔨' :
            item.id === 'leaf' ? '🍁' :
            item.id === 'leaves' ? '🍂' :
            item.id === 'spigot' ? '🧱' :
            item.id === 'bukkit' ? '🧺' :
            item.id === 'magma' ? '🌋' :
            item.id === 'arclight' ? '💡' :
            item.id === 'sponge' ? '🧽' :
            item.id === 'mohist' ? '⚗️' :
            item.id === 'gale' ? '🌬️' :
            item.id === 'pufferfish' ? '🐡' :
            item.id === 'quilt' ? '🧶' :
            item.id === 'neoforge' ? '⚒️' :
            item.id === 'vanilla' ? '🌿' :
            item.id === 'velocity' ? '⚡' :
            item.id === 'waterfall' ? '🌊' :
            item.id === 'bungeecord' ? '🔗',
        }))
      : [];

    versionCurrent = {
      software: '',
      version: startupData?.config?.minecraftVersion || '',
      build: '',
    };

    renderVersionSoftware();
  } catch (error) {
    versionCatalog = [];
    renderVersionSoftware();
    toast(`❌ ${error.message}`, 'err');
  }
}

/* Legacy compatibility */
function renderBuildsSelect() {}
async function changeSoftwareOrVersion() {}
async function installSelectedVersion() {
  if (versionCurrent.software && versionCurrent.version) {
    await selectVersionBuilds(
      versionCurrent.software,
      versionCurrent.version,
      versionFindSoftware(versionCurrent.software)
    );
  } else {
    toast('Selecciona un servidor y una versión primero.', 'warn');
  }
}

/* DATABASES (MySQL / MariaDB) */

function showDbCredentials(creds) {
  const text =
    `Host: ${creds.host}:${creds.port}\n` +
    `Base de datos: ${creds.database}\n` +
    `Usuario: ${creds.user}\n` +
    `Contraseña: ${creds.password}`;

  try {
    navigator.clipboard?.writeText(text);
  } catch {}

  alert(
    `Credenciales de la base de datos (copiadas al portapapeles):\n\n${text}\n\n⚠️ Esta contraseña no se volverá a mostrar.`
  );
}

async function createDatabase() {
  const name = prompt(
    'Nombre de la nueva base de datos (letras, números y guion bajo, máx. 48 caracteres):'
  );

  if (!name) return;

  const data = await postJSON('/api/databases', {
    name: name.trim(),
    createUser: true,
  });

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
    return;
  }

  toast('✅ Base de datos creada', 'ok');

  if (data.credentials) {
    showDbCredentials(data.credentials);
  }

  loadDatabases();
}

async function loadDatabases() {
  const container = $('dbList');

  if (!container) return;

  container.innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Conectando con MySQL...</div>
    </div>
  `;

  let status = { connected: false };

  try {
    status = await api('/api/databases/status');
  } catch (error) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(error.message)}</div>
      </div>
    `;
    return;
  }

  if (!status.connected) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" style="color:var(--red)">⚠</div>
        <div class="empty-msg">
          No se pudo conectar con MySQL (${escHtml(status.host || '')}:${escHtml(String(status.port || ''))}).<br>
          <span style="font-size:11px;color:var(--muted)">
            ${escHtml(status.error || 'Configura MOONWOLF_MYSQL_HOST / MOONWOLF_MYSQL_USER / MOONWOLF_MYSQL_PASSWORD en el .env del servidor.')}
          </span>
        </div>
      </div>
    `;
    return;
  }

  const data = await api('/api/databases');

  if (!data.ok) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(data.error)}</div>
      </div>
    `;
    return;
  }

  const databases = data.databases || [];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px 14px">
      <span style="font-size:11px;color:var(--muted2)">
        🟢 Conectado a MySQL — ${escHtml(status.host)}:${escHtml(String(status.port))}
      </span>
      <button class="small-btn" id="btnNewDatabase">➕ Nueva base de datos</button>
    </div>

    ${
      databases.length
        ? databases
            .map(
              db => `
          <div class="backup-row">
            <span class="bk-icon">🗄️</span>
            <span class="bk-name">
              ${escHtml(db.name)}
              <small>${escHtml(db.tables)} tablas · ${escHtml(db.user || 'sin usuario dedicado')}</small>
            </span>
            <span class="bk-size">${escHtml(db.sizeMb)} MB</span>
            <span class="bk-actions">
              ${
                db.user
                  ? `<button class="icon-btn edit" data-reset-db="${escHtml(db.name)}" title="Restablecer contraseña">🔑</button>`
                  : ''
              }
              <button class="icon-btn" data-delete-db="${escHtml(db.name)}" title="Eliminar">🗑️</button>
            </span>
          </div>
        `
            )
            .join('')
        : '<div class="empty-state"><div class="empty-msg">No hay bases de datos todavía.</div></div>'
    }
  `;

  $('btnNewDatabase')?.addEventListener('click', createDatabase);

  container.querySelectorAll('[data-delete-db]').forEach(button => {
    button.addEventListener('click', async () => {
      const name = button.dataset.deleteDb;

      if (
        !confirm(
          `¿Eliminar la base de datos "${name}"? Esta acción no se puede deshacer.`
        )
      ) {
        return;
      }

      const data = await api(`/api/databases/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (!data.ok) {
        toast(`❌ ${data.error}`, 'err');
        return;
      }

      toast('✅ Base de datos eliminada', 'ok');
      loadDatabases();
    });
  });

  container.querySelectorAll('[data-reset-db]').forEach(button => {
    button.addEventListener('click', async () => {
      const name = button.dataset.resetDb;

      if (!confirm(`¿Restablecer la contraseña del usuario de "${name}"?`)) {
        return;
      }

      const data = await postJSON(
        `/api/databases/${encodeURIComponent(name)}/reset-password`,
        {}
      );

      if (!data.ok) {
        toast(`❌ ${data.error}`, 'err');
        return;
      }

      showDbCredentials(data.credentials);
    });
  });
}

/* BACKUPS */

async function loadBackups() {
  const container = $('backupList');

  if (!container) return;

  container.innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Cargando copias de seguridad...</div>
    </div>
  `;

  const data = await api('/api/backups');

  if (!data.ok) {
    container.innerHTML = `<div class="empty-state"><div class="empty-msg">${escHtml(data.error)}</div></div>`;
    return;
  }

  const backups = data.backups || [];

  container.innerHTML = backups.length
    ? backups
        .map(
          backup => `
        <div class="backup-row">
          <span class="bk-icon">🗄️</span>
          <span class="bk-name">
            ${escHtml(backup.name)}
            <small>${escHtml(backup.date)}</small>
          </span>
          <span class="bk-size">${escHtml(backup.sizeMb)} MB</span>
          <span class="bk-actions">
            <button class="icon-btn edit" data-download-backup="${escHtml(backup.name)}" title="Descargar">⬇️</button>
            <button class="icon-btn" data-delete-backup="${escHtml(backup.name)}" title="Eliminar">🗑️</button>
          </span>
        </div>
      `
        )
        .join('')
    : '<div class="empty-state"><div class="empty-msg">No hay copias de seguridad todavía.</div></div>';

  container.querySelectorAll('[data-download-backup]').forEach(button => {
    button.addEventListener('click', () =>
      downloadBackup(button.dataset.downloadBackup)
    );
  });

  container.querySelectorAll('[data-delete-backup]').forEach(button => {
    button.addEventListener('click', async () => {
      const name = button.dataset.deleteBackup;

      if (
        !confirm(
          `¿Eliminar la copia de seguridad "${name}"? Esta acción no se puede deshacer.`
        )
      ) {
        return;
      }

      const data = await api(`/api/backups/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (!data.ok) {
        toast(`❌ ${data.error}`, 'err');
        return;
      }

      toast('✅ Copia de seguridad eliminada', 'ok');
      loadBackups();
    });
  });
}

async function createBackup() {
  const name = prompt('Nombre para la copia de seguridad (opcional):', '');
  if (name === null) return;

  const button = $('btnNewBackup');

  if (button) {
    button.disabled = true;
    button.textContent = '⏳ Creando...';
  }

  try {
    const data = await postJSON('/api/backups', { name: name.trim() });

    if (!data.ok) {
      toast(`❌ ${data.error}`, 'err');
      return;
    }

    toast(
      data.warning
        ? `⚠️ ${data.warning}`
        : `✅ Copia de seguridad creada (${data.sizeMb} MB)`,
      data.warning ? 'warn' : 'ok'
    );

    loadBackups();
  } catch (error) {
    toast(`❌ ${error.message}`, 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '➕ Nueva copia';
    }
  }
}

async function downloadBackup(name) {
  try {
    const result = await rpcHttp(
      `/api/backups/download/${encodeURIComponent(name)}`
    );

    if (!result?.bodyBase64) {
      toast(
        result?.data?.error || 'No se pudo descargar la copia de seguridad.',
        'err'
      );
      return;
    }

    const bytes = decodeResultBody(result);
    const blob = new Blob([bytes], {
      type: result.contentType || 'application/zip',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = name;
    anchor.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(`❌ ${error.message}`, 'err');
  }
}

/* PORTS */

async function loadPorts() {
  const element = $('portList');
  if (!element) return;

  element.innerHTML =
    '<div class="empty-state"><div style="animation:spin 1s linear infinite;font-size:28px">⟳</div><div class="empty-msg">Comprobando puertos...</div></div>';

  try {
    const data = await api('/api/ports');
    if (!data.ok) throw new Error(data.error || 'No se pudieron cargar los puertos');

    const props = data.properties || {};
    const ports = Array.isArray(data.ports) ? data.ports : [];

    element.innerHTML = `
      <div class="ports-toolbar">
        <div>
          <div class="panel-title"><span>🔌</span> PUERTOS DEL SERVIDOR</div>
          <div class="port-toolbar-sub">Configura los puertos de Minecraft, Query y RCON. Los cambios requieren reiniciar el servidor.</div>
        </div>
        <button class="small-btn" id="btnRefreshPorts">↺ Comprobar</button>
      </div>

      <div class="ports-grid">
        ${ports
          .map(
            port => `
          <div class="port-row">
            <div class="port-num">${escHtml(port.port)}</div>
            <div class="port-info">
              <div class="port-name">${escHtml(port.name)}</div>
              <div class="port-desc">${escHtml(port.description)}</div>
            </div>
            <span class="port-proto">${escHtml(port.protocol)}</span>
            <span class="port-state ${escHtml(port.state)}">
              ${
                port.state === 'open'
                  ? '● ABIERTO'
                  : port.state === 'closed'
                    ? '● CERRADO'
                    : port.state === 'disabled'
                      ? '● DESACTIVADO'
                      : '● CONFIGURADO'
              }
            </span>
          </div>
        `
          )
          .join('')}
      </div>

      <div class="panel ports-config-panel">
        <div class="panel-header">
          <div>
            <div class="panel-title"><span>⚙️</span> CONFIGURACIÓN</div>
            <div class="port-toolbar-sub">Los valores se escriben directamente en server.properties.</div>
          </div>
        </div>

        <div class="ports-form">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Puerto de Minecraft</label>
              <input id="portMinecraft" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.serverPort ?? 25565)}">
            </div>
            <div class="form-group">
              <label class="form-label">Puerto Query</label>
              <input id="portQuery" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.queryPort ?? 25565)}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Puerto RCON</label>
              <input id="portRcon" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.rconPort ?? 25575)}">
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña RCON</label>
              <input id="portRconPassword" class="form-input" type="password" placeholder="${props.hasRconPassword ? 'Dejar vacío para conservarla' : 'Contraseña nueva'}" autocomplete="new-password">
            </div>
          </div>

          <div class="startup-toggles">
            <label class="startup-toggle" for="portEnableQuery">
              <div class="startup-toggle-icon">📡</div>
              <div class="startup-toggle-info">
                <div class="startup-toggle-title">Game Query</div>
                <div class="startup-toggle-desc">Permite consultar información del servidor mediante el protocolo Query (jugadores, MOTD...).</div>
              </div>
              <span class="toggle">
                <input type="checkbox" id="portEnableQuery" ${props.enableQuery ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
            </label>

            <label class="startup-toggle" for="portEnableRcon">
              <div class="startup-toggle-icon">🎛️</div>
              <div class="startup-toggle-info">
                <div class="startup-toggle-title">RCON</div>
                <div class="startup-toggle-desc">Consola remota. Usa una contraseña fuerte y no expongas este puerto innecesariamente a Internet.</div>
              </div>
              <span class="toggle">
                <input type="checkbox" id="portEnableRcon" ${props.enableRcon ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
            </label>
          </div>

          <button class="save-btn" id="btnSavePorts">💾 GUARDAR PUERTOS</button>
        </div>
      </div>
    `;

    $('btnRefreshPorts')?.addEventListener('click', loadPorts);
    $('btnSavePorts')?.addEventListener('click', savePorts);
  } catch (error) {
    element.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-msg">${escHtml(error.message)}</div><button class="small-btn" id="btnRetryPorts">↺ Reintentar</button></div>`;
    $('btnRetryPorts')?.addEventListener('click', loadPorts);
  }
}

async function savePorts() {
  const body = {
    serverPort: Number($('portMinecraft')?.value),
    queryPort: Number($('portQuery')?.value),
    rconPort: Number($('portRcon')?.value),
    enableQuery: Boolean($('portEnableQuery')?.checked),
    enableRcon: Boolean($('portEnableRcon')?.checked),
    rconPassword: $('portRconPassword')?.value || '',
  };

  const button = $('btnSavePorts');
  if (button) {
    button.disabled = true;
    button.textContent = 'GUARDANDO...';
  }

  try {
    const data = await postJSON('/api/ports', body);
    if (!data.ok) {
      toast(`❌ ${data.error}`, 'err');
      return;
    }

    toast('✅ Puertos guardados. Reinicia el servidor para aplicar los cambios.', 'ok');
    addActivity('Configuración de puertos actualizada', 'ok', '🔌');
    await loadPorts();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '💾 GUARDAR PUERTOS';
    }
  }
}

/* STARTUP */

function requiredJavaLabel(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 'Java se seleccionará automáticamente';

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  let java = null;

  if (major >= 26) java = 25;
  else if (major === 1) {
    if (minor <= 11) java = 8;
    else if (minor >= 12 && minor <= 15) java = 11;
    else if (minor === 16) java = patch >= 5 ? 16 : 11;
    else if (minor >= 17 && minor <= 19) java = 17;
    else if (minor >= 20 && minor <= 21) java = 21;
  }

  return java ? `Java ${java} · gestionado por MoonWolf` : 'Versión no reconocida';
}

async function loadStartup() {
  const element = $('startupList');

  if (!element) return;

  element.innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Cargando configuración...</div>
    </div>
  `;

  const data = await api('/api/startup');

  if (!data.ok) {
    element.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(data.error)}</div>
      </div>
    `;

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
                ${jars
                  .map(
                    jar => `
                  <option value="${escHtml(jar)}" ${jar === cfg.jar ? 'selected' : ''}>${escHtml(jar)}</option>
                `
                  )
                  .join('')}
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
        <label class="form-label">Versión de Minecraft</label>
        <input id="stMinecraftVersion" class="form-input" type="text" placeholder="Ej. 1.21.11" value="${escHtml(cfg.minecraftVersion || '')}">
        <div class="form-hint">MoonWolf usa esta versión para seleccionar automáticamente el Java compatible. Si instalaste el servidor desde Versiones, se rellena automáticamente.</div>
      </div>

      <div class="form-group">
        <label class="form-label">Java</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">
          <span style="font-size:18px">☕</span>
          <div style="flex:1;min-width:220px">
            <div style="font-weight:700" id="stJavaManagedLabel">
              ${
                data.javaRuntime?.javaMajor
                  ? `Java ${escHtml(data.javaRuntime.javaMajor)} ${data.javaRuntime.installed ? '✓ instalado' : '↓ se descargará automáticamente'}`
                  : 'Java se seleccionará automáticamente'
              }
            </div>
            <div class="form-hint" style="margin-top:3px">
              ${
                data.javaRuntime?.javaMajor
                  ? `Runtime gestionado por MoonWolf · ${data.javaRuntime.installed ? 'listo para usar' : 'se instalará al arrancar'}`
                  : 'Indica una versión de Minecraft válida para calcular el runtime.'
              }
            </div>
          </div>
        </div>

        <div style="margin-top:10px">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
            <input id="stJavaOverride" type="checkbox" ${cfg.javaMode === 'override' ? 'checked' : ''}>
            Usar un Java personalizado (avanzado)
          </label>
          <input id="stJavaOverridePath" class="form-input" type="text" style="margin-top:8px;display:${cfg.javaMode === 'override' ? 'block' : 'none'}" placeholder="C:\Program Files\Java\jdk-21\bin\java.exe" value="${escHtml(cfg.javaOverridePath || cfg.javaPath || '')}">
          <div class="form-hint">Normalmente no necesitas tocar esto. El modo gestionado evita depender de un JDK instalado en Windows.</div>
        </div>
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

      <div class="startup-toggles">
        <label class="startup-toggle" for="stAutoRestart">
          <div class="startup-toggle-icon">🔄</div>
          <div class="startup-toggle-info">
            <div class="startup-toggle-title">Reinicio automático si se cae</div>
            <div class="startup-toggle-desc">Relanza el servidor si el proceso termina de forma inesperada. No cuenta si pulsas DETENER.</div>
          </div>
          <span class="toggle">
            <input type="checkbox" id="stAutoRestart" ${cfg.autoRestartOnCrash ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>

        <label class="startup-toggle" for="stAutoStart">
          <div class="startup-toggle-icon">🚀</div>
          <div class="startup-toggle-info">
            <div class="startup-toggle-title">Arranque automático</div>
            <div class="startup-toggle-desc">Inicia el servidor en cuanto MoonWolf Panel/Agent se ponga en marcha.</div>
          </div>
          <span class="toggle">
            <input type="checkbox" id="stAutoStart" ${cfg.autoStartOnBoot ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>
      </div>

      <button class="save-btn" id="btnSaveStartup" ${jars.length ? '' : 'disabled'}>💾 GUARDAR</button>
    </div>
  `;

  $('btnSaveStartup')?.addEventListener('click', saveStartup);

  $('stJavaOverride')?.addEventListener('change', event => {
    const input = $('stJavaOverridePath');
    if (input) {
      input.style.display = event.target.checked ? 'block' : 'none';
    }
  });

  $('stMinecraftVersion')?.addEventListener('input', event => {
    const version = event.target.value.trim();
    const runtime = requiredJavaLabel(version);
    const label = $('stJavaManagedLabel');
    if (label) label.textContent = runtime;
  });

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
    javaPath: $('stJavaOverridePath')?.value.trim() || '',
    javaMode: Boolean($('stJavaOverride')?.checked) ? 'override' : 'managed',
    javaOverridePath: $('stJavaOverride')?.checked ? ($('stJavaOverridePath')?.value.trim() || '') : '',
    minecraftVersion: $('stMinecraftVersion')?.value.trim() || '',
    minMemoryMb: Number($('stMinMem')?.value) || 1024,
    maxMemoryMb: Number($('stMaxMem')?.value) || 2048,
    extraArgs: $('stArgs')?.value.trim() || '',
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
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(item => item.classList.remove('active'));

  $(`view-${id}`)?.classList.add('active');

  document
    .querySelector(`.sb-item[data-view="${id}"]`)
    ?.classList.add('active');

  switch (id) {
    case 'files':
      populateFiles(currentDir);
      break;

    case 'versions':
      loadVersionState().catch(error => toast(error.message, 'err'));
      break;

    case 'plugins':
      loadInstalledPlugins();
      break;

    case 'databases':
      loadDatabases();
      break;

    case 'users':
      renderUsers();
      break;

    case 'backups':
      loadBackups();
      break;

    case 'ports':
      loadPorts();
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

  if (!activities.length) {
    element.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-msg">No hay actividad todavía</div>
      </div>
    `;
    return;
  }

  const counts = activities.reduce((acc, item) => {
    const level = item.level || 'info';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  const toolbar = `
    <div class="activity-toolbar">
      <div class="activity-counter">
        <span class="activity-counter-num">${activities.length}</span>
        <span class="activity-counter-label">eventos</span>
      </div>
      <div class="activity-filters">
        ${counts.info  ? `<span class="activity-filter info">${counts.info} info</span>` : ''}
        ${counts.ok    ? `<span class="activity-filter ok">${counts.ok} ok</span>` : ''}
        ${counts.warn  ? `<span class="activity-filter warn">${counts.warn} aviso</span>` : ''}
        ${counts.error ? `<span class="activity-filter error">${counts.error} error</span>` : ''}
      </div>
    </div>
  `;

  const items = activities
    .slice()
    .reverse()
    .map(item => {
      const level = String(item.level || 'info').toLowerCase();
      const safeLevel = ['info', 'ok', 'warn', 'error'].includes(level) ? level : 'info';
      const label = { info: 'INFO', ok: 'OK', warn: 'AVISO', error: 'ERROR' }[safeLevel];

      return `
        <div class="activity-item ${safeLevel}">
          <div class="activity-icon">${escHtml(item.icon || '📌')}</div>
          <div class="activity-body">
            <div class="activity-msg">${escHtml(item.message)}</div>
            <div class="activity-time">${escHtml(item.time || '--:--:--')}</div>
          </div>
          <span class="activity-badge ${safeLevel}">${label}</span>
        </div>
      `;
    })
    .join('');

  element.innerHTML = toolbar + `<div class="activity-feed">${items}</div>`;
}

/* USERS */

async function loadShareTokens() {
  if (panelKind !== 'owner' || panelPermission !== 'admin') return;

  const list = $('shareTokenList');
  if (!list) return;

  try {
    const data = await cloudApi('/api/share-tokens');
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];

    const control = tokens.filter(token => token.permission === 'control').length;
    const read = tokens.filter(token => token.permission !== 'control').length;

    if ($('userStatTotal')) $('userStatTotal').textContent = tokens.length;
    if ($('userStatControl')) $('userStatControl').textContent = control;
    if ($('userStatRead')) $('userStatRead').textContent = read;

    list.innerHTML = tokens.length
      ? tokens
          .map(token => {
            const expiry = token.expiresAt
              ? new Date(token.expiresAt).toLocaleString('es-ES')
              : 'Nunca';
            return `
            <div class="user-row">
              <div class="user-avatar">👤</div>
              <div class="user-row-main">
                <strong>${escHtml(token.label || 'Usuario')}</strong>
                <div class="user-row-meta">
                  <span class="user-permission-pill ${token.permission === 'control' ? 'control' : 'read'}">
                    ${token.permission === 'control' ? '🎮 Control' : '👁️ Solo lectura'}
                  </span>
                  <span>Caduca: ${escHtml(expiry)}</span>
                </div>
              </div>
              <button class="small-btn user-revoke-btn" data-revoke-share="${escHtml(token.id)}">Revocar</button>
            </div>
          `;
          })
          .join('')
      : '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-msg">No hay usuarios con acceso.</div></div>';

    list.querySelectorAll('[data-revoke-share]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await cloudApi(
            `/api/share-tokens/${encodeURIComponent(button.dataset.revokeShare)}`,
            { method: 'DELETE' }
          );
          toast('Acceso revocado.', 'ok');
          await loadShareTokens();
        } catch (error) {
          toast(error.message, 'err');
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escHtml(error.message)}</div>`;
  }
}

function renderUsers() {
  const element = $('userList');
  if (!element) return;

  const isOwner = panelKind === 'owner' && panelPermission === 'admin';

  if (!isOwner) {
    element.innerHTML = `
      <div class="user-access-grid">
        <div class="panel user-access-card">
          <div class="panel-header">
            <div class="panel-title"><span>👤</span> TU ACCESO</div>
          </div>
          <div class="user-access-body">
            <div class="user-profile-icon">👤</div>
            <div>
              <div class="user-profile-title">Acceso compartido</div>
              <div class="user-profile-sub">Este panel te ha sido compartido por el propietario.</div>
            </div>
          </div>
          <div class="user-permission-row">
            <span>Permiso</span>
            <strong>${panelPermission === 'control' ? '🎮 Control' : '👁️ Solo lectura'}</strong>
          </div>
          <div class="user-info-note">
            Tu acceso está limitado a los permisos asignados por el propietario. No puedes crear ni revocar accesos.
          </div>
        </div>
      </div>
    `;
    return;
  }

  element.innerHTML = `
    <div class="user-stats-grid">
      <div class="user-stat-card">
        <span class="user-stat-icon">👥</span>
        <div><span class="user-stat-label">Accesos activos</span><strong id="userStatTotal">—</strong></div>
      </div>
      <div class="user-stat-card">
        <span class="user-stat-icon">🎮</span>
        <div><span class="user-stat-label">Con control</span><strong id="userStatControl">—</strong></div>
      </div>
      <div class="user-stat-card">
        <span class="user-stat-icon">👁️</span>
        <div><span class="user-stat-label">Solo lectura</span><strong id="userStatRead">—</strong></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title"><span>➕</span> NUEVO USUARIO</div>
          <div class="user-panel-subtitle">Crea un acceso independiente sin compartir tu código de propietario.</div>
        </div>
      </div>
      <div class="user-create-form">
        <input id="shareLabel" class="form-input" placeholder="Nombre (ej. Paco)" maxlength="60">
        <select id="sharePermission" class="form-input">
          <option value="read">👁️ Solo lectura</option>
          <option value="control">🎮 Control</option>
        </select>
        <select id="shareExpiry" class="form-input">
          <option value="never">Sin caducidad</option>
          <option value="1h">1 hora</option>
          <option value="1d">1 día</option>
          <option value="7d">7 días</option>
          <option value="30d">30 días</option>
        </select>
        <button class="small-btn user-create-btn" id="btnCreateShare">Crear acceso</button>
      </div>
    </div>

    <div id="shareCreatedBox" class="panel user-token-panel" style="display:none">
      <div class="user-token-title">🔐 ACCESO CREADO</div>
      <div class="user-token-sub">Este token se muestra una sola vez. Entrégaselo a la persona que va a usar el panel.</div>
      <div class="user-token-row">
        <code id="shareCreatedToken"></code>
        <button class="small-btn" id="btnCopyShareToken">Copiar</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title"><span>👥</span> USUARIOS CON ACCESO</div>
          <div class="user-panel-subtitle">Puedes revocar cualquier acceso inmediatamente.</div>
        </div>
        <button class="small-btn" id="btnRefreshUsers">↺ Actualizar</button>
      </div>
      <div id="shareTokenList"></div>
    </div>
  `;

  bindShareSettings();
  $('btnRefreshUsers')?.addEventListener('click', loadShareTokens);
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
      toast(
        copied
          ? 'Token creado y copiado al portapapeles.'
          : 'Token creado. Cópialo antes de cerrar esta pantalla.',
        'ok'
      );
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

/* SETTINGS */

function renderSettings() {
  const element = $('settingsList');

  if (!element) return;

  element.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-icon">☁️</div>
        <div class="settings-group-info">
          <div class="settings-group-title">MoonWolf Cloud</div>
          <div class="settings-group-sub">Conexión WebSocket con el panel remoto</div>
        </div>
        <span class="settings-status ${cloudSocket?.connected ? 'online' : 'offline'}">
          ${cloudSocket?.connected ? '● ONLINE' : '● OFFLINE'}
        </span>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-icon">🛰️</div>
        <div class="settings-group-info">
          <div class="settings-group-title">MoonWolf Agent</div>
          <div class="settings-group-sub">Identificador único de esta instalación</div>
        </div>
        <span class="settings-status ${agentOnline ? 'online' : 'offline'}">
          ${agentOnline ? '● CONECTADO' : '● DESCONECTADO'}
        </span>
      </div>
      <div class="settings-group-body">
        <div class="settings-field">
          <code class="settings-field-value" title="${escHtml(agentId || '—')}">${escHtml(agentId || '—')}</code>
          <button class="small-btn" id="btnCopyAgentId">Copiar</button>
        </div>
      </div>
    </div>

    <div class="settings-danger">
      <div class="settings-danger-info">
        <div class="settings-danger-title">⚠️ Desconectar del Cloud</div>
        <div class="settings-danger-sub">
          Cerrará la sesión actual del panel. Necesitarás un nuevo código de emparejamiento para reconectar.
        </div>
      </div>
      <button class="settings-danger-btn" id="btnDisconnectCloud">Desconectar</button>
    </div>
  `;

  $('btnCopyAgentId')?.addEventListener('click', async event => {
    if (!agentId) return;

    try {
      await navigator.clipboard.writeText(agentId);
      flashButton(event.currentTarget, 'Copiado');
    } catch {
      toast('No se pudo copiar.', 'err');
    }
  });

  $('btnDisconnectCloud')?.addEventListener('click', () => {
    cloudSocket?.disconnect();
    setAgentOnline(false);
    currentStatus = 'offline';
    updateStatusUi('offline');
    clearSession();
    showLogin('Desconectado.');
  });
}

/* TOAST & HELPERS */

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

function flashButton(button, label, duration = 1200) {
  if (!button) return;

  const original = button.textContent;

  button.textContent = label;
  button.disabled = true;

  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, duration);
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

  $('btnUploadFiles')?.addEventListener('click', () => {
    $('fileUploadInput')?.click();
  });

  $('btnUploadFolder')?.addEventListener('click', () => {
    $('folderUploadInput')?.click();
  });

  $('fileUploadInput')?.addEventListener('change', async event => {
    await uploadSelectedFiles(event.target.files);
    event.target.value = '';
  });

  $('folderUploadInput')?.addEventListener('change', async event => {
    await uploadSelectedFiles(event.target.files);
    event.target.value = '';
  });

  $('btnNewFile')?.addEventListener('click', async () => {
    const raw = prompt('Nombre del nuevo archivo (termina en "/" para carpeta):');
    if (!raw) return;

    const trimmed = raw.trim();
    if (!trimmed) return;

    const isDir = trimmed.endsWith('/');
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    if (!name) return;

    const data = await postJSON('/api/files/create', {
      path: currentDir,
      name,
      isDir,
    });

    if (!data.ok) {
      toast(`❌ ${data.error}`, 'err');
      return;
    }

    toast('✅ Creado correctamente', 'ok');
    populateFiles(currentDir);
  });

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
      priceFilter = button.dataset.price;

      document.querySelectorAll('.plg-price').forEach(item =>
        item.classList.toggle('active', item === button)
      );
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

  $('plgSearchInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      pluginSearch();
    }
  });

  $('btnRefreshInstalled')?.addEventListener('click', loadInstalledPlugins);

  $('btnClosePlgModal')?.addEventListener('click', () => {
    if ($('plgVersionModal')) {
      $('plgVersionModal').style.display = 'none';
    }
  });

  $('plgVersionModal')?.addEventListener('click', event => {
    if (event.target === $('plgVersionModal')) {
      $('plgVersionModal').style.display = 'none';
    }
  });

  $('btnNewBackup')?.addEventListener('click', createBackup);

  updateAgentUi(agentOnline);
  updateStatusUi(currentStatus);

  if (panelSession && agentId) {
    connectCloud(false).catch(() =>
      showLogin(
        'La sesión no es válida. Introduce un nuevo código de emparejamiento.'
      )
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
