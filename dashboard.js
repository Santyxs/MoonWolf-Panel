'use strict';

/* ═══════════════════════ BACKEND ═══════════════════════ */
const API_URL = 'https://moonwolf.serveousercontent.com';

/* ═══════════════════════ SOCKET ═══════════════════════ */
const socket = io(API_URL);

let currentStatus = 'offline';
socket.on('status', setStatus);
socket.on('log', appendLog);
socket.on('history', logs => {
  document.getElementById('console').innerHTML = '';
  logs.forEach(appendLog);
});
socket.on('stats', updateStats);

/* ═══════════════════════ CONSTANTS ═══════════════════════ */
const STATUS_LABELS = {
  online: 'ONLINE', offline: 'OFFLINE',
  starting: 'STARTING...', restarting: 'RESTARTING...', stopping: 'STOPPING...'
};

const STATUS_ICONS = {
  online: '🟢', offline: '🔴', starting: '🟡', restarting: '🟡', stopping: '🟠'
};

const STATUS_LEVELS = {
  online: 'ok', offline: 'info', starting: 'info', restarting: 'warn', stopping: 'warn'
};

const STATUS_MESSAGES = {
  online: 'Server online', offline: 'Server offline',
  starting: 'Starting...', restarting: 'Restarting...', stopping: 'Stopping...'
};

const FILE_ICONS = { dir: '📁', jar: '☕', cfg: '⚙️', txt: '📄', log: '📋', file: '📄' };

const EXT_MODE = {
  yml: 'yaml', yaml: 'yaml', json: 'javascript', js: 'javascript',
  ts: 'javascript', xml: 'xml', html: 'xml', htm: 'xml',
  sh: 'shell', bat: 'shell', cmd: 'shell',
  properties: 'properties', cfg: 'properties', conf: 'properties', ini: 'properties',
};

const EXT_LABEL = {
  yml: 'YAML', yaml: 'YAML', json: 'JSON', js: 'JS', ts: 'TS',
  xml: 'XML', html: 'HTML', toml: 'TOML', sh: 'SHELL', bat: 'BAT',
  properties: 'PROPS', cfg: 'CONFIG', conf: 'CONFIG', ini: 'INI', txt: 'TEXT', log: 'LOG',
};

const VERSIONS = [
  { ver: '1.21.4', type: 'paper',   date: '2025-01-15', build: '#195',   current: true  },
  { ver: '1.21.4', type: 'vanilla', date: '2025-01-15', build: '—',      current: false },
  { ver: '1.21.3', type: 'paper',   date: '2024-11-20', build: '#188',   current: false },
  { ver: '1.21.3', type: 'fabric',  date: '2024-11-21', build: '0.16.9', current: false },
  { ver: '1.21.1', type: 'paper',   date: '2024-08-08', build: '#182',   current: false },
  { ver: '1.21.1', type: 'spigot',  date: '2024-08-10', build: '—',      current: false },
];

const USERS_DATA = {
  whitelist: [
    { name: 'MoonWolfHost', role: 'op',     last: '2h ago', av: '🐺' },
    { name: 'PlayerOne',    role: 'member', last: '1d ago', av: '⚔️' },
    { name: 'CreatorX',     role: 'member', last: '3d ago', av: '🏗️' },
    { name: 'NightHunter',  role: 'op',     last: 'Now',    av: '🏹' },
  ],
  ops: [
    { name: 'MoonWolfHost', role: 'op', last: '2h ago', av: '🐺' },
    { name: 'NightHunter',  role: 'op', last: 'Now',    av: '🏹' },
  ],
  bans: [],
};

const BACKUPS_DATA = [
  { name: 'backup_2025-07-13_18-00.tar.gz', date: 'Today 18:00',     size: '612 MB', auto: true  },
  { name: 'backup_2025-07-13_12-00.tar.gz', date: 'Today 12:00',     size: '608 MB', auto: true  },
  { name: 'backup_2025-07-12_18-00.tar.gz', date: 'Yesterday 18:00', size: '601 MB', auto: true  },
  { name: 'backup_manual_20250712.tar.gz',   date: 'Yesterday 10:22', size: '598 MB', auto: false },
];

/* ═══════════════════════ HELPERS ═══════════════════════ */
const $ = id => document.getElementById(id);
const escJS = str => String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const escAttr = str => str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
const escHtml = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function api(url, opts = {}) {
  const target = url.startsWith('http')
    ? url
    : `${API_URL}${url}`;

  const res = await fetch(target, opts);
  return res.json();
}

async function postJSON(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ═══════════════════════ STATUS ═══════════════════════ */
function setStatus(s) {
  currentStatus = s;
  $('sbStatus').className = 'sb-status ' + s;
  $('sbStatusText').textContent = STATUS_LABELS[s] ?? s.toUpperCase();
  $('btnStart').disabled   = s !== 'offline';
  $('btnStop').disabled    = s !== 'online';
  $('btnRestart').disabled = s !== 'online';

  const sg = $('statsGrid');
  sg.classList.toggle('hidden', s === 'offline');
  sg.classList.toggle('visible', s !== 'offline');

  addActivity(STATUS_MESSAGES[s] ?? s, STATUS_LEVELS[s] ?? 'info', STATUS_ICONS[s] ?? '📌');
}

/* ═══════════════════════ STATS ═══════════════════════ */
function updateStats(stats) {
  $('statPlayers').innerHTML = `${stats.players ?? 0}<span class="stat-unit">/${stats.maxPlayers ?? 0}</span>`;

  const tps = stats.tps ?? 20;
  const tpsEl = $('statTps');
  tpsEl.className = `stat-value ${tps < 15 ? 'tps-bad' : tps < 18 ? 'tps-warn' : 'tps-good'}`;
  tpsEl.innerHTML = `${tps}<span class="stat-unit"> tps</span>`;

  $('statUptime').textContent = stats.uptime ?? '0h 0m';
  $('statMemProc').innerHTML  = `${Number(stats.processMemory) || 0}<span class="stat-unit"> MB</span>`;

  const sys = stats.sysMemory || { used: 0, total: 0 };
  $('statMemSys').innerHTML = `${(Number(sys.used) || 0).toFixed(2)}/${(Number(sys.total) || 0).toFixed(2)}<span class="stat-unit"> GB</span>`;
  $('statCpu').innerHTML    = `${Number(stats.cpuUsage) || 0}<span class="stat-unit"> %</span>`;
}

/* ═══════════════════════ CONSOLE ═══════════════════════ */
function appendLog(entry) {
  const con = $('console');
  const div = document.createElement('div');
  div.className = 'log-line ' + (entry.type || 'info');
  div.innerHTML = `<span class="log-time">${escHtml(entry.time)}</span><span class="log-text">${escHtml(entry.line)}</span>`;
  con.appendChild(div);
  if ($('setAutoScroll')?.checked !== false) con.scrollTop = con.scrollHeight;
}

async function startServer()   { const d = await api('/api/start',   { method: 'POST' }); if (!d.ok) toast(d.error || 'Error', 'err'); }
async function stopServer()    { const d = await api('/api/stop',    { method: 'POST' }); if (!d.ok) toast(d.error || 'Error', 'err'); }
async function restartServer() {
  if (currentStatus === 'restarting' || currentStatus === 'stopping') return;
  const d = await api('/api/restart', { method: 'POST' });
  if (!d.ok) toast(d.error || 'Error', 'err');
}

async function sendCmd() {
  const input = $('cmdInput');
  const cmd   = input.value.trim();
  if (!cmd) return;
  input.value = '';
  if (currentStatus !== 'online') { toast('Server is not online', 'err'); return; }
  const d = await postJSON('/api/command', { cmd });
  if (!d.ok) toast(d.error || 'Error', 'err');
}

/* ═══════════════════════ NAVIGATION ═══════════════════════ */
const viewInitialized = new Set();

function switchView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  $('view-' + id)?.classList.add('active');
  document.querySelector(`.sb-item[data-view="${id}"]`)?.classList.add('active');

  if (id === 'files') { populateFiles(''); return; }

  if (!viewInitialized.has(id)) {
    viewInitialized.add(id);
    const init = {
      plugins:     () => { /* búsqueda bajo demanda */ },
      versions:    () => initVersions(),
      users:       () => populateUsers('whitelist'),
      backups:     () => populateBackups(),
      startup:     () => updateStartupPreview(),
      activitylog: () => renderActivity(),
    };
    init[id]?.();
  }
}

