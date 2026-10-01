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
      existing.addEventListener(
        'error',
        () => reject(new Error('No se pudo cargar Socket.IO.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');

    script.src = '/socket.io/socket.io.js';
    script.async = true;
    script.dataset.moonwolfSocketio = '1';

    script.onload = resolve;
    script.onerror = () =>
      reject(new Error('No se pudo cargar Socket.IO.'));

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

      event.target.value =
        `MW-SHARE-${groups.join('-')}`.replace(/-$/, '');

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

    event.target.value =
      `MW-P${first}${second ? `-${second}` : ''}`;
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

const PERMISSION_RANK = {
  read: 1,
  control: 2,
  admin: 3,
};

function hasPermission(required) {
  return (
    (PERMISSION_RANK[panelPermission] || 0) >=
    (PERMISSION_RANK[required] || 99)
  );
}

async function attemptLogin() {
  const input = $('loginPassword');
  const button = $('btnLogin');

  const code = String(input?.value || '')
    .trim()
    .toUpperCase();

  if (
    !PAIRING_CODE_RE.test(code) &&
    !SHARE_TOKEN_RE.test(code)
  ) {
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
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();

    if (
      !response.ok ||
      !data.ok ||
      !data.session ||
      !data.agent?.id
    ) {
      throw new Error(
        data.error || 'No se pudo emparejar el panel.'
      );
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

        showLogin(
          'La sesión del panel ha caducado. Introduce un nuevo código.'
        );
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
      panelPermission = String(
        data?.permission ||
        panelPermission ||
        'admin'
      );

      panelKind = String(
        data?.kind ||
        panelKind ||
        'owner'
      );

      sessionStorage.setItem(
        PERMISSION_KEY,
        panelPermission
      );

      sessionStorage.setItem(
        SESSION_KIND_KEY,
        panelKind
      );

      renderSettings();
    });

    cloudSocket.on('share_revoked', () => {
      clearSession();

      showLogin(
        'Este acceso compartido ha sido revocado.'
      );
    });

    cloudSocket.on('status', setStatus);
    cloudSocket.on('log', appendLog);

    cloudSocket.on('history', logs => {
      const consoleEl = $('console');

      if (!consoleEl) return;

      consoleEl.innerHTML = '';

      (Array.isArray(logs) ? logs : []).forEach(
        appendLog
      );
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

      clearPending(
        'Conexión con MoonWolf Cloud perdida.'
      );

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

      reconnectDelay = Math.min(
        reconnectDelay * 2,
        30000
      );
    });

    cloudSocket.connect();
  });
}

/* RPC / API */

async function cloudApi(pathname, init = {}) {
  const headers = new Headers(
    init.headers || {}
  );

  headers.set(
    'Authorization',
    `Bearer ${panelSession}`
  );

  if (
    init.body !== undefined &&
    !headers.has('Content-Type')
  ) {
    headers.set(
      'Content-Type',
      'application/json'
    );
  }

  const response = await fetch(
    pathname,
    {
      ...init,
      headers,
    }
  );

  let data = null;

  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.error ||
      `Error HTTP ${response.status}`
    );
  }

  return data;
}

function rpcHttp(pathname, init = {}) {
  if (!cloudSocket?.connected) {
    return Promise.reject(
      new Error(
        'MoonWolf Cloud no está conectado.'
      )
    );
  }

  const id =
    `${Date.now()}-${++requestSequence}`;

  const request = {
    id,
    method: String(
      init.method || 'GET'
    ).toUpperCase(),
    path: pathname,
    body: init.body ?? undefined,
  };

  return new Promise(resolve => {
    pending.set(id, resolve);

    cloudSocket.emit(
      'rpc',
      request
    );
  });
}

function decodeResultBody(result) {
  if (result?.bodyBase64 === undefined) {
    return null;
  }

  const binary = atob(
    result.bodyBase64
  );

  const bytes =
    new Uint8Array(binary.length);

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}

