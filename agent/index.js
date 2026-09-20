'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { startGui } = require('./gui');

const PANEL_URL =
  'https://moonwolf-panel.onrender.com';

const CLOUD_PATH = '/socket.io';

const VERSION = '1.0.0';

const DEFAULT_SERVER_DIR =
  process.env.MOONWOLF_SERVER_DIR ||
  path.join(
    os.homedir(),
    'MoonWolf'
  );

const CONFIG_DIR =
  path.join(
    process.env.APPDATA ||
      path.join(
        os.homedir(),
        'AppData',
        'Roaming'
      ),
    'MoonWolf'
  );

const CONFIG_PATH =
  path.join(
    CONFIG_DIR,
    'agent.json'
  );

const TOKEN_RE =
  /^MW-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;

const ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const LOCAL_PORT = 3000;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, {
    recursive: true,
  });
}

function makeToken() {
  const bytes =
    crypto.randomBytes(16);

  let raw = '';

  for (const byte of bytes) {
    raw +=
      ALPHABET[
        byte % ALPHABET.length
      ];
  }

  return (
    `MW-${raw.slice(0, 4)}-` +
    `${raw.slice(4, 8)}-` +
    `${raw.slice(8, 12)}-` +
    `${raw.slice(12, 16)}`
  );
}

function makeSecret(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString('hex');
}

function loadConfig() {
  ensureConfigDir();

  let config = {};

  try {
    config = JSON.parse(
      fs.readFileSync(
        CONFIG_PATH,
        'utf8'
      )
    );
  } catch {}

  if (process.env.AGENT_TOKEN) {
    config.token =
      process.env.AGENT_TOKEN;
  }

  if (
    !TOKEN_RE.test(
      config.token || ''
    ) &&
    !process.env.AGENT_TOKEN
  ) {
    config.token = makeToken();
  }

  if (!config.serverDir) {
    config.serverDir =
      DEFAULT_SERVER_DIR;
  }

  if (
    typeof config.autoStart !==
    'boolean'
  ) {
    config.autoStart = false;
  }

  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      config,
      null,
      2
    ),
    'utf8'
  );

  return config;
}

function wait(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function waitForLocalServer(
  localUrl
) {
  for (
    let attempt = 1;
    attempt <= 30;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          `${localUrl}/api/health`,
          {
            signal:
              AbortSignal.timeout(
                1000
              ),
          }
        );

      if (response.ok) {
        return;
      }
    } catch {}

    await wait(
      Math.min(
        250 * attempt,
        1500
      )
    );
  }

  throw new Error(
    'El servidor local de MoonWolf no respondió a tiempo.'
  );
}

function startEmbeddedLocalServer(
  config
) {
  const localSecret =
    makeSecret(32);

  const sessionSecret =
    makeSecret(32);

  process.env.MOONWOLF_SERVER_DIR =
    config.serverDir;

  process.env.MOONWOLF_PORT =
    String(LOCAL_PORT);

  process.env.AGENT_AUTH_TOKEN =
    localSecret;

  process.env.SESSION_SECRET =
    sessionSecret;

  require('../server.js');

  return localSecret;
}

