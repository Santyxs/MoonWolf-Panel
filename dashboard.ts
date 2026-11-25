'use strict';

/* ══════════════════════════════════════════════
   0. AMBIENT (Socket.IO · CodeMirror)
   ══════════════════════════════════════════════ */

interface SocketEventMap {
  connect: [];
  connect_error: [error: unknown];
  direct_config: [data: unknown];
  direct_signal: [message: unknown];
  cloud_ready: [data: unknown];
  agent_status: [data: unknown];
  session_info: [data: unknown];
  share_revoked: [];
  status: [status: unknown];
  log: [entry: unknown];
  log_batch: [entries: unknown];
  history: [entries: unknown];
  stats: [stats: unknown];
  rpc_result: [result: unknown];
  agent_capabilities: [data: unknown];
  rpc_result_binary: [packet: unknown];
  disconnect: [reason: unknown];
}

interface SocketLike {
  on<K extends keyof SocketEventMap>(event: K, handler: (...args: SocketEventMap[K]) => void): SocketLike;
  once<K extends keyof SocketEventMap>(event: K, handler: (...args: SocketEventMap[K]) => void): SocketLike;
  off<K extends keyof SocketEventMap>(event: K, handler?: (...args: SocketEventMap[K]) => void): SocketLike;
  emit(event: string, ...args: unknown[]): SocketLike;
  connect(): SocketLike;
  disconnect(): SocketLike;
  connected: boolean;
  id?: string;
  auth?: Record<string, unknown>;
  io?: { engine?: { transport?: { name?: string } } };
}

interface SocketIoOptions {
  path?: string;
  transports?: string[];
  auth?:
    | Record<string, unknown>
    | ((callback: (data: Record<string, unknown>) => void) => void);
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  timeout?: number;
  forceNew?: boolean;
  autoConnect?: boolean;
  [key: string]: unknown;
}

interface SocketIoStatic {
  (url?: string, opts?: SocketIoOptions): SocketLike;
  (opts?: SocketIoOptions): SocketLike;
}

interface CodeMirrorDoc {
  getValue(): string;
  setValue(value: string): void;
  getSelection(): string;
  somethingSelected(): boolean;
}

interface CodeMirrorCursorPos {
  line: number;
  ch: number;
}

interface CodeMirrorEditor {
  getValue(): string;
  setValue(value: string): void;
  getDoc(): CodeMirrorDoc;
  setOption(option: string, value: unknown): void;
  getOption(option: string): unknown;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler?: (...args: unknown[]) => void): void;
  focus(): void;
  refresh(): void;
  setSize(width: string | number | null, height: string | number | null): void;
  getWrapperElement(): HTMLElement;
  toTextArea?(): void;
  scrollTo?(x: number | null, y: number | null): void;
  setCursor?(pos: CodeMirrorCursorPos): void;
  getCursor?(): CodeMirrorCursorPos;
  lineCount?(): number;
}

interface CodeMirrorStatic {
  (host: HTMLElement, options?: Record<string, unknown>): CodeMirrorEditor;
  fromTextArea?(textarea: HTMLTextAreaElement, options?: Record<string, unknown>): CodeMirrorEditor;
  modes?: Record<string, unknown>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
}

interface WritableFileStreamLike {
  write(chunk: Uint8Array | BufferSource | string | Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface SaveFileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>;
}

interface Window {
  io?: SocketIoStatic;
  CodeMirror?: CodeMirrorStatic;
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<SaveFileHandleLike>;
}

declare const io: SocketIoStatic | undefined;
declare const CodeMirror: CodeMirrorStatic | undefined;

/* ══════════════════════════════════════════════
   0b. TIPOS BASE
   ══════════════════════════════════════════════ */

type Permission = 'read' | 'control' | 'admin';
type PanelKind = 'owner' | 'share';
type ServerStatus = 'online' | 'offline' | 'starting' | 'restarting' | 'stopping';
type StatusLevel = 'ok' | 'info' | 'warn' | 'error';

interface StatusMeta {
  label: string;
  icon: string;
  level: StatusLevel;
}

interface ViewCacheEntry {
  at: number;
  data: unknown;
}

interface SoftLoadOptions {
  soft?: boolean;
  force?: boolean;
}

interface ConsoleLogEntry {
  line?: string;
  type?: string;
  time?: string;
  ts?: number | string;
  [key: string]: unknown;
}

interface FileListItem {
  name: string;
  type?: string;
  size?: number | string;
  date?: string;
  path?: string;
  mtime?: number | string;
  [key: string]: unknown;
}

interface FilesApiResponse {
  ok?: boolean;
  error?: string;
  items?: FileListItem[];
  dir?: string;
  [key: string]: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNumber(value: unknown): value is string | number {
  return isString(value) || isNumber(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function optionalField<T>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): boolean {
  return record[key] === undefined || guard(record[key]);
}

function isFileListItem(value: unknown): value is FileListItem {
  return isRecord(value) &&
    isString(value['name']) &&
    optionalField(value, 'type', isString) &&
    optionalField(value, 'size', isStringOrNumber) &&
    optionalField(value, 'date', isString) &&
    optionalField(value, 'path', isString) &&
    optionalField(value, 'mtime', isStringOrNumber);
}

function isFilesApiResponse(value: unknown): value is FilesApiResponse {
  return isRecord(value) &&
    optionalField(value, 'ok', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'error', isString) &&
    optionalField(value, 'dir', isString) &&
    (value['items'] === undefined || isArrayOf(value['items'], isFileListItem));
}

type FileConflictChoice = 'replace' | 'keep' | 'numbered' | 'cancel';

interface ConflictChoice {
  choice: FileConflictChoice;
  applyAll: boolean;
}

interface DeleteItem {
  path: string;
  [key: string]: unknown;
}

interface UploadFile extends File {
  customRelativePath?: string;
}

interface UploadChunkResponse {
  ok?: boolean;
  error?: string;
  status?: number;
  isFileConflict?: boolean;
  isRateLimited?: boolean;
}

interface UploadError extends Error {
  status?: number;
  isFileConflict?: boolean;
  isRateLimited?: boolean;
  isCancelled?: boolean;
}

interface UploadState {
  finished: boolean;
  cancelled: boolean;
  paused: boolean;
  status: string;
  completedFiles: number;
  totalFiles: number;
  totalBytes: number;
  doneBytes: number;
  startedAt: number;
  currentFile?: string;
  currentFileSize?: number;
  currentFileDone?: number;
  resumeUpload: (() => void) | null;
  rememberConflictChoice?: FileConflictChoice | null;
  conflictQueue?: Promise<unknown>;
  activeFiles?: number;
  [key: string]: unknown;
}

interface ActivityEntry {
  message: string;
  level?: string;
  icon?: string;
  time?: string;
  [key: string]: unknown;
}

interface DirectResponseHead {
  ok?: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  size?: number;
  error?: string;
  [key: string]: unknown;
}

interface RpcInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null | object | Uint8Array | ArrayBuffer;
  onProgress?: (done: number, total: number) => void;
  onHeaders?: (headers: DirectResponseHead) => void | Promise<void>;
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal | null;
}

interface RpcResult {
  id?: string | null;
  ok?: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  bodyBase64?: string;
  bodyBytes?: Uint8Array;
  
  streamed?: boolean;
  data?: unknown;
  error?: string;
  isFileConflict?: boolean;
  isRateLimited?: boolean;
}

interface ApiResult {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface PairResponse extends ApiResult {
  session: string;
  agent: { id: string };
  permission?: Permission;
  kind?: PanelKind;
}

interface VersionDetectionResponse extends ApiResult {
  version?: string;
  source?: string;
}

function isVersionDetectionResponse(value: unknown): value is VersionDetectionResponse {
  return isApiResult(value) &&
    optionalField(value, 'version', isString) &&
    optionalField(value, 'source', isString);
}

function isPairResponse(value: unknown): value is PairResponse {
  if (!isApiResult(value) || !isString(value['session']) || !value['session']) return false;
  const agent = value['agent'];
  if (!isRecord(agent) || !isString(agent['id']) || !agent['id']) return false;
  if (value['permission'] !== undefined && !isPermission(value['permission'])) return false;
  if (value['kind'] !== undefined && !isPanelKind(value['kind'])) return false;
  return true;
}

interface StartupConfig {
  jar?: string;
  minecraftVersion?: string;
  minMemoryMb?: number;
  maxMemoryMb?: number;
  stopCommand?: string;
  autoRestartOnCrash?: boolean;
  autoStartOnBoot?: boolean;
  serverPort?: number;
  javaPath?: string;
  javaMode?: string;
  javaOverridePath?: string;
  extraArgs?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiResult(value: unknown): value is ApiResult {
  return isRecord(value) &&
    optionalField(value, 'ok', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'error', isString);
}

function getApiError(value: unknown, fallback: string): string {
  return isApiResult(value) && typeof value.error === 'string' && value.error
    ? value.error
    : fallback;
}

function isPermission(value: unknown): value is Permission {
  return value === 'read' || value === 'control' || value === 'admin';
}

function isPanelKind(value: unknown): value is PanelKind {
  return value === 'owner' || value === 'share';
}

function isRpcResult(value: unknown): value is RpcResult & { id: string } {
  return isRecord(value) &&
    isString(value['id']) &&
    optionalField(value, 'ok', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'status', isNumber) &&
    optionalField(value, 'contentType', isString) &&
    optionalField(value, 'bodyBase64', isString) &&
    optionalField(value, 'error', isString);
}

function getErrorMessage(error: unknown, fallback = 'Error desconocido'): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return String(error ?? fallback);
}

function toIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];
  const servers: RTCIceServer[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry) {
      servers.push({ urls: entry });
      continue;
    }
    if (!isRecord(entry)) continue;
    const urls = entry['urls'];
    let normalizedUrls: string | string[] | null = null;
    if (isString(urls)) {
      normalizedUrls = urls;
    } else if (Array.isArray(urls) && urls.every(isString)) {
      normalizedUrls = urls.filter(isString);
    }
    if (normalizedUrls === null) continue;

    const server: RTCIceServer = { urls: normalizedUrls };
    const username = entry['username'];
    const credential = entry['credential'];
    if (typeof username === 'string') server.username = username;
    if (typeof credential === 'string') server.credential = credential;
    servers.push(server);
  }
  return servers;
}

function isSocketPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isStartupConfig(value: unknown): value is StartupConfig {
  return isRecord(value) &&
    optionalField(value, 'jar', isString) &&
    optionalField(value, 'minecraftVersion', isString) &&
    optionalField(value, 'minMemoryMb', isNumber) &&
    optionalField(value, 'maxMemoryMb', isNumber) &&
    optionalField(value, 'stopCommand', isString) &&
    optionalField(value, 'autoRestartOnCrash', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'autoStartOnBoot', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'serverPort', isNumber) &&
    optionalField(value, 'javaPath', isString) &&
    optionalField(value, 'javaMode', isString) &&
    optionalField(value, 'javaOverridePath', isString) &&
    optionalField(value, 'extraArgs', isString);
}

function isStartupResponse(value: unknown): value is StartupResponse {
  if (!isApiResult(value)) return false;
  if (value['config'] !== undefined && !isStartupConfig(value['config'])) return false;
  if (value['jars'] !== undefined && !isArrayOf(value['jars'], isString)) return false;
  if (value['serverPort'] !== undefined && !isNumber(value['serverPort'])) return false;
  if (value['versionDetection'] !== undefined) {
    const detection = value['versionDetection'];
    if (!isRecord(detection) ||
        !optionalField(detection, 'autoDetected', (item): item is boolean => typeof item === 'boolean') ||
        !optionalField(detection, 'source', isString)) return false;
  }
  if (value['javaRuntime'] !== undefined) {
    const runtime = value['javaRuntime'];
    if (!isRecord(runtime) ||
        !optionalField(runtime, 'javaMajor', (item): item is string | number => isString(item) || isNumber(item)) ||
        !optionalField(runtime, 'installed', (item): item is boolean => typeof item === 'boolean')) return false;
  }
  return true;
}

interface StartupResponse extends ApiResult {
  config?: StartupConfig;
  jars?: string[];
  serverPort?: number;
  versionDetection?: {
    autoDetected?: boolean;
    source?: string;
  };
  javaRuntime?: {
    javaMajor?: string | number;
    installed?: boolean;
  };
}

/* ══════════════════════════════════════════════
   1. CONSTANTES Y UTILIDADES
   ══════════════════════════════════════════════ */

const CLOUD_URL: string = location.origin;
const CLOUD_PATH = '/socket.io' as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const PAIRING_CODE_RE = /^MW-P[A-Z2-9]{3}-[A-Z2-9]{4}$/;
const SHARE_TOKEN_RE = /^MW-SHARE-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const SESSION_KEY = 'moonwolf_panel_session' as const;
const AGENT_KEY = 'moonwolf_agent_id' as const;
const PERMISSION_KEY = 'moonwolf_panel_permission' as const;
const SESSION_KIND_KEY = 'moonwolf_panel_kind' as const;

const domCache = new Map<string, HTMLElement>();

function $(id: string): HTMLElement | null {
  const cached = domCache.get(id);
  if (cached) {
    if (cached.isConnected) return cached;
    domCache.delete(id);
  }
  const el = document.getElementById(id);
  if (el) domCache.set(id, el);
  return el;
}

function $input(id: string): HTMLInputElement | null {
  const el = $(id);
  return el instanceof HTMLInputElement ? el : null;
}

function $select(id: string): HTMLSelectElement | null {
  const el = $(id);
  return el instanceof HTMLSelectElement ? el : null;
}

function $btn(id: string): HTMLButtonElement | null {
  const el = $(id);
  return el instanceof HTMLButtonElement ? el : null;
}

function invalidateDom(id?: string): void {
  if (id) domCache.delete(id);
  else domCache.clear();
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): (...args: Args) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      last = now;
      fn(...args);
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = undefined;
        fn(...args);
      }, remaining);
    }
  };
}

const AIKAR_FLAGS =
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

const STATUS = {
  online: { label: 'ONLINE', icon: '🟢', level: 'ok' },
  offline: { label: 'OFFLINE', icon: '🔴', level: 'info' },
  starting: { label: 'STARTING...', icon: '🟡', level: 'info' },
  restarting: { label: 'RESTARTING...', icon: '🟡', level: 'warn' },
  stopping: { label: 'STOPPING...', icon: '🟠', level: 'warn' },
} as const satisfies Record<ServerStatus, StatusMeta>;

const DANGEROUS_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif',
  '.cpl', '.dll', '.sys', '.drv', '.ocx', '.lnk', '.url', '.reg',
  '.jar',
]);

/* ══════════════════════════════════════════════
   2. ESTADO GLOBAL
   ══════════════════════════════════════════════ */

let cloudSocket: SocketLike | null = null;
let rpcBinarySupported = false;
let panelSession: string = sessionStorage.getItem(SESSION_KEY) || '';
let agentId: string = sessionStorage.getItem(AGENT_KEY) || '';
let panelPermission: Permission = asPermission(sessionStorage.getItem(PERMISSION_KEY));
let panelKind: PanelKind = asPanelKind(sessionStorage.getItem(SESSION_KIND_KEY));
let pairingCode = '';

let requestSequence = 0;
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;

let currentStatus: ServerStatus = 'offline';
let agentOnline = false;
let cloudConnecting = false;

let editor: CodeMirrorEditor | null = null;
let currentFile: string | null = null;
let selectedFilePaths: Set<string> = new Set();
const selectedFileTypes: Map<string, boolean> = new Map();
let lastUploadFiles: File[] = [];
let activeUploadState: UploadState | null = null;
let originalFileContent = '';
let currentDir = '';

let currentPlugin: unknown = null;
let pluginSource = 'all';
let priceFilter = 'all';

let pluginSearchGeneration = 0;

const pending: Map<string, (result: RpcResult) => void> = new Map();
const activities: ActivityEntry[] = [];

let lastAgentActivityState: unknown = null;
let lastStatusActivity: unknown = null;

const VIEW_CACHE_TTL_MS = 45_000;
const VIEW_CACHE_MAX_ENTRIES = 100;
const viewCache: Map<string, ViewCacheEntry> = new Map();
const viewInflight: Map<string, Promise<unknown>> = new Map();

function getViewCache(key: string, ttl: number = VIEW_CACHE_TTL_MS): unknown | null {
  const entry = viewCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.at >= ttl) {
    viewCache.delete(key);
    return null;
  }

  viewCache.delete(key);
  viewCache.set(key, entry);
  return entry.data;
}

function setViewCache(key: string, data: unknown): void {
  viewCache.delete(key);
  viewCache.set(key, { at: Date.now(), data });

  while (viewCache.size > VIEW_CACHE_MAX_ENTRIES) {
    const oldest = viewCache.keys().next();
    if (oldest.done) break;
    viewCache.delete(oldest.value);
  }
}

function invalidateViewCache(key?: string): void {
  if (key) viewCache.delete(key);
  else viewCache.clear();
}

function sectionHasContent(element: Element | null | undefined): boolean {
  if (!element) return false;
  const html = element.innerHTML || '';
  if (!html.trim()) return false;
  return !/Cargando|Conectando|ver-loading/i.test(html);
}

function cachedApi(
  cacheKey: string,
  pathname: string,
  init?: RpcInit,
  ttl: number = VIEW_CACHE_TTL_MS,
  force = false,
): Promise<unknown> {
  if (!force) {
    const cached = getViewCache(cacheKey, ttl);
    if (cached) return Promise.resolve(cached);

    const existing = viewInflight.get(cacheKey);
    if (existing) return existing;
  } else {
    invalidateViewCache(cacheKey);
    viewInflight.delete(cacheKey);
  }

  let request: Promise<unknown>;
  request = api(pathname, init)
    .then((data: unknown) => {

      if (viewInflight.get(cacheKey) === request && isRecord(data) && data['ok'] !== false) {
        setViewCache(cacheKey, data);
      }
      return data;
    })
    .finally(() => {
      if (viewInflight.get(cacheKey) === request) viewInflight.delete(cacheKey);
    });

  viewInflight.set(cacheKey, request);
  return request;
}

function resolveSoftLoad(
  options: SoftLoadOptions | null | undefined,
  element: Element | null | undefined,
): boolean {
  if (options && options.force) return false;
  return Boolean(options?.soft) || sectionHasContent(element);
}

/* ══════════════════════════════════════════════
   3. PERMISOS
   ══════════════════════════════════════════════ */

const PERMISSION_RANK: Record<Permission, number> = {
  read: 1,
  control: 2,
  admin: 3,
};

function asPermission(value: unknown): Permission {
  return isPermission(value) ? value : 'read';
}

function asPanelKind(value: unknown): PanelKind {
  return isPanelKind(value) ? value : 'share';
}

function hasPermission(required: Permission): boolean {
  return PERMISSION_RANK[panelPermission] >= PERMISSION_RANK[required];
}

function isOwnerSession(): boolean {
  return panelKind === 'owner';
}

function isDangerousUploadFile(file: File | { name?: string } | null | undefined): boolean {
  const name = String(file?.name || '').toLowerCase();
  const ext = name.match(/\.[a-z0-9]+$/)?.[0] || '';
  return DANGEROUS_UPLOAD_EXTENSIONS.has(ext);
}

/* ══════════════════════════════════════════════
   4. CARGADORES EXTERNOS (Socket.IO · CodeMirror)
   ══════════════════════════════════════════════ */

function ensureSocketIo(): Promise<void> {
  if (typeof window.io === 'function') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[data-moonwolf-socketio]');

    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('No se pudo cargar Socket.IO.')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.8.1/socket.io.min.js';
    script.async = true;
    script.dataset.moonwolfSocketio = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('No se pudo cargar Socket.IO.'));
    document.head.appendChild(script);
  });
}

let codeMirrorPromise: Promise<void> | null = null;

const CODEMIRROR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';

const CODEMIRROR_MODES: Record<string, string> = {
  javascript: `${CODEMIRROR_CDN}/mode/javascript/javascript.min.js`,
  yaml: `${CODEMIRROR_CDN}/mode/yaml/yaml.min.js`,
  xml: `${CODEMIRROR_CDN}/mode/xml/xml.min.js`,
  properties: `${CODEMIRROR_CDN}/mode/properties/properties.min.js`,
  shell: `${CODEMIRROR_CDN}/mode/shell/shell.min.js`,
  toml: `${CODEMIRROR_CDN}/mode/toml/toml.min.js`,
  nginx: `${CODEMIRROR_CDN}/mode/nginx/nginx.min.js`,
};

