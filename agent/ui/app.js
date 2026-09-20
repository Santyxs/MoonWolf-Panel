'use strict';

const statusDot =
  document.getElementById('status-dot');

const statusTitle =
  document.getElementById('status-title');

const statusDescription =
  document.getElementById('status-description');

const agentToken =
  document.getElementById('agent-token');

const serverDir =
  document.getElementById('server-dir');

const version =
  document.getElementById('version');

const localDot =
  document.getElementById('local-dot');

const localStatus =
  document.getElementById('local-status');

const copyToken =
  document.getElementById('copy-token');

const openPanel =
  document.getElementById('open-panel');

const openServer =
  document.getElementById('open-server');

const settings =
  document.getElementById('settings');

function setCloudStatus(connected) {
  statusDot.className =
    `status-dot ${
      connected
        ? 'connected'
        : 'disconnected'
    }`;

  if (connected) {
    statusTitle.textContent =
      'Conectado a MoonWolf Cloud';

    statusDescription.textContent =
      'El Agent está conectado y funcionando.';
  } else {
    statusTitle.textContent =
      'Desconectado';

    statusDescription.textContent =
      'Intentando reconectar con MoonWolf Cloud...';
  }
}

function setLocalStatus(ready) {
  localDot.className =
    `mini-dot ${
      ready ? 'online' : ''
    }`;

  localStatus.textContent =
    ready
      ? 'Servidor local activo'
      : 'Servidor local';
}

function applyState(state) {
  if (!state) {
    return;
  }

  agentToken.textContent =
    state.token || '—';

  serverDir.textContent =
    state.serverDir || '—';

  version.textContent =
    state.version || '—';

  setCloudStatus(
    Boolean(state.cloudConnected)
  );

  setLocalStatus(
    Boolean(state.localServerReady)
  );
}

async function refresh() {
  try {
    const state =
      await window.native.getState();

    applyState(state);
  } catch {}
}

copyToken.addEventListener('click',
  async () => {
    const token =
      agentToken.textContent;

    if (
      !token ||
      token === '—'
    ) {
      return;
    }

    try {
      await navigator.clipboard.writeText(token);

      copyToken.textContent = 'Copiado';

      setTimeout(() => {
        copyToken.textContent = 'Copiar';
      }, 1200);
    } catch {}
  }
);

openPanel.addEventListener('click',
  async () => {
    await window.native.openPanel();
  }
);

openServer.addEventListener('click',
  async () => {
    await window.native.openServerFolder();
  }
);

settings.addEventListener('click',
  async () => {
    await window.native.openConfig();
  }
);

window.addEventListener('moonwolf-state',
  event => {
    applyState(event.detail);
  }
);

refresh();

setInterval(refresh, 2000);
