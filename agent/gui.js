'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const PANEL_URL = 'https://moonwolf-panel.onrender.com';
const NATIVE_ASSET = 'native/webview.win32-x64-msvc.node';
const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'MoonWolf'
);
const WEBVIEW_DATA_DIR = path.join(CONFIG_DIR, 'WebView2Data');
const UI_ASSETS = {
  '/': 'ui/index.html',
  '/index.html': 'ui/index.html',
  '/style.css': 'ui/style.css',
  '/app.js': 'ui/app.js',
};

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

function prepareNativeAddon() {
  if (!isStandalone || !getAsset) return;

  const runtimeDir = path.join(os.tmpdir(), 'MoonWolf-Agent', 'webviewjs');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const nativePath = path.join(
    runtimeDir,
    'webview.win32-x64-msvc.node'
  );

  try {
    if (!fs.existsSync(nativePath)) {
      fs.writeFileSync(
        nativePath,
        Buffer.from(getAsset(NATIVE_ASSET))
      );
    }
  } catch (error) {
    throw new Error(`No se pudo preparar WebViewJS: ${error.message}`);
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nativePath;
}

prepareNativeAddon();

const { Application } = require('@webviewjs/webview');

let app = null;
let window = null;
let webview = null;
let tray = null;
let notifyTimer = null;
let lastStateJson = null;

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

function decodePngRgba(png) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
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
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > png.length) {
      throw new Error('PNG de MoonWolf corrupto.');
    }

    const data = png.subarray(dataStart, dataEnd);

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
    throw new Error('PNG entrelazado no compatible.');
  }

  const compressed = Buffer.concat(idat);
  const raw = zlib.inflateSync(compressed);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expectedLength = height * (stride + 1);

  if (raw.length !== expectedLength) {
    throw new Error(
      `Datos PNG inesperados: ${raw.length} bytes, esperados ${expectedLength}.`
    );
  }

  const rgba = Buffer.alloc(width * height * 4);

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
            value + Math.floor((left + up) / 2);
          break;

        case 4:
          reconstructed =
            value + paeth(left, up, upLeft);
          break;

        default:
          throw new Error(
            `Filtro PNG no compatible: ${filterType}.`
          );
      }

      current[x] = reconstructed & 0xff;
    }

    current.copy(rgba, outputOffset);
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
    const icon = decodePngRgba(TRAY_ICON_PNG);

    if (typeof window.setWindowIcon === 'function') {
      window.setWindowIcon(
        icon.data,
        icon.width,
        icon.height
      );
    }

    if (process.platform === 'win32') {
      if (typeof window.setTaskbarIcon === 'function') {
        window.setTaskbarIcon(
          icon.data,
          icon.width,
          icon.height
        );
      }
    }
  } catch (error) {
    console.warn(
      `No se pudo aplicar el icono de MoonWolf: ${error.message}`
    );
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';

  return 'application/octet-stream';
}

function readUiAsset(assetName) {
  if (isStandalone && getAsset) {
    try {
      return Buffer.from(getAsset(assetName)).toString('utf8');
    } catch {}
  }

  const filePath = path.join(__dirname, assetName);
  return fs.readFileSync(filePath, 'utf8');
}

function openUrl(url) {
  try {
    execFile('explorer.exe', [url], { windowsHide: true });
  } catch {}
}

function openFolder(folder) {
  if (!folder) return;

  try {
    execFile('explorer.exe', [folder], { windowsHide: true });
  } catch {}
}

function openConfigFolder(configPath) {
  const folder = path.dirname(configPath || CONFIG_DIR);

  try {
    execFile('explorer.exe', [folder], { windowsHide: true });
  } catch {}
}

/* ── Bandeja del sistema ── */

