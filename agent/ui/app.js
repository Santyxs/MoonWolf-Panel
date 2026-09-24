'use strict';

const $ = id => document.getElementById(id);

let state = {
  version: '—',
  pairingCode: '',
  pairingExpiresAt: 0,
  serverDir: '',
  cloudConnected: false,
  localServerReady: false,
  logs: [],
};

const nativeApi = () => window.native || {};

function formatPath(value) {
  return String(value || '—');
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

  renderSettings();
  renderLogs();
}

function renderSettings() {
  if (!$('settings-server-dir')) return;

  const configDir = String(state.configPath || '').replace(/[\\/][^\\/]*$/, '');

  $('settings-server-dir').textContent = formatPath(state.serverDir);
  $('settings-server-dir').title = formatPath(state.serverDir);
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
  $('settings-open-server')?.addEventListener('click', () => nativeApi().openServerFolder?.());
  $('settings-open-config')?.addEventListener('click', () => nativeApi().openConfig?.());
  $('settings-change-server')?.addEventListener('click', () => {
    closeModal('settings-modal');
    openServerDirModal();
  });
  $('settings-copy-id')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!state.agentId) return;
    const ok = await copyText(state.agentId);
    flashButton(button, ok ? 'Copiado' : 'Error');
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
    closeModal('serverdir-modal');
    render();
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