/* ═══════════════════════ FILE MANAGER ═══════════════════════ */
let currentDir = '';

function populateFiles(dir) {
  currentDir = dir;
  const el = $('fileList');
  el.innerHTML = '<div class="empty-state"><div class="empty-icon" style="display:inline-block;animation:spin 1s linear infinite">⟳</div><div class="empty-msg">Cargando...</div></div>';

  const parts = dir ? dir.replace(/\\/g, '/').split('/').filter(Boolean) : [];
  const trail = $('crumbTrail');
  if (trail) {
    let pathAcc = '';
    trail.innerHTML = parts.map((part, i) => {
      pathAcc += (i === 0 ? '' : '/') + part;
      return ` / <span class="crumb" data-path="${escAttr(pathAcc)}">${escHtml(part)}</span>`;
    }).join('');
  }

  api(`/api/files?dir=${encodeURIComponent(dir)}`)
    .then(data => {
      if (!data.ok) { 
        toast(data.error || 'Error al leer la carpeta', 'err'); 
        el.innerHTML = ''; 
        return; 
      }
      if (!data.items.length) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><div class="empty-msg">Carpeta vacía</div></div>';
        return;
      }

      data.items.sort((a, b) => {
        const aIsDir = a.type === 'dir';
        const bIsDir = b.type === 'dir';

        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;

        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      el.innerHTML = data.items.map(f =>
        `<div class="file-row" data-name="${escAttr(f.name)}" data-type="${f.type}">
        <span class="file-icon">${FILE_ICONS[f.type] || '📄'}</span>
        <span class="file-name">${escHtml(f.name)}</span>
        <span class="file-size">${escHtml(f.size)}</span>
        <span class="file-date">${escHtml(f.date)}</span>
        <button class="file-menu-btn" data-name="${escAttr(f.name)}" data-type="${f.type}" title="Opciones">⋮</button>
        </div>`
      ).join('');
    })
    .catch(() => toast('Sin conexión al backend', 'err'));
}

/* ═══════════════════════ CODEMIRROR EDITOR ═══════════════════════ */
let cmEditor = null;
let currentEditPath = '';

function closeEditor() {
  if (cmEditor) {
    cmEditor.toTextArea();
    cmEditor = null;
  }
  currentEditPath = '';
  $('filesEditorPanel').style.display = 'none';
  $('filesTablePanel').style.display  = 'flex';
}

function openFsItem(name, type) {
  if (type === 'dir') { populateFiles(currentDir ? `${currentDir}/${name}` : name); return; }

  const rel = currentDir ? `${currentDir}/${name}` : name;
  currentEditPath = rel;

  api(`/api/files/content?path=${encodeURIComponent(rel)}`)
    .then(data => {
      if (!data.ok) { toast(data.error || 'Error al leer el archivo', 'err'); return; }

      const ext   = data.filename.split('.').pop().toLowerCase();
      const mode  = EXT_MODE[ext] || null;
      const label = EXT_LABEL[ext] || ext.toUpperCase() || 'TEXT';

      $('editorFileName').innerHTML =
        `<span style="color:var(--text)">📄 ${escHtml(data.filename)}</span>
         <span style="font-size:9px;padding:2px 8px;border-radius:999px;
           background:var(--accentDim);border:1px solid rgba(0,200,255,0.3);
           color:var(--accent);letter-spacing:1px">${label}</span>`;
      $('edSaveMsg').textContent = '';

      const container = $('editorContainer');
      if (cmEditor) { cmEditor.toTextArea(); cmEditor = null; }
      container.innerHTML = '<textarea id="cmTA"></textarea>';

      cmEditor = CodeMirror.fromTextArea($('cmTA'), {
        mode:             mode || 'text/plain',
        theme:            'dracula',
        lineNumbers:      true,
        matchBrackets:    true,
        autoCloseBrackets: true,
        styleActiveLine:  true,
        indentUnit:       2,
        tabSize:          2,
        indentWithTabs:   false,
        lineWrapping:     false,
        extraKeys:        { 'Ctrl-S': saveFile, 'Cmd-S': saveFile },
      });
      cmEditor.setValue(data.content);

      cmEditor.on('cursorActivity', () => {
        const cur = cmEditor.getCursor();
        $('edLine').textContent  = cur.line + 1;
        $('edCol').textContent   = cur.ch + 1;
        $('edLines').textContent = cmEditor.lineCount();
      });
      $('edLine').textContent  = 1;
      $('edCol').textContent   = 1;
      $('edLines').textContent = cmEditor.lineCount();

      $('filesTablePanel').style.display  = 'none';
      $('filesEditorPanel').style.display = 'flex';
      setTimeout(() => { cmEditor.refresh(); cmEditor.focus(); }, 80);
    })
    .catch(() => toast('Error de conexión', 'err'));
}

async function saveFile() {
  if (!currentEditPath || !cmEditor) return;
  const msgEl = $('edSaveMsg');
  try {
    const data = await postJSON('/api/files/content', { path: currentEditPath, content: cmEditor.getValue() });
    if (data.ok) {
      msgEl.textContent = '✅ Saved';
      msgEl.style.color = 'var(--green)';
      populateFiles(currentDir);
    } else {
      msgEl.textContent = '❌ ' + (data.error || 'Error');
      msgEl.style.color = 'var(--red)';
    }
  } catch {
    msgEl.textContent = '❌ No connection';
    msgEl.style.color = 'var(--red)';
  }
  msgEl.classList.add('show');
  setTimeout(() => msgEl.classList.remove('show'), 2500);
}
/* ═══════════════════════ FILE CONTEXT MENU ═══════════════════════ */
let ctxMenu = null;

function closeCtxMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

function openCtxMenu(e, name, type) {
  e.stopPropagation();
  closeCtxMenu();

  const isDir = type === 'dir';
  const rel   = currentDir ? `${currentDir}/${name}` : name;

  const menu = document.createElement('div');
  menu.className = 'file-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">✏️ Renombrar</div>
    <div class="ctx-item" data-action="copy">📋 Copiar</div>
    <div class="ctx-item" data-action="move">📂 Mover</div>
    ${!isDir ? `<div class="ctx-item" data-action="download">⬇️ Descargar</div>` : ''}
    <div class="ctx-item" data-action="compress">🗜️ Comprimir (.zip)</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">🗑️ Eliminar</div>
  `;

  const rect = e.target.getBoundingClientRect();
  menu.style.top  = rect.bottom + window.scrollY + 4 + 'px';
  menu.style.left = rect.left   + window.scrollX - 160 + 'px';
  document.body.appendChild(menu);
  ctxMenu = menu;

  menu.addEventListener('click', async ev => {
    const action = ev.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    closeCtxMenu();

    if (action === 'rename') {
      const newName = prompt(`Nuevo nombre para "${name}":`, name);
      if (!newName || newName === name) return;
      const d = await postJSON('/api/files/rename', { path: rel, newName });
      d.ok ? (toast(`✅ Renombrado a ${newName}`, 'ok'), populateFiles(currentDir))
           : toast('❌ ' + d.error, 'err');
    }

    if (action === 'copy') {
      const dest = prompt(`Copiar "${name}" a (ruta relativa destino):`, currentDir || '');
      if (dest === null) return;
      const d = await postJSON('/api/files/copy', { path: rel, dest: dest ? `${dest}/${name}` : name });
      d.ok ? (toast(`✅ Copiado`, 'ok'), populateFiles(currentDir))
           : toast('❌ ' + d.error, 'err');
    }

    if (action === 'move') {
      const dest = prompt(`Mover "${name}" a carpeta (ruta relativa):`, currentDir || '');
      if (dest === null) return;
      const d = await postJSON('/api/files/move', { path: rel, dest: dest ? `${dest}/${name}` : name });
      d.ok ? (toast(`✅ Movido`, 'ok'), populateFiles(currentDir))
           : toast('❌ ' + d.error, 'err');
    }

    if (action === 'download') {
      window.location.href = `${API_URL}/api/files/download?path=${encodeURIComponent(rel)}`;
    }

    if (action === 'compress') {
      toast(`🗜️ Comprimiendo ${name}...`, 'ok');
      const d = await postJSON('/api/files/compress', { path: rel, name });
      d.ok ? (toast(`✅ Creado ${d.zipName}`, 'ok'), populateFiles(currentDir))
           : toast('❌ ' + d.error, 'err');
    }

    if (action === 'delete') {
      if (!confirm(`¿Eliminar "${name}"?${isDir ? '\n⚠ Se eliminará la carpeta y todo su contenido.' : ''}`)) return;
      const d = await postJSON('/api/files/delete', { path: rel, isDir });
      d.ok ? (toast(`🗑️ Eliminado`, 'ok'), populateFiles(currentDir))
           : toast('❌ ' + d.error, 'err');
    }
  });

  setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
}

/* ═══════════════════════════════════════════════════════════════
   PLUGINS — Sistema completo (Modrinth + Spigot)
   ═══════════════════════════════════════════════════════════════ */
const PLG = { source: 'all', currentPlugin: null, installing: new Set() };

function pluginSwitchTab(tab) {
  document.querySelectorAll('.plg-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('plgTabSearch').style.display    = tab === 'search'    ? '' : 'none';
  $('plgTabInstalled').style.display = tab === 'installed' ? '' : 'none';
  if (tab === 'installed') loadInstalledPlugins();
}

function pluginSetSource(src) {
  PLG.source = src;
  document.querySelectorAll('.plg-source').forEach(b => b.classList.toggle('active', b.dataset.source === src));
}

async function pluginSearch() {
  const q       = $('plgSearchInput').value.trim();
  const results = $('plgResults');
  if (!q) return;

  results.innerHTML = '<div class="empty-state"><div style="font-size:32px;opacity:.35;animation:spin 1s linear infinite">⟳</div><div class="empty-msg">Buscando...</div></div>';

  try {
    const data = await api(`/api/plugins/search?q=${encodeURIComponent(q)}&source=${PLG.source}`);
    if (!data.ok) { results.innerHTML = plgError(data.error); return; }
    if (!data.results.length) { results.innerHTML = '<div class="empty-state">Sin resultados</div>'; return; }
    renderPluginResults(data.results, data.errors || []);
  } catch (e) {
    results.innerHTML = plgError('Sin conexión con el backend: ' + e.message);
  }
}

function renderPluginResults(plugins, errors) {
  const results = $('plgResults');
  const errHtml = errors.length ? `<div class="plg-warn-bar">⚠ ${errors.join(' · ')}</div>` : '';
  const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0);

  const cards = plugins.map(p => {
    const srcBadge = p.source === 'modrinth'
      ? `<span class="plg-src-badge modrinth">MODRINTH</span>`
      : `<span class="plg-src-badge spigot">SPIGOT</span>`;
    const lockBadge = p.premium
      ? `<span class="plg-src-badge" style="background:rgba(255,180,0,.18);color:#ffb400">💰 PREMIUM</span>`
      : p.external
      ? `<span class="plg-src-badge" style="background:rgba(255,255,255,.1);color:var(--muted2)">🔗 EXTERNO</span>`
      : '';
    const gvShort   = (p.gameVersions || []).slice(-3).reverse().join(', ');
    const pluginAttr = encodeURIComponent(JSON.stringify(p));

    return `<div class="plg-card" data-plugin="${pluginAttr}">
      <div class="plg-card-top">
        ${p.icon
          ? `<img class="plg-card-icon" src="${p.icon}" width="42" height="42" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="plg-card-icon-placeholder">🧩</div>`}
        <div class="plg-card-info">
          <div class="plg-card-name">${escHtml(p.name)}</div>
          <div class="plg-card-tags">
            ${srcBadge}
            ${lockBadge}
            <span class="plg-src-badge dl">⬇ ${fmt(p.downloads)}</span>
            ${gvShort ? `<span class="plg-src-badge mc">MC ${escHtml(gvShort)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="plg-card-desc">${escHtml((p.description || '').slice(0, 120))}${(p.description || '').length > 120 ? '…' : ''}</div>
      <div class="plg-card-footer">
        <span style="font-size:10px;color:var(--muted2)">${escHtml((p.categories || []).slice(0, 3).join(' · '))}</span>
        <button class="plg-versions-btn">Ver versiones →</button>
      </div>
    </div>`;
  }).join('');

  results.innerHTML = errHtml + '<div class="plg-grid">' + cards + '</div>';
}

