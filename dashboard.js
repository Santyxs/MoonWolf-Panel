'use strict';

/* ══════════════════════════════════════════════
   1. CONSTANTES Y UTILIDADES
   ══════════════════════════════════════════════ */

const CLOUD_URL = location.origin;
const CLOUD_PATH = '/socket.io';

const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const SHARE_TOKEN_RE = /^MW-SHARE-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const SESSION_KEY = 'moonwolf_panel_session';
const AGENT_KEY = 'moonwolf_agent_id';
const PERMISSION_KEY = 'moonwolf_panel_permission';
const SESSION_KIND_KEY = 'moonwolf_panel_kind';

const $ = id => document.getElementById(id);

const escHtml = value => String(value ?? '')
  .replace(/&/g, '&')
  .replace(/</g, '<')
  .replace(/>/g, '>')
  .replace(/"/g, '"');

const AIKAR_FLAGS = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

/** @type {Record<string, { label: string, icon: string, level: string }>} */
const STATUS = {
  online:     { label: 'ONLINE',       icon: '🟢', level: 'ok' },
  offline:    { label: 'OFFLINE',      icon: '🔴', level: 'info' },
  starting:   { label: 'STARTING...',  icon: '🟡', level: 'info' },
  restarting: { label: 'RESTARTING...', icon: '🟡', level: 'warn' },
  stopping:   { label: 'STOPPING...',  icon: '🟠', level: 'warn' },
};

const DANGEROUS_UPLOAD_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif',
  '.cpl', '.dll', '.sys', '.drv', '.ocx', '.lnk', '.url', '.reg',
  '.jar',
]);
