'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

function atomicWriteFileSync(filePath, data, options = 'utf8') {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fsSync.writeFileSync(tempPath, data, options);
    fsSync.renameSync(tempPath, filePath);
  } catch (error) {
    try { fsSync.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

async function atomicWriteFile(filePath, data, options = 'utf8') {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tempPath, data, options);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/* ══════════════════════════════════════════════
   Environments
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
   AUTHENTICATION / SESSIONS
   ══════════════════════════════════════════════ */
const LOCAL_AGENT_TOKEN = process.env.MOONWOLF_LOCAL_AUTH_TOKEN || '';

const SESSION_SECRET = (() => {
  const envSecret = process.env.MOONWOLF_SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;

  const appDir = path.join(
    process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'MoonWolf'
  );
  const secretPath = path.join(appDir, 'session-secret');

  try {
    const saved = fsSync.readFileSync(secretPath, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {}

  const secret = crypto.randomBytes(32).toString('hex');

  try {
    fsSync.mkdirSync(appDir, { recursive: true });
    atomicWriteFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[session] No se pudo persistir SESSION_SECRET:', error.message);
  }

  return secret;
})();

const PANEL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));

  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}

function signValue(value) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(value)
    .digest('base64url');
}

const SHARE_TOKEN_STORE_PATH =
  process.env.MOONWOLF_SHARE_STORE ||
  path.join(__dirname, '.moonwolf-share-tokens.json');

const PERMISSION_RANK = {
  read: 1,
  control: 2,
  admin: 3,
};
const SHARE_PERMISSIONS = new Set(Object.keys(PERMISSION_RANK));

function permissionAllows(actual, required) {
  return (PERMISSION_RANK[String(actual || '')] || 0) >= (PERMISSION_RANK[String(required || '')] || 99);
}

function normalizeSharePermission(permission) {
  const value = String(permission || '').toLowerCase();
  return SHARE_PERMISSIONS.has(value) ? value : null;
}

function canManageShareTokens(session) {
  return Boolean(session && permissionAllows(session.permission, 'admin'));
}

const ADMIN_ROUTE_RULES = Object.freeze([
  {
    methods: new Set(['GET', 'HEAD']),
    paths: [
      '/api/files',
      '/api/files/content',
      '/api/files/download',
      '/api/databases/status',
      '/api/databases',
      '/api/backups',
      '/api/backups/download/:name',
      '/api/debug/start',
    ],
  },
  {
    methods: new Set(['POST']),
    paths: [
      '/api/files/content',
      '/api/files/create',
      '/api/files/rename',
      '/api/files/copy',
      '/api/files/move',
      '/api/files/compress',
      '/api/files/bulk',
      '/api/files/delete',
      '/api/databases',
      '/api/databases/:name/reset-password',
      '/api/backups',
      '/api/startup',
      '/api/ports',
      '/api/plugins/install',
      '/api/versions/install',
    ],
  },
  {
    methods: new Set(['DELETE']),
    paths: [
      '/api/databases/:name',
      '/api/backups/:name',
      '/api/plugins/installed/:file',
    ],
  },
]);

function routeMatchesPattern(route, pattern) {
  const routeParts = route.split('/');
  const patternParts = pattern.split('/');
  if (routeParts.length !== patternParts.length) return false;

  return patternParts.every((part, index) => part.startsWith(':') || part === routeParts[index]);
}

function requiredPermission(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const route = String(pathname || '').split('?')[0];

  const isAdminRoute = ADMIN_ROUTE_RULES.some(rule =>
    rule.methods.has(verb) && rule.paths.some(pattern => routeMatchesPattern(route, pattern))
  );
  if (isAdminRoute) return 'admin';
  if (verb === 'GET' || verb === 'HEAD') return 'read';
  return 'control';
}