function plgError(msg) {
  return `<div class="empty-state"><div class="empty-icon" style="color:var(--red)">⚠</div><div class="empty-msg">${msg}</div></div>`;
}

/* ── MODAL VERSIONES ── */
async function openVersionModal(plugin) {
  PLG.currentPlugin = plugin;
  const modal = $('plgVersionModal');
  modal.style.display = 'flex';

  $('plgModalName').textContent = plugin.name;
  $('plgModalMeta').textContent = `${plugin.source === 'modrinth' ? 'Modrinth' : 'Spigot'} · ${Number(plugin.downloads || 0).toLocaleString()} descargas`;

  const iconEl = $('plgModalIcon');
  if (plugin.icon) { iconEl.src = plugin.icon; iconEl.style.display = ''; }
  else iconEl.style.display = 'none';

  $('plgModalBody').innerHTML = '<div class="empty-state"><div style="font-size:32px;opacity:.35;animation:spin 1s linear infinite">⟳</div><div class="empty-msg" style="margin-top:8px">Cargando versiones...</div></div>';

  try {
    const data = await api(`/api/plugins/versions?id=${encodeURIComponent(plugin.id)}&source=${plugin.source}`);
    if (!data.ok) { $('plgModalBody').innerHTML = plgError(data.error); return; }
    renderVersionList(data.versions, plugin, data.isExternal);
  } catch (e) {
    $('plgModalBody').innerHTML = plgError('Error: ' + e.message);
  }
}