async function api(pathname, init = {}) {
  const result = await rpcHttp(
    pathname,
    init
  );

  const status =
    result?.status || 500;

  const contentType =
    result?.contentType ||
    'application/json';

  if (
    result?.bodyBase64 !== undefined
  ) {
    const bytes =
      decodeResultBody(result);

    const text =
      new TextDecoder().decode(bytes);

    if (
      contentType.includes(
        'application/json'
      ) ||
      contentType.includes(
        'text/'
      )
    ) {
      try {
        return JSON.parse(text);
      } catch {
        return {
          ok:
            status >= 200 &&
            status < 300,
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
  return api(
    pathname,
    {
      method: 'POST',
      body,
    }
  );
}

/* AGENT STATUS */

function setAgentOnline(online) {
  const nextState =
    Boolean(online);

  if (
    agentOnline === nextState
  ) {
    updateAgentUi(nextState);
    updateStatusUi(currentStatus);
    return;
  }

  agentOnline = nextState;

  updateAgentUi(nextState);
  updateStatusUi(currentStatus);

  if (nextState) {
    if (
      lastAgentActivityState !== true
    ) {
      addActivity(
        'MoonWolf Agent conectado',
        'ok',
        '🟢'
      );
    }

    lastAgentActivityState = true;
  } else {
    if (
      lastAgentActivityState !== false
    ) {
      addActivity(
        'MoonWolf Agent desconectado',
        'warn',
        '🔴'
      );
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

    element.classList.toggle(
      'online',
      Boolean(online)
    );

    element.classList.toggle(
      'offline',
      !online
    );

    if (
      element.dataset &&
      element.dataset.agentStatus !== undefined
    ) {
      element.dataset.agentStatus =
        online
          ? 'online'
          : 'offline';
    }
  }

  const textElements = [
    $('agentStatusText'),
    $('sbAgentStatusText'),
  ];

  for (
    const element of textElements
  ) {
    if (!element) continue;

    element.textContent =
      online
        ? 'AGENT ONLINE'
        : 'AGENT OFFLINE';
  }
}

/* SERVER / TERMINAL */

function updateStatusUi(status) {
  status =
    STATUS_LABELS[status]
      ? status
      : 'offline';

  currentStatus = status;

  const statusEl =
    $('sbStatus');

  if (statusEl) {
    statusEl.className =
      `sb-status ${status}`;
  }

  const statusText =
    $('sbStatusText');

  if (statusText) {
    statusText.textContent =
      STATUS_LABELS[status] ||
      String(status).toUpperCase();
  }

  const startButton =
    $('btnStart');

  if (startButton) {
    startButton.disabled =
      status !== 'offline' ||
      !agentOnline;
  }

  const stopButton =
    $('btnStop');

  if (stopButton) {
    stopButton.disabled =
      status !== 'online' ||
      !agentOnline;
  }

  const restartButton =
    $('btnRestart');

  if (restartButton) {
    restartButton.disabled =
      status !== 'online' ||
      !agentOnline;
  }

  const stats =
    $('statsGrid');

  if (stats) {
    stats.classList.toggle(
      'hidden',
      status === 'offline'
    );

    stats.classList.toggle(
      'visible',
      status !== 'offline'
    );
  }
}

function setStatus(status) {
  updateStatusUi(status);

  const normalized =
    STATUS_LABELS[status]
      ? status
      : 'offline';

  if (
    lastStatusActivity === normalized
  ) {
    return;
  }

  lastStatusActivity =
    normalized;

  addActivity(
    STATUS_LABELS[normalized] ||
      normalized,
    STATUS_LEVELS[normalized] ||
      'info',
    STATUS_ICONS[normalized] ||
      '📌'
  );
}

function updateStats(stats = {}) {
  const players =
    Number(stats.players);

  const maxPlayers =
    Number(stats.maxPlayers);

  const tps =
    Number(stats.tps);

  const processMemory =
    Number(stats.processMemory);

  const cpuUsage =
    Number(stats.cpuUsage);

  const safePlayers =
    Number.isFinite(players)
      ? players
      : 0;

  const safeMaxPlayers =
    Number.isFinite(maxPlayers)
      ? maxPlayers
      : 0;

  const safeTps =
    Number.isFinite(tps)
      ? tps
      : 20;

  const safeProcessMemory =
    Number.isFinite(processMemory)
      ? processMemory
      : 0;

  const safeCpu =
    Number.isFinite(cpuUsage)
      ? cpuUsage
      : 0;

  if ($('statPlayers')) {
    $('statPlayers').innerHTML =
      `${safePlayers}<span class="stat-unit">/${safeMaxPlayers}</span>`;
  }

  const tpsEl =
    $('statTps');

  if (tpsEl) {
    tpsEl.className =
      `stat-value ${
        safeTps < 15
          ? 'tps-bad'
          : safeTps < 18
            ? 'tps-warn'
            : 'tps-good'
      }`;

    tpsEl.innerHTML =
      `${safeTps}<span class="stat-unit"> tps</span>`;
  }

  if ($('statUptime')) {
    $('statUptime').textContent =
      stats.uptime ||
      '0h 0m';
  }

  if ($('statMemProc')) {
    $('statMemProc').innerHTML =
      `${safeProcessMemory}<span class="stat-unit"> MB</span>`;
  }

  const sys =
    stats.sysMemory ||
    {
      used: 0,
      total: 0,
    };

  const used =
    Number(sys.used);

  const total =
    Number(sys.total);

  const safeUsed =
    Number.isFinite(used)
      ? used
      : 0;

  const safeTotal =
    Number.isFinite(total)
      ? total
      : 0;

  if ($('statMemSys')) {
    $('statMemSys').innerHTML =
      `${safeUsed}/${safeTotal}<span class="stat-unit"> GB</span>`;
  }

  if ($('statCpu')) {
    $('statCpu').innerHTML =
      `${safeCpu}<span class="stat-unit"> %</span>`;
  }
}

/* FILTRO DE LOGS */

const LOG_IGNORE_PATTERNS = [
  /Thread RCON Client \/127\.0\.0\.1 (started|shutting down)/i,
];

function shouldIgnoreLog(line) {
  const text =
    String(line || '');

  return LOG_IGNORE_PATTERNS.some(
    re => re.test(text)
  );
}

function appendLog(entry) {
  const consoleEl =
    $('console');

  if (!consoleEl) return;

  const line =
    String(entry?.line || '');

  if (shouldIgnoreLog(line)) {
    return;
  }

  const div =
    document.createElement('div');

  div.className =
    `log-line ${entry?.type || 'info'}`;

  div.innerHTML =
    `<span class="log-time">${escHtml(entry?.time || '--:--:--')}</span>` +
    `<span class="log-text">${escHtml(line)}</span>`;

  consoleEl.appendChild(div);

  consoleEl.scrollTop =
    consoleEl.scrollHeight;
}

async function startServer() {
  if (!agentOnline) {
    toast(
      'MoonWolf Agent no está conectado.',
      'err'
    );

    return;
  }

  const data =
    await api(
      '/api/start',
      {
        method: 'POST',
      }
    );

  if (!data.ok) {
    toast(
      data.error ||
        'Error al arrancar',
      'err'
    );
  }
}

async function stopServer() {
  if (!agentOnline) {
    toast(
      'MoonWolf Agent no está conectado.',
      'err'
    );

    return;
  }

  const data =
    await api(
      '/api/stop',
      {
        method: 'POST',
      }
    );

  if (!data.ok) {
    toast(
      data.error ||
        'Error al detener',
      'err'
    );
  }
}

async function restartServer() {
  if (
    currentStatus === 'restarting' ||
    currentStatus === 'stopping'
  ) {
    return;
  }

  if (!agentOnline) {
    toast(
      'MoonWolf Agent no está conectado.',
      'err'
    );

    return;
  }

  const data =
    await api(
      '/api/restart',
      {
        method: 'POST',
      }
    );

  if (!data.ok) {
    toast(
      data.error ||
        'Error al reiniciar',
      'err'
    );
  }
}

async function sendCmd() {
  const input =
    $('cmdInput');

  const cmd =
    input?.value.trim();

  if (!cmd) return;

  if (!agentOnline) {
    toast(
      'MoonWolf Agent no está conectado.',
      'err'
    );

    return;
  }

  input.value = '';

  const data =
    await postJSON(
      '/api/command',
      {
        cmd,
      }
    );

  if (!data.ok) {
    toast(
      data.error ||
        'Error al enviar comando',
      'err'
    );
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

  const list =
    $('fileList');

  if (!list) return;

  list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon" style="display:inline-block;animation:spin 1s linear infinite">⟳</div>
      <div class="empty-msg">Cargando...</div>
    </div>
  `;

  renderBreadcrumb(dir);

  api(
    `/api/files?dir=${encodeURIComponent(dir)}`
  )
    .then(data => {
      if (!data.ok) {
        throw new Error(
          data.error ||
            'No se pudo leer la carpeta.'
        );
      }

      const items =
        Array.isArray(data.items)
          ? data.items.slice()
          : [];

      items.sort(
        (a, b) =>
          (a.type === 'dir'
            ? -1
            : 1) -
            (b.type === 'dir'
              ? -1
              : 1) ||
          a.name.localeCompare(
            b.name,
            undefined,
            {
              sensitivity: 'base',
            }
          )
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

      list.innerHTML =
        items
          .map(
            item => `
              <div
                class="file-row"
                data-name="${escHtml(item.name)}"
                data-type="${escHtml(item.type)}"
              >
                <span
                  class="file-name"
                  style="flex:1"
                >
                  ${fileIcon(item.type)}
                  <span>
                    ${escHtml(item.name)}
                  </span>
                </span>

                <span
                  style="width:90px;text-align:right;color:var(--muted2)"
                >
                  ${escHtml(item.size)}
                </span>

                <span
                  style="width:140px;text-align:right;color:var(--muted2)"
                >
                  ${escHtml(item.date)}
                </span>
              </div>
            `
          )
          .join('');

      list
        .querySelectorAll('.file-row')
        .forEach(row => {
          row.addEventListener(
            'dblclick',
            () => {
              const name =
                row.dataset.name;

              const type =
                row.dataset.type;

              const rel =
                currentDir
                  ? `${currentDir}/${name}`
                  : name;

              if (type === 'dir') {
                populateFiles(rel);
              } else if (
                type !== 'jar'
              ) {
                openFile(rel);
              }
            }
          );

          row.addEventListener(
            'contextmenu',
            event =>
              openFileContext(
                event,
                row.dataset.name,
                row.dataset.type
              )
          );
        });
    })
    .catch(error => {
      list.innerHTML = `
        <div class="empty-state">
          <div
            class="empty-icon"
            style="color:var(--red)"
          >
            ⚠
          </div>

          <div class="empty-msg">
            ${escHtml(error.message)}
          </div>
        </div>
      `;
    });
}

function renderBreadcrumb(dir) {
  const trail =
    $('crumbTrail');

  if (!trail) return;

  const parts =
    dir
      ? dir.split('/').filter(Boolean)
      : [];

  let acc = '';

  trail.innerHTML =
    parts
      .map(
        (part, index) => {
          acc +=
            (index ? '/' : '') +
            part;

          return `
            /
            <span
              class="crumb"
              data-path="${escHtml(acc)}"
            >
              ${escHtml(part)}
            </span>
          `;
        }
      )
      .join('');

  trail
    .querySelectorAll('.crumb')
    .forEach(crumb => {
      crumb.addEventListener(
        'click',
        () =>
          populateFiles(
            crumb.dataset.path
          )
      );
    });
}

function openFileContext(
  event,
  name,
  type
) {
  event.preventDefault();

  document
    .querySelector('.file-ctx-menu')
    ?.remove();

  const rel =
    currentDir
      ? `${currentDir}/${name}`
      : name;

  const menu =
    document.createElement('div');

  menu.className =
    'file-ctx-menu';

  menu.style.left =
    `${event.clientX}px`;

  menu.style.top =
    `${event.clientY}px`;

  menu.innerHTML = `
    ${
      type !== 'dir'
        ? '<div class="ctx-item" data-action="open">📂 Abrir</div>'
        : ''
    }

    <div
      class="ctx-item"
      data-action="rename"
    >
      ✏️ Renombrar
    </div>

    <div
      class="ctx-item"
      data-action="copy"
    >
      📋 Copiar
    </div>

    <div
      class="ctx-item"
      data-action="move"
    >
      🔀 Mover
    </div>

    ${
      type !== 'dir'
        ? '<div class="ctx-item" data-action="download">⬇️ Descargar</div>'
        : ''
    }

    <div
      class="ctx-item"
      data-action="compress"
    >
      🗜️ Comprimir
    </div>

    <div class="ctx-sep"></div>

    <div
      class="ctx-item danger"
      data-action="delete"
    >
      🗑️ Eliminar
    </div>
  `;

  document.body.appendChild(menu);

  menu.addEventListener(
    'click',
    async click => {
      const action =
        click.target
          .closest('.ctx-item')
          ?.dataset.action;

      if (!action) return;

      menu.remove();

      try {
        if (action === 'open') {
          return openFile(rel);
        }

        if (action === 'rename') {
          const newName =
            prompt(
              `Nuevo nombre para "${name}":`,
              name
            );

          if (
            !newName ||
            newName === name
          ) {
            return;
          }

          const data =
            await postJSON(
              '/api/files/rename',
              {
                path: rel,
                newName,
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }
        }

        if (action === 'copy') {
          const dest =
            prompt(
              `Ruta relativa de destino para "${name}":`,
              currentDir || ''
            );

          if (dest === null) return;

          const target =
            dest
              ? `${dest
                  .replace(/\\/g, '/')
                  .replace(/\/$/, '')}/${name}`
              : name;

          const data =
            await postJSON(
              '/api/files/copy',
              {
                path: rel,
                dest: target,
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }
        }

        if (action === 'move') {
          const dest =
            prompt(
              `Carpeta relativa de destino para "${name}":`,
              currentDir || ''
            );

          if (dest === null) return;

          const target =
            dest
              ? `${dest
                  .replace(/\\/g, '/')
                  .replace(/\/$/, '')}/${name}`
              : name;

          const data =
            await postJSON(
              '/api/files/move',
              {
                path: rel,
                dest: target,
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }
        }

        if (action === 'download') {
          return downloadFile(
            rel,
            name
          );
        }

        if (action === 'compress') {
          const data =
            await postJSON(
              '/api/files/compress',
              {
                path: rel,
                name,
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }
        }

        if (action === 'delete') {
          if (
            !confirm(
              `¿Eliminar "${name}"?`
            )
          ) {
            return;
          }

          const data =
            await postJSON(
              '/api/files/delete',
              {
                path: rel,
                isDir:
                  type === 'dir',
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }
        }

        toast(
          '✅ Operación completada',
          'ok'
        );

        populateFiles(
          currentDir
        );
      } catch (error) {
        toast(
          `❌ ${error.message}`,
          'err'
        );
      }
    }
  );

  setTimeout(() => {
    document.addEventListener(
      'click',
      () => menu.remove(),
      { once: true }
    );
  }, 0);
}

const FILE_UPLOAD_CHUNK_SIZE =
  1024 * 1024;

function bytesToBase64(bytes) {
  let binary = '';

  const step = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += step
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        Math.min(
          i + step,
          bytes.length
        )
      )
    );
  }

  return btoa(binary);
}

function normalizeUploadRelativePath(
  value
) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(
      part =>
        part &&
        part !== '.' &&
        part !== '..'
    )
    .join('/');
}

async function uploadOneFile(
  file,
  relativePath,
  progressState
) {
  const relPath =
    normalizeUploadRelativePath(
      relativePath || file.name
    );

  if (!relPath) {
    throw new Error(
      `Nombre de archivo no válido: ${file.name}`
    );
  }

  const target =
    currentDir
      ? `${currentDir
          .replace(/\\/g, '/')
          .replace(/\/$/, '')}/${relPath}`
      : relPath;

  const uploadId =
    `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}-${progressState.index}`;

  let offset = 0;

  while (
    offset < file.size ||
    (
      file.size === 0 &&
      offset === 0
    )
  ) {
    const end =
      file.size === 0
        ? 0
        : Math.min(
            offset +
              FILE_UPLOAD_CHUNK_SIZE,
            file.size
          );

    const buffer =
      await file
        .slice(offset, end)
        .arrayBuffer();

    const bytes =
      new Uint8Array(buffer);

    const data =
      await postJSON(
        '/api/files/upload-chunk',
        {
          uploadId,
          path: target,
          offset,
          totalSize:
            file.size,
          chunkBase64:
            bytesToBase64(bytes),
          final:
            end >= file.size,
          overwrite: true,
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error ||
          `No se pudo subir ${file.name}`
      );
    }

    if (file.size === 0) {
      offset = 1;
      break;
    }

    offset = end;

    progressState.doneBytes +=
      bytes.length;

    const percent =
      progressState.totalBytes > 0
        ? Math.round(
            (
              progressState.doneBytes /
              progressState.totalBytes
            ) * 100
          )
        : 100;

    toast(
      `⬆️ Subiendo ${progressState.index + 1}/${progressState.totalFiles}: ${percent}%`,
      'info'
    );
  }

  progressState.index += 1;
}

async function uploadSelectedFiles(
  fileList
) {
  const files =
    Array.from(
      fileList || {}
    ).filter(
      file =>
        file &&
        typeof file.size ===
          'number'
    );

  if (!files.length) return;

  const progressState = {
    index: 0,
    totalFiles: files.length,
    totalBytes:
      files.reduce(
        (sum, file) =>
          sum + file.size,
        0
      ),
    doneBytes: 0,
  };

  try {
    for (const file of files) {
      const relative =
        file.webkitRelativePath ||
        file.name;

      await uploadOneFile(
        file,
        relative,
        progressState
      );
    }

    toast(
      `✅ ${files.length} ${
        files.length === 1
          ? 'archivo subido'
          : 'archivos subidos'
      } correctamente`,
      'ok'
    );

    populateFiles(
      currentDir
    );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

async function downloadFile(
  rel,
  filename
) {
  const result =
    await rpcHttp(
      `/api/files/download?path=${encodeURIComponent(rel)}`
    );

  if (!result?.bodyBase64) {
    toast(
      result?.data?.error ||
        'No se pudo descargar el archivo.',
      'err'
    );

    return;
  }

  const bytes =
    decodeResultBody(result);

  const blob =
    new Blob(
      [bytes],
      {
        type:
          result.contentType ||
          'application/octet-stream',
      }
    );

  const url =
    URL.createObjectURL(blob);

  const anchor =
    document.createElement('a');

  anchor.href = url;
  anchor.download =
    filename;

  anchor.click();

  setTimeout(
    () =>
      URL.revokeObjectURL(url),
    1000
  );
}

async function openFile(rel) {
  try {
    const data =
      await api(
        `/api/files/content?path=${encodeURIComponent(rel)}`
      );

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    currentFile = rel;

    if ($('filesTablePanel')) {
      $('filesTablePanel').style.display =
        'none';
    }

    if ($('filesEditorPanel')) {
      $('filesEditorPanel').style.display =
        'block';
    }

    if ($('editorFileName')) {
      $('editorFileName').textContent =
        rel;
    }

    initEditor(
      data.content || ''
    );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

function initEditor(content) {
  const container =
    $('editorContainer');

  if (!container) return;

  container.innerHTML = '';

  if (window.CodeMirror) {
    let mode =
      'text/plain';

    if (currentFile) {
      if (
        /\.(yml|yaml)$/i.test(
          currentFile
        )
      ) {
        mode = 'yaml';
      } else if (
        /\.json$/i.test(
          currentFile
        )
      ) {
        mode = 'application/json';
      } else if (
        /\.(properties|ini|conf)$/i.test(
          currentFile
        )
      ) {
        mode = 'properties';
      } else if (
        /\.(xml|html)$/i.test(
          currentFile
        )
      ) {
        mode = 'xml';
      } else if (
        /\.(js|mjs)$/i.test(
          currentFile
        )
      ) {
        mode = 'javascript';
      } else if (
        /\.sh$/i.test(
          currentFile
        )
      ) {
        mode = 'shell';
      }
    }

    editor =
      window.CodeMirror(
        container,
        {
          value: content,
          mode,
          theme: 'dracula',
          lineNumbers: true,
          tabSize: 2,
          indentWithTabs: false,
          lineWrapping: true,
        }
      );
  } else {
    const textarea =
      document.createElement(
        'textarea'
      );

    textarea.id =
      'editorTextarea';

    textarea.className =
      'editor-fallback';

    textarea.value =
      content;

    container.appendChild(
      textarea
    );

    editor = {
      getValue: () =>
        textarea.value,

      setValue: val => {
        textarea.value = val;
      },
    };
  }
}

function closeEditor() {
  currentFile = null;
  editor = null;

  if ($('filesEditorPanel')) {
    $('filesEditorPanel').style.display =
      'none';
  }

  if ($('filesTablePanel')) {
    $('filesTablePanel').style.display =
      'block';
  }
}

async function saveFile() {
  if (
    !currentFile ||
    !editor
  ) {
    return;
  }

  const content =
    editor.getValue();

  try {
    const data =
      await postJSON(
        '/api/files/save',
        {
          path: currentFile,
          content,
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    toast(
      '💾 Archivo guardado correctamente',
      'ok'
    );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

/* PLUGIN STORE */

async function searchPlugins() {
  const query =
    $('pluginSearchInput')
      ?.value.trim() || '';

  const grid =
    $('pluginsGrid');

  if (!grid) return;

  grid.innerHTML = `
    <div class="empty-state">
      <div
        class="empty-icon"
        style="display:inline-block;animation:spin 1s linear infinite"
      >
        ⟳
      </div>

      <div class="empty-msg">
        Buscando plugins...
      </div>
    </div>
  `;

  try {
    const data =
      await api(
        `/api/plugins/search?q=${encodeURIComponent(query)}&source=${pluginSource}&price=${priceFilter}`
      );

    if (!data.ok) {
      throw new Error(
        data.error ||
          'No se pudieron cargar los plugins.'
      );
    }

    const items =
      Array.isArray(data.items)
        ? data.items
        : [];

    if (!items.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔌</div>
          <div class="empty-msg">
            No se encontraron plugins
          </div>
        </div>
      `;

      return;
    }

    grid.innerHTML =
      items
        .map(
          item => `
            <div
              class="plugin-card"
              data-id="${escHtml(item.id)}"
              data-source="${escHtml(item.source)}"
            >
              <div class="plugin-card-header">
                <img
                  class="plugin-icon"
                  src="${escHtml(
                    item.icon ||
                      '/assets/plugin-placeholder.png'
                  )}"
                  alt="icon"
                  onerror="this.src='/assets/plugin-placeholder.png'"
                >

                <div class="plugin-info">
                  <div class="plugin-title">
                    ${escHtml(item.name)}
                  </div>

                  <div class="plugin-author">
                    por ${escHtml(
                      item.author ||
                        'Desconocido'
                    )}
                  </div>
                </div>
              </div>

              <div class="plugin-desc">
                ${escHtml(
                  item.description ||
                    'Sin descripción disponible.'
                )}
              </div>

              <div class="plugin-footer">
                <span
                  class="plugin-tag ${
                    item.premium
                      ? 'premium'
                      : 'free'
                  }"
                >
                  ${
                    item.premium
                      ? 'PREMIUM'
                      : 'GRATIS'
                  }
                </span>

                <span class="plugin-source">
                  ${escHtml(
                    item.source.toUpperCase()
                  )}
                </span>
              </div>
            </div>
          `
        )
        .join('');

    grid
      .querySelectorAll(
        '.plugin-card'
      )
      .forEach(card => {
        card.addEventListener(
          'click',
          () => {
            openPluginDetails(
              card.dataset.id,
              card.dataset.source
            );
          }
        );
      });
  } catch (error) {
    grid.innerHTML = `
      <div class="empty-state">
        <div
          class="empty-icon"
          style="color:var(--red)"
        >
          ⚠
        </div>

        <div class="empty-msg">
          ${escHtml(error.message)}
        </div>
      </div>
    `;
  }
}

async function openPluginDetails(
  id,
  source
) {
  try {
    const data =
      await api(
        `/api/plugins/details?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`
      );

    if (!data.ok) {
      throw new Error(
        data.error ||
          'No se obtuvieron detalles del plugin.'
      );
    }

    currentPlugin =
      data.plugin;

    if ($('pluginModalTitle')) {
      $('pluginModalTitle').textContent =
        currentPlugin.name;
    }

    if ($('pluginModalAuthor')) {
      $('pluginModalAuthor').textContent =
        `por ${
          currentPlugin.author ||
          'Desconocido'
        }`;
    }

    if ($('pluginModalDesc')) {
      $('pluginModalDesc').textContent =
        currentPlugin.description ||
        '';
    }

    if ($('pluginModalIcon')) {
      $('pluginModalIcon').src =
        currentPlugin.icon ||
        '/assets/plugin-placeholder.png';
    }

    if ($('pluginModalVersion')) {
      $('pluginModalVersion').textContent =
        currentPlugin.version ||
        'Última';
    }

    const installBtn =
      $('btnInstallPlugin');

    if (installBtn) {
      installBtn.disabled =
        currentPlugin.premium &&
        !currentPlugin.downloadUrl;

      installBtn.textContent =
        currentPlugin.premium
          ? 'Comprar / Descargar Externa'
          : 'Instalar en Servidor';
    }

    $('pluginModal')
      ?.classList.remove(
        'hidden'
      );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

async function installCurrentPlugin() {
  if (!currentPlugin) return;

  const btn =
    $('btnInstallPlugin');

  if (btn) {
    btn.disabled = true;
    btn.textContent =
      'Instalando...';
  }

  try {
    const data =
      await postJSON(
        '/api/plugins/install',
        {
          id:
            currentPlugin.id,

          source:
            currentPlugin.source,

          downloadUrl:
            currentPlugin.downloadUrl,

          name:
            currentPlugin.name,
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error ||
          'Fallo la instalación.'
      );
    }

    toast(
      `✅ Plugin "${currentPlugin.name}" instalado correctamente`,
      'ok'
    );

    $('pluginModal')
      ?.classList.add(
        'hidden'
      );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent =
        'Instalar en Servidor';
    }
  }
}

/* VERSIONS & SOFTWARE */

const VERSION_SOFTWARE = {
  plugins: [
    {
      id: 'paper',
      name: 'Paper',
      description:
        'Servidor optimizado compatible con plugins Bukkit/Spigot.',
      icon: '📄',
    },

    {
      id: 'purpur',
      name: 'Purpur',
      description:
        'Servidor basado en Paper con más opciones de configuración.',
      icon: '🟣',
    },

    {
      id: 'spigot',
      name: 'Spigot',
      description:
        'Servidor Bukkit optimizado y ampliamente compatible.',
      icon: '🧩',
    },

    {
      id: 'bukkit',
      name: 'Bukkit',
      description:
        'Servidor clásico para plugins Bukkit.',
      icon: '🔌',
    },

    {
      id: 'leaf',
      name: 'Leaf',
      description:
        'Servidor de alto rendimiento basado en Paper.',
      icon: '🍃',
    },
  ],

  mods: [
    {
      id: 'fabric',
      name: 'Fabric',
      description:
        'Loader ligero y moderno para servidores con mods.',
      icon: '🧵',
    },

    {
      id: 'forge',
      name: 'Forge',
      description:
        'Uno de los loaders de mods más utilizados.',
      icon: '🔨',
    },

    {
      id: 'neoforge',
      name: 'NeoForge',
      description:
        'Loader moderno para mods de Minecraft.',
      icon: '⚒️',
    },

    {
      id: 'quilt',
      name: 'Quilt',
      description:
        'Loader compatible con el ecosistema de mods de Fabric.',
      icon: '🧶',
    },
  ],

  vanilla: [
    {
      id: 'vanilla',
      name: 'Vanilla',
      description:
        'Servidor oficial de Minecraft sin modificaciones.',
      icon: '🌿',
    },
  ],
};

function getAllVersionSoftware() {
  return Object.values(
    VERSION_SOFTWARE
  ).flat();
}

function getVersionSoftware(
  software
) {
  return getAllVersionSoftware().find(
    item =>
      item.id === software
  );
}

function getVersionCategoryIcon(
  category
) {
  return {
    plugins: '🧩',
    mods: '🧱',
    vanilla: '🌿',
  }[category] || '📦';
}

function getVersionCategoryName(
  category
) {
  return {
    plugins:
      'Servidores de plugins',

    mods:
      'Servidores de mods',

    vanilla:
      'Servidores Vanilla',
  }[category] ||
    'Servidores';
}

function renderVersionSoftwareCard(
  software
) {
  return `
    <button
      type="button"
      class="ver-software-card"
      data-software="${escHtml(
        software.id
      )}"
    >
      <div class="ver-software-icon">
        ${software.icon}
      </div>

      <div class="ver-software-content">
        <div class="ver-software-name">
          ${escHtml(
            software.name
          )}
        </div>

        <div class="ver-software-desc">
          ${escHtml(
            software.description
          )}
        </div>
      </div>

      <div class="ver-software-arrow">
        ›
      </div>
    </button>
  `;
}

function renderVersionCategory(
  category,
  softwareList
) {
  return `
    <section class="ver-category">
      <div class="ver-category-header">
        <div class="ver-category-icon">
          ${getVersionCategoryIcon(
            category
          )}
        </div>

        <div class="ver-category-name">
          ${getVersionCategoryName(
            category
          )}
        </div>

        <div class="ver-category-count">
          ${softwareList.length}
          disponibles
        </div>
      </div>

      <div class="ver-software-grid">
        ${softwareList
          .map(
            renderVersionSoftwareCard
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderVersionSoftware() {
  const container =
    $('versionList');

  if (!container) {
    return;
  }

  container.innerHTML = `
    <div class="ver-hero">
      <div class="ver-hero-icon">
        📦
      </div>

      <div>
        <div class="ver-hero-title">
          Servidores de Minecraft
        </div>

        <div class="ver-hero-description">
          Elige el tipo de servidor que quieres utilizar.
        </div>
      </div>
    </div>

    ${renderVersionCategory(
      'plugins',
      VERSION_SOFTWARE.plugins
    )}

    ${renderVersionCategory(
      'mods',
      VERSION_SOFTWARE.mods
    )}

    ${renderVersionCategory(
      'vanilla',
      VERSION_SOFTWARE.vanilla
    )}
  `;

  container
    .querySelectorAll(
      '[data-software]'
    )
    .forEach(card => {
      card.addEventListener(
        'click',
        () => {
          selectVersionSoftware(
            card.dataset.software
          );
        }
      );
    });
}

function removeSelectedVersionInfo() {
  document
    .querySelector(
      '.ver-selected-software'
    )
    ?.remove();
}

function renderSelectedVersionInfo(
  software,
  data = null
) {
  removeSelectedVersionInfo();

  const container =
    $('versionList');

  if (!container) return;

  const currentVersion =
    data?.version ||
    versionState.version ||
    '';

  const builds =
    Array.isArray(data?.builds)
      ? data.builds
      : Array.isArray(
          versionState.builds
        )
        ? versionState.builds
        : [];

  const info =
    document.createElement('div');

  info.className =
    'ver-selected-software';

  const versionText =
    currentVersion
      ? `Versión disponible: ${escHtml(
          currentVersion
        )}`
      : 'Versión disponible en el servidor';

  const buildText =
    builds.length
      ? `
        <div class="ver-selected-builds">
          <span>Build disponible</span>
          <strong>
            ${escHtml(
              builds[0]
            )}
          </strong>
        </div>
      `
      : '';

  info.innerHTML = `
    <div class="ver-selected-header">
      <div class="ver-selected-icon">
        ${software.icon}
      </div>

      <div class="ver-selected-content">
        <div class="ver-selected-title">
          ${escHtml(
            software.name
          )}
        </div>

        <div class="ver-selected-description">
          ${escHtml(
            software.description
          )}
        </div>

        <div class="ver-selected-version">
          ${versionText}
        </div>

        ${buildText}
      </div>
    </div>

    <div class="ver-selected-actions">
      <button
        type="button"
        class="ver-back-btn"
        data-version-back
      >
        ← Volver
      </button>

      <button
        type="button"
        class="ver-install-btn"
        data-version-install
        ${
          !currentVersion
            ? 'disabled'
            : ''
        }
      >
        ${currentVersion
          ? 'Instalar servidor'
          : 'Versión no disponible'}
      </button>
    </div>
  `;

  container.prepend(info);

  info
    .querySelector(
      '[data-version-back]'
    )
    ?.addEventListener(
      'click',
      () => {
        removeSelectedVersionInfo();

        renderVersionSoftware();

        const versionList =
          $('versionList');

        versionList?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    );

  info
    .querySelector(
      '[data-version-install]'
    )
    ?.addEventListener(
      'click',
      () => {
        installSelectedVersion();
      }
    );

  info.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  });
}

async function selectVersionSoftware(
  software
) {
  const item =
    getVersionSoftware(
      software
    );

  if (!item) return;

  versionState = {
    software,
    softwareLabel:
      item.name,
    version: '',
    builds: [],
  };

  renderSelectedVersionInfo(
    item
  );

  try {
    const data =
      await api(
        `/api/version/status?software=${encodeURIComponent(software)}`
      );

    if (
      data?.ok
    ) {
      versionState = {
        ...versionState,

        software:
          data.software ||
          software,

        softwareLabel:
          data.softwareLabel ||
          item.name,

        version:
          data.version ||
          '',

        builds:
          Array.isArray(
            data.builds
          )
            ? data.builds
            : [],
      };

      renderSelectedVersionInfo(
        item,
        data
      );
    }
  } catch (error) {
    renderSelectedVersionInfo(
      item
    );
  }
}

async function loadVersionState() {
  renderVersionSoftware();

  try {
    const data =
      await api(
        '/api/version/status'
      );

    if (!data?.ok) {
      return;
    }

    versionState = {
      software:
        data.software ||
        'paper',

      softwareLabel:
        data.softwareLabel ||
        'Paper',

      version:
        data.version ||
        '',

      builds:
        Array.isArray(
          data.builds
        )
          ? data.builds
          : [],
    };
  } catch (error) {
    /*
     * La pantalla de software se mantiene visible
     * aunque el servidor todavía no esté disponible.
     */
  }
}

async function installSelectedVersion() {
  const software =
    versionState.software;

  const version =
    versionState.version;

  const build =
    Array.isArray(
      versionState.builds
    )
      ? (
          versionState.builds[0] ||
          ''
        )
      : '';

  if (!software) {
    toast(
      'Selecciona un servidor primero.',
      'warn'
    );

    return;
  }

  if (!version) {
    toast(
      'No hay una versión disponible para este servidor.',
      'warn'
    );

    return;
  }

  const softwareLabel =
    versionState.softwareLabel ||
    software;

  if (
    !confirm(
      `¿Deseas cambiar el servidor a ${softwareLabel}?`
    )
  ) {
    return;
  }

  try {
    toast(
      '⏳ Descargando e instalando el servidor...',
      'info'
    );

    const data =
      await postJSON(
        '/api/version/install',
        {
          software,
          version,
          build,
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error ||
          'No se pudo instalar el servidor.'
      );
    }

    toast(
      '✅ Servidor actualizado con éxito.',
      'ok'
    );

    await loadVersionState();
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

/*
 * Compatibilidad con código antiguo.
 * Ya no existen selectores de software,
 * versión o build en la nueva interfaz.
 */
function renderBuildsSelect() {
  return;
}

async function changeSoftwareOrVersion() {
  return;
}

/* SETTINGS / CONFIGS */

async function loadSettings() {
  try {
    const data =
      await api(
        '/api/settings'
      );

    if (!data.ok) return;

    const cfg =
      data.config || {};

    if ($('cfgJavaFlags')) {
      $('cfgJavaFlags').value =
        cfg.flags ||
        AIKAR_FLAGS;
    }

    if ($('cfgMemory')) {
      $('cfgMemory').value =
        cfg.memory ||
        '2G';
    }

    if ($('cfgAutoRestart')) {
      $('cfgAutoRestart').checked =
        Boolean(
          cfg.autoRestart
        );
    }

    if ($('cfgJarName')) {
      $('cfgJarName').value =
        cfg.jarName ||
        'server.jar';
    }

    renderSettings();
  } catch {}
}

async function saveSettings() {
  const flags =
    $('cfgJavaFlags')
      ?.value || '';

  const memory =
    $('cfgMemory')
      ?.value || '2G';

  const autoRestart =
    Boolean(
      $('cfgAutoRestart')
        ?.checked
    );

  const jarName =
    $('cfgJarName')
      ?.value ||
    'server.jar';

  try {
    const data =
      await postJSON(
        '/api/settings/save',
        {
          flags,
          memory,
          autoRestart,
          jarName,
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    toast(
      '💾 Configuración guardada',
      'ok'
    );
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

function renderSettings() {
  if ($('infoPermission')) {
    $('infoPermission').textContent =
      panelPermission.toUpperCase();
  }

  if ($('infoKind')) {
    $('infoKind').textContent =
      panelKind.toUpperCase();
  }

  if ($('infoAgentId')) {
    $('infoAgentId').textContent =
      agentId ||
      'Sin Conectar';
  }

  const adminOnlyElements =
    document.querySelectorAll(
      '.admin-only'
    );

  adminOnlyElements.forEach(
    el => {
      el.style.display =
        hasPermission('admin')
          ? ''
          : 'none';
    }
  );
}

/* SHARED TOKENS */

async function loadShareTokens() {
  const container =
    $('shareTokensList');

  if (!container) return;

  try {
    const data =
      await cloudApi(
        '/api/shares'
      );

    if (
      !data.ok ||
      !Array.isArray(
        data.shares
      )
    ) {
      container.innerHTML =
        '<div class="empty-msg">No hay tokens activos</div>';

      return;
    }

    if (!data.shares.length) {
      container.innerHTML =
        '<div class="empty-msg">No hay tokens activos</div>';

      return;
    }

    container.innerHTML =
      data.shares
        .map(
          s => `
            <div class="share-token-row">
              <div class="share-info">
                <span class="share-token-code">
                  ${escHtml(s.token)}
                </span>

                <span
                  class="share-permission-badge ${escHtml(
                    s.permission
                  )}"
                >
                  ${escHtml(
                    s.permission
                  )}
                </span>
              </div>

              <button
                class="btn-icon danger"
                data-revoke="${escHtml(
                  s.token
                )}"
              >
                🗑️
              </button>
            </div>
          `
        )
        .join('');

    container
      .querySelectorAll(
        '[data-revoke]'
      )
      .forEach(btn => {
        btn.addEventListener(
          'click',
          () =>
            revokeShareToken(
              btn.dataset.revoke
            )
        );
      });
  } catch {
    container.innerHTML =
      '<div class="empty-msg">Error cargando tokens</div>';
  }
}

async function createShareToken() {
  const permission =
    $('sharePermissionSelect')
      ?.value ||
    'read';

  try {
    const data =
      await cloudApi(
        '/api/shares/create',
        {
          method: 'POST',
          body:
            JSON.stringify({
              permission,
            }),
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    toast(
      '✅ Token generado con éxito',
      'ok'
    );

    loadShareTokens();
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

async function revokeShareToken(
  token
) {
  if (
    !confirm(
      '¿Revocar este token de acceso?'
    )
  ) {
    return;
  }

  try {
    const data =
      await cloudApi(
        '/api/shares/revoke',
        {
          method: 'POST',
          body:
            JSON.stringify({
              token,
            }),
        }
      );

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    toast(
      '✅ Token revocado',
      'ok'
    );

    loadShareTokens();
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

/* ACTIVITIES & TOASTS */

function addActivity(
  text,
  level = 'info',
  icon = '📌'
) {
  const time =
    new Date().toLocaleTimeString(
      'es-ES'
    );

  activities.unshift({
    time,
    text,
    level,
    icon,
  });

  if (activities.length > 30) {
    activities.pop();
  }

  const list =
    $('activityList');

  if (!list) return;

  list.innerHTML =
    activities
      .map(
        act => `
          <div class="activity-item ${act.level}">
            <span class="act-icon">
              ${act.icon}
            </span>

            <span class="act-time">
              ${act.time}
            </span>

            <span class="act-text">
              ${escHtml(
                act.text
              )}
            </span>
          </div>
        `
      )
      .join('');
}

function toast(
  msg,
  type = 'info'
) {
  let container =
    $('toastContainer');

  if (!container) {
    container =
      document.createElement(
        'div'
      );

    container.id =
      'toastContainer';

    container.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:999999;display:flex;flex-direction:column;gap:8px;';

    document.body.appendChild(
      container
    );
  }

  const el =
    document.createElement(
      'div'
    );

  el.className =
    `toast toast-${type}`;

  el.style.cssText =
    'padding:12px 18px;background:#1e222d;color:#fff;border-left:4px solid #6c5ce7;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.3);font-size:13px;animation:fadeIn 0.2s ease;';

  if (type === 'err') {
    el.style.borderLeftColor =
      '#ff6b6b';
  }

  if (type === 'ok') {
    el.style.borderLeftColor =
      '#51cf66';
  }

  if (type === 'warn') {
    el.style.borderLeftColor =
      '#fcc419';
  }

  el.textContent =
    msg;

  container.appendChild(
    el
  );

  setTimeout(() => {
    el.style.opacity = '0';

    el.style.transition =
      'opacity 0.3s ease';

    setTimeout(
      () => el.remove(),
      300
    );
  }, 3500);
}

/* NAVIGATION & TABS */

function bindNavigation() {
  const links =
    document.querySelectorAll(
      '.nav-link[data-tab]'
    );

  links.forEach(link => {
    link.addEventListener(
      'click',
      event => {
        event.preventDefault();

        const tabId =
          link.dataset.tab;

        links.forEach(
          l =>
            l.classList.remove(
              'active'
            )
        );

        link.classList.add(
          'active'
        );

        document
          .querySelectorAll(
            '.tab-content'
          )
          .forEach(tab => {
            tab.classList.add(
              'hidden'
            );
          });

        const activeTab =
          $(`tab-${tabId}`);

        if (activeTab) {
          activeTab.classList.remove(
            'hidden'
          );
        }

        if (
          tabId === 'files'
        ) {
          populateFiles(
            currentDir
          );
        }

        if (
          tabId === 'plugins'
        ) {
          searchPlugins();
        }

        if (
          tabId === 'version'
        ) {
          loadVersionState();
        }

        if (
          tabId === 'settings'
        ) {
          loadSettings();

          if (
            hasPermission(
              'admin'
            )
          ) {
            loadShareTokens();
          }
        }
      }
    );
  });
}

/* EVENTS BINDING */

function bindEvents() {
  bindNavigation();

  $('btnStart')
    ?.addEventListener(
      'click',
      startServer
    );

  $('btnStop')
    ?.addEventListener(
      'click',
      stopServer
    );

  $('btnRestart')
    ?.addEventListener(
      'click',
      restartServer
    );

  $('btnSendCmd')
    ?.addEventListener(
      'click',
      sendCmd
    );

  $('cmdInput')
    ?.addEventListener(
      'keydown',
      event => {
        if (
          event.key === 'Enter'
        ) {
          sendCmd();
        }
      }
    );

  $('btnEditorSave')
    ?.addEventListener(
      'click',
      saveFile
    );

  $('btnEditorClose')
    ?.addEventListener(
      'click',
      closeEditor
    );

  $('fileUploadInput')
    ?.addEventListener(
      'change',
      event => {
        uploadSelectedFiles(
          event.target.files
        );

        event.target.value =
          '';
      }
    );

  $('btnUploadFiles')
    ?.addEventListener(
      'click',
      () => {
        $('fileUploadInput')
          ?.click();
      }
    );

  $('btnNewFolder')
    ?.addEventListener(
      'click',
      async () => {
        const name =
          prompt(
            'Nombre de la nueva carpeta:'
          );

        if (!name) return;

        const target =
          currentDir
            ? `${currentDir}/${name}`
            : name;

        try {
          const data =
            await postJSON(
              '/api/files/mkdir',
              {
                path: target,
              }
            );

          if (!data.ok) {
            throw new Error(
              data.error
            );
          }

          toast(
            '📁 Carpeta creada',
            'ok'
          );

          populateFiles(
            currentDir
          );
        } catch (error) {
          toast(
            `❌ ${error.message}`,
            'err'
          );
        }
      }
    );

  $('btnPluginSearch')
    ?.addEventListener(
      'click',
      searchPlugins
    );

  $('pluginSearchInput')
    ?.addEventListener(
      'keydown',
      event => {
        if (
          event.key === 'Enter'
        ) {
          searchPlugins();
        }
      }
    );

  $('pluginSourceSelect')
    ?.addEventListener(
      'change',
      event => {
        pluginSource =
          event.target.value;

        searchPlugins();
      }
    );

  $('pluginPriceSelect')
    ?.addEventListener(
      'change',
      event => {
        priceFilter =
          event.target.value;

        searchPlugins();
      }
    );

  $('btnInstallPlugin')
    ?.addEventListener(
      'click',
      installCurrentPlugin
    );

  $('closePluginModal')
    ?.addEventListener(
      'click',
      () => {
        $('pluginModal')
          ?.classList.add(
            'hidden'
          );
      }
    );

  /*
   * Los antiguos selectores de Versiones ya no
   * forman parte de la interfaz nueva.
   *
   * Se mantienen estas comprobaciones opcionales
   * por compatibilidad con HTML antiguo.
   */
  $('softwareSelect')
    ?.addEventListener(
      'change',
      changeSoftwareOrVersion
    );

  $('versionSelect')
    ?.addEventListener(
      'change',
      changeSoftwareOrVersion
    );

  $('btnInstallVersion')
    ?.addEventListener(
      'click',
      installSelectedVersion
    );

  $('btnSaveSettings')
    ?.addEventListener(
      'click',
      saveSettings
    );

  $('btnCreateShareToken')
    ?.addEventListener(
      'click',
      createShareToken
    );

  $('btnLogout')
    ?.addEventListener(
      'click',
      () => {
        clearSession();

        if (cloudSocket) {
          cloudSocket.disconnect();
        }

        showLogin(
          'Has cerrado la sesión del panel.'
        );
      }
    );
}

/* INIT */

document.addEventListener(
  'DOMContentLoaded',
  () => {
    ensureLoginGate();

    bindEvents();

    if (
      panelSession &&
      agentId
    ) {
      connectCloud(false)
        .catch(() => {});
    } else {
      showLogin();
    }
  }
);
