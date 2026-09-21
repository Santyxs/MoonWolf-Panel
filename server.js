'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

/* ══════════════════════════════════════════════
   .env (mini-loader, sin dependencias externas)
   ══════════════════════════════════════════════ */
const ENV_PATH = path.join(__dirname, '.env');
(function loadDotEnv() {
  if (!fsSync.existsSync(ENV_PATH)) return;

  for (const line of fsSync.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;

    let val = m[2] || '';

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (!(m[1] in process.env)) {
      process.env[m[1]] = val;
    }
  }
})();

/* ══════════════════════════════════════════════
   AUTENTICACIÓN SIMPLE (sin cuentas ni PostgreSQL)
   ══════════════════════════════════════════════ */
const LOCAL_AGENT_TOKEN = process.env.MOONWOLF_LOCAL_AUTH_TOKEN || '';

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));

  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}

const RUNTIME_DIR =
  process.env.MOONWOLF_SERVER_DIR ||
  process.env.BASE_DIR ||
  process.env.MOONWOLF_BASE_DIR ||
  path.join(process.cwd(), 'mc-server');

const loginAttempts = new Map();
const apiHits = new Map();
const API_RATE_LIMIT = 120;
const API_RATE_WINDOW_MS = 60_000;

function loginRateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);

  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, {
      count: 1,
      resetAt: now + 5 * 60 * 1000,
    });

    return false;
  }

  rec.count++;

  return rec.count > 10;
}

function apiRateLimited(ip) {
  const now = Date.now();
  const rec = apiHits.get(ip);

  if (!rec || now > rec.resetAt) {
    apiHits.set(ip, {
      count: 1,
      resetAt: now + API_RATE_WINDOW_MS,
    });

    return false;
  }

  rec.count++;

  return rec.count > API_RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();

  for (const [ip, rec] of loginAttempts) {
    if (now > rec.resetAt) {
      loginAttempts.delete(ip);
    }
  }

  for (const [ip, rec] of apiHits) {
    if (now > rec.resetAt) {
      apiHits.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

/* ══════════════════════════════════════════════
   EXPRESS / SOCKET.IO
   ══════════════════════════════════════════════ */
const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const role = auth.role;
  const token = String(auth.token || '');

  if (role !== 'agent' && role !== 'panel') {
    return next(new Error('Rol no válido.'));
  }

  const expected = LOCAL_AGENT_TOKEN || process.env.MOONWOLF_LOCAL_AUTH_TOKEN || '';

  if (!expected || !timingSafeEqualStr(token, expected)) {
    return next(new Error('unauthorized'));
  }

  socket.data.role = role;
  next();
});

const PUBLIC_ASSETS = ['index.html', 'dashboard.js', 'styles.css'];

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

for (const asset of PUBLIC_ASSETS) {
  app.get('/' + asset, (_req, res) => {
    res.sendFile(path.join(__dirname, asset));
  });
}

app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'moonwolf-local' });
});

app.use('/api', (req, res, next) => {
  if (apiRateLimited(req.ip)) {
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas peticiones, espera un momento.',
    });
  }

  next();
});

/* ══════════════════════════════════════════════
    SERVIDOR MINECRAFT
    ══════════════════════════════════════════════ */
const BASE_DIR = RUNTIME_DIR;

if (!fsSync.existsSync(BASE_DIR)) {
  fsSync.mkdirSync(BASE_DIR, { recursive: true });
}

const PLUGINS_DIR = path.join(BASE_DIR, 'plugins');

const PORT = Number(process.env.MOONWOLF_PORT || process.env.PORT || 3000);
const PAPER_UA = 'MoonWolfPanel/2.0 (contact@moonwolf.local)';

function safePath(rel) {
  const base = path.resolve(BASE_DIR);
  const full = path.resolve(path.join(BASE_DIR, rel));

  return full.startsWith(base + path.sep) || full === base ? full : null;
}

function safePluginPath(filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null;
  }

  return path.join(PLUGINS_DIR, filename);
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, error) => res.json({ ok: false, error });