async function main() {
  const config =
    loadConfig();

  const localUrl =
    `http://127.0.0.1:${LOCAL_PORT}`;

  let localServerReady = false;
  let cloudConnected = false;

  let localToken = null;
  let localSocket = null;
  let cloudSocket = null;

  let reconnectTimer = null;
  let reconnectDelay = 1000;

  let shuttingDown = false;

  const getState = () => ({
    version: VERSION,

    token:
      config.token || '',

    serverDir:
      config.serverDir || '',

    configPath:
      CONFIG_PATH,

    cloudConnected,

    localServerReady,
  });

  const gui = startGui(
    getState
  );

  function updateGui() {
    gui?.update();
  }

  startEmbeddedLocalServer(
    config
  );

  try {
    await waitForLocalServer(
      localUrl
    );

    localServerReady = true;

    updateGui();
  } catch (error) {
    localServerReady = false;

    updateGui();

    throw error;
  }

  async function loginLocal() {
    if (localToken) {
      return localToken;
    }

    const response =
      await fetch(
        `${localUrl}/api/auth/login`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            agentToken:
              process.env.AGENT_AUTH_TOKEN,
          }),
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => ({})
        );

    if (
      !response.ok ||
      !data.ok ||
      !data.token
    ) {
      throw new Error(
        data.error ||
          `Login local rechazado (${response.status})`
      );
    }

    localToken =
      data.token;

    return localToken;
  }

  async function forwardHttp(
    request
  ) {
    try {
      const token =
        await loginLocal();

      const headers = {
        Authorization:
          `Bearer ${token}`,
      };

      if (
        request.body !==
          undefined &&
        request.body !== null
      ) {
        headers[
          'Content-Type'
        ] =
          'application/json';
      }

      const response =
        await fetch(
          `${localUrl}${request.path}`,
          {
            method:
              request.method ||
              'GET',

            headers,

            body:
              request.body !==
                undefined &&
              request.body !== null
                ? JSON.stringify(
                    request.body
                  )
                : undefined,
          }
        );

      const type =
        response.headers.get(
          'content-type'
        ) ||
        'application/octet-stream';

      const bytes =
        Buffer.from(
          await response.arrayBuffer()
        );

      return {
        id: request.id,

        ok: response.ok,

        status:
          response.status,

        contentType:
          type,

        bodyBase64:
          bytes.toString(
            'base64'
          ),
      };
    } catch (error) {
      return {
        id: request.id,

        ok: false,

        status: 502,

        data: {
          ok: false,

          error:
            error.message,
        },
      };
    }
  }

  function connectLocalSocket() {
    localSocket?.disconnect();

    localSocket =
      io(
        localUrl,
        {
          auth:
            async callback => {
              try {
                callback({
                  token:
                    await loginLocal(),
                });
              } catch {
                callback({
                  token: '',
                });
              }
            },

          transports: [
            'websocket',
            'polling',
          ],

          reconnection: true,

          reconnectionDelay:
            1000,

          reconnectionDelayMax:
            10000,
        }
      );

    for (
      const event of [
        'status',
        'log',
        'history',
        'stats',
      ]
    ) {
      localSocket.on(
        event,
        payload => {
          if (
            cloudSocket?.connected
          ) {
            cloudSocket.emit(
              'event',
              {
                name: event,
                payload,
              }
            );
          }
        }
      );
    }

    localSocket.on(
      'connect_error',
      error => {
        if (
          error?.message ===
          'unauthorized'
        ) {
          localToken = null;
        }
      }
    );
  }

  function scheduleReconnect() {
    if (shuttingDown) {
      return;
    }

    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      setTimeout(
        connectCloud,
        reconnectDelay
      );

    reconnectDelay =
      Math.min(
        reconnectDelay * 2,
        30000
      );
  }

  function connectCloud() {
    if (shuttingDown) {
      return;
    }

    cloudSocket?.disconnect();

    cloudConnected = false;

    updateGui();

    cloudSocket =
      io(
        PANEL_URL,
        {
          path: CLOUD_PATH,

          transports: [
            'websocket',
          ],

          auth: {
            role: 'agent',

            token:
              config.token,
          },

          reconnection: false,
        }
      );

    cloudSocket.on(
      'connect',
      () => {
        reconnectDelay =
          1000;

        cloudConnected = true;

        updateGui();

        connectLocalSocket();
      }
    );

    cloudSocket.on(
      'rpc',
      async request => {
        const result =
          await forwardHttp(
            request || {}
          );

        cloudSocket?.emit(
          'rpc_result',
          result
        );
      }
    );

    cloudSocket.on(
      'connect_error',
      () => {
        cloudConnected = false;

        updateGui();
      }
    );

    cloudSocket.on(
      'disconnect',
      () => {
        cloudConnected = false;

        updateGui();

        scheduleReconnect();
      }
    );
  }

  function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    clearTimeout(
      reconnectTimer
    );

    cloudSocket?.disconnect();
    localSocket?.disconnect();

    cloudConnected = false;

    updateGui();
  }

  process.on(
    'SIGINT',
    () => {
      shutdown();

      process.exit(0);
    }
  );

  process.on(
    'SIGTERM',
    () => {
      shutdown();

      process.exit(0);
    }
  );

  connectCloud();
}

main().catch(
  error => {
    console.error(
      '❌ MoonWolf Agent:',
      error.message
    );

    process.exitCode = 1;
  }
);
