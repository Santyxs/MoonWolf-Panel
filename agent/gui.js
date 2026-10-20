'use strict';

/* ══════════════════════════════════════════════
   1. REQUIRES Y CONSTANTES
   ══════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const PANEL_URL = 'https://moonwolf-panel.up.railway.app';
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoonWolf');
const NATIVE_ASSET = 'native/webview.win32-x64-msvc.node';
const TEMP_ROOT = path.join(os.tmpdir(), 'MoonWolf-Agent');
const WEBVIEW_DATA_DIR = path.join(TEMP_ROOT, 'WebView2Data', String(process.pid));
const NATIVE_ADDON_NAME = 'webview.win32-x64-msvc.node';

if (!process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--disable-gpu-shader-disk-cache',
    '--disable-application-cache',
    '--disable-offline-load-stale-cache',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-background-downloads',
    '--disable-sync',
    '--disable-translate',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-breakpad',
    '--no-pings',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--disable-plugins',
    '--disable-print-preview',
    '--disable-speech-api',
    '--disable-notifications',
    '--mute-audio',
    '--disable-features=msSmartScreenProtection,AutofillServerCommunication,OptimizationHints,MediaRouter,EdgeFeedback,InterestFeedContentSuggestions,ReadAnythingOmniboxIcon,TranslateUI,Translate,PrivacySandboxSettings4',
  ].join(' ');
}

const UI_ASSETS = {
  '/': 'ui/index.html',
  '/index.html': 'ui/index.html',
  '/style.css': 'ui/style.css',
  '/app.js': 'ui/app.js',
};

const CSP_AGENT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TRAY_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABNElEQVR42s2XsQ6CMBRF+yf8mAmTq7OrswMxcXBz0w/wC4yzYdLJwbg5MZiIGkjtJWiwgZZC+yrJiaDUe9v32r4yVrmmg3sgiASxgFsmLv87YHWX+CEUJA6EZaAR1olzYsLqsCceDCRFOMq4cE9EzFHCtU5MZtpoOU75Zv7k2/WLz4b9TbQ2ANHrOefpjRfg2cYoaA2gl6d99hUGh11mLQxMJ3455j/iYDFKaQzIPbfde6UBxFgWB0g+EgPVhKuymjzcG8BUqxMnM9A0/GQhgEiTAZIkVBkgmYaqEJAsRKokJFuKm6ah7YQ0XohkYBTvyjsjntvslsZLsc4M2nw+nW1GOtCmba3QaTtWgXdNCpXOBUlTLjiriOpKMoB7fNdnFngvSr2X5X4PJt6PZn9xOPV5PH8DKeu0vPehIOQAAAAASUVORK5CYII=',
  'base64'
);

let getAsset = null;
let isStandalone = false;

try {
  const sea = require('node:sea');

  if (typeof sea.getAsset === 'function') {
    getAsset = sea.getAsset;
    isStandalone = true;
  }
} catch {}


/* ══════════════════════════════════════════════
   2. NATIVE ADDON Y WEBVIEW DATA
   ══════════════════════════════════════════════ */

