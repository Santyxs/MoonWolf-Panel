'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PANEL_URL =
  'https://moonwolf-panel.onrender.com';

const NATIVE_ASSET =
  'native/webview.win32-x64-msvc.node';

const UI_ASSETS = {
  '/': 'ui/index.html',
  '/index.html': 'ui/index.html',
  '/style.css': 'ui/style.css',
  '/app.js': 'ui/app.js',
};

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
  if (!isStandalone || !getAsset) {
    return;
  }

  const runtimeDir = path.join(
    os.tmpdir(),
    'MoonWolf-Agent',
    'webviewjs'
  );

  fs.mkdirSync(runtimeDir, {
    recursive: true,
  });

  const nativePath = path.join(
    runtimeDir,
    'webview.win32-x64-msvc.node'
  );

  try {
    if (!fs.existsSync(nativePath)) {
      const nativeBuffer =
        getAsset(NATIVE_ASSET);

      fs.writeFileSync(
        nativePath,
        nativeBuffer
      );
    }
  } catch (error) {
    throw new Error(
      `No se pudo preparar WebViewJS: ${error.message}`
    );
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH =
    nativePath;
}

prepareNativeAddon();

const {
  Application,
} = require('@webviewjs/webview');

let app = null;
let window = null;
let webview = null;

let stateProvider = () => ({
  version: '1.0.0',
  token: '',
  serverDir: '',
  configPath: '',
  cloudConnected: false,
  localServerReady: false,
});

function mimeType(filePath) {
  const extension =
    path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';

    case '.css':
      return 'text/css; charset=utf-8';

    case '.js':
      return 'text/javascript; charset=utf-8';

    case '.json':
      return 'application/json; charset=utf-8';

    case '.svg':
      return 'image/svg+xml';

    case '.png':
      return 'image/png';

    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';

    case '.ico':
      return 'image/x-icon';

    default:
      return 'application/octet-stream';
  }
}

function readUiAsset(assetName) {
  if (isStandalone && getAsset) {
    return getAsset(assetName);
  }

  const filePath = path.join(
    __dirname,
    'ui',
    path.basename(assetName)
  );

  return fs.readFileSync(filePath);
}

function openUrl(url) {
  execFile(
    'cmd.exe',
    ['/d', '/c', 'start', '', url],
    {
      windowsHide: true,
    },
    () => {}
  );
}

function openFolder(folder) {
  if (!folder) {
    return;
  }

  execFile(
    'explorer.exe',
    [folder],
    {
      windowsHide: true,
    },
    () => {}
  );
}

function openConfigFolder(configPath) {
  if (!configPath) {
    return;
  }

  openFolder(
    path.dirname(configPath)
  );
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

  window.registerProtocol(
    'moonwolf',
    async request => {
      try {
        const url =
          new URL(request.url);

        let pathname =
          decodeURIComponent(
            url.pathname
          );

        if (!pathname) {
          pathname = '/';
        }

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
              },
            }
          );
        }

        const body =
          readUiAsset(assetName);

        return new Response(
          body,
          {
            status: 200,
            headers: {
              'Content-Type':
                mimeType(assetName),
              'Cache-Control':
                'no-store',
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
    }
  );

  webview =
    window.createWebview({
      url:
        'moonwolf://localhost/index.html',
      enableDevtools: false,
    });

  webview.expose('native', {
    getState: () =>
      stateProvider(),

    openPanel: () => {
      openUrl(PANEL_URL);

      return true;
    },

    openServerFolder: () => {
      const state =
        stateProvider();

      openFolder(
        state.serverDir
      );

      return true;
    },

    openConfig: () => {
      const state =
        stateProvider();

      openConfigFolder(
        state.configPath
      );

      return true;
    },

    close: () => {
      app?.exit();

      return true;
    },
  });

  app.on(
    'application-close-requested',
    () => {
      app?.exit();
    }
  );

  app.run({
    interval: 16,
    ref: true,
  });
}

function notifyStateChanged() {
  if (!webview) {
    return;
  }

  const state =
    JSON.stringify(
      stateProvider()
    );

  const script = `
    window.dispatchEvent(
      new CustomEvent(
        'moonwolf-state',
        {
          detail: ${state}
        }
      )
    );
  `;

  try {
    webview.evaluateScript(
      script
    );
  } catch {}
}

function startGui(getState) {
  stateProvider = getState;

  createWindow();

  setTimeout(
    notifyStateChanged,
    300
  );

  return {
    update:
      notifyStateChanged,

    close: () => {
      app?.exit();
    },
  };
}

module.exports = {
  startGui,
};
