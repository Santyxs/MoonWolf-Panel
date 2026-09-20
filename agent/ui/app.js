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

const openLogs =
  document.getElementById('open-logs');

const logsModal =
  document.getElementById('logs-modal');

const closeLogs =
  document.getElementById('close-logs');

const logsList =
  document.getElementById('logs-list');

const logsCount =
  document.getElementById('logs-count');

const copyLogs =
  document.getElementById('copy-logs');

const saveLogs =
  document.getElementById('save-logs');

const clearLogs =
  document.getElementById('clear-logs');

let currentLogs = [];

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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatLogTime(value) {
  try {
    return new Date(value)
      .toLocaleTimeString(
        'es-ES',
        {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }
      );
  } catch {
    return '--:--:--';
  }
}

function renderLogs(
  logs,
  forceScroll = false
) {
  currentLogs =
    Array.isArray(logs)
      ? logs
      : [];

  logsCount.textContent =
    `${currentLogs.length} ${
      currentLogs.length === 1
        ? 'entrada'
        : 'entradas'
    }`;

  if (!currentLogs.length) {
    logsList.innerHTML = `
      <div class="logs-empty">
        No hay logs todavía.
      </div>
    `;

    return;
  }

  const wasNearBottom =
    logsList.scrollHeight -
      logsList.scrollTop -
      logsList.clientHeight <
    80;

  logsList.innerHTML =
    currentLogs
      .map(log => {
        const level =
          String(
            log.level || 'info'
          ).toLowerCase();

        const label =
          level === 'error'
            ? 'ERROR'
            : level === 'warn'
              ? 'WARN'
              : 'INFO';

        return `
          <div class="log-entry ${escapeHtml(level)}">
            <span class="log-time">
              ${escapeHtml(
                formatLogTime(
                  log.time
                )
              )}
            </span>

            <span class="log-level">
              ${label}
            </span>

            <span class="log-message">${escapeHtml(
              log.message || ''
            )}</span>
          </div>
        `;
      })
      .join('');

  if (
    forceScroll ||
    wasNearBottom
  ) {
    logsList.scrollTop =
      logsList.scrollHeight;
  }
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

  renderLogs(
    state.logs || []
  );
}

async function refresh() {
  try {
    const state =
      await window.native.getState();

    applyState(state);
  } catch {}
}

copyToken.addEventListener(
  'click',
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
      await navigator.clipboard.writeText(
        token
      );

      copyToken.textContent =
        'Copiado';

      setTimeout(() => {
        copyToken.textContent =
          'Copiar';
      }, 1200);
    } catch {}
  }
);

openPanel.addEventListener(
  'click',
  async () => {
    await window.native.openPanel();
  }
);

openServer.addEventListener(
  'click',
  async () => {
    await window.native.openServerFolder();
  }
);

settings.addEventListener(
  'click',
  async () => {
    await window.native.openConfig();
  }
);

openLogs.addEventListener(
  'click',
  async () => {
    logsModal.classList.remove(
      'hidden'
    );

    await refresh();

    renderLogs(
      currentLogs,
      true
    );
  }
);

closeLogs.addEventListener(
  'click',
  () => {
    logsModal.classList.add(
      'hidden'
    );
  }
);

logsModal
  .querySelector('.modal-backdrop')
  .addEventListener(
    'click',
    () => {
      logsModal.classList.add(
        'hidden'
      );
    }
  );

copyLogs.addEventListener(
  'click',
  async () => {
    const text =
      currentLogs
        .map(log => {
          const time =
            formatLogTime(
              log.time
            );

          const level =
            String(
              log.level || 'info'
            ).toUpperCase();

          return (
            `[${time}] ` +
            `[${level}] ` +
            log.message
          );
        })
        .join('\n\n');

    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        text
      );

      copyLogs.textContent =
        'Copiado';

      setTimeout(() => {
        copyLogs.textContent =
          'Copiar';
      }, 1200);
    } catch {}
  }
);

saveLogs.addEventListener(
  'click',
  async () => {
    try {
      const result =
        await window.native.saveLogs();

      if (result) {
        saveLogs.textContent =
          'Guardado';

        setTimeout(() => {
          saveLogs.textContent =
            'Guardar';
        }, 1200);
      }
    } catch {}
  }
);

clearLogs.addEventListener(
  'click',
  async () => {
    try {
      await window.native.clearLogs();

      await refresh();

      renderLogs(
        currentLogs,
        true
      );
    } catch {}
  }
);

window.addEventListener(
  'moonwolf-state',
  event => {
    applyState(
      event.detail
    );
  }
);

window.addEventListener(
  'keydown',
  event => {
    if (
      event.key === 'Escape' &&
      !logsModal.classList.contains(
        'hidden'
      )
    ) {
      logsModal.classList.add(
        'hidden'
      );
    }
  }
);

refresh();

setInterval(
  refresh,
  2000
);