function closePlgModal() {
  $('plgVersionModal').style.display = 'none';
  PLG.currentPlugin = null;
}

function renderVersionList(versions, plugin, isExternal) {
  if (!versions?.length) {
    $('plgModalBody').innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-msg">Sin versiones disponibles</div></div>';
    return;
  }
  const headerLeft = isExternal
    ? `<span style="color:var(--muted2);font-size:11px">SpigotMC no ofrece descarga directa</span>`
    : `<span style="color:var(--muted2);font-size:11px">${versions.length} versión${versions.length !== 1 ? 'es' : ''}</span>`;
  $('plgModalBody').innerHTML = `
    <div class="plg-ver-header">
      ${headerLeft}
      <span style="color:var(--muted2);font-size:11px">Se guarda en <code style="color:var(--accent);background:var(--accentDim);padding:1px 6px;border-radius:4px">plugins/</code></span>
    </div>
    <div class="plg-ver-list">${versions.map(v => renderVersionRow(v, plugin, isExternal)).join('')}</div>`;
}

function renderVersionRow(v, plugin, isExternal) {
  const btnId     = `ver_${v.versionId}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const gvShort   = (v.gameVersions || []).slice(-4).reverse().join(', ') || '—';
  const loaders   = (v.loaders || []).map(l => l.toUpperCase()).join(' · ') || '—';
  const published = v.published ? new Date(v.published).toLocaleDateString('es-ES') : '—';
  const primary   = v.files?.find(f => f.primary) || v.files?.[0];
  const sizeKb    = primary?.size ? Math.round(primary.size / 1024) + ' KB' : '';

  let dlButton;
  if (isExternal || v.isExternal) {
    const url = v.externalUrl || `https://www.spigotmc.org/resources/${plugin.id}/`;
    dlButton = `<a href="${url}" target="_blank" rel="noopener" class="plg-dl-btn external">🔗 Ver en SpigotMC</a>`;
  } else if (!primary) {
    dlButton = `<span class="plg-dl-btn disabled">Sin archivo</span>`;
  } else {
    dlButton = `<button id="${btnId}" class="plg-dl-btn"
      data-url="${escAttr(primary.url)}"
      data-filename="${escAttr(primary.filename)}"
      data-source="${escAttr(plugin.source)}"
      data-rid="${escAttr(String(plugin.id))}"
      data-vid="${escAttr(String(v.versionId))}">⬇ INSTALAR</button>`;
  }

  const changelogHtml = v.changelog
    ? `<div class="plg-ver-changelog">${escHtml(v.changelog).replace(/\n/g, '<br>')}</div>`
    : '';

  return `<div class="plg-ver-row">
    <div class="plg-ver-left">
      <div class="plg-ver-number">${escHtml(v.versionNumber)}</div>
      ${v.name && v.name !== v.versionNumber ? `<div class="plg-ver-name">${escHtml(v.name)}</div>` : ''}
      ${changelogHtml}
    </div>
    <div class="plg-ver-right">
      <div class="plg-ver-meta">
        <span class="plg-vm">🎮 ${escHtml(gvShort)}</span>
        <span class="plg-vm">⚙ ${escHtml(loaders)}</span>
        <span class="plg-vm">${published}</span>
        ${sizeKb ? `<span class="plg-vm">📦 ${sizeKb}</span>` : ''}
        ${v.downloads ? `<span class="plg-vm">⬇ ${Number(v.downloads).toLocaleString()}</span>` : ''}
      </div>
      ${dlButton}
    </div>
  </div>`;
}

