import { cac } from 'cac'
import OpenAI from 'openai'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile, copyFile, rename, unlink, stat, readdir, rm } from 'node:fs/promises'
import { existsSync, createReadStream, readFileSync, mkdirSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { dlopen, FFIType, suffix } from 'bun:ffi'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import os from 'node:os'

const VERSION = '0.15.3'
const LAUNCH_AGENT_LABEL = 'com.kid7st.voicenote'
const LOG_DIR = join(os.homedir(), '.local/state/voicenote/logs')
const LOCK_PATH = join(os.homedir(), '.local/state/voicenote/run.lock')
const CONFIG_DIR = join(os.homedir(), '.config/voicenote')
const SPEAKERS_PATH = join(CONFIG_DIR, 'speakers.json')

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.wma', '.aac', '.flac'])

type Json = Record<string, any>

type Recording = {
  sourcePath: string
  sizeBytes: number
  modifiedAt: string
  durationSeconds: number | null
  sourceId: string
  recordedAt: Date
}

type LocalFiles = {
  audio: string
  transcript: string
  notes: string
  metadata: string
}

type SpeakerSelf = { name: string | null; aliases: string[] }
type SpeakerKnown = { name: string; aliases: string[]; relationship?: string | null }
type SpeakersConfig = { self: SpeakerSelf; known: SpeakerKnown[] }


type AsrProvider = 'volcano' | 'openai'

type VolcanoTosConfig = {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  keep: boolean
}

type VolcanoConfig = {
  apiKey?: string             // 新版控制台：X-Api-Key
  appKey?: string             // 旧版控制台：X-Api-App-Key (APP ID)
  accessKey?: string          // 旧版控制台：X-Api-Access-Key (Access Token)
  resourceId: string
  language?: string
  tos: VolcanoTosConfig
}

type Config = {
  deviceVolume: string
  recordDir: string
  workspace: string
  minBytes: number
  minDurationSeconds: number
  asrProvider: AsrProvider
  transcribeModel: string
  reconcileModel: string
  summaryModel: string
  turboMinDurationSeconds: number
  turboChunkSeconds: number
  turboOverlapSeconds: number
  turboConcurrency: number
  openaiTimeoutSeconds: number
  openaiMaxRetries: number
  speakers: SpeakersConfig
  volcano: VolcanoConfig | null
}

// ────────────────────────────────────────────────────────────────────────────
// Env loading
// ────────────────────────────────────────────────────────────────────────────

// Single source of truth for every env var the pipeline reads. Both consumers
// derive from this list so they can never drift:
//   - loadDotZshrcEnv() hydrates these from ~/.zshrc for non-interactive runs
//   - launchAgentEnv()  embeds them into the LaunchAgent plist
// Anything documented in the README as a configurable knob MUST live here.
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_TRANSCRIBE_MODEL',
  'OPENAI_RECONCILE_MODEL',
  'OPENAI_SUMMARY_MODEL',
  'OPENAI_TIMEOUT_SECONDS',
  'OPENAI_MAX_RETRIES',
  'VOICENOTE_DEVICE_VOLUME',
  'VOICENOTE_RECORD_DIR',
  'VOICENOTE_WORKSPACE',
  'VOICENOTE_MIN_BYTES',
  'VOICENOTE_MIN_DURATION_SECONDS',
  'VOICENOTE_TURBO_MIN_DURATION_SECONDS',
  'VOICENOTE_TURBO_CHUNK_SECONDS',
  'VOICENOTE_TURBO_OVERLAP_SECONDS',
  'VOICENOTE_TURBO_CONCURRENCY',
  'VOICENOTE_ASR_PROVIDER',
  'VOLCANO_ASR_KEY',
  'VOLCANO_ASR_APP_ID',
  'VOLCANO_ASR_APP_KEY',
  'VOLCANO_ASR_ACCESS_TOKEN',
  'VOLCANO_ASR_ACCESS_KEY',
  'VOLCANO_ASR_RESOURCE_ID',
  'VOLCANO_ASR_LANGUAGE',
  'VOLCANO_TOS_REGION',
  'VOLCANO_TOS_ENDPOINT',
  'VOLCANO_TOS_BUCKET',
  'VOLCANO_TOS_ACCESS_KEY',
  'VOLCANO_TOS_SECRET_KEY',
  'VOLCANO_TOS_KEEP',
  'VOICENOTE_LLM_PROVIDER',
  'VOICENOTE_PI_BIN',
  'VOICENOTE_PI_MODEL',
  'VOICENOTE_PI_MODEL_SUMMARY',
  'VOICENOTE_PI_MODEL_RECONCILE',
  'VOICENOTE_PI_THINKING',
  'VOICENOTE_PI_SUMMARY_TOOLS',
  'VOICENOTE_CONTEXT_DIR',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'LOCAL_PROXY_HOST', 'LOCAL_PROXY_PORT', 'LOCAL_NO_PROXY',
]

// Volcano endpoints (TOS object storage + openspeech ASR) should NEVER go through
// the SOCKS/HTTP proxy that we keep around for OpenAI:
//   1) the proxy bandwidth often chokes on multi-megabyte PUTs to TOS
//   2) routing China-mainland Volcano APIs through an overseas proxy is slower / unreliable
const VOLCANO_NO_PROXY_HOSTS = ['.volces.com', '.volcengineapi.com', 'openspeech.bytedance.com']

function mergeVolcanoNoProxy(value: string | undefined): string {
  const items = (value || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const host of VOLCANO_NO_PROXY_HOSTS) if (!items.includes(host)) items.push(host)
  return items.join(',')
}

function applyDerivedProxy(): void {
  const host = process.env.LOCAL_PROXY_HOST
  const port = process.env.LOCAL_PROXY_PORT
  if (host && port) {
    const url = `http://${host}:${port}`
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy']) if (!process.env[k]) process.env[k] = url
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) if (!process.env[k]) process.env[k] = url
    const baseNoProxy = process.env.LOCAL_NO_PROXY || 'localhost,127.0.0.1,::1'
    if (!process.env.no_proxy) process.env.no_proxy = baseNoProxy
    if (!process.env.NO_PROXY) process.env.NO_PROXY = baseNoProxy
  }
  // Always ensure Volcano hosts bypass whatever proxy is configured.
  process.env.no_proxy = mergeVolcanoNoProxy(process.env.no_proxy)
  process.env.NO_PROXY = mergeVolcanoNoProxy(process.env.NO_PROXY)
}

let zshrcEnvLoaded = false
function loadDotZshrcEnv(): void {
  if (zshrcEnvLoaded) return
  zshrcEnvLoaded = true
  const zshrc = join(os.homedir(), '.zshrc')
  if (!existsSync(zshrc)) return
  let content = ''
  try { content = readFileSync(zshrc, 'utf8') } catch { return }
  for (const key of ENV_KEYS) {
    // Already defined in the process env (shell / plist / CLI) wins; .zshrc is only
    // a fallback for unset keys. Use !== undefined so an explicit empty string
    // (e.g. VOICENOTE_PI_SUMMARY_TOOLS="" to disable tools) isn't re-overridden.
    if (process.env[key] !== undefined) continue
    const pattern = new RegExp(`(?:^|\\n)\\s*export\\s+${key}=(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`)
    const match = content.match(pattern)
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    // Regex parsing skips shell expansion; resolve $HOME/${HOME} so path knobs
    // written as "$HOME/..." (per the README) work in non-interactive runs too.
    if (value !== undefined) process.env[key] = value.replace(/\$\{?HOME\}?/g, os.homedir())
  }
  applyDerivedProxy()
}

function getVolcanoConfigFromEnv(): VolcanoConfig | null {
  const apiKey = process.env.VOLCANO_ASR_KEY || ''
  const appKey = process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_ASR_APP_KEY || ''
  const asrAccess = process.env.VOLCANO_ASR_ACCESS_TOKEN || process.env.VOLCANO_ASR_ACCESS_KEY || ''
  const tosAccess = process.env.VOLCANO_TOS_ACCESS_KEY
  const tosSecret = process.env.VOLCANO_TOS_SECRET_KEY
  const bucket = process.env.VOLCANO_TOS_BUCKET
  const hasAuth = apiKey || (appKey && asrAccess)
  if (!hasAuth || !tosAccess || !tosSecret || !bucket) return null
  const region = process.env.VOLCANO_TOS_REGION || 'cn-hongkong'
  const endpoint = process.env.VOLCANO_TOS_ENDPOINT || `tos-s3-${region}.volces.com`
  const keep = ['1', 'true', 'yes'].includes((process.env.VOLCANO_TOS_KEEP || '0').toLowerCase())
  return {
    apiKey: apiKey || undefined,
    appKey: appKey || undefined,
    accessKey: asrAccess || undefined,
    resourceId: process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.seedasr.auc',
    language: process.env.VOLCANO_ASR_LANGUAGE || undefined,
    tos: { endpoint, region, bucket, accessKey: tosAccess, secretKey: tosSecret, keep },
  }
}

function volcanoAuthHeaders(volc: VolcanoConfig, taskId: string, includeSequence: boolean): Record<string, string> {
  const base: Record<string, string> = {
    'X-Api-Resource-Id': volc.resourceId,
    'X-Api-Request-Id': taskId,
    'Content-Type': 'application/json',
  }
  if (includeSequence) base['X-Api-Sequence'] = '-1'
  if (volc.appKey && volc.accessKey) {
    base['X-Api-App-Key'] = volc.appKey
    base['X-Api-Access-Key'] = volc.accessKey
  } else if (volc.apiKey) {
    base['X-Api-Key'] = volc.apiKey
  }
  return base
}