async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, { headers: { 'User-Agent': PAPER_UA } });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} -> ${url}`);
  }

  return res.json();
}

async function downloadFile(url, dest) {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(url, {
    headers: { 'User-Agent': PAPER_UA },
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const head = buffer.subarray(0, 20).toString('utf8').trim().toLowerCase();

  if (
    contentType.includes('text/html') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html')
  ) {
    throw new Error('La descarga fue bloqueada por la protección anti-bot de SpigotMC. Instala este plugin manualmente desde su página de recursos.');
  }

  await fs.writeFile(dest, buffer);
}

function semverCmp(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10));
  const pb = String(b).split('.').map(n => parseInt(n, 10));

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isNaN(pa[i]) ? 0 : pa[i] || 0;
    const nb = Number.isNaN(pb[i]) ? 0 : pb[i] || 0;

    if (na !== nb) {
      return na - nb;
    }
  }

  return 0;
}

/* ══════════════════════════════════════════════
    CLOUD / AGENT
    ══════════════════════════════════════════════ */
let agentSocket = null;
const panelSockets = new Set();

io.on('connection', socket => {
  console.log('Cliente conectado:', socket.id, socket.data.role);

  if (socket.data.role === 'agent') {
    agentSocket = socket;
    console.log('🌙 MoonWolf Agent conectado:', socket.id);

    for (const panel of panelSockets) {
      panel.emit('cloud_ready', { agentOnline: true });
      panel.emit('agent_status', { online: true });
    }

    socket.on('event', event => {
      if (!event?.name) return;

      for (const panel of panelSockets) {
        panel.emit(event.name, event.payload);
      }
    });

    socket.on('rpc_result', result => {
      if (!result?.id) return;

      for (const panel of panelSockets) {
        if (panel.data.pendingRpc?.has(result.id)) {
          panel.data.pendingRpc.delete(result.id);
          panel.emit('rpc_result', result);
          break;
        }
      }
    });

    socket.on('disconnect', () => {
      if (agentSocket === socket) {
        agentSocket = null;
      }

      console.log('🌙 MoonWolf Agent desconectado:', socket.id);

      for (const panel of panelSockets) {
        panel.emit('cloud_ready', { agentOnline: false });
        panel.emit('agent_status', { online: false });
      }
    });

    return;
  }

  if (socket.data.role === 'panel') {
    socket.data.pendingRpc = new Set();
    panelSockets.add(socket);

    console.log('🖥️ Panel conectado:', socket.id);

    socket.emit('cloud_ready', { agentOnline: Boolean(agentSocket?.connected) });
    socket.emit('agent_status', { online: Boolean(agentSocket?.connected) });

    socket.on('rpc', request => {
      if (!agentSocket?.connected) {
        return socket.emit('rpc_result', {
          id: request?.id || null,
          ok: false,
          status: 503,
          contentType: 'application/json',
          data: { ok: false, error: 'MoonWolf Agent no está conectado.' },
        });
      }

      const id = request?.id;
      if (!id) return;

      socket.data.pendingRpc.add(id);
      agentSocket.emit('rpc', request);
    });

    socket.on('disconnect', () => {
      panelSockets.delete(socket);
      socket.data.pendingRpc?.clear();
      console.log('🖥️ Panel desconectado:', socket.id);
    });

    return;
  }

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

/* ══════════════════════════════════════════════
    ARCHIVOS
    ══════════════════════════════════════════════ */
app.get('/api/files', async (req, res) => {
  const fullPath = safePath(req.query.dir || '');

  if (!fullPath) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const items = await Promise.all(entries.map(async entry => {
      const stats = await fs.stat(path.join(fullPath, entry.name));

      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.name.endsWith('.jar') ? 'jar' : entry.name.endsWith('.log') ? 'log' : 'file',
        size: stats.isDirectory() ? '-' : (stats.size / 1024 / 1024).toFixed(2) + ' MB',
        date: stats.mtime.toLocaleString('es-ES'),
      };
    }));

    ok(res, { items });
  } catch {
    fail(res, 'No se puede acceder a la carpeta');
  }
});

app.get('/api/files/content', async (req, res) => {
  const full = safePath(req.query.path || '');

  if (!full) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    ok(res, { content: await fs.readFile(full, 'utf-8'), filename: path.basename(full) });
  } catch {
    fail(res, 'No se puede leer el archivo');
  }
});

app.post('/api/files/content', async (req, res) => {
  const { path: rel, content } = req.body;

  if (!rel || content === undefined) {
    return fail(res, 'Parámetros requeridos');
  }

  const full = safePath(rel);
  if (!full) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    await fs.writeFile(full, content, 'utf-8');
    ok(res);
  } catch {
    fail(res, 'No se puede guardar');
  }
});

/* ══════════════════════════════════════════════
    MINECRAFT PROCESS
    ══════════════════════════════════════════════ */
const { spawn } = require('child_process');

let mcProcess = null;
let startTime = null;
let statsTimer = null;
let restarting = false;

function broadcastStatus(s) { io.emit('status', s); }
function broadcastLog(line, type = 'info') {
  io.emit('log', {
    line,
    time: new Date().toLocaleTimeString('es-ES'),
    type,
  });
}

function startStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
  }

  statsTimer = setInterval(() => {
    if (!mcProcess || mcProcess.exitCode !== null) {
      return;
    }

    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const mem = process.memoryUsage();

    io.emit('stats', {
      players: 0,
      maxPlayers: 20,
      tps: 20,
      uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
      processMemory: Math.round(mem.rss / 1024 / 1024),
      sysMemory: {
        used: (mem.rss / 1024 / 1024 / 1024).toFixed(2),
        total: '16.00',
      },
      cpuUsage: 0,
    });
  }, 3000);
}

function launchServer() {
  const jarPath = path.join(BASE_DIR, 'server.jar');

  if (!fsSync.existsSync(jarPath)) {
    broadcastLog('❌ No se encontró server.jar en: ' + BASE_DIR, 'error');
    broadcastStatus('offline');
    return false;
  }

  mcProcess = spawn('java', ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], {
    cwd: BASE_DIR,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  startTime = Date.now();

  mcProcess.stdout.on('data', data => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(line => {
      const type = /WARN/i.test(line) ? 'warn' : /ERROR/i.test(line) ? 'error' : /Done/i.test(line) ? 'success' : 'info';
      broadcastLog(line, type);

      if (/Done/.test(line)) {
        broadcastStatus('online');
        startStatsTimer();
      }
    });
  });

  mcProcess.stderr.on('data', data => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(line => broadcastLog(line, 'warn'));
  });

  mcProcess.on('error', err => {
    broadcastLog('❌ Error al lanzar java: ' + err.message, 'error');
    broadcastStatus('offline');
    mcProcess = null;
  });

  mcProcess.on('close', code => {
    broadcastLog(`⏹ Servidor detenido (código ${code})`, 'system');

    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }

    mcProcess = null;

    if (restarting) {
      restarting = false;
      broadcastLog('↺ Relanzando servidor...', 'system');
      setTimeout(() => {
        broadcastStatus('starting');
        launchServer();
      }, 2000);
    } else {
      broadcastStatus('offline');
    }
  });

  return true;
}

app.post('/api/start', (_req, res) => {
  if (mcProcess && mcProcess.exitCode === null) {
    return fail(res, 'El servidor ya está en marcha');
  }

  broadcastStatus('starting');
  broadcastLog('🌙 Arrancando servidor...', 'system');

  if (!launchServer()) {
    return fail(res, 'No se encontró server.jar');
  }

  ok(res);
});

app.post('/api/stop', (_req, res) => {
  if (!mcProcess || mcProcess.exitCode !== null) {
    return fail(res, 'El servidor no está corriendo');
  }

  broadcastStatus('stopping');
  broadcastLog('⏹ Enviando stop...', 'system');
  mcProcess.stdin.write('stop\n');
  ok(res);
});

app.post('/api/restart', (_req, res) => {
  if (!mcProcess || mcProcess.exitCode !== null) {
    return fail(res, 'El servidor no está corriendo');
  }

  restarting = true;
  broadcastStatus('restarting');
  broadcastLog('↺ Reiniciando servidor...', 'system');
  mcProcess.stdin.write('stop\n');
  ok(res);
});

app.post('/api/command', (req, res) => {
  if (!req.body?.cmd) {
    return fail(res, 'Comando vacío');
  }

  if (!mcProcess || mcProcess.exitCode !== null) {
    return fail(res, 'El servidor no está corriendo');
  }

  mcProcess.stdin.write(req.body.cmd + '\n');
  broadcastLog('/ ' + req.body.cmd, 'cmd');
  ok(res);
});

/* ══════════════════════════════════════════════
    PLUGINS
    ══════════════════════════════════════════════ */
app.get('/api/plugins/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const source = req.query.source || 'all';

  if (!q) {
    return fail(res, 'Query vacía');
  }

  const results = [];
  const errors = [];

  if (source === 'all' || source === 'modrinth') {
    try {
      const { default: fetch } = await import('node-fetch');
      const r = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&limit=10`);
      const d = await r.json();

      results.push(...d.hits.map(p => ({
        id: p.project_id,
        name: p.title,
        description: p.description,
        icon: p.icon_url,
        downloads: p.downloads,
        source: 'modrinth',
        gameVersions: p.game_versions || [],
        categories: p.categories || [],
      })));
    } catch {
      errors.push('Modrinth no disponible');
    }
  }

  if (source === 'all' || source === 'spigot') {
    try {
      const list = await apiFetch(`https://api.spiget.org/v2/search/resources/${encodeURIComponent(q)}?size=10&field=name`);
      (Array.isArray(list) ? list : []).forEach(p => {
        results.push({
          id: String(p.id),
          name: p.name,
          description: p.tag || 'Plugin desde SpigotMC.',
          icon: `https://api.spiget.org/v2/resources/${p.id}/icon`,
          downloads: p.downloads || 0,
          source: 'spigot',
          external: !!p.external,
          premium: !!p.premium,
          gameVersions: [],
          categories: [],
        });
      });
    } catch {
      errors.push('SpigotMC (Spiget) no disponible');
    }
  }

  if (source === 'all' || source === 'hangar') {
    try {
      const d = await apiFetch(`https://hangar.papermc.io/api/v1/projects?limit=10&offset=0&q=${encodeURIComponent(q)}&sort=-stars`);
      (d.result || []).forEach(p => {
        results.push({
          id: `${p.namespace.owner}/${p.namespace.slug}`,
          name: p.name,
          description: p.description || '',
          icon: p.avatarUrl,
          downloads: p.stats?.downloads || 0,
          source: 'hangar',
          gameVersions: [],
          categories: p.category ? [p.category] : [],
        });
      });
    } catch {
      errors.push('Hangar no disponible');
    }
  }

  ok(res, { results, errors });
});