async function installPlugin(btnId, url, filename, source, resourceId, versionId) {
  if (PLG.installing.has(btnId)) return;
  PLG.installing.add(btnId);
  const btn = $(btnId);
  if (btn) { btn.textContent = '⏳ Descargando...'; btn.disabled = true; btn.classList.add('loading'); }
  toast(`⬇ Descargando ${filename}...`, 'ok');

  try {
    const data = await postJSON('/api/plugins/install', { url, filename, source, resourceId, versionId });
    if (data.ok) {
      if (btn) { btn.textContent = '✓ Instalado'; btn.classList.replace('loading', 'done'); }
      toast(`✅ ${data.filename} instalado (${data.size})`, 'ok');
      addActivity(`Plugin instalado: ${data.filename}`, 'ok', '🧩');
    } else {
      if (btn) { btn.textContent = '❌ Error'; btn.classList.replace('loading', 'err'); }
      toast('❌ ' + (data.error || 'Error desconocido'), 'err');
    }
  } catch (e) {
    if (btn) { btn.textContent = '❌ Sin conexión'; btn.classList.remove('loading'); }
    toast('❌ ' + e.message, 'err');
  }
  PLG.installing.delete(btnId);
}

async function loadInstalledPlugins() {
  const el = $('plgInstalledList');
  el.innerHTML = '<div class="empty-state"><div style="font-size:32px;opacity:.35;animation:spin 1s linear infinite">⟳</div><div class="empty-msg" style="margin-top:8px">Cargando...</div></div>';
  try {
    const data = await api('/api/plugins/installed');
    if (!data.ok || !data.plugins.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><div class="empty-msg">No hay plugins instalados<br><span style="font-size:10px;color:var(--muted)">Busca un plugin y pulsa INSTALAR</span></div></div>';
      return;
    }
    el.innerHTML = data.plugins.map(p =>
      `<div class="plg-inst-row">
        <span class="plg-inst-icon">☕</span>
        <div class="plg-inst-info">
          <div class="plg-inst-name">${escHtml(p.filename)}</div>
          <div class="plg-inst-meta">${escHtml(p.size)} · Modificado ${escHtml(p.modified)}</div>
        </div>
        <button class="icon-btn" title="Eliminar" data-delete="${escAttr(p.filename)}">✕</button>
      </div>`
    ).join('');
  } catch (e) {
    el.innerHTML = plgError('Error: ' + e.message);
  }
}