function loadExternalScript(src: string, dataAttr?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (dataAttr && document.querySelector(`script[data-cm-asset="${dataAttr}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    if (dataAttr) script.dataset.cmAsset = dataAttr;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(script);
  });
}

function loadExternalStylesheet(href: string, dataAttr?: string): void {
  if (dataAttr && document.querySelector(`link[data-cm-asset="${dataAttr}"]`)) {
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  if (dataAttr) link.dataset.cmAsset = dataAttr;
  document.head.appendChild(link);
}

async function ensureCodeMirror(mode?: string): Promise<boolean> {
  const modeUrl = mode ? CODEMIRROR_MODES[mode] : undefined;

  if (window.CodeMirror) {
    if (!modeUrl) return true;
    try {
      await loadExternalScript(modeUrl, `mode-${mode}`);
      return true;
    } catch {
      return false;
    }
  }

  if (!codeMirrorPromise) {
    loadExternalStylesheet(`${CODEMIRROR_CDN}/codemirror.min.css`, 'core-css');
    loadExternalStylesheet(`${CODEMIRROR_CDN}/theme/dracula.min.css`, 'dracula-css');

    codeMirrorPromise = loadExternalScript(`${CODEMIRROR_CDN}/codemirror.min.js`, 'core-js').catch(
      (error: unknown) => {
        codeMirrorPromise = null;
        throw error;
      },
    );
  }

  try {
    await codeMirrorPromise;
    if (modeUrl) {
      await loadExternalScript(modeUrl, `mode-${mode}`);
    }
    return true;
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════
   5. LOGIN Y SESIÓN
   ══════════════════════════════════════════════ */

function formatLoginCode(raw: unknown): string {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!clean) return '';
  if (clean === 'M' || clean === 'MW') return clean;

  const body = clean.startsWith('MW') ? clean.slice(2) : clean;

  if (body.startsWith('S')) {
    const head = body.slice(0, 5);
    if (body.length <= 5) return `MW-${head}`;

    const rest = body.slice(5).replace(/[^A-Z2-9]/g, '').slice(0, 16);
    const groups = rest.match(/.{1,4}/g) || [];

    return `MW-${head}${groups.length ? `-${groups.join('-')}` : ''}`;
  }

  const rest = (body.startsWith('P') ? body.slice(1) : body)
    .replace(/[^A-Z2-9]/g, '')
    .slice(0, 7);

  const first = rest.slice(0, 3);
  const second = rest.slice(3, 7);

  return `MW-P${first}${second ? `-${second}` : ''}`;
}

function ensureLoginGate() {
  if ($('loginGate')) return;

  const style = document.createElement('style');

  style.id = 'mw-cloud-login-style';

  style.textContent = `
    #loginGate{
      position:fixed;
      inset:0;
      z-index:99999;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#0d0f14;
      font-family:inherit
    }

    #loginGate.hidden{
      display:none
    }

    .mw-cloud-card{
      width:360px;
      max-width:90vw;
      padding:32px 28px;
      background:#171a21;
      border:1px solid #2a2e38;
      border-radius:14px;
      box-shadow:0 18px 60px rgba(0,0,0,.45);
      text-align:center
    }

    .mw-cloud-logo{
      width:56px;
      height:56px;
      margin:0 auto 14px;
      border-radius:16px;
      display:grid;
      place-items:center;
      box-shadow:0 0 24px rgba(0,200,255,.18)
    }
    .mw-cloud-logo img{display:block;width:100%;height:100%}
    .mw-cloud-card h1{
      font-size:18px;
      color:#eee;
      margin:0 0 6px;
      letter-spacing:.08em;
      font-family:Orbitron,sans-serif
    }

    .mw-cloud-card p{
      margin:0 0 18px;
      color:#888;
      font-size:12px;
      line-height:1.5
    }

    .mw-cloud-card input{
      width:100%;
      box-sizing:border-box;
      padding:12px;
      background:#0d0f14;
      border:1px solid #2a2e38;
      border-radius:9px;
      color:#eee;
      font:600 14px/1.2 ui-monospace,monospace;
      text-align:center;
      letter-spacing:.12em
    }

    .mw-cloud-card button{
      width:100%;
      margin-top:12px;
      padding:11px;
      border:1px solid rgba(0,200,255,.6);
      border-radius:9px;
      background:linear-gradient(180deg,#3fdcff 0%,#0a8fbf 100%);
      color:#02141c;
      font-weight:700;
      letter-spacing:.06em;
      cursor:pointer;
      box-shadow:0 0 18px rgba(0,200,255,.25);
      transition:filter .15s ease, box-shadow .15s ease, transform .15s ease
    }

    .mw-cloud-card button:hover:not(:disabled){
      filter:brightness(1.1);
      box-shadow:0 0 24px rgba(0,200,255,.4);
      transform:translateY(-1px)
    }

    #mwCloudError{
      min-height:18px;
      margin-top:12px;
      font-size:12px;
      color:#ff6b6b
    }

    .mw-cloud-help{
      margin-top:16px;
      color:#666;
      font-size:11px
    }

    .mw-cloud-help b{
      color:#aaa
    }
  `;

  document.head.appendChild(style);

  const gate = document.createElement('div');

  gate.id = 'loginGate';

  gate.innerHTML = `
    <div class="mw-cloud-card">
      <div class="mw-cloud-logo" aria-hidden="true">
        <img src="/icon.ico" width="56" height="56" alt="">
      </div>
      <h1>MOONWOLF CLOUD</h1>

      <p>
        Introduce el código de emparejamiento que muestra MoonWolf Agent
        o un token de acceso compartido.
      </p>

      <input
        id="loginPassword"
        type="text"
        maxlength="28"
        spellcheck="false"
        autocomplete="off"
        placeholder="MW-PXXX-XXXX / MW-SHARE-XXXX-XXXX-XXXX-XXXX"
      >

      <button id="btnLogin">CONECTAR SERVIDOR</button>

      <div id="mwCloudError"></div>

      <div class="mw-cloud-help">
        El código de emparejamiento se usa una sola vez. Los tokens compartidos
        pueden reutilizarse hasta que caduquen o sean revocados.
      </div>
    </div>
  `;

  document.body.prepend(gate);

  const loginPasswordInput = $input('loginPassword');
  loginPasswordInput?.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | null;
    if (target) target.value = formatLoginCode(target.value);
  });

  $('btnLogin')?.addEventListener('click', attemptLogin);

  loginPasswordInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      attemptLogin();
    }
  });
}

function showApp() {
  ensureLoginGate();

  $('loginGate')?.classList.add('hidden');
  document.querySelector('.app')?.classList.remove('locked');
}

function showLogin(errorMessage: string = ''): void {
  ensureLoginGate();

  $('loginGate')?.classList.remove('hidden');
  document.querySelector('.app')?.classList.add('locked');

  const errorBox = $('mwCloudError');
  if (errorBox) {
    errorBox.textContent = errorMessage;
  }

  const passwordInput = $input('loginPassword');
  if (passwordInput) {
    passwordInput.value = pairingCode;
  }
}

function setSession(session: string, id: string, permission: unknown = 'read', kind: unknown = 'share'): void {
  panelSession = String(session || '');
  agentId = String(id || '');
  panelPermission = asPermission(permission);
  panelKind = asPanelKind(kind);

  if (panelSession) {
    sessionStorage.setItem(SESSION_KEY, panelSession);
    sessionStorage.setItem(PERMISSION_KEY, panelPermission);
    sessionStorage.setItem(SESSION_KIND_KEY, panelKind);
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PERMISSION_KEY);
    sessionStorage.removeItem(SESSION_KIND_KEY);
  }

  if (agentId) {
    sessionStorage.setItem(AGENT_KEY, agentId);
  } else {
    sessionStorage.removeItem(AGENT_KEY);
  }
}

function clearSession(): void {
  setSession('', '', 'read', 'share');
  pairingCode = '';
}

function updateSessionMetadata(permission: unknown, kind: unknown): void {
  if (permission !== undefined) panelPermission = asPermission(permission);
  if (kind !== undefined) panelKind = asPanelKind(kind);
  sessionStorage.setItem(PERMISSION_KEY, panelPermission);
  sessionStorage.setItem(SESSION_KIND_KEY, panelKind);
}

async function attemptLogin(): Promise<void> {
  const input = $input('loginPassword');
  const button = $btn('btnLogin') || $('btnLogin');
  const errorBox = $('mwCloudError');

  const code = String(input?.value || '')
    .trim()
    .toUpperCase();

  if (!PAIRING_CODE_RE.test(code) && !SHARE_TOKEN_RE.test(code)) {
    if (errorBox) {
      errorBox.textContent =
        'Código inválido. Usa MW-PXXX-XXXX o un token MW-SHARE-...';
    }
    return;
  }

  if (button && 'disabled' in button) {
    (button as HTMLButtonElement).disabled = true;
    button.textContent = 'Emparejando...';
  }

  if (errorBox) errorBox.textContent = '';

  pairingCode = code;

  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const payload: unknown = await response.json();

    if (!response.ok || !isPairResponse(payload)) {
      throw new Error(getApiError(payload, 'No se pudo emparejar el panel.'));
    }

    setSession(
      payload.session,
      payload.agent.id,
      payload.permission ?? 'read',
      payload.kind ?? 'share'
    );
    pairingCode = '';

    await connectCloud(true);

    if (errorBox) errorBox.textContent = '';
  } catch (error: unknown) {
    pairingCode = '';
    const message = getErrorMessage(error, 'No se pudo emparejar el panel.');
    if (errorBox) errorBox.textContent = message;
    if (button) {
      button.textContent = 'CONECTAR SERVIDOR';
      if ('disabled' in button) (button as HTMLButtonElement).disabled = false;
    }
  }
}

/* ══════════════════════════════════════════════
   6. CONEXIÓN CLOUD (Socket.IO)
   ══════════════════════════════════════════════ */

function clearPending(errorMessage?: string): void {
  for (const [, resolve] of pending) {
    resolve({
      id: null,
      ok: false,
      status: 503,
      data: {
        ok: false,
        error: errorMessage,
      },
    });
  }

  pending.clear();
}

async function connectCloud(manual: boolean = false): Promise<void> {
  clearTimeout(connectTimer);

  if (!panelSession || !agentId) {
    showLogin('Empareja este panel con MoonWolf Agent.');

    return Promise.reject(new Error('Código de conexión inválido.'));
  }

  if (cloudSocket?.connected) {
    showApp();
    return;
  }

  rpcBinarySupported = false;
  await ensureSocketIo();
  const socketIo = window.io || io;
  if (typeof socketIo !== 'function') {
    throw new Error('Socket.IO no está disponible.');
  }

  if (cloudSocket) {
    try {
      cloudSocket.disconnect();
    } catch {}
  }

  cloudConnecting = true;
  updateAgentUi();
  updateAgentStatusBadges();

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (fn: (value?: unknown) => void, value?: unknown) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    cloudSocket = socketIo(CLOUD_URL, {
      autoConnect: false,
      path: CLOUD_PATH,
      transports: ['websocket'],
      reconnection: false,

      auth: callback => {
        callback({
          role: 'panel',
          session: panelSession,
        });
      },
    });

    cloudSocket.once('connect', () => {
      reconnectDelay = 1000;

      cloudConnecting = false;
      showApp();

      addActivity('Conectado a MoonWolf Cloud', 'ok', '☁️');

      updateAgentUi();
      updateAgentStatusBadges();

      finish(() => resolve());
    });

    cloudSocket.once('connect_error', (error: unknown) => {
      cloudConnecting = false;
      updateAgentUi();
      updateAgentStatusBadges();

      const message = getErrorMessage(error, 'No se pudo conectar con MoonWolf Cloud.');

      addActivity(message, 'warn', '⚠️');

      if (/unauthorized/i.test(message)) {
        clearSession();
        showLogin('La sesión del panel ha caducado. Introduce un nuevo código.');
      }

      finish(reject, new Error(message));
    });

    cloudSocket.on('direct_config', data => {
      if (!isSocketPayload(data)) return;
      const iceServers = toIceServers(data['iceServers']);
      if (!iceServers.length) return;

      const changed = JSON.stringify(direct.iceServers) !== JSON.stringify(iceServers);
      direct.iceServers = iceServers;
      if (changed && !directReady() && agentOnline) {
        closeDirectLink(false);
        void startDirectLink();
      }
    });

    cloudSocket.on('direct_signal', async msg => {
      const pc = direct.pc;
      if (!pc || !isSocketPayload(msg)) return;

      try {
        const type = msg['type'];
        if (type === 'answer') {
          const sdp = typeof msg['sdp'] === 'string' ? msg['sdp'] : '';
          await pc.setRemoteDescription({ type: 'answer', sdp });
        } else if (type === 'candidate' && typeof msg['candidate'] === 'string') {
          const sdpMid = typeof msg['sdpMid'] === 'string' ? msg['sdpMid'] : null;
          await pc.addIceCandidate({ candidate: msg['candidate'], sdpMid });
        } else if (type === 'unavailable') {
          closeDirectLink(true);
        }
      } catch {
        
      }
    });

    cloudSocket.on('cloud_ready', data => {
      const online = isSocketPayload(data) ? Boolean(data['agentOnline']) : false;
      setAgentOnline(online);
    });

    cloudSocket.on('agent_status', data => {
      const online = isSocketPayload(data) ? Boolean(data['online']) : false;
      setAgentOnline(online);
    });

    cloudSocket.on('session_info', data => {
      if (!isSocketPayload(data)) return;
      updateSessionMetadata(data['permission'], data['kind']);
      renderSettings();
      renderUsers();
    });

    cloudSocket.on('share_revoked', () => {
      clearSession();
      showLogin('Este acceso compartido ha sido revocado.');
    });

    cloudSocket.on('status', status => {
      if (isString(status)) setStatus(status);
    });
    cloudSocket.on('log', appendLog);
    cloudSocket.on('log_batch', entries => {
      if (Array.isArray(entries)) entries.forEach(appendLog);
    });

    cloudSocket.on('history', logs => {
      const consoleEl = $('console');

      if (!consoleEl) return;

      consoleEl.innerHTML = '';
      pendingConsoleLogs.length = 0;

      (Array.isArray(logs) ? logs : []).forEach(appendLog);
    });

    cloudSocket.on('stats', updateStats);

    cloudSocket.on('rpc_result', result => {
      if (!isRpcResult(result)) return;
      const resolveRequest = pending.get(result.id);
      if (!resolveRequest) return;

      pending.delete(result.id);
      resolveRequest(result);
    });

    cloudSocket.on('agent_capabilities', data => {
      rpcBinarySupported = isRecord(data) && data['rpcBinary'] === true;
    });

    cloudSocket.on('rpc_result_binary', async packet => {
      const binaryPacket: unknown = typeof Blob !== 'undefined' && packet instanceof Blob
        ? await packet.arrayBuffer()
        : packet;
      const decoded = decodeRpcBinaryPacket(binaryPacket);
      if (!decoded) return;

      const id = String(decoded.header?.id ?? '');
      const resolveRequest = pending.get(id);
      if (!resolveRequest) return;

      pending.delete(id);
      resolveRequest({
        id,
        ok: Boolean(decoded.header?.ok),
        status: Number(decoded.header?.status) || 500,
        contentType: decoded.header?.contentType || 'application/octet-stream',
        bodyBytes: decoded.body,
      });
    });

    cloudSocket.on('disconnect', reason => {
      rpcBinarySupported = false;
      cloudConnecting = false;
      setAgentOnline(false);

      currentStatus = 'offline';
      updateStatusUi('offline');
      updateAgentUi();
      updateAgentStatusBadges();

      clearPending('Conexión con MoonWolf Cloud perdida.');

      addActivity(`Cloud desconectado (${String(reason)})`, 'warn', '⚠️');

      if (manual) {
        showLogin(
          'La conexión se cerró. Comprueba que el Agent esté ejecutándose.'
        );
      }

      clearTimeout(connectTimer);

      connectTimer = setTimeout(() => {
        connectCloud(false).catch(() => {});
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    cloudSocket.connect();
  });
}

async function cloudApi(pathname: string, init: RpcInit = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${panelSession}`);
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    if (typeof init.body === 'string' || init.body instanceof Blob || init.body instanceof FormData || init.body instanceof URLSearchParams || init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
      body = init.body as BodyInit;
    } else {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      body = JSON.stringify(init.body);
    }
  }

  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (body !== undefined) requestInit.body = body;
  if (init.signal !== undefined) requestInit.signal = init.signal;
  const response = await fetch(pathname, requestInit);
  let data = null;

  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Error HTTP ${response.status}`);
  }

  return data;
}

function sendCloudRpcRequest(
  id: string,
  signal: AbortSignal | null | undefined,
  send: () => void,
): Promise<RpcResult> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise<RpcResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      pending.delete(id);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    };

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };

    const abortHandler = (): void => {

      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };

    timeout = setTimeout(() => {
      finish(() => reject(new Error('MoonWolf Agent no respondió a la solicitud. Comprueba la conexión e inténtalo de nuevo.')));
    }, 125_000);

    pending.set(id, result => finish(() => resolve(result)));

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) {
        abortHandler();
        return;
      }
    }

    try {
      send();
    } catch (error: unknown) {
      finish(() => reject(error));
    }
  });
}

function rpcCloudLegacy(pathname: string, init: RpcInit = {}): Promise<RpcResult> {
  if (!cloudSocket?.connected) {
    return Promise.reject(new Error('MoonWolf Cloud no está conectado.'));
  }

  const id = `${Date.now()}-${++requestSequence}`;
  const request = {
    id,
    method: String(init.method || 'GET').toUpperCase(),
    path: pathname,
    body: init.body ?? undefined,
  };

  return sendCloudRpcRequest(id, init.signal, () => {
    cloudSocket?.emit('rpc', request);
  });
}

const RPC_BINARY_MAGIC = new Uint8Array([0x4d, 0x57, 0x52, 0x31]);
const RPC_BINARY_MAX_HEADER = 64 * 1024;

function encodeRpcBinaryPacket(header: unknown, body: Uint8Array): Uint8Array {
  const headerBytes = TEXT_ENCODER.encode(JSON.stringify(header));
  if (!headerBytes.length || headerBytes.length > RPC_BINARY_MAX_HEADER) {
    throw new Error('Cabecera RPC demasiado grande.');
  }

  const packet = new Uint8Array(8 + headerBytes.length + body.length);
  packet.set(RPC_BINARY_MAGIC, 0);
  new DataView(packet.buffer).setUint32(4, headerBytes.length);
  packet.set(headerBytes, 8);
  packet.set(body, 8 + headerBytes.length);
  return packet;
}

function decodeRpcBinaryPacket(data: unknown): { header: RpcResult & { id: string }; body: Uint8Array } | null {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }

  if (bytes.length < 8 ||
      bytes[0] !== RPC_BINARY_MAGIC[0] ||
      bytes[1] !== RPC_BINARY_MAGIC[1] ||
      bytes[2] !== RPC_BINARY_MAGIC[2] ||
      bytes[3] !== RPC_BINARY_MAGIC[3]) return null;

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (!headerLength || headerLength > RPC_BINARY_MAX_HEADER || 8 + headerLength > bytes.length) return null;

  try {
    const header: unknown = JSON.parse(TEXT_DECODER.decode(bytes.subarray(8, 8 + headerLength)));
    if (!isRpcResult(header)) return null;
    return { header, body: bytes.slice(8 + headerLength) };
  } catch {
    return null;
  }
}

function rpcCloudBinary(pathname: string, init: RpcInit = {}): Promise<RpcResult> {
  if (!cloudSocket?.connected) {
    return Promise.reject(new Error('MoonWolf Cloud no está conectado.'));
  }

  const id = `${Date.now()}-${++requestSequence}`;
  const rawBody = init.body;
  const hasBody = rawBody !== undefined && rawBody !== null;
  let body = new Uint8Array(0);
  const headers = new Headers(init.headers || {});
  let contentType = headers.get('Content-Type') || 'application/json';

  if (hasBody) {
    if (rawBody instanceof Uint8Array) {
      body = rawBody as Uint8Array<ArrayBuffer>;
      contentType = headers.get('Content-Type') || 'application/octet-stream';
    } else if (rawBody instanceof ArrayBuffer) {
      body = new Uint8Array(rawBody);
      contentType = headers.get('Content-Type') || 'application/octet-stream';
    } else if (ArrayBuffer.isView(rawBody)) {
      body = new Uint8Array(rawBody.buffer as ArrayBuffer, rawBody.byteOffset, rawBody.byteLength);
      contentType = headers.get('Content-Type') || 'application/octet-stream';
    } else {

      body = TEXT_ENCODER.encode(JSON.stringify(rawBody));
      contentType = 'application/json';
    }
  }

  let packet;
  try {
    packet = encodeRpcBinaryPacket({
      id,
      method: String(init.method || 'GET').toUpperCase(),
      path: pathname,
      contentType,
      hasBody,
    }, body);
  } catch (error: unknown) {
    return Promise.reject(error);
  }

  return sendCloudRpcRequest(id, init.signal, () => {
    if (!cloudSocket) throw new Error('MoonWolf Cloud no está conectado');
    cloudSocket.emit('rpc_binary', packet);
  });
}

function rpcCloud(pathname: string, init: RpcInit = {}): Promise<RpcResult> {
  return rpcBinarySupported
    ? rpcCloudBinary(pathname, init)
    : rpcCloudLegacy(pathname, init);
}

const DF = { REQ_HEAD: 1, REQ_BODY: 2, REQ_END: 3, RES_HEAD: 17, RES_BODY: 18, RES_END: 19, RES_ERR: 20 };
const DIRECT_FRAME_BYTES = 16 * 1024;
const DIRECT_HIGH_WATER = 4 * 1024 * 1024;
const DIRECT_OPEN_TIMEOUT_MS = 15_000;

const DIRECT_ROUTES: ReadonlyArray<readonly [method: string, pattern: string]> = [
  ['GET', '/api/files'],
  ['GET', '/api/files/content'],
  ['POST', '/api/files/content'],
  ['GET', '/api/files/download'],
  ['POST', '/api/files/upload-chunk'],
  ['GET', '/api/backups/download/:name'],
];

interface DirectPendingRequest {
  resolve: (value: RpcResult) => void;
  reject: (reason?: unknown) => void;
  chunks: Uint8Array[];
  size: number;
  totalSize: number;
  head?: DirectResponseHead | null;
  writeChain?: Promise<void>;
  onProgress?: (loaded: number, total: number) => void;
  onHeaders?: (headers: DirectResponseHead) => void | Promise<void>;
  onChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

interface DirectState {
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  ready: boolean;
  iceServers: RTCIceServer[];
  nextId: number;
  reqs: Map<number, DirectPendingRequest>;
  waiters: Array<() => void>;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  openTimer: ReturnType<typeof setTimeout> | undefined;
  failures: number;
}

const direct: DirectState = {
  pc: null,
  dc: null,
  ready: false,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  nextId: 1,
  reqs: new Map(),
  waiters: [],
  retryTimer: undefined,
  openTimer: undefined,
  failures: 0,
};

/* ══════════════════════════════════════════════
   7. CANAL DIRECTO (WebRTC) Y CAPA API
   ══════════════════════════════════════════════ */

const directReady = () => direct.ready && direct.dc?.readyState === 'open';

function pathMatchesPattern(pathname: string, pattern: string): boolean {
  const pathParts = String(pathname || '').split('/');
  const patternParts = String(pattern || '').split('/');
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

function isDirectRoute(method: string, pathname: string): boolean {
  const route = String(pathname || '').split('?')[0] ?? '';
  return DIRECT_ROUTES.some(routeEntry =>
    routeEntry[0] === method && pathMatchesPattern(route, routeEntry[1] ?? '')
  );
}

function hasResultBody(result: RpcResult | null | undefined): boolean {
  return result?.bodyBytes !== undefined || result?.bodyBase64 !== undefined;
}

function wakeDirect(): void {
  const waiters = direct.waiters.splice(0);
  waiters.forEach(resolve => resolve());
}

function failDirectRequests(error: unknown): void {
  for (const req of direct.reqs.values()) req.reject(error);
  direct.reqs.clear();
}

function scheduleDirectRetry(): void {
  clearTimeout(direct.retryTimer);

  if (!cloudSocket?.connected || !agentOnline) return;

  direct.failures += 1;

  const delay = Math.min(15_000 * 2 ** Math.min(direct.failures - 1, 5), 5 * 60_000);

  direct.retryTimer = setTimeout(startDirectLink, delay);
}

function closeDirectLink(retry: boolean = false): void {
  clearTimeout(direct.openTimer);

  const { pc, dc } = direct;
  const wasReady = direct.ready;

  direct.pc = null;
  direct.dc = null;
  direct.ready = false;

  if (pc) pc.onconnectionstatechange = null;
  if (dc) dc.onclose = null;

  try { pc?.close(); } catch {}

  failDirectRequests(new Error('Canal directo cerrado'));
  wakeDirect();

  if (wasReady) {
    addActivity('Canal directo cerrado; las operaciones de archivos esperan a que se reconecte', 'warn', '⚡');
    updateAgentStatusBadges();
  }

  if (retry) scheduleDirectRetry();
  else clearTimeout(direct.retryTimer);
}

async function startDirectLink(): Promise<void> {
  if (direct.pc || directReady()) return;
  if (!cloudSocket?.connected || !agentOnline || typeof RTCPeerConnection === 'undefined') return;

  clearTimeout(direct.retryTimer);

  const pc = new RTCPeerConnection({ iceServers: direct.iceServers });
  const dc = pc.createDataChannel('moonwolf', { ordered: true });

  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 256 * 1024;

  direct.pc = pc;
  direct.dc = dc;

  pc.onicecandidate = event => {
    if (!event.candidate) return;

    cloudSocket?.emit('direct_signal', {
      type: 'candidate',
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
    });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closeDirectLink(true);
  };

  dc.onopen = () => {
    clearTimeout(direct.openTimer);
    direct.ready = true;
    direct.failures = 0;
    wakeDirect();
    addActivity('Canal directo con el Agent activo', 'ok', '⚡');
    updateAgentStatusBadges();
  };

  dc.onclose = () => closeDirectLink(true);
  dc.onbufferedamountlow = wakeDirect;
  dc.onmessage = event => { void onDirectMessage(event.data); };

  direct.openTimer = setTimeout(() => {
    if (directReady()) return;

    addActivity('No se pudo establecer el canal directo; las transferencias usarán Cloud (más lento)', 'warn', '⚡');
    closeDirectLink(true);
  }, DIRECT_OPEN_TIMEOUT_MS);

  try {
    await pc.setLocalDescription(await pc.createOffer());
    cloudSocket?.emit('direct_signal', { type: 'offer', sdp: pc.localDescription?.sdp });
  } catch {
    closeDirectLink(true);
  }
}

async function sendDirect(type: number, id: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
  while (true) {
    const openChannel = direct.dc;
    if (!directReady() || !openChannel) break;
    if (openChannel.bufferedAmount <= DIRECT_HIGH_WATER) break;
    await new Promise<void>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        const index = direct.waiters.indexOf(finish);
        if (index !== -1) direct.waiters.splice(index, 1);
        resolve();
      };
      timer = setTimeout(finish, 2000);
      direct.waiters.push(finish);
    });
  }

  const channel = direct.dc;
  if (!directReady() || !channel) {
    throw new Error('Canal directo no disponible');
  }

  const frame = new Uint8Array(5 + payload.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, id);
  frame.set(payload, 5);
  channel.send(frame);
}

async function onDirectMessage(data: ArrayBuffer | Uint8Array): Promise<void> {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 5) return;

  const view = new DataView(data);
  const type = view.getUint8(0);
  const id = view.getUint32(1);
  const req = direct.reqs.get(id);

  if (!req) return;

  if (type === DF.RES_HEAD) {
    let rawHead: unknown;
    try {
      rawHead = JSON.parse(TEXT_DECODER.decode(new Uint8Array(data, 5)));
    } catch {
      req.reject(new Error('Cabecera directa malformada'));
      direct.reqs.delete(id);
      return;
    }
    if (!isRecord(rawHead)) {
      req.reject(new Error('Cabecera directa no válida'));
      direct.reqs.delete(id);
      return;
    }
    req.head = rawHead;
    req.totalSize = Number(rawHead['contentLength'] ?? rawHead['size'] ?? 0) || 0;
    if (req.onHeaders) {
      try { await req.onHeaders(rawHead); } catch (error: unknown) { req.reject(error); direct.reqs.delete(id); return; }
    }
    if (req.onProgress) {
      req.onProgress(0, req.totalSize);
    }
  } else if (type === DF.RES_BODY) {
    const chunk = new Uint8Array(data, 5);
    req.size += chunk.length;
    const status = typeof req.head?.['status'] === 'number' ? req.head['status'] : undefined;
    if (req.onChunk && status !== undefined && status >= 200 && status < 300) {
      const onChunk = req.onChunk;
      req.writeChain = (req.writeChain ?? Promise.resolve()).then(() => {
        const result = onChunk(chunk);
        return result === undefined ? undefined : Promise.resolve(result).then(() => undefined);
      });
      req.writeChain.catch((error: unknown) => {
        if (direct.reqs.has(id)) {
          direct.reqs.delete(id);
          req.reject(error);
          try { void sendDirect(DF.REQ_END, id); } catch {  }
        }
      });
    } else {
      req.chunks.push(chunk);
    }
    if (req.onProgress) {
      req.onProgress(req.size, req.totalSize);
    }
  } else if (type === DF.RES_END) {
    direct.reqs.delete(id);
    try { await req.writeChain; } catch (error: unknown) { req.reject(error); return; }

    const statusRaw = req.head?.['status'];
    const status = typeof statusRaw === 'number' ? statusRaw : 502;
    let bytes: Uint8Array | undefined;
    if (!req.onChunk || status < 200 || status >= 300) {
      bytes = new Uint8Array(req.size);
      let offset = 0;
      for (const chunk of req.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }

    const contentTypeRaw = req.head?.['contentType'];
    const contentType = typeof contentTypeRaw === 'string' ? contentTypeRaw : 'application/octet-stream';
    const result: RpcResult = {
      id: null,
      ok: status >= 200 && status < 300,
      status,
      contentType,
    };
    if (bytes) result.bodyBytes = bytes;
    else result.streamed = true;
    req.resolve(result);
  } else if (type === DF.RES_ERR) {
    direct.reqs.delete(id);
    req.reject(new Error(TEXT_DECODER.decode(new Uint8Array(data, 5))));
  }
}

async function directRequest(method: string, pathname: string, body?: unknown, { onProgress, onHeaders, onChunk, signal }: Pick<RpcInit, "onProgress" | "onHeaders" | "onChunk" | "signal"> = {}): Promise<RpcResult> {
  const id = direct.nextId++ >>> 0;
  const isBinary = body instanceof Uint8Array;

  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  const payload = body === undefined || body === null
    ? null
    : isBinary ? body : TEXT_ENCODER.encode(typeof body === 'string' ? body : JSON.stringify(body));

  let requestStarted = false;
  let abortHandler: (() => void) | undefined;

  const done = new Promise<RpcResult>((resolve, reject) => {
    direct.reqs.set(id, {
      resolve,
      reject,
      head: null,
      chunks: [],
      size: 0,
      totalSize: 0,
      writeChain: Promise.resolve(),
      ...(onProgress ? { onProgress } : {}),
      ...(onHeaders ? { onHeaders } : {}),
      ...(onChunk ? { onChunk } : {}),
    });
  });

  if (signal) {
    abortHandler = () => {
      const request = direct.reqs.get(id);
      if (!request) return;

      direct.reqs.delete(id);
      request.reject(new DOMException('Aborted', 'AbortError'));

      if (requestStarted) {
        void sendDirect(DF.REQ_END, id).catch(() => {});
      }
    };

    signal.addEventListener('abort', abortHandler, { once: true });
  }

  done.catch(() => {});

  try {
    if (signal?.aborted) {
      return await done;
    }

    requestStarted = true;
    await sendDirect(DF.REQ_HEAD, id, TEXT_ENCODER.encode(JSON.stringify({
      method,
      path: pathname,
      contentType: isBinary ? 'application/octet-stream' : 'application/json',
    })));

    if (payload) {
      for (let off = 0; off < payload.length; off += DIRECT_FRAME_BYTES) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await sendDirect(DF.REQ_BODY, id, new Uint8Array(payload.subarray(off, off + DIRECT_FRAME_BYTES)));
      }
    }

    await sendDirect(DF.REQ_END, id);
    return await done;
  } catch (error: unknown) {
    const request = direct.reqs.get(id);
    if (request) request.reject(error);
    direct.reqs.delete(id);
    throw error;
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}
async function waitForDirectReady(
  timeoutMs: number = DIRECT_OPEN_TIMEOUT_MS,
  signal?: AbortSignal | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!directReady()) {
    if (signal?.aborted) {
      throw new DOMException('Espera WebRTC cancelada', 'AbortError');
    }
    if (!cloudSocket?.connected) {
      throw new Error('MoonWolf Cloud no está conectado. No se ha transferido ningún dato de archivo.');
    }
    if (!agentOnline) {
      throw new Error('MoonWolf Agent está desconectado. No se ha transferido ningún dato de archivo.');
    }
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('Este navegador no admite WebRTC. La transferencia por Cloud está desactivada para evitar consumir tráfico.');
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Conexión directa no disponible. No se ha transferido ningún dato por MoonWolf Cloud. Espera a que WebRTC se conecte e inténtalo de nuevo.');
    }

    startDirectLink();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        const index = direct.waiters.indexOf(wake);
        if (index !== -1) direct.waiters.splice(index, 1);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException('Espera WebRTC cancelada', 'AbortError'));
      };
      const wake = () => finish();
      timer = setTimeout(finish, remaining);
      direct.waiters.push(wake);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

function rpcHttp(pathname: string, init: RpcInit = {}): Promise<RpcResult> {
  const method = String(init.method || 'GET').toUpperCase();

  if (isDirectRoute(method, pathname)) {
    return waitForDirectReady(DIRECT_OPEN_TIMEOUT_MS, init.signal).then(() =>
      directRequest(method, pathname, init.body, {
        ...(init.onProgress ? { onProgress: init.onProgress } : {}),
        ...(init.onHeaders ? { onHeaders: init.onHeaders } : {}),
        ...(init.onChunk ? { onChunk: init.onChunk } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
      })
    ).catch(error => {
      if (init.signal?.aborted || error?.name === 'AbortError') throw error;
      console.warn('[moonwolf] WebRTC no disponible, usando Cloud:', error.message);
      return rpcCloud(pathname, init);
    });
  }

  return rpcCloud(pathname, init);
}

function decodeResultBody(result: RpcResult | null | undefined): Uint8Array | null {
  if (result?.bodyBytes) return result.bodyBytes;

  if (result?.bodyBase64 === undefined) {
    return null;
  }

  const binary = atob(result.bodyBase64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function api(pathname: string, init: RpcInit = {}): Promise<unknown> {
  const result = await rpcHttp(pathname, init);

  const status = result?.status || 500;
  const contentType = result?.contentType || 'application/json';

  if (hasResultBody(result)) {
    const bytes = decodeResultBody(result) || new Uint8Array(0);
    const text = TEXT_DECODER.decode(bytes);

    if (
      contentType.includes('application/json') ||
      contentType.includes('text/')
    ) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return {
          ok: status >= 200 && status < 300,
          status,
          content: text,
        };
      }
    }
  }

  return result?.data || {
    ok: Boolean(result?.ok),
    status,
    error: 'Respuesta vacía.',
  };
}

function postJSON(pathname: string, body?: unknown): Promise<unknown> {
  return api(pathname, { method: 'POST', body });
}

/* ══════════════════════════════════════════════
   8. ESTADO DEL AGENTE Y SERVIDOR
   ══════════════════════════════════════════════ */

function setAgentOnline(online: boolean): void {
  const nextState = Boolean(online);
  const previousState = agentOnline;

  agentOnline = nextState;
  if (nextState) startDirectLink();
  else closeDirectLink(false);

  if (previousState === nextState) {
    updateAgentUi();
    updateStatusUi(currentStatus);
    updateAgentStatusBadges();
    return;
  }

  updateAgentUi();
  updateStatusUi(currentStatus);
  updateAgentStatusBadges();

  if (nextState) {
    invalidateViewCache();
    void refreshServerStatus();
    if (lastAgentActivityState !== true) {
      addActivity('MoonWolf Agent conectado', 'ok', '🟢');
    }

    lastAgentActivityState = true;
  } else {
    if (lastAgentActivityState !== false) {
      addActivity('MoonWolf Agent desconectado', 'warn', '🔴');
    }

    lastAgentActivityState = false;
  }
}

function updateAgentUi() {
  const state = cloudConnecting
    ? 'connecting'
    : (agentOnline ? 'online' : 'offline');

  const elements = [
    $('agentStatus'),
    $('sbAgentStatus'),
    $('agentConnectionStatus'),
  ];

  for (const element of elements) {
    if (!element) continue;

    element.classList.toggle('online',     state === 'online');
    element.classList.toggle('offline',    state === 'offline');
    element.classList.toggle('connecting', state === 'connecting');

    if (element.dataset && element.dataset.agentStatus !== undefined) {
      element.dataset.agentStatus = state;
    }
  }

  const text = {
    online:     'AGENT ONLINE',
    offline:    'AGENT OFFLINE',
    connecting: 'AGENT CONECTANDO...',
  }[state];

  for (const element of [$('agentStatusText'), $('sbAgentStatusText')]) {
    if (element) element.textContent = text;
  }
}

function updateAgentStatusBadges() {
  if ($('view-settings')?.classList.contains('active')) {
    renderSettings();
  }
}

function toServerStatus(value: string): ServerStatus {
  if (value === 'online' || value === 'offline' || value === 'starting' || value === 'restarting' || value === 'stopping') {
    return value;
  }
  return 'offline';
}

function updateStatusUi(status: string): void {
  const normalized = toServerStatus(status);

  currentStatus = normalized;
  status = normalized;

  const statusEl = $('sbStatus');

  if (statusEl) {
    statusEl.className = `sb-status ${status}`;
  }

  const statusText = $('sbStatusText');

  if (statusText) {
    statusText.textContent =
      STATUS[normalized]?.label || String(status).toUpperCase();
  }

  const startButton = $btn('btnStart');

  if (startButton) {
    startButton.disabled = status !== 'offline' || !agentOnline;
  }

  const stopButton = $btn('btnStop');

  if (stopButton) {

    const canStop = ['online', 'starting', 'restarting', 'stopping'].includes(status);
    stopButton.disabled = !canStop || !agentOnline;
  }

  const restartButton = $btn('btnRestart');

  if (restartButton) {
    const canRestart = status === 'online';
    restartButton.disabled = !canRestart || !agentOnline;
  }

  const stats = $('statsGrid');

  if (stats) {
    stats.classList.toggle('hidden', status === 'offline');
    stats.classList.toggle('visible', status !== 'offline');
  }
}

async function refreshServerStatus() {
  if (!agentOnline || !cloudSocket?.connected) return;
  try {
    const data = await api('/api/status');
    if (isRecord(data) && isString(data['status']) && STATUS[toServerStatus(data['status'])]) {
      setStatus(data['status']);
    }
  } catch (error: unknown) {
    console.warn('[moonwolf] No se pudo sincronizar el estado del servidor:', error);
  }
}

function setStatus(status: string): void {
  updateStatusUi(status);

  const normalized = toServerStatus(status);

  if (lastStatusActivity === normalized) {
    return;
  }

  lastStatusActivity = normalized;

  addActivity(
    STATUS[normalized]?.label || normalized,
    STATUS[normalized]?.level || 'info',
    STATUS[normalized]?.icon || '📌'
  );
}

function updateStats(payload: unknown): void {
  const stats = isRecord(payload) ? payload : {};
  const players = Number(stats['players']);
  const maxPlayers = Number(stats['maxPlayers']);
  const tps = Number(stats['tps']);
  const processMemory = Number(stats['processMemory']);
  const cpuUsage = Number(stats['cpuUsage']);

  const safePlayers = Number.isFinite(players) ? players : 0;
  const safeMaxPlayers = Number.isFinite(maxPlayers) ? maxPlayers : 0;
  const hasTps = stats['tps'] !== null && stats['tps'] !== undefined && Number.isFinite(tps);
  const safeTps = hasTps ? tps : 0;
  const safeProcessMemory = Number.isFinite(processMemory) ? processMemory : 0;
  const safeCpu = Number.isFinite(cpuUsage) ? cpuUsage : 0;

  const statPlayers = $('statPlayers');
  if (statPlayers) {
    statPlayers.innerHTML = `${safePlayers}<span class="stat-unit">/${safeMaxPlayers}</span>`;
  }

  const tpsEl = $('statTps');

  if (tpsEl) {
    tpsEl.className = hasTps
      ? `stat-value ${safeTps < 15 ? 'tps-bad' : safeTps < 18 ? 'tps-warn' : 'tps-good'}`
      : 'stat-value';
    tpsEl.innerHTML = hasTps
      ? `${safeTps.toFixed(1)}<span class="stat-unit"> tps</span>`
      : '—';
  }

  const statUptime = $('statUptime');
  if (statUptime) {
    statUptime.textContent = isString(stats['uptime']) ? stats['uptime'] : '0h 0m';
  }

  const statMemProc = $('statMemProc');
  if (statMemProc) {
    statMemProc.innerHTML = `${safeProcessMemory}<span class="stat-unit"> MB</span>`;
  }

  const sys = isRecord(stats['sysMemory']) ? stats['sysMemory'] : {};

  const used = Number(sys['used']);
  const total = Number(sys['total']);

  const safeUsed = Number.isFinite(used) ? used : 0;
  const safeTotal = Number.isFinite(total) ? total : 0;

  const statMemSys = $('statMemSys');
  if (statMemSys) {
    statMemSys.innerHTML = `${safeUsed}/${safeTotal}<span class="stat-unit"> GB</span>`;
  }

  const statCpu = $('statCpu');
  if (statCpu) {
    statCpu.innerHTML = `${safeCpu}<span class="stat-unit"> %</span>`;
  }
}

const LOG_IGNORE_PATTERNS = [
  /Thread RCON Client \/127\.0\.0\.1 (started|shutting down)/i,
];

const METRIC_REPLY_PATTERNS = [
  /There are \d+ of a max of \d+ players online/i,
  /TPS from last 1m,? 5m,? 15m:/i,
  /Average tick time:.*TPS/i,
  /Target tick rate:.*Average time per tick/i,
  /Server TPS:.*|MSPT:.*|\bmspt\b/i,
  /Tick statistics.*|tick rate/i,
];

const METRIC_CMD_RE = /^(list|tps|tick query)\s*$/i;

let suppressMetricRepliesUntil = 0;
let pendingUserMetricCmd = false;

/* ══════════════════════════════════════════════
   9. TERMINAL / CONSOLA
   ══════════════════════════════════════════════ */

function shouldIgnoreLog(line: unknown): boolean {
  const text = String(line || '');

  if (LOG_IGNORE_PATTERNS.some(re => re.test(text))) return true;

  if (/^\s*>\s*(list|tps|tick query)\s*$/i.test(text)) {
    if (pendingUserMetricCmd) {
      pendingUserMetricCmd = false;
      suppressMetricRepliesUntil = 0;
      return false;
    }
    suppressMetricRepliesUntil = Date.now() + 2500;
    return true;
  }

  if (Date.now() < suppressMetricRepliesUntil) {
    if (METRIC_REPLY_PATTERNS.some(re => re.test(text))) return true;
  }

  return false;
}

const CONSOLE_FORMAT_RE = /\x1b\[([0-9;]*)m|\u00a7x(?:\u00a7[0-9a-f]){6}|\u00a7([0-9a-fk-or])/gi;
const ANSI_COLORS: Record<number, string> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow',
  94: 'bright-blue', 95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
};
const MINECRAFT_COLORS: Record<string, string> = {
  0: 'black', 1: 'dark-blue', 2: 'dark-green', 3: 'dark-aqua',
  4: 'dark-red', 5: 'dark-purple', 6: 'gold', 7: 'gray',
  8: 'dark-gray', 9: 'blue', a: 'green', b: 'aqua',
  c: 'red', d: 'light-purple', e: 'yellow', f: 'white',
};

function xtermColor(index: unknown): string {
  const n = Math.max(0, Math.min(255, Number(index) || 0));
  const base = [
    '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
    '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  if (n < 16) return base[n] ?? base[0] ?? '#000000';
  if (n >= 232) {
    const shade = 8 + (n - 232) * 10;
    return `#${shade.toString(16).padStart(2, '0').repeat(3)}`;
  }
  const value = n - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const r = levels[Math.floor(value / 36)] ?? 0;
  const g = levels[Math.floor((value % 36) / 6)] ?? 0;
  const b = levels[value % 6] ?? 0;
  return `#${[r, g, b].map(part => part.toString(16).padStart(2, '0')).join('')}`;
}

