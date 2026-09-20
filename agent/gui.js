'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Application } = require('@webviewjs/webview');

const UI_DIR = path.join(__dirname, 'ui');

const PANEL_URL = 'https://moonwolf-panel.onrender.com';

let app = null;
let window = null;
let webview = null;

let stateProvider = () => ({
  version: '1.0.0',
  token: '',
  serverDir: '',
  cloudConnected: false,
  localServerReady: false,
});

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

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
  openFolder(path.dirname(configPath));
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

  window.registerProtocol('moonwolf', async request => {
    try {
      const url = new URL(request.url);

      let relativePath = decodeURIComponent(
        url.pathname
      );

      if (
        !relativePath ||
        relativePath === '/'
      ) {
        relativePath = '/index.html';
      }

      const filePath = path.resolve(
        UI_DIR,
        `.${relativePath}`
      );

      const uiRoot = path.resolve(UI_DIR);

      if (
        filePath !== uiRoot &&
        !filePath.startsWith(`${uiRoot}${path.sep}`)
      ) {
        return {
          statusCode: 403,
          body: Buffer.from('Forbidden'),
          mimeType: 'text/plain',
        };
      }

      const data = await fs.promises.readFile(filePath);

      return {
        statusCode: 200,
        body: data,
        mimeType: mimeType(filePath),
      };
    } catch {
      return {
        statusCode: 404,
        body: Buffer.from('Not found'),
        mimeType: 'text/plain',
      };
    }
  });

  webview = window.createWebview({
    url: 'moonwolf://localhost/index.html',
    enableDevtools: false,
  });

  webview.expose('native', {
    getState: () => stateProvider(),

    openPanel: () => {
      openUrl(PANEL_URL);
      return true;
    },

    openServerFolder: () => {
      const state = stateProvider();

      if (state.serverDir) {
        openFolder(state.serverDir);
      }

      return true;
    },

    openConfig: () => {
      const configPath =
        stateProvider().configPath;

      if (configPath) {
        openConfigFolder(configPath);
      }

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

  const state = JSON.stringify(
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
    webview.evaluateScript(script);
  } catch {}
}

function startGui(getState) {
  stateProvider = getState;

  createWindow();

  setTimeout(() => {
    notifyStateChanged();
  }, 300);

  return {
    update: notifyStateChanged,

    close: () => {
      app?.exit();
    },
  };
}

module.exports = {
  startGui,
};