async function deletePlugin(filename, btn) {
  if (!confirm(`¿Eliminar ${filename}?`)) return;
  btn.disabled = true;
  try {
    const data = await api(`/api/plugins/installed/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (data.ok) { toast(`🗑 ${filename} eliminado`, 'ok'); loadInstalledPlugins(); }
    else { toast('❌ ' + data.error, 'err'); btn.disabled = false; }
  } catch (e) {
    toast('❌ ' + e.message, 'err');
    btn.disabled = false;
  }
}

/* ═══════════════════════ VERSIONS ═══════════════════════ */

const VER = {
  software:  null,   // software seleccionado
  version:   null,   // versión MC seleccionada
  builds:    [],     // builds cargados
  isFabric:  false,
  installing: false,
};

/* ── Inicializar vista de versiones ── */
async function initVersions() {
  renderVersionsShell();
  loadCurrentJar();
  loadSoftwareList();
}

/* ── Estructura base del panel ── */
function renderVersionsShell() {
  const view = $('view-versions');
  view.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">VERSIONES MC</div>
        <div class="page-sub">Descarga e instala cualquier software de servidor</div>
      </div>
      <div class="ver-current-badge" id="verCurrentBadge">
        <span class="vcb-dot"></span>
        <span id="verCurrentText">Cargando server.jar...</span>
      </div>
    </div>

    <!-- PASO 1: Software -->
    <div class="ver-step">
      <div class="ver-step-label">① Software</div>
      <div class="ver-sw-grid" id="verSwGrid">
        <div class="ver-loading">⟳ Cargando...</div>
      </div>
    </div>

    <!-- PASO 2: Versión MC -->
    <div class="ver-step" id="verStepVersion" style="display:none">
      <div class="ver-step-label">② Versión de Minecraft</div>
      <div class="ver-version-bar">
        <input class="ver-search-input" id="verVersionSearch" type="text" placeholder="Filtrar versión... (ej: 1.21)">
        <div class="ver-version-grid" id="verVersionGrid"></div>
      </div>
    </div>

    <!-- PASO 3: Build -->
    <div class="ver-step" id="verStepBuilds" style="display:none">
      <div class="ver-step-label">③ Build</div>
      <div class="panel" id="verBuildsPanel">
        <div class="panel-header">
          <div class="panel-title" id="verBuildsPanelTitle"><span>📦</span> BUILDS</div>
          <div style="display:flex;gap:8px;align-items:center">
            <label class="ver-toggle-label">
              <input type="checkbox" id="verShowAll"> Solo estables
            </label>
          </div>
        </div>
        <div id="verBuildsList"></div>
      </div>
    </div>

    <!-- MODAL instalación -->
    <div id="verInstallModal" class="plg-modal-overlay" style="display:none">
      <div class="plg-modal" style="max-width:560px">
        <div class="plg-modal-header">
          <div class="plg-modal-title" id="verModalTitle">Instalando...</div>
          <button class="plg-modal-close" id="btnCloseVerModal">✕</button>
        </div>
        <div id="verModalBody" class="plg-modal-body" style="padding:24px"></div>
      </div>
    </div>
  `;

  // Eventos locales
  $('verVersionSearch').addEventListener('input', filterVersionList);
  $('verShowAll').addEventListener('change', () => renderBuildsList(VER.builds));
  $('btnCloseVerModal').addEventListener('click', () => $('verInstallModal').style.display = 'none');
  $('verInstallModal').addEventListener('click', e => { if (e.target === $('verInstallModal')) $('verInstallModal').style.display = 'none'; });
}

/* ── server.jar actual ── */
async function loadCurrentJar() {
  try {
    const d   = await api('/api/versions/current');
    const el  = $('verCurrentText');
    const dot = document.querySelector('.vcb-dot');
    if (d.exists) {
      el.textContent = `server.jar · ${d.size} · mod. ${d.modified}`;
      dot.style.background = 'var(--green)';
      dot.style.boxShadow  = '0 0 6px var(--green)';
    } else {
      el.textContent = 'Sin server.jar';
      dot.style.background = 'var(--red)';
    }
  } catch { /* silencioso */ }
}

/* ── PASO 1: Lista de softwares ── */
async function loadSoftwareList() {
  const grid = $('verSwGrid');
  try {
    const d = await api('/api/versions/software');
    renderSoftwareGrid(d.software);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon" style="color:var(--red)">⚠</div><div class="empty-msg">${e.message}</div></div>`;
  }
}

const SW_ICONS = {
  paper: '📄', purpur: '🟣', folia: '🌿', fabric: '🧵', vanilla: '🎮', forge: '⚒️', velocity: '⚡', waterfall: '💧', bungeecord: '🔗',
};

function renderSoftwareGrid(list) {
  const categories = { server: list.filter(s => s.category === 'server'), proxy: list.filter(s => s.category === 'proxy') };
  let html = '';

  for (const [cat, items] of Object.entries(categories)) {
    html += `<div class="ver-sw-category"><div class="ver-sw-cat-label">${cat === 'server' ? '🖥️ Servidores' : '🔀 Proxies'}</div><div class="ver-sw-row">`;
    html += items.map(s => `
      <div class="ver-sw-card ${s.external ? 'ver-sw-external' : ''}" data-sw="${s.id}" style="--sw-color:${s.color}">
        <div class="ver-sw-icon">${SW_ICONS[s.id] || '📦'}</div>
        <div class="ver-sw-name">${s.label}</div>
        <div class="ver-sw-desc">${s.desc}</div>
        ${s.external ? `<a class="ver-ext-link" href="${s.external}" target="_blank" rel="noopener">Descargar →</a>` : ''}
      </div>`).join('');
    html += '</div></div>';
  }
  $('verSwGrid').innerHTML = html;

  $('verSwGrid').addEventListener('click', e => {
    const card = e.target.closest('.ver-sw-card:not(.ver-sw-external)');
    if (!card) return;
    selectSoftware(card.dataset.sw);
  });
}

/* ── Seleccionar software ── */
async function selectSoftware(swId) {
  VER.software = swId;
  VER.version  = null;

  document.querySelectorAll('.ver-sw-card').forEach(c => c.classList.toggle('active', c.dataset.sw === swId));

  const stepVer = $('verStepVersion');
  const grid    = $('verVersionGrid');
  stepVer.style.display = '';
  $('verStepBuilds').style.display = 'none';
  grid.innerHTML = '<div class="ver-loading" style="animation:spin 1s linear infinite;font-size:24px;padding:20px">⟳</div>';
  $('verVersionSearch').value = '';

  // Scroll suave al paso 2
  stepVer.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const d = await api(`/api/versions/list?software=${swId}`);
    if (!d.ok) throw new Error(d.error);
    renderVersionGrid(d.versions);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon" style="color:var(--red)">⚠</div><div class="empty-msg">${e.message}</div></div>`;
  }
}

/* ── PASO 2: Grid de versiones ── */
let _allVersions = [];

function renderVersionGrid(versions) {
  _allVersions = versions;
  _renderVersionPills(versions);
}

function _renderVersionPills(list) {
  if (!list.length) {
    $('verVersionGrid').innerHTML = '<div class="empty-state"><div class="empty-msg">Sin versiones disponibles</div></div>';
    return;
  }
  $('verVersionGrid').innerHTML = list.map(v =>
    `<button class="ver-pill ${VER.version === v ? 'active' : ''}" data-ver="${v}">${v}</button>`
  ).join('');

  $('verVersionGrid').onclick = e => {
    const pill = e.target.closest('.ver-pill');
    if (pill) selectVersion(pill.dataset.ver);
  };
}

function filterVersionList() {
  const q      = $('verVersionSearch').value.toLowerCase();
  const filtered = q ? _allVersions.filter(v => v.includes(q)) : _allVersions;
  _renderVersionPills(filtered);
}

/* ── Seleccionar versión ── */
async function selectVersion(ver) {
  VER.version = ver;
  document.querySelectorAll('.ver-pill').forEach(p => p.classList.toggle('active', p.dataset.ver === ver));

  const stepBuilds = $('verStepBuilds');
  const list       = $('verBuildsList');
  stepBuilds.style.display = '';
  list.innerHTML = '<div class="ver-loading" style="animation:spin 1s linear infinite;font-size:24px;padding:20px;text-align:center">⟳</div>';
  $('verBuildsPanelTitle').innerHTML = `<span>📦</span> BUILDS — <span style="color:var(--accent)">${VER.software?.toUpperCase()} ${ver}</span>`;

  stepBuilds.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const d = await api(`/api/versions/builds?software=${VER.software}&version=${encodeURIComponent(ver)}`);
    if (!d.ok) throw new Error(d.error);
    VER.builds   = d.builds || [];
    VER.isFabric = !!d.isFabric;
    renderBuildsList(VER.builds);
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon" style="color:var(--red)">⚠</div><div class="empty-msg">${e.message}</div></div>`;
  }
}