function hideToTray() {
  if (!tray || !window) return false;

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
  try {
    actions.onQuit?.();
  } catch {}

  try {
    tray?.dispose();
  } catch {}

  try {
    app?.exit();
  } catch {}

  setImmediate(() => {
    try {
      process.exit(0);
    } catch {}
  });
}

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
      const button = String(
        event?.button || ''
      ).toLowerCase();

      const buttonState = String(
        event?.buttonState || ''
      ).toLowerCase();

      if (button && !button.includes('left')) return;
      if (buttonState.includes('down')) return;

      showFromTray();
    });

    tray.on('double-click', showFromTray);
  } catch {
    tray = null;
  }
}

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

  applyWindowIcon();

  window.registerProtocol('moonwolf', async request => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(
        url.pathname || '/'
      );

      const assetName = UI_ASSETS[pathname];

      if (!assetName) {
        return new Response('Not found', {
          status: 404,
          headers: {
            'Content-Type':
              'text/plain; charset=utf-8',
          },
        });
      }

      return new Response(
        readUiAsset(assetName),
        {
          status: 200,
          headers: {
            'Content-Type': mimeType(assetName),
            'Cache-Control': 'no-store',
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
          },
        }
      );
    }
  });

  fs.mkdirSync(WEBVIEW_DATA_DIR, {
    recursive: true,
  });

  const webContext = app.createWebContext({
    dataDirectory: WEBVIEW_DATA_DIR,
  });

  webview = window.createWebview({
    url: 'moonwolf://localhost/index.html',
    enableDevtools: false,
    webContext,
  });

  webview.expose('native', {
    getState: () => stateProvider(),

    openPanel: () => {
      openUrl(PANEL_URL);
      return true;
    },

    openServerFolder: () => {
      openFolder(stateProvider().serverDir);
      return true;
    },

    openConfig: () => {
      openConfigFolder(stateProvider().configPath);
      return true;
    },

    setServerDir: dir =>
      typeof actions.setServerDir === 'function'
        ? actions.setServerDir(dir)
        : {
            ok: false,
            error: 'No disponible.',
          },

    clearLogs: () =>
      typeof actions.clearLogs === 'function' &&
      actions.clearLogs(),

    saveLogs: () =>
      typeof actions.saveLogs === 'function' &&
      actions.saveLogs(),

    hideToTray: () => hideToTray(),

    close: () => {
      quitApp();
      return true;
    },
  });

  window.on('resize', () => {
    try {
      if (window.isMinimized()) {
        hideToTray();
      }
    } catch {}
  });

  app.on(
    'application-close-requested',
    () => quitApp()
  );

  app.on('custom-menu-click', event => {
    const id = event?.customMenuEvent?.id;

    if (id === 'tray-open') {
      showFromTray();
    }

    if (id === 'tray-quit') {
      quitApp();
    }
  });

  const ready =
    typeof app.whenReady === 'function'
      ? app.whenReady({ autoRun: false })
      : null;

  app.run({
    interval: 16,
    ref: true,
  });

  if (ready) {
    ready.then(createTray).catch(() => {});
  }
}

function notifyStateChanged() {
  notifyTimer = null;

  if (!webview) return;

  let stateJson;

  try {
    stateJson = JSON.stringify(
      stateProvider()
    );
  } catch {
    return;
  }

  if (stateJson === lastStateJson) return;

  lastStateJson = stateJson;

  const script =
    `window.dispatchEvent(new CustomEvent(` +
    `'moonwolf-state', { detail: ${stateJson} }));`;

  try {
    webview.evaluateScript(script);
  } catch {}
}

function scheduleStateChanged() {
  if (notifyTimer !== null) return;

  notifyTimer = setTimeout(
    notifyStateChanged,
    100
  );
}

function startGui(
  getState,
  guiActions = {}
) {
  stateProvider = getState;
  actions = guiActions;

  createWindow();

  setTimeout(
    notifyStateChanged,
    300
  );

  return {
    update: scheduleStateChanged,
    close: () => quitApp(),
  };
}

module.exports = {
  startGui,
};
