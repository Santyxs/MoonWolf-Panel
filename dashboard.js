'use strict';

const CLOUD_URL = location.origin;
const CLOUD_PATH = '/socket.io';

const CODE_RE = /^MW-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const CODE_KEY = 'moonwolf_connection_code';

const $ = id => document.getElementById(id);

const escHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

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
let connectionCode = sessionStorage.getItem(CODE_KEY) || '';

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

let versionState = {
  software: null,
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
        Introduce el código de conexión que muestra
        MoonWolf Agent en el servidor Minecraft.
      </p>

      <input
        id="loginPassword"
        type="text"
        maxlength="22"
        spellcheck="false"
        autocomplete="off"
        placeholder="MW-XXXX-XXXX-XXXX-XXXX"
      >

      <button id="btnLogin">CONECTAR SERVIDOR</button>

      <div id="mwCloudError"></div>

      <div class="mw-cloud-help">
        El código se guarda solo en esta sesión del navegador.
      </div>
    </div>
  `;

  document.body.prepend(gate);

  $('loginPassword').addEventListener('input', event => {
    let value = event.target.value
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, '');

    if (
      !value ||
      (
        value === 'MW' &&
        String(event.inputType || '').startsWith('delete')
      )
    ) {
      event.target.value = '';
      return;
    }

    if (value === 'M') {
      event.target.value = 'M';
      return;
    }

    const raw = value.startsWith('MW')
      ? value.slice(2)
      : value;

    const groups = raw.match(/.{1,4}/g) || [];

    event.target.value =
      'MW-' + groups.slice(0, 4).join('-');
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
    $('loginPassword').value = connectionCode;
  }
}

function setCode(code) {
  connectionCode = String(code || '')
    .trim()
    .toUpperCase();

  if (connectionCode) {
    sessionStorage.setItem(CODE_KEY, connectionCode);
  } else {
    sessionStorage.removeItem(CODE_KEY);
  }
}

async function attemptLogin() {
  const input = $('loginPassword');
  const button = $('btnLogin');

  const code = String(input?.value || '')
    .trim()
    .toUpperCase();

  if (!CODE_RE.test(code)) {
    if ($('mwCloudError')) {
      $('mwCloudError').textContent =
        'Formato inválido. Usa MW-XXXX-XXXX-XXXX-XXXX.';
    }

    return;
  }

  button.disabled = true;

  if ($('mwCloudError')) {
    $('mwCloudError').textContent = 'Conectando...';
  }

  setCode(code);

  try {
    await connectCloud(true);

    if ($('mwCloudError')) {
      $('mwCloudError').textContent = '';
    }
  } catch (error) {
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

  if (!connectionCode || !CODE_RE.test(connectionCode)) {
    showLogin('Introduce un código de conexión.');

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
          token: connectionCode,
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

      finish(reject, new Error(message));
    });

    cloudSocket.on('cloud_ready', data => {
      setAgentOnline(Boolean(data?.agentOnline));
    });

    cloudSocket.on('agent_status', data => {
      setAgentOnline(Boolean(data?.online));
    });

    cloudSocket.on('status', setStatus);
    cloudSocket.on('log', appendLog);

    cloudSocket.on('history', logs => {
      const consoleEl = $('console');

      if (!consoleEl) return;

      consoleEl.innerHTML = '';

      (
        Array.isArray(logs)
          ? logs
          : []
      ).forEach(appendLog);
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

function rpcHttp(pathname, init = {}) {
  if (!cloudSocket?.connected) {
    return Promise.reject(
      new Error('MoonWolf Cloud no está conectado.')
    );
  }

  const id =
    `${Date.now()}-${++requestSequence}`;

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
  const contentType =
    result?.contentType || 'application/json';

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
    return;
  }

  agentOnline = nextState;
  updateAgentUi(nextState);

  if (nextState) {
    if (lastAgentActivityState !== true) {
      addActivity(
        'MoonWolf Agent conectado',
        'ok',
        '🟢'
      );
    }

    lastAgentActivityState = true;
  } else {
    if (lastAgentActivityState !== false) {
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
        online ? 'online' : 'offline';
    }
  }

  const textElements = [
    $('agentStatusText'),
    $('sbAgentStatusText'),
  ];

  for (const element of textElements) {
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

  const statusEl = $('sbStatus');

  if (statusEl) {
    statusEl.className =
      `sb-status ${status}`;
  }

  const statusText = $('sbStatusText');

  if (statusText) {
    statusText.textContent =
      STATUS_LABELS[status] ||
      String(status).toUpperCase();
  }

  const startButton = $('btnStart');

  if (startButton) {
    startButton.disabled =
      status !== 'offline' ||
      !agentOnline;
  }

  const stopButton = $('btnStop');

  if (stopButton) {
    stopButton.disabled =
      status !== 'online' ||
      !agentOnline;
  }

  const restartButton = $('btnRestart');

  if (restartButton) {
    restartButton.disabled =
      status !== 'online' ||
      !agentOnline;
  }

  const stats = $('statsGrid');

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

  const safePlayers =
    Number.isFinite(players) ? players : 0;

  const safeMaxPlayers =
    Number.isFinite(maxPlayers)
      ? maxPlayers
      : 0;

  const safeTps =
    Number.isFinite(tps) ? tps : 20;

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

    tpsEl.innerHTML =
      `${safeTps}<span class="stat-unit"> tps</span>`;
  }

  if ($('statUptime')) {
    $('statUptime').textContent =
      stats.uptime || '0h 0m';
  }

  if ($('statMemProc')) {
    $('statMemProc').innerHTML =
      `${safeProcessMemory}<span class="stat-unit"> MB</span>`;
  }

  const sys =
    stats.sysMemory || {
      used: 0,
      total: 0,
    };

  const used = Number(sys.used);
  const total = Number(sys.total);

  const safeUsed =
    Number.isFinite(used) ? used : 0;

  const safeTotal =
    Number.isFinite(total) ? total : 0;

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

  div.className =
    `log-line ${entry?.type || 'info'}`;

  div.innerHTML =
    `<span class="log-time">${escHtml(entry?.time || '--:--:--')}</span>` +
    `<span class="log-text">${escHtml(entry?.line || '')}</span>`;

  consoleEl.appendChild(div);

  if ($('setAutoScroll')?.checked !== false) {
    consoleEl.scrollTop =
      consoleEl.scrollHeight;
  }
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
    await api('/api/start', {
      method: 'POST',
    });

  if (!data.ok) {
    toast(
      data.error || 'Error al arrancar',
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
    await api('/api/stop', {
      method: 'POST',
    });

  if (!data.ok) {
    toast(
      data.error || 'Error al detener',
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
    await api('/api/restart', {
      method: 'POST',
    });

  if (!data.ok) {
    toast(
      data.error || 'Error al reiniciar',
      'err'
    );
  }
}

async function sendCmd() {
  const input = $('cmdInput');
  const cmd = input?.value.trim();

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
    await postJSON('/api/command', {
      cmd,
    });

  if (!data.ok) {
    toast(
      data.error || 'Error al enviar comando',
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

  const list = $('fileList');

  if (!list) return;

  list.innerHTML = `
    <div class="empty-state">
      <div
        class="empty-icon"
        style="display:inline-block;animation:spin 1s linear infinite"
      >⟳</div>
      <div class="empty-msg">Cargando...</div>
    </div>
  `;

  renderBreadcrumb(dir);

  api(`/api/files?dir=${encodeURIComponent(dir)}`)
    .then(data => {
      if (!data.ok) {
        throw new Error(
          data.error || 'No se pudo leer la carpeta.'
        );
      }

      const items =
        Array.isArray(data.items)
          ? data.items.slice()
          : [];

      items.sort(
        (a, b) =>
          (a.type === 'dir' ? -1 : 1) -
          (b.type === 'dir' ? -1 : 1) ||
          a.name.localeCompare(
            b.name,
            undefined,
            { sensitivity: 'base' }
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

      list.innerHTML = items
        .map(item => `
          <div
            class="file-row"
            data-name="${escHtml(item.name)}"
            data-type="${escHtml(item.type)}"
          >
            <span class="file-name" style="flex:1">
              ${fileIcon(item.type)}
              <span>${escHtml(item.name)}</span>
            </span>

            <span style="width:90px;text-align:right;color:var(--muted2)">
              ${escHtml(item.size)}
            </span>

            <span style="width:140px;text-align:right;color:var(--muted2)">
              ${escHtml(item.date)}
            </span>
          </div>
        `)
        .join('');

      list
        .querySelectorAll('.file-row')
        .forEach(row => {
          row.addEventListener('dblclick', () => {
            const name = row.dataset.name;
            const type = row.dataset.type;

            const rel =
              currentDir
                ? `${currentDir}/${name}`
                : name;

            if (type === 'dir') {
              populateFiles(rel);
            } else if (type !== 'jar') {
              openFile(rel);
            }
          });

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
          >⚠</div>
          <div class="empty-msg">
            ${escHtml(error.message)}
          </div>
        </div>
      `;
    });
}