/* ── PASO 3: Lista de builds ── */
function renderBuildsList(builds) {
  const el        = $('verBuildsList');
  const stableOnly = $('verShowAll').checked;
  const list      = stableOnly ? builds.filter(b => b.channel === 'STABLE') : builds;

  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-msg">No hay builds disponibles</div></div>';
    return;
  }

  el.innerHTML = list.map((b, i) => {
    const isLatest  = i === 0;
    const isStable  = b.channel === 'STABLE';
    const channelBadge = isStable
      ? `<span class="ver-channel stable">STABLE</span>`
      : `<span class="ver-channel experimental">EXPERIMENTAL</span>`;
    const timeStr = b.time ? new Date(b.time).toLocaleString('es-ES') : '';

    return `<div class="ver-build-row ${isLatest ? 'ver-build-latest' : ''}">
      <div class="ver-build-left">
        <div class="ver-build-num">
          ${VER.isFabric ? `Loader ${b.loaderVersion}` : `Build #${b.build}`}
          ${isLatest ? '<span class="ver-latest-tag">LATEST</span>' : ''}
        </div>
        ${timeStr ? `<div class="ver-build-time">${timeStr}</div>` : ''}
        ${b.changes ? `<div class="ver-build-changes">${b.changes}</div>` : ''}
      </div>
      <div class="ver-build-right">
        ${channelBadge}
        <button class="ver-install-btn" data-idx="${i}">⬇ INSTALAR</button>
      </div>
    </div>`;
  }).join('');

  el.onclick = e => {
    const btn = e.target.closest('.ver-install-btn');
    if (btn) confirmInstall(list[parseInt(btn.dataset.idx)]);
  };
}

/* ── Modal de confirmación + instalación ── */
function confirmInstall(build) {
  if (VER.installing) return;

  const isLatest = VER.builds.indexOf(build) === 0;
  const sw       = VER.software;
  const ver      = VER.version;

  $('verModalTitle').textContent = `Instalar ${sw?.toUpperCase()} ${ver}`;
  $('verInstallModal').style.display = 'flex';

  let extraInfo = '';
  if (VER.isFabric) {
    extraInfo = `<div class="ver-modal-info">
      <b>Fabric Loader:</b> ${build.loaderVersion}<br>
      <small style="color:var(--yellow)">⚠ Fabric requiere ejecutar el installer. Se generará el comando tras confirmar.</small>
    </div>`;
  } else if (build.sha256) {
    extraInfo = `<div class="ver-modal-info"><b>SHA:</b> <code style="font-size:9px;color:var(--muted2)">${build.sha256.substring(0, 16)}…</code></div>`;
  }

  $('verModalBody').innerHTML = `
    <div class="ver-confirm-box">
      <div class="ver-confirm-icon">${SW_ICONS[sw] || '📦'}</div>
      <div class="ver-confirm-info">
        <div class="ver-confirm-title">${sw?.toUpperCase()} ${ver}</div>
        <div class="ver-confirm-sub">${VER.isFabric ? `Loader ${build.loaderVersion}` : `Build #${build.build} · ${build.channel}`}</div>
      </div>
    </div>
    ${extraInfo}
    <div class="ver-modal-warning">
      ⚠ El server.jar actual se guardará como backup automáticamente.<br>
      Deberás reiniciar el servidor para aplicar los cambios.
    </div>
    <div style="display:flex;gap:10px;margin-top:20px">
      <button class="ver-cancel-btn" id="btnVerCancel">Cancelar</button>
      <button class="ver-confirm-btn" id="btnVerConfirm">✓ Confirmar instalación</button>
    </div>
    <div id="verInstallProgress" style="display:none;margin-top:16px"></div>
  `;

  $('btnVerCancel').onclick  = () => $('verInstallModal').style.display = 'none';
  $('btnVerConfirm').onclick = () => runInstall(build);
}

async function runInstall(build) {
  if (VER.installing) return;
  VER.installing = true;

  const confirmBtn = $('btnVerConfirm');
  const cancelBtn  = $('btnVerCancel');
  const progress   = $('verInstallProgress');

  confirmBtn.disabled = true;
  cancelBtn.disabled  = true;
  confirmBtn.textContent = '⏳ Instalando...';
  progress.style.display = '';
  progress.innerHTML = '<div class="ver-progress-bar"><div class="ver-progress-fill"></div></div><div class="ver-progress-text">Descargando...</div>';

  try {
    const body = {
      software:      VER.software,
      version:       VER.version,
      build:         build.build,
      url:           build.url,
      loaderVersion: build.loaderVersion || null,
    };

    const d = await postJSON('/api/versions/install', body);

    if (!d.ok) throw new Error(d.error);

    VER.installing = false;

    if (d.type === 'fabric-installer') {
      progress.innerHTML = `
        <div style="color:var(--green);font-size:13px;margin-bottom:10px">✅ Installer descargado correctamente</div>
        <div style="font-size:11px;color:var(--muted2);margin-bottom:8px">Ejecuta este comando en tu carpeta de servidor:</div>
        <div class="ver-cmd-box" id="verFabricCmd">${d.installCmd}</div>
        <button class="small-btn" style="margin-top:8px" onclick="navigator.clipboard.writeText('${d.installCmd.replace(/'/g,"\\'")}');toast('Copiado','ok')">📋 Copiar</button>
        <div style="font-size:10px;color:var(--yellow);margin-top:10px">⚠ ${d.note}</div>`;
      confirmBtn.textContent = 'Hecho';
      confirmBtn.disabled    = false;
      confirmBtn.onclick     = () => $('verInstallModal').style.display = 'none';
    } else {
      progress.innerHTML = `
        <div style="color:var(--green);font-size:14px;margin-bottom:6px">✅ Instalado correctamente</div>
        <div style="font-size:11px;color:var(--muted2)">${d.software?.toUpperCase()} ${d.version} · Build #${d.build} · ${d.size}</div>
        <div style="font-size:10px;color:var(--yellow);margin-top:8px">⚠ ${d.note}</div>`;
      confirmBtn.textContent = 'Cerrar';
      confirmBtn.disabled    = false;
      confirmBtn.onclick     = () => $('verInstallModal').style.display = 'none';

      toast(`✅ ${d.software?.toUpperCase()} ${d.version} instalado`, 'ok');
      addActivity(`Versión instalada: ${d.software} ${d.version} build #${d.build}`, 'ok', '📦');
      loadCurrentJar(); // actualizar badge
    }
  } catch (e) {
    VER.installing = false;
    progress.innerHTML = `<div style="color:var(--red)">❌ ${e.message}</div>`;
    confirmBtn.textContent = 'Reintentar';
    confirmBtn.disabled    = false;
    cancelBtn.disabled     = false;
    confirmBtn.onclick     = () => runInstall(build);
    toast('❌ Error al instalar: ' + e.message, 'err');
  }
}

/* ═══════════════════════ USERS ═══════════════════════ */
function populateUsers(tab) {
  const data = USERS_DATA[tab] || [];
  const el   = $('userList');
  if (!data.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🚫</div><div class="empty-msg">No entries</div></div>';
    return;
  }
  el.innerHTML = data.map(u =>
    `<div class="user-row">
      <div class="user-avatar">${u.av}</div>
      <span class="user-name">${u.name}</span>
      <span class="user-role ${u.role}">${u.role === 'op' ? 'OPERATOR' : 'MEMBER'}</span>
      <span class="user-last">${u.last}</span>
      <div class="user-actions">
        <button class="icon-btn edit">✎</button>
        <button class="icon-btn">✕</button>
      </div>
    </div>`
  ).join('');
}

/* ═══════════════════════ BACKUPS ═══════════════════════ */
function populateBackups() {
  $('backupList').innerHTML = BACKUPS_DATA.map(b =>
    `<div class="backup-row">
      <span class="bk-icon">${b.auto ? '🔄' : '💾'}</span>
      <div class="bk-name">${b.name}<small>${b.date} · ${b.auto ? 'Automatic' : 'Manual'}</small></div>
      <span class="bk-size">${b.size}</span>
      <div class="bk-actions">
        <button class="icon-btn edit" data-action="restore">↩</button>
        <button class="icon-btn" data-action="download">⬇</button>
        <button class="icon-btn" data-action="delete">✕</button>
      </div>
    </div>`
  ).join('');
}