function getConfig(): Config {
  loadDotZshrcEnv()
  const deviceVolume = process.env.VOICENOTE_DEVICE_VOLUME || 'VTR6500'
  const recordDir = process.env.VOICENOTE_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`
  const requestedProvider = (process.env.VOICENOTE_ASR_PROVIDER || 'volcano').toLowerCase() as AsrProvider
  const asrProvider: AsrProvider = ['volcano', 'openai'].includes(requestedProvider) ? requestedProvider : 'volcano'
  return {
    deviceVolume,
    recordDir,
    workspace: expandHome(process.env.VOICENOTE_WORKSPACE || '~/Documents/meetings'),
    minBytes: Number(process.env.VOICENOTE_MIN_BYTES || 100000),
    minDurationSeconds: Number(process.env.VOICENOTE_MIN_DURATION_SECONDS || 60),
    asrProvider,
    volcano: getVolcanoConfigFromEnv(),
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize',
    // OpenAI-side model used to reconcile turbo chunks (merge per-chunk transcripts back into one).
    reconcileModel: process.env.OPENAI_RECONCILE_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-5.5',
    summaryModel: process.env.OPENAI_SUMMARY_MODEL || 'gpt-5.5',
    turboMinDurationSeconds: Number(process.env.VOICENOTE_TURBO_MIN_DURATION_SECONDS || 20 * 60),
    turboChunkSeconds: Number(process.env.VOICENOTE_TURBO_CHUNK_SECONDS || 10 * 60),
    turboOverlapSeconds: Number(process.env.VOICENOTE_TURBO_OVERLAP_SECONDS || 5),
    turboConcurrency: Number(process.env.VOICENOTE_TURBO_CONCURRENCY || 3),
    openaiTimeoutSeconds: Number(process.env.OPENAI_TIMEOUT_SECONDS || 300),
    openaiMaxRetries: Number(process.env.OPENAI_MAX_RETRIES || 2),
    speakers: loadSpeakers(),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Config files (~/.config/voicenote)
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SPEAKERS: SpeakersConfig = { self: { name: null, aliases: [] }, known: [] }


function loadJsonSync<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function loadSpeakers(): SpeakersConfig {
  ensureConfigSeed()
  const data = loadJsonSync<Partial<SpeakersConfig>>(SPEAKERS_PATH, DEFAULT_SPEAKERS)
  return {
    self: { name: data.self?.name ?? null, aliases: Array.isArray(data.self?.aliases) ? data.self!.aliases : [] },
    known: Array.isArray(data.known) ? data.known : [],
  }
}


let configSeeded = false
function ensureConfigSeed(): void {
  if (configSeeded) return
  configSeeded = true
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    if (!existsSync(SPEAKERS_PATH)) {
      writeFileSync(SPEAKERS_PATH, JSON.stringify(DEFAULT_SPEAKERS, null, 2) + '\n', 'utf8')
    }
  } catch {
    // Don't crash if we can't seed; commands still work with defaults in memory.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

function expandHome(path: string): string {
  if (path === '~') return os.homedir()
  if (path.startsWith('~/')) return join(os.homedir(), path.slice(2))
  return path
}

function nowIso(): string { return new Date().toISOString() }
function pad(n: number): string { return String(n).padStart(2, '0') }

function dateParts(d: Date): { month: string; prefix: string } {
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  // 文件名里的本地时间只用 HH-MM（录音设备同一分钟内不可能产生两条录音）
  const prefix = `${month}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`
  return { month, prefix }
}

function safeSlug(text: string, maxLen = 48): string {
  const cleaned = (text || '').trim().replace(/[\\/:*?"<>|\n\r\t]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, maxLen).replace(/-+$/g, '') || 'meeting'
}

function formatSeconds(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function parseTimestampToSeconds(value: string): number {
  const parts = value.split(':').map(Number)
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return Number(value) || 0
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

// ────────────────────────────────────────────────────────────────────────────
// File state IO
// ────────────────────────────────────────────────────────────────────────────

async function ensureDirs(config: Config): Promise<void> {
  for (const dir of ['_state', '_index', '_audio', '_transcripts', '_metadata']) {
    await mkdir(join(config.workspace, dir), { recursive: true })
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

async function writeJson(path: string, data: any): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, path)
}

async function appendJsonl(path: string, data: any): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(data) + '\n', 'utf8')
}


// ────────────────────────────────────────────────────────────────────────────
// Logging (rolling daily log)
// ────────────────────────────────────────────────────────────────────────────

function dailyLogPath(): string {
  const d = new Date()
  return join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`)
}

// Best-effort side effects (logging, idle-state) must not crash the pipeline, but
// failures should still be observable. Write directly to stderr (not console.error,
// which wireDailyLog wraps and would recurse into the same failing file) once per tag.
const sideEffectWarned = new Set<string>()
function warnSideEffect(where: string, e: unknown): void {
  if (sideEffectWarned.has(where)) return
  sideEffectWarned.add(where)
  process.stderr.write(`[voicenote] non-fatal: ${where} failed: ${e instanceof Error ? e.message : String(e)}\n`)
}

let logWired = false
function wireDailyLog(): void {
  if (logWired) return
  logWired = true
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch (e) { warnSideEffect('log dir mkdir', e) }
  const path = dailyLogPath()
  const append = (level: 'INFO' | 'ERROR', args: any[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const stamped = `${nowIso()} [${level}] ${line}\n`
    try { appendFileSync(path, stamped, 'utf8') } catch (e) { warnSideEffect('daily log append', e) }
  }
  const origLog = console.log.bind(console)
  const origErr = console.error.bind(console)
  console.log = (...a: any[]) => { append('INFO', a); origLog(...a) }
  console.error = (...a: any[]) => { append('ERROR', a); origErr(...a) }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${m}m ${s}s`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function progressStep(step: number, total: number, title: string, detail?: string): void {
  console.log(`▶ Step ${step}/${total}: ${title}${detail ? ` — ${detail}` : ''}`)
}

async function withHeartbeat<T>(label: string, work: () => Promise<T>, heartbeatSeconds = 60): Promise<T> {
  const started = Date.now()
  const timer = setInterval(() => {
    console.log(`… Still working: ${label} (${formatElapsed(Date.now() - started)} elapsed)`)
  }, Math.max(10, heartbeatSeconds) * 1000)
  ;(timer as any).unref?.()
  try {
    const result = await work()
    console.log(`✓ Done: ${label} (${formatElapsed(Date.now() - started)})`)
    return result
  } catch (e) {
    console.error(`✗ Failed: ${label} after ${formatElapsed(Date.now() - started)}`)
    throw e
  } finally {
    clearInterval(timer)
  }
}

function shouldLogIdleStatus(key: string, intervalMs = 30 * 60 * 1000): boolean {
  const path = join(LOG_DIR, 'idle-status.json')
  const now = Date.now()
  let prev: any = null
  try { prev = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  const should = prev?.key !== key || now - Number(prev?.at || 0) >= intervalMs
  if (should) {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      writeFileSync(path, JSON.stringify({ key, at: now, iso: nowIso() }, null, 2) + '\n', 'utf8')
    } catch (e) { warnSideEffect('idle-status write', e) }
  }
  return should
}

type RunMode = 'notes' | 'transcript'
type TranscribeStrategy = 'auto' | 'single' | 'turbo'

function normalizeRunMode(opts: any): RunMode {
  const raw = String(opts.mode || 'notes').toLowerCase()
  if (raw === 'note') return 'notes'
  if (raw === 'notes' || raw === 'transcript') return raw
  throw new Error(`Invalid --mode "${raw}". Use: notes|transcript`)
}

function normalizeTranscribeStrategy(opts: any): TranscribeStrategy {
  const raw = String(opts.transcribe || 'auto').toLowerCase()
  if (['auto', 'single', 'turbo'].includes(raw)) return raw as TranscribeStrategy
  throw new Error(`Invalid --transcribe "${raw}". Use: auto|single|turbo`)
}

function chooseTranscribeStrategy(config: Config, rec: Recording, requested: TranscribeStrategy): 'single' | 'turbo' {
  if (config.asrProvider === 'volcano') return 'single'
  if (requested === 'single') return 'single'
  if (requested === 'turbo') return 'turbo'
  return (rec.durationSeconds || 0) >= config.turboMinDurationSeconds ? 'turbo' : 'single'
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-process lock
// ────────────────────────────────────────────────────────────────────────────

// Single-instance mutual exclusion via an OS advisory lock (flock) held on an open
// fd. The kernel releases it automatically when the process exits — including
// SIGKILL/crash — so there is NO pid / mtime / heartbeat / stale-steal logic to
// race on. flock lives in libSystem on macOS (the only supported platform).
const flockFn = (() => {
  try {
    const lib = dlopen(`libSystem.${suffix}`, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    return lib.symbols.flock as (fd: number, op: number) => number
  } catch { return null }
})()
const FLOCK_EX_NB = 2 | 4  // LOCK_EX | LOCK_NB
const FLOCK_UN = 8

async function acquireRunLock(): Promise<{ release: () => Promise<void> } | null> {
  await mkdir(dirname(LOCK_PATH), { recursive: true })
  if (!flockFn) {
    console.error('Warning: flock unavailable on this runtime; proceeding without cross-process locking.')
    return { release: async () => {} }
  }
  // The lock is a regular file we keep open. Builds ≤ 0.15.2 used a *directory*
  // here, held purely by its existence, with no pid or refreshed mtime inside — so
  // a leftover legacy dir carries NO reliable signal about whether an old `vn run`
  // still holds it. Rather than guess (and risk deleting a live lock → concurrent
  // double-processing), refuse to auto-reclaim it: warn and skip. Normal upgrades
  // don't hit this (≤ 0.15.2 removes its own dir lock on SIGTERM/exit); it only
  // appears after a hard crash of an old build, where a one-time manual cleanup is
  // the safe move.
  let fd: number
  try { fd = openSync(LOCK_PATH, 'w') }
  catch (e: any) {
    if (e?.code !== 'EISDIR') throw e
    console.error(`Found a legacy (≤ 0.15.2) lock directory at ${LOCK_PATH}; it carries no liveness info and can't be auto-reclaimed safely. If no 'vn run' is active, remove it once:  rm -rf "${LOCK_PATH}"  — skipping this run.`)
    return null
  }
  if (flockFn(fd, FLOCK_EX_NB) !== 0) { closeSync(fd); return null }  // another run holds it
  let released = false
  const release = async () => {
    if (released) return
    released = true
    try { flockFn(fd, FLOCK_UN) } catch {}
    try { closeSync(fd) } catch {}
  }
  process.once('exit', () => { void release() })
  process.once('SIGINT', () => { void release(); process.exit(130) })
  process.once('SIGTERM', () => { void release(); process.exit(143) })
  return { release }
}

// ────────────────────────────────────────────────────────────────────────────
// Recording scan
// ────────────────────────────────────────────────────────────────────────────

function parseRecordedAt(path: string): Date {
  const stem = basename(path, extname(path))
  const m = stem.match(/(20\d{12})/)
  if (m?.[1]) {
    const s = m[1]
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14)))
  }
  return new Date()
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  const reader = Bun.file(path).stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    h.update(value)
  }
  return h.digest('hex')
}

async function sourceIdFor(path: string): Promise<string> {
  const st = await stat(path)
  const digest = await sha256File(path)
  return createHash('sha256').update(`${path}|${st.size}|${Math.floor(st.mtimeMs / 1000)}|${digest}`).digest('hex')
}

function runCommand(command: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', d => stdout += String(d))
    child.stderr.on('data', d => stderr += String(d))
    child.on('close', code => { clearTimeout(timer); res({ stdout, stderr, code: code ?? 1 }) })
    child.on('error', err => { clearTimeout(timer); res({ stdout, stderr: String(err), code: 1 }) })
  })
}

async function ffprobeDuration(path: string): Promise<number | null> {
  const result = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path])
  if (result.code !== 0) return null
  const v = Number(result.stdout.trim())
  return Number.isFinite(v) ? v : null
}

function isCandidateFile(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('._') || name.startsWith('.')) return false
  if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) return false
  const parts = path.split('/')
  if (parts.includes('.Spotlight-V100') || parts.includes('.fseventsd') || parts.includes('System Volume Information')) return false
  return true
}

async function scanRecordings(config: Config): Promise<Recording[]> {
  if (!existsSync(config.recordDir)) return []
  const recordings: Recording[] = []
  for await (const file of new Bun.Glob('**/*').scan({ cwd: config.recordDir, absolute: true, dot: true })) {
    if (!isCandidateFile(file)) continue
    const st = await stat(file).catch(() => null)
    if (!st?.isFile()) continue
    recordings.push({
      sourcePath: file,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      durationSeconds: await ffprobeDuration(file),
      sourceId: await sourceIdFor(file),
      recordedAt: parseRecordedAt(file),
    })
  }
  return recordings.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
}

function shouldSkip(rec: Recording, state: Json, config: Config, force: boolean): [boolean, string] {
  if (state.processed_source_ids?.[rec.sourceId] && !force) return [true, 'already_processed']
  if (rec.sizeBytes < config.minBytes) return [true, `too_small:${rec.sizeBytes}<${config.minBytes}`]
  if (rec.durationSeconds !== null && rec.durationSeconds < config.minDurationSeconds) return [true, `too_short:${rec.durationSeconds.toFixed(1)}<${config.minDurationSeconds}`]
  return [false, '']
}