function renderBreadcrumb(dir) {
  const trail = $('crumbTrail');

  if (!trail) return;

  const parts =
    dir
      ? dir.split('/').filter(Boolean)
      : [];

  let acc = '';

  trail.innerHTML = parts
    .map((part, index) => {
      acc +=
        (index ? '/' : '') + part;

      return `
        /
        <span
          class="crumb"
          data-path="${escHtml(acc)}"
        >
          ${escHtml(part)}
        </span>
      `;
    })
    .join('');

  trail
    .querySelectorAll('.crumb')
    .forEach(crumb => {
      crumb.addEventListener(
        'click',
        () => populateFiles(crumb.dataset.path)
      );
    });
}

function openFileContext(event, name, type) {
  event.preventDefault();

  document
    .querySelector('.ctx-menu')
    ?.remove();

  const rel =
    currentDir
      ? `${currentDir}/${name}`
      : name;

  const menu =
    document.createElement('div');

  menu.className = 'ctx-menu';

  menu.style.left =
    `${event.clientX}px`;

  menu.style.top =
    `${event.clientY}px`;

  menu.innerHTML = `
    ${
      type !== 'dir'
        ? '<div class="ctx-item" data-action="open">✏️ Abrir</div>'
        : ''
    }

    <div class="ctx-item" data-action="rename">
      ✏️ Renombrar
    </div>

    <div class="ctx-item" data-action="copy">
      📋 Copiar
    </div>

    <div class="ctx-item" data-action="move">
      📦 Mover
    </div>

    ${
      type !== 'dir'
        ? '<div class="ctx-item" data-action="download">⬇️ Descargar</div>'
        : ''
    }

    <div class="ctx-item" data-action="compress">
      🗜️ Comprimir (.zip)
    </div>

    <div class="ctx-sep"></div>

    <div class="ctx-item danger" data-action="delete">
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
            throw new Error(data.error);
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
            throw new Error(data.error);
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
            throw new Error(data.error);
          }
        }

        if (action === 'download') {
          return downloadFile(rel, name);
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
            throw new Error(data.error);
          }
        }

        if (action === 'delete') {
          if (!confirm(`¿Eliminar "${name}"?`)) {
            return;
          }

          const data =
            await postJSON(
              '/api/files/delete',
              {
                path: rel,
                isDir: type === 'dir',
              }
            );

          if (!data.ok) {
            throw new Error(data.error);
          }
        }

        toast(
          '✅ Operación completada',
          'ok'
        );

        populateFiles(currentDir);
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

async function downloadFile(rel, filename) {
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
  anchor.download = filename;
  anchor.click();

  setTimeout(
    () => URL.revokeObjectURL(url),
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
      throw new Error(data.error);
    }

    currentFile = rel;

    if ($('filesTablePanel')) {
      $('filesTablePanel').style.display =
        'none';
    }

    if ($('filesEditorPanel')) {
      $('filesEditorPanel').style.display =
        '';
    }

    if ($('editorFileName')) {
      $('editorFileName').innerHTML =
        `📄 ${escHtml(
          data.filename ||
          rel.split('/').pop()
        )}`;
    }

    if ($('edSaveMsg')) {
      $('edSaveMsg').textContent = '';
    }

    if (editor) {
      editor.toTextArea?.();
    }

    $('editorContainer').innerHTML =
      '<textarea id="mwEditorArea"></textarea>';

    const ext =
      String(
        rel.split('.').pop() || ''
      ).toLowerCase();

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
      editor =
        CodeMirror.fromTextArea(
          $('mwEditorArea'),
          {
            lineNumbers: true,
            mode,
            theme: 'dracula',
            lineWrapping: false,
            viewportMargin: Infinity,
          }
        );

      editor.setValue(
        data.content || ''
      );

      editor.on(
        'cursorActivity',
        updateEditorStatus
      );

      updateEditorStatus();
    } else {
      $('mwEditorArea').value =
        data.content || '';
    }
  } catch (error) {
    toast(
      `❌ ${error.message}`,
      'err'
    );
  }
}

function updateEditorStatus() {
  if (!editor) return;

  const cursor =
    editor.getCursor();

  if ($('edLine')) {
    $('edLine').textContent =
      cursor.line + 1;
  }

  if ($('edCol')) {
    $('edCol').textContent =
      cursor.ch + 1;
  }

  if ($('edLines')) {
    $('edLines').textContent =
      editor.lineCount();
  }
}

async function saveCurrentFile() {
  if (!currentFile) return;

  const content =
    editor
      ? editor.getValue()
      : $('mwEditorArea')?.value || '';

  const data =
    await postJSON(
      '/api/files/content',
      {
        path: currentFile,
        content,
      }
    );

  if (!data.ok) {
    toast(
      `❌ ${data.error}`,
      'err'
    );

    return;
  }

  if ($('edSaveMsg')) {
    $('edSaveMsg').textContent =
      'Guardado';
  }

  toast(
    '💾 Archivo guardado',
    'ok'
  );
}

/* PLUGINS */

async function pluginSearch() {
  const query =
    $('plgSearchInput')
      ?.value.trim();

  if (!query) return;

  $('plgResults').innerHTML = `
    <div class="empty-state">
      <div
        style="font-size:32px;animation:spin 1s linear infinite"
      >⟳</div>
      <div class="empty-msg">
        Buscando...
      </div>
    </div>
  `;

  try {
    const data =
      await api(
        `/api/plugins/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(pluginSource)}`
      );

    if (!data.ok) {
      throw new Error(data.error);
    }

    renderPluginResults(
      data.results || [],
      data.errors || []
    );
  } catch (error) {
    $('plgResults').innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">
          ${escHtml(error.message)}
        </div>
      </div>
    `;
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

  const warning =
    errors.length
      ? `
        <div class="plg-warn-bar">
          ⚠ ${errors.map(escHtml).join(' · ')}
        </div>
      `
      : '';

  $('plgResults').innerHTML =
    warning +
    results
      .map((plugin, index) => {
        const tag =
          plugin.source === 'modrinth'
            ? 'MODRINTH'
            : 'SPIGOT';

        const external =
          plugin.external
            ? '<span class="plg-src-badge">🔗 EXTERNO</span>'
            : '';

        const premium =
          plugin.premium
            ? '<span class="plg-src-badge">💰 PREMIUM</span>'
            : '';

        return `
          <div
            class="plg-card"
            data-index="${index}"
          >
            <div class="plg-card-top">
              ${
                plugin.icon
                  ? `
                    <img
                      class="plg-card-icon"
                      src="${escHtml(plugin.icon)}"
                      width="42"
                      height="42"
                      loading="lazy"
                    >
                  `
                  : `
                    <div class="plg-card-icon-placeholder">
                      🧩
                    </div>
                  `
              }

              <div class="plg-card-info">
                <div class="plg-card-name">
                  ${escHtml(plugin.name)}
                </div>

                <div class="plg-card-tags">
                  <span class="plg-src-badge">
                    ${tag}
                  </span>

                  ${premium}
                  ${external}

                  <span class="plg-src-badge dl">
                    ⬇ ${formatDownloads(plugin.downloads)}
                  </span>
                </div>
              </div>
            </div>

            <div class="plg-card-desc">
              ${escHtml(plugin.description || '')}
            </div>

            <div class="plg-card-footer">
              <span></span>
              <button class="plg-versions-btn">
                Ver versiones →
              </button>
            </div>
          </div>
        `;
      })
      .join('') ||
    `
      <div class="empty-state">
        <div class="empty-msg">
          Sin resultados
        </div>
      </div>
    `;

  $('plgResults')
    .querySelectorAll('.plg-card')
    .forEach(card => {
      card.addEventListener(
        'click',
        () =>
          openPluginVersions(
            results[
              Number(card.dataset.index)
            ]
          )
      );
    });
}