function renderConsoleText(value: unknown): string {
  const text = String(value || '');
  let html = '';
  let cursor = 0;
  let colorClass = '';
  let inlineColor = '';
  let inlineBackground = '';
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;
  let match;

  const resetFormatting = () => {
    colorClass = '';
    inlineColor = '';
    inlineBackground = '';
    bold = false;
    italic = false;
    underline = false;
    strike = false;
  };

  const append = (chunk: string) => {
    if (!chunk) return;
    const classes = [
      colorClass,
      bold && 'ansi-bold',
      italic && 'ansi-italic',
      underline && 'ansi-underline',
      strike && 'ansi-strike',
    ].filter(Boolean).join(' ');
    const styles = [];
    if (inlineColor) styles.push(`color:${inlineColor}`);
    if (inlineBackground) styles.push(`background-color:${inlineBackground}`);
    const attributes = `${classes ? ` class="${classes}"` : ''}${styles.length ? ` style="${styles.join(';')}"` : ''}`;
    html += attributes
      ? `<span${attributes}>${escHtml(chunk)}</span>`
      : escHtml(chunk);
  };

  while ((match = CONSOLE_FORMAT_RE.exec(text))) {
    append(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    if (!match[1] && !match[2] && /^\u00a7x/i.test(match[0])) {
      const hex = match[0].replace(/\u00a7/gi, '').slice(1);
      if (/^[0-9a-f]{6}$/i.test(hex)) {
        colorClass = '';
        inlineColor = `#${hex}`;
        inlineBackground = '';
        bold = italic = underline = strike = false;
      }
      continue;
    }

    if (match[2]) {
      const code = match[2].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(MINECRAFT_COLORS, code)) {
        colorClass = `mc-${MINECRAFT_COLORS[code]}`;
        inlineColor = '';
        inlineBackground = '';
        bold = italic = underline = strike = false;
      } else if (code === 'r') {
        resetFormatting();
      } else if (code === 'l') {
        bold = true;
      } else if (code === 'o') {
        italic = true;
      } else if (code === 'n') {
        underline = true;
      } else if (code === 'm') {
        strike = true;
      }

      continue;
    }

    const codes = (match[1] || '0').split(';').map(part => part === '' ? 0 : Number(part));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === undefined) continue;
      if (code === 0) {
        resetFormatting();
      } else if (code === 1) {
        bold = true;
      } else if (code === 3) {
        italic = true;
      } else if (code === 4) {
        underline = true;
      } else if (code === 9) {
        strike = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 23) {
        italic = false;
      } else if (code === 24) {
        underline = false;
      } else if (code === 29) {
        strike = false;
      } else if (code === 39) {
        colorClass = '';
        inlineColor = '';
      } else if (code === 49) {
        inlineBackground = '';
      } else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isFinite(codes[i + 2])) {
        const hex = xtermColor(codes[i + 2]);
        if (code === 38) {
          colorClass = '';
          inlineColor = hex;
        } else {
          inlineBackground = hex;
        }
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2
        && [codes[i + 2], codes[i + 3], codes[i + 4]].every(Number.isFinite)) {
        const rgb = codes.slice(i + 2, i + 5).map(part => Math.max(0, Math.min(255, part)));
        const hex = `#${rgb.map(part => part.toString(16).padStart(2, '0')).join('')}`;
        if (code === 38) {
          colorClass = '';
          inlineColor = hex;
        } else {
          inlineBackground = hex;
        }
        i += 4;
      } else {
        const ansiColor = ANSI_COLORS[code];
        if (ansiColor) {
          colorClass = `ansi-${ansiColor}`;
          inlineColor = '';
        }
      }
    }
  }

  append(text.slice(cursor));
  CONSOLE_FORMAT_RE.lastIndex = 0;
  return html;
}

function getConsoleLogType(entry: ConsoleLogEntry | null | undefined): string {
  const explicitType = String(entry?.type || 'info').toLowerCase();
  const line = String(entry?.line || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\u00a7(?:x(?:\u00a7[0-9a-f]){6}|[0-9a-fk-or])/gi, '')
    .slice(0, 220);

  if (/\b(?:ERROR|FATAL|SEVERE)\b(?=[\]/:])/i.test(line)) return 'error';
  if (/\b(?:WARN|WARNING)\b(?=[\]/:])/i.test(line)) return 'warn';
  if (/^\s*>/.test(line)) return 'cmd';
  if (/\b(?:SUCCESS|DONE)\b(?=[\]:.]|\s*\()/i.test(line)) return 'success';
  return ['error', 'warn', 'success', 'system', 'cmd'].includes(explicitType) ? explicitType : 'info';
}

const MAX_CONSOLE_LINES = 3_000;
const pendingConsoleLogs: ConsoleLogEntry[] = [];
let consoleFlushScheduled = false;

const consolePluginStates = new Map<string, boolean>();
let consolePluginListSection = '';

function rememberPluginState(line: unknown): void {
  const text = String(line || '');
  const match = text.match(/\b(Enabling|Enabled|Disabling|Disabled)\s+(.+?)\s+v[^\s]+/i);
  const action = match?.[1];
  const name = match?.[2]?.trim();
  if (!action || !name) return;
  consolePluginStates.set(name.toLowerCase(), /^(?:Enabling|Enabled)$/i.test(action));
}

function renderPluginListLine(line: unknown): string {
  const text = String(line || '');
  if (!consolePluginListSection) return renderConsoleText(text);

  const loggerMatch = text.match(/^(.*?\]:\s*)(.*)$/);
  const prefix = loggerMatch?.[1] ?? '';
  let namesText = loggerMatch?.[2] ?? text;
  if (namesText.startsWith('- ')) namesText = namesText.slice(2);
  const names = namesText.split(/,\s*/);
  const renderedNames = names.map(name => {
    const cleanName = name.trim();
    if (!cleanName) return '';
    const enabled = consolePluginStates.get(cleanName.toLowerCase());

    const color = enabled === false ? 'mc-red' : 'mc-green';
    return `<span class="${color}">${escHtml(cleanName)}</span>`;
  }).join('<span>, </span>');
  return renderConsoleText(prefix) + renderedNames;
}

function renderConsoleEntry(line: unknown): string {
  rememberPluginState(line);
  const text = String(line || '');
  if (/\b(?:Paper|Bukkit) Plugins?\s*\(\d+\)\s*:/i.test(text)) {
    consolePluginListSection = /Bukkit Plugins/i.test(text) ? 'bukkit' : 'paper';
    return renderConsoleText(text);
  }
  if (consolePluginListSection) {

    const loggerMatch = text.match(/^.*?\]:\s*(.*)$/);
    const content = loggerMatch?.[1] ?? text;
    if (/^-\s*[^,]+/.test(content) || /,\s*[^,]+/.test(content)) {
      return renderPluginListLine(text);
    }

    if (!/\b(?:INFO|WARN|ERROR)\b/i.test(text)) consolePluginListSection = '';
  }
  return renderConsoleText(text);
}

function flushConsoleLogs() {
  consoleFlushScheduled = false;
  const consoleEl = $('console');
  if (!consoleEl || !pendingConsoleLogs.length) return;

  const fragment = document.createDocumentFragment();
  for (const entry of pendingConsoleLogs.splice(0)) {
    const div = document.createElement('div');
    div.className = `log-line ${getConsoleLogType(entry)}`;
    div.innerHTML =
      `<span class="log-time">${escHtml(entry.time || '--:--:--')}</span>` +
      `<span class="log-text">${renderConsoleEntry(entry.line)}</span>`;
    fragment.appendChild(div);
  }

  const excess = consoleEl.childElementCount + fragment.childElementCount - MAX_CONSOLE_LINES;
  if (excess >= consoleEl.childElementCount && excess > 0) {
    consoleEl.replaceChildren();
  } else if (excess > 0) {

    if (excess > 80) {
      const range = document.createRange();
      range.setStartBefore(consoleEl.firstChild!);
      range.setEndAfter(consoleEl.children[excess - 1]!);
      range.deleteContents();
    } else {
      for (let i = 0; i < excess; i++) {
        consoleEl.firstElementChild?.remove();
      }
    }
  }

  consoleEl.appendChild(fragment);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function appendLog(entry: unknown): void {
  const consoleEl = $('console');
  if (!consoleEl) return;

  const rawEntry: ConsoleLogEntry = isRecord(entry)
    ? {
        line: isString(entry['line']) ? entry['line'] : String(entry['line'] ?? ''),
        ...(isString(entry['time']) ? { time: entry['time'] } : {}),
        ...(isString(entry['type']) ? { type: entry['type'] } : {}),
      }
    : { line: String(entry ?? '') };
  const line = String(rawEntry.line || '');

  if (shouldIgnoreLog(line)) {
    return;
  }

  pendingConsoleLogs.push({
    line,
    time: rawEntry.time || '--:--:--',
    type: rawEntry.type || 'info',
  });
  if (pendingConsoleLogs.length > MAX_CONSOLE_LINES) {
    pendingConsoleLogs.splice(0, pendingConsoleLogs.length - MAX_CONSOLE_LINES);
  }

  if (!consoleFlushScheduled) {
    consoleFlushScheduled = true;
    requestAnimationFrame(flushConsoleLogs);
  }
}

async function startServer() {
  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  setStatus('starting');

  try {
    const data = await api('/api/start', { method: 'POST' });
    if (!isApiResult(data) || data.ok !== true) throw new Error(getApiError(data, 'Error al arrancar'));
    await refreshServerStatus();
  } catch (error: unknown) {
    toast(`No se pudo arrancar: ${getErrorMessage(error, 'Error de conexión.')}`, 'err');
    await refreshServerStatus();
  }
}

async function stopServer() {
  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  setStatus('stopping');

  try {
    const data = await api('/api/stop', { method: 'POST' });
    if (!isApiResult(data) || data.ok !== true) throw new Error(getApiError(data, 'Error al detener'));
    await refreshServerStatus();
  } catch (error: unknown) {
    toast(`No se pudo detener: ${getErrorMessage(error, 'Error de conexión.')}`, 'err');
    await refreshServerStatus();
  }
}

async function restartServer() {
  if (currentStatus === 'restarting' || currentStatus === 'stopping') {
    return;
  }

  if (!agentOnline) {
    toast('MoonWolf Agent no está conectado.', 'err');
    return;
  }

  setStatus('restarting');

  try {
    const data = await api('/api/restart', { method: 'POST' });
    if (!isApiResult(data) || data.ok !== true) throw new Error(getApiError(data, 'Error al reiniciar'));
    await refreshServerStatus();
  } catch (error: unknown) {
    toast(`No se pudo reiniciar: ${getErrorMessage(error, 'Error de conexión.')}`, 'err');
    await refreshServerStatus();
  }
}

let sendingConsoleCommand = false;

async function sendCmd() {
  const input = $input('cmdInput');
  const button = $btn('btnSendCmd');
  if (!input || sendingConsoleCommand) return;

  const rawCmd = input.value;
  const cmd = rawCmd.trim().replace(/^\/+/, '').trim();
  if (!cmd) return;

  if (!agentOnline || !cloudSocket?.connected) {
    toast('MoonWolf Cloud o MoonWolf Agent no están conectados.', 'err');
    return;
  }

  if (!hasPermission('control')) {
    toast('Este acceso no tiene permiso para enviar comandos.', 'err');
    return;
  }

  if (METRIC_CMD_RE.test(cmd)) {
    pendingUserMetricCmd = true;
    suppressMetricRepliesUntil = 0;
  }

  sendingConsoleCommand = true;
  input.disabled = true;
  if (button) button.disabled = true;

  try {
    const data = await postJSON('/api/command', { cmd });
    if (!isApiResult(data) || data.ok !== true) {
      throw new Error(getApiError(data, 'El Agent rechazó el comando.'));
    }

    input.value = '';
  } catch (error: unknown) {
    console.warn('[moonwolf] No se pudo enviar el comando:', error);
    toast(`No se pudo enviar el comando: ${getErrorMessage(error, 'Error de conexión.')}`, 'err');
  } finally {
    sendingConsoleCommand = false;
    input.disabled = false;
    if (button) button.disabled = false;
    input.focus();
  }
}

/* ══════════════════════════════════════════════
   10. ARCHIVOS
   ══════════════════════════════════════════════ */

function fileIcon(type: unknown): string {
  const t = String(type || '');
  const icons: Record<string, string> = {
    dir: '📁',
    jar: '☕',
    log: '📋',
    file: '📄',
  };
  return icons[t] || '📄';
}

const FILE_NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const boundFileLists = new WeakSet<HTMLElement>();
const boundBreadcrumbs = new WeakSet<HTMLElement>();
let fileListRequestGeneration = 0;

function setFileSelection(path: string, isDir: boolean, selected: boolean): void {
  if (selected) {
    selectedFilePaths.add(path);
    selectedFileTypes.set(path, isDir);
  } else {
    selectedFilePaths.delete(path);
    selectedFileTypes.delete(path);
  }
}

function bindFileListEvents(list: HTMLElement): void {
  if (boundFileLists.has(list)) return;
  boundFileLists.add(list);

  list.addEventListener('change', (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('input[type="checkbox"]')) return;

    const row = input.closest<HTMLElement>('.file-row');
    if (!row || !list.contains(row)) return;

    const path = row.dataset.path;
    if (!path) return;

    setFileSelection(path, row.dataset.type === 'dir', input.checked);
    updateBulkBar();
  });

  list.addEventListener('dblclick', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('input[type="checkbox"], .file-select')) return;

    const row = target.closest<HTMLElement>('.file-row');
    if (!row || !list.contains(row)) return;

    const path = row.dataset.path || '';
    const type = row.dataset.type || '';
    if (!path) return;

    if (type === 'dir') {
      populateFiles(path);
    } else if (type !== 'jar') {
      openFile(path);
    }
  });

  list.addEventListener('contextmenu', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.file-row');
    if (!row || !list.contains(row)) return;

    openFileContext(
      event,
      row.dataset.name || '',
      row.dataset.type || '',
      row.dataset.path || '',
    );
  });
}

function bindBreadcrumbEvents(trail: HTMLElement): void {
  if (boundBreadcrumbs.has(trail)) return;
  boundBreadcrumbs.add(trail);

  trail.addEventListener('click', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const crumb = target?.closest<HTMLElement>('.crumb');
    if (!crumb || !trail.contains(crumb)) return;
    populateFiles(crumb.dataset.path || '');
  });
}

function populateFiles(dir: string = '', options: SoftLoadOptions = {}): void {
  const requestedDir = dir;
  currentDir = requestedDir;
  const requestGeneration = ++fileListRequestGeneration;

  const list = $('fileList');

  if (!list) return;
  bindFileListEvents(list);

  const soft = resolveSoftLoad(options, list);
  if (!soft) {
    list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon" style="display:inline-block;animation:spin 1s linear infinite">⟳</div>
      <div class="empty-msg">Cargando...</div>
    </div>
  `;
  }

  renderBreadcrumb(requestedDir);

  cachedApi(`files:${requestedDir}`, `/api/files?dir=${encodeURIComponent(requestedDir)}`, undefined, 15_000, Boolean(options.force))
    .then(raw => {
      if (requestGeneration !== fileListRequestGeneration) return;

      if (!isFilesApiResponse(raw) || !raw.ok) {
        const err = isFilesApiResponse(raw) && typeof raw.error === 'string' ? raw.error : 'No se pudo leer la carpeta.';
        throw new Error(err);
      }

      const items: FileListItem[] = Array.isArray(raw.items) ? raw.items.slice() : [];

      items.sort((a: FileListItem, b: FileListItem) =>
        Number(b.type === 'dir') - Number(a.type === 'dir') ||
        FILE_NAME_COLLATOR.compare(a.name, b.name)
      );

      if (!items.length) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📂</div>
            <div class="empty-msg">Carpeta vacía</div>
          </div>
        `;

        return;
      }

      list.innerHTML = items
        .map(item => {
          const relativePath = requestedDir ? `${requestedDir}/${item.name}` : item.name;
          const checked = selectedFilePaths.has(relativePath) ? 'checked' : '';

          if (selectedFilePaths.has(relativePath)) {
            selectedFileTypes.set(relativePath, item.type === 'dir');
          }

          return `
            <div class="file-row" data-name="${escHtml(item.name)}" data-type="${escHtml(item.type)}" data-path="${escHtml(relativePath)}">
              <label class="file-select"><input type="checkbox" aria-label="Seleccionar ${escHtml(item.name)}" ${checked}></label>
              <span class="file-name" style="flex:1">
                ${fileIcon(item.type)}
                <span>${escHtml(item.name)}</span>
              </span>
              <span style="width:90px;text-align:right;color:var(--muted2)">${escHtml(item.size)}</span>
              <span style="width:140px;text-align:right;color:var(--muted2)">${escHtml(item.date)}</span>
            </div>
          `;
        })
        .join('');
    })
    .catch((error: unknown) => {
      if (requestGeneration !== fileListRequestGeneration) return;

      list.innerHTML = `
        <div class="file-load-error" role="alert">
          <div class="empty-icon">⚠</div>
          <div class="empty-msg">No se pudo cargar esta carpeta</div>
          <div class="empty-detail">${escHtml(getErrorMessage(error))}</div>
          <button class="small-btn" id="btnRetryFiles" type="button">↻ Reintentar</button>
        </div>
      `;
      $('btnRetryFiles')?.addEventListener('click', () => populateFiles(requestedDir, { force: true }));
    });
}