function loadShareTokens() {
  try {
    const data = JSON.parse(fsSync.readFileSync(SHARE_TOKEN_STORE_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveShareTokens(tokens) {
  const dir = path.dirname(SHARE_TOKEN_STORE_PATH);

  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }

  atomicWriteFileSync(SHARE_TOKEN_STORE_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

function hashShareToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function makeShareToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';

  while (raw.length < 16) {
    for (const byte of crypto.randomBytes(16)) {
      raw += alphabet[byte % alphabet.length];
      if (raw.length >= 16) break;
    }
  }

  return `MW-SHARE-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function createShareToken(agentId, permission, expiresAt, label) {
  const token = makeShareToken();
  const record = {
    id: crypto.randomUUID(),
    agentId: String(agentId),
    tokenHash: hashShareToken(token),
    label: String(label || '').trim().slice(0, 60) || 'Acceso compartido',
    permission,
    createdAt: Date.now(),
    expiresAt: expiresAt || null,
    revokedAt: null,
  };

  const tokens = loadShareTokens();
  tokens.push(record);
  saveShareTokens(tokens);

  return { record, token };
}

function findShareToken(token) {
  const hash = hashShareToken(token);
  const record = loadShareTokens().find(item => {
    const stored = String(item?.tokenHash || '');
    return stored.length === hash.length && timingSafeEqualStr(stored, hash);
  });

  if (!record || record.revokedAt) return null;
  if (record.expiresAt && Number(record.expiresAt) <= Date.now()) return null;

  return record;
}

function publicShareToken(record) {
  return {
    id: record.id,
    agentId: record.agentId,
    label: record.label,
    permission: record.permission,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt || null,
    revokedAt: record.revokedAt || null,
  };
}

function getSessionFromRequest(req) {
  const auth = String(req.headers.authorization || '');

  if (!auth.startsWith('Bearer ')) return null;

  const session = verifyPanelSession(auth.slice(7).trim());
  if (!session) return null;

  if (session.kind === 'share') {
    const share = loadShareTokens().find(
      item => item.id === session.shareTokenId && item.agentId === session.agentId
    );
    if (!share || share.revokedAt || (share.expiresAt && Number(share.expiresAt) <= Date.now())) {
      return null;
    }
    session.permission = normalizeSharePermission(share.permission) || 'read';
  }

  return session;
}

function createPanelSession(agentId, options = {}) {
  const permission = options.permission || 'admin';
  const kind = options.kind || 'owner';
  const shareTokenId = options.shareTokenId || null;
  const requestedExp = Number(options.expiresAt) || 0;
  const sessionExp = requestedExp > 0
    ? Math.min(Date.now() + PANEL_SESSION_TTL_MS, requestedExp)
    : Date.now() + PANEL_SESSION_TTL_MS;

  const payload = Buffer.from(JSON.stringify({
    agentId,
    permission,
    kind,
    shareTokenId,
    iat: Date.now(),
    exp: sessionExp,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');

  return `${payload}.${signValue(payload)}`;
}

function verifyPanelSession(token) {
  const [payload, signature] = String(token || '').split('.');

  if (!payload || !signature || !timingSafeEqualStr(signature, signValue(payload))) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (!data?.agentId || !Number.isFinite(data.exp) || data.exp <= Date.now()) {
      return null;
    }

    data.permission = data.permission || 'admin';
    data.kind = data.kind || 'owner';
    data.shareTokenId = data.shareTokenId || null;

    return data;
  } catch {
    return null;
  }
}

const AGENT_STORE_PATH =
  process.env.MOONWOLF_AGENT_STORE ||
  path.join(__dirname, '.moonwolf-agents.json');

function verifyOrRegisterAgent(agentId, token) {
  if (!/^[A-Za-z0-9-]{16,64}$/.test(agentId)) return false;

  let db = {};

  try {
    db = JSON.parse(fsSync.readFileSync(AGENT_STORE_PATH, 'utf8')) || {};
  } catch {}

  const hash = hashShareToken(token);

  if (!Object.prototype.hasOwnProperty.call(db, agentId)) {
    db[agentId] = hash;

    try {
      atomicWriteFileSync(AGENT_STORE_PATH, JSON.stringify(db), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.warn('[agents] No se pudo persistir el registro:', error.message);
    }

    return true;
  }

  return timingSafeEqualStr(db[agentId], hash);
}

const pairingCodes = new Map();

function makePairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';

  for (const byte of crypto.randomBytes(7)) {
    raw += alphabet[byte % alphabet.length];
  }

  return `MW-P${raw.slice(0, 3)}-${raw.slice(3, 7)}`;
}

function createPairingCode(agentId) {
  for (const [code, pairing] of pairingCodes) {
    if (pairing.agentId === agentId) {
      pairingCodes.delete(code);
    }
  }

  let code;

  do {
    code = makePairingCode();
  } while (pairingCodes.has(code));

  const expiresAt = Date.now() + PAIRING_TTL_MS;

  pairingCodes.set(code, { agentId, expiresAt });

  return { code, expiresAt };
}

function consumePairingCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  const pairing = pairingCodes.get(normalized);

  if (!pairing) return null;

  pairingCodes.delete(normalized);

  if (pairing.expiresAt <= Date.now()) {
    return null;
  }

  return pairing;
}

const RUNTIME_DIR =
  process.env.MOONWOLF_SERVER_DIR ||
  process.env.BASE_DIR ||
  process.env.MOONWOLF_BASE_DIR ||
  path.join(process.cwd(), 'mc-server');

const loginAttempts = new Map();
const apiHits = new Map();
const operationHits = new Map();
const API_RATE_LIMIT = 120;
const API_RATE_WINDOW_MS = 60_000;
const SOCKET_CONNECTION_LIMIT = 20;
const SOCKET_CONNECTION_WINDOW_MS = 60_000;
const SOCKET_CONNECTION_ATTEMPTS = 40;
const socketConnectionAttempts = new Map();
const socketConnections = new Map();
const OPERATION_RATE_RULES = Object.freeze([
  { id: 'pair', methods: new Set(['POST']), paths: ['/pair'], limit: 10, windowMs: 5 * 60_000 },
  { id: 'share-tokens', methods: new Set(['POST', 'PATCH', 'DELETE']), paths: ['/share-tokens', '/share-tokens/:id'], limit: 20, windowMs: 60_000 },
  { id: 'server-lifecycle', methods: new Set(['POST']), paths: ['/start', '/stop', '/restart'], limit: 20, windowMs: 60_000 },
  { id: 'server-command', methods: new Set(['POST']), paths: ['/command'], limit: 30, windowMs: 60_000 },
  { id: 'startup-ports', methods: new Set(['POST']), paths: ['/startup', '/ports'], limit: 20, windowMs: 60_000 },
  { id: 'file-upload', methods: new Set(['POST']), paths: ['/files/upload-chunk'], limit: 2_000, windowMs: 60_000 },
  { id: 'file-mutation', methods: new Set(['POST']), paths: [
    '/files/content', '/files/create', '/files/rename', '/files/copy',
    '/files/move', '/files/compress', '/files/bulk', '/files/delete',
  ], limit: 60, windowMs: 60_000 },
  { id: 'database-mutation', methods: new Set(['POST', 'DELETE']), paths: [
    '/databases', '/databases/:name/reset-password', '/databases/:name',
  ], limit: 10, windowMs: 60_000 },
  { id: 'installation', methods: new Set(['POST', 'DELETE']), paths: [
    '/plugins/install', '/plugins/installed/:file', '/versions/install',
  ], limit: 10, windowMs: 60_000 },
  { id: 'backup-mutation', methods: new Set(['POST', 'DELETE']), paths: ['/backups', '/backups/:name'], limit: 10, windowMs: 60_000 },
]);

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

function operationPathMatches(pathname, pattern) {
  const pathParts = pathname.split('/');
  const patternParts = pattern.split('/');
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(':') || part === pathParts[index]);
}

function operationRateRule(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const route = String(pathname || '').split('?')[0];
  return OPERATION_RATE_RULES.find(rule =>
    rule.methods.has(verb) && rule.paths.some(pattern => operationPathMatches(route, pattern))
  ) || null;
}

function operationRateLimited(ip, method, pathname) {
  const rule = operationRateRule(method, pathname);
  if (!rule) return null;

  const key = `${ip}:${rule.id}`;
  const now = Date.now();
  const current = operationHits.get(key);
  if (!current || now > current.resetAt) {
    operationHits.set(key, { count: 1, resetAt: now + rule.windowMs });
    return null;
  }

  current.count++;
  if (current.count > rule.limit) {
    return rule;
  }
  return null;
}

function socketClientIp(socket) {
  const forwarded = String(socket.handshake.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || String(socket.handshake.address || 'unknown');
}

function socketConnectionAllowed(socket) {
  const ip = socketClientIp(socket);
  const now = Date.now();
  const attempts = socketConnectionAttempts.get(ip);

  if (!attempts || now > attempts.resetAt) {
    socketConnectionAttempts.set(ip, {
      count: 1,
      resetAt: now + SOCKET_CONNECTION_WINDOW_MS,
    });
  } else {
    attempts.count++;
    if (attempts.count > SOCKET_CONNECTION_ATTEMPTS) return false;
  }

  if ((socketConnections.get(ip) || 0) >= SOCKET_CONNECTION_LIMIT) return false;

  socket.data.connectionIp = ip;
  socketConnections.set(ip, (socketConnections.get(ip) || 0) + 1);
  return true;
}

function releaseSocketConnection(socket) {
  const ip = socket.data.connectionIp;
  if (!ip) return;

  const count = (socketConnections.get(ip) || 1) - 1;
  if (count > 0) socketConnections.set(ip, count);
  else socketConnections.delete(ip);
  socket.data.connectionIp = null;
}

function socketEventAllowed(socket, event, limit, windowMs = 60_000) {
  const now = Date.now();
  const current = socket.data.eventLimits?.[event];

  if (!current || now > current.resetAt) {
    socket.data.eventLimits = socket.data.eventLimits || {};
    socket.data.eventLimits[event] = { count: 1, resetAt: now + windowMs };
    return true;
  }

  current.count++;
  return current.count <= limit;
}

setInterval(() => {
  const now = Date.now();

  for (const [ip, rec] of apiHits) {
    if (now > rec.resetAt) apiHits.delete(ip);
  }

  for (const [ip, rec] of socketConnectionAttempts) {
    if (now > rec.resetAt) socketConnectionAttempts.delete(ip);
  }

  for (const [ip, rec] of loginAttempts) {
    if (now > rec.resetAt) loginAttempts.delete(ip);
  }

  for (const [key, rec] of operationHits) {
    if (now > rec.resetAt) operationHits.delete(key);
  }

  for (const [code, pairing] of pairingCodes) {
    if (pairing.expiresAt <= now) pairingCodes.delete(code);
  }
}, 10 * 60 * 1000).unref();

/* ══════════════════════════════════════════════
   EXPRESS / SOCKET.IO
   ══════════════════════════════════════════════ */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(compression({ threshold: 1024 }));
const server = http.createServer(app);

const ALLOWED_ORIGIN = 'https://moonwolf-panel.onrender.com';

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
  maxHttpBufferSize: 20 * 1024 * 1024,
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

io.use((socket, next) => {
  if (!socketConnectionAllowed(socket)) {
    console.warn('[socket] Conexión rechazada por rate limit:', socket.handshake.address);
    return next(new Error('rate_limited'));
  }

  const auth = socket.handshake.auth || {};
  const role = auth.role;

  if (role === 'local-agent') {
    const token = String(auth.token || '');

    if (!LOCAL_AGENT_TOKEN || !timingSafeEqualStr(token, LOCAL_AGENT_TOKEN)) {
      console.warn('[socket] local-agent rechazado: token inválido o no configurado');
      releaseSocketConnection(socket);
      return next(new Error('unauthorized'));
    }

    socket.data.role = 'local-agent';
    return next();
  }

  if (role === 'agent') {
    const agentId = String(auth.agentId || '');
    const token = String(auth.token || '');

    if (!agentId || !token) {
      console.warn('[socket] agent rechazado: faltan agentId o token');
      releaseSocketConnection(socket);
      return next(new Error('unauthorized'));
    }

    if (agentId.length < 16 || token.length < 32 || !verifyOrRegisterAgent(agentId, token)) {
      console.warn('[socket] agent rechazado: credenciales inválidas para agentId:', agentId || '(vacío)');
      releaseSocketConnection(socket);
      return next(new Error('unauthorized'));
    }

    socket.data.role = 'agent';
    socket.data.agentId = agentId;
    socket.data.agentToken = token;
    return next();
  }

  if (role === 'panel') {
    const session = verifyPanelSession(auth.session);

    if (!session) {
      releaseSocketConnection(socket);
      return next(new Error('unauthorized'));
    }

    socket.data.role = 'panel';
    socket.data.agentId = session.agentId;
    socket.data.sessionExp = session.exp;
    socket.data.permission = session.permission || 'admin';
    socket.data.kind = session.kind || 'owner';
    socket.data.shareTokenId = session.shareTokenId || null;
    return next();
  }

  releaseSocketConnection(socket);
  return next(new Error('Rol no válido.'));
});

const PUBLIC_ASSETS = [
  'index.html',
  'dashboard.js',
  'styles.css',
];

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

for (const asset of PUBLIC_ASSETS) {
  app.get('/' + asset, (_req, res) => {
    res.setHeader('Cache-Control', asset === 'index.html' ? 'no-cache' : 'public, max-age=300');
    res.sendFile(path.join(__dirname, asset));
  });
}

app.use(express.json({ limit: '10mb' }));

/* ══════════════════════════════════════════════
   RATE LIMIT
/* ══════════════════════════════════════════════ */   
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

  const operationRule = operationRateLimited(req.ip, req.method, req.path);
  if (operationRule) {
    const current = operationHits.get(`${req.ip}:${operationRule.id}`);
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      ok: false,
      error: `Límite de operación alcanzado para ${operationRule.id}. Espera unos segundos.`,
    });
  }

  next();
});

/* ══════════════════════════════════════════════
   PAIRING
   ══════════════════════════════════════════════ */
const CLOUD_ONLY_ROUTE = /^\/(pair|share-tokens)(\/|$)/;

app.use('/api', (req, res, next) => {
  if (LOCAL_AGENT_TOKEN) {
    if (CLOUD_ONLY_ROUTE.test(req.path)) return res.status(404).json({ ok: false, error: 'No encontrado.' });

    if (!timingSafeEqualStr(req.get('x-moonwolf-token'), LOCAL_AGENT_TOKEN)) {
      return res.status(401).json({ ok: false, error: 'No autorizado.' });
    }

    return next();
  }

  if (!CLOUD_ONLY_ROUTE.test(req.path)) {
    return res.status(404).json({ ok: false, error: 'No encontrado.' });
  }

  next();
});

app.post('/api/pair', (req, res) => {
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos, espera unos minutos.' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  let pairing = null;
  let share = null;
  let sessionOptions = { permission: 'admin', kind: 'owner' };

  if (/^MW-SHARE-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(code)) {
    share = findShareToken(code);

    if (!share) {
      return res.status(401).json({
        ok: false,
        error: 'Token compartido inválido, revocado o caducado.',
      });
    }

    pairing = { agentId: share.agentId };
    sessionOptions = {
      permission: share.permission,
      kind: 'share',
      shareTokenId: share.id,
      expiresAt: share.expiresAt,
    };
  } else {
    pairing = consumePairingCode(code);

    if (!pairing) {
      return res.status(401).json({
        ok: false,
        error: 'Código de emparejamiento inválido o caducado.',
      });
    }
  }

  const agentSocket = agentSockets.get(pairing.agentId);

  if (!agentSocket?.connected) {
    return res.status(409).json({
      ok: false,
      error: 'El MoonWolf Agent ya no está conectado.',
    });
  }

  const session = createPanelSession(pairing.agentId, sessionOptions);

  if (!share) {
    agentSocket.emit('pairing_consumed');
  }

  return res.json({
    ok: true,
    session,
    permission: sessionOptions.permission,
    kind: sessionOptions.kind,
    agent: {
      id: pairing.agentId,
      online: true,
    },
  });
});

/* ══════════════════════════════════════════════
   SHARE TOKENS
   ══════════════════════════════════════════════ */
app.get('/api/share-tokens', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!canManageShareTokens(session)) {
    return res.status(403).json({ ok: false, error: 'Necesitas el permiso Administrador para gestionar accesos compartidos.' });
  }

  const tokens = loadShareTokens()
    .filter(item => item.agentId === session.agentId && !item.revokedAt)
    .filter(item => !item.expiresAt || Number(item.expiresAt) > Date.now())
    .map(publicShareToken);

  return res.json({ ok: true, tokens });
});

app.post('/api/share-tokens', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!canManageShareTokens(session)) {
    return res.status(403).json({ ok: false, error: 'Necesitas el permiso Administrador para crear accesos compartidos.' });
  }

  const permission = normalizeSharePermission(req.body?.permission);

  if (!permission) {
    return res.status(400).json({ ok: false, error: 'Permiso no válido.' });
  }

  const expires = String(req.body?.expires || 'never').toLowerCase();
  const expiryMap = {
    '1h': 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  if (expires !== 'never' && !expiryMap[expires]) {
    return res.status(400).json({ ok: false, error: 'Caducidad no válida.' });
  }

  const expiresAt = expires === 'never' ? null : Date.now() + expiryMap[expires];

  try {
    const created = createShareToken(
      session.agentId,
      permission,
      expiresAt,
      req.body?.label
    );

    return res.json({
      ok: true,
      token: created.token,
      access: publicShareToken(created.record),
    });
  } catch (error) {
    console.error('[share-tokens] create:', error.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el acceso compartido.' });
  }
});

app.patch('/api/share-tokens/:id', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!canManageShareTokens(session)) {
    return res.status(403).json({ ok: false, error: 'Necesitas el permiso Administrador para editar accesos compartidos.' });
  }

  const permission = normalizeSharePermission(req.body?.permission);
  if (!permission) {
    return res.status(400).json({ ok: false, error: 'Permiso no válido.' });
  }

  const tokens = loadShareTokens();
  const record = tokens.find(item => item.id === req.params.id && item.agentId === session.agentId);
  if (!record || record.revokedAt || (record.expiresAt && Number(record.expiresAt) <= Date.now())) {
    return res.status(404).json({ ok: false, error: 'Acceso compartido no encontrado.' });
  }

  record.permission = permission;
  saveShareTokens(tokens);

  for (const panel of panelSockets) {
    if (panel.data.shareTokenId === record.id) {
      panel.data.permission = permission;
      panel.emit('session_info', {
        permission,
        kind: panel.data.kind || 'share',
        expiresAt: panel.data.sessionExp,
      });
    }
  }

  return res.json({ ok: true, access: publicShareToken(record) });
});

app.delete('/api/share-tokens/:id', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!canManageShareTokens(session)) {
    return res.status(403).json({ ok: false, error: 'Necesitas el permiso Administrador para revocar accesos compartidos.' });
  }

  const tokens = loadShareTokens();
  const record = tokens.find(item => item.id === req.params.id && item.agentId === session.agentId);

  if (!record || record.revokedAt) {
    return res.status(404).json({ ok: false, error: 'Acceso compartido no encontrado.' });
  }

  record.revokedAt = Date.now();
  saveShareTokens(tokens);

  for (const panel of panelSockets) {
    if (panel.data.shareTokenId === record.id) {
      panel.emit('share_revoked');
      panel.disconnect(true);
    }
  }

  return res.json({ ok: true });
});

/* ══════════════════════════════════════════════
    SERVER
    ══════════════════════════════════════════════ */
const BASE_DIR = RUNTIME_DIR;

if (!fsSync.existsSync(BASE_DIR)) {
  fsSync.mkdirSync(BASE_DIR, { recursive: true });
}

const PLUGINS_DIR = path.join(BASE_DIR, 'plugins');

/* ══════════════════════════════════════════════
   JAVA RUNTIMES
   ══════════════════════════════════════════════ */
const MOONWOLF_APP_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'MoonWolf'
);
const JAVA_RUNTIMES_DIR = process.env.MOONWOLF_RUNTIME_DIR || path.join(MOONWOLF_APP_DIR, 'runtimes');
const JAVA_RUNTIME_VERSIONS = [8, 11, 16, 17, 21, 25];
const JAVA_DOWNLOAD_API = 'https://api.adoptium.net/v3/assets/latest';
const javaInstallPromises = new Map();
const javaPathCache = new Map();

function parseMinecraftVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

function compareMinecraftVersions(a, b) {
  const pa = parseMinecraftVersion(a);
  const pb = parseMinecraftVersion(b);
  if (!pa || !pb) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }

  return 0;
}

function requiredJavaForMinecraft(version) {
  const parsed = parseMinecraftVersion(version);
  if (!parsed) return null;

  if (parsed.major >= 26) return 25;

  if (parsed.major === 1) {
    if (parsed.minor <= 11) return 8;
    if (parsed.minor === 12 || parsed.minor === 13 || parsed.minor === 14 || parsed.minor === 15) return 11;
    if (parsed.minor === 16) return parsed.patch >= 5 ? 16 : 11;
    if (parsed.minor === 17) return 17;
    if (parsed.minor === 18 || parsed.minor === 19) return 17;
    // 1.20.0 – 1.20.4 → Java 17 | 1.20.5+ → Java 21
    if (parsed.minor === 20) return parsed.patch >= 5 ? 21 : 17;
    // 1.21.x → Java 21
    if (parsed.minor === 21) return 21;
  }

  return null;
}

function javaRuntimeDir(javaMajor) {
  return path.join(JAVA_RUNTIMES_DIR, `java${javaMajor}`);
}

function javaExecutablePath(javaMajor) {
  return path.join(javaRuntimeDir(javaMajor), 'bin', 'java.exe');
}

function detectMinecraftVersionFromJarName(jarName) {
  const name = String(jarName || '');
  const matches = name.match(/(?:^|[-_.])((?:1\.\d+(?:\.\d+)?|2[0-9]+(?:\.\d+){0,2}))(?:[-_.]|$)/gi);
  if (!matches?.length) return null;

  for (const raw of matches) {
    const value = raw.replace(/^[-_.]/, '').replace(/[-_.]$/, '');
    if (/^(?:1\.\d+(?:\.\d+)?|2[0-9]+(?:\.\d+){0,2})$/.test(value)) return value;
  }

  return null;
}

function getJavaRuntimeInfo(minecraftVersion) {
  const javaMajor = requiredJavaForMinecraft(minecraftVersion);
  if (!javaMajor) {
    return {
      minecraftVersion: minecraftVersion || null,
      javaMajor: null,
      installed: false,
      executable: null,
      supported: false,
    };
  }

  const executable = javaExecutablePath(javaMajor);

  return {
    minecraftVersion: minecraftVersion || null,
    javaMajor,
    installed: fsSync.existsSync(executable),
    executable,
    supported: true,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MoonWolf-Agent',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al consultar ${url}`);
  }

  return response.json();
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MoonWolf-Agent' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Descarga de Java fallida (HTTP ${response.status})`);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const file = fsSync.createWriteStream(destination);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!file.write(Buffer.from(value))) {
        await new Promise(resolve => file.once('drain', resolve));
      }
    }
  } finally {
    file.end();
    await new Promise(resolve => file.once('close', resolve));
  }
}

async function verifySha256(filePath, expected) {
  if (!expected) return true;

  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex').toLowerCase() === String(expected).toLowerCase();
}

async function findJavaExecutable(rootDir) {
  const direct = path.join(rootDir, 'bin', 'java.exe');
  if (fsSync.existsSync(direct)) return direct;

  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const candidate = path.join(rootDir, entry.name, 'bin', 'java.exe');
    if (fsSync.existsSync(candidate)) return candidate;
  }

  return null;
}

