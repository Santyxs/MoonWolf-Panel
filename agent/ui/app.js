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

function formatPath(value) {
  return String(value || '—');
}

/* ══════════════════════════════════════════════
   CUSTOM CONFIRM
   ══════════════════════════════════════════════ */
function ensureConfirmStyles() {
  if (document.getElementById('mw-confirm-style')) return;

  const style = document.createElement('style');
  style.id = 'mw-confirm-style';
  style.textContent = `
    .mw-confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      animation: mwConfirmIn 0.15s ease;
    }
    @keyframes mwConfirmIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    .mw-confirm-box {
      width: min(420px, calc(100vw - 40px));
      background: #171a21;
      border: 1px solid #2a2e38;
      border-radius: 14px;
      padding: 22px 24px 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #e8edf2;
      animation: mwConfirmPop 0.18s ease;
    }
    @keyframes mwConfirmPop {
      from { transform: translateY(-8px) scale(0.98); opacity: 0; }
      to   { transform: none; opacity: 1; }
    }
    .mw-confirm-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 10px;
      letter-spacing: 0.3px;
    }
    .mw-confirm-message {
      font-size: 13px;
      line-height: 1.55;
      color: #b6c2d1;
      margin-bottom: 18px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .mw-confirm-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .mw-confirm-actions button {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .mw-confirm-cancel {
      background: transparent;
      border-color: #2a2e38;
      color: #8b97a6;
    }
    .mw-confirm-cancel:hover {
      border-color: #4a5260;
      color: #c9d3df;
    }
    .mw-confirm-accept {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    .mw-confirm-accept:hover {
      background: #1d4fd8;
      border-color: #1d4fd8;
    }
    .mw-confirm-accept:focus,
    .mw-confirm-cancel:focus {
      outline: 2px solid #3b82f6;
      outline-offset: 2px;
    }
  `;

  document.head.appendChild(style);
}

function customConfirm(message, title = 'Reiniciar Agent') {
  ensureConfirmStyles();

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

function render() {
  const cloudConnected = Boolean(state.cloudConnected);
  const localReady = Boolean(state.localServerReady);

  $('pairing-code').textContent = state.pairingCode || '—';
  $('server-dir').textContent = formatPath(state.serverDir);
  $('server-dir').title = formatPath(state.serverDir);
  $('version').textContent = state.version && /^\d/.test(state.version) ? `v${state.version}` : (state.version || '—');

  $('status-dot').className = `status-dot ${cloudConnected ? 'connected' : 'connecting'}`;
  $('status-title').textContent = cloudConnected ? 'Conectado' : 'Desconectado';
  $('status-description').textContent = cloudConnected
    ? 'MoonWolf Agent conectado con MoonWolf Cloud'
    : 'Conectando con MoonWolf Cloud';

  $('local-dot').className = `mini-dot ${localReady ? 'ready' : ''}`;
  $('local-status').textContent = localReady
    ? 'Servidor local listo'
    : 'Servidor local iniciando';

  const banner = $('restart-banner');
  if (banner) {
    banner.classList.toggle('hidden', !state.restartRequired);
  }

  renderUpdateBanner();
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
    if (description) description.textContent = status === 'installing'
      ? 'Aplicando actualización…'
      : 'La actualización se instalará y MoonWolf Agent se reiniciará.';
    if (track) track.classList.add('hidden');
    if (applyButton) {
      applyButton.disabled = status === 'installing';
      applyButton.innerHTML = status === 'installing'
        ? '<span>⏳</span>Instalando'
        : '<span>⬆</span>Actualizar ahora';
    }
    return;
  }

  if (status === 'error') {
    if (title) title.textContent = `Error actualizando a ${version}`;
    if (description) description.textContent = state.updateError || 'No se pudo completar la actualización.';
    if (track) track.classList.add('hidden');
    if (applyButton) {
      applyButton.disabled = false;
      applyButton.innerHTML = '<span>↻</span>Reintentar';
    }
    return;
  }

  if (title) title.textContent = `Actualización disponible · ${version}`;
  if (description) description.textContent = 'Se descargará automáticamente en segundo plano.';
  if (track) track.classList.add('hidden');
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.innerHTML = '<span>⬇</span>Preparando';
  }
}