function updateBulkBar() {
  const bar = $('filesBulkbar');
  const count = selectedFilePaths.size;
  const countEl = $('selectedFilesCount');
  if (countEl) countEl.textContent = String(count);
  bar?.classList.toggle('visible', count > 0);
  const selectAll = $input('selectAllFiles');
  const rows = document.querySelectorAll<HTMLElement>('#fileList .file-row');
  let rowCount = 0;
  let selectedInView = 0;

  rows.forEach(row => {
    rowCount++;
    if (selectedFilePaths.has(row.dataset.path || '')) selectedInView++;
  });

  if (selectAll) {
    selectAll.checked = rowCount > 0 && selectedInView === rowCount;
    selectAll.indeterminate = selectedInView > 0 && selectedInView < rowCount;
  }
}
function clearSelectedFiles(): void {
  selectedFilePaths.clear();
  selectedFileTypes.clear();
  document.querySelectorAll<HTMLInputElement>('#fileList input[type="checkbox"]').forEach(input => { input.checked = false; });
  updateBulkBar();
}
async function runBulkAction(action: string | undefined): Promise<void> {
  if (action === 'clear') return clearSelectedFiles();
  const items = Array.from(selectedFilePaths, path => ({
    path,
    isDir: selectedFileTypes.get(path) === true,
  }));
  if (!items.length) return;
  if (action === 'download') {
    const count = items.length;
    toast(`⬇️ Descargando ${count} elemento${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}...`, 'info');
    for (const item of items) {
      const name = item.path.split('/').pop() || '';
      if (item.isDir) {
        await downloadDirectoryAsZip(item.path, name);
      } else {
        await downloadFile(item.path, name);
      }
    }
    return;
  }
  let destination;
  if (action === 'move') {
    destination = prompt('Carpeta relativa de destino:', currentDir || '');
    if (destination === null) return;
    destination = normalizeUploadRelativePath(destination);
  }
  if (action === 'delete') {
    const confirmed = await askFileDeleteConfirm(items);
    if (confirmed !== 'delete') return;
  }
  try {
    const data = await postJSON('/api/files/bulk', { action, items, destination });
    if (!isApiResult(data) || data.ok !== true) {
      throw new Error(getApiError(data, 'La operación masiva falló'));
    }
    const completed = isNumber(data['completed']) && data['completed'] > 0 ? data['completed'] : items.length;
    const failed = isNumber(data['failed']) ? data['failed'] : 0;
    clearSelectedFiles();
    toast(`✅ ${completed} operación${completed === 1 ? '' : 'es'} completada${completed === 1 ? '' : 's'}`, 'ok');
    if (failed > 0) toast(`⚠️ ${failed} elemento${failed === 1 ? '' : 's'} no se pudo procesar`, 'warn');
    populateFiles(currentDir);
  } catch (error: unknown) { toast(`❌ ${(error instanceof Error ? error.message : String(error))}`, 'err'); }
}
function renderBreadcrumb(dir: string): void {
  const trail = $('crumbTrail');

  if (!trail) return;

  const parts = dir ? dir.split('/').filter(Boolean) : [];

  let acc = '';

  bindBreadcrumbEvents(trail);

  trail.innerHTML = parts
    .map((part, index) => {
      acc += (index ? '/' : '') + part;

      return `
        /
        <span class="crumb" data-path="${escHtml(acc)}">${escHtml(part)}</span>
      `;
    })
    .join('');
}

async function downloadDirectoryAsZip(rel: string, name: string): Promise<void> {
  toast(`🗜️ Preparando y comprimiendo "${name}"...`, 'info');
  try {
    const data = await postJSON('/api/files/compress', {
      path: rel,
      name,
    });
    if (!isApiResult(data) || data.ok !== true) {
      throw new Error(getApiError(data, 'No se pudo comprimir la carpeta'));
    }

    const zipName = isString(data['zipName']) && data['zipName'] ? data['zipName'] : `${name}.zip`;
    const parentDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const zipRel = parentDir ? `${parentDir}/${zipName}` : zipName;

    await downloadFile(zipRel, zipName);
    populateFiles(currentDir);
  } catch (error: unknown) {
    toast(`❌ ${(error instanceof Error ? error.message : String(error))}`, 'err');
  }
}