async function ensureJavaRuntime(javaMajor) {
  if (!JAVA_RUNTIME_VERSIONS.includes(Number(javaMajor))) {
    throw new Error(`Java ${javaMajor} no está soportado por el gestor de MoonWolf.`);
  }

  const targetDir = javaRuntimeDir(javaMajor);
  const executable = javaExecutablePath(javaMajor);

  if (fsSync.existsSync(executable)) return executable;

  if (javaInstallPromises.has(javaMajor)) {
    return javaInstallPromises.get(javaMajor);
  }

  const promise = (async () => {
    await fs.mkdir(JAVA_RUNTIMES_DIR, { recursive: true });

    const metadataUrl =
      `${JAVA_DOWNLOAD_API}/${javaMajor}/hotspot` +
      '?architecture=x64&image_type=jdk&os=windows&vendor=eclipse' +
      '&heap_size=normal&project=jdk&release_type=ga';

    broadcastLog(`☕ Java ${javaMajor} no está instalado. Descargando runtime de MoonWolf...`, 'system');

    const assets = await fetchJson(metadataUrl);
    const asset = Array.isArray(assets)
      ? assets.find(item => item?.binary?.package?.link && item?.binary?.package?.checksum)
      : null;

    if (!asset) {
      throw new Error(`No se encontró un JDK Temurin ${javaMajor} compatible para Windows x64.`);
    }

    const archive = path.join(JAVA_RUNTIMES_DIR, `.java${javaMajor}-${Date.now()}.zip`);
    const staging = path.join(JAVA_RUNTIMES_DIR, `.install-java${javaMajor}-${Date.now()}`);

    try {
      await downloadToFile(asset.binary.package.link, archive);
      broadcastLog(`☕ Java ${javaMajor} descargado. Verificando integridad...`, 'system');

      if (!(await verifySha256(archive, asset.binary.package.checksum))) {
        throw new Error(`La verificación SHA-256 de Java ${javaMajor} ha fallado.`);
      }

      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { recursive: true });

      await new Promise((resolve, reject) => {
        const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

        const psCommand =
          `$ErrorActionPreference='Stop'; ` +
          `Expand-Archive -LiteralPath ${psQuote(archive)} ` +
          `-DestinationPath ${psQuote(staging)} -Force`;

        console.log('[java] Expand-Archive →', psCommand);

        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            psCommand,
          ],
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );

        let stderr = '';
        let stdout = '';
        child.stderr.on('data', data => { stderr += String(data); });
        child.stdout.on('data', data => { stdout += String(data); });
        child.on('error', reject);
        child.on('close', code => {
          if (code === 0) return resolve();
          const detail = (stderr || stdout).trim();
          console.warn('[java] PowerShell falló:', detail);
          reject(new Error(detail || `PowerShell terminó con código ${code}`));
        });
      });

      const extractedJava = await findJavaExecutable(staging);
      if (!extractedJava) {
        throw new Error(`El archivo de Java ${javaMajor} no contiene un bin/java.exe válido.`);
      }

      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.mkdir(targetDir, { recursive: true });

      await fs.cp(path.dirname(path.dirname(extractedJava)), targetDir, {
        recursive: true,
        force: true,
      });

      if (!fsSync.existsSync(executable)) {
        const nested = await findJavaExecutable(targetDir);
        if (!nested) {
          throw new Error(`No se pudo preparar correctamente Java ${javaMajor}.`);
        }

        if (nested !== executable) {
          const nestedRoot = path.dirname(path.dirname(nested));
          await fs.rm(targetDir, { recursive: true, force: true });
          await fs.cp(nestedRoot, targetDir, { recursive: true, force: true });
        }
      }

      if (!fsSync.existsSync(executable)) {
        throw new Error(`No se encontró java.exe después de instalar Java ${javaMajor}.`);
      }

      broadcastLog(`☕ Java ${javaMajor} listo: ${executable}`, 'success');
      return executable;
    } finally {
      await fs.rm(archive, { force: true }).catch(() => {});
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  })();

  javaInstallPromises.set(javaMajor, promise);

  try {
    return await promise;
  } finally {
    javaInstallPromises.delete(javaMajor);
  }
}

async function resolveJavaForServer(minecraftVersion) {
  const javaMajor = requiredJavaForMinecraft(minecraftVersion);

  if (!javaMajor) {
    throw new Error(
      `No se puede determinar automáticamente el Java necesario para Minecraft "${minecraftVersion || 'desconocido'}". ` +
      'Indica una versión de Minecraft válida en Startup.'
    );
  }

  const cached = javaPathCache.get(javaMajor);
  if (cached && fsSync.existsSync(cached)) return cached;

  const executable = await ensureJavaRuntime(javaMajor);
  javaPathCache.set(javaMajor, executable);
  return executable;
}


const PORT = Number(process.env.MOONWOLF_PORT || process.env.PORT || 3000);
const PAPER_UA = 'MoonWolfPanel/2.0 (contact@moonwolf.local)';

const STARTUP_DIR = path.join(BASE_DIR, '.moonwolf');
const STARTUP_CONFIG_PATH = path.join(STARTUP_DIR, 'startup.json');
const SERVER_PROPERTIES_PATH = path.join(BASE_DIR, 'server.properties');

const DEFAULT_STARTUP_CONFIG = {
  jar: 'server.jar',
  javaPath: 'java',
  javaMode: 'managed',
  javaOverridePath: '',
  minecraftVersion: '',
  minMemoryMb: 1024,
  maxMemoryMb: 2048,
  extraArgs: '',
  programArgs: '',
  stopCommand: 'stop',
  autoRestartOnCrash: false,
  autoStartOnBoot: false,
};

function loadStartupConfig() {
  try {
    const raw = JSON.parse(fsSync.readFileSync(STARTUP_CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_STARTUP_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_STARTUP_CONFIG };
  }
}

function saveStartupConfig(partial) {
  const next = { ...loadStartupConfig(), ...partial };

  if (!fsSync.existsSync(STARTUP_DIR)) {
    fsSync.mkdirSync(STARTUP_DIR, { recursive: true });
  }

  atomicWriteFileSync(STARTUP_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function safeJarName(name) {
  const value = String(name || '').trim();

  if (
    !value ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    !value.toLowerCase().endsWith('.jar')
  ) {
    return null;
  }

  return value;
}

function safeJavaPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) return null;

  const candidate = path.resolve(raw);
  if (!['java', 'java.exe'].includes(path.basename(candidate).toLowerCase())) return null;

  try {
    const stats = fsSync.lstatSync(candidate);
    const realCandidate = fsSync.realpathSync.native(candidate);
    const comparable = item => process.platform === 'win32'
      ? path.normalize(item).toLowerCase()
      : path.normalize(item);
    if (!stats.isFile() || stats.isSymbolicLink() || comparable(realCandidate) !== comparable(candidate)) {
      return null;
    }
  } catch {
    return null;
  }

  return candidate;
}

function verifyJavaExecutable(javaBin) {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const child = spawn(javaBin, ['-version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = valid => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Boolean(valid));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && /\bversion\s+["']?\d/i.test(output)));
  });
}

async function validateJavaOverride(value) {
  const javaBin = safeJavaPath(value);
  if (!javaBin || !(await verifyJavaExecutable(javaBin))) {
    throw new Error('La ruta debe apuntar a un ejecutable Java válido (java o java.exe).');
  }
  return javaBin;
}

