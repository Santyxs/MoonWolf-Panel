'use strict';

const $ = id => document.getElementById(id);

let state = {
  version: '—',
  pairingCode: '',
  pairingExpiresAt: 0,
  serverDir: '',
  cloudConnected: false,
  localServerReady: false,
  restartRequired: false,
  updateAvailable: null,
  updateStatus: 'idle',
  updateProgress: 0,
  updateError: null,
  updateNotice: null,
  logs: [],
};

const nativeApi = () => window.native || {};
const UPDATE_CHECK_TIMEOUT = 8000;

let lastNoticeRef = null;
let pendingUpdateCheck = false;
let updateCheckTimer = null;
let settingsStatusTimer = null;
let logsFilter = 'all';
let logsQuery = '';
let logsRenderKey = '';

function formatPath(value) {
  return String(value || '—');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Confirmación personalizada ---------- */

function customConfirm(message, title = 'Reiniciar Agent') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'mw-confirm-overlay';

    const box = document.createElement('div');
    box.className = 'mw-confirm-box';

    const titleEl = document.createElement('div');
    titleEl.className = 'mw-confirm-title';
    titleEl.textContent = title;

    const msgEl = document.createElement('div');
    msgEl.className = 'mw-confirm-message';
    msgEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'mw-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'mw-confirm-cancel';
    cancelBtn.textContent = 'Cancelar';

    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'mw-confirm-accept';
    acceptBtn.textContent = 'Aceptar';

    actions.append(cancelBtn, acceptBtn);
    box.append(titleEl, msgEl, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let closed = false;

    const close = result => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };

    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        close(true);
      }
    };

    acceptBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));

    overlay.addEventListener('click', event => {
      if (event.target === overlay) close(false);
    });

    document.addEventListener('keydown', onKey);

    setTimeout(() => acceptBtn.focus(), 30);
  });
}

/* ---------- Actualizaciones ---------- */

function cancelUpdateCheck() {
  pendingUpdateCheck = false;
  clearTimeout(updateCheckTimer);
  updateCheckTimer = null;
}

function showSettingsUpdateStatus(kind, message, autoHide = 0) {
  const element = $('settings-update-status');
  if (!element) return;

  clearTimeout(settingsStatusTimer);
  settingsStatusTimer = null;

  if (!message) {
    element.className = 'settings-update-status hidden';
    element.textContent = '';
    return;
  }

  element.textContent = message;
  element.className = `settings-update-status ${kind || 'info'}`;

  if (autoHide > 0) {
    settingsStatusTimer = setTimeout(() => {
      element.classList.add('hidden');
    }, autoHide);
  }
}

function completeUpdateCheck(found) {
  cancelUpdateCheck();

  const button = $('settings-check-update');
  if (button) {
    flashButton(
      button,
      found ? '¡Disponible!' : 'Sin novedades',
      found ? 1600 : 2000
    );
  }

  showSettingsUpdateStatus(
    found ? 'ok' : 'info',
    found
      ? 'Actualización disponible. Se descargará en segundo plano.'
      : 'Ya tienes la última versión.'
  );
}

function revealUpdateIfPending() {
  if (!pendingUpdateCheck || !state.updateAvailable) return;
  closeModal('settings-modal');
  completeUpdateCheck(true);
}

/* ---------- Render ---------- */

function render() {
  const cloudConnected = Boolean(state.cloudConnected);
  const localReady = Boolean(state.localServerReady);

  $('pairing-code').textContent = state.pairingCode || '—';

  $('server-dir').textContent = formatPath(state.serverDir);
  $('server-dir').title = formatPath(state.serverDir);

  $('version').textContent =
    state.version && /^\d/.test(state.version)
      ? `v${state.version}`
      : (state.version || '—');

  $('status-dot').className =
    `status-dot ${cloudConnected ? 'connected' : 'connecting'}`;

  const statusCard = $('status-card');
  if (statusCard) {
    statusCard.className =
      `status-card ${cloudConnected ? 'connected' : 'connecting'}`;
  }

  $('status-title').textContent =
    cloudConnected ? 'Conectado' : 'Desconectado';

  $('status-description').textContent = cloudConnected
    ? 'MoonWolf Agent conectado con MoonWolf Cloud'
    : 'Conectando con MoonWolf Cloud';

  $('local-dot').className =
    `mini-dot ${localReady ? 'ready' : ''}`;

  $('local-status').textContent = localReady
    ? 'Servidor local listo'
    : 'Servidor local iniciando';

  const banner = $('restart-banner');
  if (banner) {
    banner.classList.toggle('hidden', !state.restartRequired);
  }

  renderUpdateBanner();
  revealUpdateIfPending();
  renderUpdateNotice();
  renderSettings();
  renderLogs();
}