function openFileContext(event: MouseEvent, name: string, type: string, path?: string): void {
  event.preventDefault();

  document.querySelector('.file-ctx-menu')?.remove();

  const rel = path || (currentDir ? `${currentDir}/${name}` : name);

  const menu = document.createElement('div');

  menu.className = 'file-ctx-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  menu.innerHTML = `
    ${type !== 'dir' ? '<div class="ctx-item" data-action="open">📂 Abrir</div>' : ''}
    <div class="ctx-item" data-action="rename">✏️ Renombrar</div>
    <div class="ctx-item" data-action="copy">📋 Copiar</div>
    <div class="ctx-item" data-action="move">🔀 Mover</div>
    ${type !== 'dir'
      ? '<div class="ctx-item" data-action="download">⬇️ Descargar</div>'
      : '<div class="ctx-item" data-action="download-folder">⬇️ Descargar (.zip)</div>'}
    <div class="ctx-item" data-action="compress">🗜️ Comprimir</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">🗑️ Eliminar</div>
  `;

  document.body.appendChild(menu);

  menu.addEventListener('click', async (click: MouseEvent) => {
    const targetEl = click.target instanceof Element ? click.target : null;
    const action = targetEl?.closest<HTMLElement>('.ctx-item')?.dataset.action;

    if (!action) return;

    menu.remove();

    try {
      if (action === 'open') {
        return openFile(rel);
      }

      if (action === 'rename') {
        const newName = prompt(`Nuevo nombre para "${name}":`, name);

        if (!newName || newName === name) {
          return;
        }

        const data = await postJSON('/api/files/rename', {
          path: rel,
          newName,
        });

        if (!isApiResult(data) || data.ok !== true) {
          throw new Error(getApiError(data, 'No se pudo renombrar el archivo'));
        }
      }

      if (action === 'copy') {
        const dest = prompt(
          `Ruta relativa de destino para "${name}":`,
          currentDir || ''
        );

        if (dest === null) return;

        const target = dest
          ? `${dest.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`
          : name;

        const data = await postJSON('/api/files/copy', {
          path: rel,
          dest: target,
        });

        if (!isApiResult(data) || data.ok !== true) {
          throw new Error(getApiError(data, 'No se pudo copiar el archivo'));
        }
      }

      if (action === 'move') {
        const dest = prompt(
          `Carpeta relativa de destino para "${name}":`,
          currentDir || ''
        );

        if (dest === null) return;

        const target = dest
          ? `${dest.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`
          : name;

        const data = await postJSON('/api/files/move', {
          path: rel,
          dest: target,
        });

        if (!isApiResult(data) || data.ok !== true) {
          throw new Error(getApiError(data, 'No se pudo mover el archivo'));
        }
      }

      if (action === 'download') {
        return downloadFile(rel, name);
      }

      if (action === 'download-folder') {
        return downloadDirectoryAsZip(rel, name);
      }

      if (action === 'compress') {
        const data = await postJSON('/api/files/compress', {
          path: rel,
          name,
        });

        if (!isApiResult(data) || data.ok !== true) {
          throw new Error(getApiError(data, 'No se pudo comprimir la carpeta'));
        }
      }

      if (action === 'delete') {
        if (!confirm(`¿Eliminar "${name}"?`)) {
          return;
        }

        const data = await postJSON('/api/files/delete', {
          path: rel,
          isDir: type === 'dir',
        });

        if (!isApiResult(data) || data.ok !== true) {
          throw new Error(getApiError(data, 'No se pudo eliminar el archivo'));
        }
      }

      toast('✅ Operación completada', 'ok');

      populateFiles(currentDir);
    } catch (error: unknown) {
      toast(`❌ ${(error instanceof Error ? error.message : String(error))}`, 'err');
    }
  });

  setTimeout(() => {
    document.addEventListener('click', () => menu.remove(), { once: true });
  }, 0);
}

const FILE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const FILE_UPLOAD_PARALLEL_CHUNKS = 4;
const UPLOAD_MAX_INFLIGHT = 6;
let uploadInflight = 0;
const uploadWaiters: Array<() => void> = [];

async function getFilesFromDataTransfer(dataTransfer: DataTransfer | null): Promise<UploadFile[]> {
  const items = dataTransfer?.items;
  if (!items || !items.length) {
    return Array.from(dataTransfer?.files || []);
  }

  const entries: FileSystemEntry[] = [];
  const fallbackFiles: UploadFile[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.kind !== 'file') continue;
    {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) fallbackFiles.push(file);
      }
    }
  }

  if (!entries.length) {
    return fallbackFiles.length ? fallbackFiles : Array.from(dataTransfer?.files || []);
  }

  const resultFiles: UploadFile[] = [];

  function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
    return entry.isFile;
  }

  function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
    return entry.isDirectory;
  }

  async function traverseEntry(entry: FileSystemEntry, parentPath = ''): Promise<void> {
    if (isFileEntry(entry)) {
      const fileEntry = entry;
      await new Promise<void>(resolve => {
        fileEntry.file(file => {
          const rel = parentPath ? `${parentPath}/${file.name}` : file.name;
          Object.defineProperty(file, 'customRelativePath', {
            value: rel,
            configurable: true,
            writable: true,
          });
          resultFiles.push(file as UploadFile);
          resolve();
        }, () => resolve());
      });
    } else if (isDirectoryEntry(entry)) {
      const directoryEntry = entry;
      const dirReader = directoryEntry.createReader();
      const nextPath = parentPath ? `${parentPath}/${directoryEntry.name}` : directoryEntry.name;
      const readBatch = () => new Promise<FileSystemEntry[]>(resolve => {
        dirReader.readEntries(batch => resolve(batch), () => resolve([]));
      });
      while (true) {
        const batch = await readBatch();
        if (!batch || !batch.length) break;
        for (const child of batch) {
          await traverseEntry(child, nextPath);
        }
      }
    }
  }

  for (const entry of entries) {
    await traverseEntry(entry);
  }

  return resultFiles.length ? resultFiles : fallbackFiles;
}

async function acquireUploadSlot() {
  if (uploadInflight < UPLOAD_MAX_INFLIGHT) {
    uploadInflight++;
    return;
  }

  await new Promise<void>(resolve => {
    uploadWaiters.push(resolve);
  });
}

function releaseUploadSlot() {
  const next = uploadWaiters.shift();

  if (next) next();
  else uploadInflight--;
}

function normalizeUploadRelativePath(value: unknown): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
}

function formatUploadBytes(value: unknown): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}
function formatUploadEta(seconds: unknown): string {
  const secNum = Number(seconds);
  if (!Number.isFinite(secNum) || secNum <= 0) return 'Calculando tiempo…';
  const total = Math.ceil(secNum);
  if (total < 60) return `${total}s restantes`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${secs.toString().padStart(2, '0')}s restantes`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m restantes`;
}
function formatDuration(seconds: unknown): string {
  const total = Math.max(1, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function uploadCancelledError(): UploadError {
  const error: UploadError = new Error('Subida cancelada');
  error.isCancelled = true;
  return error;
}
async function waitForUploadResume(progressState: UploadState): Promise<void> {
  if (progressState.cancelled) throw uploadCancelledError();
  if (!progressState.paused) return;
  progressState.status = 'Subida pausada';
  updateUploadProgress(progressState);
  await new Promise<void>(resolve => { progressState.resumeUpload = () => resolve(); });
  if (progressState.cancelled) throw uploadCancelledError();
}
function setUploadControls(visible: boolean): void {
  const pauseBtn = $btn('uploadProgressPause');
  if (pauseBtn) {
    pauseBtn.hidden = !visible;
    pauseBtn.disabled = false;
    if (visible && activeUploadState) {
      pauseBtn.textContent = activeUploadState.paused ? '▶ Reanudar' : 'Ⅱ Pausar';
    }
  }
  const cancelBtn = $btn('uploadProgressCancel');
  if (cancelBtn) {
    cancelBtn.hidden = !visible;
    cancelBtn.disabled = false;
  }
}

function updateUploadProgress(progressState: UploadState): void {
  const panel = $('uploadProgressPanel');
  if (!panel) return;

  if (progressState.finished) return;

  const total = progressState.totalBytes || 0;
  const done = Math.min(progressState.doneBytes || 0, total);
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
  const elapsed = Math.max((Date.now() - progressState.startedAt) / 1000, 0.001);
  const speed = done / elapsed;
  const eta = speed > 0 ? (total - done) / speed : Infinity;
  const currentDone = progressState.currentFileDone || 0;
  const currentTotal = progressState.currentFileSize || 0;
  const single = progressState.totalFiles === 1;

  panel.hidden = false;
  setUploadControls(Boolean(activeUploadState && !activeUploadState.finished));
  panel.classList.remove('upload-progress-error');

  const errorEl = $('uploadProgressError');
  if (errorEl) errorEl.textContent = '';

  const retryEl = $('uploadProgressRetry');
  if (retryEl) retryEl.hidden = true;

  const titleEl = $('uploadProgressTitle');
  if (titleEl) {
    titleEl.textContent = progressState.status || `Subiendo ${progressState.completedFiles + 1}/${progressState.totalFiles}`;
  }

  const currentEl = $('uploadProgressCurrent');
  if (currentEl) {
    currentEl.textContent = progressState.currentFile
      ? (single
          ? progressState.currentFile
          : `${progressState.currentFile} · ${formatUploadBytes(currentDone)} / ${formatUploadBytes(currentTotal)}`)
      : 'Preparando…';
  }

  const percentEl = $('uploadProgressPercent');
  if (percentEl) percentEl.textContent = `${percent}%`;

  const fillEl = $('uploadProgressFill');
  if (fillEl) fillEl.style.width = `${percent}%`;

  const filesEl = $('uploadProgressFiles');
  if (filesEl) {
    filesEl.textContent = single
      ? ''
      : `${Math.min(progressState.completedFiles, progressState.totalFiles)}/${progressState.totalFiles} archivos`;
  }

  const bytesEl = $('uploadProgressBytes');
  if (bytesEl) bytesEl.textContent = `${formatUploadBytes(done)} de ${formatUploadBytes(total)}`;

  const speedEl = $('uploadProgressSpeed');
  if (speedEl) speedEl.textContent = speed > 0 ? `${formatUploadBytes(speed)}/s` : '—';

  const etaEl = $('uploadProgressEta');
  if (etaEl) etaEl.textContent = percent >= 100 ? 'Completado' : formatUploadEta(eta);
}

function finishUploadProgress(message: string, isError: boolean = false, detail: string = '', hidePanel: boolean = false): void {
  const panel = $('uploadProgressPanel');
  if (!panel) return;

  if (activeUploadState) activeUploadState.finished = true;

  const titleEl = $('uploadProgressTitle');
  if (titleEl) titleEl.textContent = message;

  const currentEl = $('uploadProgressCurrent');
  if (currentEl) {
    currentEl.textContent = isError ? 'La subida se detuvo' : 'Todos los archivos se han procesado';
  }

  const errorEl = $('uploadProgressError');
  if (errorEl) errorEl.textContent = detail;

  const retryEl = $('uploadProgressRetry');
  if (retryEl) retryEl.hidden = !isError || !lastUploadFiles.length;

  setUploadControls(false);
  panel.classList.toggle('upload-progress-error', isError);
  if (hidePanel) panel.hidden = true;
  if (!isError) setTimeout(() => { panel.hidden = true; }, 3500);
}

type ActionButtonEl = HTMLElement & {
  _conflictHandler?: () => void;
  _deleteHandler?: () => void;
};

function askFileConflict(fileName: string): Promise<ConflictChoice> {
  const modal = $('fileConflictModal');
  if (!modal) return Promise.resolve({ choice: 'cancel', applyAll: false });

  const nameEl = $('fileConflictName');
  if (nameEl) nameEl.textContent = fileName;

  const messageEl = $('fileConflictMessage');
  if (messageEl) messageEl.textContent = 'Ya existe un archivo con ese nombre. ¿Qué quieres hacer?';

  const applyAllInput = $input('fileConflictApplyAll');
  if (applyAllInput) applyAllInput.checked = false;

  modal.hidden = false;
  return new Promise<ConflictChoice>(resolve => {
    const finish = (choice: FileConflictChoice) => {
      const applyAll = Boolean(applyAllInput?.checked);
      modal.hidden = true;
      modal.querySelectorAll('[data-conflict-choice]').forEach(el => {
        const button = el as ActionButtonEl;
        if (button._conflictHandler) {
          button.removeEventListener('click', button._conflictHandler);
          delete button._conflictHandler;
        }
      });
      resolve({ choice, applyAll });
    };
    modal.querySelectorAll('[data-conflict-choice]').forEach(el => {
      const button = el as ActionButtonEl;
      const handler = () => {
        const value = button.dataset['conflictChoice'];
        const choice: FileConflictChoice = value === 'replace' || value === 'keep' || value === 'numbered'
          ? value
          : 'cancel';
        finish(choice);
      };
      button._conflictHandler = handler;
      button.addEventListener('click', handler);
    });
  });
}

function isFileConflict(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const message = typeof error['message'] === 'string' ? error['message'] : '';
  return Boolean(error['isFileConflict'] || error['status'] === 409 || /ya existe un archivo/i.test(message));
}

function askFileDeleteConfirm(items: DeleteItem[]): Promise<'delete' | 'cancel'> {
  const modal = $('fileDeleteModal');
  if (!modal) {
    const list = items.map(item => `• ${item.path}`).join('\n');
    const plural = items.length === 1 ? '' : 's';
    return Promise.resolve<'delete' | 'cancel'>(
      confirm(
        `¿Eliminar ${items.length} elemento${plural} seleccionado${plural}?\n\n${list}\n\nEsta acción no se puede deshacer.`
      )
        ? 'delete'
        : 'cancel'
    );
  }

  const countEl = $('fileDeleteCount');
  if (countEl) countEl.textContent = String(items.length);

  const listEl = $('fileDeleteList');
  if (listEl) {
    listEl.innerHTML = items
      .map(item => {
        const label = item.path.split('/').pop() || item.path;
        return `
          <li class="file-delete-item">
            <span class="file-delete-icon">${item.isDir ? '📁' : '📄'}</span>
            <span class="file-delete-name">${escHtml(label)}</span>
            <span class="file-delete-path">${escHtml(item.path)}</span>
          </li>
        `;
      })
      .join('');
  }

  modal.hidden = false;
  return new Promise<'delete' | 'cancel'>(resolve => {
    const finish = (choice: 'delete' | 'cancel') => {
      modal.hidden = true;
      modal.querySelectorAll('[data-delete-choice]').forEach(el => {
        const button = el as ActionButtonEl;
        if (button._deleteHandler) {
          button.removeEventListener('click', button._deleteHandler);
          delete button._deleteHandler;
        }
      });
      document.removeEventListener('keydown', onKey);
      resolve(choice);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish('cancel');
    };
    modal.querySelectorAll('[data-delete-choice]').forEach(el => {
      const button = el as ActionButtonEl;
      const handler = () => {
        const rawChoice = button.dataset['deleteChoice'];
        finish(rawChoice === 'delete' ? 'delete' : 'cancel');
      };
      button._deleteHandler = handler;
      button.addEventListener('click', handler);
    });
    document.addEventListener('keydown', onKey);
  });
}
async function uploadOneFile(file: UploadFile, relativePath: string, progressState: UploadState, overwrite: boolean = true): Promise<void> {
  const relCandidate = file.customRelativePath || relativePath || file.webkitRelativePath || file.name;
  progressState.currentFile = relCandidate;
  progressState.currentFileSize = file.size;
  progressState.currentFileDone = 0;
  updateUploadProgress(progressState);

  const relPath = normalizeUploadRelativePath(relCandidate);

  if (!relPath) {
    throw new Error(`Nombre de archivo no válido: ${file.name}`);
  }

  const target = currentDir
    ? `${currentDir.replace(/\\/g, '/').replace(/\/$/, '')}/${relPath}`
    : relPath;

  const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const totalSize = file.size;

  if (totalSize === 0) {
    await waitForUploadResume(progressState);
    const data = await postUploadChunk(uploadId, target, 0, totalSize, new Uint8Array(), true, overwrite);
    if (!data?.ok) {
      const uploadError: UploadError = new Error(data?.error || `No se pudo subir ${file.name}`);
      if (typeof data?.status === 'number') uploadError.status = data.status;
      if (data?.status === 409 || data?.isFileConflict || /ya existe un archivo/i.test(uploadError.message)) {
        uploadError.isFileConflict = true;
      }
      throw uploadError;
    }
    progressState.completedFiles = (progressState.completedFiles ?? 0) + 1;
    progressState.status = `Subiendo ${progressState.completedFiles}/${progressState.totalFiles}`;
    updateUploadProgress(progressState);
    return;
  }

  const chunkCount = Math.ceil(totalSize / FILE_UPLOAD_CHUNK_SIZE);
  let nextChunk = 0;
  let completedChunks = 0;

  const uploadChunkInner = async (chunkIndex: number): Promise<void> => {
    const offset = chunkIndex * FILE_UPLOAD_CHUNK_SIZE;
    const end = Math.min(offset + FILE_UPLOAD_CHUNK_SIZE, totalSize);
    const buffer = await file.slice(offset, end).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let data: UploadChunkResponse | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForUploadResume(progressState);

      try {
        data = await postUploadChunk(
          uploadId,
          target,
          offset,
          totalSize,
          bytes,
          end >= totalSize,
          overwrite
        );

        if (!data?.ok) {
          const uploadError: UploadError = new Error(data?.error || `No se pudo subir ${file.name}`);
          if (typeof data?.status === 'number') uploadError.status = data.status;
          if (data?.status === 409 || data?.isFileConflict || /ya existe un archivo/i.test(uploadError.message)) {
            uploadError.isFileConflict = true;
            throw uploadError;
          }
          if (data?.status === 429 || /demasiadas/i.test(uploadError.message)) {
            uploadError.isRateLimited = true;
          }
          throw uploadError;
        }

        break;
      } catch (error: unknown) {
        lastError = error;

        if (isRecord(error) && Boolean(error['isFileConflict'])) {
          throw error;
        }
        if (attempt < 4) {
          const rateLimited = isRecord(error) && Boolean(error['isRateLimited']);
          const delay = rateLimited ? (1500 * (attempt + 1)) : (500 * (attempt + 1));
          if (rateLimited) {
            progressState.status = `Esperando por límite de peticiones (${attempt + 1}/5)…`;
            updateUploadProgress(progressState);
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!data?.ok) {
      throw lastError || new Error(`No se pudo subir ${file.name}`);
    }

    completedChunks += 1;
    progressState.currentFileDone = Math.min(totalSize, (progressState.currentFileDone || 0) + bytes.length);
    progressState.doneBytes = (Number(progressState.doneBytes) || 0) + bytes.length;
    progressState.status = `Subiendo ${(progressState.completedFiles ?? 0) + 1}/${progressState.totalFiles} · ${completedChunks}/${chunkCount} bloques`;
    updateUploadProgress(progressState);
  };

  const uploadChunk = async (chunkIndex: number): Promise<void> => {
    await acquireUploadSlot();
    try {
      await uploadChunkInner(chunkIndex);
    } finally {
      releaseUploadSlot();
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      await waitForUploadResume(progressState);
      if (progressState.cancelled) throw uploadCancelledError();

      const chunkIndex = nextChunk++;
      if (chunkIndex >= chunkCount) return;

      await uploadChunk(chunkIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FILE_UPLOAD_PARALLEL_CHUNKS, chunkCount) }, worker)
  );

  progressState.currentFileDone = totalSize;
  progressState.completedFiles = (progressState.completedFiles ?? 0) + 1;
  progressState.status = `Subiendo ${progressState.completedFiles}/${progressState.totalFiles}`;
  updateUploadProgress(progressState);
}

function postUploadChunk(
  uploadId: string,
  target: string,
  offset: number,
  totalSize: number,
  bytes: Uint8Array,
  final: boolean,
  overwrite: boolean
): Promise<UploadChunkResponse> {
  const params = new URLSearchParams({
    uploadId,
    path: target,
    offset: String(offset),
    totalSize: String(totalSize),
    final: final ? '1' : '0',
    overwrite: overwrite ? '1' : '0',
  });

  return rpcHttp(`/api/files/upload-chunk?${params.toString()}`, {
    method: 'POST',
    body: bytes,
  }).then(result => {
    const status = result?.status || 500;
    let parsed: unknown = result?.data;

    if (hasResultBody(result)) {
      const bytesResult = decodeResultBody(result);
      const text = TEXT_DECODER.decode(bytesResult ?? new Uint8Array(0));
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const baseObj: Record<string, unknown> = isRecord(parsed)
      ? parsed
      : { ok: Boolean(result?.ok), status, error: 'Respuesta vacía.' };

    return {
      ...(baseObj as UploadChunkResponse),
      status,
    };
  });
}

async function uploadSelectedFiles(
  fileList: ArrayLike<UploadFile> | UploadFile[] | FileList | null | undefined
): Promise<void> {
  const rawList: UploadFile[] = fileList ? Array.from(fileList) : [];
  const files = rawList.filter(file => file && typeof file.size === 'number');

  if (!files.length) return;
  if (!isOwnerSession()) {
    const dangerous = files.filter(isDangerousUploadFile);
    if (dangerous.length) {
      toast(
        `🔒 Bloqueado: ${dangerous.map(file => file.name).join(', ')}. Los accesos compartidos no pueden subir ejecutables.`,
        'err'
      );
      return;
    }
  }

  lastUploadFiles = files;

  const progressState: UploadState = {
    completedFiles: 0,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    doneBytes: 0,
    startedAt: Date.now(),
    status: `Subiendo 1/${files.length}`,
    paused: false,
    cancelled: false,
    finished: false,
    resumeUpload: null,
    rememberConflictChoice: null,
    conflictQueue: Promise.resolve(),
    activeFiles: 0,
  };
  activeUploadState = progressState;
  updateUploadProgress(progressState);

  try {
    let nextFileIndex = 0;
    progressState.conflictQueue = Promise.resolve();
    const uploadFileWithConflict = async (file: UploadFile): Promise<void> => {
      const relative = file.customRelativePath || file.webkitRelativePath || file.name;
      progressState.activeFiles = (Number(progressState.activeFiles) || 0) + 1;
      const parallelLabel = (Number(progressState.activeFiles) || 0) > 1
        ? ` · ${progressState.activeFiles} simultáneos`
        : '';
      progressState.status = `Subiendo ${Math.min((progressState.completedFiles ?? 0) + 1, progressState.totalFiles)}/${progressState.totalFiles}${parallelLabel}`;
      try {
        try {
          await uploadOneFile(file, relative, progressState, false);
        } catch (error: unknown) {
          if (!isFileConflict(error)) throw error;
          let choice = progressState.rememberConflictChoice;
          if (!choice) {
            const queuePromise: Promise<unknown> = progressState.conflictQueue ?? Promise.resolve();
            const promptPromise = queuePromise.then(() => askFileConflict(relative));
            progressState.conflictQueue = promptPromise.catch(() => ({ choice: 'cancel', applyAll: false }));
            const res = await promptPromise;
            choice = res.choice;
            if (res.applyAll && (choice === 'replace' || choice === 'keep' || choice === 'numbered')) {
              progressState.rememberConflictChoice = choice;
            }
          }
          if (choice === 'keep') {
            progressState.completedFiles = (progressState.completedFiles ?? 0) + 1;
            progressState.status = `Omitiendo ${progressState.completedFiles}/${progressState.totalFiles}`;
            updateUploadProgress(progressState);
            return;
          }
          if (choice === 'cancel') {
            const cancelErr: UploadError = new Error('Subida cancelada por conflicto de archivo');
            cancelErr.isCancelled = true;
            throw cancelErr;
          }

          if (choice === 'numbered') {
            let counter = 1;
            while (true) {
              const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/') + 1) : '';
              const currentFileName = relative.includes('/') ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
              const dot = currentFileName.lastIndexOf('.');
              const nameBase = dot > 0 ? currentFileName.slice(0, dot).replace(/\s\(\d+\)$/, '') : currentFileName.replace(/\s\(\d+\)$/, '');
              const ext = dot > 0 ? currentFileName.slice(dot) : '';
              const newRelative = `${parent}${nameBase} (${counter})${ext}`;
              try {
                await uploadOneFile(file, newRelative, progressState, false);
                break;
              } catch (numErr) {
                if (isFileConflict(numErr)) {
                  counter++;
                  continue;
                }
                throw numErr;
              }
            }
            return;
          }

          await uploadOneFile(file, relative, progressState, true);
        }
      } finally {
        progressState.activeFiles = Math.max(0, (Number(progressState.activeFiles) || 1) - 1);
      }
    };
    const worker = async (): Promise<void> => {
      while (true) {
        const fileIndex = nextFileIndex++;
        if (fileIndex >= files.length) return;
        const file = files[fileIndex];
        if (!file) return;
        await uploadFileWithConflict(file);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
    progressState.doneBytes = progressState.totalBytes;
    progressState.completedFiles = progressState.totalFiles;
    updateUploadProgress(progressState);
    const startedAtNum = Number(progressState.startedAt) || Date.now();
    const totalSeconds = (Date.now() - startedAtNum) / 1000;
    finishUploadProgress(`Subida completada en ${formatDuration(totalSeconds)}`);
    toast(`✅ ${files.length} ${files.length === 1 ? 'archivo subido' : 'archivos subidos'} correctamente`, 'ok');
    populateFiles(currentDir);
  } catch (error: unknown) {
    const isCancelled = isRecord(error) && Boolean(error['isCancelled']);
    const errMsg = getErrorMessage(error, 'Error desconocido');
    finishUploadProgress(
      isCancelled ? 'Subida cancelada' : 'Subida interrumpida',
      true,
      errMsg,
      isCancelled
    );
    toast(`❌ ${errMsg}`, 'err');
  }
}

let activeDownloadAbort: AbortController | null = null;
let activeDownloadWriter: WritableFileStreamLike | null = null;

async function downloadUrlWithProgress(
  pathname: string,
  filename: string,
  title: string = 'Descargando archivo'
): Promise<void> {
  const panel = $('uploadProgressPanel');
  const startedAt = Date.now();
  let receivedBytes = 0;
  let totalBytes = 0;
  let writable: WritableFileStreamLike | null = null;
  let saveHandle: SaveFileHandleLike | null = null;

  activeDownloadAbort = new AbortController();

  if (panel) {
    panel.hidden = false;
    panel.classList.remove('upload-progress-error');
    const titleEl = $('uploadProgressTitle');
    const currentEl = $('uploadProgressCurrent');
    const percentEl = $('uploadProgressPercent');
    const fillEl = $('uploadProgressFill');
    const cancelEl = $btn('uploadProgressCancel');
    if (titleEl) titleEl.textContent = title;
    if (currentEl) currentEl.textContent = filename;
    if (percentEl) percentEl.textContent = '0%';
    if (fillEl) fillEl.style.width = '0%';
    if (cancelEl) cancelEl.hidden = false;
  }

  const onProgress = (done: number, total: number) => {
    receivedBytes = Number(done) || 0;
    totalBytes = Number(total) || 0;
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = receivedBytes / elapsedSec;
    const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
    const remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - receivedBytes) : 0;
    const eta = speed > 0 ? remainingBytes / speed : 0;

    const percentEl = $('uploadProgressPercent');
    const fillEl = $('uploadProgressFill');
    const speedEl = $('uploadProgressSpeed');
    const etaEl = $('uploadProgressEta');

    if (percentEl) percentEl.textContent = totalBytes > 0 ? `${percent}%` : formatUploadBytes(receivedBytes);
    if (fillEl) fillEl.style.width = totalBytes > 0 ? `${percent}%` : '35%';
    if (speedEl) speedEl.textContent = speed > 0 ? `${formatUploadBytes(speed)}/s` : '—';
    if (etaEl) {
      etaEl.textContent = totalBytes > 0
        ? (percent >= 100 ? 'Finalizando…' : formatUploadEta(eta))
        : 'Descargando…';
    }
  };

  try {
    const picker = window.showSaveFilePicker;
    const canStreamToDisk = typeof picker === 'function';
    if (canStreamToDisk && picker) {
      saveHandle = await picker({ suggestedName: filename });
      writable = await saveHandle.createWritable();
      activeDownloadWriter = writable;
    }

    const result = await rpcHttp(pathname, {
      onProgress,
      signal: activeDownloadAbort.signal,
      ...(writable ? {
        onHeaders: async (head: unknown) => {
          const status = isRecord(head) && typeof head['status'] === 'number' ? head['status'] : 200;
          if (status < 200 || status >= 300) {
            if (writable) await writable.abort().catch(() => {});
            writable = null;
            activeDownloadWriter = null;
          }
        },
        onChunk: async (chunk: Uint8Array) => {
          if (writable) await writable.write(chunk);
        },
      } : {}),
    });

    const resultObj = isRecord(result) ? result : {};
    const resultOk = resultObj['ok'] !== false;
    const isStreamed = Boolean(resultObj['streamed']);

    if ((!hasResultBody(result) && !isStreamed) || !resultOk) {
      if (writable) await writable.abort().catch(() => {});
      const errorBytes = decodeResultBody(result);
      const errorText = errorBytes ? TEXT_DECODER.decode(errorBytes) : '';
      const dataError = isRecord(resultObj['data']) && typeof resultObj['data']['error'] === 'string'
        ? resultObj['data']['error']
        : '';
      throw new Error(errorText || dataError || 'No se pudo descargar el archivo.');
    }

    if (isStreamed && writable) {
      await writable.close();
      writable = null;
      activeDownloadWriter = null;
    } else {
      if (writable) await writable.abort().catch(() => {});
      activeDownloadWriter = null;
      const bytes = decodeResultBody(result) ?? new Uint8Array(0);
      const blobPart: BlobPart = new Uint8Array(bytes);
      const contentType = typeof resultObj['contentType'] === 'string'
        ? resultObj['contentType']
        : 'application/octet-stream';
      const blob = new Blob([blobPart], { type: contentType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    const totalSeconds = (Date.now() - startedAt) / 1000;
    const titleEl = $('uploadProgressTitle');
    const currentEl = $('uploadProgressCurrent');
    const percentEl = $('uploadProgressPercent');
    const fillEl = $('uploadProgressFill');
    const cancelEl = $btn('uploadProgressCancel');

    if (titleEl) titleEl.textContent = `Descarga completada en ${formatDuration(totalSeconds)}`;
    if (currentEl) currentEl.textContent = filename;
    if (percentEl) percentEl.textContent = '100%';
    if (fillEl) fillEl.style.width = '100%';
    if (cancelEl) cancelEl.hidden = true;
    setTimeout(() => { if (panel && !activeUploadState) panel.hidden = true; }, 3500);
    toast(`✅ Descargado: ${filename}`, 'ok');
  } catch (error: unknown) {
    if (activeDownloadWriter) {
      try { await activeDownloadWriter.abort(); } catch {}
      activeDownloadWriter = null;
    }
    const errName = error instanceof Error
      ? error.name
      : (isRecord(error) && typeof error['name'] === 'string' ? error['name'] : '');
    const errMessage = getErrorMessage(error, 'Error en la descarga');

    if (errName === 'AbortError' && !activeDownloadAbort?.signal?.aborted) {
      if (panel && !activeUploadState) panel.hidden = true;
      return;
    }
    if (activeDownloadAbort?.signal?.aborted) {
      const titleEl = $('uploadProgressTitle');
      const currentEl = $('uploadProgressCurrent');
      if (titleEl) titleEl.textContent = 'Descarga cancelada';
      if (currentEl) currentEl.textContent = filename;
      setTimeout(() => { if (panel && !activeUploadState) panel.hidden = true; }, 2000);
      toast('Descarga cancelada', 'info');
      return;
    }
    if (panel) {
      panel.classList.add('upload-progress-error');
      const titleEl = $('uploadProgressTitle');
      const currentEl = $('uploadProgressCurrent');
      const errorEl = $('uploadProgressError');
      const cancelEl = $btn('uploadProgressCancel');
      if (titleEl) titleEl.textContent = 'Error en la descarga';
      if (currentEl) currentEl.textContent = filename;
      if (errorEl) errorEl.textContent = errMessage;
      if (cancelEl) cancelEl.hidden = true;
    }
    toast(`❌ ${errMessage}`, 'err');
  } finally {
    activeDownloadAbort = null;
  }
}

async function downloadFile(rel: string, filename: string): Promise<void> {
  return downloadUrlWithProgress(
    `/api/files/download?path=${encodeURIComponent(rel)}`,
    filename,
    'Descargando archivo'
  );
}

function getEditorContent(): string {
  return editor ? editor.getValue() : $input('mwEditorArea')?.value || '';
}

function editorHasUnsavedChanges(): boolean {
  return Boolean(currentFile && getEditorContent() !== originalFileContent);
}

function confirmEditorExit(): boolean {
  if (!editorHasUnsavedChanges() || !currentFile) return true;
  const fileName = currentFile.split('/').pop() || currentFile;
  return window.confirm(`El archivo "${fileName}" tiene cambios sin guardar. ¿Quieres salir del editor y descartarlos?`);
}

function closeFileEditor(): boolean {
  if (!confirmEditorExit()) return false;
  const editorPanel = $('filesEditorPanel');
  const tablePanel = $('filesTablePanel');
  if (editorPanel) editorPanel.style.display = 'none';
  if (tablePanel) tablePanel.style.display = '';
  editor?.toTextArea?.();
  editor = null;
  currentFile = null;
  originalFileContent = '';
  return true;
}

async function openFile(rel: string): Promise<void> {
  if (currentFile && currentFile !== rel && !confirmEditorExit()) return;
  try {
    const rawData = await api(`/api/files/content?path=${encodeURIComponent(rel)}`);
    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudo abrir el archivo.');
    }

    currentFile = rel;
    const contentText = typeof data['content'] === 'string' ? data['content'] : '';
    originalFileContent = contentText;

    const tablePanel = $('filesTablePanel');
    const editorPanel = $('filesEditorPanel');
    const fileNameEl = $('editorFileName');
    const saveMsgEl = $('edSaveMsg');
    const containerEl = $('editorContainer');

    if (tablePanel) tablePanel.style.display = 'none';
    if (editorPanel) editorPanel.style.display = '';
    if (fileNameEl) {
      const displayName = typeof data['filename'] === 'string' && data['filename']
        ? data['filename']
        : (rel.split('/').pop() || rel);
      fileNameEl.innerHTML = `📄 ${escHtml(displayName)}`;
    }
    if (saveMsgEl) saveMsgEl.textContent = '';

    editor?.toTextArea?.();

    if (containerEl) {
      containerEl.innerHTML = '<textarea id="mwEditorArea"></textarea>';
    }

    const ext = String(rel.split('.').pop() || '').toLowerCase();
    const modeMap: Record<string, string> = {
      yml: 'yaml',
      yaml: 'yaml',
      json: 'javascript',
      js: 'javascript',
      xml: 'xml',
      properties: 'properties',
      conf: 'properties',
      cfg: 'properties',
      sh: 'shell',
      bat: 'shell',
      cmd: 'shell',
      toml: 'toml',
      nginx: 'nginx',
    };
    const mode = modeMap[ext] || 'text/plain';

    await ensureCodeMirror(mode);

    const cmStatic = window.CodeMirror;
    const textareaEl = $('mwEditorArea');
    const textarea = textareaEl instanceof HTMLTextAreaElement ? textareaEl : null;

    if (cmStatic && typeof cmStatic.fromTextArea === 'function' && textarea) {
      editor = cmStatic.fromTextArea(textarea, {
        lineNumbers: true,
        mode,
        theme: 'dracula',
        lineWrapping: false,
        viewportMargin: 40,
      });

      editor.setValue(contentText);
      editor.scrollTo?.(0, 0);
      editor.setCursor?.({ line: 0, ch: 0 });

      editor.on('cursorActivity', updateEditorStatus);
      editor.on('change', updateEditorDirtyState);
      updateEditorDirtyState();
      updateEditorStatus();
      requestAnimationFrame(() => {
        if (!editor) return;
        editor.setSize('100%', '100%');
        editor.refresh();
      });
    } else if (textarea) {
      textarea.value = contentText;
      textarea.addEventListener('input', updateEditorDirtyState);
      updateEditorDirtyState();
    }
  } catch (error: unknown) {
    toast(`❌ ${getErrorMessage(error)}`, 'err');
  }
}

function updateEditorStatus(): void {
  if (!editor) return;

  const cursor = editor.getCursor?.() || { line: 0, ch: 0 };
  const lineEl = $('edLine');
  const colEl = $('edCol');
  const linesEl = $('edLines');

  if (lineEl) lineEl.textContent = String(cursor.line + 1);
  if (colEl) colEl.textContent = String(cursor.ch + 1);
  if (linesEl && typeof editor.lineCount === 'function') {
    linesEl.textContent = String(editor.lineCount());
  }
}

function updateEditorDirtyState(): void {
  const dirty = editorHasUnsavedChanges();
  $('btnSaveFile')?.classList.toggle('has-unsaved-changes', dirty);
  const saveMsgEl = $('edSaveMsg');
  if (saveMsgEl) saveMsgEl.textContent = dirty ? 'Cambios sin guardar' : '';
}

function refreshEditorLayout(): void {
  if (!editor) return;

  requestAnimationFrame(() => {
    if (!editor) return;
    editor.setSize('100%', '100%');
    editor.refresh();
  });
}

window.addEventListener('resize', refreshEditorLayout, { passive: true });
window.visualViewport?.addEventListener('resize', refreshEditorLayout, { passive: true });

async function saveCurrentFile(): Promise<void> {
  if (!currentFile) return;

  const content = getEditorContent();
  const rawData = await postJSON('/api/files/content', {
    path: currentFile,
    content,
  });
  const data = isRecord(rawData) ? rawData : {};

  if (!data['ok']) {
    toast(`❌ ${typeof data['error'] === 'string' ? data['error'] : 'No se pudo guardar.'}`, 'err');
    return;
  }

  originalFileContent = content;
  updateEditorDirtyState();
  const saveMsgEl = $('edSaveMsg');
  if (saveMsgEl) {
    saveMsgEl.textContent = 'Guardado';
  }

  toast('💾 Archivo guardado', 'ok');
}

/* ══════════════════════════════════════════════
   11. PLUGINS
   ══════════════════════════════════════════════ */

interface PluginSearchItem {
  id?: string;
  name?: string;
  source?: string;
  icon?: string;
  description?: string;
  downloads?: number;
  premium?: boolean;
  external?: boolean;
  [key: string]: unknown;
}

function isPluginSearchItem(value: unknown): value is PluginSearchItem {
  return isRecord(value) &&
    optionalField(value, 'id', isString) &&
    optionalField(value, 'name', isString) &&
    optionalField(value, 'source', isString) &&
    optionalField(value, 'icon', isString) &&
    optionalField(value, 'description', isString) &&
    optionalField(value, 'downloads', isNumber) &&
    optionalField(value, 'premium', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'external', (item): item is boolean => typeof item === 'boolean');
}

interface PluginFileItem {
  url?: string;
  filename?: string;
  primary?: boolean;
  [key: string]: unknown;
}

interface PluginVersionItem {
  versionNumber?: string;
  name?: string;
  published?: string | number;
  changelog?: string;
  changelogIsHtml?: boolean;
  isExternal?: boolean;
  externalUrl?: string;
  files?: PluginFileItem[];
  [key: string]: unknown;
}

function isPluginFileItem(value: unknown): value is PluginFileItem {
  return isRecord(value) &&
    optionalField(value, 'url', isString) &&
    optionalField(value, 'filename', isString) &&
    optionalField(value, 'primary', (item): item is boolean => typeof item === 'boolean');
}

function isPluginVersionItem(value: unknown): value is PluginVersionItem {
  return isRecord(value) &&
    optionalField(value, 'versionNumber', isString) &&
    optionalField(value, 'name', isString) &&
    optionalField(value, 'published', isStringOrNumber) &&
    optionalField(value, 'changelog', isString) &&
    optionalField(value, 'changelogIsHtml', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'isExternal', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'externalUrl', isString) &&
    (value['files'] === undefined || isArrayOf(value['files'], isPluginFileItem));
}

interface InstalledPluginItem {
  filename?: string;
  size?: string | number;
  modified?: string;
  [key: string]: unknown;
}

function isInstalledPluginItem(value: unknown): value is InstalledPluginItem {
  return isRecord(value) &&
    optionalField(value, 'filename', isString) &&
    optionalField(value, 'size', isStringOrNumber) &&
    optionalField(value, 'modified', isString);
}

async function pluginSearch(): Promise<void> {
  const query = $input('plgSearchInput')?.value.trim() || '';
  const resultsEl = $('plgResults');

  if (!query) return;

  const generation = ++pluginSearchGeneration;

  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <div style="font-size:32px;animation:spin 1s linear infinite">⟳</div>
        <div class="empty-msg">Buscando...</div>
      </div>
    `;
  }

  try {
    const rawData = await api(
      `/api/plugins/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(pluginSource)}`
    );

    if (generation !== pluginSearchGeneration) return;

    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'Error al buscar plugins.');
    }

    let results: PluginSearchItem[] = isArrayOf(data['results'], isPluginSearchItem)
      ? data['results']
      : [];

    if (priceFilter === 'free') {
      results = results.filter(plugin => !plugin.premium);
    } else if (priceFilter === 'premium') {
      results = results.filter(plugin => Boolean(plugin.premium));
    }

    const errors: unknown[] = Array.isArray(data['errors']) ? data['errors'] : [];
    renderPluginResults(results, errors);
  } catch (error: unknown) {
    if (generation !== pluginSearchGeneration) return;
    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-msg">${escHtml(getErrorMessage(error))}</div>
        </div>
      `;
    }
  }
}

function renderPluginResults(results: PluginSearchItem[], errors: unknown[]): void {
  const resultsEl = $('plgResults');
  if (!resultsEl) return;

  const formatDownloads = (value: unknown) => {
    const n = Number(value) || 0;

    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;

    return String(n);
  };

  const warning = errors.length
    ? `<div class="plg-warn-bar">⚠ ${errors.map(escHtml).join(' · ')}</div>`
    : '';

  const tagMap: Record<string, string> = {
    modrinth: 'MODRINTH',
    spigot: 'SPIGOT',
    hangar: 'HANGAR',
  };

  const cards = results
    .map((plugin: PluginSearchItem, index: number) => {
      const srcKey = String(plugin.source || '').toLowerCase();
      const tag = tagMap[srcKey] || String(plugin.source || '').toUpperCase();
      const external = plugin.external
        ? '<span class="plg-src-badge">🔗 EXTERNO</span>'
        : '';
      const premium = plugin.premium
        ? '<span class="plg-src-badge">💰 PREMIUM</span>'
        : '';

      return `
        <div class="plg-card" data-index="${index}">
          <div class="plg-card-top">
            ${
              plugin.icon
                ? `<img class="plg-card-icon" src="${escHtml(plugin.icon)}" width="42" height="42" loading="lazy">`
                : `<div class="plg-card-icon-placeholder">🧩</div>`
            }
            <div class="plg-card-info">
              <div class="plg-card-name">${escHtml(plugin.name)}</div>
              <div class="plg-card-tags">
                <span class="plg-src-badge ${escHtml(plugin.source)}">${tag}</span>
                ${premium}
                ${external}
                <span class="plg-src-badge dl">⬇ ${formatDownloads(plugin.downloads)}</span>
              </div>
            </div>
          </div>
          <div class="plg-card-desc">${escHtml(plugin.description || '')}</div>
          <div class="plg-card-footer">
            <span></span>
            <button class="plg-versions-btn">Ver versiones →</button>
          </div>
        </div>
      `;
    })
    .join('');

  resultsEl.innerHTML =
    warning +
    (cards
      ? `<div class="plg-grid">${cards}</div>`
      : `<div class="empty-state"><div class="empty-msg">Sin resultados</div></div>`);

  resultsEl
    .querySelectorAll('.plg-card')
    .forEach(cardEl => {
      const card = cardEl as HTMLElement;
      card.addEventListener('click', () =>
        openPluginVersions(results[Number(card.dataset['index'])])
      );
    });
}

async function openPluginVersions(plugin: PluginSearchItem | undefined): Promise<void> {
  if (!plugin) return;
  currentPlugin = plugin;

  const modalEl = $('plgVersionModal');
  const iconEl = $('plgModalIcon') as HTMLImageElement | null;
  const nameEl = $('plgModalName');
  const metaEl = $('plgModalMeta');
  const bodyEl = $('plgModalBody');

  if (modalEl) modalEl.style.display = '';
  if (iconEl) iconEl.src = plugin.icon || '';
  if (nameEl) nameEl.textContent = plugin.name || '';
  if (metaEl) metaEl.textContent = `${String(plugin.source || '').toUpperCase()} · ${plugin.downloads || 0} descargas`;

  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="empty-state">
        <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
        <div class="empty-msg">Cargando versiones...</div>
      </div>
    `;
  }

  try {
    const rawData = await api(
      `/api/plugins/versions?id=${encodeURIComponent(String(plugin.id || ''))}&source=${encodeURIComponent(String(plugin.source || ''))}`
    );
    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudieron cargar las versiones.');
    }

    const versions: PluginVersionItem[] = isArrayOf(data['versions'], isPluginVersionItem)
      ? data['versions']
      : [];

    if (!versions.length) {
      if (bodyEl) {
        bodyEl.innerHTML = '<div class="empty-state"><div class="empty-msg">No hay versiones.</div></div>';
      }
      return;
    }

    const formatChangelog = (text: unknown) => {
      if (!text) return '';
      return escHtml(text)
        .replace(/^#### (.*$)/gim, '<div class="plg-ch-h4">$1</div>')
        .replace(/^### (.*$)/gim, '<div class="plg-ch-h3">$1</div>')
        .replace(/^## (.*$)/gim, '<div class="plg-ch-h2">$1</div>')
        .replace(/^# (.*$)/gim, '<div class="plg-ch-h1">$1</div>')
        .replace(/^\s*-\s+(.*$)/gim, '<div class="plg-ch-li">• $1</div>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    };

    if (bodyEl) {
      bodyEl.innerHTML = versions
        .map((version: PluginVersionItem, index: number) => {
          const published = version.published
            ? new Date(version.published).toLocaleString('es-ES')
            : '';

          const changelog = version.changelog
            ? `<div class="plg-ver-changelog">${version.changelogIsHtml
                ? version.changelog
                : formatChangelog(version.changelog)}</div>`
            : '';

          const action = version.isExternal
            ? `<a class="plg-dl-btn external" href="${escHtml(version.externalUrl)}" target="_blank" rel="noopener">ABRIR</a>`
            : `<button class="plg-dl-btn" data-version="${index}">INSTALAR</button>`;

          return `
            <div class="plg-ver-row">
              <div class="plg-ver-left">
                <div class="plg-ver-number">${escHtml(version.versionNumber || version.name || 'Versión')}</div>
                ${published ? `<div class="plg-ver-meta"><span class="plg-vm">${escHtml(published)}</span></div>` : ''}
                ${changelog}
              </div>
              <div class="plg-ver-right">
                ${action}
              </div>
            </div>
          `;
        })
        .join('');

      bodyEl
        .querySelectorAll('[data-version]')
        .forEach(buttonEl => {
          const button = buttonEl as HTMLElement;
          button.addEventListener('click', () =>
            installPlugin(versions[Number(button.dataset['version'])])
          );
        });
    }
  } catch (error: unknown) {
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-msg">${escHtml(getErrorMessage(error))}</div>
        </div>
      `;
    }
  }
}

async function installPlugin(version: PluginVersionItem | undefined): Promise<void> {
  if (!version) return;
  if (!isOwnerSession()) {
    toast('🔒 Solo el propietario puede instalar plugins.', 'warn');
    return;
  }

  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((item: PluginFileItem) => Boolean(item.primary)) || files[0];

  if (!file?.url) {
    toast('Esta versión requiere instalación externa.', 'err');
    return;
  }

  const pluginName = isRecord(currentPlugin) && typeof currentPlugin['name'] === 'string'
    ? currentPlugin['name']
    : 'plugin';
  const filename =
    file.filename ||
    `${String(pluginName).replace(/[^a-zA-Z0-9._-]/g, '_')}.jar`;

  const modalBody = $('plgModalBody');
  const installStatus = document.createElement('div');
  installStatus.className = 'plg-install-status installing';
  installStatus.innerHTML = '<span class="plg-install-spinner">⟳</span><strong>Instalando...</strong><span>Descargando y copiando el plugin al servidor</span>';
  modalBody?.prepend(installStatus);

  const installButtons = Array.from(modalBody?.querySelectorAll('.plg-dl-btn:not(.external)') || [])
    .map(btn => btn as HTMLButtonElement);
  installButtons.forEach(button => {
    button.disabled = true;
    button.classList.add('is-installing');
  });

  try {
    const rawData = await postJSON('/api/plugins/install', { url: file.url, filename });
    const data = isRecord(rawData) ? rawData : {};
    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudo instalar el plugin.');
    }
    installStatus.className = 'plg-install-status installed';
    installStatus.innerHTML = `<span>✓</span><strong>Instalado correctamente</strong><span>${escHtml(filename)}</span>`;
    toast(`✅ ${filename} instalado`, 'ok');
    loadInstalledPlugins({ force: true });
  } catch (error: unknown) {
    const errMsg = getErrorMessage(error);
    installStatus.className = 'plg-install-status failed';
    installStatus.innerHTML = `<span>⚠</span><strong>Instalación fallida</strong><span>${escHtml(errMsg)}</span>`;
    installButtons.forEach(button => {
      button.disabled = false;
      button.classList.remove('is-installing');
    });
    toast(`❌ ${errMsg}`, 'err');
  }
}

async function loadInstalledPlugins(options: SoftLoadOptions = {}): Promise<void> {
  const element = $('plgInstalledList');

  if (!element) return;

  const soft = resolveSoftLoad(options, element);
  if (!soft) {
    element.innerHTML = `
      <div class="empty-state">
        <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
        <div class="empty-msg">Cargando...</div>
      </div>
    `;
  }

  const rawData = await cachedApi(
    'plugins:installed',
    '/api/plugins/installed',
    undefined,
    VIEW_CACHE_TTL_MS,
    Boolean(options.force)
  );
  const data = isRecord(rawData) ? rawData : {};

  if (!data['ok']) {
    element.innerHTML = `<div class="empty-state">${escHtml(data['error'])}</div>`;
    return;
  }

  const owner = isOwnerSession();
  const pluginsList: InstalledPluginItem[] = isArrayOf(data['plugins'], isInstalledPluginItem)
    ? data['plugins']
    : [];

  element.innerHTML =
    pluginsList
      .map(
        (plugin: InstalledPluginItem) => `
        <div class="installed-plugin-row">
          <div>
            <strong>☕ ${escHtml(plugin.filename)}</strong>
            <div style="font-size:11px;color:var(--muted2)">${escHtml(plugin.size)} · ${escHtml(plugin.modified)}</div>
          </div>
          <button class="small-btn danger" data-delete-plugin="${escHtml(plugin.filename)}"
            ${owner ? '' : 'disabled title="Solo el propietario"'}>Eliminar</button>
        </div>
      `
      )
      .join('') ||
    `<div class="empty-state">No hay plugins .jar instalados.</div>`;

  element.querySelectorAll('[data-delete-plugin]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', async () => {
      const filename = button.dataset['deletePlugin'] || '';

      if (!confirm(`¿Eliminar ${filename}?`)) {
        return;
      }

      const rawDel = await api(
        `/api/plugins/installed/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      );
      const delData = isRecord(rawDel) ? rawDel : {};

      if (!delData['ok']) {
        toast(`❌ ${delData['error']}`, 'err');
      } else {
        loadInstalledPlugins({ force: true });
      }
    });
  });
}

interface VersionSoftwareItem {
  id: string;
  label?: string;
  name?: string;
  desc?: string;
  description?: string;
  category?: string;
  icon?: string;
  external?: string;
  [key: string]: unknown;
}

function isVersionSoftwareItem(value: unknown): value is VersionSoftwareItem {
  return isRecord(value) && isString(value['id']) &&
    optionalField(value, 'label', isString) &&
    optionalField(value, 'name', isString) &&
    optionalField(value, 'desc', isString) &&
    optionalField(value, 'description', isString) &&
    optionalField(value, 'category', isString) &&
    optionalField(value, 'icon', isString) &&
    optionalField(value, 'external', isString);
}

interface VersionBuildItem {
  build?: string | number;
  channel?: string;
  loaderVersion?: string;
  time?: string | number;
  changes?: string;
  sha256?: string;
  installable?: boolean;
  url?: string;
  [key: string]: unknown;
}

function isVersionBuildItem(value: unknown): value is VersionBuildItem {
  return isRecord(value) &&
    optionalField(value, 'build', isStringOrNumber) &&
    optionalField(value, 'channel', isString) &&
    optionalField(value, 'loaderVersion', isString) &&
    optionalField(value, 'time', isStringOrNumber) &&
    optionalField(value, 'changes', isString) &&
    optionalField(value, 'sha256', isString) &&
    optionalField(value, 'installable', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'url', isString);
}

