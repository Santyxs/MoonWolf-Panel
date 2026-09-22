'use strict';

const statusDot = document.getElementById('status-dot');
const statusTitle = document.getElementById('status-title');
const statusDescription = document.getElementById('status-description');
const pairingCode = document.getElementById('pairing-code');
const serverDir = document.getElementById('server-dir');
const version = document.getElementById('version');
const localDot = document.getElementById('local-dot');
const localStatus = document.getElementById('local-status');
const copyPairing = document.getElementById('copy-pairing');
const openPanel = document.getElementById('open-panel');
const openServer = document.getElementById('open-server');
const settings = document.getElementById('settings');
const openLogs = document.getElementById('open-logs');
const logsModal = document.getElementById('logs-modal');
const closeLogs = document.getElementById('close-logs');
const logsList = document.getElementById('logs-list');
const logsCount = document.getElementById('logs-count');
const copyLogs = document.getElementById('copy-logs');
const saveLogs = document.getElementById('save-logs');
const clearLogs = document.getElementById('clear-logs');
const editServerDir = document.getElementById('edit-server-dir');
const serverDirModal = document.getElementById('serverdir-modal');
const closeServerDir = document.getElementById('close-serverdir');
const cancelServerDir = document.getElementById('cancel-serverdir');
const saveServerDirBtn = document.getElementById('save-serverdir');
const serverDirInput = document.getElementById('serverdir-input');
const serverDirError = document.getElementById('serverdir-error');
let currentLogs = [];

function setCloudStatus(connected) {
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusTitle.textContent = connected ? 'Conectado a MoonWolf Cloud' : 'Desconectado';
  statusDescription.textContent = connected ? 'El Agent está conectado y funcionando.' : 'Intentando reconectar con MoonWolf Cloud...';
}

function setLocalStatus(ready) {
  localDot.className = `mini-dot ${ready ? 'online' : ''}`;
  localStatus.textContent = ready ? 'Servidor local activo' : 'Servidor local';
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function formatLogTime(value) {
  try { return new Date(value).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return '--:--:--'; }
}

function renderLogs(logs, forceScroll = false) {
  currentLogs = Array.isArray(logs) ? logs : [];
  logsCount.textContent = `${currentLogs.length} ${currentLogs.length === 1 ? 'entrada' : 'entradas'}`;
  if (!currentLogs.length) { logsList.innerHTML = '<div class="logs-empty">No hay logs todavía.</div>'; return; }
  const wasNearBottom = logsList.scrollHeight - logsList.scrollTop - logsList.clientHeight < 80;
  logsList.innerHTML = currentLogs.map(log => {
    const level = String(log.level || 'info').toLowerCase();
    const label = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
    return `<div class="log-entry ${escapeHtml(level)}"><span class="log-time">${escapeHtml(formatLogTime(log.time))}</span><span class="log-level">${label}</span><span class="log-message">${escapeHtml(log.message || '')}</span></div>`;
  }).join('');
  if (forceScroll || wasNearBottom) logsList.scrollTop = logsList.scrollHeight;
}

function applyState(state) {
  if (!state) return;
  pairingCode.textContent = state.pairingCode || 'Generando...';
  serverDir.textContent = state.serverDir || '—';
  version.textContent = state.version || '—';
  setCloudStatus(Boolean(state.cloudConnected));
  setLocalStatus(Boolean(state.localServerReady));
  renderLogs(state.logs || []);
}

async function refresh() { try { applyState(await window.native.getState()); } catch {} }

copyPairing.addEventListener('click', async () => {
  const code = pairingCode.textContent;
  if (!code || code === '—' || code === 'Generando...') return;
  try { await navigator.clipboard.writeText(code); copyPairing.textContent = 'Copiado'; setTimeout(() => copyPairing.textContent = 'Copiar', 1200); } catch {}
});
openPanel.addEventListener('click', async () => await window.native.openPanel());
openServer.addEventListener('click', async () => await window.native.openServerFolder());
settings.addEventListener('click', async () => await window.native.openConfig());
openLogs.addEventListener('click', async () => { logsModal.classList.remove('hidden'); await refresh(); renderLogs(currentLogs, true); });
closeLogs.addEventListener('click', () => logsModal.classList.add('hidden'));
logsModal.querySelector('.modal-backdrop').addEventListener('click', () => logsModal.classList.add('hidden'));
copyLogs.addEventListener('click', async () => {
  const text = currentLogs.map(log => `[${formatLogTime(log.time)}] [${String(log.level || 'info').toUpperCase()}] ${log.message}`).join('\n\n');
  if (!text) return;
  try { await navigator.clipboard.writeText(text); copyLogs.textContent = 'Copiado'; setTimeout(() => copyLogs.textContent = 'Copiar', 1200); } catch {}
});
saveLogs.addEventListener('click', async () => { try { if (await window.native.saveLogs()) { saveLogs.textContent = 'Guardado'; setTimeout(() => saveLogs.textContent = 'Guardar', 1200); } } catch {} });
clearLogs.addEventListener('click', async () => { try { await window.native.clearLogs(); await refresh(); renderLogs(currentLogs, true); } catch {} });

function openServerDirModal() {
  serverDirError.textContent = '';
  serverDirInput.value = serverDir.textContent && serverDir.textContent !== '—' ? serverDir.textContent : '';
  serverDirModal.classList.remove('hidden');
  serverDirInput.focus();
}

function closeServerDirModal() {
  serverDirModal.classList.add('hidden');
}

editServerDir.addEventListener('click', openServerDirModal);
closeServerDir.addEventListener('click', closeServerDirModal);
cancelServerDir.addEventListener('click', closeServerDirModal);
serverDirModal.querySelector('.modal-backdrop').addEventListener('click', closeServerDirModal);

saveServerDirBtn.addEventListener('click', async () => {
  serverDirError.textContent = '';
  const value = serverDirInput.value.trim();

  if (!value) {
    serverDirError.textContent = 'Introduce una ruta.';
    return;
  }

  saveServerDirBtn.disabled = true;
  saveServerDirBtn.textContent = 'Guardando...';

  try {
    const result = await window.native.setServerDir(value);

    if (!result || !result.ok) {
      serverDirError.textContent = (result && result.error) || 'No se pudo guardar la ruta.';
      return;
    }

    await refresh();
    closeServerDirModal();
  } catch (error) {
    serverDirError.textContent = (error && error.message) || 'Error inesperado.';
  } finally {
    saveServerDirBtn.disabled = false;
    saveServerDirBtn.textContent = 'Guardar';
  }
});

window.addEventListener('moonwolf-state', event => applyState(event.detail));
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!logsModal.classList.contains('hidden')) logsModal.classList.add('hidden');
  if (!serverDirModal.classList.contains('hidden')) closeServerDirModal();
});
refresh();
setInterval(refresh, 2000);