function renderUpdateBanner() {
  const banner = $('update-banner');
  if (!banner) return;

  const available = state.updateAvailable;

  if (!available) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');

  const title = $('update-title');
  const description = $('update-description');
  const applyButton = $('update-apply');
  const track = $('update-progress-track');
  const fill = $('update-progress-fill');

  const version = `v${available.version}`;
  const status = String(state.updateStatus || 'idle');
  const progress = Number(state.updateProgress) || 0;

  if (status === 'downloading') {
    if (title) title.textContent = `Descargando ${version}…`;
    if (description) description.textContent = `${progress}% completado`;
    if (track) track.classList.remove('hidden');
    if (fill) fill.style.width = `${progress}%`;
    if (applyButton) {
      applyButton.disabled = true;
      applyButton.innerHTML = '<span>⬇</span>Descargando';
    }
    return;
  }

  if (status === 'ready' || status === 'installing') {
    if (title) title.textContent = `Listo para actualizar a ${version}`;
    if (description) {
      description.textContent =
        status === 'installing'
          ? 'Aplicando actualización…'
          : 'La actualización se instalará y MoonWolf Agent se reiniciará.';
    }
    if (track) track.classList.add('hidden');
    if (applyButton) {
      applyButton.disabled = status === 'installing';
      applyButton.innerHTML =
        status === 'installing'
          ? '<span>⏳</span>Instalando'
          : '<span>⬆</span>Actualizar ahora';
    }
    return;
  }

  if (status === 'error') {
    if (title) title.textContent = `Error actualizando a ${version}`;
    if (description) {
      description.textContent =
        state.updateError ||
        'No se pudo completar la actualización.';
    }
    if (track) track.classList.add('hidden');
    if (applyButton) {
      applyButton.disabled = false;
      applyButton.innerHTML = '<span>↻</span>Reintentar';
    }
    return;
  }

  if (title) title.textContent = `Actualización disponible · ${version}`;
  if (description) {
    description.textContent = 'Se descargará automáticamente en segundo plano.';
  }
  if (track) track.classList.add('hidden');
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.innerHTML = '<span>⬇</span>Preparando';
  }
}

function renderUpdateNotice() {
  const element = $('update-notice');
  if (!element) return;

  const notice = state.updateNotice;

  if (!notice || !notice.message) {
    element.classList.add('hidden');
    element.textContent = '';
    lastNoticeRef = null;
    return;
  }

  if (lastNoticeRef === notice) return;
  lastNoticeRef = notice;

  element.textContent = notice.message;
  element.className = `update-notice ${notice.type || 'info'}`;
  element.classList.remove('hidden');
}

function renderSettings() {
  if (!$('settings-config-dir')) return;

  const configDir = String(state.configPath || '')
    .replace(/[\\/][^\\/]*$/, '');

  $('settings-config-dir').textContent = formatPath(configDir);
  $('settings-config-dir').title = formatPath(configDir);
  $('settings-agent-id').textContent = state.agentId || '—';
}

/* ---------- Logs ---------- */

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';

  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function logLevelLabel(level) {
  if (level === 'error') return 'ERROR';
  if (level === 'warn') return 'AVISO';
  return 'INFO';
}