app.get('/api/plugins/versions', async (req, res) => {
  const { id, source } = req.query;

  if (!id || !source) {
    return fail(res, 'Parámetros requeridos');
  }

  try {
    if (source === 'modrinth') {
      const { default: fetch } = await import('node-fetch');
      const r = await fetch(`https://api.modrinth.com/v2/project/${id}/version`);
      const versions = await r.json();

      return ok(res, { versions: versions.map(v => ({ versionId: v.id, versionNumber: v.version_number, name: v.name, downloads: v.downloads, published: v.date_published, gameVersions: v.game_versions, loaders: v.loaders, changelog: v.changelog, files: v.files })) });
    }

    if (source === 'spigot') {
      const resource = await apiFetch(`https://api.spiget.org/v2/resources/${encodeURIComponent(id)}`);
      const canDownload = !resource.premium && !resource.external;
      const resourcePage = `https://www.spigotmc.org/resources/${encodeURIComponent(id)}/`;
      const rawVersions = await apiFetch(`https://api.spiget.org/v2/resources/${encodeURIComponent(id)}/versions?size=20&sort=-releaseDate`);
      const safeName = (resource.name || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_');
      let updates = [];

      try {
        updates = await apiFetch(`https://api.spiget.org/v2/resources/${encodeURIComponent(id)}/updates?size=20&sort=-date`);
        if (!Array.isArray(updates)) updates = [];
      } catch {}

      const findChangelog = releaseDateSec => {
        if (!releaseDateSec || !updates.length) return null;

        let best = null;
        let bestDiff = Infinity;

        for (const u of updates) {
          if (!u.date) continue;
          const diff = Math.abs(u.date - releaseDateSec);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = u;
          }
        }

        return best && bestDiff <= 7 * 86400 ? best.description : null;
      };

      const versions = (Array.isArray(rawVersions) ? rawVersions : []).map(v => {
        const versionLabel = v.name || `#${v.id}`;

        return {
          versionId: v.id,
          versionNumber: versionLabel,
          published: v.releaseDate ? v.releaseDate * 1000 : null,
          downloads: v.downloads,
          isExternal: !canDownload,
          externalUrl: !canDownload ? resourcePage : undefined,
          changelog: findChangelog(v.releaseDate),
          changelogIsHtml: true,
          files: canDownload ? [{ primary: true, url: `https://api.spiget.org/v2/resources/${encodeURIComponent(id)}/versions/${v.id}/download`, filename: `${safeName}-${String(versionLabel).replace(/[^a-zA-Z0-9._-]/g, '_')}.jar` }] : [],
        };
      });

      if (!versions.length) {
        versions.push({ versionId: 'external', versionNumber: 'Ver en SpigotMC', isExternal: true, externalUrl: resourcePage });
      }

      return ok(res, { versions, isExternal: !canDownload });
    }

    if (source === 'hangar') {
      const [owner, slug] = String(id).split('/');
      if (!owner || !slug) {
        return fail(res, 'ID de Hangar inválido');
      }

      const projectPage = `https://hangar.papermc.io/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
      const rawVersions = await apiFetch(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions?limit=20&offset=0`);
      const list = Array.isArray(rawVersions.result) ? rawVersions.result : [];

      const versions = list.map(v => {
        const platforms = Object.keys(v.downloads || {});
        const platform = platforms.includes('PAPER') ? 'PAPER' : platforms[0];
        const platDL = platform ? v.downloads[platform] : null;
        const totalDownloads = Object.values(v.downloads || {}).reduce((a, p) => a + (p?.downloads || 0), 0);
        const isExternal = !platform || !!platDL?.externalUrl;

        return {
          versionId: v.name,
          versionNumber: v.name,
          published: v.createdAt ? new Date(v.createdAt).getTime() : null,
          downloads: totalDownloads,
          isExternal,
          externalUrl: isExternal ? (platDL?.externalUrl || `${projectPage}/versions/${encodeURIComponent(v.name)}`) : undefined,
          changelog: v.description || null,
          changelogIsHtml: false,
          files: !isExternal && platform ? [{ primary: true, url: `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(v.name)}/${platform}/download`, filename: `${slug}-${v.name}.jar` }] : [],
        };
      });

      if (!versions.length) {
        versions.push({ versionId: 'external', versionNumber: 'Ver en Hangar', isExternal: true, externalUrl: projectPage });
      }

      return ok(res, { versions });
    }

    ok(res, { versions: [], isExternal: true });
  } catch (e) {
    console.error('[plugins/versions]', e.message);
    fail(res, e.message);
  }
});