async function openPluginVersions(plugin) {
  currentPlugin = plugin;

  $('plgVersionModal').style.display = '';
  $('plgModalIcon').src =
    plugin.icon || '';

  $('plgModalName').textContent =
    plugin.name;

  $('plgModalMeta').textContent =
    `${plugin.source.toUpperCase()} · ${plugin.downloads || 0} descargas`;

  $('plgModalBody').innerHTML = `
    <div class="empty-state">
      <div
        style="animation:spin 1s linear infinite;font-size:28px"
      >⟳</div>
      <div class="empty-msg">
        Cargando versiones...
      </div>
    </div>
  `;

  try {
    const data =
      await api(
        `/api/plugins/versions?id=${encodeURIComponent(plugin.id)}&source=${encodeURIComponent(plugin.source)}`
      );

    if (!data.ok) {
      throw new Error(data.error);
    }

    $('plgModalBody').innerHTML =
      (data.versions || [])
        .map((version, index) => `
          <div class="plg-version-row">
            <div>
              <strong>
                ${escHtml(
                  version.versionNumber ||
                  version.name ||
                  'Versión'
                )}
              </strong>

              <div
                style="font-size:11px;color:var(--muted2)"
              >
                ${
                  version.published
                    ? new Date(
                        version.published
                      ).toLocaleString('es-ES')
                    : ''
                }
              </div>
            </div>

            ${
              version.isExternal
                ? `
                  <a
                    class="plg-install-btn"
                    href="${escHtml(version.externalUrl)}"
                    target="_blank"
                    rel="noopener"
                  >
                    ABRIR
                  </a>
                `
                : `
                  <button
                    class="plg-install-btn"
                    data-version="${index}"
                  >
                    INSTALAR
                  </button>
                `
            }
          </div>
        `)
        .join('') ||
      '<div class="empty-state">No hay versiones.</div>';

    $('plgModalBody')
      .querySelectorAll('[data-version]')
      .forEach(button => {
        button.addEventListener(
          'click',
          () =>
            installPlugin(
              data.versions[
                Number(
                  button.dataset.version
                )
              ]
            )
        );
      });
  } catch (error) {
    $('plgModalBody').innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">
          ${escHtml(error.message)}
        </div>
      </div>
    `;
  }
}

async function installPlugin(version) {
  const file =
    (version.files || [])
      .find(item => item.primary) ||
    version.files?.[0];

  if (!file?.url) {
    toast(
      'Esta versión requiere instalación externa.',
      'err'
    );

    return;
  }

  const filename =
    file.filename ||
    `${String(
      currentPlugin?.name || 'plugin'
    ).replace(
      /[^a-zA-Z0-9._-]/g,
      '_'
    )}.jar`;

  $('plgModalBody').insertAdjacentHTML(
    'afterbegin',
    '<div class="plg-warn-bar">⬇️ Instalando...</div>'
  );

  const data =
    await postJSON(
      '/api/plugins/install',
      {
        url: file.url,
        filename,
      }
    );

  if (!data.ok) {
    toast(
      `❌ ${data.error}`,
      'err'
    );

    return;
  }

  toast(
    `✅ ${filename} instalado`,
    'ok'
  );

  loadInstalledPlugins();
}

async function loadInstalledPlugins() {
  const element =
    $('plgInstalledList');

  if (!element) return;

  element.innerHTML = `
    <div class="empty-state">
      <div
        style="animation:spin 1s linear infinite;font-size:28px"
      >⟳</div>
      <div class="empty-msg">
        Cargando...
      </div>
    </div>
  `;

  const data =
    await api(
      '/api/plugins/installed'
    );

  if (!data.ok) {
    element.innerHTML = `
      <div class="empty-state">
        ${escHtml(data.error)}
      </div>
    `;

    return;
  }

  element.innerHTML =
    (data.plugins || [])
      .map(plugin => `
        <div class="installed-plugin-row">
          <div>
            <strong>
              ☕ ${escHtml(plugin.filename)}
            </strong>

            <div
              style="font-size:11px;color:var(--muted2)"
            >
              ${escHtml(plugin.size)}
              ·
              ${escHtml(plugin.modified)}
            </div>
          </div>

          <button
            class="small-btn danger"
            data-delete-plugin="${escHtml(plugin.filename)}"
          >
            Eliminar
          </button>
        </div>
      `)
      .join('') ||
    `
      <div class="empty-state">
        No hay plugins .jar instalados.
      </div>
    `;

  element
    .querySelectorAll('[data-delete-plugin]')
    .forEach(button => {
      button.addEventListener(
        'click',
        async () => {
          const filename =
            button.dataset.deletePlugin;

          if (!confirm(
            `¿Eliminar ${filename}?`
          )) {
            return;
          }

          const data =
            await api(
              `/api/plugins/installed/${encodeURIComponent(filename)}`,
              {
                method: 'DELETE',
              }
            );

          if (!data.ok) {
            toast(
              `❌ ${data.error}`,
              'err'
            );
          } else {
            loadInstalledPlugins();
          }
        }
      );
    });
}

/* MINECRAFT VERSIONS */

async function loadSoftware() {
  const data =
    await api(
      '/api/versions/software'
    );

  if (!data.ok) {
    throw new Error(data.error);
  }

  const list =
    data.software || [];

  const element =
    $('versionList');

  if (!element) return;

  element.innerHTML = `
    <div
      style="padding:8px 0 18px;color:var(--muted2)"
    >
      Selecciona un software para consultar
      sus versiones y builds.
    </div>

    <div
      style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px"
    >
      ${list.map(sw => `
        <button
          class="small-btn"
          data-software="${escHtml(sw.id)}"
        >
          ${escHtml(sw.label)}
        </button>
      `).join('')}
    </div>

    <div
      id="mwVersionDetails"
      style="margin-top:18px"
    ></div>
  `;

  element
    .querySelectorAll('[data-software]')
    .forEach(button => {
      button.addEventListener(
        'click',
        () =>
          selectSoftware(
            button.dataset.software,
            list.find(
              sw =>
                sw.id ===
                button.dataset.software
            )
          )
      );
    });

  const current =
    await api(
      '/api/versions/current'
    );

  if (current.ok) {
    $('mwVersionDetails')
      .insertAdjacentHTML(
        'afterbegin',
        `
          <div
            class="panel"
            style="margin-bottom:12px;padding:12px"
          >
            📦 server.jar:
            ${
              current.exists
                ? `✅ ${escHtml(current.size)} · ${escHtml(current.modified)}`
                : '❌ no encontrado'
            }
          </div>
        `
      );
  }
}

async function selectSoftware(id, meta) {
  versionState = {
    software: id,
    version: null,
    builds: [],
  };

  const details =
    $('mwVersionDetails');

  details.innerHTML = `
    <div
      class="panel"
      style="padding:12px"
    >
      <strong>
        ${escHtml(meta?.label || id)}
      </strong>

      <div style="margin-top:12px">
        Cargando versiones...
      </div>
    </div>
  `;

  const data =
    await api(
      `/api/versions/list?software=${encodeURIComponent(id)}`
    );

  if (!data.ok) {
    details.innerHTML = `
      <div class="empty-state">
        ${escHtml(data.error)}
      </div>
    `;

    return;
  }

  const versions =
    data.versions || [];

  details.innerHTML = `
    <div
      class="panel"
      style="padding:12px"
    >
      <strong>Versiones</strong>

      <input
        id="mwVersionSearch"
        class="cmd-input"
        style="margin-top:10px;width:100%"
        placeholder="Buscar versión..."
      >

      <div
        id="mwVersionPills"
        style="display:flex;flex-wrap:wrap;gap:7px;margin-top:12px"
      ></div>

      <div
        id="mwBuilds"
        style="margin-top:14px"
      ></div>
    </div>
  `;

  const renderVersions =
    list => {
      $('mwVersionPills').innerHTML =
        list
          .map(version => `
            <button
              class="small-btn"
              data-version="${escHtml(version)}"
            >
              ${escHtml(version)}
            </button>
          `)
          .join('');

      $('mwVersionPills')
        .querySelectorAll('[data-version]')
        .forEach(button => {
          button.addEventListener(
            'click',
            () =>
              selectVersion(
                button.dataset.version
              )
          );
        });
    };

  renderVersions(versions);

  $('mwVersionSearch')
    .addEventListener(
      'input',
      event => {
        const query =
          event.target.value
            .toLowerCase();

        renderVersions(
          query
            ? versions.filter(
                version =>
                  version
                    .toLowerCase()
                    .includes(query)
              )
            : versions
        );
      }
    );
}

async function selectVersion(version) {
  versionState.version =
    version;

  $('mwBuilds').innerHTML =
    '<div style="padding:8px">Cargando builds...</div>';

  const data =
    await api(
      `/api/versions/builds?software=${encodeURIComponent(versionState.software)}&version=${encodeURIComponent(version)}`
    );

  if (!data.ok) {
    $('mwBuilds').innerHTML = `
      <div class="empty-state">
        ${escHtml(data.error)}
      </div>
    `;

    return;
  }

  versionState.builds =
    data.builds || [];

  $('mwBuilds').innerHTML =
    versionState.builds
      .map((build, index) => `
        <div class="installed-plugin-row">
          <div>
            <strong>
              ${
                versionState.software === 'fabric'
                  ? `Loader ${escHtml(build.loaderVersion)}`
                  : `Build #${escHtml(build.build)}`
              }
            </strong>

            <div
              style="font-size:11px;color:var(--muted2)"
            >
              ${escHtml(build.channel || '')}
              ${
                build.time
                  ? ' · ' +
                    new Date(
                      build.time
                    ).toLocaleString('es-ES')
                  : ''
              }
            </div>
          </div>

          <button
            class="small-btn"
            data-build="${index}"
          >
            INSTALAR
          </button>
        </div>
      `)
      .join('') ||
    `
      <div class="empty-state">
        No hay builds disponibles.
      </div>
    `;

  $('mwBuilds')
    .querySelectorAll('[data-build]')
    .forEach(button => {
      button.addEventListener(
        'click',
        () =>
          installServerBuild(
            versionState.builds[
              Number(
                button.dataset.build
              )
            ]
          )
      );
    });
}

async function installServerBuild(build) {
  if (!confirm(
    `Actualizar server.jar a ${versionState.software} ${versionState.version}?`
  )) {
    return;
  }

  const data =
    await postJSON(
      '/api/versions/install',
      {
        software:
          versionState.software,
        version:
          versionState.version,
        build: build.build,
        url: build.url,
        loaderVersion:
          build.loaderVersion,
      }
    );

  if (!data.ok) {
    toast(
      `❌ ${data.error}`,
      'err'
    );
  } else {
    toast(
      `✅ ${
        data.note ||
        'server.jar actualizado'
      }`,
      'ok'
    );
  }
}

/* NAVIGATION */

function switchView(id) {
  document
    .querySelectorAll('.view')
    .forEach(view =>
      view.classList.remove('active')
    );

  document
    .querySelectorAll('.sb-item')
    .forEach(item =>
      item.classList.remove('active')
    );

  $(`view-${id}`)
    ?.classList.add('active');

  document
    .querySelector(
      `.sb-item[data-view="${id}"]`
    )
    ?.classList.add('active');

  switch (id) {
    case 'files':
      populateFiles(currentDir);
      break;

    case 'versions':
      loadSoftware()
        .catch(error =>
          toast(
            error.message,
            'err'
          )
        );
      break;

    case 'plugins':
      loadInstalledPlugins();
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

function addActivity(
  message,
  level = 'info',
  icon = '📌'
) {
  activities.push({
    message,
    level,
    icon,
    time:
      new Date().toLocaleTimeString(
        'es-ES'
      ),
  });

  if (activities.length > 200) {
    activities.shift();
  }

  if (
    $('view-activitylog')
      ?.classList.contains('active')
  ) {
    renderActivity();
  }
}

function renderActivity() {
  const element =
    $('activityList');

  if (!element) return;

  element.innerHTML =
    activities.length
      ? activities
          .slice()
          .reverse()
          .map(item => `
            <div class="activity-row">
              <span>
                ${escHtml(item.icon)}
              </span>

              <div>
                <strong>
                  ${escHtml(item.message)}
                </strong>

                <div
                  style="font-size:10px;color:var(--muted2)"
                >
                  ${escHtml(item.time)}
                </div>
              </div>
            </div>
          `)
          .join('')
      : `
        <div class="empty-state">
          No hay actividad todavía.
        </div>
      `;
}

/* SETTINGS */

function renderSettings() {
  const element =
    $('settingsList');

  if (!element) return;

  element.innerHTML = `
    <div class="settings-row">
      <div>
        <strong>MoonWolf Cloud</strong>
        <div
          style="font-size:11px;color:var(--muted2)"
        >
          WebSocket
        </div>
      </div>

      <span>
        ${
          agentOnline
            ? '🟢 Agent conectado'
            : '🔴 Agent desconectado'
        }
      </span>
    </div>

    <div class="settings-row">
      <div>
        <strong>Código de conexión</strong>
        <div
          style="font-size:11px;color:var(--muted2)"
        >
          Identificador de este servidor
        </div>
      </div>

      <code>
        ${escHtml(connectionCode || '—')}
      </code>
    </div>

    <div class="settings-row">
      <div>
        <strong>Conexión</strong>
        <div
          style="font-size:11px;color:var(--muted2)"
        >
          MoonWolf Cloud / Render WebSocket
        </div>
      </div>

      <span>
        ${
          cloudSocket?.connected
            ? '🟢 ONLINE'
            : '🔴 OFFLINE'
        }
      </span>
    </div>

    <div style="padding-top:12px">
      <button
        class="small-btn"
        id="btnDisconnectCloud"
      >
        Desconectar
      </button>
    </div>
  `;

  $('btnDisconnectCloud')
    ?.addEventListener(
      'click',
      () => {
        cloudSocket?.disconnect();

        setAgentOnline(false);

        currentStatus = 'offline';
        updateStatusUi('offline');

        setCode('');

        showLogin('Desconectado.');
      }
    );
}

/* TOAST */

function toast(
  message,
  type = 'info'
) {
  const element =
    $('toast');

  if (!element) return;

  element.textContent =
    message;

  element.className =
    `toast show ${type}`;

  clearTimeout(toast.timer);

  toast.timer =
    setTimeout(() => {
      element.className =
        'toast';
    }, 3000);
}

/* EVENTS */

function bindEvents() {
  ensureLoginGate();

  document
    .querySelectorAll('.sb-item')
    .forEach(item => {
      item.addEventListener(
        'click',
        () =>
          switchView(
            item.dataset.view
          )
      );
    });

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
        if (event.key === 'Enter') {
          sendCmd();
        }
      }
    );

  document
    .querySelectorAll('.quick-btn')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          const input =
            $('cmdInput');

          if (!input) return;

          input.value =
            button.dataset.cmd || '';

          sendCmd();
        }
      );
    });

  $('btnClearConsole')
    ?.addEventListener(
      'click',
      () => {
        if ($('console')) {
          $('console').innerHTML = '';
        }
      }
    );

  $('crumbHome')
    ?.addEventListener(
      'click',
      () => populateFiles('')
    );

  $('btnEditorBack')
    ?.addEventListener(
      'click',
      () => {
        if ($('filesEditorPanel')) {
          $('filesEditorPanel').style.display =
            'none';
        }

        if ($('filesTablePanel')) {
          $('filesTablePanel').style.display =
            '';
        }

        if (editor?.toTextArea) {
          editor.toTextArea();
        }

        editor = null;
        currentFile = null;
      }
    );

  $('btnSaveFile')
    ?.addEventListener(
      'click',
      saveCurrentFile
    );

  document.addEventListener(
    'keydown',
    event => {
      if (
        (event.ctrlKey ||
          event.metaKey) &&
        event.key.toLowerCase() === 's' &&
        currentFile
      ) {
        event.preventDefault();
        saveCurrentFile();
      }
    }
  );

  document
    .querySelectorAll('.plg-source')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          pluginSource =
            button.dataset.source;

          document
            .querySelectorAll(
              '.plg-source'
            )
            .forEach(item =>
              item.classList.toggle(
                'active',
                item === button
              )
            );
        }
      );
    });

  document
    .querySelectorAll('.plg-tab-btn')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          const tab =
            button.dataset.tab;

          document
            .querySelectorAll(
              '.plg-tab-btn'
            )
            .forEach(item =>
              item.classList.toggle(
                'active',
                item === button
              )
            );

          if ($('plgTabSearch')) {
            $('plgTabSearch').style.display =
              tab === 'search'
                ? ''
                : 'none';
          }

          if ($('plgTabInstalled')) {
            $('plgTabInstalled').style.display =
              tab === 'installed'
                ? ''
                : 'none';
          }

          if (tab === 'installed') {
            loadInstalledPlugins();
          }
        }
      );
    });

  $('btnPluginSearch')
    ?.addEventListener(
      'click',
      pluginSearch
    );

  $('plgSearchInput')
    ?.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Enter') {
          pluginSearch();
        }
      }
    );

  $('btnRefreshInstalled')
    ?.addEventListener(
      'click',
      loadInstalledPlugins
    );

  $('btnClosePlgModal')
    ?.addEventListener(
      'click',
      () => {
        if ($('plgVersionModal')) {
          $('plgVersionModal').style.display =
            'none';
        }
      }
    );

  $('plgVersionModal')
    ?.addEventListener(
      'click',
      event => {
        if (
          event.target ===
          $('plgVersionModal')
        ) {
          $('plgVersionModal').style.display =
            'none';
        }
      }
    );

  updateAgentUi(agentOnline);
  updateStatusUi(currentStatus);

  if (
    connectionCode &&
    CODE_RE.test(connectionCode)
  ) {
    connectCloud(false).catch(() =>
      showLogin('No se pudo conectar. Comprueba que el Agent esté ejecutándose.')
    );
  } else {
    showLogin('');
  }
}

/* START */

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    bindEvents,
    { once: true }
  );
} else {
  bindEvents();
}