// ────────────────────────────────────────────────────────────────────────────
// File path planning
// ────────────────────────────────────────────────────────────────────────────

function initialLocalFiles(config: Config, rec: Recording): LocalFiles {
  const { month, prefix } = dateParts(rec.recordedAt)
  return {
    audio: join(config.workspace, '_audio', month, `${prefix}-original${extname(rec.sourcePath).toLowerCase()}`),
    transcript: join(config.workspace, '_transcripts', month, `${prefix}-transcript.md`),
    notes: join(config.workspace, month, `${prefix}-meeting.md`),
    metadata: join(config.workspace, '_metadata', month, `${prefix}-metadata.json`),
  }
}

async function titledLocalFiles(config: Config, rec: Recording, meta: Json, files: LocalFiles): Promise<LocalFiles> {
  const { month, prefix } = dateParts(rec.recordedAt)
  const base = `${prefix}-${safeSlug(meta.title || 'meeting')}`
  const targets: LocalFiles = {
    audio: join(config.workspace, '_audio', month, `${base}-original${extname(rec.sourcePath).toLowerCase()}`),
    transcript: join(config.workspace, '_transcripts', month, `${base}-transcript.md`),
    notes: join(config.workspace, month, `${base}.md`),
    metadata: join(config.workspace, '_metadata', month, `${base}-metadata.json`),
  }
  for (const p of Object.values(targets)) await mkdir(dirname(p), { recursive: true })
  if (existsSync(files.audio) && files.audio !== targets.audio) {
    if (existsSync(targets.audio)) await unlink(targets.audio)
    await rename(files.audio, targets.audio)
  }
  return targets
}

// ────────────────────────────────────────────────────────────────────────────
// OpenAI
// ────────────────────────────────────────────────────────────────────────────

function openaiClient(config: Config): OpenAI {
  loadDotZshrcEnv()
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: config.openaiTimeoutSeconds * 1000,
    maxRetries: config.openaiMaxRetries,
  })
}

function formatTranscriptionResult(result: any): string {
  if (typeof result === 'string') return result.trim()
  if (Array.isArray(result?.segments)) {
    const lines = result.segments.map((seg: any) => {
      const text = String(seg.text || '').trim()
      if (!text) return ''
      const speaker = seg.speaker || 'Speaker'
      return `[${formatSeconds(seg.start)}-${formatSeconds(seg.end)}] Speaker ${speaker}: ${text}`
    }).filter(Boolean)
    if (lines.length) return lines.join('\n')
  }
  if (result?.text) return String(result.text).trim()
  return String(result)
}

// ───────────────────────────────────────────────────────────────────────
// Volcano (豆包 ASR + TOS upload)
// ───────────────────────────────────────────────────────────────────────

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function tosCanonicalUri(key: string): string {
  // S3 SigV4: encode each path segment, keep '/' as separator.
  return '/' + key.split('/').map(s => encodeURIComponent(s)).join('/')
}

function tosAmzDate(now: Date = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function tosSigningKey(secretKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, 's3')
  return hmacSha256(kService, 'aws4_request')
}

function tosSignRequest(tos: VolcanoTosConfig, method: 'PUT' | 'DELETE', key: string, payloadHash: string, contentType?: string): { url: string; headers: Record<string, string> } {
  const host = `${tos.bucket}.${tos.endpoint}`
  const { amzDate, dateStamp } = tosAmzDate()
  const canonicalUri = tosCanonicalUri(key)
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (contentType) headers['content-type'] = contentType
  const sortedNames = Object.keys(headers).sort()
  const canonicalHeaders = sortedNames.map(h => `${h}:${headers[h]}\n`).join('')
  const signedHeaders = sortedNames.join(';')
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/${tos.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = tosSigningKey(tos.secretKey, dateStamp, tos.region)
  const signature = hmacSha256(signingKey, stringToSign).toString('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${tos.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { url: `https://${host}${canonicalUri}`, headers: { ...headers, Authorization: authorization } }
}

function tosPresignedGet(tos: VolcanoTosConfig, key: string, expiresSeconds = 3600): string {
  const host = `${tos.bucket}.${tos.endpoint}`
  const { amzDate, dateStamp } = tosAmzDate()
  const canonicalUri = tosCanonicalUri(key)
  const credentialScope = `${dateStamp}/${tos.region}/s3/aws4_request`
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${tos.accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  }
  const canonicalQuery = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`).join('&')
  const canonicalHeaders = `host:${host}\n`
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacSha256(tosSigningKey(tos.secretKey, dateStamp, tos.region), stringToSign).toString('hex')
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

async function tosUploadObject(tos: VolcanoTosConfig, localPath: string, key: string, contentType: string): Promise<void> {
  const body = await readFile(localPath)
  const payloadHash = sha256Hex(body)
  const { url, headers } = tosSignRequest(tos, 'PUT', key, payloadHash, contentType)
  const res = await fetch(url, { method: 'PUT', body, headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`TOS upload failed: ${res.status} ${text.slice(0, 500)}`)
  }
}

async function tosDeleteObject(tos: VolcanoTosConfig, key: string): Promise<void> {
  const { url, headers } = tosSignRequest(tos, 'DELETE', key, sha256Hex(''))
  const res = await fetch(url, { method: 'DELETE', headers })
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const text = await res.text().catch(() => '')
    console.log(`Warn: TOS delete returned ${res.status}: ${text.slice(0, 200)}`)
  }
}

function volcanoFormatFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (e === 'mp3') return 'mp3'
  if (e === 'wav') return 'wav'
  return e || 'mp3'
}

function volcanoContentTypeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  switch (e) {
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'ogg': return 'audio/ogg'
    case 'flac': return 'audio/flac'
    default: return 'application/octet-stream'
  }
}

async function volcanoSubmitTask(volc: VolcanoConfig, taskId: string, audioUrl: string, format: string): Promise<void> {
  const body = {
    user: { uid: 'voicenote' },
    audio: { url: audioUrl, format },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      enable_speaker_info: true,
      show_utterances: true,
      ...(volc.language ? { language: volc.language } : {}),
    },
  }
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, true),
    body: JSON.stringify(body),
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  if (status !== '20000000') {
    const text = await res.text().catch(() => '')
    throw new Error(`Volcano submit failed: status=${status} message=${message} body=${text.slice(0, 500)}`)
  }
}

type VolcanoUtterance = {
  text?: string
  start_time?: number
  end_time?: number
  speaker_id?: number | string
  additions?: { speaker_id?: number | string; speaker?: string | number }
}

type VolcanoQueryResult = {
  status: string
  message: string
  result?: { text?: string; utterances?: VolcanoUtterance[] }
  audio_info?: { duration?: number }
}

async function volcanoQueryResult(volc: VolcanoConfig, taskId: string): Promise<VolcanoQueryResult> {
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, false),
    body: '{}',
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  const text = await res.text().catch(() => '')
  let parsed: any = null
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
  return { status, message, result: parsed?.result, audio_info: parsed?.audio_info }
}

function volcanoSpeakerLabel(u: VolcanoUtterance): string {
  const id = u.speaker_id ?? u.additions?.speaker_id ?? u.additions?.speaker
  if (id == null || id === '') return 'Speaker A'
  const n = Number(id)
  if (Number.isFinite(n) && n >= 0 && n < 26) return `Speaker ${String.fromCharCode(65 + n)}`
  return `Speaker ${String(id)}`
}

function volcanoFormatTranscript(result: { text?: string; utterances?: VolcanoUtterance[] }): string {
  const utterances = result.utterances || []
  if (!utterances.length) return (result.text || '').trim()
  const lines = utterances
    .map(u => {
      const text = String(u.text || '').trim()
      if (!text) return ''
      const start = formatSeconds(Math.round((u.start_time || 0) / 1000))
      const end = formatSeconds(Math.round((u.end_time || 0) / 1000))
      return `[${start}-${end}] ${volcanoSpeakerLabel(u)}: ${text}`
    })
    .filter(Boolean)
  return lines.join('\n')
}

async function volcanoTranscribeAudio(volc: VolcanoConfig, audioPath: string, rec: Recording): Promise<string> {
  const ext = extname(audioPath).toLowerCase() || '.mp3'
  const format = volcanoFormatFromExt(ext)
  const contentType = volcanoContentTypeFromExt(ext)
  const { month } = dateParts(rec.recordedAt)
  const key = `voicenote/${month}/${rec.sourceId}-${Date.now()}${ext}`
  console.log(`Volcano: upload audio to TOS as ${key}`)
  await withHeartbeat('upload audio to TOS', () => tosUploadObject(volc.tos, audioPath, key, contentType), 30)
  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp || volc.tos.keep) return
    cleanedUp = true
    await tosDeleteObject(volc.tos, key).catch(() => {})
  }
  try {
    const audioUrl = tosPresignedGet(volc.tos, key, 6 * 3600)
    const taskId = randomUUID()
    console.log(`Volcano: submit ASR task ${taskId} (resource=${volc.resourceId}, format=${format})`)
    await volcanoSubmitTask(volc, taskId, audioUrl, format)
    const started = Date.now()
    const expectedSeconds = rec.durationSeconds || 0
    const maxWaitMs = Math.max(20 * 60 * 1000, Math.ceil(expectedSeconds * 1000 * 1.5))
    let lastStatusLog = 0
    let lastStatus = ''
    for (;;) {
      await new Promise(res => setTimeout(res, 8000))
      const q = await volcanoQueryResult(volc, taskId)
      if (q.status === '20000000' && q.result) {
        console.log(`✓ Volcano: ASR done in ${formatElapsed(Date.now() - started)}; audio_duration=${q.audio_info?.duration ?? 'unknown'}ms`)
        return volcanoFormatTranscript(q.result)
      }
      if (q.status === '20000001' || q.status === '20000002') {
        if (q.status !== lastStatus || Date.now() - lastStatusLog > 60_000) {
          const label = q.status === '20000002' ? 'queued' : 'processing'
          console.log(`… Volcano: ${label} (status=${q.status}, ${formatElapsed(Date.now() - started)} elapsed)`)
          lastStatusLog = Date.now()
          lastStatus = q.status
        }
        if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last status=${q.status})`)
        continue
      }
      if (q.status === '20000003') throw new Error('Volcano: 20000003 静音音频（未检测到人声）')
      throw new Error(`Volcano query failed: status=${q.status} message=${q.message}`)
    }
  } finally {
    await cleanup()
  }
}

async function transcribeAudio(config: Config, audioPath: string, rec?: Recording): Promise<string> {
  if (config.asrProvider === 'volcano') {
    if (!config.volcano) throw new Error('Volcano ASR not configured. Set VOLCANO_ASR_KEY / VOLCANO_TOS_* in ~/.zshrc, or use VOICENOTE_ASR_PROVIDER=openai.')
    if (!rec) throw new Error('Volcano transcribe requires recording metadata')
    return volcanoTranscribeAudio(config.volcano, audioPath, rec)
  }
  return openaiTranscribeAudio(config, audioPath)
}