app.post('/api/plugins/install', async (req, res) => {
  const { url, filename } = req.body;

  if (!url || !filename) {
    return fail(res, 'Parámetros requeridos');
  }

  const dest = safePluginPath(filename);
  if (!dest) {
    return fail(res, 'Nombre no válido');
  }

  try {
    if (!fsSync.existsSync(PLUGINS_DIR)) {
      fsSync.mkdirSync(PLUGINS_DIR, { recursive: true });
    }

    await downloadFile(url, dest);
    const stats = await fs.stat(dest);

    ok(res, { filename, size: (stats.size / 1024 / 1024).toFixed(2) + ' MB' });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get('/api/plugins/installed', async (_req, res) => {
  try {
    if (!fsSync.existsSync(PLUGINS_DIR)) {
      return ok(res, { plugins: [] });
    }

    const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
    const jarFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.jar'));
    const plugins = await Promise.all(jarFiles.map(async e => {
      const s = await fs.stat(path.join(PLUGINS_DIR, e.name));
      return {
        filename: e.name,
        size: (s.size / 1024 / 1024).toFixed(2) + ' MB',
        modified: s.mtime.toLocaleString('es-ES'),
      };
    }));

    ok(res, { plugins });
  } catch (e) {
    fail(res, e.message);
  }
});

app.delete('/api/plugins/installed/:file', async (req, res) => {
  const dest = safePluginPath(req.params.file);

  if (!dest) {
    return fail(res, 'Nombre no válido');
  }

  try {
    const stat = await fs.stat(dest);
    if (!stat.isFile()) {
      return fail(res, 'Solo se pueden eliminar archivos de plugin (.jar)');
    }

    await fs.unlink(dest);
    ok(res);
  } catch (e) {
    fail(res, e.message);
  }
});

/* ══════════════════════════════════════════════
    VERSIONES DE SOFTWARE
    ══════════════════════════════════════════════ */
app.get('/api/versions/software', (_req, res) => {
  ok(res, {
    software: [
      { id: 'paper', label: 'Paper', category: 'server', color: '#00c8ff', desc: 'Alto rendimiento. El más popular. 1.8.8+' },
      { id: 'purpur', label: 'Purpur', category: 'server', color: '#aa88ff', desc: 'Fork de Paper con configurabilidad extra. 1.16+' },
      { id: 'folia', label: 'Folia', category: 'server', color: '#00ff88', desc: 'Paper con multithreading regional. 1.20+' },
      { id: 'fabric', label: 'Fabric', category: 'server', color: '#d4aa70', desc: 'Ligero, orientado a mods. 1.14+' },
      { id: 'vanilla', label: 'Vanilla', category: 'server', color: '#c9d8e8', desc: 'Oficial de Mojang. Sin mods ni plugins. 1.0+' },
      { id: 'forge', label: 'Forge', category: 'server', color: '#c0873f', desc: 'El cargador de mods clásico. Descarga manual.', external: 'https://files.minecraftforge.net/' },
      { id: 'velocity', label: 'Velocity', category: 'proxy', color: '#ffcc00', desc: 'Proxy moderno. Recomendado.' },
      { id: 'waterfall', label: 'Waterfall', category: 'proxy', color: '#ff8844', desc: 'Fork de BungeeCord (EOL). Usa Velocity mejor.' },
      { id: 'bungeecord', label: 'BungeeCord', category: 'proxy', color: '#ff4455', desc: 'Proxy original. Descarga desde SpigotMC.', external: 'https://ci.md-5.net/job/BungeeCord/' },
    ],
  });
});

app.get('/api/versions/list', async (req, res) => {
  const sw = req.query.software || '';
  if (!sw) {
    return fail(res, 'software requerido');
  }

  try {
    if (['paper', 'folia', 'velocity', 'waterfall'].includes(sw)) {
      const data = await apiFetch(`https://fill.papermc.io/v3/projects/${sw}`);
      const all = [];

      for (const group of Object.values(data.versions || {})) {
        all.push(...group);
      }

      all.sort((a, b) => semverCmp(b, a));
      return ok(res, { versions: all });
    }

    if (sw === 'purpur') {
      const data = await apiFetch('https://api.purpurmc.org/v2/purpur');
      return ok(res, { versions: (data.versions || []).slice().reverse() });
    }

    if (sw === 'fabric') {
      const data = await apiFetch('https://meta.fabricmc.net/v2/versions/game');
      return ok(res, { versions: data.filter(v => v.stable).map(v => v.version) });
    }

    if (sw === 'vanilla') {
      const manifest = await apiFetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      return ok(res, { versions: manifest.versions.filter(v => v.type === 'release').map(v => v.id) });
    }

    fail(res, `Software sin API pública: ${sw}`);
  } catch (e) {
    console.error('[versions/list]', e.message);
    fail(res, e.message);
  }
});

app.get('/api/versions/builds', async (req, res) => {
  const { software: sw, version } = req.query;

  if (!sw || !version) {
    return fail(res, 'software y version requeridos');
  }

  try {
    if (['paper', 'folia', 'velocity', 'waterfall'].includes(sw)) {
      const data = await apiFetch(`https://fill.papermc.io/v3/projects/${sw}/versions/${encodeURIComponent(version)}/builds`);
      const builds = (Array.isArray(data) ? data : []).map(b => ({
        build: b.build,
        channel: b.channel,
        time: b.time,
        url: b.downloads?.['server:default']?.url || null,
        sha256: b.downloads?.['server:default']?.sha256 || null,
        changes: (b.changes || []).map(c => c.summary).slice(0, 3).join(' · '),
      })).sort((a, b) => b.build - a.build);

      return ok(res, { builds });
    }

    if (sw === 'purpur') {
      const data = await apiFetch(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
      const builds = (data.builds?.all || []).slice().reverse().map(b => ({
        build: b,
        channel: 'STABLE',
        time: null,
        url: `https://api.purpurmc.org/v2/purpur/${version}/${b}/download`,
        sha256: null,
        changes: '',
      }));

      return ok(res, { builds });
    }

    if (sw === 'fabric') {
      const loaders = await apiFetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`);
      const builds = loaders.filter(l => l.loader?.stable).map(l => ({
        build: l.loader.build,
        channel: 'STABLE',
        loaderVersion: l.loader.version,
        time: null,
        url: null,
        sha256: null,
        changes: `Fabric Loader ${l.loader.version}`,
      }));

      return ok(res, { builds, isFabric: true });
    }

    if (sw === 'vanilla') {
      const manifest = await apiFetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const entry = manifest.versions.find(v => v.id === version && v.type === 'release');

      if (!entry) {
        return fail(res, `Versión ${version} no encontrada`);
      }

      const vdata = await apiFetch(entry.url);
      const serverUrl = vdata.downloads?.server?.url;

      if (!serverUrl) {
        return fail(res, 'No hay descarga de servidor para esta versión');
      }

      return ok(res, { builds: [{ build: 1, channel: 'STABLE', time: entry.releaseTime, url: serverUrl, sha256: vdata.downloads?.server?.sha1, changes: `Minecraft ${version} — oficial de Mojang` }] });
    }

    fail(res, `Software sin API: ${sw}`);
  } catch (e) {
    console.error('[versions/builds]', e.message);
    fail(res, e.message);
  }
});

app.post('/api/versions/install', async (req, res) => {
  const { software: sw, version, build, url, loaderVersion } = req.body;

  if (!sw || !version) {
    return fail(res, 'software y version requeridos');
  }

  try {
    if (sw === 'fabric') {
      if (!loaderVersion) {
        return fail(res, 'loaderVersion requerido para Fabric');
      }

      const installers = await apiFetch('https://meta.fabricmc.net/v2/versions/installer');
      const inst = installers.find(i => i.stable) || installers[0];

      if (!inst) {
        return fail(res, 'No se encontró installer de Fabric');
      }

      const instFile = path.join(BASE_DIR, `fabric-installer-${inst.version}.jar`);
      if (!fsSync.existsSync(instFile)) {
        await downloadFile(inst.url, instFile);
      }

      return ok(res, {
        type: 'fabric-installer',
        installCmd: `java -jar "fabric-installer-${inst.version}.jar" server -mcversion ${version} -loader ${loaderVersion} -downloadMinecraft`,
        jarName: 'fabric-server-launch.jar',
        note: 'Ejecuta este comando en tu carpeta de servidor. Luego configura Startup para usar fabric-server-launch.jar.',
      });
    }

    if (!url) {
      return fail(res, 'URL de descarga requerida');
    }

    const currentJar = path.join(BASE_DIR, 'server.jar');
    if (fsSync.existsSync(currentJar)) {
      const bakName = `server.bak_${Date.now()}.jar`;
      await fs.rename(currentJar, path.join(BASE_DIR, bakName));
      console.log(`[versions] Backup creado: ${bakName}`);
    }

    await downloadFile(url, currentJar);
    const stats = await fs.stat(currentJar);

    ok(res, {
      type: 'direct',
      filename: 'server.jar',
      size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
      software: sw,
      version,
      build,
      note: 'server.jar actualizado correctamente. Reinicia el servidor para aplicar los cambios.',
    });
  } catch (e) {
    console.error('[versions/install]', e.message);
    fail(res, e.message);
  }
});

app.get('/api/versions/current', async (_req, res) => {
  const jarPath = path.join(BASE_DIR, 'server.jar');

  try {
    const stats = await fs.stat(jarPath);
    ok(res, {
      exists: true,
      size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
      modified: stats.mtime.toLocaleString('es-ES'),
    });
  } catch {
    ok(res, { exists: false });
  }
});

/* ══════════════════════════════════════════════
    OPERACIONES DE ARCHIVOS
    ══════════════════════════════════════════════ */
const archiver = require('archiver');

app.post('/api/files/rename', async (req, res) => {
  const { path: rel, newName } = req.body;

  if (!rel || !newName) {
    return fail(res, 'Parámetros requeridos');
  }

  if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
    return fail(res, 'Nombre no válido');
  }

  const full = safePath(rel);
  const fullNew = safePath(path.join(path.dirname(rel), newName));

  if (!full || !fullNew) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    await fs.rename(full, fullNew);
    ok(res);
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/files/copy', async (req, res) => {
  const { path: rel, dest } = req.body;

  if (!rel || dest === undefined) {
    return fail(res, 'Parámetros requeridos');
  }

  const full = safePath(rel);
  const fullDest = safePath(dest);

  if (!full || !fullDest) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    await fs.mkdir(path.dirname(fullDest), { recursive: true });
    await fs.copyFile(full, fullDest);
    ok(res);
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/files/move', async (req, res) => {
  const { path: rel, dest } = req.body;

  if (!rel || dest === undefined) {
    return fail(res, 'Parámetros requeridos');
  }

  const full = safePath(rel);
  const fullDest = safePath(dest);

  if (!full || !fullDest) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    await fs.mkdir(path.dirname(fullDest), { recursive: true });
    await fs.rename(full, fullDest);
    ok(res);
  } catch (e) {
    fail(res, e.message);
  }
});

app.get('/api/files/download', async (req, res) => {
  const full = safePath(req.query.path || '');

  if (!full) {
    return res.status(403).send('Ruta no permitida');
  }

  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) {
      return res.status(400).send('Solo se pueden descargar archivos');
    }

    res.download(full);
  } catch {
    res.status(404).send('Archivo no encontrado');
  }
});

app.post('/api/files/compress', async (req, res) => {
  const { path: rel, name } = req.body;

  if (!rel || !name) {
    return fail(res, 'Parámetros requeridos');
  }

  const full = safePath(rel);
  if (!full) {
    return fail(res, 'Ruta no permitida');
  }

  const zipName = name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.zip';
  const zipDest = path.join(path.dirname(full), zipName);
  const resolvedBase = path.resolve(BASE_DIR);

  if (!zipDest.startsWith(resolvedBase + path.sep) && zipDest !== resolvedBase) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(zipDest);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      const stat = fsSync.statSync(full);
      if (stat.isDirectory()) {
        archive.directory(full, name);
      } else {
        archive.file(full, { name });
      }

      archive.finalize();
    });

    ok(res, { zipName });
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/files/delete', async (req, res) => {
  const { path: rel, isDir } = req.body;

  if (!rel) {
    return fail(res, 'Parámetros requeridos');
  }

  const full = safePath(rel);
  if (!full) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    if (isDir) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await fs.unlink(full);
    }

    ok(res);
  } catch (e) {
    fail(res, e.message);
  }
});

/* ══════════════════════════════════════════════
    DEBUG
    ══════════════════════════════════════════════ */
app.get('/api/debug/start', async (_req, res) => {
  const jarPath = path.join(BASE_DIR, 'server.jar');
  const exists = fsSync.existsSync(jarPath);

  const javaCheck = await new Promise(resolve => {
    const j = spawn('java', ['-version'], { shell: true, stdio: 'pipe' });
    let out = '';

    j.stderr.on('data', d => { out += d; });
    j.stdout.on('data', d => { out += d; });
    j.on('close', code => resolve({ code, out }));
    j.on('error', e => resolve({ code: -1, out: e.message }));
  });

  res.json({ BASE_DIR, jarExists: exists, jarPath, java: javaCheck });
});

/* ══════════════════════════════════════════════
    INICIO
    ══════════════════════════════════════════════ */
async function start() {
  server.listen(PORT, () => console.log(`MoonWolf Panel → http://localhost:${PORT}`));
}

start().catch(error => {
  console.error('❌ Error iniciando MoonWolf Panel:', error);
  process.exit(1);
});