function readServerPort() {
  try {
    const content = fsSync.readFileSync(SERVER_PROPERTIES_PATH, 'utf8');
    const match = content.match(/^\s*server-port\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function writeServerPort(port) {
  let content = '';

  try {
    content = fsSync.readFileSync(SERVER_PROPERTIES_PATH, 'utf8');
  } catch {}

  if (/^\s*server-port\s*=.*$/m.test(content)) {
    content = content.replace(/^\s*server-port\s*=.*$/m, `server-port=${port}`);
  } else {
    content = (content.length && !content.endsWith('\n') ? content + '\n' : content) + `server-port=${port}\n`;
  }

  atomicWriteFileSync(SERVER_PROPERTIES_PATH, content, 'utf8');
}

/* ══════════════════════════════════════════════
   PORTS
   ══════════════════════════════════════════════ */
let serverPropertiesCache = null;

function readServerProperties() {
  try {
    const stat = fsSync.statSync(SERVER_PROPERTIES_PATH);
    if (serverPropertiesCache && serverPropertiesCache.mtimeMs === stat.mtimeMs && serverPropertiesCache.size === stat.size) {
      return serverPropertiesCache.values;
    }

    const content = fsSync.readFileSync(SERVER_PROPERTIES_PATH, 'utf8');
    const values = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const match = line.match(/^\s*([^=:#]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1].trim()] = match[2];
    }
    serverPropertiesCache = { mtimeMs: stat.mtimeMs, size: stat.size, values };
    return values;
  } catch {
    serverPropertiesCache = null;
    return {};
  }
}

function writeServerProperties(values) {
  let content = '';
  try { content = fsSync.readFileSync(SERVER_PROPERTIES_PATH, 'utf8'); } catch {}

  const lines = content.split(/\r?\n/);
  const updated = new Set();
  const output = lines.map(line => {
    const match = line.match(/^\s*([^=:#]+)\s*=\s*(.*?)\s*$/);
    if (!match) return line;
    const key = match[1].trim();
    if (!(key in values)) return line;
    updated.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!updated.has(key)) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      output.push(`${key}=${value}`);
    }
  }

  atomicWriteFileSync(
    SERVER_PROPERTIES_PATH,
    output.join('\n').replace(/\n+$/, '') + '\n',
    'utf8'
  );
  serverPropertiesCache = null;
}

function checkLocalPort(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const finish = open => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Boolean(open));
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/* ══════════════════════════════════════════════
   RCON (Minecraft Remote Console)
   ══════════════════════════════════════════════ */
class RconClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.configKey = '';
  }

  close() {
    this.authenticated = false;
    this.buffer = Buffer.alloc(0);
    this.socket?.destroy();
    this.socket = null;
  }

  packet(id, type, body) {
    const bodyBuf = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(12 + bodyBuf.length + 2);
    packet.writeInt32LE(10 + bodyBuf.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    return packet;
  }

  async connect(port, password) {
    const key = `${port}:${password}`;
    if (this.socket && this.authenticated && this.configKey === key) return;

    this.close();
    this.configKey = key;

    await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      let authBuffer = Buffer.alloc(0);
      const finish = error => {
        if (settled) return;
        settled = true;
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve();
        }
      };

      socket.setTimeout(2000);
      socket.once('timeout', () => finish(new Error('RCON timeout')));
      socket.once('error', finish);
      const onAuthData = chunk => {
        authBuffer = Buffer.concat([authBuffer, chunk]);
        if (authBuffer.length < 4) return;
        const size = authBuffer.readInt32LE(0);
        if (authBuffer.length < 4 + size) return;
        const id = authBuffer.readInt32LE(4);
        if (id === -1) return finish(new Error('RCON auth failed'));
        this.socket = socket;
        this.authenticated = true;
        socket.off('data', onAuthData);
        socket.removeAllListeners('timeout');
        socket.setTimeout(0);
        finish();
      };
      socket.on('data', onAuthData);
      socket.connect(port, '127.0.0.1', () => socket.write(this.packet(0, 3, password)));
    });
  }

  exec(port, password, command) {
    const run = this.queue.then(async () => {
      await this.connect(port, password);
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const socket = this.socket;
        const timer = setTimeout(() => {
          this.close();
          reject(new Error('RCON timeout'));
        }, 2000);
        const onData = chunk => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4) {
            const size = buffer.readInt32LE(0);
            if (buffer.length < 4 + size) return;
            const packetId = buffer.readInt32LE(4);
            const body = buffer.slice(12, 4 + size - 2).toString('utf8');
            buffer = buffer.slice(4 + size);
            if (packetId !== id) continue;
            clearTimeout(timer);
            socket.off('data', onData);
            resolve(body);
            return;
          }
        };
        socket.once('error', error => {
          clearTimeout(timer);
          socket.off('data', onData);
          this.close();
          reject(error);
        });
        socket.on('data', onData);
        socket.write(this.packet(id, 2, command));
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const rconClient = new RconClient();

async function queryRconStats() {
  const props = readServerProperties();

  if (String(props['enable-rcon'] || 'false').toLowerCase() !== 'true') {
    return null;
  }

  const port = validPort(props['rcon.port']) || 25575;
  const password = String(props['rcon.password'] || '');

  if (!password) return null;

  try {
    const [listRaw, tpsRaw] = await Promise.all([
      rconClient.exec(port, password, 'list'),
      rconClient.exec(port, password, 'tps'),
    ]);

    const clean = value => String(value || '').replace(/§[0-9a-fk-or]/gi, '').trim();

    const listMatch = clean(listRaw).match(/There are (\d+) of a max of (\d+) players online/i);
    const tpsMatch = clean(tpsRaw).match(/TPS from last [^:]+:\s*([\d.]+)/i);

    return {
      players: listMatch ? Number(listMatch[1]) : 0,
      maxPlayers: listMatch ? Number(listMatch[2]) : 0,
      tps: tpsMatch ? Number(tpsMatch[1]) : 20,
    };
  } catch {
    return null;
  }
}

let portsCache = null;

app.get('/api/ports', async (_req, res) => {
  if (portsCache && Date.now() - portsCache.createdAt < 5000) {
    return res.json(portsCache.payload);
  }

  try {
    const props = readServerProperties();
    const serverPort = validPort(props['server-port']) || readServerPort() || 25565;
    const queryEnabled = String(props['enable-query'] || 'false').toLowerCase() === 'true';
    const queryPort = validPort(props['query.port']) || 25565;
    const rconEnabled = String(props['enable-rcon'] || 'false').toLowerCase() === 'true';
    const rconPort = validPort(props['rcon.port']) || 25575;

    const definitions = [
      {
        id: 'minecraft',
        name: 'Minecraft',
        description: 'Puerto principal usado por los jugadores para conectarse al servidor.',
        protocol: 'TCP',
        port: serverPort,
        enabled: true,
      },
      {
        id: 'query',
        name: 'Query',
        description: queryEnabled
          ? 'Game Query de Minecraft habilitado.'
          : 'Game Query deshabilitado en server.properties.',
        protocol: 'UDP',
        port: queryPort,
        enabled: queryEnabled,
      },
      {
        id: 'rcon',
        name: 'RCON',
        description: rconEnabled
          ? 'Control remoto de consola habilitado.'
          : 'RCON deshabilitado en server.properties.',
        protocol: 'TCP',
        port: rconPort,
        enabled: rconEnabled,
      },
    ];

    const ports = await Promise.all(definitions.map(async item => ({
      ...item,
      state: !item.enabled
        ? 'disabled'
        : item.protocol === 'TCP'
          ? (await checkLocalPort(item.port) ? 'open' : 'closed')
          : 'configured',
    })));

    const payload = {
      ok: true,
      ports,
      properties: {
        enableQuery: queryEnabled,
        enableRcon: rconEnabled,
        serverPort,
        queryPort,
        rconPort,
        hasRconPassword: Boolean(String(props['rcon.password'] || '')),
      },
    };
    portsCache = { createdAt: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/ports', (req, res) => {
  portsCache = null;
  const body = req.body || {};
  const serverPort = validPort(body.serverPort);
  const queryPort = validPort(body.queryPort);
  const rconPort = validPort(body.rconPort);

  if (!serverPort || !queryPort || !rconPort) {
    return fail(res, 'Todos los puertos deben estar entre 1 y 65535');
  }

  const enableQuery = Boolean(body.enableQuery);
  const enableRcon = Boolean(body.enableRcon);
  const current = readServerProperties();
  const newPassword = String(body.rconPassword || '').trim();
  const rconPassword = newPassword || String(current['rcon.password'] || '');

  if (enableRcon && !rconPassword) {
    return fail(res, 'Debes indicar una contraseña para activar RCON');
  }

  try {
    writeServerProperties({
      'server-port': serverPort,
      'query.port': queryPort,
      'enable-query': enableQuery,
      'rcon.port': rconPort,
      'enable-rcon': enableRcon,
      ...(rconPassword ? { 'rcon.password': rconPassword } : {}),
    });

    ok(res, {
      serverPort,
      queryPort,
      rconPort,
      enableQuery,
      enableRcon,
      restartRequired: true,
    });
  } catch (e) {
    fail(res, e.message);
  }
});

function safePath(rel) {
  if (typeof rel !== 'string') return null;

  let base;
  try {
    // Canonicalizar la raíz permite aceptar una BASE_DIR que sea un alias,
    // pero impide que sus descendientes salgan del árbol real permitido.
    base = fsSync.realpathSync.native(path.resolve(BASE_DIR));
  } catch {
    return null;
  }

  const comparable = value => process.platform === 'win32'
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  const comparableBase = comparable(base);
  const full = path.resolve(path.join(base, rel));
  const comparableFull = comparable(full);
  if (!(comparableFull.startsWith(comparableBase + path.sep) || comparableFull === comparableBase)) {
    return null;
  }

  let current = base;
  const relative = path.relative(base, full);
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const stats = fsSync.lstatSync(current);
      const realCurrent = fsSync.realpathSync.native(current);

      // isSymbolicLink cubre symlinks; la comparación con realpath detecta
      // junctions y otros reparse points que redirigen el árbol en Windows.
      if (stats.isSymbolicLink() || comparable(realCurrent) !== comparable(current)) return null;
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      return null;
    }
  }
  return full;
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

async function apiFetchText(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, { headers: { 'User-Agent': PAPER_UA } });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} -> ${url}`);
  }

  return res.text();
}

function xmlValues(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))]
    .map(match => match[1].trim())
    .filter(Boolean);
}

const DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_MAX_REDIRECTS = 5;
const DOWNLOAD_ALLOWED_HOSTS = Object.freeze([
  'api.modrinth.com',
  'modrinth.com',
  'spiget.org',
  'papermc.io',
  'neoforged.net',
  'minecraftforge.net',
  'fabricmc.net',
  'mojang.com',
  'github.com',
  'githubusercontent.com',
  'spigotmc.org',
]);

function isAllowedDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHost = DOWNLOAD_ALLOWED_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
  if (parsed.protocol !== 'https:' || !allowedHost || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;
  return parsed;
}

function safeDownloadDestination(dest) {
  const relative = path.relative(BASE_DIR, path.resolve(String(dest || '')));
  const safe = safePath(relative);
  if (!safe || path.resolve(safe) !== path.resolve(dest)) return null;
  return safe;
}

async function downloadFile(url, dest) {
  const { default: fetch } = await import('node-fetch');
  const finalDest = safeDownloadDestination(dest);
  if (!finalDest) throw new Error('Destino de descarga no permitido.');

  let currentUrl = isAllowedDownloadUrl(url);
  if (!currentUrl) throw new Error('URL de descarga no permitida.');

  let response;
  for (let redirect = 0; redirect <= DOWNLOAD_MAX_REDIRECTS; redirect++) {
    response = await fetch(currentUrl, {
      headers: { 'User-Agent': PAPER_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirect === DOWNLOAD_MAX_REDIRECTS) {
      throw new Error('Demasiadas redirecciones o redirección inválida.');
    }
    currentUrl = isAllowedDownloadUrl(new URL(location, currentUrl).toString());
    if (!currentUrl) throw new Error('Redirección de descarga no permitida.');
  }

  if (!response?.ok || !response.body) {
    throw new Error(`Download failed: ${response?.status || 0} ${response?.statusText || ''}`.trim());
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > DOWNLOAD_MAX_BYTES) {
    throw new Error('La descarga supera el tamaño máximo permitido.');
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error('La descarga devolvió HTML en lugar de un archivo. Instálalo manualmente desde su página de recursos.');
  }

  const tempDest = `${finalDest}.download-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  let bytes = 0;
  let head = Buffer.alloc(0);
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      head = Buffer.concat([head, chunk.subarray(0, Math.max(0, 512 - head.length))]);
      if (bytes > DOWNLOAD_MAX_BYTES) {
        return callback(new Error('La descarga supera el tamaño máximo permitido.'));
      }
      callback(null, chunk);
    },
    flush(callback) {
      const textHead = head.toString('utf8').trim().toLowerCase();
      if (textHead.startsWith('<!doctype html') || textHead.startsWith('<html') || textHead.startsWith('<head')) {
        return callback(new Error('La descarga devolvió HTML en lugar de un archivo. Instálalo manualmente desde su página de recursos.'));
      }
      callback();
    },
  });

  try {
    await pipeline(response.body, limiter, fsSync.createWriteStream(tempDest, { flags: 'wx' }));
    await fs.rename(tempDest, finalDest);
  } catch (error) {
    await fs.rm(tempDest, { force: true }).catch(() => {});
    throw error;
  }
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
const agentSockets = new Map();
const panelSockets = new Set();
const agentCache = new Map();
const AGENT_EVENTS = new Set(['status', 'log', 'log_batch', 'stats']);

const LOCAL_AGENT_ROOM = 'local-agent';
const LOG_BATCH_DELAY_MS = 50;
let pendingLogBatch = [];
let logBatchTimer = null;
const agentRoom  = id => `agent:${id}`;
const panelsRoom = id => `panels:${id}`;

function emitToAgentPanels(agentId, event, payload) {
  io.to(panelsRoom(agentId)).emit(event, payload);
}

function agentIsOnline(agentId) {
  return Boolean(agentSockets.get(agentId)?.connected);
}

io.on('connection', socket => {
  console.log('Cliente conectado:', socket.id, socket.data.role, socket.data.agentId || '');

  if (socket.data.role === 'local-agent') {
    socket.join(LOCAL_AGENT_ROOM);
    socket.emit('status', lastStatus);
    socket.once('disconnect', () => releaseSocketConnection(socket));
    console.log('🖥️ Agent local conectado:', socket.id);
    return;
  }

  if (socket.data.role === 'agent') {
    const agentId = socket.data.agentId;
    const previous = agentSockets.get(agentId);

    if (previous && previous !== socket) {
      console.warn(
        '[socket] Colisión de agentId: expulsando conexión anterior',
        agentId,
        'anterior=', previous.id,
        'nueva=', socket.id
      );
      previous.disconnect(true);
    }

    agentSockets.set(agentId, socket);
    socket.join(agentRoom(agentId));
    console.log('🌙 MoonWolf Agent conectado:', agentId, socket.id);

    socket.on('pairing_create', () => {
      if (!socketEventAllowed(socket, 'pairing_create', 6)) return;
      const pairing = createPairingCode(agentId);
      console.log(
        '[pairing] Código creado:',
        agentId,
        'socket=', socket.id,
        'expira=', new Date(pairing.expiresAt).toISOString()
      );
      socket.emit('pairing_ready', {
        ...pairing,
        ttlMs: PAIRING_TTL_MS,
      });
    });

    socket.on('event', event => {
      if (!socketEventAllowed(socket, 'event', 240)) return;
      if (!event?.name) return;
      if (!AGENT_EVENTS.has(event.name)) return;

      const cache = agentCache.get(agentId) || { status: null, stats: null, logs: [] };

      if (event.name === 'status') cache.status = event.payload;
      else if (event.name === 'stats') cache.stats = event.payload;
      else {
        const entries = event.name === 'log_batch' && Array.isArray(event.payload)
          ? event.payload
          : [event.payload];
        cache.logs.push(...entries);
        if (cache.logs.length > 300) cache.logs.splice(0, cache.logs.length - 300);
      }

      agentCache.set(agentId, cache);
      emitToAgentPanels(agentId, event.name, event.payload);
    });

    socket.on('rpc_result', result => {
      if (!socketEventAllowed(socket, 'rpc_result', 240)) return;
      if (!result?.id) return;

      for (const panel of panelSockets) {
        if (
          panel.data.agentId === agentId &&
          panel.data.pendingRpc?.has(result.id)
        ) {
          panel.data.pendingRpc.delete(result.id);
          panel.emit('rpc_result', result);
          break;
        }
      }
    });

    const notifyAgentState = online => {
      emitToAgentPanels(agentId, 'cloud_ready', { agentOnline: online });
      emitToAgentPanels(agentId, 'agent_status', { online });
    };

    notifyAgentState(true);

    socket.on('disconnect', reason => {
      releaseSocketConnection(socket);
      if (agentSockets.get(agentId) === socket) {
        agentSockets.delete(agentId);
        notifyAgentState(false);
      }

      console.log('🌙 MoonWolf Agent desconectado:', agentId, socket.id, 'motivo=', reason || 'sin-motivo');
    });

    return;
  }

  if (socket.data.role === 'panel') {
    socket.data.pendingRpc = new Set();
    panelSockets.add(socket);
    socket.join(panelsRoom(socket.data.agentId));

    const agentId = socket.data.agentId;
    const online = agentIsOnline(agentId);
    const sessionTimer = setTimeout(() => {
      socket.disconnect(true);
    }, Math.max(1000, socket.data.sessionExp - Date.now()));

    console.log('🖥️ Panel conectado:', socket.id, '->', agentId);

    socket.emit('cloud_ready', { agentOnline: online });
    socket.emit('agent_status', { online });

    const cached = online ? agentCache.get(agentId) : null;

    if (cached) {
      socket.emit('history', cached.logs);
      if (cached.status) socket.emit('status', cached.status);
      if (cached.stats) socket.emit('stats', cached.stats);
    }
    socket.emit('session_info', {
      permission: socket.data.permission || 'admin',
      kind: socket.data.kind || 'owner',
      expiresAt: socket.data.sessionExp,
    });

    socket.on('rpc', request => {
      const isUploadChunk = String(request?.path || '').startsWith('/api/files/upload-chunk');
      const rpcLimit = isUploadChunk ? 2000 : 120;

      if (!socketEventAllowed(socket, 'rpc', rpcLimit)) {
        return socket.emit('rpc_result', {
          id: request?.id || null,
          ok: false,
          status: 429,
          contentType: 'application/json',
          bodyBase64: Buffer.from(JSON.stringify({
            ok: false,
            error: 'Demasiadas solicitudes en tiempo real. Espera un momento.',
          })).toString('base64'),
        });
      }

      const rejectRpc = (status, message) => socket.emit('rpc_result', {
        id: request?.id || null,
        ok: false,
        status,
        contentType: 'application/json',
        bodyBase64: Buffer.from(JSON.stringify({ ok: false, error: message })).toString('base64'),
      });

      if (!request || typeof request !== 'object') return;

      let rpcUrl;

      try {
        rpcUrl = new URL(String(request.path || ''), 'http://moonwolf.invalid');
      } catch {
        return rejectRpc(400, 'Petición no válida.');
      }

      if (rpcUrl.origin !== 'http://moonwolf.invalid' || !rpcUrl.pathname.startsWith('/api/')) {
        return rejectRpc(400, 'Ruta no válida.');
      }

      request.path = rpcUrl.pathname + rpcUrl.search;
      request.method = String(request.method || 'GET').toUpperCase();

      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        return rejectRpc(400, 'Método no válido.');
      }

      if (socket.data.kind === 'share') {
        const share = loadShareTokens().find(item => item.id === socket.data.shareTokenId && item.agentId === agentId);

        if (!share || share.revokedAt || (share.expiresAt && Number(share.expiresAt) <= Date.now())) {
          socket.emit('share_revoked');
          return socket.disconnect(true);
        }

        socket.data.permission = normalizeSharePermission(share.permission) || 'read';
        if (!permissionAllows(socket.data.permission, requiredPermission(request?.method, request?.path))) {
          return socket.emit('rpc_result', {
            id: request?.id || null,
            ok: false,
            status: 403,
            contentType: 'application/json',
            bodyBase64: Buffer.from(JSON.stringify({
              ok: false,
              error: 'No tienes permisos para realizar esta acción.',
            })).toString('base64'),
          });
        }
      }

      const agentSocket = agentSockets.get(agentId);

      if (!agentSocket?.connected) {
        return socket.emit('rpc_result', {
          id: request?.id || null,
          ok: false,
          status: 503,
          contentType: 'application/json',
          bodyBase64: Buffer.from(JSON.stringify({
            ok: false,
            error: 'MoonWolf Agent no está conectado.',
          })).toString('base64'),
        });
      }

      const id = request?.id;
      if (!id) return;
      if (socket.data.pendingRpc.size >= 100) {
        return rejectRpc(429, 'Demasiadas solicitudes pendientes. Espera a que terminen algunas operaciones.');
      }

      socket.data.pendingRpc.add(id);
      agentSocket.emit('rpc', request);
    });

    socket.on('disconnect', () => {
      releaseSocketConnection(socket);
      clearTimeout(sessionTimer);
      panelSockets.delete(socket);
      socket.data.pendingRpc?.clear();
      console.log('🖥️ Panel desconectado:', socket.id);
    });

    return;
  }

  socket.on('disconnect', () => {
    releaseSocketConnection(socket);
    console.log('Cliente desconectado:', socket.id);
  });
});

/* ══════════════════════════════════════════════
    FILES
    ══════════════════════════════════════════════ */
app.get('/api/files', async (req, res) => {
  const fullPath = safePath(req.query.dir || '');

  if (!fullPath) {
    return fail(res, 'Ruta no permitida');
  }

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter(entry => !entry.name.startsWith('.'))
        .map(async entry => {
          const stats = await fs.stat(path.join(fullPath, entry.name));

          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : entry.name.endsWith('.jar') ? 'jar' : entry.name.endsWith('.log') ? 'log' : 'file',
            size: stats.isDirectory() ? '-' : (stats.size / 1024 / 1024).toFixed(2) + ' MB',
            date: stats.mtime.toLocaleString('es-ES'),
          };
        })
    );

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
    await atomicWriteFile(full, content, 'utf-8');
    ok(res);
  } catch {
    fail(res, 'No se puede guardar');
  }
});