async function openaiTranscribeAudio(config: Config, audioPath: string): Promise<string> {
  const client = openaiClient(config)
  const isDiarize = config.transcribeModel === 'gpt-4o-transcribe-diarize'
  // Streaming avoids "socket closed unexpectedly" on long-running transcribe calls
  // (long audios may keep the HTTP connection idle for several minutes).
  const kwargs: any = {
    model: config.transcribeModel,
    file: createReadStream(audioPath),
    stream: true,
  }
  if (isDiarize) {
    kwargs.response_format = 'diarized_json'
    kwargs.chunking_strategy = 'auto'
  }
  const stream: any = await client.audio.transcriptions.create(kwargs)
  const segments: any[] = []
  let doneText = ''
  for await (const ev of stream) {
    const t = ev?.type as string | undefined
    if (!t) continue
    if (t === 'transcript.text.segment') segments.push(ev)
    else if (t === 'transcript.text.done') doneText = String(ev.text || '')
    else if (t === 'transcript.text.delta' && !isDiarize) doneText += String(ev.delta || '')
  }
  if (segments.length) return formatTranscriptionResult({ segments })
  return doneText.trim() || ''
}

type AudioChunk = { index: number; start: number; duration: number; path: string }

async function splitAudioForTurbo(config: Config, audioPath: string, durationSeconds: number): Promise<{ tempDir: string; chunks: AudioChunk[] }> {
  const tempDir = join(os.tmpdir(), `voicenote-turbo-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(tempDir, { recursive: true })
  const chunks: AudioChunk[] = []
  const chunk = Math.max(60, config.turboChunkSeconds)
  const overlap = Math.max(0, Math.min(config.turboOverlapSeconds, 30))
  for (let base = 0, index = 0; base < durationSeconds; base += chunk, index++) {
    const start = Math.max(0, base - (index > 0 ? overlap : 0))
    const end = Math.min(durationSeconds, base + chunk + overlap)
    const out = join(tempDir, `chunk-${String(index + 1).padStart(3, '0')}${extname(audioPath).toLowerCase() || '.mp3'}`)
    const result = await runCommand('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(Math.max(1, end - start)), '-i', audioPath, '-vn', '-acodec', 'copy', out], 120000)
    if (result.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg split failed for chunk ${index + 1}: ${result.stderr}`)
    chunks.push({ index: index + 1, start, duration: end - start, path: out })
  }
  return { tempDir, chunks }
}

function offsetChunkTranscript(text: string, chunk: AudioChunk): string {
  const out: string[] = [`## Chunk ${String(chunk.index).padStart(2, '0')} (${formatSeconds(chunk.start)}-${formatSeconds(chunk.start + chunk.duration)})`]
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d{2}(?::\d{2}){1,2})-(\d{2}(?::\d{2}){1,2})\]\s*(.*)$/)
    if (!m) {
      if (line.trim()) out.push(line)
      continue
    }
    const start = formatSeconds(parseTimestampToSeconds(m[1]!) + chunk.start)
    const end = formatSeconds(parseTimestampToSeconds(m[2]!) + chunk.start)
    const rest = m[3]!.replace(/^Speaker\s+/i, `Chunk ${String(chunk.index).padStart(2, '0')} Speaker `)
    out.push(`[${start}-${end}] ${rest}`)
  }
  return out.join('\n')
}

async function reconcileMergedTranscript(config: Config, merged: string, rec: Recording): Promise<string> {
  const system = `你是中文录音 transcript 合并与说话人校准助手。

任务：把多个音频 chunk 的转写合并成一份连续 transcript。输入中的说话人标签形如 \`Chunk 01 Speaker A\`，每个 chunk 的 Speaker A/B/C 都是局部标签，不能直接视为全局同一人。

规则：
- 保留并校准全局时间戳，输出每行仍使用 \`[00:00-00:05] 说话人: 内容\` 格式。
- 对 chunk overlap 造成的重复句子做去重；不要删除非重复信息。
- 根据上下文和 speaker context 尽可能做 speaker reconciliation：同一个人跨 chunk 使用同一标签或真实姓名。
- 如果能确定是用户本人，使用真实姓名；如果无法确定，使用全局标签 \`Speaker A\` / \`Speaker B\`，不要保留 \`Chunk 01\` 前缀。
- 轻度修正明显错别字、标点、术语和断句；不要总结，不要改写成纪要。
- 不确定词用「[不确定：原词?]」标注。
- 输出纯 transcript，不要 markdown 标题，不要解释。

${speakerContextBlock(config.speakers)}`
  const user = `录音时间：${rec.recordedAt.toISOString()}\n源文件：${basename(rec.sourcePath)}\n\n请合并并校准以下分块 transcript：\n\n${merged}`
  const text = await chatComplete({ systemPrompt: system, userPrompt: user, role: 'reconcile', config, openaiModel: config.reconcileModel })
  return text.trim() || merged
}

async function transcribeAudioTurbo(config: Config, audioPath: string, rec: Recording): Promise<{ transcript: string; rawMerged: string; chunks: AudioChunk[] }> {
  const duration = rec.durationSeconds || await ffprobeDuration(audioPath) || 0
  const { tempDir, chunks } = await splitAudioForTurbo(config, audioPath, duration)
  try {
    console.log(`Turbo plan: ${chunks.length} chunks, concurrency=${config.turboConcurrency}, chunk=${formatSeconds(config.turboChunkSeconds)}, overlap=${config.turboOverlapSeconds}s`)
    let completed = 0
    const chunkTexts = await mapLimit(chunks, config.turboConcurrency, async (chunk) => {
      const label = `transcribe chunk ${chunk.index}/${chunks.length} (${formatSeconds(chunk.start)}-${formatSeconds(chunk.start + chunk.duration)})`
      console.log(`  ▶ ${label}; remaining chunks after this starts: ${Math.max(0, chunks.length - completed - 1)}`)
      const text = await withHeartbeat(label, () => openaiTranscribeAudio(config, chunk.path), 90)
      completed++
      console.log(`  ✓ chunk ${chunk.index}/${chunks.length} complete; progress=${completed}/${chunks.length}; remaining=${chunks.length - completed}`)
      return offsetChunkTranscript(text, chunk)
    })
    const rawMerged = chunkTexts.join('\n\n')
    console.log('Next: reconcile merged transcript speakers/context, then generate semantic notes.')
    const transcript = await withHeartbeat('reconcile merged transcript speakers/context', () => reconcileMergedTranscript(config, rawMerged, rec), 60)
    return { transcript, rawMerged, chunks }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

function speakerContextBlock(speakers: SpeakersConfig): string {
  const selfPart = speakers.self.name
    ? `用户本人：${speakers.self.name}${speakers.self.aliases.length ? `（别名：${speakers.self.aliases.join('、')}）` : ''}`
    : '用户本人姓名未配置。'
  const knownPart = speakers.known.length
    ? speakers.known.map(k => `- ${k.name}${k.aliases?.length ? `（别名：${k.aliases.join('、')}）` : ''}${k.relationship ? `，${k.relationship}` : ''}`).join('\n')
    : '（无其他已知说话人）'
  return `Speaker context（用于尽可能把 Speaker A/B/C 还原成真实姓名，但只在证据充分时替换）：\n- ${selfPart}\n- 其他已知说话人：\n${knownPart}\n\n判断规则：\n- 录音只有一个说话人，且本人姓名已配置，可以把 Speaker A 视为本人。\n- 多人对话中若某说话人被其他人称呼为本人姓名/别名，则该说话人为本人。\n- 多人对话中若某说话人被其他人称呼为已知说话人的姓名/别名，则该说话人为该已知说话人。\n- 其他无法确认的，保留 Speaker A/B/C，不要硬猜。`
}


function summaryMessages(config: Config, transcript: string, rec: Recording, localAudioPath: string, opts: { integratedMode?: boolean } = {}): OpenAI.Chat.ChatCompletionMessageParam[] {
  const system = `你是石洋的个人语义整理助手，不是通用会议纪要模板生成器。

你的目标不是复刻“会议纪要”格式，而是把一段录音变成一份最高效的理解材料：让石洋快速知道这段讨论真正讲了什么、为什么重要、里面有什么思想/判断/事项、应该关注什么、后续该做什么。

特别注意：不要只输出压缩后的“结论”。很多录音的价值正在于观点如何被提出、质疑、论证、修正，以及共识或分歧如何形成。你要在不机械复刻 transcript 的前提下，尽量还原重要发言者的观点、推理过程、争论过程、决策演化和共识形成过程。

核心原则：
1. 结构完全由内容决定。不要套用任何固定模板，不要为了形式输出固定章节。
2. 优先抓“语义价值”，而不是逐段复述；但不要把过程压扁成结论。重要的思考、争论、验证、让步、反驳和共识形成过程，本身就是语义价值。
3. 多人沟通必须尽量还原：各方最初关心的问题/立场、各自的理由和例子、谁提出了质疑或反驳、讨论如何转向、哪些观点被修正、最后形成了什么共识、哪些分歧仍未解决。
4. 单人思考也要还原推理路径：问题如何被提出，假设如何被检验，为什么排除某些方案，哪些经验/类比支撑判断，最后为什么形成当前结论。
5. 可以自由选择表达形态：短备忘、战略 memo、问题树、决策记录、行动清单、思维导图式层级、阶段复盘、争论复盘、学习笔记、产品/技术分析等；选最适合这段内容的一种或几种。
6. 如果讨论是思想性/探索性的，重点帮助读者理解思路脉络、关键概念、推理链条、观点变化、值得回看的片段；不要硬拆待办。
7. 如果讨论是执行性/项目性的，除了结论、事项、负责人、风险、下一步，也要说明这些结论是如何被讨论出来的：背景约束是什么、哪些方案被比较、为什么选择当前路径。
8. 如果讨论很短，只输出最少但有用的内容；如果讨论很长，可以先给阅读指南，再展开。长内容宁可稍长，也不要丢掉关键推理和争论过程。
9. 避免空话、套话和形式主义标题。每个标题都应该有信息量。
10. transcript 中如果出现真实姓名（参考下方 Speaker context），直接用真实姓名；只在没把握时保留 Speaker A/B/C。
11. 不确定或疑似转写错误的词要明确标注，不要当成事实。
12. 默认是 Integrated notes mode：输入 transcript 可能没有经过单独清洗。你必须在生成内容前先在内部完成必要清理和梳理：纠正明显错别字、统一术语、还原 speaker、合并口语重复、修正标点和断句；但不要编造原文没有的信息，也不要把真实的思考过程清洗掉。

输出必须是合法 JSON，不要 markdown fence。

${speakerContextBlock(config.speakers)}`

  const user = `请基于下面 transcript 生成一份“语义整理笔记”。

处理模式：${opts.integratedMode === false ? 'Full mode（会额外生成可读 transcript；但纪要仍应独立完成语义整理）' : 'Integrated notes mode（不做单独 transcript 清洗；请在生成笔记时完成必要清理、纠错、梳理和 speaker 还原）'}

你要服务的阅读场景：
- 石洋以后打开这篇笔记时，应该能立刻知道：这段录音值得看什么、核心思想/事项是什么、这些观点是如何讨论/论证出来的、哪些地方需要理解、哪些问题还没解决、下一步应该做什么。
- 不要假设这一定是“会议”；它可能是自言自语、产品思考、技术讨论、商业判断、学习笔记、灵感记录、电话沟通或执行任务。
- 不要参考飞书/通用会议纪要结构。markdown 的结构由内容语义决定。
- 对多人讨论，笔记要能帮助石洋复盘“过程”：谁提出了什么问题，谁持什么观点，谁质疑了什么，如何回应，哪里发生了转折，最后如何形成共识或保留分歧。
- 如果 transcript 中存在明显的讨论、争论、共同推演、方案比较或观点演化，markdown 正文必须有一个能承载“过程还原”的部分（标题自拟，例如“讨论如何展开”“观点如何演化”“争论与共识形成”），不能只写结论清单。

录音信息：
- 源文件：${rec.sourcePath}
- 本地音频：${localAudioPath}
- 录音文件名推断时间：${rec.recordedAt.toISOString()}
- 文件大小：${rec.sizeBytes} bytes
- 时长：${rec.durationSeconds} seconds

请输出 JSON，字段如下：
{
  "title": "中文标题，尽量表达这段内容的真实主题和价值，不要泛泛写会议纪要",
  "date": "YYYY-MM-DD",
  "start_time": "HH:mm|null",
  "end_time": "HH:mm|null",
  "participants": ["只填写真实识别出的人名（包括用户本人姓名）；不要填写 Speaker A/B"],
  "organizations": ["string"],
  "projects": ["string"],
  "markdown": "完整 markdown 正文。必须从 # 标题 开始。结构完全由你根据语义设计，不要包含底部来源 details，系统会自动追加。",
  "discussion_flow": [{"stage": "讨论阶段/主题", "what_happened": "这一阶段发生了什么", "speaker_positions": [{"speaker": "真实姓名或Speaker标签", "position": "观点/担忧/理由"}], "turning_point": "关键转折或观点变化|null", "outcome": "阶段性共识/分歧/未决|null"}],
  "consensus_points": [{"point": "达成的共识", "how_reached": "这个共识是如何通过讨论/论证形成的|null"}],
  "disagreements": [{"issue": "分歧点", "positions": [{"speaker": "真实姓名或Speaker标签", "position": "立场和理由"}], "status": "resolved|unresolved|partially_resolved|null"}],
  "action_items": [{"task": "string", "owner": "string|null", "due_date": "YYYY-MM-DD|null", "priority": "high|medium|low|null", "note": "string|null"}],
  "decisions": [{"decision": "string", "reason": "string|null", "owner": "string|null", "date": "YYYY-MM-DD|null", "how_reached": "这个决定是如何形成的|null"}],
  "open_questions": [{"question": "string", "next_step": "string|null"}],
  "key_quotes_or_details": ["string"],
  "transcription_uncertainties": ["string"]
}

markdown 质量要求：
- 第一屏要高信噪比：读者不用看完整 transcript，也能知道这段内容为什么值得保留。
- 不要输出空章节；不要输出“无明确记录/未知/未识别”这类占位内容。
- 不要强制包含“总结、待办、智能章节、关键决策、金句”等标题；只有语义上需要时才用。
- 如果有行动项，用具体可执行语言；如果没有明确行动项，不要硬造。
- 如果有思想/判断，写出推理链，而不只是结论。
- 如果有讨论、争论或共同推演，必须保留关键过程：观点提出 → 质疑/补充 → 回应/反驳 → 修正/转向 → 共识/分歧。不要把这个过程压缩成一句“最终认为……”。
- markdown 正文应优先使用自然语言复盘过程，不要只把 discussion_flow/consensus_points/disagreements 当 metadata 填完就结束；这些结构化字段只是辅助你思考和索引。
- 对重要共识，说明它是怎么达成的；对重要分歧，说明谁持什么观点、理由是什么、有没有被解决。
- 如果某个结论经历了方案比较或取舍，写出被比较的方案、判断标准、为什么放弃或选择。
- 如果会议较长，可以按“主题/阶段”复盘，而不是流水账；但每个阶段要保留关键转折点和代表性发言者观点。
- 如果有争议、风险、待验证假设，要明显标出。
- 如果时间戳能帮助回看关键片段，可以少量使用；不要为了形式做完整时间线。
- 如果 transcript 有不确定词，放在上下文里提醒读者，不要把不确定词当事实。
- Integrated notes mode 下尤其要避免把原始转写里的口吃、重复、错别字直接搬进笔记；正文应呈现清理和梳理后的内容，同时保留真实的推理、争论和观点演化。

Transcript：
${transcript}`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// ───────────────────────────────────────────────────────────────────────
// LLM backend dispatcher: openai (API key) | pi-codex (ChatGPT Plus via pi)
// ───────────────────────────────────────────────────────────────────────

type LlmBackend = 'openai' | 'pi-codex'

function getLlmBackend(): LlmBackend {
  const v = (process.env.VOICENOTE_LLM_PROVIDER || 'pi-codex').toLowerCase()
  return v === 'openai' ? 'openai' : 'pi-codex'
}

function piCodexBin(): string {
  return process.env.VOICENOTE_PI_BIN || 'pi'
}

// Heuristic for "pi is logged in": the OAuth credential file exists. Used to skip
// the pipeline before spending ASR on notes whose pi-codex summary would fail.
function piAuthAvailable(): boolean {
  return existsSync(join(os.homedir(), '.pi', 'agent', 'auth.json'))
}

function piCodexModelFor(role: 'summary' | 'reconcile'): string {
  if (role === 'summary') return process.env.VOICENOTE_PI_MODEL_SUMMARY || process.env.VOICENOTE_PI_MODEL || 'gpt-5.5'
  return process.env.VOICENOTE_PI_MODEL_RECONCILE || process.env.VOICENOTE_PI_MODEL || 'gpt-5.5'
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  if (fence) return fence[1]!.trim()
  return trimmed
}

function extractFirstJsonObject(text: string): string {
  const trimmed = stripJsonFences(text)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  // Find the first balanced {...}
  let depth = 0, start = -1, inString = false, escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) return trimmed.slice(start, i + 1) }
  }
  return trimmed
}