function removeStaleWebViewData() {
  const dataRoot = path.join(TEMP_ROOT, 'WebView2Data');
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {}

  try {
    fs.rmSync(path.join(CONFIG_DIR, 'WebView2Data'), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  } catch {}

  try {
    fs.rmSync(path.join(TEMP_ROOT, 'webviewjs'), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  } catch {}
}

function scheduleWebViewDataCleanup() {
  const target = WEBVIEW_DATA_DIR;
  const tryRemove = (attempt) => {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch {}
    if (attempt < 4) {
      setTimeout(() => tryRemove(attempt + 1), 400 * attempt);
    }
  };
  setTimeout(() => tryRemove(1), 300);
}

function prepareNativeAddon() {
  if (!isStandalone || !getAsset) return;

  fs.mkdirSync(TEMP_ROOT, { recursive: true });

  const nativePath = path.join(TEMP_ROOT, NATIVE_ADDON_NAME);

  try {
    // El build elige entre original, gzip y Brotli; MWBR identifica el payload Brotli.
    const asset = Buffer.from(getAsset(NATIVE_ASSET));
    const isBrotli = asset.length >= 4 && asset.subarray(0, 4).toString('ascii') === 'MWBR';
    const isGzip = asset.length >= 2 && asset[0] === 0x1f && asset[1] === 0x8b;
    const embeddedAddon = isBrotli
      ? zlib.brotliDecompressSync(asset.subarray(4))
      : isGzip ? zlib.gunzipSync(asset) : asset;
    let needsWrite = true;

    try {
      const existing = fs.readFileSync(nativePath);
      needsWrite = !existing.equals(embeddedAddon);
    } catch {}

    if (needsWrite) {
      const temporaryPath = `${nativePath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, embeddedAddon);
        fs.renameSync(temporaryPath, nativePath);
      } catch (error) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch {}
        throw error;
      }
    }
  } catch (error) {
    throw new Error(`No se pudo preparar WebViewJS: ${error.message}`);
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nativePath;
}

removeStaleWebViewData();
prepareNativeAddon();

const { Application } = require('@webviewjs/webview');

let app = null;
let window = null;
let webview = null;
let tray = null;
let notifyTimer = null;
let initialPaintTimer = null;
let lastStateJson = null;
let isQuitting = false;

let stateProvider = () => ({
  version: '1.0.0',
  token: '',
  serverDir: '',
  configPath: '',
  cloudConnected: false,
  localServerReady: false,
  logs: [],
});

let actions = {};

function cleanupOldExe() {
  try {
    const selfPath = process.execPath;

    if (!/\.exe$/i.test(selfPath)) return;

    const oldPath = selfPath + '.old';

    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  } catch {}
}

cleanupOldExe();


/* ══════════════════════════════════════════════
   3. ICONO PNG
   ══════════════════════════════════════════════ */

function decodePngRgba(png) {
  const signature = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);

  if (!png.subarray(0, 8).equals(signature)) {
    throw new Error('El icono de MoonWolf no es un PNG válido.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString(
      'ascii',
      offset + 4,
      offset + 8
    );

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > png.length) {
      throw new Error(
        'PNG de MoonWolf corrupto.'
      );
    }

    const data = png.subarray(
      dataStart,
      dataEnd
    );

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width !== 32 || height !== 32) {
    throw new Error(
      `Tamaño de icono no compatible: ${width}x${height}.`
    );
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `Formato PNG no compatible: bitDepth=${bitDepth}, colorType=${colorType}.`
    );
  }

  if (interlaceMethod !== 0) {
    throw new Error(
      'PNG entrelazado no compatible.'
    );
  }

  const compressed = Buffer.concat(idat);
  const raw = zlib.inflateSync(compressed);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expectedLength =
    height * (stride + 1);

  if (raw.length !== expectedLength) {
    throw new Error(`Datos PNG inesperados: ${raw.length} bytes, esperados ${expectedLength}.`);
  }

  const rgba = Buffer.alloc(
    width * height * 4
  );

  let rawOffset = 0;
  let outputOffset = 0;

  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];

    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset++];

      const left =
        x >= bytesPerPixel
          ? current[x - bytesPerPixel]
          : 0;

      const up = previous[x];

      const upLeft =
        x >= bytesPerPixel
          ? previous[x - bytesPerPixel]
          : 0;

      let reconstructed;

      switch (filterType) {
        case 0:
          reconstructed = value;
          break;

        case 1:
          reconstructed = value + left;
          break;

        case 2:
          reconstructed = value + up;
          break;

        case 3:
          reconstructed =
            value +
            Math.floor((left + up) / 2);
          break;

        case 4:
          reconstructed =
            value +
            paeth(left, up, upLeft);
          break;

        default:
          throw new Error(
            `Filtro PNG no compatible: ${filterType}.`
          );
      }

      current[x] =
        reconstructed & 0xff;
    }

    current.copy(
      rgba,
      outputOffset
    );

    outputOffset += stride;

    current.copy(previous);
  }

  return {
    data: rgba,
    width,
    height,
  };
}

function applyWindowIcon() {
  if (!window) return;

  try {
    const icon =
      decodePngRgba(TRAY_ICON_PNG);

    if (
      typeof window.setWindowIcon ===
      'function'
    ) {
      window.setWindowIcon(
        icon.data,
        icon.width,
        icon.height
      );
    }

    if (process.platform === 'win32') {
      if (
        typeof window.setTaskbarIcon ===
        'function'
      ) {
        window.setTaskbarIcon(
          icon.data,
          icon.width,
          icon.height
        );
      }
    }
  } catch (error) {
    console.warn(`No se pudo aplicar el icono de MoonWolf: ${error.message}`);
  }
}

function mimeType(filePath) {
  const ext =
    path.extname(filePath).toLowerCase();

  if (ext === '.html') {
    return 'text/html; charset=utf-8';
  }

  if (ext === '.css') {
    return 'text/css; charset=utf-8';
  }

  if (ext === '.js') {
    return 'text/javascript; charset=utf-8';
  }

  if (ext === '.json') {
    return 'application/json; charset=utf-8';
  }

  return 'application/octet-stream';
}

function readUiAsset(assetName) {
  if (isStandalone && getAsset) {
    try {
      return Buffer.from(
        getAsset(assetName)
      ).toString('utf8');
    } catch {}
  }

  const filePath =
    path.join(__dirname, assetName);

  return fs.readFileSync(
    filePath,
    'utf8'
  );
}

/* ══════════════════════════════════════════════
   4. SHELL HELPERS
   ══════════════════════════════════════════════ */
function openExplorerPath(target, label = 'explorer') {
  if (!target) {
    console.warn(`[${label}] Sin ruta para abrir.`);
    return false;
  }

  console.log(`[${label}] Abriendo: ${target}`);

  try {
    const child = spawn('explorer.exe', [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.on('error', err => {
      console.error(`[${label}] spawn error:`, err?.message || err);
    });

    child.unref();
    return true;
  } catch (err) {
    console.error(`[${label}] sync error:`, err?.message || err);
    return false;
  }
}

function openUrl(url) {
  if (!url) return false;
  return openExplorerPath(url, 'url');
}

function openFolder(folder) {
  if (!folder) return false;
  return openExplorerPath(folder, 'folder');
}

function openConfigFolder(configPath) {
  let folder = CONFIG_DIR;

  if (configPath) {
    try {
      const st = fs.statSync(configPath);
      folder = st.isDirectory() ? configPath : path.dirname(configPath);
    } catch {
      const dir = path.dirname(configPath);
      if (dir && dir !== '.' && dir !== path.sep) folder = dir;
    }
  }

  if (!folder) folder = CONFIG_DIR;

  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    console.warn('[config] No se pudo crear la carpeta de configuración:', err?.message || err);
    folder = CONFIG_DIR;
    try { fs.mkdirSync(folder, { recursive: true }); } catch {}
  }

  return openExplorerPath(folder, 'config');
}

function hideToTray() {
  if (!tray || !window) {
    return false;
  }

  try {
    window.hide();
    return true;
  } catch {
    return false;
  }
}

function showFromTray() {
  if (!window) return false;

  try {
    window.show();
    window.setMinimized(false);
    window.focus();

    return true;
  } catch {
    return false;
  }
}

function quitApp() {
  if (isQuitting) return;

  isQuitting = true;

  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }

  if (initialPaintTimer !== null) {
    clearTimeout(initialPaintTimer);
    initialPaintTimer = null;
  }

  try {
    window?.hide();
  } catch {}

  Promise.resolve()
    .then(() => actions.onQuit?.())
    .catch(error =>
      console.error(
        '[app] onQuit falló:',
        error?.message || error
      )
    )
    .then(finishQuit);
}

function finishQuit() {
  try {
    if (webview && typeof webview.clearAllBrowsingData === 'function') {
      webview.clearAllBrowsingData();
    }
  } catch {}

  try {
    tray?.dispose();
  } catch (error) {
    console.error(
      '[app] tray.dispose falló:',
      error?.message || error
    );
  }

  try {
    app?.exit();
  } catch (error) {
    console.error(
      '[app] app.exit falló:',
      error?.message || error
    );
  }

  scheduleWebViewDataCleanup();

  setImmediate(() => {
    try {
      process.exit(0);
    } catch {}
  });
}


/* ══════════════════════════════════════════════
   5. TRAY
   ══════════════════════════════════════════════ */

function createTray() {
  if (!app || tray) return;

  try {
    tray = app.createTrayIcon({
      id: 'moonwolf-agent',
      icon: {
        data: TRAY_ICON_PNG,
      },
      tooltip: 'MoonWolf Agent',
      menu: {
        items: [
          {
            id: 'tray-open',
            label: 'Abrir MoonWolf Agent',
          },
          {
            id: 'tray-quit',
            label: 'Salir',
          },
        ],
      },
      menuOnLeftClick: false,
      menuOnRightClick: true,
    });

    tray.on('click', event => {
      const button =
        String(
          event?.button || ''
        ).toLowerCase();

      const buttonState =
        String(
          event?.buttonState || ''
        ).toLowerCase();

      if (
        button &&
        !button.includes('left')
      ) {
        return;
      }

      if (buttonState.includes('down')) {
        return;
      }

      showFromTray();
    });

    tray.on(
      'double-click',
      showFromTray
    );
  } catch {
    tray = null;
  }
}

function executeWebViewScript(script) {
  if (!webview || typeof webview.evaluateScript !== 'function') {
    return false;
  }

  webview.evaluateScript(script);
  return true;
}

const WEBVIEW_RESTRICTIONS_SCRIPT = `
(() => {
  if (window.__moonwolfRestrictionsInstalled) return;
  window.__moonwolfRestrictionsInstalled = true;

  document.addEventListener('contextmenu', event => {
    event.preventDefault();
  }, true);

  document.addEventListener('selectstart', event => {
    const target = event.target;
    if (target && target.closest &&
        target.closest('button')) {
      event.preventDefault();
    }
  }, true);
})();
`;

function installWebViewRestrictions() {
  executeWebViewScript(WEBVIEW_RESTRICTIONS_SCRIPT);
}


/* ══════════════════════════════════════════════
   6. VENTANA Y PROTOCOLO
   ══════════════════════════════════════════════ */

function createWindow() {
  app = new Application();

  window = app.createBrowserWindow({
    title: 'MoonWolf Agent',
    width: 620,
    height: 720,
    minWidth: 560,
    minHeight: 650,
    resizable: true,
    maximizable: false,
    minimizable: true,
    decorations: true,
    focused: true,
  });

  try {
    window.setVisible(false);
  } catch {}

  applyWindowIcon();

  window.registerProtocol(
    'moonwolf',
    async request => {
      try {
        const url =
          new URL(request.url);

        const pathname =
          decodeURIComponent(
            url.pathname || '/'
          );

        const assetName =
          UI_ASSETS[pathname];

        if (!assetName) {
          return new Response(
            'Not found',
            {
              status: 404,
              headers: {
                'Content-Type':
                  'text/plain; charset=utf-8',
                'Content-Security-Policy':
                  CSP_AGENT,
              },
            }
          );
        }

        return new Response(
          readUiAsset(assetName),
          {
            status: 200,
            headers: {
              'Content-Type':
                mimeType(assetName),
              'Cache-Control':
                'no-store',
              'Content-Security-Policy':
                CSP_AGENT,
              'X-Content-Type-Options':
                'nosniff',
              'Referrer-Policy':
                'no-referrer',
            },
          }
        );
      } catch (error) {
        return new Response(
          `MoonWolf UI error: ${error.message}`,
          {
            status: 500,
            headers: {
              'Content-Type':
                'text/plain; charset=utf-8',
              'Content-Security-Policy':
                CSP_AGENT,
            },
          }
        );
      }
    }
  );

  fs.mkdirSync(WEBVIEW_DATA_DIR, { recursive: true });

  const webContext =
    app.createWebContext({
      dataDirectory:
        WEBVIEW_DATA_DIR,
    });

  webview = window.createWebview({
    url: 'moonwolf://localhost/index.html',
    enableDevtools: false,
    incognito: true,
    webContext,
  });

  try {
    installWebViewRestrictions();
  } catch (error) {
    console.warn('[webview] No se pudo desactivar el menú contextual:', error?.message || error);
  }

  if (
    typeof webview.on ===
    'function'
  ) {
    webview.on(
      'error',
      error => {
        console.error(
          '[webview] error:',
          error?.message || error
        );
      }
    );

    webview.on(
      'crashed',
      () => {
        console.error('[webview] proceso de renderizado crasheado.');
      }
    );

    webview.on(
      'unresponsive',
      () => {
        console.warn('[webview] no responde.');
      }
    );

    webview.on(
      'responsive',
      () => {
        console.log('[webview] vuelve a responder.');
      }
    );

    webview.on(
      'page-load-finished',
      () => {
        try {
          installWebViewRestrictions();
        } catch {}
      }
    );
  }

  webview.expose('native', {
    getState: () =>
      stateProvider(),

    openPanel: () => {
      const ok = openUrl(PANEL_URL);
      return { ok };
    },

    openServerFolder: () => {
      const ok = openFolder(
        stateProvider().serverDir
      );

      return { ok };
    },

    openConfig: () => {
      const ok = openConfigFolder(
        stateProvider().configPath
      );

      return { ok };
    },

    setServerDir: dir =>
      typeof actions.setServerDir ===
      'function'
        ? actions.setServerDir(dir)
        : {
            ok: false,
            error: 'No disponible.',
          },

    clearLogs: () =>
      typeof actions.clearLogs ===
        'function' &&
      actions.clearLogs(),

    saveLogs: () =>
      typeof actions.saveLogs ===
        'function' &&
      actions.saveLogs(),

    hideToTray: () => {
      const ok = hideToTray();
      return { ok };
    },

    restart: () =>
      typeof actions.restart ===
        'function' &&
      actions.restart(),

    checkForUpdates: () =>
      typeof actions.checkForUpdates ===
        'function' &&
      actions.checkForUpdates(),

    applyUpdate: () =>
      typeof actions.applyUpdate ===
        'function'
        ? actions.applyUpdate()
        : {
            ok: false,
            error: 'No disponible.',
          },

    close: () => {
      quitApp();
      return { ok: true };
    },
  });

  window.on(
    'resize',
    () => {
      try {
        if (window.isMinimized()) {
          hideToTray();
        }
      } catch {}
    }
  );

  window.on(
    'close',
    event => {
      if (isQuitting) return;

      try {
        event?.preventDefault?.();
      } catch {}

      quitApp();
    }
  );

  window.on(
    'error',
    error => {
      console.error(
        '[window] error:',
        error?.message || error
      );
    }
  );

  app.on(
    'application-close-requested',
    () => quitApp()
  );

  app.on(
    'custom-menu-click',
    event => {
      const id =
        event?.customMenuEvent?.id;

      if (id === 'tray-open') {
        showFromTray();
      }

      if (id === 'tray-quit') {
        quitApp();
      }
    }
  );

  const ready =
    typeof app.whenReady ===
    'function'
      ? app.whenReady({
          autoRun: false,
        })
      : null;

  app.run({
    interval: 16,
    ref: true,
  });

  if (ready) {
    ready
      .then(createTray)
      .catch(() => {});
  }
}

function notifyStateChanged() {
  notifyTimer = null;

  if (!webview) return;

  let stateJson;

  try {
    stateJson =
      JSON.stringify(
        stateProvider()
      );
  } catch {
    return;
  }

  if (
    stateJson === lastStateJson
  ) {
    return;
  }

  lastStateJson = stateJson;

  const safeJson =
    stateJson
      .replace(
        /\u2028/g,
        '\\u2028'
      )
      .replace(
        /\u2029/g,
        '\\u2029'
      );

  const script =
    `window.dispatchEvent(new CustomEvent(` +
    `'moonwolf-state', { detail: ${safeJson} }));`;

  try {
    executeWebViewScript(
      script
    );
  } catch {}
}

function scheduleStateChanged() {
  if (notifyTimer !== null) {
    return;
  }

  notifyTimer =
    setTimeout(
      notifyStateChanged,
      100
    );
}

function revealWindowAfterInitialPaint() {
  initialPaintTimer = null;

  if (!window || isQuitting) {
    return;
  }

  try {
    webview?.setWebviewVisibility?.(
      true
    );
  } catch {}

  try {
    if (
      typeof window.setVisible ===
      'function'
    ) {
      window.setVisible(true);
    } else {
      window.show();
    }

    window.setMinimized(false);
    window.focus();
  } catch (error) {
    console.warn(
      '[window] No se pudo mostrar la ventana tras el primer pintado:',
      error?.message || error
    );
  }
}


/* ══════════════════════════════════════════════
   7. START GUI
   ══════════════════════════════════════════════ */

function startGui(
  getState,
  guiActions = {}
) {
  stateProvider = getState;
  actions = guiActions;

  createWindow();

  initialPaintTimer =
    setTimeout(() => {
      notifyStateChanged();
      revealWindowAfterInitialPaint();
    }, 350);

  return {
    update: scheduleStateChanged,

    close: () =>
      quitApp(),
  };
}


/* ══════════════════════════════════════════════
   8. EXPORTS
   ══════════════════════════════════════════════ */

module.exports = {
  startGui,
};