/* ═════════════
    STARTUP
    ════════════ */
app.get('/api/startup', async (_req, res) => {
  try {
    const entries = await fs.readdir(BASE_DIR, { withFileTypes: true });
    const jars = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const config = loadStartupConfig();
    const detectedVersion =
      config.minecraftVersion ||
      detectMinecraftVersionFromJarName(config.jar) ||
      detectMinecraftVersionFromJarName(jars.find(jar => jar === config.jar));

    const runtime = getJavaRuntimeInfo(detectedVersion);

    ok(res, {
      config: { ...config, minecraftVersion: detectedVersion || '' },
      jars,
      serverPort: readServerPort(),
      javaRuntime: runtime,
    });
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/startup', async (req, res) => {
  const {
    jar,
    javaPath,
    javaMode,
    javaOverridePath,
    minecraftVersion,
    minMemoryMb,
    maxMemoryMb,
    extraArgs,
    programArgs,
    stopCommand,
    autoRestartOnCrash,
    autoStartOnBoot,
    serverPort,
  } = req.body || {};

  const safeJar = safeJarName(jar);
  if (!safeJar) {
    return fail(res, 'Nombre de archivo .jar no válido');
  }

  if (!fsSync.existsSync(path.join(BASE_DIR, safeJar))) {
    return fail(res, `No se encontró "${safeJar}" en la carpeta del servidor`);
  }

  const min = Number(minMemoryMb);
  const max = Number(maxMemoryMb);

  if (!Number.isFinite(min) || min < 256 || !Number.isFinite(max) || max < min) {
    return fail(res, 'Valores de memoria no válidos');
  }

  let portNum = null;

  if (serverPort !== undefined && serverPort !== null && String(serverPort).trim() !== '') {
    portNum = Number(serverPort);

    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return fail(res, 'Puerto del servidor no válido (1-65535)');
    }
  }

  try {
    const mode = String(javaMode || '').trim() === 'override' ? 'override' : 'managed';
    const configuredJava = mode === 'override'
      ? await validateJavaOverride(javaOverridePath || javaPath)
      : 'java';
    const config = saveStartupConfig({
      jar: safeJar,
      javaPath: configuredJava,
      javaMode: mode,
      javaOverridePath: mode === 'override' ? configuredJava : '',
      minecraftVersion: String(minecraftVersion || '').trim(),
      minMemoryMb: Math.round(min),
      maxMemoryMb: Math.round(max),
      extraArgs: String(extraArgs || '').trim(),
      programArgs: programArgs === undefined ? loadStartupConfig().programArgs : String(programArgs || '').trim(),
      stopCommand: String(stopCommand || '').trim() || 'stop',
      autoRestartOnCrash: Boolean(autoRestartOnCrash),
      autoStartOnBoot: Boolean(autoStartOnBoot),
    });

    if (portNum !== null) {
      writeServerPort(portNum);
    }

    ok(res, { config, serverPort: readServerPort() });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ═════════════════════════════════════
    DATABASE (MySQL / MariaDB)
    ════════════════════════════════════ */
let mysql = null;

function getMysql() {
  return mysql || (mysql = require('mysql2/promise'));
}

const MYSQL_HOST = process.env.MOONWOLF_MYSQL_HOST || 'localhost';
const MYSQL_PORT = Number(process.env.MOONWOLF_MYSQL_PORT || 3306);
const MYSQL_ROOT_USER = process.env.MOONWOLF_MYSQL_USER || 'root';
const MYSQL_ROOT_PASSWORD = process.env.MOONWOLF_MYSQL_PASSWORD || '';

const DATABASES_STORE_PATH = path.join(STARTUP_DIR, 'databases.json');
const MYSQL_SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const DB_NAME_RE = /^[A-Za-z0-9_]{1,48}$/;

let mysqlPool = null;

function getMysqlPool() {
  if (mysqlPool) return mysqlPool;

  mysqlPool = getMysql().createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_ROOT_USER,
    password: MYSQL_ROOT_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
  });

  return mysqlPool;
}

function loadDatabasesStore() {
  try {
    const raw = JSON.parse(fsSync.readFileSync(DATABASES_STORE_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveDatabasesStore(list) {
  if (!fsSync.existsSync(STARTUP_DIR)) {
    fsSync.mkdirSync(STARTUP_DIR, { recursive: true });
  }

  atomicWriteFileSync(DATABASES_STORE_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function generateDbPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

app.get('/api/databases/status', async (_req, res) => {
  try {
    const pool = getMysqlPool();
    await pool.query('SELECT 1');
    ok(res, { connected: true, host: MYSQL_HOST, port: MYSQL_PORT });
  } catch (e) {
    ok(res, { connected: false, error: e.message, host: MYSQL_HOST, port: MYSQL_PORT });
  }
});

app.get('/api/databases', async (_req, res) => {
  try {
    const pool = getMysqlPool();
    const [rows] = await pool.query(
      `SELECT
         s.SCHEMA_NAME AS name,
         COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes,
         COUNT(t.TABLE_NAME) AS tableCount
       FROM information_schema.SCHEMATA s
       LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
       GROUP BY s.SCHEMA_NAME
       ORDER BY s.SCHEMA_NAME`
    );

    const store = loadDatabasesStore();
    const databases = rows
      .filter(row => !MYSQL_SYSTEM_DBS.has(row.name))
      .map(row => {
        const meta = store.find(item => item.database === row.name);

        return {
          name: row.name,
          sizeMb: (Number(row.sizeBytes) / 1024 / 1024).toFixed(2),
          tables: Number(row.tableCount),
          user: meta?.user || null,
          createdAt: meta?.createdAt || null,
        };
      });

    ok(res, { databases });
  } catch (e) {
    fail(res, `No se pudo conectar a MySQL: ${e.message}`);
  }
});

app.post('/api/databases', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const createUser = req.body?.createUser !== false;

  if (!DB_NAME_RE.test(name)) {
    return fail(res, 'Nombre no válido. Usa solo letras, números y guion bajo (máx. 48 caracteres).');
  }

  if (MYSQL_SYSTEM_DBS.has(name.toLowerCase())) {
    return fail(res, 'Ese nombre está reservado para MySQL.');
  }

  try {
    const pool = getMysqlPool();
    const [existing] = await pool.query('SHOW DATABASES LIKE ?', [name]);

    if (existing.length) {
      return fail(res, 'Ya existe una base de datos con ese nombre.');
    }

    await pool.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    let credentials = null;

    if (createUser) {
      const username = name.slice(0, 32);
      const password = generateDbPassword();

      await pool.query('CREATE USER IF NOT EXISTS ?@\'%\' IDENTIFIED BY ?', [username, password]);
      await pool.query("ALTER USER ?@'%' IDENTIFIED BY ?", [username, password]);
      await pool.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'%'`, [username]);
      await pool.query('FLUSH PRIVILEGES');

      credentials = { user: username, password, host: MYSQL_HOST, port: MYSQL_PORT, database: name };

      const store = loadDatabasesStore();
      store.push({ database: name, user: username, createdAt: Date.now() });
      saveDatabasesStore(store);
    }

    ok(res, { name, credentials });
  } catch (e) {
    fail(res, `No se pudo crear la base de datos: ${e.message}`);
  }
});

app.post('/api/databases/:name/reset-password', async (req, res) => {
  const name = String(req.params.name || '').trim();

  if (!DB_NAME_RE.test(name)) {
    return fail(res, 'Nombre no válido.');
  }

  const store = loadDatabasesStore();
  const record = store.find(item => item.database === name);

  if (!record?.user) {
    return fail(res, 'Esta base de datos no tiene un usuario asociado creado por el panel.');
  }

  try {
    const pool = getMysqlPool();
    const password = generateDbPassword();

    await pool.query('ALTER USER ?@\'%\' IDENTIFIED BY ?', [record.user, password]);
    await pool.query('FLUSH PRIVILEGES');

    ok(res, { credentials: { user: record.user, password, host: MYSQL_HOST, port: MYSQL_PORT, database: name } });
  } catch (e) {
    fail(res, `No se pudo restablecer la contraseña: ${e.message}`);
  }
});

app.delete('/api/databases/:name', async (req, res) => {
  const name = String(req.params.name || '').trim();

  if (!DB_NAME_RE.test(name) || MYSQL_SYSTEM_DBS.has(name.toLowerCase())) {
    return fail(res, 'Nombre no válido.');
  }

  try {
    const pool = getMysqlPool();
    await pool.query(`DROP DATABASE \`${name}\``);

    const store = loadDatabasesStore();
    const record = store.find(item => item.database === name);

    if (record?.user) {
      try {
        await pool.query('DROP USER IF EXISTS ?@\'%\'', [record.user]);
        await pool.query('FLUSH PRIVILEGES');
      } catch {}
    }

    saveDatabasesStore(store.filter(item => item.database !== name));

    ok(res);
  } catch (e) {
    fail(res, `No se pudo eliminar la base de datos: ${e.message}`);
  }
});

/* ══════════════════════════════════════════════
    MINECRAFT PROCESS
    ══════════════════════════════════════════════ */
const DONE_RE = /Done \([\d.,]+s\)!|Listening on /;
let mcProcess = null;
let launchPromise = null;
let startTime = null;
let statsTimer = null;
let restarting = false;
let stopRequested = false;
let crashCount = 0;
let lastCrashTime = 0;
let statsBusy = false;
let previousCpuSnapshot = null;

let lastStatus = 'offline';

function getCpuSnapshot() {
  return os.cpus().reduce((snapshot, cpu) => {
    const times = cpu.times || {};
    const idle = Number(times.idle) || 0;
    const total = Object.values(times).reduce((sum, value) => sum + (Number(value) || 0), 0);

    snapshot.idle += idle;
    snapshot.total += total;
    return snapshot;
  }, { idle: 0, total: 0 });
}

function getCpuUsage() {
  const current = getCpuSnapshot();

  if (!previousCpuSnapshot) {
    previousCpuSnapshot = current;
    return 0;
  }

  const idleDelta = current.idle - previousCpuSnapshot.idle;
  const totalDelta = current.total - previousCpuSnapshot.total;
  previousCpuSnapshot = current;

  if (totalDelta <= 0) return 0;

  return Math.round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) * 10) / 10;
}

function broadcastStatus(s) {
  lastStatus = s;
  io.to(LOCAL_AGENT_ROOM).emit('status', s);
}

function broadcastLog(line, type = 'info') {
  pendingLogBatch.push({
    line,
    time: new Date().toLocaleTimeString('es-ES'),
    type,
  });

  if (logBatchTimer) return;
  logBatchTimer = setTimeout(() => {
    const batch = pendingLogBatch;
    pendingLogBatch = [];
    logBatchTimer = null;
    if (batch.length === 1) io.to(LOCAL_AGENT_ROOM).emit('log', batch[0]);
    else if (batch.length) io.to(LOCAL_AGENT_ROOM).emit('log_batch', batch);
  }, LOG_BATCH_DELAY_MS);
}

function startStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
  }

  previousCpuSnapshot = getCpuSnapshot();

  statsTimer = setInterval(async () => {
    if (statsBusy) return;
    if (!mcProcess || mcProcess.exitCode !== null) return;

    statsBusy = true;

    try {
      const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
      const mem = process.memoryUsage();
      const rcon = await queryRconStats();
      const cpuUsage = getCpuUsage();

      io.to(LOCAL_AGENT_ROOM).emit('stats', {
        players: rcon?.players ?? 0,
        maxPlayers: rcon?.maxPlayers ?? 0,
        tps: rcon?.tps ?? 0,
        rconAvailable: Boolean(rcon),
        uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
        processMemory: Math.round(mem.rss / 1024 / 1024),
        sysMemory: {
          used: (mem.rss / 1024 / 1024 / 1024).toFixed(2),
          total: '16.00',
        },
        cpuUsage,
      });
    } finally {
      statsBusy = false;
    }
  }, 5000);
}

async function launchServerInternal() {
  const cfg = loadStartupConfig();
  const jarPath = path.join(BASE_DIR, cfg.jar);

  if (!fsSync.existsSync(jarPath)) {
    broadcastLog(`❌ No se encontró "${cfg.jar}" en: ${BASE_DIR}. Configúralo en Startup.`, 'error');
    broadcastStatus('offline');
    return false;
  }
   
  const minecraftVersion =
    String(cfg.minecraftVersion || '').trim() ||
    detectMinecraftVersionFromJarName(cfg.jar);

  let javaBin;

  try {
    if (cfg.javaMode === 'override' && String(cfg.javaOverridePath || '').trim()) {
      javaBin = await validateJavaOverride(cfg.javaOverridePath);
    } else {
      javaBin = await resolveJavaForServer(minecraftVersion);
    }
  } catch (error) {
    broadcastLog(`❌ No se pudo preparar Java: ${error.message}`, 'error');
    broadcastStatus('offline');
    return false;
  }

  const args = [
    `-Xms${cfg.minMemoryMb}M`,
    `-Xmx${cfg.maxMemoryMb}M`,
    '-Djava.awt.headless=true',
    ...(cfg.extraArgs ? cfg.extraArgs.split(/\s+/).filter(Boolean) : []),
    '-jar', cfg.jar,
    ...(cfg.programArgs ? cfg.programArgs.split(/\s+/).filter(Boolean) : []),
  ];

  stopRequested = false;
   
   broadcastLog(`▶ Lanzando: ${javaBin}`, 'system');
  
   mcProcess = spawn(javaBin, args, {
    cwd: BASE_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  startTime = Date.now();

  mcProcess.stdin.on('error', () => {});

  mcProcess.stdout.on('data', data => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(line => {
      const type = /WARN/i.test(line) ? 'warn' : /ERROR/i.test(line) ? 'error' : DONE_RE.test(line) ? 'success' : 'info';
      broadcastLog(line, type);

      if (DONE_RE.test(line)) {
        broadcastStatus('online');
        startStatsTimer();
      }
    });
  });

  mcProcess.stderr.on('data', data => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(line => broadcastLog(line, 'warn'));
  });

  mcProcess.on('error', err => {
    broadcastLog(`❌ Error al lanzar "${javaBin}": ` + err.message, 'error');
    broadcastStatus('offline');
    mcProcess = null;
  });

  mcProcess.on('close', code => {
    broadcastLog(`⏹ Servidor detenido (código ${code})`, 'system');
    rconClient.close();

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
        launchServer().catch(error => broadcastLog(`❌ Error relanzando servidor: ${error.message}`, 'error'));
      }, 2000);
      return;
    }

    const liveCfg = loadStartupConfig();

    if (!stopRequested && liveCfg.autoRestartOnCrash) {
      const now = Date.now();

      if (now - lastCrashTime < 60_000) {
        crashCount++;
      } else {
        crashCount = 1;
      }

      lastCrashTime = now;

      if (crashCount > 3) {
        broadcastLog('❌ El servidor se ha caído varias veces en poco tiempo. Reinicio automático desactivado temporalmente.', 'error');
        broadcastStatus('offline');
      } else {
        broadcastLog('⚠️ El servidor se cerró inesperadamente. Reiniciando automáticamente en 5s...', 'warn');
        broadcastStatus('starting');
        setTimeout(() => launchServer().catch(error => broadcastLog(`❌ Error en reinicio automático: ${error.message}`, 'error')), 5000);
      }

      return;
    }

    broadcastStatus('offline');
  });

  return true;
}