async function chatCompleteViaPiCodex(opts: {
  systemPrompt: string
  userPrompt: string
  model: string
  timeoutMs?: number
  thinking?: string
  tools?: string  // e.g. 'read,grep'; empty/undefined = --no-tools
  appendSystemPrompt?: string
  cwd?: string  // agent working dir: the knowledge base, so read/grep/find default there
}): Promise<string> {
  const args = [
    '-p',
    '--provider', 'openai-codex',
    '--model', opts.model,
    '--mode', 'text',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-session', '--no-prompt-templates', '--no-themes',
    '--system-prompt', opts.systemPrompt,
  ]
  if (opts.thinking) args.push('--thinking', opts.thinking)
  if (opts.tools && opts.tools.trim()) args.push('--tools', opts.tools.trim())
  else args.push('--no-tools')
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
  return new Promise<string>((resolve, reject) => {
    const child = spawn(piCodexBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd })
    let stdout = '', stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', d => stdout += String(d))
    child.stderr.on('data', d => stderr += String(d))
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code !== 0) return reject(new Error(`pi codex exited ${code}: ${(stderr || stdout).slice(0, 800)}`))
      const text = stdout.trim()
      if (!text) return reject(new Error('pi codex returned empty output'))
      resolve(text)
    })
    child.stdin.end(opts.userPrompt)
  })
}

function piThinkingLevel(): string {
  return process.env.VOICENOTE_PI_THINKING || 'high'
}

function piSummaryTools(): string {
  // Default ON: let the summary model read/grep prior notes for cross-reference consistency.
  // Set VOICENOTE_PI_SUMMARY_TOOLS='' (empty) to disable.
  const v = process.env.VOICENOTE_PI_SUMMARY_TOOLS
  if (v === undefined) return 'read,grep'
  return v.trim()
}

function summaryContextDir(config: Config): string {
  // Directory the summary model may read/grep for cross-reference consistency.
  // Defaults to the workspace itself (your prior notes); override with
  // VOICENOTE_CONTEXT_DIR to point at a wider knowledge tree (e.g. a vault).
  return expandHome(process.env.VOICENOTE_CONTEXT_DIR || config.workspace)
}

function piSummaryToolsHint(contextDir: string): string {
  return `你在写纪要前有 read 和 grep 两个只读工具可用。你的当前工作目录（cwd）就是 \`${contextDir}\`（你既往的纪要/资料），可直接用相对路径 grep/read。\n\n用途：保持人名、项目名、术语与既往纪要一致；识别本次 transcript 中模糊提到、名字不全的人或项目；补充本次讨论明显相关的背景。\n\n约束：\n- 总共最多 10 次工具调用；如果 transcript 本身信息足够，可完全不调用。\n- 只读 \`${contextDir}\` 范围内的内容；跳过明显涉及个人隐私/凭证/财务的目录（如 identity / credentials / finance 等）。\n- 查到的信息仅用于一致性；不要把未在本次 transcript 中出现的内容当作事实写进纪要。\n- 不要尝试写文件或调用 bash（这些工具并未启用）。`
}

async function chatComplete(opts: {
  systemPrompt: string
  userPrompt: string
  jsonResponse?: boolean
  role: 'summary' | 'reconcile'
  // openai fallback config
  config: Config
  openaiModel: string
}): Promise<string> {
  const backend = getLlmBackend()
  if (backend === 'pi-codex') {
    // Reconcile is a mechanical chunk-merge task; don't enable tools or extra thinking.
    const isSummary = opts.role === 'summary'
    // The summary agent's working dir IS the knowledge base, so read/grep/find
    // operate there directly. If a configured context dir is missing, say so
    // loudly and run without it rather than silently searching the wrong place.
    const wantTools = isSummary && !!piSummaryTools()
    const ctx = wantTools ? summaryContextDir(opts.config) : undefined
    const ctxExists = ctx ? existsSync(ctx) : false
    if (ctx && !ctxExists) console.error(`Warning: context dir ${ctx} does not exist; summary agent runs WITHOUT read/grep cross-reference.`)
    // Tools, the cwd hint, and the spawn cwd must move together: if the context
    // dir is missing we disable tools entirely, otherwise the agent would keep
    // read/grep enabled while sitting in the launchd WorkingDirectory ($HOME)
    // and grep the wrong tree.
    const toolsActive = wantTools && ctxExists
    return chatCompleteViaPiCodex({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      model: piCodexModelFor(opts.role),
      timeoutMs: 60 * 60 * 1000,
      thinking: isSummary ? piThinkingLevel() : undefined,
      tools: toolsActive ? piSummaryTools() : undefined,
      appendSystemPrompt: toolsActive ? piSummaryToolsHint(ctx!) : undefined,
      cwd: toolsActive ? ctx : undefined,
    })
  }
  const client = openaiClient(opts.config)
  const req: any = {
    model: opts.openaiModel,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ],
  }
  if (opts.jsonResponse) req.response_format = { type: 'json_object' }
  if (!opts.openaiModel.toLowerCase().startsWith('gpt-5')) req.temperature = opts.role === 'summary' ? 0.2 : 0
  const completion = await client.chat.completions.create(req)
  return completion.choices[0]?.message?.content || ''
}