/* ═══════════════════════ STARTUP ═══════════════════════ */
function updateStartupPreview() {
  const jar   = $('cfgJar')?.value       || 'server.jar';
  const xms   = $('cfgXms')?.value       || '1G';
  const xmx   = $('cfgXmx')?.value       || '2G';
  const extra = $('cfgExtraArgs')?.value || '';
  const prev  = $('cfgPreview');
  if (prev) prev.textContent = `java -Xms${xms} -Xmx${xmx}${extra ? ' ' + extra.trim() : ''} -jar ${jar} nogui`;
}

async function saveStartup() {
  const body = {
    jar:       $('cfgJar').value,
    xms:       $('cfgXms').value,
    xmx:       $('cfgXmx').value,
    extraArgs: $('cfgExtraArgs').value,
    path:      $('cfgPath').value,
  };
  try {
    const d = await postJSON('/api/config', body);
    if (d.ok) { toast('✅ Configuration saved', 'ok'); addActivity('Startup updated', 'ok', '⚙️'); }
    else toast(d.error || 'Error', 'err');
  } catch {
    toast('✅ Config saved (no backend yet)', 'ok');
  }
}

/* ═══════════════════════ ACTIVITY LOG ═══════════════════════ */
const activityLog = [];
let activityFilter = 'all';

function addActivity(msg, level = 'info', icon = '📌') {
  activityLog.unshift({ msg, level, icon, time: new Date().toLocaleTimeString('en-US') });
  if (activityLog.length > 100) activityLog.pop();
  if ($('view-activitylog').classList.contains('active')) renderActivity();
}

function renderActivity() {
  const el   = $('activityList');
  if (!el) return;
  const data = activityFilter === 'all' ? activityLog : activityLog.filter(a => a.level === activityFilter);
  el.innerHTML = data.length
    ? data.map(a =>
        `<div class="act-row">
          <span class="act-icon">${a.icon}</span>
          <div class="act-body"><div class="act-msg">${escHtml(a.msg)}</div><div class="act-time">${escHtml(a.time)}</div></div>
          <span class="act-level ${a.level}">${a.level.toUpperCase()}</span>
        </div>`
      ).join('')
    : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-msg">No events yet</div></div>';
}

/* ═══════════════════════ TOAST ═══════════════════════ */
let toastTimer;
function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 3200);
}

/* ═══════════════════════ EVENT DELEGATION ═══════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  // Sidebar navigation
  document.querySelector('.sidebar').addEventListener('click', e => {
    const item = e.target.closest('.sb-item[data-view]');
    if (item) switchView(item.dataset.view);
  });

  // Server controls
  $('btnStart').addEventListener('click', startServer);
  $('btnStop').addEventListener('click', stopServer);
  $('btnRestart').addEventListener('click', restartServer);

  // Console
  $('btnClearConsole').addEventListener('click', () => $('console').innerHTML = '');
  $('btnSendCmd').addEventListener('click', sendCmd);
  $('cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendCmd(); });
  $('console').parentElement.addEventListener('click', e => {
    const btn = e.target.closest('.quick-btn[data-cmd]');
    if (btn) { $('cmdInput').value = btn.dataset.cmd; sendCmd(); }
  });

  // File manager
  $('crumbHome').addEventListener('click', () => populateFiles(''));
  $('crumbTrail').addEventListener('click', e => {
    const crumb = e.target.closest('.crumb[data-path]');
    if (crumb) populateFiles(crumb.dataset.path);
  });

  // Menú contextual de archivos
  $('fileList').addEventListener('click', e => {
    const menuBtn = e.target.closest('.file-menu-btn');
    if (menuBtn) {
      e.stopPropagation();
      openCtxMenu(e, menuBtn.dataset.name, menuBtn.dataset.type);
      return;
    }
    const row = e.target.closest('.file-row');
    if (row) openFsItem(row.dataset.name, row.dataset.type);
  });

  // Editor — volver y guardar
  $('btnEditorBack').addEventListener('click', closeEditor);
  $('btnSaveFile').addEventListener('click', saveFile);

  // Plugins tabs & source
  document.querySelector('.page-header').addEventListener('click', e => {
    const tab = e.target.closest('.plg-tab-btn[data-tab]');
    if (tab) pluginSwitchTab(tab.dataset.tab);
    const src = e.target.closest('.plg-source[data-source]');
    if (src) pluginSetSource(src.dataset.source);
  });
  $('btnPluginSearch').addEventListener('click', pluginSearch);
  $('plgSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') pluginSearch(); });
  $('btnRefreshInstalled').addEventListener('click', loadInstalledPlugins);

  // Plugin results — open modal
  $('plgResults').addEventListener('click', e => {
    const card = e.target.closest('.plg-card[data-plugin]');
    if (card) openVersionModal(JSON.parse(decodeURIComponent(card.dataset.plugin)));
  });

  // Plugin modal — install buttons & close
  $('btnClosePlgModal').addEventListener('click', closePlgModal);
  $('plgVersionModal').addEventListener('click', e => { if (e.target === $('plgVersionModal')) closePlgModal(); });
  $('plgModalBody').addEventListener('click', e => {
    const btn = e.target.closest('.plg-dl-btn[data-url]');
    if (btn) installPlugin(btn.id, btn.dataset.url, btn.dataset.filename, btn.dataset.source, btn.dataset.rid, btn.dataset.vid);
  });

  // Installed plugins — delete
  $('plgInstalledList').addEventListener('click', e => {
    const btn = e.target.closest('[data-delete]');
    if (btn) deletePlugin(btn.dataset.delete, btn);
  });

  // Version list — download
  $('versionList').addEventListener('click', e => {
    const btn = e.target.closest('.dl-btn[data-ver]');
    if (btn && !btn.classList.contains('current')) {
      toast(`⬇ Downloading ${btn.dataset.type} ${btn.dataset.ver}...`, 'ok');
      addActivity(`Downloading ${btn.dataset.type} ${btn.dataset.ver}`, 'info', '📦');
    }
  });

  // Backups
  $('backupList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const actions = { restore: 'Restoring...', download: 'Downloading...', delete: 'Deleting...' };
    toast(actions[btn.dataset.action] || '...', 'ok');
  });

  // Cerrar menú contextual con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeCtxMenu();
      if ($('filesEditorPanel').style.display !== 'none') closeEditor();
    }
  });

  addActivity('MoonWolf Panel started', 'info', '🌙');
});