function launchServer() {
  if (launchPromise) return launchPromise;

  launchPromise = launchServerInternal().finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

app.post('/api/start', (_req, res) => {
  if (launchPromise || (mcProcess && mcProcess.exitCode === null)) {
    return fail(res, 'El servidor ya está en marcha');
  }

  broadcastStatus('starting');
  broadcastLog('🌙 Arrancando servidor...', 'system');

  launchServer().catch(error => {
    broadcastLog(`❌ Error al arrancar: ${error.message}`, 'error');
  });

  ok(res);
});

app.post('/api/stop', (_req, res) => {
  if (!mcProcess || mcProcess.exitCode !== null) {
    return fail(res, 'El servidor no está corriendo');
  }

  stopRequested = true;
  broadcastStatus('stopping');
  broadcastLog('⏹ Enviando comando de parada...', 'system');
  mcProcess.stdin.write(`${loadStartupConfig().stopCommand || 'stop'}\n`);
  ok(res);
});

app.post('/api/restart', (_req, res) => {
  if (!mcProcess || mcProcess.exitCode !== null) {
    return fail(res, 'El servidor no está corriendo');
  }

  stopRequested = true;
  restarting = true;
  broadcastStatus('restarting');
  broadcastLog('↺ Reiniciando servidor...', 'system');
  mcProcess.stdin.write(`${loadStartupConfig().stopCommand || 'stop'}\n`);
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
    SOFTWARE
    ══════════════════════════════════════════════ */
app.get('/api/versions/software', (_req, res) => {
  ok(res, {
    software: [
      { id: 'paper', label: 'Paper', category: 'plugins', color: '#00c8ff', desc: 'Servidor de alto rendimiento compatible con plugins.' },
      { id: 'purpur', label: 'Purpur', category: 'plugins', color: '#aa88ff', desc: 'Fork de Paper con configuración avanzada y soporte de plugins. 1.16+' },
      { id: 'folia', label: 'Folia', category: 'plugins', color: '#00ff88', desc: 'Fork de Paper con multithreading regional y soporte de plugins. 1.20+' },
      { id: 'fabric', label: 'Fabric', category: 'mods', color: '#d4aa70', desc: 'Loader ligero y moderno para servidores con mods. 1.14+' },
      { id: 'velocity', label: 'Velocity', category: 'proxy', color: '#ffcc00', desc: 'Proxy moderno para conectar múltiples servidores.' },
      { id: 'waterfall', label: 'Waterfall', category: 'proxy', color: '#ff8844', desc: 'Proxy basado en BungeeCord.' },
      { id: 'bungeecord', label: 'BungeeCord', category: 'proxy', color: '#ff4455', desc: 'Proxy clásico para redes de servidores.' },
      { id: 'forge', label: 'Forge', category: 'mods', color: '#c0873f', desc: 'Loader clásico para servidores con mods. 1.1+' },
      { id: 'leaf', label: 'Leaf', category: 'plugins', color: '#7bd88f', desc: 'Fork de Paper orientado a rendimiento y estabilidad.' },
      { id: 'leaves', label: 'Leaves', category: 'plugins', color: '#a5d66a', desc: 'Fork experimental de Paper con mejoras de rendimiento.' },
      { id: 'spigot', label: 'Spigot', category: 'plugins', color: '#f0a24b', desc: 'Servidor compatible con plugins; se compila mediante BuildTools.' },
      { id: 'bukkit', label: 'Bukkit', category: 'plugins', color: '#e2b66d', desc: 'API histórica de plugins. Catálogo de versiones legado, sin JAR ejecutable oficial.' },
      { id: 'magma', label: 'Magma', category: 'hybrid', color: '#d66bff', desc: 'Servidor híbrido con soporte para mods NeoForge y plugins.' },
      { id: 'arclight', label: 'Arclight', category: 'hybrid', color: '#ff8f70', desc: 'Servidor híbrido con loaders Fabric y NeoForge.' },
      { id: 'sponge', label: 'Sponge', category: 'hybrid', color: '#8bd3dd', desc: 'Plataforma híbrida para mods y plugins mediante SpongeVanilla.', external: 'https://spongepowered.org/downloads/spongevanilla' },
      { id: 'mohist', label: 'Mohist', category: 'hybrid', color: '#f08a5d', desc: 'Servidor híbrido con soporte para mods Forge y plugins Bukkit.', external: 'https://mohistmc.com/download' },
      { id: 'gale', label: 'Gale', category: 'plugins', color: '#8ecae6', desc: 'Fork de Paper centrado en rendimiento y estabilidad.' },
      { id: 'pufferfish', label: 'Pufferfish', category: 'plugins', color: '#f6bd60', desc: 'Fork de Paper con optimizaciones adicionales.' },
      { id: 'quilt', label: 'Quilt', category: 'mods', color: '#d8a7ff', desc: 'Loader moderno y comunitario para mods.' },
      { id: 'neoforge', label: 'NeoForge', category: 'mods', color: '#ff6d5a', desc: 'Loader moderno para servidores con mods.' },
      { id: 'vanilla', label: 'Vanilla', category: 'vanilla', color: '#c9d8e8', desc: 'Servidor oficial de Mojang sin plugins ni mods. 1.0+' },
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

    if (sw === 'forge') {
      const data = await apiFetch('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
      const versions = Object.keys(data || {}).sort((a, b) => semverCmp(b, a));
      return ok(res, { versions });
    }

    if (sw === 'leaf' || sw === 'leaves') {
      const project = sw === 'leaf' ? 'leaf' : 'leaves';
      const data = await apiFetch(`https://api.${sw === 'leaf' ? 'leafmc.one' : 'leavesmc.org'}/v2/projects/${project}`);
      return ok(res, { versions: Object.keys(data.versions || {}).flatMap(key => data.versions[key]).sort((a, b) => semverCmp(b, a)) });
    }

    if (sw === 'magma') {
      const data = await apiFetch('https://magmafoundation.org/api/versions?limit=0');
      return ok(res, { versions: (data.versions || data || []).map(item => item.version || item).filter(Boolean) });
    }

    if (sw === 'neoforge') {
      const xml = await apiFetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      return ok(res, { versions: xmlValues(xml, 'version').reverse() });
    }

    if (sw === 'spigot') {
      const html = await apiFetchText('https://hub.spigotmc.org/versions/');
      const versions = [...html.matchAll(/href=\"(1\.\d+(?:\.\d+)?\.json)\"/g)]
        .map(match => match[1].replace(/\.json$/, ''))
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort((a, b) => semverCmp(b, a));
      return ok(res, { versions });
    }

    if (sw === 'bukkit') {
      const tags = await apiFetch('https://api.github.com/repos/Bukkit/Bukkit/tags?per_page=100');
      return ok(res, { versions: (tags || []).map(tag => tag.name).filter(Boolean) });
    }

    if (sw === 'arclight') {
      const releases = await apiFetch('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=100');
      const versions = new Set();
      for (const release of releases || []) {
        for (const asset of release.assets || []) {
          const match = String(asset.name || '').match(/^arclight-[^-]+-(1\.\d+(?:\.\d+)*?)-.+\.jar$/);
          if (match) versions.add(match[1]);
        }
      }
      return ok(res, { versions: [...versions].sort((a, b) => semverCmp(b, a)) });
    }

    if (sw === 'bungeecord') {
      const data = await apiFetch(
        'https://hub.spigotmc.org/jenkins/job/BungeeCord/api/json?tree=builds[number,result,timestamp]&pretty=false'
      );
      const versions = (data.builds || [])
        .filter(b => b.result === 'SUCCESS' && Number.isFinite(Number(b.number)))
        .slice(0, 50)
        .map(b => String(b.number));
      return ok(res, { versions });
    }

    if (sw === 'gale') {
      const releases = await apiFetch('https://api.github.com/repos/GaleMC/Gale/releases?per_page=100');
      return ok(res, { versions: (releases || []).map(r => r.tag_name).filter(Boolean) });
    }

    if (sw === 'pufferfish') {
      const releases = await apiFetch('https://api.github.com/repos/pufferfish-gg/Pufferfish/releases?per_page=100');
      let versions = (releases || []).map(r => r.tag_name).filter(Boolean);
      if (!versions.length) {
        const tags = await apiFetch('https://api.github.com/repos/pufferfish-gg/Pufferfish/tags?per_page=100');
        versions = (tags || []).map(tag => tag.name).filter(Boolean);
      }
      if (!versions.length) {
        const branches = await apiFetch('https://api.github.com/repos/pufferfish-gg/Pufferfish/branches?per_page=100');
        versions = (branches || [])
          .map(branch => branch.name)
          .filter(name => /^ver\/\d+\.\d+$/.test(name))
          .map(name => name.replace(/^ver\//, ''));
      }
      return ok(res, { versions });
    }

    if (sw === 'quilt') {
      const data = await apiFetch('https://meta.quiltmc.org/v3/versions/game');
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

    if (sw === 'forge') {
      const data = await apiFetch('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
      const forgeVersions = Array.isArray(data?.[version]) ? data[version].slice().reverse() : [];
      const builds = forgeVersions.map(forgeVersion => ({
        build: forgeVersion,
        channel: 'RELEASE',
        time: null,
        loaderVersion: forgeVersion,
        url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/forge-${encodeURIComponent(forgeVersion)}-installer.jar`,
        sha256: null,
        changes: `Forge ${forgeVersion} para Minecraft ${version}`,
      }));
      return ok(res, { builds, isForge: true });
    }

    if (sw === 'leaf' || sw === 'leaves') {
      const project = sw === 'leaf' ? 'leaf' : 'leaves';
      const host = sw === 'leaf' ? 'api.leafmc.one' : 'api.leavesmc.org';
      const data = await apiFetch(`https://${host}/v2/projects/${project}/versions/${encodeURIComponent(version)}/builds`);
      const builds = (data.builds || data || []).map(item => {
        const artifact = item.downloads?.primary || item.downloads?.application;
        return {
          build: item.build,
          channel: item.channel || (item.promoted ? 'STABLE' : 'EXPERIMENTAL'),
          time: item.time,
          url: artifact?.name ? `https://${host}/v2/projects/${project}/versions/${encodeURIComponent(version)}/builds/${encodeURIComponent(item.build)}/downloads/${encodeURIComponent(artifact.name)}` : null,
          sha256: artifact?.sha256 || null,
          changes: (item.changes || []).map(change => change.summary || change.message || '').filter(Boolean).slice(0, 3).join(' · '),
        };
      }).sort((a, b) => Number(b.build) - Number(a.build));
      return ok(res, { builds });
    }

    if (sw === 'magma') {
      const data = await apiFetch(`https://magmafoundation.org/api/versions/${encodeURIComponent(version)}`);
      const item = data.version ? data : (data.versions || []).find(entry => entry.version === version);
      if (!item) return fail(res, `Build de Magma no encontrada: ${version}`);
      return ok(res, { builds: [{
        build: version,
        channel: item.isStable ? 'STABLE' : 'BETA',
        time: item.createdAt || item.date || null,
        url: item.launcherUrl || item.installerUrl || `https://magmafoundation.org/api/versions/${encodeURIComponent(version)}/download?type=launcher`,
        sha256: null,
        changes: `Magma para Minecraft ${item.minecraftVersion || version}`,
      }] });
    }

    if (sw === 'neoforge') {
      const build = version;
      return ok(res, { builds: [{
        build,
        channel: /-(alpha|beta|rc)/i.test(build) ? 'PRERELEASE' : 'RELEASE',
        time: null,
        url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(build)}/neoforge-${encodeURIComponent(build)}-installer.jar`,
        sha256: null,
        changes: `NeoForge ${build} · instalador oficial`,
      }] });
    }

    if (sw === 'spigot') {
      const data = await apiFetch(`https://hub.spigotmc.org/versions/${encodeURIComponent(version)}.json`);
      return ok(res, { builds: [{
        build: data.name || 'BuildTools',
        channel: 'BUILDTOOLS',
        time: null,
        url: null,
        sha256: data.hashes?.spigot || null,
        installable: false,
        changes: 'Spigot se compila localmente con BuildTools; no existe un JAR de servidor oficial descargable directamente.',
      }] });
    }

    if (sw === 'bukkit') {
      return ok(res, { builds: [{
        build: version,
        channel: 'LEGACY',
        time: null,
        url: null,
        sha256: null,
        installable: false,
        changes: 'Bukkit es una API histórica y no publica un JAR de servidor ejecutable oficial.',
      }] });
    }

    if (sw === 'arclight') {
      const releases = await apiFetch('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=100');
      const builds = [];
      for (const release of releases || []) {
        for (const asset of release.assets || []) {
          const name = String(asset.name || '');
          const match = name.match(/^arclight-([^-]+)-(1\.\d+(?:\.\d+)*?)-(.+)\.jar$/);
          if (!match || match[2] !== version) continue;
          builds.push({
            build: match[3],
            channel: release.prerelease ? 'PRERELEASE' : 'RELEASE',
            time: release.published_at || release.created_at || null,
            url: asset.browser_download_url,
            sha256: asset.digest?.replace(/^sha256:/, '') || null,
            changes: `Arclight ${match[1]} · ${release.name || release.tag_name || ''}`,
          });
        }
      }
      return ok(res, { builds });
    }

    if (sw === 'gale' || sw === 'pufferfish') {
      const repo = sw === 'gale' ? 'GaleMC/Gale' : 'pufferfish-gg/Pufferfish';
      const releases = await apiFetch(`https://api.github.com/repos/${repo}/releases?per_page=100`);
      const release = (releases || []).find(r => r.tag_name === version) || (releases || []).find(r => r.name === version);
      if (!release) {
        return ok(res, { builds: [{
          build: version,
          channel: 'SOURCE',
          time: null,
          url: `https://github.com/${repo}/tree/${encodeURIComponent(version)}`,
          sha256: null,
          installable: false,
          changes: `${sw === 'gale' ? 'Gale' : 'Pufferfish'} publica esta referencia como código fuente; consulta sus instrucciones oficiales de compilación.`,
        }] });
      }
      const builds = (release?.assets || []).filter(asset => /\.jar$/i.test(asset.name)).map(asset => ({
        build: asset.name,
        channel: release.prerelease ? 'PRERELEASE' : 'RELEASE',
        time: release.published_at || release.created_at || null,
        url: asset.browser_download_url,
        sha256: asset.digest?.replace(/^sha256:/, '') || null,
        changes: `${sw === 'gale' ? 'Gale' : 'Pufferfish'} ${version}`,
      }));
      return ok(res, { builds });
    }

    if (sw === 'quilt') {
      const loaders = await apiFetch(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(version)}`);
      const builds = (loaders || []).filter(item => item.loader?.stable).map(item => ({
        build: item.loader.version,
        channel: 'STABLE',
        loaderVersion: item.loader.version,
        time: null,
        url: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-server-launch/${encodeURIComponent(item.loader.version)}/quilt-server-launch-${encodeURIComponent(item.loader.version)}.jar`,
        sha256: item.loader?.hashes?.sha256 || null,
        installable: false,
        changes: `Quilt Loader ${item.loader.version} · consulta la instalación oficial de Quilt`,
      }));
      return ok(res, { builds, isQuilt: true });
    }

    if (sw === 'sponge') {
      return ok(res, { builds: [{
        build: version,
        channel: 'OFFICIAL',
        time: null,
        url: 'https://spongepowered.org/downloads/spongevanilla',
        sha256: null,
        installable: false,
        changes: 'Consulta la descarga oficial de SpongeVanilla para elegir el JAR compatible.',
      }] });
    }

    if (sw === 'bungeecord') {
      const buildNumber = Number(version);
      if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
        return fail(res, `Build de BungeeCord no válida: ${version}`);
      }

      const data = await apiFetch(
        `https://hub.spigotmc.org/jenkins/job/BungeeCord/${buildNumber}/api/json?tree=number,result,timestamp,artifacts[fileName,relativePath]&pretty=false`
      );

      if (data.result !== 'SUCCESS') {
        return fail(res, `BungeeCord #${version} no terminó correctamente`);
      }

      const artifact = (data.artifacts || []).find(a => a.fileName === 'BungeeCord.jar');
      if (!artifact?.relativePath) {
        return fail(res, `No se encontró BungeeCord.jar en el build #${version}`);
      }

      return ok(res, {
        builds: [{
          build: String(data.number),
          channel: 'STABLE',
          time: data.timestamp ? new Date(data.timestamp).toISOString() : null,
          url: `https://hub.spigotmc.org/jenkins/job/BungeeCord/${buildNumber}/artifact/${artifact.relativePath}`,
          sha256: null,
          changes: `BungeeCord build #${data.number}`,
        }],
      });
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
    if (sw === 'neoforge') {
      if (!build) {
        return fail(res, 'versión de NeoForge requerida');
      }

      const javaBin = await resolveJavaForServer(version);
      const instFile = path.join(BASE_DIR, `neoforge-installer-${build}.jar`);
      if (!fsSync.existsSync(instFile)) {
        const neoforgeUrl = url || `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(build)}/neoforge-${encodeURIComponent(build)}-installer.jar`;
        await downloadFile(neoforgeUrl, instFile);
      }

      return ok(res, {
        type: 'neoforge-installer',
        installCmd: `"${javaBin}" -jar "neoforge-installer-${build}.jar" --installServer`,
        jarName: 'run.bat',
        note: `NeoForge ${build} descargado. Ejecuta el comando desde la carpeta del servidor para completar la instalación; después selecciona el archivo de arranque generado en Startup.`,
      });
    }

    if (sw === 'forge') {
      if (!build) {
        return fail(res, 'versión de Forge requerida');
      }

      const javaBin = await resolveJavaForServer(version);
      const instFile = path.join(BASE_DIR, `forge-installer-${build}.jar`);
      if (!fsSync.existsSync(instFile)) {
        const forgeUrl = url || `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(build)}/forge-${encodeURIComponent(build)}-installer.jar`;
        await downloadFile(forgeUrl, instFile);
      }

      return ok(res, {
        type: 'forge-installer',
        installCmd: `"${javaBin}" -jar "forge-installer-${build}.jar" --installServer`,
        jarName: 'run.bat',
        note: `Forge ${build} descargado. Ejecuta el comando desde la carpeta del servidor para completar la instalación; Forge generará los archivos de arranque necesarios.`,
      });
    }

    if (sw === 'fabric') {
      if (!loaderVersion) {
        return fail(res, 'loaderVersion requerido para Fabric');
      }

      const installers = await apiFetch('https://meta.fabricmc.net/v2/versions/installer');
      const inst = installers.find(i => i.stable) || installers[0];

      if (!inst) {
        return fail(res, 'No se encontró installer de Fabric');
      }

      const javaBin = await resolveJavaForServer(version);

      const instFile = path.join(BASE_DIR, `fabric-installer-${inst.version}.jar`);
      if (!fsSync.existsSync(instFile)) {
        await downloadFile(inst.url, instFile);
      }

      return ok(res, {
        type: 'fabric-installer',
        installCmd: `"${javaBin}" -jar "fabric-installer-${inst.version}.jar" server -mcversion ${version} -loader ${loaderVersion} -downloadMinecraft`,
        jarName: 'fabric-server-launch.jar',
        note: `Java ${requiredJavaForMinecraft(version)} gestionado por MoonWolf. Ejecuta el comando generado en tu carpeta de servidor y luego selecciona fabric-server-launch.jar en Startup.`,
      });
    }

    if (!url) {
      return fail(res, 'URL de descarga requerida');
    }

    const currentJar = path.join(BASE_DIR, 'server.jar');
    const tempJar = path.join(
      BASE_DIR,
      `.moonwolf-server-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.download`
    );
    let backupJar = null;
    try {
      await downloadFile(url, tempJar);
      if (fsSync.existsSync(currentJar)) {
        const bakName = `server.bak_${Date.now()}.jar`;
        backupJar = path.join(BASE_DIR, bakName);
        await fs.rename(currentJar, backupJar);
        console.log(`[versions] Backup creado: ${bakName}`);
      }
      await fs.rename(tempJar, currentJar);
    } catch (error) {
      if (backupJar && !fsSync.existsSync(currentJar) && fsSync.existsSync(backupJar)) {
        await fs.rename(backupJar, currentJar).catch(() => {});
      }
      throw error;
    } finally {
      await fs.rm(tempJar, { force: true }).catch(() => {});
    }
    const stats = await fs.stat(currentJar);

    const isProxy = ['velocity', 'waterfall', 'bungeecord'].includes(sw);
    const startupUpdate = {
      jar: 'server.jar',
      software: sw,
      ...(isProxy ? {} : { minecraftVersion: String(version) }),
    };

    saveStartupConfig(startupUpdate);

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
    FILE OPERATIONS
    ══════════════════════════════════════════════ */
let archiver = null;

function getArchiver() {
  return archiver || (archiver = require('archiver'));
}

async function createZipAtomically(zipPath, configureArchive) {
  const tempPath = `${zipPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(tempPath, { flags: 'wx' });
      const archive = getArchiver()('zip', { zlib: { level: 6 } });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      output.once('close', () => finish());
      output.once('error', finish);
      archive.once('error', finish);
      archive.pipe(output);
      try {
        configureArchive(archive);
        void archive.finalize().catch(finish);
      } catch (error) {
        finish(error);
      }
    });

    try {
      await fs.rename(tempPath, zipPath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await fs.rm(zipPath, { force: true });
      await fs.rename(tempPath, zipPath);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const FILE_UPLOAD_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const FILE_UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,120}$/;
const FILE_UPLOAD_DIR = path.join(BASE_DIR, '.moonwolf-uploads');
const FILE_UPLOAD_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.MOONWOLF_UPLOAD_RETENTION_HOURS || 24) * 60 * 60 * 1000
);
const FILE_UPLOAD_CLEANUP_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.MOONWOLF_UPLOAD_CLEANUP_INTERVAL_MINUTES || 60) * 60 * 1000
);
const activeFileUploads = new Set();
const fileUploadLocks = new Map();

function withFileUploadLock(uploadId, task) {
  const previous = fileUploadLocks.get(uploadId) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(task);

  fileUploadLocks.set(uploadId, current);

  return current.finally(() => {
    if (fileUploadLocks.get(uploadId) === current) {
      fileUploadLocks.delete(uploadId);
    }
  });
}

async function cleanupStaleFileUploads() {
  let entries;

  try {
    entries = await fs.readdir(FILE_UPLOAD_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[uploads] No se pudo revisar la carpeta temporal:', error.message);
    }
    return;
  }

  const cutoff = Date.now() - FILE_UPLOAD_RETENTION_MS;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !/\\.(part|json)$/.test(entry.name)) continue;

    const uploadId = entry.name.replace(/\\.(part|json)$/, '');
    if (activeFileUploads.has(uploadId)) continue;

    const uploadPath = path.join(FILE_UPLOAD_DIR, entry.name);

    try {
      const stats = await fs.stat(uploadPath);
      if (stats.mtimeMs > cutoff) continue;

      await fs.rm(uploadPath, { force: true });
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[uploads] No se pudo eliminar ${entry.name}:`, error.message);
      }
    }
  }

  if (removed) {
    console.log(`[uploads] Limpieza automática: ${removed} temporal(es) eliminado(s).`);
  }
}

void cleanupStaleFileUploads();
const fileUploadCleanupTimer = setInterval(
  cleanupStaleFileUploads,
  FILE_UPLOAD_CLEANUP_INTERVAL_MS
);
fileUploadCleanupTimer.unref?.();

app.post(
  '/api/files/upload-chunk',
  express.raw({ type: 'application/octet-stream', limit: 9 * 1024 * 1024 }),
  async (req, res) => {
    const {
      uploadId,
      path: relParam,
      offset: offsetParam,
      totalSize: totalSizeParam,
      final: finalParam,
      overwrite: overwriteParam,
    } = req.query || {};

    const rel = String(relParam || '');
    const uploadIdString = String(uploadId || '');
    const numericOffset = Number(offsetParam);
    const numericTotal = Number(totalSizeParam);
    const final = String(finalParam || '') === '1';
    const overwrite = String(overwriteParam || '') === '1';

    if (!FILE_UPLOAD_ID_RE.test(uploadIdString)) {
      return fail(res, 'Identificador de subida no válido');
    }

    if (!rel.trim()) {
      return fail(res, 'Ruta requerida');
    }

    if (!Number.isSafeInteger(numericOffset) || numericOffset < 0 ||
        !Number.isSafeInteger(numericTotal) || numericTotal < 0) {
      return fail(res, 'Tamaño de subida no válido');
    }

    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (chunk.length > FILE_UPLOAD_MAX_CHUNK_BYTES) {
      return fail(res, 'Bloque demasiado grande');
    }

    const full = safePath(rel);
    if (!full) {
      return fail(res, 'Ruta no permitida');
    }

    if (numericOffset + chunk.length > numericTotal) {
      return fail(res, 'El bloque excede el tamaño indicado');
    }

    const uploadDir = path.resolve(FILE_UPLOAD_DIR);
    const uploadPath = path.join(uploadDir, `${uploadIdString}.part`);
    const manifestPath = path.join(uploadDir, `${uploadIdString}.json`);

    if (!uploadPath.startsWith(uploadDir + path.sep) ||
        !manifestPath.startsWith(uploadDir + path.sep)) {
      return fail(res, 'Ruta temporal no permitida');
    }

    return withFileUploadLock(uploadIdString, async () => {
      activeFileUploads.add(uploadIdString);

      try {
        await fs.mkdir(uploadDir, { recursive: true });

        let manifest = {
          path: rel,
          totalSize: numericTotal,
          chunks: [],
        };

        try {
          const stored = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          if (
            stored &&
            stored.path === rel &&
            stored.totalSize === numericTotal &&
            Array.isArray(stored.chunks)
          ) {
            manifest = stored;
          }
        } catch {}

        if (manifest.path !== rel || manifest.totalSize !== numericTotal) {
          return fail(res, 'La subida no coincide con sus datos originales');
        }

        const chunkEnd = numericOffset + chunk.length;
        const duplicate = manifest.chunks.some(
          item => item.offset === numericOffset && item.end === chunkEnd
        );

        if (!duplicate && chunk.length) {
          const handle = await fs.open(uploadPath, 'a+');
          try {
            await handle.write(chunk, 0, chunk.length, numericOffset);
          } finally {
            await handle.close();
          }

          manifest.chunks.push({ offset: numericOffset, end: chunkEnd });
          manifest.chunks.sort((a, b) => a.offset - b.offset);
        }

        const merged = [];
        for (const item of manifest.chunks) {
          const last = merged[merged.length - 1];
          if (last && item.offset <= last.end) {
            last.end = Math.max(last.end, item.end);
          } else {
            merged.push({ offset: item.offset, end: item.end });
          }
        }

        manifest.chunks = merged;
        await atomicWriteFile(manifestPath, JSON.stringify(manifest), 'utf8');

        const complete = numericTotal === 0
          ? true
          : manifest.chunks.length === 1 &&
            manifest.chunks[0].offset === 0 &&
            manifest.chunks[0].end === numericTotal;

        if (numericTotal === 0) {
          await fs.writeFile(uploadPath, Buffer.alloc(0));
        }

        if (!complete) {
          return ok(res, {
            uploaded: manifest.chunks.reduce((sum, item) => sum + (item.end - item.offset), 0),
            complete: false,
          });
        }

        const finalSize = (await fs.stat(uploadPath)).size;
        if (finalSize !== numericTotal) {
          return fail(res, `Tamaño final incorrecto: ${finalSize}/${numericTotal}`);
        }

        await fs.mkdir(path.dirname(full), { recursive: true });

        if (!overwrite) {
          try {
            await fs.access(full);
            return fail(res, 'Ya existe un archivo con ese nombre');
          } catch {}
        }

        if (overwrite) {
          try { await fs.rm(full, { recursive: true, force: true }); } catch {}
        }

        await fs.rename(uploadPath, full);
        await fs.rm(manifestPath, { force: true });

        return ok(res, {
          uploaded: finalSize,
          complete: true,
          path: rel,
        });
      } catch (e) {
        return fail(res, e.message || 'No se pudo guardar el archivo');
      } finally {
        activeFileUploads.delete(uploadIdString);
      }
    });
  }
);

app.post('/api/files/create', async (req, res) => {
  const { path: dir, name, isDir } = req.body || {};

  if (!name) {
    return fail(res, 'Nombre requerido');
  }

  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return fail(res, 'Nombre no válido');
  }

  const rel = dir ? `${dir}/${name}` : name;
  const full = safePath(rel);

  if (!full) {
    return fail(res, 'Ruta no permitida');
  }

  if (fsSync.existsSync(full)) {
    return fail(res, 'Ya existe un archivo o carpeta con ese nombre');
  }

  try {
    if (isDir) {
      await fs.mkdir(full, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await atomicWriteFile(full, '', 'utf-8');
    }

    ok(res, { path: rel });
  } catch (e) {
    fail(res, e.message);
  }
});

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
    await fs.cp(full, fullDest, { recursive: true });
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
    await createZipAtomically(zipDest, archive => {
      const stat = fsSync.statSync(full);
      if (stat.isDirectory()) {
        archive.directory(full, name);
      } else {
        archive.file(full, { name });
      }
    });

    ok(res, { zipName });
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/files/bulk', async (req, res) => {
  const { action, items, destination = '' } = req.body || {};
  const allowed = new Set(['delete', 'move', 'compress']);
  if (!allowed.has(action) || !Array.isArray(items) || !items.length || items.length > 500) {
    return fail(res, 'Operación masiva no válida');
  }
  if (action === 'move' && typeof destination !== 'string') {
    return fail(res, 'Destino no válido');
  }
  const results = [];
  for (const item of items) {
    const rel = typeof item?.path === 'string' ? item.path : '';
    const full = safePath(rel);
    if (!full || path.resolve(full) === path.resolve(BASE_DIR)) {
      results.push({ path: rel, ok: false, error: 'Ruta no permitida' });
      continue;
    }
    try {
      const stat = await fs.stat(full);
      if (action === 'delete') {
        await fs.rm(full, { recursive: stat.isDirectory(), force: true });
      } else if (action === 'move') {
        const destinationPath = destination
          ? `${destination.replace(/[\\/]+$/, '')}/${path.basename(rel)}`
          : path.basename(rel);
        const fullDest = safePath(destinationPath);
        if (!fullDest || path.resolve(fullDest) === path.resolve(full)) throw new Error('Destino no válido');
        await fs.mkdir(path.dirname(fullDest), { recursive: true });
        await fs.rename(full, fullDest);
      } else {
        const baseName = path.basename(rel).replace(/[^a-zA-Z0-9._-]/g, '_');
        const zipName = `${baseName}.zip`;
        const zipDest = path.join(path.dirname(full), zipName);
        if (!zipDest.startsWith(path.resolve(BASE_DIR) + path.sep)) throw new Error('Destino no válido');
        await createZipAtomically(zipDest, archive => {
          if (stat.isDirectory()) archive.directory(full, baseName);
          else archive.file(full, { name: path.basename(full) });
        });
      }
      results.push({ path: rel, ok: true });
    } catch (error) {
      results.push({ path: rel, ok: false, error: error.message || 'No se pudo completar la operación' });
    }
  }
  const completed = results.filter(result => result.ok).length;
  const failed = results.length - completed;
  return ok(res, { completed, failed, results });
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
      if (path.resolve(full) === path.resolve(BASE_DIR)) {
        return fail(res, 'No se puede eliminar la carpeta raíz del servidor');
      }

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
    BACKUPS
    ══════════════════════════════════════════════ */
const BACKUPS_DIR = path.join(STARTUP_DIR, 'backups');
const BACKUP_NAME_RE = /^[A-Za-z0-9 _.-]{1,80}$/;
const BACKUP_FILE_RE = /^[A-Za-z0-9_.-]{1,120}\.zip$/;

function ensureBackupsDir() {
  if (!fsSync.existsSync(BACKUPS_DIR)) {
    fsSync.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function safeBackupPath(filename) {
  if (!BACKUP_FILE_RE.test(filename) || filename.includes('..')) {
    return null;
  }

  return path.join(BACKUPS_DIR, filename);
}

app.get('/api/backups', async (_req, res) => {
  try {
    ensureBackupsDir();

    const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
        .map(async entry => {
          const stats = await fs.stat(path.join(BACKUPS_DIR, entry.name));

          return {
            name: entry.name,
            sizeMb: (stats.size / 1024 / 1024).toFixed(2),
            createdAt: stats.mtime.getTime(),
            date: stats.mtime.toLocaleString('es-ES'),
          };
        })
    );

    backups.sort((a, b) => b.createdAt - a.createdAt);
    ok(res, { backups });
  } catch (e) {
    fail(res, e.message);
  }
});

app.post('/api/backups', async (req, res) => {
  const label = String(req.body?.name || '').trim();

  if (label && !BACKUP_NAME_RE.test(label)) {
    return fail(res, 'Nombre no válido. Usa letras, números, espacios, guiones y puntos (máx. 80 caracteres).');
  }

  try {
    ensureBackupsDir();

    const wasRunning = Boolean(mcProcess && mcProcess.exitCode === null);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = (label || 'backup').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, '_').slice(0, 60);
    const zipName = `${safeLabel}_${timestamp}.zip`;
    const zipPath = path.join(BACKUPS_DIR, zipName);

    await createZipAtomically(zipPath, archive => {
      archive.directory(BASE_DIR, false, entryData => {
        if (entryData.name === '.moonwolf' || entryData.name.startsWith('.moonwolf/')) {
          return false;
        }

        return entryData;
      });
    });

    const stats = await fs.stat(zipPath);

    ok(res, {
      name: zipName,
      sizeMb: (stats.size / 1024 / 1024).toFixed(2),
      warning: wasRunning
        ? 'El servidor sigue en marcha; algunos archivos (el mundo) pudieron cambiar durante la copia.'
        : null,
    });
  } catch (e) {
    fail(res, `No se pudo crear la copia de seguridad: ${e.message}`);
  }
});

app.get('/api/backups/download/:name', async (req, res) => {
  const full = safeBackupPath(req.params.name);

  if (!full) {
    return res.status(403).send('Nombre no válido');
  }

  try {
    await fs.stat(full);
    res.download(full);
  } catch {
    res.status(404).send('Copia de seguridad no encontrada');
  }
});

app.delete('/api/backups/:name', async (req, res) => {
  const full = safeBackupPath(req.params.name);

  if (!full) {
    return fail(res, 'Nombre no válido');
  }

  try {
    await fs.unlink(full);
    ok(res);
  } catch (e) {
    fail(res, `No se pudo eliminar: ${e.message}`);
  }
});

/* ══════════════════════════════════════════════
    DEBUG
    ══════════════════════════════════════════════ */
app.get('/api/debug/start', async (_req, res) => {
  const cfg = loadStartupConfig();
  const jarPath = path.join(BASE_DIR, cfg.jar);
  const exists = fsSync.existsSync(jarPath);
  const minecraftVersion =
    String(cfg.minecraftVersion || '').trim() ||
    detectMinecraftVersionFromJarName(cfg.jar);

  let javaBin = null;
  let javaResolveError = null;

  try {
    javaBin =
      cfg.javaMode === 'override' && String(cfg.javaOverridePath || '').trim()
        ? await validateJavaOverride(cfg.javaOverridePath)
        : await resolveJavaForServer(minecraftVersion);
  } catch (error) {
    javaResolveError = error.message;
  }

  const javaCheck = javaBin ? await new Promise(resolve => {
    const j = spawn(javaBin, ['-version'], { windowsHide: true, stdio: 'pipe' });
    let out = '';

    j.stderr.on('data', d => { out += d; });
    j.stdout.on('data', d => { out += d; });
    j.on('close', code => resolve({ code, out }));
    j.on('error', e => resolve({ code: -1, out: e.message }));
  }) : { code: -1, out: javaResolveError || 'Java no disponible' };

  res.json({
    BASE_DIR,
    jar: cfg.jar,
    minecraftVersion,
    javaPath: javaBin,
    jarExists: exists,
    jarPath,
    java: javaCheck,
    javaRuntime: getJavaRuntimeInfo(minecraftVersion),
    javaResolveError,
  });
});

/* ══════════════════════════════════════════════
    START
    ══════════════════════════════════════════════ */
function stopMinecraft(timeoutMs = 30000) {
  return new Promise(resolve => {
    if (!mcProcess || mcProcess.exitCode !== null) return resolve();

    const proc = mcProcess;

    stopRequested = true;
    restarting = false;

    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeoutMs);

    proc.once('close', () => {
      clearTimeout(killTimer);
      resolve();
    });

    try {
      proc.stdin.write(`${loadStartupConfig().stopCommand || 'stop'}\n`);
    } catch {
      try { proc.kill(); } catch {}
    }
  });
}

module.exports = { stopMinecraft };

async function start() {
  // El panel local no debe exponerse en interfaces de red externas.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`MoonWolf Panel → http://localhost:${PORT}`);

    const cfg = loadStartupConfig();

    if (cfg.autoStartOnBoot) {
      broadcastLog('🌙 Arranque automático activado. Iniciando servidor...', 'system');
      broadcastStatus('starting');
      launchServer().catch(error => broadcastLog(`❌ Error en arranque automático: ${error.message}`, 'error'));
    }
  });
}

start().catch(error => {
  console.error('❌ Error iniciando MoonWolf Panel:', error);
  process.exit(1);
});