let lastNoticeRef = null;

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

  const configDir = String(state.configPath || '').replace(/[\\/][^\\/]*$/, '');

  $('settings-config-dir').textContent = formatPath(configDir);
  $('settings-config-dir').title = formatPath(configDir);
  $('settings-agent-id').textContent = state.agentId || '—';
}

function renderLogs() {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const list = $('logs-list');
  if (!list) return;

  $('logs-count').textContent = `${logs.length} entradas`;
  list.innerHTML = logs.length
    ? logs.map(entry => {
        const time = entry.time ? new Date(entry.time).toLocaleTimeString('es-ES') : '--:--:--';
        const level = String(entry.level || 'info');
        return `<div class="log-entry ${level}"><span class="log-time">${escapeHtml(time)}</span><span>${escapeHtml(entry.message)}</span></div>`;
      }).join('')
    : '<div class="empty-state">No hay logs todavía.</div>';
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function flashButton(button, label) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => { button.textContent = original; }, 1200);
}

function openServerDirModal() {
  $('serverdir-input').value = state.serverDir || '';
  $('serverdir-error').textContent = '';
  openModal('serverdir-modal');
}

function bindEvents() {
  $('open-panel')?.addEventListener('click', () => nativeApi().openPanel?.());
  $('open-server')?.addEventListener('click', () => nativeApi().openServerFolder?.());
  $('open-logs')?.addEventListener('click', () => openModal('logs-modal'));
  $('close-logs')?.addEventListener('click', () => closeModal('logs-modal'));
  $('logs-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => closeModal('logs-modal'));

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
      .map(entry => `[${entry.time || ''}] [${entry.level || 'info'}] ${entry.message || ''}`)
      .join('\n');
    const ok = await copyText(text);
    flashButton(button, ok ? 'Copiado' : 'Error');
  });

  $('save-logs')?.addEventListener('click', () => nativeApi().saveLogs?.());

  $('edit-server-dir')?.addEventListener('click', openServerDirModal);

  $('settings')?.addEventListener('click', () => {
    renderSettings();
    openModal('settings-modal');
  });
  $('close-settings')?.addEventListener('click', () => closeModal('settings-modal'));
  $('settings-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => closeModal('settings-modal'));
  $('settings-open-config')?.addEventListener('click', () => nativeApi().openConfig?.());
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
  $('settings-check-update')?.addEventListener('click', () => {
    nativeApi().checkForUpdates?.();
  });

  $('close-serverdir')?.addEventListener('click', () => closeModal('serverdir-modal'));
  $('cancel-serverdir')?.addEventListener('click', () => closeModal('serverdir-modal'));
  $('serverdir-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => closeModal('serverdir-modal'));

  $('save-serverdir')?.addEventListener('click', () => {
    const result = nativeApi().setServerDir?.($('serverdir-input').value);
    if (!result?.ok) {
      $('serverdir-error').textContent = result?.error || 'No se pudo guardar la ruta.';
      return;
    }
    state.serverDir = result.serverDir || $('serverdir-input').value;

    if (result.restartRequired) {
      state.restartRequired = true;
    }

    closeModal('serverdir-modal');
    render();
  });

  $('restart-agent')?.addEventListener('click', async () => {
    const ok = await customConfirm(
      'Reiniciar MoonWolf Agent ahora?',
      'Reiniciar Agent'
    );

    if (ok) {
      nativeApi().restart?.();
    }
  });

  $('update-apply')?.addEventListener('click', async () => {
    if (!state.updateAvailable) return;
    if (state.updateStatus !== 'ready' && state.updateStatus !== 'error') return;

    if (state.updateStatus === 'ready') {
      const ok = await customConfirm(
        `Actualizar MoonWolf Agent a v${state.updateAvailable.version}?\n\nSe reiniciará automáticamente.`,
        'Reiniciar Agent'
      );

      if (!ok) return;
    }

    const result = nativeApi().applyUpdate?.();

    if (result && !result.ok) {
      $('update-description').textContent = result.error || 'No se pudo aplicar la actualización.';
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const id of ['logs-modal', 'serverdir-modal', 'settings-modal']) {
      $(id)?.classList.add('hidden');
    }
  });
}

window.addEventListener('moonwolf-state', refreshState);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    refreshState();
  }, { once: true });
} else {
  bindEvents();
  refreshState();
}