let versionCatalog: VersionSoftwareItem[] = [];
let versionCurrent = {
  software: '',
  version: '',
  build: '' as string | number,
};

/* ══════════════════════════════════════════════
   12. VERSIONES Y SOFTWARE
   ══════════════════════════════════════════════ */

function versionFindSoftware(id: string): VersionSoftwareItem {
  return versionCatalog.find((item: VersionSoftwareItem) => item.id === id) || {
    id,
    label: id,
    desc: '',
  };
}

function versionCategoryName(category: string): string {
  if (category === 'plugins') return 'Versiones de plugins';
  if (category === 'mods' || category === 'mod') return 'Versiones de mods';
  if (category === 'proxy') return 'Versiones de proxy';
  if (category === 'hybrid') return 'Versiones de híbridos';
  if (category === 'vanilla') return 'Versiones de Vanilla';
  return 'Servidores de Minecraft';
}

function renderVersionSoftwareCard(software: VersionSoftwareItem): string {
  return `
    <button type="button" class="ver-software-card" data-software="${escHtml(software.id)}">
      <div class="ver-software-icon">${software.icon || '📦'}</div>
      <div class="ver-software-content">
        <div class="ver-software-name">${escHtml(software.label || software.name || software.id)}</div>
        <div class="ver-software-desc">${escHtml(software.desc || software.description || '')}</div>
      </div>
      <div class="ver-software-arrow">›</div>
    </button>
  `;
}

function renderVersionSoftware(): void {
  const container = $('versionList');
  if (!container) return;

  if (!versionCatalog.length) {
    container.innerHTML = `
      <div class="ver-empty">
        <div class="ver-empty-icon">📦</div>
        <div class="ver-empty-title">No se han podido cargar los servidores</div>
        <div class="ver-empty-text">Comprueba que el Agent esté conectado y vuelve a intentarlo.</div>
        <button type="button" class="btn btn-primary ver-retry-btn" id="verRetry">Reintentar</button>
      </div>
    `;
    $('verRetry')?.addEventListener('click', () => loadVersionState({ force: true }));
    return;
  }

  const groups: Record<string, VersionSoftwareItem[]> = {};
  for (const item of versionCatalog) {
    const category = item.category || 'plugins';
    (groups[category] ||= []).push(item);
  }

  const categoryOrder = ['plugins', 'mods', 'proxy', 'hybrid', 'vanilla'];
  const categoryIcon: Record<string, string> = {
    plugins: '🧩',
    mods: '🧵',
    proxy: '🌐',
    hybrid: '🔀',
    vanilla: '🌿',
  };

  const orderedGroups = categoryOrder
    .filter(category => groups[category]?.length)
    .map(category => [category, groups[category]] as [string, VersionSoftwareItem[]]);

  container.innerHTML = `
    ${orderedGroups.map(([category, items]) => `
      <section class="ver-category">
        <div class="ver-category-header">
          <div class="ver-category-icon">${categoryIcon[category] || '📦'}</div>
          <div class="ver-category-name">${escHtml(versionCategoryName(category))}</div>
          <div class="ver-category-count">${items.length} disponibles</div>
        </div>
        <div class="ver-software-grid">
          ${items.map(renderVersionSoftwareCard).join('')}
        </div>
      </section>
    `).join('')}
  `;

  container.querySelectorAll('[data-software]').forEach(cardEl => {
    const card = cardEl as HTMLElement;
    card.addEventListener('click', () => selectVersionSoftware(card.dataset['software'] || ''));
  });
}

async function selectVersionSoftware(software: string): Promise<void> {
  const item = versionFindSoftware(software);
  const container = $('versionList');
  if (!container) return;

  container.innerHTML = `
    <div class="ver-panel-head">
      <button type="button" class="btn ver-back-btn" id="verBack">← Volver</button>
      <div>
        <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)}</div>
        <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
      </div>
    </div>
    <div class="ver-loading">Cargando versiones de ${escHtml(item.label || software)}…</div>
  `;

  $('verBack')?.addEventListener('click', renderVersionSoftware);

  const supportedApiSoftware = [
    'paper', 'purpur', 'folia', 'leaves', 'leaf', 'spigot', 'bukkit',
    'mohist', 'arclight', 'magma', 'spongevanilla', 'spongeforge', 'spongeneo',
    'fabric', 'quilt', 'vanilla', 'forge', 'neoforge', 'velocity', 'waterfall', 'bungeecord',
  ];

  if (item.external && !supportedApiSoftware.includes(software)) {
    const loadingEl = container.querySelector('.ver-loading');
    if (loadingEl) {
      loadingEl.outerHTML = `
        <div class="ver-empty">
          <div class="ver-empty-icon">🌐</div>
          <div class="ver-empty-title">Descarga externa</div>
          <div class="ver-empty-text">MoonWolf no dispone de una API de versiones para este software.</div>
          <a class="btn btn-primary" href="${escHtml(item.external)}" target="_blank" rel="noopener noreferrer">Abrir web oficial ↗</a>
        </div>
      `;
    }
    return;
  }

  try {
    const rawData = await api(`/api/versions/list?software=${encodeURIComponent(software)}`);
    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudieron cargar las versiones.');
    }

    const versions: unknown[] = Array.isArray(data['versions']) ? data['versions'] : [];

    if (!versions.length) {
      throw new Error('La API no devolvió ninguna versión disponible.');
    }

    versionCurrent.software = software;

    container.innerHTML = `
      <div class="ver-panel-head">
        <button type="button" class="btn ver-back-btn" id="verBack">← Volver</button>
        <div>
          <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)}</div>
          <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
        </div>
      </div>

      <div class="ver-version-header">
        <div style="padding-left:28px">
          <div class="ver-section-title">Versiones disponibles</div>
          <div class="ver-section-subtitle">${versions.length} versiones encontradas</div>
        </div>
        <input id="verVersionSearch" class="ver-search" type="search" placeholder="Buscar versión…">
      </div>

      <div class="ver-version-grid" id="verVersionGrid"></div>
    `;

    $('verBack')?.addEventListener('click', renderVersionSoftware);

    const grid = $('verVersionGrid');

    const drawVersions = (filter = '') => {
      if (!grid) return;
      const q = filter.trim().toLowerCase();
      const filtered = versions.filter((v: unknown) => String(v).toLowerCase().includes(q));

      grid.innerHTML = filtered.map((v: unknown) => `
        <button type="button" class="ver-version-card ${String(v) === String(versionCurrent.version) && software === versionCurrent.software ? 'current' : ''}" data-version="${escHtml(v)}">
          <span>${escHtml(v)}</span>
          ${String(v) === String(versionCurrent.version) && software === versionCurrent.software ? '<small>ACTUAL</small>' : ''}
        </button>
      `).join('') || `<div class="ver-no-results">No hay versiones que coincidan.</div>`;

      grid.querySelectorAll('[data-version]').forEach(btnEl => {
        const btn = btnEl as HTMLElement;
        btn.addEventListener('click', () => selectVersionBuilds(software, btn.dataset['version'] || '', item));
      });
    };

    const onVersionSearch = debounce((value: string) => {
      drawVersions(value);
    }, 120);
    $input('verVersionSearch')?.addEventListener('input', (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      onVersionSearch(target?.value || '');
    });
    drawVersions();

  } catch (error: unknown) {
    const box = container.querySelector('.ver-loading');
    if (box) {
      box.className = 'ver-empty';
      box.innerHTML = `
        <div class="ver-empty-icon">⚠️</div>
        <div class="ver-empty-title">No se pudieron cargar las versiones</div>
        <div class="ver-empty-text">${escHtml(getErrorMessage(error, 'Error desconocido'))}</div>
        <button type="button" class="btn btn-primary" id="verRetrySoftware">Reintentar</button>
      `;
      $('verRetrySoftware')?.addEventListener('click', () => selectVersionSoftware(software));
    }
  }
}

async function selectVersionBuilds(
  software: string,
  version: string,
  item: VersionSoftwareItem = versionFindSoftware(software)
): Promise<void> {
  const container = $('versionList');
  if (!container) return;

  versionCurrent.software = software;
  versionCurrent.version = version;
  versionCurrent.build = '';

  container.innerHTML = `
    <div class="ver-panel-head">
      <button type="button" class="btn ver-back-btn" id="verBackVersions">← Versiones</button>
      <div>
        <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)} ${escHtml(version)}</div>
        <div class="ver-panel-subtitle">${escHtml(item.desc || '')}</div>
      </div>
    </div>
    <div class="ver-loading">Cargando builds de ${escHtml(version)}…</div>
  `;

  $('verBackVersions')?.addEventListener('click', () => selectVersionSoftware(software));

  try {
    const rawData = await api(
      `/api/versions/builds?software=${encodeURIComponent(software)}&version=${encodeURIComponent(version)}`
    );
    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudieron cargar los builds.');
    }

    const builds: VersionBuildItem[] = isArrayOf(data['builds'], isVersionBuildItem)
      ? data['builds']
      : [];

    if (!builds.length) {
      throw new Error('No hay builds disponibles para esta versión.');
    }

    versionCurrent.build = builds[0]?.build ?? '';

    container.innerHTML = `
      <div class="ver-panel-head">
        <button type="button" class="btn ver-back-btn" id="verBackVersions">← Versiones</button>
        <div>
          <div class="ver-panel-title">${item.icon || '📦'} ${escHtml(item.label || software)} ${escHtml(version)}</div>
          <div class="ver-panel-subtitle">${builds.length} builds disponibles</div>
        </div>
      </div>

      <div class="ver-build-list">
        ${builds.map((b: VersionBuildItem, index: number) => `
          <div class="ver-build-item ${index === 0 ? 'selected' : ''}" data-build="${escHtml(b.build)}">
            <div class="ver-build-main">
              <div class="ver-build-title">Build ${escHtml(b.build)}</div>
              <div class="ver-build-meta">
                <span>${escHtml(b.channel || 'STABLE')}</span>
                ${b.loaderVersion ? `<span>Loader ${escHtml(b.loaderVersion)}</span>` : ''}
                ${b.time ? `<span>${escHtml(new Date(b.time).toLocaleString('es-ES'))}</span>` : ''}
              </div>
              ${b.changes ? `<div class="ver-build-changes">${escHtml(b.changes)}</div>` : ''}
              ${b.sha256 ? `<div class="ver-build-sha">SHA-256: ${escHtml(b.sha256)}</div>` : ''}
            </div>
            <button type="button" class="btn ${b.installable === false ? '' : 'btn-primary'} ver-install-btn" data-build-index="${index}" ${b.installable === false ? 'disabled' : ''}>
              ${b.installable === false ? 'Solo información' : (software === 'fabric' || software === 'quilt' || software === 'forge' || software === 'neoforge' ? 'Preparar instalación' : 'Instalar')}
            </button>
          </div>
        `).join('')}
      </div>
    `;

    $('verBackVersions')?.addEventListener('click', () => selectVersionSoftware(software));

    container.querySelectorAll('[data-build-index]').forEach(buttonEl => {
      const button = buttonEl as HTMLElement;
      button.addEventListener('click', () => {
        const build = builds[Number(button.dataset['buildIndex'])];
        if (build?.installable === false) return;
        installVersionSelection(software, version, build);
      });
    });
  } catch (error: unknown) {
    const box = container.querySelector('.ver-loading');
    if (box) {
      box.className = 'ver-empty';
      box.innerHTML = `
        <div class="ver-empty-icon">⚠️</div>
        <div class="ver-empty-title">No se pudieron cargar los builds</div>
        <div class="ver-empty-text">${escHtml(getErrorMessage(error, 'Error desconocido'))}</div>
        <button type="button" class="btn btn-primary" id="verRetryBuilds">Reintentar</button>
      `;
      $('verRetryBuilds')?.addEventListener('click', () => selectVersionBuilds(software, version, item));
    }
  }
}

async function installVersionSelection(
  software: string,
  version: string,
  build: VersionBuildItem | undefined
): Promise<void> {
  if (!isOwnerSession()) {
    toast('🔒 Solo el propietario puede instalar o reemplazar el servidor.', 'warn');
    return;
  }

  const label = versionFindSoftware(software).label || software;
  const buildLabel = build?.build !== undefined ? `Build ${build.build}` : 'versión seleccionada';

  if (!confirm(`¿Quieres instalar ${label} ${version} (${buildLabel})?`)) return;

  try {
    toast('⏳ Descargando e instalando...', 'info');

    const rawData = await postJSON('/api/versions/install', {
      software,
      version,
      build: build?.build ?? '',
      url: build?.url || '',
      loaderVersion: build?.loaderVersion || '',
    });
    const data = isRecord(rawData) ? rawData : {};

    if (!data['ok']) {
      throw new Error(typeof data['error'] === 'string' ? data['error'] : 'No se pudo instalar la versión.');
    }

    const installType = typeof data['type'] === 'string' ? data['type'] : '';
    if (installType === 'fabric-installer' || installType === 'quilt-installer' || installType === 'forge-installer' || installType === 'neoforge-installer') {
      const name = installType === 'forge-installer'
        ? 'Forge'
        : (installType === 'neoforge-installer' ? 'NeoForge' : (installType === 'quilt-installer' ? 'Quilt' : 'Fabric'));
      toast(`⚠️ ${name} preparado. Revisa el comando indicado antes de ejecutarlo.`, 'info');
      const noteText = typeof data['note'] === 'string' ? data['note'] : '';
      const cmdText = typeof data['installCmd'] === 'string' && data['installCmd'] ? data['installCmd'] : 'No disponible';
      alert(
        `${name} ${version} preparado.\n\n` +
        `${noteText}\n\n` +
        `Comando:\n${cmdText}`
      );
    } else {
      toast(`✅ ${label} ${version} instalado correctamente.`, 'ok');
    }

    await loadVersionState();
  } catch (error: unknown) {
    toast(`❌ ${getErrorMessage(error)}`, 'err');
  }
}

async function loadVersionState(options: SoftLoadOptions = {}): Promise<void> {
  const container = $('versionList');
  const soft = resolveSoftLoad(options, container);
  if (container && !soft) {
    container.innerHTML = `
      <div class="ver-loading-page">
        <div class="ver-loading-spinner">⟳</div>
        <div>Cargando catálogo de versiones…</div>
      </div>
    `;
  }

  try {
    const force = Boolean(options.force);
    const [rawSoftwareData, rawStartupData] = await Promise.all([
      cachedApi('versions:software', '/api/versions/software', undefined, VIEW_CACHE_TTL_MS, force),
      cachedApi('startup', '/api/startup', undefined, VIEW_CACHE_TTL_MS, force),
    ]);
    const softwareData = isRecord(rawSoftwareData) ? rawSoftwareData : {};
    const startupData = isRecord(rawStartupData) ? rawStartupData : {};

    if (!softwareData['ok']) {
      throw new Error(typeof softwareData['error'] === 'string' ? softwareData['error'] : 'No se pudo cargar el catálogo de software.');
    }

    const softwareItems = isArrayOf(softwareData['software'], isVersionSoftwareItem)
      ? softwareData['software']
      : [];
    versionCatalog = softwareItems
      .map((item: VersionSoftwareItem) => ({
        ...item,
        icon:
          item.id === 'paper' ? '📄' :
          item.id === 'purpur' ? '🟣' :
          item.id === 'folia' ? '🌲' :
          item.id === 'fabric' ? '🧵' :
          item.id === 'forge' ? '🔨' :
          item.id === 'leaf' ? '🍁' :
          item.id === 'leaves' ? '🍃' :
          item.id === 'spigot' ? '🧱' :
          item.id === 'bukkit' ? '🧺' :
          item.id === 'magma' ? '🌋' :
          item.id === 'arclight' ? '💡' :
          item.id === 'sponge' ? '🧽' :
          item.id === 'mohist' ? '⚗️' :
          item.id === 'gale' ? '🌬️' :
          item.id === 'pufferfish' ? '🐡' :
          item.id === 'quilt' ? '🧶' :
          item.id === 'neoforge' ? '⚒️' :
          item.id === 'vanilla' ? '🌿' :
          item.id === 'velocity' ? '⚡' :
          item.id === 'waterfall' ? '🌊' :
          item.id === 'bungeecord' ? '🔗' : '📦',
      }));

    const startupConfigObj = isRecord(startupData['config']) ? startupData['config'] : {};
    versionCurrent = {
      software: '',
      version: typeof startupConfigObj['minecraftVersion'] === 'string' ? startupConfigObj['minecraftVersion'] : '',
      build: '',
    };

    renderVersionSoftware();
  } catch (error: unknown) {
    versionCatalog = [];
    renderVersionSoftware();
    toast(`❌ ${getErrorMessage(error)}`, 'err');
  }
}

/* ══════════════════════════════════════════════
   13. BASES DE DATOS
   ══════════════════════════════════════════════ */

interface DbCredentials {
  host?: string;
  port?: string | number;
  database?: string;
  user?: string;
  password?: string;
}

function isDbCredentials(value: unknown): value is DbCredentials {
  return isRecord(value) &&
    optionalField(value, 'host', isString) &&
    optionalField(value, 'port', isStringOrNumber) &&
    optionalField(value, 'database', isString) &&
    optionalField(value, 'user', isString) &&
    optionalField(value, 'password', isString);
}

interface DatabaseSummaryItem {
  name?: string;
  tables?: string | number;
  user?: string;
  sizeMb?: string | number;
}

function isDatabaseSummaryItem(value: unknown): value is DatabaseSummaryItem {
  return isRecord(value) &&
    optionalField(value, 'name', isString) &&
    optionalField(value, 'tables', isStringOrNumber) &&
    optionalField(value, 'user', isString) &&
    optionalField(value, 'sizeMb', isStringOrNumber);
}

interface DatabaseStatusState {
  connected: boolean;
  host?: string;
  port?: string | number;
  error?: string;
}

function showDbCredentials(creds: DbCredentials): void {
  const text =
    `Host: ${creds.host}:${creds.port}\n` +
    `Base de datos: ${creds.database}\n` +
    `Usuario: ${creds.user}\n` +
    `Contraseña: ${creds.password}`;

  try {
    navigator.clipboard?.writeText(text);
  } catch {}

  alert(
    `Credenciales de la base de datos (copiadas al portapapeles):\n\n${text}\n\n⚠️ Esta contraseña no se volverá a mostrar.`
  );
}

async function createDatabase(): Promise<void> {
  const name = prompt(
    'Nombre de la nueva base de datos (letras, números y guion bajo, máx. 48 caracteres):'
  );

  if (!name) return;

  const rawData = await postJSON('/api/databases', {
    name: name.trim(),
    createUser: true,
  });
  const data = isRecord(rawData) ? rawData : {};

  if (!data['ok']) {
    toast(`❌ ${typeof data['error'] === 'string' ? data['error'] : 'Error al crear la base de datos.'}`, 'err');
    return;
  }

  toast('✅ Base de datos creada', 'ok');

  if (isDbCredentials(data['credentials'])) {
    showDbCredentials(data['credentials']);
  }

  loadDatabases({ force: true });
}

async function loadDatabases(options: SoftLoadOptions = {}): Promise<void> {
  const container = $('dbList');

  if (!container) return;

  const soft = resolveSoftLoad(options, container);
  if (!soft) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
        <div class="empty-msg">Conectando con MySQL...</div>
      </div>
    `;
  }

  let status: DatabaseStatusState = { connected: false };

  try {
    const force = Boolean(options.force);
    const rawStatus = await cachedApi('databases:status', '/api/databases/status', undefined, 15_000, force);
    if (isRecord(rawStatus)) {
      status = {
        connected: rawStatus['connected'] === true,
        ...(typeof rawStatus['host'] === 'string' ? { host: rawStatus['host'] } : {}),
        ...(typeof rawStatus['port'] === 'string' || typeof rawStatus['port'] === 'number'
          ? { port: rawStatus['port'] }
          : {}),
        ...(typeof rawStatus['error'] === 'string' ? { error: rawStatus['error'] } : {}),
      };
    }
  } catch (error: unknown) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(getErrorMessage(error))}</div>
      </div>
    `;
    return;
  }

  if (!status.connected) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" style="color:var(--red)">⚠</div>
        <div class="empty-msg">
          No se pudo conectar con MySQL (${escHtml(status.host || '')}:${escHtml(String(status.port || ''))}).<br>
          <span style="font-size:11px;color:var(--muted)">
            ${escHtml(status.error || 'Configura MOONWOLF_MYSQL_HOST / MOONWOLF_MYSQL_USER / MOONWOLF_MYSQL_PASSWORD en el .env del servidor.')}
          </span>
        </div>
      </div>
    `;
    return;
  }

  const rawData = await cachedApi('databases', '/api/databases', undefined, VIEW_CACHE_TTL_MS, Boolean(options.force));
  const data = isRecord(rawData) ? rawData : {};

  if (!data['ok']) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(data['error'])}</div>
      </div>
    `;
    return;
  }

  const databases: DatabaseSummaryItem[] = isArrayOf(data['databases'], isDatabaseSummaryItem)
    ? data['databases']
    : [];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px 14px">
      <span style="font-size:11px;color:var(--muted2)">
        🟢 Conectado a MySQL — ${escHtml(status.host || '')}:${escHtml(String(status.port || ''))}
      </span>
      <button class="small-btn" id="btnNewDatabase">➕ Nueva base de datos</button>
    </div>

    ${
      databases.length
        ? databases
            .map(
              (db: DatabaseSummaryItem) => `
          <div class="backup-row">
            <span class="bk-icon">🗄️</span>
            <span class="bk-name">
              ${escHtml(db.name)}
              <small>${escHtml(db.tables)} tablas · ${escHtml(db.user || 'sin usuario dedicado')}</small>
            </span>
            <span class="bk-size">${escHtml(db.sizeMb)} MB</span>
            <span class="bk-actions">
              ${
                db.user
                  ? `<button class="icon-btn edit" data-reset-db="${escHtml(db.name)}" title="Restablecer contraseña">🔑</button>`
                  : ''
              }
              <button class="icon-btn" data-delete-db="${escHtml(db.name)}" title="Eliminar">🗑️</button>
            </span>
          </div>
        `
            )
            .join('')
        : '<div class="empty-state"><div class="empty-msg">No hay bases de datos todavía.</div></div>'
    }
  `;

  $('btnNewDatabase')?.addEventListener('click', createDatabase);

  container.querySelectorAll('[data-delete-db]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', async () => {
      const name = button.dataset['deleteDb'] || '';

      if (
        !confirm(
          `Eliminar la base de datos "${name}"? Esta acción no se puede deshacer.`
        )
      ) {
        return;
      }

      const rawDel = await api(`/api/databases/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const delData = isRecord(rawDel) ? rawDel : {};

      if (!delData['ok']) {
        toast(`❌ ${delData['error']}`, 'err');
        return;
      }

      toast('✅ Base de datos eliminada', 'ok');
      loadDatabases({ force: true });
    });
  });

  container.querySelectorAll('[data-reset-db]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', async () => {
      const name = button.dataset['resetDb'] || '';

      if (!confirm(`Restablecer la contraseña del usuario de "${name}"?`)) {
        return;
      }

      const rawReset = await postJSON(
        `/api/databases/${encodeURIComponent(name)}/reset-password`,
        {}
      );
      const resetData = isRecord(rawReset) ? rawReset : {};

      if (!resetData['ok']) {
        toast(`❌ ${resetData['error']}`, 'err');
        return;
      }

      if (isDbCredentials(resetData['credentials'])) {
        showDbCredentials(resetData['credentials']);
      }
    });
  });
}

/* ══════════════════════════════════════════════
   14. USUARIOS Y TOKENS COMPARTIDOS
   ══════════════════════════════════════════════ */

interface ShareTokenItem {
  id?: string;
  label?: string;
  permission?: string;
  expiresAt?: string | number | null;
}

function isShareTokenItem(value: unknown): value is ShareTokenItem {
  return isRecord(value) &&
    optionalField(value, 'id', isString) &&
    optionalField(value, 'label', isString) &&
    optionalField(value, 'permission', isString) &&
    (value['expiresAt'] === undefined || value['expiresAt'] === null || isStringOrNumber(value['expiresAt']));
}

const SHARE_PERMISSION_LABELS: Record<Permission, string> = {
  read: '👁️ Solo lectura',
  control: '🎮 Control',
  admin: '🛡️ Administrador',
};

function sharePermissionLabel(permission: unknown): string {
  const key = String(permission || '').toLowerCase();
  return isPermission(key) ? SHARE_PERMISSION_LABELS[key] : SHARE_PERMISSION_LABELS.read;
}

async function loadShareTokens(): Promise<void> {
  if (panelPermission !== 'admin') return;

  const list = $('shareTokenList');
  if (!list) return;

  try {
    const rawData = await cloudApi('/api/share-tokens');
    const data = isRecord(rawData) ? rawData : {};
    const tokens: ShareTokenItem[] = isArrayOf(data['tokens'], isShareTokenItem)
      ? data['tokens']
      : [];

    const control = tokens.filter((token: ShareTokenItem) => token.permission === 'control').length;
    const read = tokens.filter((token: ShareTokenItem) => token.permission === 'read').length;
    const admin = tokens.filter((token: ShareTokenItem) => token.permission === 'admin').length;

    const totalEl = $('userStatTotal');
    const controlEl = $('userStatControl');
    const readEl = $('userStatRead');
    const adminEl = $('userStatAdmin');

    if (totalEl) totalEl.textContent = String(tokens.length);
    if (controlEl) controlEl.textContent = String(control);
    if (readEl) readEl.textContent = String(read);
    if (adminEl) adminEl.textContent = String(admin);

    list.innerHTML = tokens.length
      ? tokens
          .map((token: ShareTokenItem) => {
            const expiry = token.expiresAt
              ? new Date(token.expiresAt).toLocaleString('es-ES')
              : 'Nunca';
            return `
            <div class="user-row">
              <div class="user-avatar">👤</div>
              <div class="user-row-main">
                <strong>${escHtml(token.label || 'Usuario')}</strong>
                <div class="user-row-meta">
                  <select class="form-input user-permission-select ${escHtml(token.permission)}" data-edit-permission="${escHtml(token.id)}">
                    <option value="read" ${token.permission === 'read' ? 'selected' : ''}>${SHARE_PERMISSION_LABELS['read']}</option>
                    <option value="control" ${token.permission === 'control' ? 'selected' : ''}>${SHARE_PERMISSION_LABELS['control']}</option>
                    <option value="admin" ${token.permission === 'admin' ? 'selected' : ''}>${SHARE_PERMISSION_LABELS['admin']}</option>
                  </select>
                  <span>Caduca: ${escHtml(expiry)}</span>
                </div>
              </div>
              <button class="small-btn user-revoke-btn" data-revoke-share="${escHtml(token.id)}">Revocar</button>
            </div>
          `;
          })
          .join('')
      : '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-msg">No hay usuarios con acceso.</div></div>';

    list.querySelectorAll('[data-revoke-share]').forEach(buttonEl => {
      const button = buttonEl as HTMLButtonElement;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await cloudApi(
            `/api/share-tokens/${encodeURIComponent(button.dataset['revokeShare'] || '')}`,
            { method: 'DELETE' }
          );
          toast('Acceso revocado.', 'ok');
          await loadShareTokens();
        } catch (error: unknown) {
          toast(getErrorMessage(error), 'err');
          button.disabled = false;
        }
      });
    });

    list.querySelectorAll('[data-edit-permission]').forEach(selectEl => {
      const select = selectEl as HTMLSelectElement;
      select.dataset['previousPermission'] = select.value;
      select.addEventListener('change', async () => {
        const previous = select.dataset['previousPermission'] || 'read';
        select.disabled = true;
        try {
          await cloudApi(`/api/share-tokens/${encodeURIComponent(select.dataset['editPermission'] || '')}`, {
            method: 'PATCH',
            body: JSON.stringify({ permission: select.value }),
          });
          select.dataset['previousPermission'] = select.value;
          toast(`Permiso actualizado: ${sharePermissionLabel(select.value)}.`, 'ok');
          await loadShareTokens();
        } catch (error: unknown) {
          select.value = previous;
          select.disabled = false;
          toast(getErrorMessage(error), 'err');
        }
      });
    });
  } catch (error: unknown) {
    list.innerHTML = `<div class="empty-state">${escHtml(getErrorMessage(error))}</div>`;
  }
}

