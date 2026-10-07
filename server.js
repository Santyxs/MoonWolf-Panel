const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
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