async function summarizeTranscript(config: Config, transcript: string, rec: Recording, localAudioPath: string, opts: { integratedMode?: boolean } = {}): Promise<Json> {
  const messages = summaryMessages(config, transcript, rec, localAudioPath, opts)
  const systemPrompt = String(messages[0]!.content)
  const userPrompt = String(messages[1]!.content)
  const text = await chatComplete({
    systemPrompt,
    userPrompt,
    jsonResponse: true,
    role: 'summary',
    config,
    openaiModel: config.summaryModel,
  })
  const jsonText = extractFirstJsonObject(text)
  try {
    return JSON.parse(jsonText || '{}')
  } catch (e: any) {
    throw new Error(`summary returned non-JSON output (${e?.message || e}). First 400 chars: ${text.slice(0, 400)}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata + markdown
// ────────────────────────────────────────────────────────────────────────────

function isSpeakerLabel(text: string): boolean {
  return /^\s*speaker\s+[a-z]\s*$/i.test(text) || /^\s*说话人\s*[A-ZＡ-Ｚa-zａ-ｚ一二三四五六七八九十0-9]+\s*$/.test(text)
}

function normalizeMetadata(meta: Json, rec: Recording): Json {
  const d = rec.recordedAt
  meta.date ||= `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  meta.start_time ||= `${pad(d.getHours())}:${pad(d.getMinutes())}`
  meta.end_time ??= null
  for (const key of ['participants', 'organizations', 'projects', 'discussion_flow', 'consensus_points', 'disagreements', 'action_items', 'decisions', 'open_questions', 'key_quotes_or_details', 'transcription_uncertainties']) {
    if (!Array.isArray(meta[key])) meta[key] = []
  }
  meta.participants = meta.participants.filter((p: any) => typeof p === 'string' && p.trim() && !isSpeakerLabel(p))
  return meta
}

function sourceDetails(meta: Json, audioPath: string, transcriptPath: string): string {
  return `<details>\n<summary>来源信息</summary>\n\n- 纪要生成来源：voicenote 自动转写\n- 原始音频：\`${audioPath}\`\n- 完整转写：\`${transcriptPath}\`\n\n</details>`
}

function markdownNotes(meta: Json, audioPath: string, transcriptPath: string): string {
  let body = typeof meta.markdown === 'string' && meta.markdown.trim() ? meta.markdown.trim() : `# ${meta.title || '未命名录音纪要'}\n`
  if (!body.startsWith('#')) body = `# ${meta.title || '未命名录音纪要'}\n\n${body}`
  if (!body.includes('来源信息')) body = `${body.trim()}\n\n${sourceDetails(meta, audioPath, transcriptPath)}`
  return `${body.trim()}\n`
}

async function markdownToPdf(markdownPath: string): Promise<string> {
  const pdfPath = markdownPath.replace(/\.md$/i, '.pdf')
  const tempBase = join(os.tmpdir(), `voicenote-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const htmlPath = `${tempBase}.html`
  const cssPath = `${tempBase}.css`
  const css = `
:root { color-scheme: light; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; line-height: 1.68; color: #1f2328; max-width: 860px; margin: 40px auto; padding: 0 32px; font-size: 15px; }
h1, h2, h3 { line-height: 1.32; margin-top: 1.8em; color: #111827; }
h1 { font-size: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
h2 { font-size: 22px; border-bottom: 1px solid #eef2f7; padding-bottom: 6px; }
h3 { font-size: 18px; }
p, ul, ol, blockquote, table { margin: 0.9em 0; }
blockquote { border-left: 4px solid #d0d7de; padding-left: 16px; color: #57606a; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #f6f8fa; padding: 0.15em 0.35em; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 8px 10px; vertical-align: top; }
th { background: #f6f8fa; }
details { margin-top: 2em; color: #57606a; font-size: 13px; }
@page { size: A4; margin: 18mm 16mm; }
@media print { body { margin: 0; padding: 0; max-width: none; } h1, h2, h3 { break-after: avoid; } table, blockquote { break-inside: avoid; } }
`
  await writeFile(cssPath, css, 'utf8')
  try {
    const title = basename(markdownPath, extname(markdownPath))
    const pandoc = await runCommand('pandoc', [markdownPath, '--from', 'markdown+smart', '--to', 'html5', '--standalone', '--metadata', `title=${title}`, '--css', cssPath, '-o', htmlPath], 120000)
    if (pandoc.code !== 0) throw new Error(`pandoc failed: ${pandoc.stderr || pandoc.stdout}`)
    const chromePath = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
    const chrome = await runCommand(chromePath, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], 120000)
    if (chrome.code !== 0 || !existsSync(pdfPath)) throw new Error(`chrome pdf failed: ${chrome.stderr || chrome.stdout}`)
    return pdfPath
  } finally {
    await unlink(htmlPath).catch(() => {})
    await unlink(cssPath).catch(() => {})
  }
}

function transcriptMarkdown(config: Config, rec: Recording, transcript: string, rawTranscript?: string, opts: { mode?: RunMode; transcribeStrategy?: string } = {}): string {
  const raw = rawTranscript && rawTranscript.trim() !== transcript.trim() ? `\n\n---\n\n## 原始/分块转写\n\n${rawTranscript.trim()}\n` : ''
  const transcribeBackend = config.asrProvider === 'volcano'
    ? `volcano 豆包 (资源为 ${config.volcano?.resourceId || 'volc.seedasr.auc'})`
    : `openai (模型 ${config.transcribeModel})`
  const reconcileNote = opts.transcribeStrategy === 'turbo' && config.asrProvider === 'openai'
    ? `分块 reconciliation 模型：\`${config.reconcileModel}\`\n`
    : ''
  return `# 录音转写：${basename(rec.sourcePath)}\n\n- 源文件：\`${rec.sourcePath}\`\n- ASR 提供商：${config.asrProvider}\n- 转写后端：${transcribeBackend}\n${reconcileNote}- 处理模式：${opts.mode || 'notes'}\n- 转写策略：${opts.transcribeStrategy || 'auto'}\n- 录音时间：${rec.recordedAt.toISOString()}\n- 文件大小：${rec.sizeBytes} bytes\n- 时长：${rec.durationSeconds ?? '未知'} seconds\n- 转写时间：${nowIso()}\n\n---\n\n## 原始/合并 transcript（不做 lossy 清洗）\n\n${transcript.trim()}${raw}`
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline
// ────────────────────────────────────────────────────────────────────────────

async function processRecording(config: Config, rec: Recording, opts: any): Promise<Json> {
  const jobStarted = Date.now()
  let files = initialLocalFiles(config, rec)
  const mode = normalizeRunMode(opts)
  const requestedTranscribe = normalizeTranscribeStrategy(opts)
  const strategy = chooseTranscribeStrategy(config, rec, requestedTranscribe)
  const needsNotes = mode === 'notes'
  const transcribeBackendLabel = config.asrProvider === 'volcano'
    ? `volcano:${config.volcano?.resourceId || 'volc.seedasr.auc'}`
    : `openai:${config.transcribeModel}`
  const llmBackend = getLlmBackend()

  console.log(`\n=== voicenote job: ${basename(rec.sourcePath)} ===`)
  console.log(`Source: ${rec.sourcePath}`)
  console.log(`Audio: duration=${rec.durationSeconds == null ? 'unknown' : formatSeconds(rec.durationSeconds)}, size=${formatBytes(rec.sizeBytes)}, mode=${mode}, asr=${transcribeBackendLabel}, transcribe=${requestedTranscribe}${requestedTranscribe === 'auto' ? `→${strategy}` : ''}, llm=${llmBackend}`)
  console.log(`Plan: copy audio → ${strategy === 'turbo' ? 'turbo transcribe + chunk reconciliation' : 'transcribe'} → write transcript${needsNotes ? ' → integrated semantic notes' : ''} → write metadata/index (no auto move)`)
  if (config.asrProvider === 'volcano' && requestedTranscribe === 'turbo') console.log('Volcano: ignoring --transcribe turbo because Volcano natively handles long audio.')
  if (opts.dryRun) return { source_path: rec.sourcePath, source_id: rec.sourceId, would_copy_to: files.audio, size_bytes: rec.sizeBytes, duration_seconds: rec.durationSeconds, mode, transcribe: requestedTranscribe }

  const totalSteps = needsNotes ? 4 : 3
  let stepNo = 0
  const nextStep = () => ++stepNo

  progressStep(nextStep(), totalSteps, 'Copy audio to workspace', files.audio)
  await mkdir(dirname(files.audio), { recursive: true })
  await copyFile(rec.sourcePath, files.audio)
  console.log(`✓ Local audio ready: ${files.audio}`)

  let rawTranscript: string | undefined
  let transcript = ''
  let meta: Json = {
    title: basename(rec.sourcePath, extname(rec.sourcePath)),
    markdown: '',
  }
  let turboInfo: any = null

  if (strategy === 'turbo') {
    progressStep(nextStep(), totalSteps, 'Turbo transcribe + chunk reconciliation', `model=${config.transcribeModel}; chunks are processed in parallel`)
    const turbo = await transcribeAudioTurbo(config, files.audio, rec)
    rawTranscript = turbo.rawMerged
    transcript = turbo.transcript
    turboInfo = {
      chunk_seconds: config.turboChunkSeconds,
      overlap_seconds: config.turboOverlapSeconds,
      concurrency: config.turboConcurrency,
      chunks: turbo.chunks.map(c => ({ index: c.index, start: c.start, duration: c.duration })),
    }
  } else {
    progressStep(nextStep(), totalSteps, 'Transcribe audio', transcribeBackendLabel)
    rawTranscript = await withHeartbeat('transcribe audio', () => transcribeAudio(config, files.audio, rec), 90)
    transcript = rawTranscript
  }

  // Persist transcript IMMEDIATELY so an expensive ASR result is never lost
  // if a later step (summary) blows up. We use the initial (untitled) path;
  // if summary succeeds we'll move it to the titled path below.
  await mkdir(dirname(files.transcript), { recursive: true })
  await writeFile(files.transcript, transcriptMarkdown(config, rec, transcript, rawTranscript, { mode, transcribeStrategy: strategy }), 'utf8')
  console.log(`✓ Transcript saved: ${files.transcript}`)

  let summaryError: any = null
  if (needsNotes) {
    progressStep(nextStep(), totalSteps, 'Generate integrated semantic notes', `model=${config.summaryModel} via ${llmBackend}`)
    try {
      meta = await withHeartbeat('generate integrated semantic notes', () => summarizeTranscript(config, transcript, rec, files.audio, { integratedMode: true }), 60)
    } catch (e: any) {
      summaryError = e
      console.error(`Summary step failed; transcript is preserved. Error: ${e?.message || e}`)
      console.error(`Hint: fix LLM credits, then re-run with: vn forget ${basename(rec.sourcePath)} && vn run --latest`)
    }
  }

  meta = normalizeMetadata(meta, rec)
  meta.processing_mode = mode
  meta.transcribe_strategy = strategy
  if (turboInfo) meta.turbo = turboInfo
  meta.source_audio_path = rec.sourcePath
  meta.source_id = rec.sourceId
  meta.source_size_bytes = rec.sizeBytes
  meta.source_modified_at = rec.modifiedAt
  meta.duration_seconds = rec.durationSeconds
  meta.asr_provider = config.asrProvider
  meta.transcribe_model = config.asrProvider === 'volcano' ? config.volcano?.resourceId || 'volc.seedasr.auc' : config.transcribeModel
  meta.transcript_reconcile_model = strategy === 'turbo' && config.asrProvider === 'openai' ? config.reconcileModel : null
  meta.summary_model = needsNotes && !summaryError ? config.summaryModel : null
  meta.llm_backend = needsNotes ? llmBackend : null
  meta.processed_at = nowIso()
  if (summaryError) meta.summary_error = String(summaryError?.message || summaryError)

  progressStep(nextStep(), totalSteps, 'Write outputs and index')
  if (needsNotes && !summaryError) {
    const titled = await titledLocalFiles(config, rec, meta, files)
    // titledLocalFiles renames the audio; manually move our already-written transcript too.
    if (titled.transcript !== files.transcript && existsSync(files.transcript)) {
      await mkdir(dirname(titled.transcript), { recursive: true })
      if (existsSync(titled.transcript)) await unlink(titled.transcript)
      await rename(files.transcript, titled.transcript)
    }
    files = titled
  }
  await mkdir(dirname(files.notes), { recursive: true })
  await mkdir(dirname(files.metadata), { recursive: true })

  if (needsNotes && !summaryError) {
    await writeFile(files.notes, markdownNotes(meta, files.audio, files.transcript), 'utf8')
    console.log(`✓ Notes: ${files.notes}`)
    if (opts.pdf) {
      const pdf = await withHeartbeat('render notes PDF', () => markdownToPdf(files.notes), 30)
      meta.local_paths = { ...files, pdf }
      console.log(`✓ PDF: ${pdf}`)
    }
  } else if (needsNotes && summaryError) {
    const stubBody = `# 待补纪要：${basename(rec.sourcePath)}\n\n> ⚠ 转写已完成并保存，但纪要生成阶段失败，需人工重试。\n\n- 转写文件：\`${files.transcript}\`\n- 原始音频：\`${rec.sourcePath}\`\n- 失败原因：${meta.summary_error}\n- 重试命令：\`vn forget ${basename(rec.sourcePath)} && vn run --latest\`\n`
    await writeFile(files.notes, stubBody, 'utf8')
    console.log(`⚠ Stub notes (summary failed): ${files.notes}`)
  } else if (opts.pdf) {
    console.log('PDF skipped: --pdf only applies to --mode notes.')
  }

  meta.local_paths = { ...files, ...(meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}) }
  meta.final_paths = {
    audio: files.audio,
    transcript: files.transcript,
    notes: needsNotes ? files.notes : null,
    metadata: files.metadata,
    ...(meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}),
  }

  if (summaryError) {
    meta.status = 'summary_failed_transcript_saved'
  } else if (needsNotes) {
    meta.status = 'completed'
  } else {
    meta.status = 'transcript_only'
  }

  await writeJson(files.metadata, meta)
  await appendJsonl(join(config.workspace, '_index', 'meetings.jsonl'), meta)
  console.log(`✓ Completed: ${meta.title || basename(rec.sourcePath)} (${formatElapsed(Date.now() - jobStarted)} total)`)
  if (needsNotes) console.log(`Final notes: ${files.notes}`)
  else console.log(`Final transcript: ${files.transcript}`)
  return meta
}

async function runPipeline(opts: any): Promise<void> {
  wireDailyLog()
  if (opts.asr) process.env.VOICENOTE_ASR_PROVIDER = String(opts.asr).toLowerCase()
  if (opts.llm) process.env.VOICENOTE_LLM_PROVIDER = String(opts.llm).toLowerCase()
  const config = getConfig()
  const lock = await acquireRunLock()
  if (!lock) {
    console.log('voicenote pipeline already running; skip')
    return
  }
  try {
    await runPipelineLocked(config, opts)
  } finally {
    await lock.release()
  }
}

async function runPipelineLocked(config: Config, opts: any): Promise<void> {
  await ensureDirs(config)
  const statePath = join(config.workspace, '_state', 'processed.json')
  const state = await readJson<Json>(statePath, { processed_source_ids: {}, skipped_source_ids: {} })
  state.processed_source_ids ||= {}
  state.skipped_source_ids ||= {}

  if (!existsSync(config.recordDir)) {
    if (shouldLogIdleStatus(`missing:${config.recordDir}`)) {
      console.log(`Idle: recorder not mounted or record dir missing: ${config.recordDir} (repeated idle logs suppressed for 30m)`)
    }
    return
  }
  const recordings = await scanRecordings(config)
  const eligible: Recording[] = []
  const skipCounts: Record<string, number> = {}
  const skipSamples: Record<string, string[]> = {}
  const verboseSkips = Boolean(opts.verbose || opts.dryRun)
  for (const rec of recordings) {
    const [skip, reason] = shouldSkip(rec, state, config, Boolean(opts.force))
    if (skip) {
      const reasonKey = reason.split(':')[0] || reason
      skipCounts[reasonKey] = (skipCounts[reasonKey] || 0) + 1
      ;(skipSamples[reasonKey] ||= []).push(basename(rec.sourcePath))
      if (!state.skipped_source_ids[rec.sourceId] && reason !== 'already_processed') {
        state.skipped_source_ids[rec.sourceId] = { source_path: rec.sourcePath, reason, size_bytes: rec.sizeBytes, duration_seconds: rec.durationSeconds, seen_at: nowIso() }
      }
      if (verboseSkips) console.log(`  Skip: ${basename(rec.sourcePath)} (${reason})`)
    } else eligible.push(rec)
  }
  const skipSummary = Object.entries(skipCounts).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'
  const scanLine = `Scan summary: found=${recordings.length}; eligible=${eligible.length}; skipped=${recordings.length - eligible.length} (${skipSummary})`
  const samplesLine = !verboseSkips && Object.keys(skipSamples).length
    ? `Skipped samples: ${Object.entries(skipSamples).map(([reason, names]) => `${reason}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? `…(+${names.length - 3})` : ''}`).join(' | ')}`
    : ''
  const latestOnly = Boolean(opts.latest)
  const targets = latestOnly ? eligible.slice(0, 1) : eligible
  // Preflight: if there is work but the run cannot complete, skip BEFORE spending
  // ASR money, rather than failing per-recording on every 60s StartInterval tick.
  // Idle-suppressed so a misconfigured daemon doesn't spam logs. Skipped for
  // --dry-run, which is a zero-side-effect diagnostic and should still print the
  // plan even on an unconfigured machine.
  if (targets.length && !opts.dryRun) {
    if (config.asrProvider === 'volcano' && !config.volcano) {
      if (shouldLogIdleStatus(`asr-misconfig:${config.recordDir}`)) console.error('ASR not configured: Volcano needs VOLCANO_ASR_KEY / VOLCANO_TOS_*. Skipping; run `vn doctor`, fix config, then re-run.')
      return
    }
    if (normalizeRunMode(opts) === 'notes' && getLlmBackend() === 'pi-codex' && !piAuthAvailable()) {
      if (shouldLogIdleStatus(`pi-noauth:${config.recordDir}`)) console.error('pi-codex summary backend selected but pi is not logged in (~/.pi/agent/auth.json missing). Skipping to avoid spending ASR on notes that would fail. Run `pi` to log in, then re-run.')
      return
    }
  }
  if (!targets.length) {
    if (verboseSkips || shouldLogIdleStatus(`idle:${config.recordDir}:${recordings.length}:${skipSummary}:${samplesLine}`)) {
      console.log(scanLine)
      if (samplesLine) console.log(samplesLine)
      console.log('Idle: no new recordings to process. (repeated idle logs suppressed for 30m)')
    }
  } else {
    console.log(scanLine)
    if (samplesLine) console.log(samplesLine)
    console.log(`Queue: processing ${targets.length} recording(s)${latestOnly ? ' (--latest)' : ''}. Remaining after this run: ${Math.max(0, eligible.length - targets.length)}`)
  }
  for (const rec of targets) {
    try {
      const result = await processRecording(config, rec, opts)
      if (!opts.dryRun) {
        state.processed_source_ids[rec.sourceId] = { source_path: rec.sourcePath, processed_at: nowIso(), status: result.status, title: result.title, final_paths: result.final_paths }
        delete state.skipped_source_ids[rec.sourceId]
      }
    } catch (e: any) {
      console.error(`ERROR processing ${rec.sourcePath}: ${e?.message || e}`)
      state.skipped_source_ids[rec.sourceId] = { source_path: rec.sourcePath, reason: `error:${e?.message || e}`, seen_at: nowIso() }
    }
  }
  if (!opts.dryRun) await writeJson(statePath, state)
}

// ────────────────────────────────────────────────────────────────────────────
// LaunchAgent
// ────────────────────────────────────────────────────────────────────────────

function plistPath(): string {
  return join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Pulled in for `vn install-launch-agent`. launchd does NOT inherit your zsh
// environment, so anything the pipeline needs (API key, proxy, etc.) has to
// be written into the plist's EnvironmentVariables.
async function launchAgentEnv(): Promise<Record<string, string>> {
  loadDotZshrcEnv()
  const env: Record<string, string> = {
    PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  for (const k of ENV_KEYS) {
    const v = process.env[k]
    // Embed explicitly-set values, including empty strings: VOICENOTE_PI_SUMMARY_TOOLS=""
    // is a meaningful "disable tools" signal that a truthy check would silently drop.
    if (v !== undefined) env[k] = v
  }
  // Embed pi's absolute path so launchd resolves it regardless of the fixed plist
  // PATH (npm global bin can live outside it under nvm / custom prefixes).
  if (!env.VOICENOTE_PI_BIN && getLlmBackend() === 'pi-codex') {
    const w = await runCommand('which', ['pi'], 5000)
    const p = w.code === 0 ? (w.stdout.trim().split('\n')[0] || '') : ''
    if (p && existsSync(p)) env.VOICENOTE_PI_BIN = p
  }
  return env
}

async function installLaunchAgent(): Promise<void> {
  const cliPath = fileURLToPath(import.meta.url)
  const plist = plistPath()
  await mkdir(dirname(plist), { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  const bunPath = existsSync('/opt/homebrew/bin/bun') ? '/opt/homebrew/bin/bun' : process.execPath
  const env = await launchAgentEnv()
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n')
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${cliPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.err.log</string>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>
`
  await writeFile(plist, content, 'utf8')
  const summary = Object.keys(env).join(', ')
  console.log(`LaunchAgent written: ${plist}`)
  console.log(`Embedded env keys: ${summary}`)
  console.log(`Enable with: launchctl bootstrap gui/$(id -u) ${plist}`)
}

async function uninstallLaunchAgent(): Promise<void> {
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath()], 10000)
  console.log(`Bootout attempted: ${plistPath()}`)
}

// ────────────────────────────────────────────────────────────────────────────
// Browse / debug commands
// ────────────────────────────────────────────────────────────────────────────

async function listMeetings(opts: { month?: string }): Promise<void> {
  const config = getConfig()
  const month = opts.month || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`
  const dir = join(config.workspace, month)
  if (!existsSync(dir)) {
    console.log(`No meetings in ${dir}`)
    return
  }
  const entries = (await readdir(dir)).filter(f => f.endsWith('.md')).sort()
  if (!entries.length) {
    console.log(`No meetings in ${dir}`)
    return
  }
  for (const name of entries) {
    console.log(join(dir, name))
  }
}

async function lastMeeting(): Promise<void> {
  const config = getConfig()
  const indexPath = join(config.workspace, '_index', 'meetings.jsonl')
  if (!existsSync(indexPath)) {
    console.log('No meetings indexed yet.')
    return
  }
  const lines = (await readFile(indexPath, 'utf8')).trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) {
    console.log('No meetings indexed yet.')
    return
  }
  let obj: Json
  try { obj = JSON.parse(last) } catch { console.log(last); return }
  console.log(`Title:        ${obj.title}`)
  console.log(`Date:         ${obj.date} ${obj.start_time || ''}-${obj.end_time || ''}`)
  console.log(`Status:       ${obj.status || 'unknown'}`)
  console.log(`Notes:        ${obj.final_paths?.notes || obj.local_paths?.notes}`)
  console.log(`Transcript:   ${obj.final_paths?.transcript || obj.local_paths?.transcript}`)
  console.log(`Audio:        ${obj.final_paths?.audio || obj.local_paths?.audio}`)
}


async function openTarget(arg?: string): Promise<void> {
  const config = getConfig()
  let target = config.workspace
  if (arg === 'config') {
    target = CONFIG_DIR
  } else if (arg === 'logs') {
    target = LOG_DIR
  } else if (arg) {
    // Try matching most recent file in current month containing arg.
    const month = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`
    const dir = join(config.workspace, month)
    if (existsSync(dir)) {
      const matches = (await readdir(dir)).filter(f => f.includes(arg) && f.endsWith('.md'))
      if (matches.length) target = join(dir, matches[matches.length - 1]!)
    }
  }
  await runCommand('open', [target], 5000)
  console.log(`open ${target}`)
}

async function forgetRecording(needle: string): Promise<void> {
  const config = getConfig()
  const statePath = join(config.workspace, '_state', 'processed.json')
  const state = await readJson<Json>(statePath, { processed_source_ids: {}, skipped_source_ids: {} })
  let removed = 0
  for (const bucket of ['processed_source_ids', 'skipped_source_ids']) {
    for (const id of Object.keys(state[bucket] || {})) {
      const entry = state[bucket][id]
      if (id === needle || entry?.source_path?.includes(needle)) {
        delete state[bucket][id]
        removed++
      }
    }
  }
  await writeJson(statePath, state)
  console.log(`forgot ${removed} record(s)`)
}

async function showErrors(opts: { lines?: number }): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    console.log('No logs.')
    return
  }
  const files = (await readdir(LOG_DIR)).filter(f => f.endsWith('.log')).sort().slice(-3)
  const lineCount = Number(opts.lines || 20)
  const errors: string[] = []
  for (const f of files) {
    const content = await readFile(join(LOG_DIR, f), 'utf8').catch(() => '')
    for (const line of content.split('\n')) {
      if (line.includes('[ERROR]') || line.includes('ERROR processing')) errors.push(line)
    }
  }
  for (const line of errors.slice(-lineCount)) console.log(line)
}

async function upgradeSelf(): Promise<void> {
  const cmd = existsSync('/opt/homebrew/bin/bun') ? '/opt/homebrew/bin/bun' : 'bun'
  console.log(`$ ${cmd} remove -g @kid7st/voicenote || true`)
  await new Promise<void>(res => spawn(cmd, ['remove', '-g', '@kid7st/voicenote'], { stdio: 'inherit' }).on('close', () => res()))
  console.log(`$ ${cmd} add -g git+https://github.com/kid7st/voicenote.git#main`)
  const addCode = await new Promise<number>(res =>
    spawn(cmd, ['add', '-g', 'git+https://github.com/kid7st/voicenote.git#main'], { stdio: 'inherit' })
      .on('close', c => res(c ?? 1)).on('error', () => res(1)))
  if (addCode !== 0) {
    console.error(`Upgrade failed: \`${cmd} add -g\` exited ${addCode}. The previous global install was already removed and may be gone; re-run \`vn upgrade\` (or the install command) to repair.`)
    process.exitCode = 1
    return
  }
  // Refresh the LaunchAgent plist so its embedded env + cliPath track the new
  // version. This process is still the OLD code in memory, so invoke the freshly
  // installed binary to regenerate, then reload.
  if (existsSync(plistPath())) {
    console.log('Refreshing LaunchAgent plist for the upgraded version…')
    const code = await new Promise<number>(res =>
      spawn('vn', ['install-launch-agent'], { stdio: 'inherit' })
        .on('close', c => res(c ?? 1)).on('error', () => res(1)))
    if (code !== 0) {
      console.error(`Warning: \`vn install-launch-agent\` failed (exit ${code}); the LaunchAgent still points at the previous version. Ensure vn is on PATH and re-run \`vn install-launch-agent\`.`)
      return
    }
    const uid = process.getuid?.()
    await runCommand('launchctl', ['bootout', `gui/${uid}`, plistPath()], 10000)   // ok if not currently loaded
    const bs = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, plistPath()], 10000)
    if (bs.code !== 0) {
      console.error(`Warning: launchctl bootstrap failed: ${(bs.stderr || bs.stdout).trim()}. Reload manually: launchctl bootstrap gui/$(id -u) ${plistPath()}`)
      return
    }
    console.log('LaunchAgent reloaded.')
  }
}

async function watchLoop(opts: { interval?: number }): Promise<void> {
  const interval = Number(opts.interval || 60) * 1000
  for (;;) {
    await runPipeline({})
    await new Promise(res => setTimeout(res, interval))
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Doctor
// ────────────────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const config = getConfig()
  console.log(`version=${VERSION}`)
  console.log(`bun=${process.versions.bun || 'not-bun'}`)
  console.log(`node=${process.version}`)
  console.log(`recordDir=${config.recordDir} exists=${existsSync(config.recordDir)}`)
  console.log(`workspace=${config.workspace}`)
  console.log(`asrProvider=${config.asrProvider}`)
  if (config.volcano) {
    const auth = config.volcano.appKey && config.volcano.accessKey ? 'old-console (X-Api-App-Key + X-Api-Access-Key)' : config.volcano.apiKey ? 'new-console (X-Api-Key)' : 'missing'
    console.log(`volcano.auth=${auth}`)
    console.log(`volcano.resourceId=${config.volcano.resourceId}`)
    console.log(`volcano.tos=bucket:${config.volcano.tos.bucket} region:${config.volcano.tos.region} endpoint:${config.volcano.tos.endpoint} keep:${config.volcano.tos.keep}`)
    console.log(`volcano.tos.accessKey=${config.volcano.tos.accessKey ? 'loaded' : 'missing'} secretKey=${config.volcano.tos.secretKey ? 'loaded' : 'missing'}`)
    if (config.volcano.language) console.log(`volcano.language=${config.volcano.language}`)
  } else {
    console.log(`volcano=not configured`)
  }
  const openaiNeeded = config.asrProvider === 'openai' || getLlmBackend() === 'openai'
  console.log(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? 'loaded' : (openaiNeeded ? 'MISSING (required by current --asr/--llm openai)' : 'missing (optional; only for --asr/--llm openai)')}`)
  console.log(`llmBackend=${getLlmBackend()} (env VOICENOTE_LLM_PROVIDER=${process.env.VOICENOTE_LLM_PROVIDER || '<unset>'})`)
  if (getLlmBackend() === 'pi-codex') {
    console.log(`pi.bin=${piCodexBin()} model.summary=${piCodexModelFor('summary')} model.reconcile=${piCodexModelFor('reconcile')}`)
    console.log(`pi.thinking=${piThinkingLevel()} (summary only)`)
    const tools = piSummaryTools()
    console.log(`pi.summaryTools=${tools || '<disabled>'} (summary only; reconcile always --no-tools)`)
    if (tools) console.log(`pi.contextDir=${summaryContextDir(config)} (summary agent cwd + read/grep cross-reference root)`)
    // pi is a bun-based CLI; cold start (esp. behind a proxy) can take >5s, so
    // give --version a generous timeout to avoid a false 'missing' on a healthy pi.
    const piCheck = await runCommand(piCodexBin(), ['--version'], 15000)
    const piVer = (piCheck.stdout.trim() || piCheck.stderr.trim()) || 'missing'
    console.log(`pi.version=${piCheck.code === 0 ? piVer : 'missing'}`)
    console.log(`pi.auth=${piAuthAvailable() ? 'logged-in' : 'NOT logged-in — run `pi` to sign in, else the summary step will fail'}`)
  }
  console.log(`transcribeModel=${config.transcribeModel} (used when --asr openai)`)
  console.log(`reconcileModel=${config.reconcileModel} (used for OpenAI turbo chunk reconciliation)`)
  console.log(`summaryModel=${config.summaryModel}`)
  console.log(`defaultMode=notes`)
  console.log(`defaultTranscribe=auto${config.asrProvider === 'volcano' ? ' (volcano always single)' : ` (turbo if duration >= ${config.turboMinDurationSeconds}s)`}`)
  console.log(`turbo=chunk:${config.turboChunkSeconds}s overlap:${config.turboOverlapSeconds}s concurrency:${config.turboConcurrency}`)
  console.log(`http_proxy=${process.env.http_proxy || '<unset>'}`)
  console.log(`speakers.self=${config.speakers.self.name || '<unset>'}`)
  console.log(`speakers.known=${config.speakers.known.length}`)
  console.log(`launch_agent_plist=${plistPath()}`)
  const ff = await runCommand('ffprobe', ['-version'], 5000)
  console.log(`ffprobe=${ff.code === 0 ? 'ok' : 'missing'}`)
  const ffmpeg = await runCommand('ffmpeg', ['-version'], 5000)
  console.log(`ffmpeg=${ffmpeg.code === 0 ? 'ok' : 'missing'}`)
}

// ────────────────────────────────────────────────────────────────────────────
// CLI commands
// ────────────────────────────────────────────────────────────────────────────

const cli = cac('vn')

cli.command('run', 'Scan recorder and process recordings (default: --mode notes --transcribe auto --asr volcano --llm pi-codex)')
  .option('--mode <mode>', 'Output mode: notes (default) | transcript', { default: 'notes' })
  .option('--transcribe <strategy>', 'Transcription strategy: auto (default) | single | turbo', { default: 'auto' })
  .option('--asr <provider>', 'ASR provider: volcano | openai (default from VOICENOTE_ASR_PROVIDER env, fallback volcano)')
  .option('--llm <provider>', 'LLM backend for summary: pi-codex | openai (default from VOICENOTE_LLM_PROVIDER env, fallback pi-codex)')
  .option('--latest', 'Only process newest eligible recording')
  .option('--force', 'Reprocess already processed recordings')
  .option('--dry-run', 'Do not copy / transcribe / write files')
  .option('--pdf', 'Also render notes to PDF (only meaningful for --mode notes)')
  .option('--verbose', 'Print per-file skip details during scan')
  .action(runPipeline)

cli.command('watch', 'Continuously poll the recorder')
  .option('--interval <seconds>', 'Poll interval seconds', { default: 60 })
  .action(watchLoop)

cli.command('list', 'List meeting notes in a month')
  .option('--month <YYYY-MM>', 'Month to list (default: current month)')
  .action(listMeetings)

cli.command('last', 'Print summary of most recent processed recording').action(lastMeeting)


cli.command('open [target]', 'Open meetings dir, config dir (`config`), logs dir (`logs`), or a note matching the slug').action((target?: string) => openTarget(target))

cli.command('forget <key>', 'Remove a recording from processed/skipped state so it can be reprocessed').action((key: string) => forgetRecording(key))

cli.command('errors', 'Show recent ERROR lines from daily logs').option('--lines <n>', 'How many lines to print', { default: 20 }).action(showErrors)

cli.command('upgrade', 'Upgrade to the latest published version via bun add -g').action(upgradeSelf)

cli.command('doctor', 'Check environment').action(doctor)
cli.command('install-launch-agent', 'Write LaunchAgent plist').action(installLaunchAgent)
cli.command('uninstall-launch-agent', 'Unload LaunchAgent').action(uninstallLaunchAgent)
cli.command('status', 'Print LaunchAgent status').action(async () => {
  await runCommand('launchctl', ['print', `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`], 10000).then(r => process.stdout.write(r.stdout || r.stderr))
})

cli.help()
cli.version(VERSION)
cli.parse()