function renderUsers(): void {
  const element = $('userList');
  if (!element) return;

  const canManageUsers = isOwnerSession() && panelPermission === 'admin';

  if (!canManageUsers) {
    element.innerHTML = `
      <div class="user-access-grid">
        <div class="panel user-access-card">
          <div class="panel-header">
            <div class="panel-title"><span>👤</span> TU ACCESO</div>
          </div>
          <div class="user-access-body">
            <div class="user-profile-icon">👤</div>
            <div>
              <div class="user-profile-title">Acceso compartido</div>
              <div class="user-profile-sub">Este panel te ha sido compartido por el propietario.</div>
            </div>
          </div>
          <div class="user-permission-row">
            <span>Permiso</span>
            <strong>${escHtml(sharePermissionLabel(panelPermission))}</strong>
          </div>
          <div class="user-info-note">
            Tu acceso está limitado a los permisos asignados por el propietario.
            Las operaciones que permiten ejecutar código en el host (instalar plugins,
            cambiar flags JVM, restaurar backups) están reservadas al propietario.
          </div>
        </div>
      </div>
    `;
    return;
  }

  element.innerHTML = `
    <div class="user-stats-grid">
      <div class="user-stat-card">
        <span class="user-stat-icon">👥</span>
        <div><span class="user-stat-label">Accesos activos</span><strong id="userStatTotal">—</strong></div>
      </div>
      <div class="user-stat-card">
        <span class="user-stat-icon">👁️</span>
        <div><span class="user-stat-label">Solo lectura</span><strong id="userStatRead">—</strong></div>
      </div>
      <div class="user-stat-card">
        <span class="user-stat-icon">🎮</span>
        <div><span class="user-stat-label">Con control</span><strong id="userStatControl">—</strong></div>
      </div>
      <div class="user-stat-card">
        <span class="user-stat-icon">🛡️</span>
        <div><span class="user-stat-label">Administradores</span><strong id="userStatAdmin">—</strong></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title"><span>➕</span> NUEVO USUARIO</div>
          <div class="user-panel-subtitle">Crea un acceso independiente.</div>
        </div>
      </div>
      <div class="user-create-form">
        <input id="shareLabel" class="form-input" placeholder="Nombre (ej. Paco)" maxlength="60">
        <select id="sharePermission" class="form-input">
          <option value="read">👁️ Solo lectura</option>
          <option value="control">🎮 Control</option>
          <option value="admin">🛡️ Administrador</option>
        </select>
        <select id="shareExpiry" class="form-input">
          <option value="never">Sin caducidad</option>
          <option value="1h">1 hora</option>
          <option value="1d">1 día</option>
          <option value="7d">7 días</option>
          <option value="30d">30 días</option>
        </select>
        <button class="small-btn user-create-btn" id="btnCreateShare">Crear acceso</button>
      </div>
    </div>

    <div id="shareCreatedBox" class="panel user-token-panel" style="display:none">
      <div class="user-token-title">🔐 ACCESO CREADO</div>
      <div class="user-token-sub">Este token se muestra una sola vez. Entrégaselo a la persona que va a usar el panel.</div>
      <div class="user-token-row">
        <code id="shareCreatedToken"></code>
        <button class="small-btn" id="btnCopyShareToken">Copiar</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title"><span>👥</span> USUARIOS CON ACCESO</div>
          <div class="user-panel-subtitle">Puedes revocar cualquier acceso inmediatamente.</div>
        </div>
        <button class="small-btn" id="btnRefreshUsers">↺ Actualizar</button>
      </div>
      <div id="shareTokenList"></div>
    </div>
  `;

  bindShareSettings();
  $('btnRefreshUsers')?.addEventListener('click', loadShareTokens);
}

function bindShareSettings(): void {
  if (panelPermission !== 'admin') return;

  $('btnCreateShare')?.addEventListener('click', async () => {
    const button = $btn('btnCreateShare');
    if (button) button.disabled = true;

    try {
      const rawData = await cloudApi('/api/share-tokens', {
        method: 'POST',
        body: JSON.stringify({
          label: $input('shareLabel')?.value || '',
          permission: $select('sharePermission')?.value || 'read',
          expires: $select('shareExpiry')?.value || 'never',
        }),
      });
      const data = isRecord(rawData) ? rawData : {};

      const token = typeof data['token'] === 'string' ? data['token'] : '';
      let copied = false;
      try {
        if (navigator.clipboard?.writeText && token) {
          await navigator.clipboard.writeText(token);
          copied = true;
        }
      } catch {}

      const tokenEl = $('shareCreatedToken');
      const boxEl = $('shareCreatedBox');
      const labelInput = $input('shareLabel');

      if (tokenEl) tokenEl.textContent = token;
      if (boxEl) boxEl.style.display = '';
      if (labelInput) labelInput.value = '';
      toast(
        copied
          ? 'Token creado y copiado al portapapeles.'
          : 'Token creado. Cópialo antes de cerrar esta pantalla.',
        'ok'
      );
      await loadShareTokens();
    } catch (error: unknown) {
      toast(getErrorMessage(error), 'err');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btnCopyShareToken')?.addEventListener('click', async event => {
    const token = $('shareCreatedToken')?.textContent || '';
    try {
      await navigator.clipboard.writeText(token);
      flashButton(event.currentTarget as HTMLElement | null, 'Copiado');
    } catch {
      toast('No se pudo copiar el token.', 'err');
    }
  });

  loadShareTokens();
}

/* ══════════════════════════════════════════════
   15. BACKUPS
   ══════════════════════════════════════════════ */

interface BackupSummaryItem {
  name?: string;
  date?: string;
  sizeMb?: string | number;
}

function isBackupSummaryItem(value: unknown): value is BackupSummaryItem {
  return isRecord(value) &&
    optionalField(value, 'name', isString) &&
    optionalField(value, 'date', isString) &&
    optionalField(value, 'sizeMb', isStringOrNumber);
}

async function loadBackups(options: SoftLoadOptions = {}): Promise<void> {
  const container = $('backupList');

  if (!container) return;

  const soft = resolveSoftLoad(options, container);
  if (!soft) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
        <div class="empty-msg">Cargando copias de seguridad...</div>
      </div>
    `;
  }

  const rawData = await cachedApi('backups', '/api/backups', undefined, VIEW_CACHE_TTL_MS, Boolean(options.force));
  const data = isRecord(rawData) ? rawData : {};

  if (!data['ok']) {
    container.innerHTML = `<div class="empty-state"><div class="empty-msg">${escHtml(data['error'])}</div></div>`;
    return;
  }

  const backups: BackupSummaryItem[] = isArrayOf(data['backups'], isBackupSummaryItem)
    ? data['backups']
    : [];
  const owner = isOwnerSession();

  container.innerHTML = backups.length
    ? backups
        .map(
          (backup: BackupSummaryItem) => `
        <div class="backup-row">
          <span class="bk-icon">🗄️</span>
          <span class="bk-name">
            ${escHtml(backup.name)}
            <small>${escHtml(backup.date)}</small>
          </span>
          <span class="bk-size">${escHtml(backup.sizeMb)} MB</span>
          <span class="bk-actions">
            <button class="icon-btn edit" data-download-backup="${escHtml(backup.name)}" title="Descargar">⬇️</button>
            <button class="icon-btn warn" data-restore-backup="${escHtml(backup.name)}"
              title="${owner ? 'Restaurar' : 'Solo el propietario'}"
              ${owner ? '' : 'disabled'}>♻️</button>
            <button class="icon-btn" data-delete-backup="${escHtml(backup.name)}" title="Eliminar">🗑️</button>
          </span>
        </div>
      `
        )
        .join('')
    : '<div class="empty-state"><div class="empty-msg">No hay copias de seguridad todavía.</div></div>';

  container.querySelectorAll('[data-download-backup]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', () =>
      downloadBackup(button.dataset['downloadBackup'] || '')
    );
  });

  container.querySelectorAll('[data-restore-backup]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', () =>
      restoreBackup(button.dataset['restoreBackup'] || '')
    );
  });

  container.querySelectorAll('[data-delete-backup]').forEach(buttonEl => {
    const button = buttonEl as HTMLElement;
    button.addEventListener('click', async () => {
      const name = button.dataset['deleteBackup'] || '';

      if (
        !confirm(
          `¿Eliminar la copia de seguridad "${name}"? Esta acción no se puede deshacer.`
        )
      ) {
        return;
      }

      const rawResult = await api(`/api/backups/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const result = isRecord(rawResult) ? rawResult : {};

      if (!result['ok']) {
        toast(`❌ ${result['error']}`, 'err');
        return;
      }

      toast('✅ Copia de seguridad eliminada', 'ok');
      invalidateViewCache('backups'); loadBackups({ soft: false });
    });
  });
}

const BACKUP_PROGRESS_POLL_MS = 500;

interface BackupProgressPayload {
  active?: boolean;
  phase?: string;
  percent?: number;
  processedBytes?: number;
  totalBytes?: number;
}

function isBackupProgressPayload(value: unknown): value is BackupProgressPayload {
  return isRecord(value) &&
    optionalField(value, 'active', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'phase', isString) &&
    optionalField(value, 'percent', isNumber) &&
    optionalField(value, 'processedBytes', isNumber) &&
    optionalField(value, 'totalBytes', isNumber);
}

interface BackupProgressUiState {
  label?: string;
  pct?: string;
  width?: number;
  state?: 'normal' | 'indeterminate' | 'done' | 'error';
}

function setBackupProgressUI({ label, pct, width, state }: BackupProgressUiState): void {
  const box = $('backupProgress');
  if (!box) return;

  if (state) {
    box.classList.remove('indeterminate', 'done', 'error');
    if (state !== 'normal') box.classList.add(state);
  }

  const labelEl = $('backupProgressLabel');
  if (label !== undefined && labelEl) labelEl.textContent = label;

  const pctEl = $('backupProgressPct');
  if (pct !== undefined && pctEl) pctEl.textContent = pct;

  if (width !== undefined) {
    const fillEl = $('backupProgressFill');
    if (fillEl) fillEl.style.width = `${width}%`;

    const barEl = $('backupProgressBar');
    if (barEl) barEl.setAttribute('aria-valuenow', String(Math.round(width)));
  }
}

function showBackupProgress(): void {
  const box = $('backupProgress');
  if (!box) return;

  box.hidden = false;
  setBackupProgressUI({
    label: 'Preparando la copia de seguridad…',
    pct: '—',
    width: 0,
    state: 'indeterminate',
  });
}

function hideBackupProgress(delay: number = 0): void {
  setTimeout(() => {
    const box = $('backupProgress');
    if (!box) return;

    box.hidden = true;
    box.classList.remove('indeterminate', 'done', 'error');
    const fillEl = $('backupProgressFill');
    if (fillEl) fillEl.style.width = '0%';
  }, delay);
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;

    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };

    timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function pollBackupProgress(signal?: AbortSignal): Promise<void> {
  try {
    const raw: unknown = await api('/api/backups/progress', signal ? { signal } : {});
    if (signal?.aborted || !isRecord(raw) || raw['ok'] !== true || !isBackupProgressPayload(raw['progress'])) return;

    const progress = raw['progress'];
    if (!progress.active) return;

    if (progress.phase === 'flush') {
      setBackupProgressUI({
        label: 'Sincronizando el mundo del servidor…',
        pct: '—',
        state: 'indeterminate',
      });
      return;
    }

    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const processedMb = ((Number(progress.processedBytes) || 0) / 1024 / 1024).toFixed(1);
    const totalMb = ((Number(progress.totalBytes) || 0) / 1024 / 1024).toFixed(1);

    setBackupProgressUI({
      label: `Comprimiendo archivos… (${processedMb} / ${totalMb} MB)`,
      pct: `${percent}%`,
      width: percent,
    });
  } catch {

  }
}

async function runBackupProgressPolling(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await pollBackupProgress(signal);
    if (signal.aborted) return;
    await waitForAbortableDelay(BACKUP_PROGRESS_POLL_MS, signal);
  }
}

async function createBackup(): Promise<void> {
  const name = prompt('Nombre para la copia de seguridad (opcional):', '');
  if (name === null) return;

  const button = $btn('btnNewBackup');

  if (button) {
    button.disabled = true;
    button.textContent = '⏳ Creando...';
  }

  showBackupProgress();

  const pollController = new AbortController();
  const pollTask = runBackupProgressPolling(pollController.signal);

  try {
    const raw: unknown = await postJSON('/api/backups', { name: name.trim() });
    const data = isRecord(raw) ? raw : {};

    if (!data['ok']) {
      const errMsg = typeof data['error'] === 'string' ? data['error'] : 'Error al crear la copia de seguridad.';
      setBackupProgressUI({ label: errMsg, pct: '✕', state: 'error' });
      hideBackupProgress(4000);
      toast(`❌ ${errMsg}`, 'err');
      return;
    }

    setBackupProgressUI({
      label: 'Copia completada',
      pct: '100%',
      width: 100,
      state: 'done',
    });
    hideBackupProgress(2500);

    const warningMsg = typeof data['warning'] === 'string' ? data['warning'] : '';
    const sizeMb = data['sizeMb'] ?? '?';
    toast(
      warningMsg
        ? `⚠️ ${warningMsg}`
        : `✅ Copia de seguridad creada (${String(sizeMb)} MB)`,
      warningMsg ? 'warn' : 'ok'
    );

    invalidateViewCache('backups');
    void loadBackups({ soft: false });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    setBackupProgressUI({ label: errMsg, pct: '✕', state: 'error' });
    hideBackupProgress(4000);
    toast(`❌ ${errMsg}`, 'err');
  } finally {
    pollController.abort();
    await pollTask;
    if (button) {
      button.disabled = false;
      button.textContent = '➕ Nueva copia';
    }
  }
}

async function downloadBackup(name: string): Promise<void> {
  return downloadUrlWithProgress(
    `/api/backups/download/${encodeURIComponent(name)}`,
    name,
    'Descargando copia de seguridad'
  );
}

async function restoreBackup(name: string): Promise<void> {
  if (!isOwnerSession()) {
    toast('🔒 Solo el propietario puede restaurar copias.', 'warn');
    return;
  }

  const typed = prompt(
    `⚠️ RESTAURAR "${name}"\n\n` +
    'Esto reemplazará TODOS los archivos actuales del servidor (mundos, plugins, configs).\n' +
    'Los directorios internos .moonwolf y .moonwolf-uploads NO se tocan.\n' +
    'Si el servidor está corriendo, se detendrá y se reiniciará automáticamente.\n\n' +
    'Escribe RESTAURAR en mayúsculas para confirmar:'
  );

  if (typed !== 'RESTAURAR') {
    if (typed !== null) toast('Restauración cancelada.', 'warn');
    return;
  }

  const button = document.querySelector<HTMLButtonElement>(`[data-restore-backup="${CSS.escape(name)}"]`);
  if (button) { button.disabled = true; }

  toast('⏳ Restaurando copia... el servidor puede tardar en reiniciar.', 'info');

  try {
    const raw: unknown = await postJSON(
      `/api/backups/${encodeURIComponent(name)}/restore`,
      {}
    );
    const data = isRecord(raw) ? raw : {};

    if (!data['ok']) {
      const errMsg = typeof data['error'] === 'string' ? data['error'] : 'No se pudo restaurar la copia.';
      throw new Error(errMsg);
    }

    const restartFailed = Boolean(data['restartFailed']);
    const wasRunning = Boolean(data['wasRunning']);
    toast(
      restartFailed
        ? '⚠️ Copia restaurada, pero Minecraft no pudo reiniciarse. Revisa la consola.'
        : wasRunning
          ? '✅ Copia restaurada. Minecraft se está iniciando.'
          : '✅ Copia restaurada.',
      restartFailed ? 'warn' : 'ok'
    );
    addActivity(`Copia restaurada: ${name}`, 'ok', '♻️');
    invalidateViewCache('backups');
    void loadBackups({ soft: false });
  } catch (error: unknown) {
    toast(`❌ ${error instanceof Error ? error.message : String(error)}`, 'err');
    if (button) { button.disabled = false; }
  }
}

/* ══════════════════════════════════════════════
   16. PUERTOS
   ══════════════════════════════════════════════ */

interface ServerPortInfo {
  port: number | string;
  name: string;
  description: string;
  protocol: string;
  state: 'open' | 'closed' | 'disabled' | string;
}

interface ServerPortsProperties {
  serverPort?: number;
  queryPort?: number;
  rconPort?: number;
  rconPassword?: string;
  hasRconPassword?: boolean;
  enableQuery?: boolean;
  enableRcon?: boolean;
}

function isServerPortInfo(value: unknown): value is ServerPortInfo {
  return isRecord(value) &&
    isStringOrNumber(value['port']) &&
    isString(value['name']) &&
    isString(value['description']) &&
    isString(value['protocol']) &&
    isString(value['state']);
}

function isServerPortsProperties(value: unknown): value is ServerPortsProperties {
  return isRecord(value) &&
    optionalField(value, 'serverPort', isNumber) &&
    optionalField(value, 'queryPort', isNumber) &&
    optionalField(value, 'rconPort', isNumber) &&
    optionalField(value, 'rconPassword', isString) &&
    optionalField(value, 'hasRconPassword', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'enableQuery', (item): item is boolean => typeof item === 'boolean') &&
    optionalField(value, 'enableRcon', (item): item is boolean => typeof item === 'boolean');
}

async function loadPorts(options: SoftLoadOptions = {}): Promise<void> {
  const element = $('portList');
  if (!element) return;

  const soft = resolveSoftLoad(options, element);
  if (!soft) {
    element.innerHTML =
    '<div class="empty-state"><div style="animation:spin 1s linear infinite;font-size:28px">⟳</div><div class="empty-msg">Comprobando puertos...</div></div>';
  }

  try {
    const raw: unknown = await cachedApi('ports', '/api/ports', undefined, 20_000, Boolean(options.force));
    if (!isRecord(raw) || !raw['ok']) {
      const errMsg = isRecord(raw) && typeof raw['error'] === 'string'
        ? raw['error']
        : 'No se pudieron cargar los puertos';
      throw new Error(errMsg);
    }

    const props: ServerPortsProperties = isServerPortsProperties(raw['properties'])
      ? raw['properties']
      : {};
    const ports: ServerPortInfo[] = isArrayOf(raw['ports'], isServerPortInfo)
      ? raw['ports']
      : [];

    element.innerHTML = `
      <div class="ports-toolbar">
        <div>
          <div class="panel-title"><span>🔌</span> PUERTOS DEL SERVIDOR</div>
          <div class="port-toolbar-sub">Configura los puertos de Minecraft, Query y RCON. Los cambios requieren reiniciar el servidor.</div>
        </div>
        <button class="small-btn" id="btnRefreshPorts">↺ Comprobar</button>
      </div>

      <div class="ports-grid">
        ${ports
          .map(
            (port: ServerPortInfo) => `
          <div class="port-row">
            <div class="port-num">${escHtml(port.port)}</div>
            <div class="port-info">
              <div class="port-name">${escHtml(port.name)}</div>
              <div class="port-desc">${escHtml(port.description)}</div>
            </div>
            <span class="port-proto">${escHtml(port.protocol)}</span>
            <span class="port-state ${escHtml(port.state)}">
              ${
                port.state === 'open'
                  ? '● ABIERTO'
                  : port.state === 'closed'
                    ? '● CERRADO'
                    : port.state === 'disabled'
                      ? '● DESACTIVADO'
                      : '● CONFIGURADO'
              }
            </span>
          </div>
        `
          )
          .join('')}
      </div>

      <div class="panel ports-config-panel">
        <div class="panel-header">
          <div>
            <div class="panel-title"><span>⚙️</span> CONFIGURACIÓN</div>
            <div class="port-toolbar-sub">Los valores se escriben directamente en server.properties.</div>
          </div>
        </div>

        <div class="ports-form">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Puerto de Minecraft</label>
              <input id="portMinecraft" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.serverPort ?? 25565)}">
            </div>
            <div class="form-group">
              <label class="form-label">Puerto Query</label>
              <input id="portQuery" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.queryPort ?? 25565)}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Puerto RCON</label>
              <input id="portRcon" class="form-input" type="number" min="1" max="65535" value="${escHtml(props.rconPort ?? 25575)}">
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña RCON</label>
              <input id="portRconPassword" class="form-input" type="password" placeholder="${props.hasRconPassword ? 'Dejar vacío para conservarla' : 'Contraseña nueva'}" autocomplete="new-password">
            </div>
          </div>

          <div class="startup-toggles">
            <label class="startup-toggle" for="portEnableQuery">
              <div class="startup-toggle-icon">📡</div>
              <div class="startup-toggle-info">
                <div class="startup-toggle-title">Game Query</div>
                <div class="startup-toggle-desc">Permite consultar información del servidor mediante el protocolo Query (jugadores, MOTD...).</div>
              </div>
              <span class="toggle">
                <input type="checkbox" id="portEnableQuery" ${props.enableQuery ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
            </label>

            <label class="startup-toggle" for="portEnableRcon">
              <div class="startup-toggle-icon">🎛️</div>
              <div class="startup-toggle-info">
                <div class="startup-toggle-title">RCON</div>
                <div class="startup-toggle-desc">Consola remota. Usa una contraseña fuerte y no expongas este puerto innecesariamente a Internet.</div>
              </div>
              <span class="toggle">
                <input type="checkbox" id="portEnableRcon" ${props.enableRcon ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
            </label>
          </div>

          <button class="save-btn" id="btnSavePorts">💾 GUARDAR PUERTOS</button>
        </div>
      </div>
    `;

    $('btnRefreshPorts')?.addEventListener('click', () => { void loadPorts({ force: true }); });
    $('btnSavePorts')?.addEventListener('click', () => { void savePorts(); });
  } catch (error: unknown) {
    element.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-msg">${escHtml((error instanceof Error ? error.message : String(error)))}</div><button class="small-btn" id="btnRetryPorts">↺ Reintentar</button></div>`;
    $('btnRetryPorts')?.addEventListener('click', () => { void loadPorts({ force: true }); });
  }
}

async function savePorts(): Promise<void> {
  const body: ServerPortsProperties = {
    serverPort: Number($input('portMinecraft')?.value),
    queryPort: Number($input('portQuery')?.value),
    rconPort: Number($input('portRcon')?.value),
    enableQuery: Boolean($input('portEnableQuery')?.checked),
    enableRcon: Boolean($input('portEnableRcon')?.checked),
    rconPassword: $input('portRconPassword')?.value || '',
  };

  const button = $btn('btnSavePorts');
  if (button) {
    button.disabled = true;
    button.textContent = 'GUARDANDO...';
  }

  try {
    const raw: unknown = await postJSON('/api/ports', body);
    const data = isRecord(raw) ? raw : {};
    if (!data['ok']) {
      toast(`❌ ${String(data['error'] || 'Error al guardar puertos')}`, 'err');
      return;
    }

    toast('✅ Puertos guardados. Reinicia el servidor para aplicar los cambios.', 'ok');
    addActivity('Configuración de puertos actualizada', 'ok', '🔌');
    await loadPorts({ force: true });
  } catch (error: unknown) {
    toast((error instanceof Error ? error.message : String(error)), 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '💾 GUARDAR PUERTOS';
    }
  }
}

/* ══════════════════════════════════════════════
   17. STARTUP
   ══════════════════════════════════════════════ */

function requiredJavaLabel(version: string): string {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 'Java se seleccionará automáticamente';

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  let java = null;

  if (major >= 26) java = 25;
  else if (major === 1) {
    if (minor <= 11) java = 8;
    else if (minor >= 12 && minor <= 15) java = 11;
    else if (minor === 16) java = patch >= 5 ? 16 : 11;
    else if (minor >= 17 && minor <= 19) java = 17;
    else if (minor >= 20 && minor <= 21) java = 21;
  }

  return java ? `Java ${java} · gestionado por MoonWolf` : 'Versión no reconocida';
}