function renderLogs(force = false) {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const list = $('logs-list');
  if (!list) return;

  const query = logsQuery.trim().toLowerCase();
  const visible = logs.filter(entry => {
    const level = String(entry.level || 'info');
    if (logsFilter !== 'all' && level !== logsFilter) return false;
    if (!query) return true;
    return String(entry.message || '').toLowerCase().includes(query);
  });

  const errors = logs.filter(e => e.level === 'error').length;
  const warnings = logs.filter(e => e.level === 'warn').length;
  const parts = [`${logs.length} ${logs.length === 1 ? 'entrada' : 'entradas'}`];

  if (warnings) parts.push(`${warnings} aviso${warnings === 1 ? '' : 's'}`);
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 'es'}`);
  if (visible.length !== logs.length) parts.push(`${visible.length} visibles`);

  $('logs-count').textContent = parts.join(' · ');

  const last = logs[logs.length - 1];
  const key = [
    logs.length,
    last?.time || '',
    last?.message || '',
    logsFilter,
    query,
  ].join('|');

  if (!force && key === logsRenderKey) return;
  logsRenderKey = key;

  const nearBottom =
    list.scrollHeight - list.scrollTop - list.clientHeight < 56;
  const previousScroll = list.scrollTop;

  if (!logs.length) {
    list.innerHTML = '<div class="empty-state">No hay logs todavía.</div>';
    return;
  }

  if (!visible.length) {
    list.innerHTML =
      '<div class="empty-state">Ningún log coincide con la búsqueda o el filtro.</div>';
    return;
  }

  list.innerHTML = visible.map(entry => {
    const level = String(entry.level || 'info');
    return (
      `<div class="log-entry ${escapeHtml(level)}">` +
        `<span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>` +
        `<span class="log-level">${logLevelLabel(level)}</span>` +
        `<span class="log-message">${escapeHtml(entry.message)}</span>` +
      '</div>'
    );
  }).join('');

  list.scrollTop = nearBottom ? list.scrollHeight : previousScroll;
}

/* ---------- Estado / utilidades ---------- */

function refreshState(event) {
  const next = event?.detail || nativeApi().getState?.();

  if (next && typeof next === 'object') {
    state = { ...state, ...next };
    render();
  }
}

function openModal(id) {
  $(id)?.classList.remove('hidden');
}

function closeModal(id) {
  $(id)?.classList.add('hidden');
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';

    document.body.appendChild(area);
    area.select();

    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function flashButton(button, label, duration = 1200) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;

  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => {
    button.textContent = original;
  }, duration);
}

function openServerDirModal() {
  $('serverdir-input').value = state.serverDir || '';
  $('serverdir-error').textContent = '';
  openModal('serverdir-modal');
}

/* ---------- Eventos ---------- */

function bindEvents() {
  $('open-panel')?.addEventListener(
    'click',
    () => nativeApi().openPanel?.()
  );

  $('open-server')?.addEventListener(
    'click',
    () => nativeApi().openServerFolder?.()
  );

  $('open-logs')?.addEventListener('click', () => {
    openModal('logs-modal');
    renderLogs(true);
    const list = $('logs-list');
    if (list) list.scrollTop = list.scrollHeight;
  });

  $('logs-search')?.addEventListener('input', event => {
    logsQuery = event.currentTarget.value || '';
    renderLogs(true);
  });

  document.querySelectorAll('.log-filter').forEach(button => {
    button.addEventListener('click', () => {
      logsFilter = button.dataset.level || 'all';

      document.querySelectorAll('.log-filter').forEach(item => {
        item.classList.toggle('active', item === button);
      });

      renderLogs(true);
    });
  });

  $('close-logs')?.addEventListener(
    'click',
    () => closeModal('logs-modal')
  );

  $('logs-modal')
    ?.querySelector('.modal-backdrop')
    ?.addEventListener('click', () => closeModal('logs-modal'));

  $('copy-pairing')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!state.pairingCode) return;

    const ok = await copyText(state.pairingCode);
    flashButton(button, ok ? 'Copiado' : 'Error');
  });

  $('clear-logs')?.addEventListener('click', () => {
    nativeApi().clearLogs?.();
    render();
  });

  $('copy-logs')?.addEventListener('click', async event => {
    const button = event.currentTarget;

    const text = (state.logs || [])
      .map(entry =>
        `[${entry.time || ''}] ` +
        `[${entry.level || 'info'}] ` +
        `${entry.message || ''}`
      )
      .join('\n');

    const ok = await copyText(text);
    flashButton(button, ok ? 'Copiado' : 'Error');
  });

  $('save-logs')?.addEventListener(
    'click',
    () => nativeApi().saveLogs?.()
  );

  $('edit-server-dir')?.addEventListener('click', openServerDirModal);

  $('settings')?.addEventListener('click', () => {
    showSettingsUpdateStatus('', '');
    renderSettings();
    openModal('settings-modal');
  });

  $('close-settings')?.addEventListener(
    'click',
    () => closeModal('settings-modal')
  );

  $('settings-modal')
    ?.querySelector('.modal-backdrop')
    ?.addEventListener('click', () => closeModal('settings-modal'));

  $('settings-open-config')?.addEventListener(
    'click',
    () => nativeApi().openConfig?.()
  );

  $('settings-hide-tray')?.addEventListener('click', () => {
    closeModal('settings-modal');
    nativeApi().hideToTray?.();
  });

  $('settings-copy-id')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!state.agentId) return;

    const ok = await copyText(state.agentId);
    flashButton(button, ok ? 'Copiado' : 'Error');
  });

  $('settings-check-update')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const api = nativeApi();

    if (!api.checkForUpdates) {
      flashButton(button, 'No disponible');
      showSettingsUpdateStatus(
        'err',
        'La interfaz nativa no está disponible.'
      );
      return;
    }

    if (state.updateAvailable) {
      closeModal('settings-modal');
      flashButton(button, '¡Disponible!', 1600);
      return;
    }

    pendingUpdateCheck = true;

    flashButton(button, 'Buscando…', UPDATE_CHECK_TIMEOUT);
    showSettingsUpdateStatus('info', 'Buscando actualizaciones…');

    clearTimeout(updateCheckTimer);

    updateCheckTimer = setTimeout(() => {
      if (!pendingUpdateCheck) return;

      if (state.updateAvailable) {
        closeModal('settings-modal');
        completeUpdateCheck(true);
      } else {
        completeUpdateCheck(false);
      }
    }, UPDATE_CHECK_TIMEOUT);

    try {
      const result = await api.checkForUpdates();

      if (!pendingUpdateCheck) return;

      if (state.updateAvailable) {
        closeModal('settings-modal');
        completeUpdateCheck(true);
        return;
      }

      if (
        result &&
        typeof result === 'object' &&
        result.available === false
      ) {
        completeUpdateCheck(false);
      }
      // Si el nativo no responde con available:false,
      // el timeout cierra con "Ya tienes la última versión."
    } catch {
      if (pendingUpdateCheck) completeUpdateCheck(false);
    }
  });

  $('close-serverdir')?.addEventListener(
    'click',
    () => closeModal('serverdir-modal')
  );

  $('cancel-serverdir')?.addEventListener(
    'click',
    () => closeModal('serverdir-modal')
  );

  $('serverdir-modal')
    ?.querySelector('.modal-backdrop')
    ?.addEventListener('click', () => closeModal('serverdir-modal'));

  $('save-serverdir')?.addEventListener('click', async () => {
    const api = nativeApi();
    const inputVal = $('serverdir-input').value;

    if (!api.setServerDir) {
      $('serverdir-error').textContent =
        'La interfaz nativa no está disponible.';
      return;
    }

    try {
      const result = await api.setServerDir(inputVal);

      if (result && result.ok === false) {
        $('serverdir-error').textContent =
          result.error ||
          result.message ||
          'No se pudo guardar la ruta.';
        return;
      }

      state.serverDir = (result && result.serverDir) || inputVal;
      if (result && result.restartRequired) {
        state.restartRequired = true;
      }

      closeModal('serverdir-modal');
      render();
    } catch (err) {
      $('serverdir-error').textContent =
        err.message || 'Error al establecer la ruta.';
    }
  });

  $('restart-agent')?.addEventListener('click', async () => {
    const ok = await customConfirm(
      'Reiniciar MoonWolf Agent?',
      'Reiniciar Agent'
    );

    if (ok) nativeApi().restart?.();
  });

  $('update-apply')?.addEventListener('click', async () => {
    if (!state.updateAvailable) return;

    if (
      state.updateStatus !== 'ready' &&
      state.updateStatus !== 'error'
    ) {
      return;
    }

    const api = nativeApi();

    if (!api.applyUpdate) {
      if ($('update-description')) {
        $('update-description').textContent =
          'La interfaz nativa no está disponible.';
      }
      return;
    }

    try {
      const result = await api.applyUpdate();

      if (result && result.ok === false) {
        if ($('update-description')) {
          $('update-description').textContent =
            result.error ||
            result.message ||
            'No se pudo aplicar la actualización.';
        }
      }
    } catch (err) {
      if ($('update-description')) {
        $('update-description').textContent =
          err.message || 'Error durante la actualización.';
      }
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;

    for (const id of [
      'logs-modal',
      'serverdir-modal',
      'settings-modal',
    ]) {
      $(id)?.classList.add('hidden');
    }
  });
}

window.addEventListener('moonwolf-state', refreshState);

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      bindEvents();
      refreshState();
    },
    { once: true }
  );
} else {
  bindEvents();
  refreshState();
}