async function loadStartup(options: SoftLoadOptions = {}): Promise<void> {
  const element = $('startupList');

  if (!element) return;

  const soft = resolveSoftLoad(options, element);
  if (!soft) {
    element.innerHTML = `
    <div class="empty-state">
      <div style="animation:spin 1s linear infinite;font-size:28px">⟳</div>
      <div class="empty-msg">Cargando configuración...</div>
    </div>
  `;
  }

  const rawStartup = await cachedApi(
    'startup',
    '/api/startup',
    undefined,
    VIEW_CACHE_TTL_MS,
    Boolean(options.force),
  );
  if (!isStartupResponse(rawStartup)) {
    element.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">Respuesta de arranque no válida</div>
      </div>
    `;
    return;
  }
  const data = rawStartup;

  if (!data.ok) {
    element.innerHTML = `
      <div class="empty-state">
        <div class="empty-msg">${escHtml(data.error)}</div>
      </div>
    `;

    return;
  }

  const cfg: StartupConfig = data.config || {};
  const jars: string[] = Array.isArray(data.jars) ? data.jars : [];
  const hasCurrentJar = jars.includes(String(cfg.jar || ''));
  const port = data.serverPort;
  const owner = isOwnerSession();

  element.innerHTML = `
    <div class="startup-form">

      <div class="form-group">
        <label class="form-label">Archivo .jar del servidor</label>
        ${
          jars.length
            ? `
              <select id="stJar" class="form-select">
                ${jars
                  .map(
                    jar => `
                  <option value="${escHtml(jar)}" ${jar === cfg.jar ? 'selected' : ''}>${escHtml(jar)}</option>
                `
                  )
                  .join('')}
              </select>
              <div class="form-hint">
                Se lanzará este archivo al pulsar ARRANCAR.
                ${!hasCurrentJar ? ` El configurado actualmente ("${escHtml(cfg.jar)}") no está en la carpeta — elige uno de la lista y guarda.` : ''}
              </div>
            `
            : `
              <div class="form-hint" style="color:var(--red)">
                No se encontró ningún .jar en la carpeta del servidor. Sube uno desde Archivos o instala uno desde Versiones.
              </div>
            `
        }
      </div>

      <div class="form-group">
        <label class="form-label">Versión de Minecraft</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="stMinecraftVersion" class="form-input" type="text" placeholder="Se detecta sola si dejas vacío" value="${escHtml(cfg.minecraftVersion || '')}" style="flex:1;min-width:160px">
          <button type="button" class="small-btn" id="btnDetectMcVersion" title="Detectar desde el JAR seleccionado">🔍 Detectar</button>
        </div>
        <div class="form-hint" id="stVersionHint">
          ${
            data.versionDetection?.autoDetected
              ? `Detectada automáticamente (${escHtml(data.versionDetection.source || 'jar')}): <strong>${escHtml(cfg.minecraftVersion || '')}</strong>. MoonWolf la usa para elegir el Java compatible.`
              : 'MoonWolf detecta la versión del JAR (nombre o contenido) y desde la consola al arrancar. Si dejas el campo vacío se rellena sola.'
          }
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">
          Java
          ${owner ? '' : '<span class="owner-lock">🔒 Solo el propietario</span>'}
        </label>
        <div class="startup-java-card">
          <span style="font-size:18px">☕</span>
          <div style="flex:1;min-width:220px">
            <div style="font-weight:700" id="stJavaManagedLabel">
              ${
                data.javaRuntime?.javaMajor
                  ? `Java ${escHtml(data.javaRuntime.javaMajor)} ${data.javaRuntime.installed ? '✓ instalado' : '↓ se descargará automáticamente'}`
                  : 'Java se seleccionará automáticamente'
              }
            </div>
            <div class="form-hint" style="margin-top:3px">
              ${
                data.javaRuntime?.javaMajor
                  ? `Runtime gestionado por MoonWolf · ${data.javaRuntime.installed ? 'listo para usar' : 'se instalará al arrancar'}`
                  : 'Indica una versión de Minecraft válida para calcular el runtime.'
              }
            </div>
          </div>
        </div>

        <div style="margin-top:10px">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
            <input id="stJavaOverride" type="checkbox"
              ${cfg.javaMode === 'override' ? 'checked' : ''}
              ${owner ? '' : 'disabled'}>
            Usar un Java personalizado (avanzado)
          </label>
          <input id="stJavaOverridePath" class="form-input" type="text"
            style="margin-top:8px;display:${cfg.javaMode === 'override' ? 'block' : 'none'}"
            placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
            value="${escHtml(cfg.javaOverridePath || cfg.javaPath || '')}"
            ${owner ? '' : 'readonly'}>
          <div class="form-hint">
            Normalmente no necesitas tocar esto.
            ${owner ? '' : ' Solo el propietario puede modificar la ruta de Java.'}
          </div>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Memoria mínima (MB)</label>
          <input id="stMinMem" class="form-input" type="number" min="256" step="256" value="${escHtml(cfg.minMemoryMb ?? 1024)}">
        </div>
        <div class="form-group">
          <label class="form-label">Memoria máxima (MB)</label>
          <input id="stMaxMem" class="form-input" type="number" min="256" step="256" value="${escHtml(cfg.maxMemoryMb ?? 2048)}">
        </div>
      </div>

      <div class="form-group">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <label class="form-label" style="margin-bottom:0">
            Argumentos JVM extra (antes de "-jar")
            ${owner ? '' : '<span class="owner-lock">🔒 Solo el propietario</span>'}
          </label>
          ${
            owner
              ? `<button type="button" class="small-btn" id="btnAikarFlags" style="font-size:10px;padding:4px 9px;flex-shrink:0">⚡ Usar Aikar's Flags</button>`
              : ''
          }
        </div>
        <input id="stArgs" class="form-input" type="text"
          placeholder="-XX:+UseG1GC"
          value="${escHtml(cfg.extraArgs || '')}"
          ${owner ? '' : 'readonly'}>
        <div class="form-hint">
          Flags de la JVM (recolector de basura, memoria avanzada...). Se insertan justo antes de "-jar".
          ${owner
            ? ' Los flags que cargan código (javaagent, agentlib, OnError...) están bloqueados por seguridad.'
            : ' Solo el propietario puede modificarlos.'}
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Puerto del servidor</label>
          <input id="stPort" class="form-input" type="number" min="1" max="65535" placeholder="25565" value="${port ?? ''}">
          <div class="form-hint">Se guarda como server-port en server.properties.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Comando de parada</label>
          <input id="stStopCmd" class="form-input" type="text" placeholder="stop" value="${escHtml(cfg.stopCommand || 'stop')}">
        </div>
      </div>

      <div class="startup-toggles">
        <label class="startup-toggle" for="stAutoRestart">
          <div class="startup-toggle-icon">🔄</div>
          <div class="startup-toggle-info">
            <div class="startup-toggle-title">Reinicio automático si se cae</div>
            <div class="startup-toggle-desc">Relanza el servidor si el proceso termina de forma inesperada. No cuenta si pulsas DETENER.</div>
          </div>
          <span class="toggle">
            <input type="checkbox" id="stAutoRestart" ${cfg.autoRestartOnCrash ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>

        <label class="startup-toggle" for="stAutoStart">
          <div class="startup-toggle-icon">🚀</div>
          <div class="startup-toggle-info">
            <div class="startup-toggle-title">Arranque automático</div>
            <div class="startup-toggle-desc">Inicia el servidor en cuanto MoonWolf Panel/Agent se ponga en marcha.</div>
          </div>
          <span class="toggle">
            <input type="checkbox" id="stAutoStart" ${cfg.autoStartOnBoot ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>
      </div>

      <button class="save-btn" id="btnSaveStartup" ${jars.length ? '' : 'disabled'}>💾 GUARDAR</button>
    </div>
  `;

  $('btnSaveStartup')?.addEventListener('click', saveStartup);

  $('btnDetectMcVersion')?.addEventListener('click', async () => {
    const btn = $btn('btnDetectMcVersion') || $('btnDetectMcVersion');
    const jarEl = $select('stJar') || $input('stJar');
    const jar = jarEl && 'value' in jarEl ? jarEl.value : '';
    if (btn && 'disabled' in btn) {
      (btn as HTMLButtonElement).disabled = true;
      btn.textContent = '⟳ Detectando…';
    }
    try {
      const rawData = await api('/api/startup/detect-version', {
        method: 'POST',

        body: { jar: jar || undefined, force: true, persist: true },
      });
      if (!isVersionDetectionResponse(rawData)) {
        throw new Error('Respuesta de detección de versión no válida.');
      }
      const data = rawData;
      if (data.ok === false && data.error) throw new Error(data.error);
      const version = data.version || '';
      const input = $input('stMinecraftVersion');
      if (input) input.value = version;
      const hint = $('stVersionHint');
      if (hint) {
        hint.innerHTML = version
          ? `Detectada (${escHtml(data.source || 'jar')}): <strong>${escHtml(version)}</strong>. Se ha guardado automáticamente.`
          : 'No se pudo detectar la versión en el JAR. Puedes escribirla a mano.';
      }
      const label = $('stJavaManagedLabel');
      if (label) label.textContent = requiredJavaLabel(version);
      toast(
        version
          ? `🔍 Versión detectada: ${version}`
          : 'No se encontró versión en el JAR',
        version ? 'ok' : 'err'
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? (error instanceof Error ? error.message : String(error)) : String(error);
      toast(`❌ ${message}`, 'err');
    } finally {
      if (btn && 'disabled' in btn) {
        (btn as HTMLButtonElement).disabled = false;
        btn.textContent = '🔍 Detectar';
      }
    }
  });

  $input('stJavaOverride')?.addEventListener('change', event => {
    const input = $input('stJavaOverridePath');
    const target = event.target as HTMLInputElement | null;
    if (input && target) {
      input.style.display = target.checked ? 'block' : 'none';
    }
  });

  $input('stMinecraftVersion')?.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    const version = target.value.trim();
    const runtime = requiredJavaLabel(version);
    const label = $('stJavaManagedLabel');
    if (label) label.textContent = runtime;
  });

  $('btnAikarFlags')?.addEventListener('click', () => {
    const input = $input('stArgs');
    if (!input) return;
    input.value = AIKAR_FLAGS;
    toast('⚡ Flags de Aikar aplicados — recuerda GUARDAR', 'ok');
  });
}

async function saveStartup() {
  const jarSelect = $select('stJar') || $input('stJar');

  if (!jarSelect || !('value' in jarSelect) || !jarSelect.value) {
    toast('❌ No hay ningún .jar seleccionable', 'err');
    return;
  }

  const portValue = $input('stPort')?.value.trim();
  const owner = isOwnerSession();

  const body: StartupConfig = {
    jar: jarSelect.value,
    minecraftVersion: $input('stMinecraftVersion')?.value.trim() || '',
    minMemoryMb: Number($input('stMinMem')?.value) || 1024,
    maxMemoryMb: Number($input('stMaxMem')?.value) || 2048,
    stopCommand: $input('stStopCmd')?.value.trim() || 'stop',
    autoRestartOnCrash: Boolean($input('stAutoRestart')?.checked),
    autoStartOnBoot: Boolean($input('stAutoStart')?.checked),
    ...(portValue ? { serverPort: Number(portValue) } : {}),
  };

  if (owner) {
    body.javaPath = $input('stJavaOverridePath')?.value.trim() || '';
    body.javaMode = Boolean($input('stJavaOverride')?.checked) ? 'override' : 'managed';
    body.javaOverridePath = $input('stJavaOverride')?.checked
      ? ($input('stJavaOverridePath')?.value.trim() || '')
      : '';
    body.extraArgs = $input('stArgs')?.value.trim() || '';
  }

  const button = $btn('btnSaveStartup') || $('btnSaveStartup');

  if (button && 'disabled' in button) {
    (button as HTMLButtonElement).disabled = true;
    button.textContent = 'GUARDANDO...';
  }

  const rawSave = await postJSON('/api/startup', body);
  if (!isRecord(rawSave)) {
    toast('❌ Respuesta no válida', 'err');
    return;
  }
  const data: ApiResult = {
    ok: rawSave['ok'] === true,
    ...(typeof rawSave['error'] === 'string' ? { error: rawSave['error'] } : {}),
  };

  if (button && 'disabled' in button) {
    (button as HTMLButtonElement).disabled = false;
    button.textContent = '💾 GUARDAR';
  }

  if (!data.ok) {
    toast(`❌ ${data.error}`, 'err');
    return;
  }

  toast('✅ Configuración de arranque guardada', 'ok');
  loadStartup({ force: true });
}

/* ══════════════════════════════════════════════
   18. AJUSTES
   ══════════════════════════════════════════════ */

function renderSettings() {
  const element = $('settingsList');

  if (!element) return;

  const cloudConnected = Boolean(cloudSocket?.connected);

  let cloudCls, cloudText;
  if (cloudConnecting) {
    cloudCls = 'connecting'; cloudText = '● CONECTANDO...';
  } else if (cloudConnected) {
    cloudCls = 'online';     cloudText = '● ONLINE';
  } else {
    cloudCls = 'offline';    cloudText = '● OFFLINE';
  }

  let agentCls, agentText;
  if (cloudConnecting) {
    agentCls = 'connecting'; agentText = '● CONECTANDO...';
  } else if (cloudConnected && agentOnline) {
    agentCls = 'online';     agentText = '● CONECTADO';
  } else {
    agentCls = 'offline';    agentText = '● DESCONECTADO';
  }

  element.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-icon">☁️</div>
        <div class="settings-group-info">
          <div class="settings-group-title">MoonWolf Cloud</div>
          <div class="settings-group-sub">Conexión WebSocket con el panel remoto</div>
        </div>
        <span class="settings-status ${cloudCls}">${cloudText}</span>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-icon">🛰️</div>
        <div class="settings-group-info">
          <div class="settings-group-title">MoonWolf Agent</div>
          <div class="settings-group-sub">Identificador único de esta instalación</div>
        </div>
        <span class="settings-status ${agentCls}">${agentText}</span>
      </div>
      <div class="settings-group-body">
        <div class="settings-field">
          <code class="settings-field-value" title="${escHtml(agentId || '—')}">${escHtml(agentId || '—')}</code>
          <button class="small-btn" id="btnCopyAgentId">Copiar</button>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">
        <div class="settings-group-icon">⚡</div>
        <div class="settings-group-info">
          <div class="settings-group-title">Canal directo</div>
          <div class="settings-group-sub">Transferencias de archivos por WebRTC (si falla, se usa Cloud)</div>
        </div>
        <span class="settings-status ${directReady() ? 'online' : 'connecting'}">${directReady() ? '● DIRECTO' : '● ESPERANDO'}</span>
      </div>
    </div>

    <div class="settings-danger">
      <div class="settings-danger-info">
        <div class="settings-danger-title">⚠️ Desconectar del Cloud</div>
        <div class="settings-danger-sub">
          Cerrará la sesión actual del panel. Necesitarás un nuevo código de emparejamiento para reconectar.
        </div>
      </div>
      <button class="settings-danger-btn" id="btnDisconnectCloud">Desconectar</button>
    </div>
  `;

  $('btnCopyAgentId')?.addEventListener('click', async event => {
    if (!agentId) return;

    try {
      await navigator.clipboard.writeText(agentId);
      flashButton(event.currentTarget as HTMLElement | null, 'Copiado');
    } catch {
      toast('No se pudo copiar.', 'err');
    }
  });

  $('btnDisconnectCloud')?.addEventListener('click', () => {
    cloudSocket?.disconnect();
    setAgentOnline(false);
    currentStatus = 'offline';
    updateStatusUi('offline');
    clearSession();
    showLogin('Desconectado.');
  });
}

/* ══════════════════════════════════════════════
   19. REGISTRO DE ACTIVIDAD
   ══════════════════════════════════════════════ */

function addActivity(message: string, level: string = 'info', icon: string = '📌'): void {
  activities.push({
    message,
    level,
    icon,
    time: new Date().toLocaleTimeString('es-ES'),
  });

  if (activities.length > 200) {
    activities.shift();
  }

  if ($('view-activitylog')?.classList.contains('active')) {
    renderActivity();
  }
}

function renderActivity() {
  const element = $('activityList');

  if (!element) return;

  if (!activities.length) {
    element.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-msg">No hay actividad todavía</div>
      </div>
    `;
    return;
  }

  const counts = activities.reduce<Record<string, number>>((acc, item) => {
    const level = String(item.level || 'info');
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  const toolbar = `
    <div class="activity-toolbar">
      <div class="activity-counter">
        <span class="activity-counter-num">${activities.length}</span>
        <span class="activity-counter-label">eventos</span>
      </div>
      <div class="activity-filters">
        ${counts.info  ? `<span class="activity-filter info">${counts.info} info</span>` : ''}
        ${counts.ok    ? `<span class="activity-filter ok">${counts.ok} ok</span>` : ''}
        ${counts.warn  ? `<span class="activity-filter warn">${counts.warn} aviso</span>` : ''}
        ${counts.error ? `<span class="activity-filter error">${counts.error} error</span>` : ''}
      </div>
    </div>
  `;

  const items = activities
    .slice()
    .reverse()
    .map(item => {
      const level = String(item.level || 'info').toLowerCase();
      const safeLevel = ['info', 'ok', 'warn', 'error'].includes(level) ? level : 'info';
      const label = { info: 'INFO', ok: 'OK', warn: 'AVISO', error: 'ERROR' }[safeLevel];

      return `
        <div class="activity-item ${safeLevel}">
          <div class="activity-icon">${escHtml(item.icon || '📌')}</div>
          <div class="activity-body">
            <div class="activity-msg">${escHtml(item.message)}</div>
            <div class="activity-time">${escHtml(item.time || '--:--:--')}</div>
          </div>
          <span class="activity-badge ${safeLevel}">${label}</span>
        </div>
      `;
    })
    .join('');

  element.innerHTML = toolbar + `<div class="activity-feed">${items}</div>`;
}

/* ══════════════════════════════════════════════
   20. NAVEGACIÓN (switchView)
   ══════════════════════════════════════════════ */

function prefetchView(id: string | undefined): void {
  if (!agentOnline || !id) return;

  switch (id) {
    case 'files':
      cachedApi(`files:${currentDir || ''}`, `/api/files?dir=${encodeURIComponent(currentDir || '')}`, undefined, 15_000);
      break;
    case 'versions':
      cachedApi('versions:software', '/api/versions/software');
      cachedApi('startup', '/api/startup');
      break;
    case 'plugins':
      cachedApi('plugins:installed', '/api/plugins/installed');
      break;
    case 'databases':
      cachedApi('databases:status', '/api/databases/status', undefined, 15_000);
      cachedApi('databases', '/api/databases');
      break;
    case 'backups':
      cachedApi('backups', '/api/backups');
      break;
    case 'ports':
      cachedApi('ports', '/api/ports', undefined, 20_000);
      break;
    case 'startup':
      cachedApi('startup', '/api/startup');
      break;
    default:
      break;
  }
}

function switchView(id: string): void {
  const editorOpen = Boolean(currentFile && $('filesEditorPanel')?.style.display !== 'none');
  if (editorOpen && id !== 'files' && !closeFileEditor()) return;
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(item => item.classList.remove('active'));

  $(`view-${id}`)?.classList.add('active');

  document
    .querySelector(`.sb-item[data-view="${id}"]`)
    ?.classList.add('active');

  switch (id) {
    case 'files':
      populateFiles(currentDir, { soft: true });
      break;

    case 'versions':
      loadVersionState({ soft: true }).catch(error => toast(error.message, 'err'));
      break;

    case 'plugins':
      loadInstalledPlugins({ soft: true });
      break;

    case 'databases':
      loadDatabases({ soft: true });
      break;

    case 'users':
      renderUsers();
      break;

    case 'backups':
      loadBackups({ soft: true });
      break;

    case 'ports':
      loadPorts({ soft: true });
      break;

    case 'startup':
      loadStartup({ soft: true });
      break;

    case 'activitylog':
      renderActivity();
      break;

    case 'settings':
      renderSettings();
      break;
  }
}

/* ══════════════════════════════════════════════
   21. TOAST Y HELPERS UI
   ══════════════════════════════════════════════ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(message: unknown, type: string = 'info'): void {
  const element = $('toast');

  if (!element) return;

  element.textContent = String(message);
  element.className = `toast show ${type}`;

  if (toastTimer !== null) clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    element.className = 'toast';
    toastTimer = null;
  }, 3000);
}

function flashButton(
  button: HTMLButtonElement | HTMLElement | null | undefined,
  label: string,
  duration: number = 1200,
): void {
  if (!button) return;

  const original = button.textContent;
  button.textContent = label;
  if ('disabled' in button) {
    (button as HTMLButtonElement).disabled = true;
  }

  setTimeout(() => {
    button.textContent = original;
    if ('disabled' in button) {
      (button as HTMLButtonElement).disabled = false;
    }
  }, duration);
}

/* ══════════════════════════════════════════════
   22. EVENTOS E INICIALIZACIÓN
   ══════════════════════════════════════════════ */

function bindEvents() {
  ensureLoginGate();

  const sidebar = document.querySelector('.sidebar');
  if (sidebar instanceof HTMLElement) {
    sidebar.addEventListener('click', event => {
      const item = event.target instanceof Element
        ? event.target.closest('.sb-item')
        : null;
      if (!(item instanceof HTMLElement) || !sidebar.contains(item)) return;
      const view = item.dataset.view;
      if (view) switchView(view);
    });
    sidebar.addEventListener('mouseover', event => {
      const item = event.target instanceof Element
        ? event.target.closest('.sb-item')
        : null;
      if (item instanceof HTMLElement && sidebar.contains(item)) {
        prefetchView(item.dataset.view);
      }
    });
    sidebar.addEventListener('focusin', event => {
      const item = event.target instanceof Element
        ? event.target.closest('.sb-item')
        : null;
      if (item instanceof HTMLElement && sidebar.contains(item)) {
        prefetchView(item.dataset.view);
      }
    });
  }

  $('btnStart')?.addEventListener('click', startServer);
  $('btnStop')?.addEventListener('click', stopServer);
  $('btnRestart')?.addEventListener('click', restartServer);
  $('btnSendCmd')?.addEventListener('click', sendCmd);

  $('cmdInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendCmd();
    }
  });

  document.querySelectorAll('.quick-btn').forEach(button => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLElement)) return;
      const input = $('cmdInput') as HTMLInputElement | null;
      if (!input) return;
      input.value = button.dataset.cmd || '';
      void sendCmd();
    });
  });

  $('btnClearConsole')?.addEventListener('click', () => {
    const consoleEl = $('console');
    if (consoleEl) {
      consoleEl.innerHTML = '';
      pendingConsoleLogs.length = 0;
    }
  });

  $('crumbHome')?.addEventListener('click', () => populateFiles(''));

  const uploadMenu = $('uploadMenu');
  const uploadMenuList = $('uploadMenuList');
  const uploadMenuTrigger = $('btnUpload');
  const closeUploadMenu = () => {
    if (!uploadMenuList || uploadMenuList.hidden) return;
    uploadMenuList.hidden = true;
    uploadMenuTrigger?.setAttribute('aria-expanded', 'false');
  };
  const openUploadMenu = () => {
    if (!uploadMenuList) return;
    uploadMenuList.hidden = false;
    uploadMenuTrigger?.setAttribute('aria-expanded', 'true');
  };
  uploadMenuTrigger?.addEventListener('click', event => {
    event.stopPropagation();
    if (uploadMenuList?.hidden) openUploadMenu();
    else closeUploadMenu();
  });
  uploadMenu?.querySelectorAll('[data-upload-mode]').forEach(item => {
    item.addEventListener('click', () => {
      if (!(item instanceof HTMLElement)) return;
      const mode = item.dataset.uploadMode;
      closeUploadMenu();
      if (mode === 'folder') $('folderUploadInput')?.click();
      else $('fileUploadInput')?.click();
    });
  });
  document.addEventListener('click', event => {
    const target = event.target;
    if (uploadMenu && target instanceof Node && !uploadMenu.contains(target)) {
      closeUploadMenu();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeUploadMenu();
  });

  $('fileUploadInput')?.addEventListener('change', async event => {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    await uploadSelectedFiles(input.files);
    input.value = '';
  });

  $('folderUploadInput')?.addEventListener('change', async event => {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    await uploadSelectedFiles(input.files);
    input.value = '';
  });

  $('selectAllFiles')?.addEventListener('change', event => {
    const source = event.target as HTMLInputElement | null;
    if (!source) return;
    document.querySelectorAll('#fileList .file-row').forEach(row => {
      if (!(row instanceof HTMLElement)) return;
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!(checkbox instanceof HTMLInputElement)) return;
      checkbox.checked = source.checked;
      const path = row.dataset.path;
      if (!path) return;
      const rowType = row.dataset.type;
      setFileSelection(path, rowType === 'dir', checkbox.checked);
    });
    updateBulkBar();
  });

  document.querySelectorAll('[data-bulk-action]').forEach(button => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLElement)) return;
      runBulkAction(button.dataset.bulkAction);
    });
  });

  const filesView = $('view-files');
  const filesLayout = filesView?.querySelector('.files-layout');
  if (filesView && filesLayout) {
    ['dragenter', 'dragover'].forEach(type => {
      filesView.addEventListener(type, event => {
        const dragEvent = event as DragEvent;
        dragEvent.preventDefault();
        if (dragEvent.dataTransfer) {
          dragEvent.dataTransfer.dropEffect = 'copy';
        }
        filesLayout.classList.add('is-dragging');
      });
    });
    filesView.addEventListener('dragleave', event => {
      const related = (event as DragEvent).relatedTarget;
      if (!(related instanceof Node) || !filesView.contains(related)) {
        filesLayout.classList.remove('is-dragging');
      }
    });
    filesView.addEventListener('drop', async event => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      filesLayout.classList.remove('is-dragging');
      const files = await getFilesFromDataTransfer(dragEvent.dataTransfer);
      if (files?.length) await uploadSelectedFiles(files);
    });
  }

  const uploadProgressPause = $('uploadProgressPause') as HTMLButtonElement | null;
  uploadProgressPause?.addEventListener('click', () => {
    const upload = activeUploadState;
    if (!upload || upload.finished) return;
    upload.paused = !upload.paused;
    if (upload.paused) {
      upload.status = 'Subida pausada';
      if (uploadProgressPause) uploadProgressPause.textContent = '▶ Reanudar';
      updateUploadProgress(upload);
    } else {
      const done = Number(upload.completedFiles ?? 0);
      const total = Number(upload.totalFiles ?? 0);
      upload.status = `Subiendo ${done + 1}/${total}`;
      if (uploadProgressPause) uploadProgressPause.textContent = 'Ⅱ Pausar';
      const resume = upload.resumeUpload;
      if (typeof resume === 'function') resume();
      upload.resumeUpload = null;
      updateUploadProgress(upload);
    }
  });

  const uploadProgressCancel = $('uploadProgressCancel') as HTMLButtonElement | null;
  uploadProgressCancel?.addEventListener('click', () => {
    if (activeDownloadAbort) {
      activeDownloadAbort.abort();
      activeDownloadAbort = null;
      if (uploadProgressCancel) uploadProgressCancel.disabled = true;
      const title = $('uploadProgressTitle');
      if (title) title.textContent = 'Cancelando descarga…';
      return;
    }
    const upload = activeUploadState;
    if (!upload || upload.finished) return;
    upload.cancelled = true;
    const resume = upload.resumeUpload;
    if (typeof resume === 'function') resume();
    upload.resumeUpload = null;
    if (uploadProgressCancel) uploadProgressCancel.disabled = true;
    const pauseBtn = $('uploadProgressPause') as HTMLButtonElement | null;
    if (pauseBtn) pauseBtn.disabled = true;
    const title = $('uploadProgressTitle');
    if (title) title.textContent = 'Cancelando subida…';
    const panel = $('uploadProgressPanel');
    if (panel) panel.hidden = true;
  });

  const uploadProgressRetry = $('uploadProgressRetry') as HTMLButtonElement | null;
  uploadProgressRetry?.addEventListener('click', async () => {
    const files = lastUploadFiles.slice();
    if (!files.length) return;
    if (uploadProgressRetry) uploadProgressRetry.hidden = true;
    await uploadSelectedFiles(files);
  });

  $('fileConflictModal')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const cancelBtn = $('fileConflictModal')?.querySelector('[data-conflict-choice="cancel"]');
      if (cancelBtn instanceof HTMLElement) cancelBtn.click();
    }
  });

  $('btnNewFile')?.addEventListener('click', async () => {
    const raw = prompt('Nombre del nuevo archivo (termina en "/" para carpeta):');
    if (!raw) return;

    const trimmed = raw.trim();
    if (!trimmed) return;

    const isDir = trimmed.endsWith('/');
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    if (!name) return;

    const rawCreate: unknown = await postJSON('/api/files/create', {
      path: currentDir,
      name,
      isDir,
    });
    const data = isRecord(rawCreate) ? rawCreate : {};

    if (!data['ok']) {
      toast(`❌ ${String(data['error'] || 'Error al crear el archivo')}`, 'err');
      return;
    }

    toast('✅ Creado correctamente', 'ok');
    populateFiles(currentDir);
  });

  $('btnEditorBack')?.addEventListener('click', closeFileEditor);
  $('btnSaveFile')?.addEventListener('click', saveCurrentFile);

  document.addEventListener('keydown', event => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 's' &&
      currentFile
    ) {
      event.preventDefault();
      saveCurrentFile();
    }
  });

  document.querySelectorAll('.plg-source').forEach(button => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLElement)) return;
      pluginSource = button.dataset.source || 'all';

      document.querySelectorAll('.plg-source').forEach(item =>
        item.classList.toggle('active', item === button)
      );
    });
  });

  document.querySelectorAll('.plg-price').forEach(button => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLElement)) return;
      priceFilter = button.dataset.price || 'all';

      document.querySelectorAll('.plg-price').forEach(item =>
        item.classList.toggle('active', item === button)
      );
    });
  });

  document.querySelectorAll('.plg-tab-btn').forEach(button => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLElement)) return;
      const tab = button.dataset.tab;

      document.querySelectorAll('.plg-tab-btn').forEach(item =>
        item.classList.toggle('active', item === button)
      );

      const plgTabSearch = $('plgTabSearch');
      if (plgTabSearch) {
        plgTabSearch.style.display = tab === 'search' ? '' : 'none';
      }

      const plgTabInstalled = $('plgTabInstalled');
      if (plgTabInstalled) {
        plgTabInstalled.style.display = tab === 'installed' ? '' : 'none';
      }

      if (tab === 'installed') {
        loadInstalledPlugins({ force: true });
      }
    });
  });

  $('btnPluginSearch')?.addEventListener('click', pluginSearch);

  $('plgSearchInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      pluginSearch();
    }
  });

  $('btnRefreshInstalled')?.addEventListener('click', () => loadInstalledPlugins({ force: true }));

  $('btnClosePlgModal')?.addEventListener('click', () => {
    const modal = $('plgVersionModal');
    if (modal) {
      modal.style.display = 'none';
    }
  });

  const plgVersionModal = $('plgVersionModal');
  plgVersionModal?.addEventListener('click', event => {
    if (event.target === plgVersionModal) {
      plgVersionModal.style.display = 'none';
    }
  });

  $('btnNewBackup')?.addEventListener('click', createBackup);

  updateAgentUi();
  updateStatusUi(currentStatus);

  showLogin('');

  if (panelSession && agentId) {
    connectCloud(false).catch(() =>
      showLogin(
        'La sesión no es válida. Introduce un nuevo código de emparejamiento.'
      )
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents, { once: true });
} else {
  bindEvents();
}
