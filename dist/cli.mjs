#!/usr/bin/env bun
import { cac } from "cac";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { FFIType, dlopen, suffix } from "bun:ffi";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
//#region src/cli.ts
const VERSION = "0.16.1";
const LAUNCH_AGENT_LABEL = "com.kid7st.voicenote";
const LOG_DIR = join(os.homedir(), ".local/state/voicenote/logs");
const LOCK_PATH = join(os.homedir(), ".local/state/voicenote/run.lock");
const CONFIG_DIR = join(os.homedir(), ".config/voicenote");
const SPEAKERS_PATH = join(CONFIG_DIR, "speakers.json");
const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".wma",
	".aac",
	".flac"
]);
const ENV_KEYS = [
	"VOICENOTE_DEVICE_VOLUME",
	"VOICENOTE_RECORD_DIR",
	"VOICENOTE_WORKSPACE",
	"VOICENOTE_MIN_BYTES",
	"VOICENOTE_MIN_DURATION_SECONDS",
	"VOLCANO_ASR_KEY",
	"VOLCANO_ASR_APP_ID",
	"VOLCANO_ASR_APP_KEY",
	"VOLCANO_ASR_ACCESS_TOKEN",
	"VOLCANO_ASR_ACCESS_KEY",
	"VOLCANO_ASR_RESOURCE_ID",
	"VOLCANO_ASR_LANGUAGE",
	"VOLCANO_TOS_REGION",
	"VOLCANO_TOS_ENDPOINT",
	"VOLCANO_TOS_BUCKET",
	"VOLCANO_TOS_ACCESS_KEY",
	"VOLCANO_TOS_SECRET_KEY",
	"VOLCANO_TOS_KEEP",
	"VOICENOTE_PI_BIN",
	"VOICENOTE_PI_PROVIDER",
	"VOICENOTE_PI_MODEL",
	"VOICENOTE_PI_MODEL_SUMMARY",
	"VOICENOTE_PI_THINKING",
	"VOICENOTE_PI_SUMMARY_TOOLS",
	"VOICENOTE_CONTEXT_DIR",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"LOCAL_PROXY_HOST",
	"LOCAL_PROXY_PORT",
	"LOCAL_NO_PROXY",
	"OPENAI_API_KEY"
];
const VOLCANO_NO_PROXY_HOSTS = [
	".volces.com",
	".volcengineapi.com",
	"openspeech.bytedance.com"
];
function mergeVolcanoNoProxy(value) {
	const items = (value || "").split(",").map((s) => s.trim()).filter(Boolean);
	for (const host of VOLCANO_NO_PROXY_HOSTS) if (!items.includes(host)) items.push(host);
	return items.join(",");
}
function applyDerivedProxy() {
	const host = process.env.LOCAL_PROXY_HOST;
	const port = process.env.LOCAL_PROXY_PORT;
	if (host && port) {
		const url = `http://${host}:${port}`;
		for (const k of [
			"http_proxy",
			"https_proxy",
			"all_proxy"
		]) if (!process.env[k]) process.env[k] = url;
		for (const k of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY"
		]) if (!process.env[k]) process.env[k] = url;
		const baseNoProxy = process.env.LOCAL_NO_PROXY || "localhost,127.0.0.1,::1";
		if (!process.env.no_proxy) process.env.no_proxy = baseNoProxy;
		if (!process.env.NO_PROXY) process.env.NO_PROXY = baseNoProxy;
	}
	process.env.no_proxy = mergeVolcanoNoProxy(process.env.no_proxy);
	process.env.NO_PROXY = mergeVolcanoNoProxy(process.env.NO_PROXY);
}
let zshrcEnvLoaded = false;
function loadDotZshrcEnv() {
	if (zshrcEnvLoaded) return;
	zshrcEnvLoaded = true;
	const zshrc = join(os.homedir(), ".zshrc");
	if (!existsSync(zshrc)) return;
	let content = "";
	try {
		content = readFileSync(zshrc, "utf8");
	} catch {
		return;
	}
	for (const key of ENV_KEYS) {
		if (process.env[key] !== void 0) continue;
		const pattern = new RegExp(`(?:^|\\n)\\s*export\\s+${key}=(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`);
		const match = content.match(pattern);
		const value = match?.[1] ?? match?.[2] ?? match?.[3];
		if (value !== void 0) process.env[key] = value.replace(/\$\{?HOME\}?/g, os.homedir());
	}
	applyDerivedProxy();
}
function getVolcanoConfigFromEnv() {
	const apiKey = process.env.VOLCANO_ASR_KEY || "";
	const appKey = process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_ASR_APP_KEY || "";
	const asrAccess = process.env.VOLCANO_ASR_ACCESS_TOKEN || process.env.VOLCANO_ASR_ACCESS_KEY || "";
	const tosAccess = process.env.VOLCANO_TOS_ACCESS_KEY;
	const tosSecret = process.env.VOLCANO_TOS_SECRET_KEY;
	const bucket = process.env.VOLCANO_TOS_BUCKET;
	if (!(apiKey || appKey && asrAccess) || !tosAccess || !tosSecret || !bucket) return null;
	const region = process.env.VOLCANO_TOS_REGION || "cn-hongkong";
	const endpoint = process.env.VOLCANO_TOS_ENDPOINT || `tos-s3-${region}.volces.com`;
	const keep = [
		"1",
		"true",
		"yes"
	].includes((process.env.VOLCANO_TOS_KEEP || "0").toLowerCase());
	return {
		apiKey: apiKey || void 0,
		appKey: appKey || void 0,
		accessKey: asrAccess || void 0,
		resourceId: process.env.VOLCANO_ASR_RESOURCE_ID || "volc.seedasr.auc",
		language: process.env.VOLCANO_ASR_LANGUAGE || void 0,
		tos: {
			endpoint,
			region,
			bucket,
			accessKey: tosAccess,
			secretKey: tosSecret,
			keep
		}
	};
}
function volcanoAuthHeaders(volc, taskId, includeSequence) {
	const base = {
		"X-Api-Resource-Id": volc.resourceId,
		"X-Api-Request-Id": taskId,
		"Content-Type": "application/json"
	};
	if (includeSequence) base["X-Api-Sequence"] = "-1";
	if (volc.appKey && volc.accessKey) {
		base["X-Api-App-Key"] = volc.appKey;
		base["X-Api-Access-Key"] = volc.accessKey;
	} else if (volc.apiKey) base["X-Api-Key"] = volc.apiKey;
	return base;
}
function getConfig() {
	loadDotZshrcEnv();
	const deviceVolume = process.env.VOICENOTE_DEVICE_VOLUME || "VTR6500";
	return {
		deviceVolume,
		recordDir: process.env.VOICENOTE_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`,
		workspace: expandHome(process.env.VOICENOTE_WORKSPACE || "~/Documents/meetings"),
		minBytes: Number(process.env.VOICENOTE_MIN_BYTES || 1e5),
		minDurationSeconds: Number(process.env.VOICENOTE_MIN_DURATION_SECONDS || 60),
		volcano: getVolcanoConfigFromEnv(),
		speakers: loadSpeakers()
	};
}
const DEFAULT_SPEAKERS = {
	self: {
		name: null,
		aliases: []
	},
	known: []
};
function loadJsonSync(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		warnSideEffect(`parse ${path}`, e);
		return fallback;
	}
}
function loadSpeakers() {
	ensureConfigSeed();
	const data = loadJsonSync(SPEAKERS_PATH, DEFAULT_SPEAKERS);
	return {
		self: {
			name: data.self?.name ?? null,
			aliases: Array.isArray(data.self?.aliases) ? data.self.aliases : []
		},
		known: Array.isArray(data.known) ? data.known : []
	};
}
let configSeeded = false;
function ensureConfigSeed() {
	if (configSeeded) return;
	configSeeded = true;
	try {
		if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
		if (!existsSync(SPEAKERS_PATH)) writeFileSync(SPEAKERS_PATH, JSON.stringify(DEFAULT_SPEAKERS, null, 2) + "\n", "utf8");
	} catch {}
}
function expandHome(path) {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
	return path;
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function pad(n) {
	return String(n).padStart(2, "0");
}
function dateParts(d) {
	const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
	return {
		month,
		prefix: `${month}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`
	};
}
function safeSlug(text, maxLen = 48) {
	return (text || "").trim().replace(/[\\/:*?"<>|\n\r\t]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/g, "") || "note";
}
function formatSeconds(seconds) {
	const total = Math.max(0, Math.round(seconds || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor(total % 3600 / 60);
	const s = total % 60;
	return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
async function ensureDirs(config) {
	for (const dir of [
		"_state",
		"_index",
		"_audio",
		"_transcripts",
		"_metadata"
	]) await mkdir(join(config.workspace, dir), { recursive: true });
}
async function readJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (e) {
		warnSideEffect(`parse ${path}`, e);
		return fallback;
	}
}
async function writeJson(path, data) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, path);
}
async function appendJsonl(path, data) {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(data) + "\n", "utf8");
}
const SUMMARY_FAILED_STATUS = "summary_failed_transcript_saved";
const RAW_TRANSCRIPT_MARKER = "## 原始 transcript（不做 lossy 清洗）\n\n";
function isSummaryFailedEntry(entry) {
	return entry?.status === SUMMARY_FAILED_STATUS;
}
function dailyLogPath() {
	const d = /* @__PURE__ */ new Date();
	return join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}
const sideEffectWarned = /* @__PURE__ */ new Set();
function warnSideEffect(where, e) {
	if (sideEffectWarned.has(where)) return;
	sideEffectWarned.add(where);
	process.stderr.write(`[voicenote] non-fatal: ${where} failed: ${e instanceof Error ? e.message : String(e)}\n`);
}
let logWired = false;
function wireDailyLog() {
	if (logWired) return;
	logWired = true;
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch (e) {
		warnSideEffect("log dir mkdir", e);
	}
	const path = dailyLogPath();
	const append = (level, args) => {
		const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
		const stamped = `${nowIso()} [${level}] ${line}\n`;
		try {
			appendFileSync(path, stamped, "utf8");
		} catch (e) {
			warnSideEffect("daily log append", e);
		}
	};
	const origLog = console.log.bind(console);
	const origErr = console.error.bind(console);
	console.log = (...a) => {
		append("INFO", a);
		origLog(...a);
	};
	console.error = (...a) => {
		append("ERROR", a);
		origErr(...a);
	};
}
function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return "unknown size";
	const units = [
		"B",
		"KB",
		"MB",
		"GB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function formatElapsed(ms) {
	const total = Math.max(0, Math.round(ms / 1e3));
	const h = Math.floor(total / 3600);
	const m = Math.floor(total % 3600 / 60);
	const s = total % 60;
	if (h) return `${h}h ${m}m ${s}s`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}
function progressStep(step, total, title, detail) {
	console.log(`▶ Step ${step}/${total}: ${title}${detail ? ` — ${detail}` : ""}`);
}
async function withHeartbeat(label, work, heartbeatSeconds = 60) {
	const started = Date.now();
	const timer = setInterval(() => {
		console.log(`… Still working: ${label} (${formatElapsed(Date.now() - started)} elapsed)`);
	}, Math.max(10, heartbeatSeconds) * 1e3);
	timer.unref?.();
	try {
		const result = await work();
		console.log(`✓ Done: ${label} (${formatElapsed(Date.now() - started)})`);
		return result;
	} catch (e) {
		console.error(`✗ Failed: ${label} after ${formatElapsed(Date.now() - started)}`);
		throw e;
	} finally {
		clearInterval(timer);
	}
}
function shouldLogIdleStatus(key, intervalMs = 1800 * 1e3) {
	const path = join(LOG_DIR, "idle-status.json");
	const now = Date.now();
	let prev = null;
	try {
		prev = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	const should = prev?.key !== key || now - Number(prev?.at || 0) >= intervalMs;
	if (should) try {
		mkdirSync(LOG_DIR, { recursive: true });
		writeFileSync(path, JSON.stringify({
			key,
			at: now,
			iso: nowIso()
		}, null, 2) + "\n", "utf8");
	} catch (e) {
		warnSideEffect("idle-status write", e);
	}
	return should;
}
function normalizeRunMode(opts) {
	const raw = String(opts.mode || "notes").toLowerCase();
	if (raw === "note") return "notes";
	if (raw === "notes" || raw === "transcript") return raw;
	throw new Error(`Invalid --mode "${raw}". Use: notes|transcript`);
}
const flockFn = (() => {
	try {
		return dlopen(`libSystem.${suffix}`, { flock: {
			args: [FFIType.i32, FFIType.i32],
			returns: FFIType.i32
		} }).symbols.flock;
	} catch {
		return null;
	}
})();
const FLOCK_EX_NB = 6;
const FLOCK_UN = 8;
async function acquireRunLock() {
	await mkdir(dirname(LOCK_PATH), { recursive: true });
	if (!flockFn) {
		console.error("Warning: flock unavailable on this runtime; proceeding without cross-process locking.");
		return { release: async () => {} };
	}
	let fd;
	try {
		fd = openSync(LOCK_PATH, "w");
	} catch (e) {
		if (e?.code !== "EISDIR") throw e;
		console.error(`Found a legacy (≤ 0.15.2) lock directory at ${LOCK_PATH}; it carries no liveness info and can't be auto-reclaimed safely. If no 'vn run' is active, remove it once:  rm -rf "${LOCK_PATH}"  — skipping this run.`);
		return null;
	}
	if (flockFn(fd, FLOCK_EX_NB) !== 0) {
		closeSync(fd);
		return null;
	}
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		try {
			flockFn(fd, FLOCK_UN);
		} catch {}
		try {
			closeSync(fd);
		} catch {}
	};
	process.once("exit", () => {
		release();
	});
	process.once("SIGINT", () => {
		release();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		release();
		process.exit(143);
	});
	return { release };
}
function parseRecordedAt(path) {
	const m = basename(path, extname(path)).match(/(20\d{12})/);
	if (m?.[1]) {
		const s = m[1];
		return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14)));
	}
	return /* @__PURE__ */ new Date();
}
async function sha256File(path) {
	const h = createHash("sha256");
	const reader = Bun.file(path).stream().getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		h.update(value);
	}
	return h.digest("hex");
}
async function sourceIdFor(path) {
	const st = await stat(path);
	const digest = await sha256File(path);
	return createHash("sha256").update(`${path}|${st.size}|${Math.floor(st.mtimeMs / 1e3)}|${digest}`).digest("hex");
}
function runCommand(command, args, timeoutMs = 2e4) {
	return new Promise((res) => {
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => stdout += String(d));
		child.stderr.on("data", (d) => stderr += String(d));
		child.on("close", (code) => {
			clearTimeout(timer);
			res({
				stdout,
				stderr,
				code: code ?? 1
			});
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			res({
				stdout,
				stderr: String(err),
				code: 1
			});
		});
	});
}
async function ffprobeDuration(path) {
	const result = await runCommand("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		path
	]);
	if (result.code !== 0) return null;
	const v = Number(result.stdout.trim());
	return Number.isFinite(v) ? v : null;
}
function isCandidateFile(path) {
	const name = basename(path);
	if (name.startsWith("._") || name.startsWith(".")) return false;
	if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) return false;
	const parts = path.split("/");
	if (parts.includes(".Spotlight-V100") || parts.includes(".fseventsd") || parts.includes("System Volume Information")) return false;
	return true;
}
async function scanRecordings(config) {
	if (!existsSync(config.recordDir)) return [];
	const recordings = [];
	for await (const file of new Bun.Glob("**/*").scan({
		cwd: config.recordDir,
		absolute: true,
		dot: true
	})) {
		if (!isCandidateFile(file)) continue;
		const st = await stat(file).catch(() => null);
		if (!st?.isFile()) continue;
		recordings.push({
			sourcePath: file,
			sizeBytes: st.size,
			modifiedAt: st.mtime.toISOString(),
			durationSeconds: await ffprobeDuration(file),
			sourceId: await sourceIdFor(file),
			recordedAt: parseRecordedAt(file)
		});
	}
	return recordings.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}
function shouldSkip(rec, state, config, force, mode) {
	const processed = state.processed_source_ids?.[rec.sourceId];
	if (processed && !force) {
		if (mode === "notes" && isSummaryFailedEntry(processed)) return [false, ""];
		return [true, "already_processed"];
	}
	if (rec.sizeBytes < config.minBytes) return [true, `too_small:${rec.sizeBytes}<${config.minBytes}`];
	if (rec.durationSeconds !== null && rec.durationSeconds < config.minDurationSeconds) return [true, `too_short:${rec.durationSeconds.toFixed(1)}<${config.minDurationSeconds}`];
	return [false, ""];
}
function initialLocalFiles(config, rec) {
	const { month, prefix } = dateParts(rec.recordedAt);
	return {
		audio: join(config.workspace, "_audio", month, `${prefix}-original${extname(rec.sourcePath).toLowerCase()}`),
		transcript: join(config.workspace, "_transcripts", month, `${prefix}-transcript.md`),
		notes: join(config.workspace, month, `${prefix}-note.md`),
		metadata: join(config.workspace, "_metadata", month, `${prefix}-metadata.json`)
	};
}
function localFilesFromState(config, rec, entry) {
	const fallback = initialLocalFiles(config, rec);
	const paths = entry?.final_paths || entry?.local_paths || {};
	return {
		audio: typeof paths.audio === "string" ? paths.audio : fallback.audio,
		transcript: typeof paths.transcript === "string" ? paths.transcript : fallback.transcript,
		notes: typeof paths.notes === "string" ? paths.notes : fallback.notes,
		metadata: typeof paths.metadata === "string" ? paths.metadata : fallback.metadata
	};
}
function resumableTranscriptFiles(config, rec, state, mode, force) {
	if (force || mode !== "notes") return null;
	const entry = state.processed_source_ids?.[rec.sourceId];
	if (!isSummaryFailedEntry(entry)) return null;
	const files = localFilesFromState(config, rec, entry);
	return existsSync(files.transcript) ? files : null;
}
async function readSavedTranscript(path) {
	const markdown = await readFile(path, "utf8");
	const markerAt = markdown.indexOf(RAW_TRANSCRIPT_MARKER);
	if (markerAt < 0) throw new Error(`Cannot resume summary: saved transcript is missing raw transcript marker: ${path}`);
	const transcript = markdown.slice(markerAt + 31).trim();
	if (!transcript) throw new Error(`Cannot resume summary: saved transcript is empty: ${path}`);
	return transcript;
}
async function removeFailedSummaryStub(path) {
	if (!existsSync(path)) return;
	try {
		if ((await readFile(path, "utf8")).startsWith("# 待补纪要：")) await unlink(path);
	} catch (e) {
		warnSideEffect(`remove failed-summary stub ${path}`, e);
	}
}
async function titledLocalFiles(config, rec, meta, files) {
	const { month, prefix } = dateParts(rec.recordedAt);
	const base = `${prefix}-${safeSlug(meta.title || "note")}`;
	const targets = {
		audio: join(config.workspace, "_audio", month, `${base}-original${extname(rec.sourcePath).toLowerCase()}`),
		transcript: join(config.workspace, "_transcripts", month, `${base}-transcript.md`),
		notes: join(config.workspace, month, `${base}.md`),
		metadata: join(config.workspace, "_metadata", month, `${base}-metadata.json`)
	};
	for (const p of Object.values(targets)) await mkdir(dirname(p), { recursive: true });
	if (existsSync(files.audio) && files.audio !== targets.audio) {
		if (existsSync(targets.audio)) await unlink(targets.audio);
		await rename(files.audio, targets.audio);
	}
	return targets;
}
function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}
function hmacSha256(key, data) {
	return createHmac("sha256", key).update(data).digest();
}
function tosCanonicalUri(key) {
	return "/" + key.split("/").map((s) => encodeURIComponent(s)).join("/");
}
function tosAmzDate(now = /* @__PURE__ */ new Date()) {
	const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	return {
		amzDate,
		dateStamp: amzDate.slice(0, 8)
	};
}
function tosSigningKey(secretKey, dateStamp, region) {
	return hmacSha256(hmacSha256(hmacSha256(hmacSha256("AWS4" + secretKey, dateStamp), region), "s3"), "aws4_request");
}
function tosSignRequest(tos, method, key, payloadHash, contentType) {
	const host = `${tos.bucket}.${tos.endpoint}`;
	const { amzDate, dateStamp } = tosAmzDate();
	const canonicalUri = tosCanonicalUri(key);
	const headers = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate
	};
	if (contentType) headers["content-type"] = contentType;
	const sortedNames = Object.keys(headers).sort();
	const canonicalHeaders = sortedNames.map((h) => `${h}:${headers[h]}\n`).join("");
	const signedHeaders = sortedNames.join(";");
	const canonicalRequest = [
		method,
		canonicalUri,
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join("\n");
	const credentialScope = `${dateStamp}/${tos.region}/s3/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex(canonicalRequest)
	].join("\n");
	const signature = hmacSha256(tosSigningKey(tos.secretKey, dateStamp, tos.region), stringToSign).toString("hex");
	const authorization = `AWS4-HMAC-SHA256 Credential=${tos.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return {
		url: `https://${host}${canonicalUri}`,
		headers: {
			...headers,
			Authorization: authorization
		}
	};
}
function tosPresignedGet(tos, key, expiresSeconds = 3600) {
	const host = `${tos.bucket}.${tos.endpoint}`;
	const { amzDate, dateStamp } = tosAmzDate();
	const canonicalUri = tosCanonicalUri(key);
	const credentialScope = `${dateStamp}/${tos.region}/s3/aws4_request`;
	const params = {
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${tos.accessKey}/${credentialScope}`,
		"X-Amz-Date": amzDate,
		"X-Amz-Expires": String(expiresSeconds),
		"X-Amz-SignedHeaders": "host"
	};
	const canonicalQuery = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([
			"GET",
			canonicalUri,
			canonicalQuery,
			`host:${host}\n`,
			"host",
			"UNSIGNED-PAYLOAD"
		].join("\n"))
	].join("\n");
	return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${hmacSha256(tosSigningKey(tos.secretKey, dateStamp, tos.region), stringToSign).toString("hex")}`;
}
async function tosUploadObject(tos, localPath, key, contentType) {
	const body = await readFile(localPath);
	const { url, headers } = tosSignRequest(tos, "PUT", key, sha256Hex(body), contentType);
	const res = await fetch(url, {
		method: "PUT",
		body,
		headers
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`TOS upload failed: ${res.status} ${text.slice(0, 500)}`);
	}
}
async function tosDeleteObject(tos, key) {
	const { url, headers } = tosSignRequest(tos, "DELETE", key, sha256Hex(""));
	const res = await fetch(url, {
		method: "DELETE",
		headers
	});
	if (!res.ok && res.status !== 204 && res.status !== 404) {
		const text = await res.text().catch(() => "");
		console.log(`Warn: TOS delete returned ${res.status}: ${text.slice(0, 200)}`);
	}
}
function volcanoFormatFromExt(ext) {
	const e = ext.replace(/^\./, "").toLowerCase();
	if (e === "mp3") return "mp3";
	if (e === "wav") return "wav";
	return e || "mp3";
}
function volcanoContentTypeFromExt(ext) {
	switch (ext.replace(/^\./, "").toLowerCase()) {
		case "mp3": return "audio/mpeg";
		case "wav": return "audio/wav";
		case "m4a": return "audio/mp4";
		case "aac": return "audio/aac";
		case "ogg": return "audio/ogg";
		case "flac": return "audio/flac";
		default: return "application/octet-stream";
	}
}
async function volcanoSubmitTask(volc, taskId, audioUrl, format) {
	const body = {
		user: { uid: "voicenote" },
		audio: {
			url: audioUrl,
			format
		},
		request: {
			model_name: "bigmodel",
			enable_itn: true,
			enable_punc: true,
			enable_ddc: true,
			enable_speaker_info: true,
			show_utterances: true,
			...volc.language ? { language: volc.language } : {}
		}
	};
	const res = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit", {
		method: "POST",
		headers: volcanoAuthHeaders(volc, taskId, true),
		body: JSON.stringify(body)
	});
	const status = res.headers.get("X-Api-Status-Code") || "";
	const message = res.headers.get("X-Api-Message") || "";
	if (status !== "20000000") {
		const text = await res.text().catch(() => "");
		throw new Error(`Volcano submit failed: status=${status} message=${message} body=${text.slice(0, 500)}`);
	}
}
async function volcanoQueryResult(volc, taskId) {
	const res = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query", {
		method: "POST",
		headers: volcanoAuthHeaders(volc, taskId, false),
		body: "{}"
	});
	const status = res.headers.get("X-Api-Status-Code") || "";
	const message = res.headers.get("X-Api-Message") || "";
	const text = await res.text().catch(() => "");
	let parsed = null;
	if (text) try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	return {
		status,
		message,
		result: parsed?.result,
		audio_info: parsed?.audio_info
	};
}
function volcanoSpeakerLabel(u) {
	const id = u.speaker_id ?? u.additions?.speaker_id ?? u.additions?.speaker;
	if (id == null || id === "") return "Speaker A";
	const n = Number(id);
	if (Number.isFinite(n) && n >= 0 && n < 26) return `Speaker ${String.fromCharCode(65 + n)}`;
	return `Speaker ${String(id)}`;
}
function volcanoFormatTranscript(result) {
	const utterances = result.utterances || [];
	if (!utterances.length) return (result.text || "").trim();
	return utterances.map((u) => {
		const text = String(u.text || "").trim();
		if (!text) return "";
		return `[${formatSeconds(Math.round((u.start_time || 0) / 1e3))}-${formatSeconds(Math.round((u.end_time || 0) / 1e3))}] ${volcanoSpeakerLabel(u)}: ${text}`;
	}).filter(Boolean).join("\n");
}
async function volcanoTranscribeAudio(volc, audioPath, rec) {
	const ext = extname(audioPath).toLowerCase() || ".mp3";
	const format = volcanoFormatFromExt(ext);
	const contentType = volcanoContentTypeFromExt(ext);
	const { month } = dateParts(rec.recordedAt);
	const key = `voicenote/${month}/${rec.sourceId}-${Date.now()}${ext}`;
	console.log(`Volcano: upload audio to TOS as ${key}`);
	await withHeartbeat("upload audio to TOS", () => tosUploadObject(volc.tos, audioPath, key, contentType), 30);
	let cleanedUp = false;
	const cleanup = async () => {
		if (cleanedUp || volc.tos.keep) return;
		cleanedUp = true;
		await tosDeleteObject(volc.tos, key).catch(() => {});
	};
	try {
		const audioUrl = tosPresignedGet(volc.tos, key, 6 * 3600);
		const taskId = randomUUID();
		console.log(`Volcano: submit ASR task ${taskId} (resource=${volc.resourceId}, format=${format})`);
		await volcanoSubmitTask(volc, taskId, audioUrl, format);
		const started = Date.now();
		const expectedSeconds = rec.durationSeconds || 0;
		const maxWaitMs = Math.max(1200 * 1e3, Math.ceil(expectedSeconds * 1e3 * 1.5));
		let lastStatusLog = 0;
		let lastStatus = "";
		for (;;) {
			await new Promise((res) => setTimeout(res, 8e3));
			const q = await volcanoQueryResult(volc, taskId);
			if (q.status === "20000000" && q.result) {
				console.log(`✓ Volcano: ASR done in ${formatElapsed(Date.now() - started)}; audio_duration=${q.audio_info?.duration ?? "unknown"}ms`);
				return volcanoFormatTranscript(q.result);
			}
			if (q.status === "20000001" || q.status === "20000002") {
				if (q.status !== lastStatus || Date.now() - lastStatusLog > 6e4) {
					const label = q.status === "20000002" ? "queued" : "processing";
					console.log(`… Volcano: ${label} (status=${q.status}, ${formatElapsed(Date.now() - started)} elapsed)`);
					lastStatusLog = Date.now();
					lastStatus = q.status;
				}
				if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last status=${q.status})`);
				continue;
			}
			if (q.status === "20000003") throw new Error("Volcano: 20000003 静音音频（未检测到人声）");
			throw new Error(`Volcano query failed: status=${q.status} message=${q.message}`);
		}
	} finally {
		await cleanup();
	}
}
async function transcribeAudio(config, audioPath, rec) {
	if (!config.volcano) throw new Error("Volcano ASR not configured. Set VOLCANO_ASR_KEY / VOLCANO_TOS_* in ~/.zshrc.");
	return volcanoTranscribeAudio(config.volcano, audioPath, rec);
}
function speakerContextBlock(speakers) {
	return `Speaker context（用于尽可能把 Speaker A/B/C 还原成真实姓名，但只在证据充分时替换）：\n- ${speakers.self.name ? `用户本人：${speakers.self.name}${speakers.self.aliases.length ? `（别名：${speakers.self.aliases.join("、")}）` : ""}` : "用户本人姓名未配置。"}\n- 其他已知说话人：\n${speakers.known.length ? speakers.known.map((k) => `- ${k.name}${k.aliases?.length ? `（别名：${k.aliases.join("、")}）` : ""}${k.relationship ? `，${k.relationship}` : ""}`).join("\n") : "（无其他已知说话人）"}\n\n判断规则：\n- 录音只有一个说话人，且本人姓名已配置，可以把 Speaker A 视为本人。\n- 多人对话中若某说话人被其他人称呼为本人姓名/别名，则该说话人为本人。\n- 多人对话中若某说话人被其他人称呼为已知说话人的姓名/别名，则该说话人为该已知说话人。\n- 其他无法确认的，保留 Speaker A/B/C，不要硬猜。`;
}
function summaryMessages(config, transcript, rec, localAudioPath) {
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

${speakerContextBlock(config.speakers)}`;
	const user = `请基于下面 transcript 生成一份“语义整理笔记”。

处理模式：Integrated notes mode（不做单独 transcript 清洗；请在生成笔记时完成必要清理、纠错、梳理和 speaker 还原）

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
${transcript}`;
	return [{
		role: "system",
		content: system
	}, {
		role: "user",
		content: user
	}];
}
function piCodexBin() {
	return process.env.VOICENOTE_PI_BIN || "pi";
}
function piAuthAvailable() {
	return existsSync(join(os.homedir(), ".pi", "agent", "auth.json"));
}
function piProviderCandidates() {
	const providers = (process.env.VOICENOTE_PI_PROVIDER?.trim() || "openai-codex,openai").split(",").map((s) => s.trim()).filter(Boolean);
	return providers.length ? Array.from(new Set(providers)) : ["openai-codex", "openai"];
}
function piProviderFor() {
	return piProviderCandidates()[0] || "openai-codex";
}
function piCodexModelFor() {
	return process.env.VOICENOTE_PI_MODEL_SUMMARY || process.env.VOICENOTE_PI_MODEL || "gpt-5.5";
}
function stripJsonFences(text) {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
	if (fence) return fence[1].trim();
	return trimmed;
}
function extractFirstJsonObject(text) {
	const trimmed = stripJsonFences(text);
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	let depth = 0, start = -1, inString = false, escape = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) return trimmed.slice(start, i + 1);
		}
	}
	return trimmed;
}
async function chatCompleteViaPiProvider(opts) {
	const args = [
		"-p",
		"--provider",
		opts.provider,
		"--model",
		opts.model,
		"--mode",
		"text",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-session",
		"--no-prompt-templates",
		"--no-themes",
		"--system-prompt",
		opts.systemPrompt
	];
	if (opts.thinking) args.push("--thinking", opts.thinking);
	if (opts.tools && opts.tools.trim()) args.push("--tools", opts.tools.trim());
	else args.push("--no-tools");
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	return new Promise((resolve, reject) => {
		const child = spawn(piCodexBin(), args, {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			cwd: opts.cwd
		});
		let stdout = "", stderr = "";
		const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
		child.stdout.on("data", (d) => stdout += String(d));
		child.stderr.on("data", (d) => stderr += String(d));
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (code !== 0) return reject(/* @__PURE__ */ new Error(`pi ${opts.provider} exited ${code}: ${(stderr || stdout).slice(0, 800)}`));
			const text = stdout.trim();
			if (!text) return reject(/* @__PURE__ */ new Error(`pi ${opts.provider} returned empty output`));
			resolve(text);
		});
		child.stdin.end(opts.userPrompt);
	});
}
async function chatCompleteViaPiCodex(opts) {
	const providers = piProviderCandidates();
	let lastError = null;
	for (const [idx, provider] of providers.entries()) try {
		if (idx > 0) console.error(`pi provider fallback: trying ${provider} after ${providers[idx - 1]} failed: ${lastError?.message || lastError}`);
		return await chatCompleteViaPiProvider({
			...opts,
			provider
		});
	} catch (e) {
		lastError = e;
	}
	throw lastError || /* @__PURE__ */ new Error("pi provider fallback exhausted");
}
function piThinkingLevel() {
	return process.env.VOICENOTE_PI_THINKING || "high";
}
function piSummaryTools() {
	const v = process.env.VOICENOTE_PI_SUMMARY_TOOLS;
	if (v === void 0) return "read,grep";
	return v.trim();
}
function summaryContextDir(config) {
	return expandHome(process.env.VOICENOTE_CONTEXT_DIR || config.workspace);
}
function piSummaryToolsHint(contextDir) {
	return `你在写纪要前有 read 和 grep 两个只读工具可用。你的当前工作目录（cwd）就是 \`${contextDir}\`（你既往的纪要/资料），可直接用相对路径 grep/read。\n\n用途：保持人名、项目名、术语与既往纪要一致；识别本次 transcript 中模糊提到、名字不全的人或项目；补充本次讨论明显相关的背景。\n\n约束：\n- 总共最多 10 次工具调用；如果 transcript 本身信息足够，可完全不调用。\n- 只读 \`${contextDir}\` 范围内的内容；跳过明显涉及个人隐私/凭证/财务的目录（如 identity / credentials / finance 等）。\n- 查到的信息仅用于一致性；不要把未在本次 transcript 中出现的内容当作事实写进纪要。\n- 不要尝试写文件或调用 bash（这些工具并未启用）。`;
}
async function chatComplete(opts) {
	const wantTools = !!piSummaryTools();
	const ctx = wantTools ? summaryContextDir(opts.config) : void 0;
	const ctxExists = ctx ? existsSync(ctx) : false;
	if (ctx && !ctxExists) console.error(`Warning: context dir ${ctx} does not exist; summary agent runs WITHOUT read/grep cross-reference.`);
	const toolsActive = wantTools && ctxExists;
	return chatCompleteViaPiCodex({
		systemPrompt: opts.systemPrompt,
		userPrompt: opts.userPrompt,
		model: piCodexModelFor(),
		timeoutMs: 3600 * 1e3,
		thinking: piThinkingLevel(),
		tools: toolsActive ? piSummaryTools() : void 0,
		appendSystemPrompt: toolsActive ? piSummaryToolsHint(ctx) : void 0,
		cwd: toolsActive ? ctx : void 0
	});
}
async function summarizeTranscript(config, transcript, rec, localAudioPath) {
	const messages = summaryMessages(config, transcript, rec, localAudioPath);
	const text = await chatComplete({
		systemPrompt: String(messages[0].content),
		userPrompt: String(messages[1].content),
		config
	});
	const jsonText = extractFirstJsonObject(text);
	try {
		return JSON.parse(jsonText || "{}");
	} catch (e) {
		throw new Error(`summary returned non-JSON output (${e?.message || e}). First 400 chars: ${text.slice(0, 400)}`);
	}
}
function isSpeakerLabel(text) {
	return /^\s*speaker\s+[a-z]\s*$/i.test(text) || /^\s*说话人\s*[A-ZＡ-Ｚa-zａ-ｚ一二三四五六七八九十0-9]+\s*$/.test(text);
}
function normalizeMetadata(meta, rec) {
	const d = rec.recordedAt;
	meta.date ||= `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	meta.start_time ||= `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	meta.end_time ??= null;
	for (const key of [
		"participants",
		"organizations",
		"projects",
		"discussion_flow",
		"consensus_points",
		"disagreements",
		"action_items",
		"decisions",
		"open_questions",
		"key_quotes_or_details",
		"transcription_uncertainties"
	]) if (!Array.isArray(meta[key])) meta[key] = [];
	meta.participants = meta.participants.filter((p) => typeof p === "string" && p.trim() && !isSpeakerLabel(p));
	return meta;
}
const SOURCE_MARKER = "<!-- voicenote:source -->";
function sourceDetails(meta, audioPath, transcriptPath) {
	return `${SOURCE_MARKER}\n<details>\n<summary>来源信息</summary>\n\n- 纪要生成来源：voicenote 自动转写\n- 原始音频：\`${audioPath}\`\n- 完整转写：\`${transcriptPath}\`\n\n</details>`;
}
function markdownNotes(meta, audioPath, transcriptPath) {
	let body = typeof meta.markdown === "string" && meta.markdown.trim() ? meta.markdown.trim() : `# ${meta.title || "未命名录音纪要"}\n`;
	if (!body.startsWith("#")) body = `# ${meta.title || "未命名录音纪要"}\n\n${body}`;
	if (!body.includes(SOURCE_MARKER)) body = `${body.trim()}\n\n${sourceDetails(meta, audioPath, transcriptPath)}`;
	return `${body.trim()}\n`;
}
async function markdownToPdf(markdownPath) {
	const pdfPath = markdownPath.replace(/\.md$/i, ".pdf");
	const tempBase = join(os.tmpdir(), `voicenote-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const htmlPath = `${tempBase}.html`;
	const cssPath = `${tempBase}.css`;
	await writeFile(cssPath, `
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
`, "utf8");
	try {
		const pandoc = await runCommand("pandoc", [
			markdownPath,
			"--from",
			"markdown+smart",
			"--to",
			"html5",
			"--standalone",
			"--metadata",
			`title=${basename(markdownPath, extname(markdownPath))}`,
			"--css",
			cssPath,
			"-o",
			htmlPath
		], 12e4);
		if (pandoc.code !== 0) throw new Error(`pandoc failed: ${pandoc.stderr || pandoc.stdout}`);
		const chrome = await runCommand(existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome", [
			"--headless",
			"--disable-gpu",
			"--no-pdf-header-footer",
			`--print-to-pdf=${pdfPath}`,
			pathToFileURL(htmlPath).href
		], 12e4);
		if (chrome.code !== 0 || !existsSync(pdfPath)) throw new Error(`chrome pdf failed: ${chrome.stderr || chrome.stdout}`);
		return pdfPath;
	} finally {
		await unlink(htmlPath).catch(() => {});
		await unlink(cssPath).catch(() => {});
	}
}
function transcriptMarkdown(config, rec, transcript, opts = {}) {
	const transcribeBackend = `volcano 豆包 (资源为 ${config.volcano?.resourceId || "volc.seedasr.auc"})`;
	return `# 录音转写：${basename(rec.sourcePath)}\n\n- 源文件：\`${rec.sourcePath}\`\n- 转写后端：${transcribeBackend}\n- 处理模式：${opts.mode || "notes"}\n- 录音时间：${rec.recordedAt.toISOString()}\n- 文件大小：${rec.sizeBytes} bytes\n- 时长：${rec.durationSeconds ?? "未知"} seconds\n- 转写时间：${nowIso()}\n\n---\n\n## 原始 transcript（不做 lossy 清洗）\n\n${transcript.trim()}`;
}
async function processRecording(config, rec, opts) {
	const jobStarted = Date.now();
	let files = opts.resumeFromTranscriptFiles || initialLocalFiles(config, rec);
	const mode = normalizeRunMode(opts);
	const needsNotes = mode === "notes";
	const resumeSummary = needsNotes && Boolean(opts.resumeFromTranscriptFiles);
	const transcribeBackendLabel = `volcano:${config.volcano?.resourceId || "volc.seedasr.auc"}`;
	const llmBackendLabel = `pi:${piProviderFor()}`;
	const plan = resumeSummary ? "reuse saved transcript → integrated semantic notes → write metadata/index (no auto move)" : `copy audio → transcribe → write transcript${needsNotes ? " → integrated semantic notes" : ""} → write metadata/index (no auto move)`;
	console.log(`\n=== voicenote job: ${basename(rec.sourcePath)} ===`);
	console.log(`Source: ${rec.sourcePath}`);
	console.log(`Audio: duration=${rec.durationSeconds == null ? "unknown" : formatSeconds(rec.durationSeconds)}, size=${formatBytes(rec.sizeBytes)}, mode=${mode}, asr=${transcribeBackendLabel}, llm=${llmBackendLabel}`);
	console.log(`Plan: ${plan}`);
	if (opts.dryRun) return {
		source_path: rec.sourcePath,
		source_id: rec.sourceId,
		would_copy_to: files.audio,
		resume_from_transcript: resumeSummary ? files.transcript : null,
		size_bytes: rec.sizeBytes,
		duration_seconds: rec.durationSeconds,
		mode
	};
	const totalSteps = resumeSummary ? 3 : needsNotes ? 4 : 3;
	let stepNo = 0;
	const nextStep = () => ++stepNo;
	let transcript = "";
	let meta = {
		title: basename(rec.sourcePath, extname(rec.sourcePath)),
		markdown: ""
	};
	if (resumeSummary) {
		progressStep(nextStep(), totalSteps, "Reuse saved transcript", files.transcript);
		transcript = await readSavedTranscript(files.transcript);
		console.log(`✓ Reusing transcript: ${files.transcript}`);
		if (!existsSync(files.audio)) {
			await mkdir(dirname(files.audio), { recursive: true });
			await copyFile(rec.sourcePath, files.audio);
			console.log(`✓ Local audio restored: ${files.audio}`);
		}
	} else {
		progressStep(nextStep(), totalSteps, "Copy audio to workspace", files.audio);
		await mkdir(dirname(files.audio), { recursive: true });
		await copyFile(rec.sourcePath, files.audio);
		console.log(`✓ Local audio ready: ${files.audio}`);
		progressStep(nextStep(), totalSteps, "Transcribe audio", transcribeBackendLabel);
		transcript = await withHeartbeat("transcribe audio", () => transcribeAudio(config, files.audio, rec), 90);
		await mkdir(dirname(files.transcript), { recursive: true });
		await writeFile(files.transcript, transcriptMarkdown(config, rec, transcript, { mode }), "utf8");
		console.log(`✓ Transcript saved: ${files.transcript}`);
	}
	let summaryError = null;
	if (needsNotes) {
		progressStep(nextStep(), totalSteps, "Generate integrated semantic notes", `model=${piCodexModelFor()} via ${llmBackendLabel}`);
		try {
			meta = await withHeartbeat("generate integrated semantic notes", () => summarizeTranscript(config, transcript, rec, files.audio), 60);
		} catch (e) {
			summaryError = e;
			console.error(`Summary step failed; transcript is preserved. Error: ${e?.message || e}`);
			console.error(`Hint: fix LLM auth/credits, then re-run with: vn run --latest`);
		}
	}
	meta = normalizeMetadata(meta, rec);
	meta.processing_mode = mode;
	meta.source_audio_path = rec.sourcePath;
	meta.source_id = rec.sourceId;
	meta.source_size_bytes = rec.sizeBytes;
	meta.source_modified_at = rec.modifiedAt;
	meta.duration_seconds = rec.durationSeconds;
	meta.asr_provider = "volcano";
	meta.transcribe_model = config.volcano?.resourceId || "volc.seedasr.auc";
	meta.summary_model = needsNotes && !summaryError ? piCodexModelFor() : null;
	meta.llm_backend = needsNotes ? llmBackendLabel : null;
	meta.processed_at = nowIso();
	if (summaryError) meta.summary_error = String(summaryError?.message || summaryError);
	progressStep(nextStep(), totalSteps, "Write outputs and index");
	let failedStubPathToRemove = null;
	if (needsNotes && !summaryError) {
		const previousNotes = files.notes;
		const titled = await titledLocalFiles(config, rec, meta, files);
		if (titled.transcript !== files.transcript && existsSync(files.transcript)) {
			await mkdir(dirname(titled.transcript), { recursive: true });
			if (existsSync(titled.transcript)) await unlink(titled.transcript);
			await rename(files.transcript, titled.transcript);
		}
		files = titled;
		if (previousNotes !== files.notes) failedStubPathToRemove = previousNotes;
	}
	await mkdir(dirname(files.notes), { recursive: true });
	await mkdir(dirname(files.metadata), { recursive: true });
	if (needsNotes && !summaryError) {
		await writeFile(files.notes, markdownNotes(meta, files.audio, files.transcript), "utf8");
		console.log(`✓ Notes: ${files.notes}`);
		if (failedStubPathToRemove) await removeFailedSummaryStub(failedStubPathToRemove);
		if (opts.pdf) {
			const pdf = await withHeartbeat("render notes PDF", () => markdownToPdf(files.notes), 30);
			meta.local_paths = {
				...files,
				pdf
			};
			console.log(`✓ PDF: ${pdf}`);
		}
	} else if (needsNotes && summaryError) {
		const stubBody = `# 待补纪要：${basename(rec.sourcePath)}\n\n> ⚠ 转写已完成并保存，但纪要生成阶段失败，需人工重试。\n\n- 转写文件：\`${files.transcript}\`\n- 原始音频：\`${rec.sourcePath}\`\n- 失败原因：${meta.summary_error}\n- 重试命令：\`vn run --latest\`\n`;
		await writeFile(files.notes, stubBody, "utf8");
		console.log(`⚠ Stub notes (summary failed): ${files.notes}`);
	} else if (opts.pdf) console.log("PDF skipped: --pdf only applies to --mode notes.");
	meta.local_paths = {
		...files,
		...meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}
	};
	meta.final_paths = {
		audio: files.audio,
		transcript: files.transcript,
		notes: needsNotes ? files.notes : null,
		metadata: files.metadata,
		...meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}
	};
	if (summaryError) meta.status = SUMMARY_FAILED_STATUS;
	else if (needsNotes) meta.status = "completed";
	else meta.status = "transcript_only";
	await writeJson(files.metadata, meta);
	await appendJsonl(await notesIndexPath(config), meta);
	console.log(`✓ Completed: ${meta.title || basename(rec.sourcePath)} (${formatElapsed(Date.now() - jobStarted)} total)`);
	if (needsNotes) console.log(`Final notes: ${files.notes}`);
	else console.log(`Final transcript: ${files.transcript}`);
	return meta;
}
async function runPipeline(opts) {
	wireDailyLog();
	const config = getConfig();
	const lock = await acquireRunLock();
	if (!lock) {
		console.log("voicenote pipeline already running; skip");
		return;
	}
	try {
		await runPipelineLocked(config, opts);
	} finally {
		await lock.release();
	}
}
async function runPipelineLocked(config, opts) {
	await ensureDirs(config);
	const statePath = join(config.workspace, "_state", "processed.json");
	const state = await readJson(statePath, {
		processed_source_ids: {},
		skipped_source_ids: {}
	});
	state.processed_source_ids ||= {};
	state.skipped_source_ids ||= {};
	if (!existsSync(config.recordDir)) {
		if (shouldLogIdleStatus(`missing:${config.recordDir}`)) console.log(`Idle: recorder not mounted or record dir missing: ${config.recordDir} (repeated idle logs suppressed for 30m)`);
		return;
	}
	const recordings = await scanRecordings(config);
	const mode = normalizeRunMode(opts);
	const force = Boolean(opts.force);
	const eligible = [];
	const skipCounts = {};
	const skipSamples = {};
	const verboseSkips = Boolean(opts.verbose || opts.dryRun);
	for (const rec of recordings) {
		const [skip, reason] = shouldSkip(rec, state, config, force, mode);
		if (skip) {
			const reasonKey = reason.split(":")[0] || reason;
			skipCounts[reasonKey] = (skipCounts[reasonKey] || 0) + 1;
			(skipSamples[reasonKey] ||= []).push(basename(rec.sourcePath));
			if (!state.skipped_source_ids[rec.sourceId] && reason !== "already_processed") state.skipped_source_ids[rec.sourceId] = {
				source_path: rec.sourcePath,
				reason,
				size_bytes: rec.sizeBytes,
				duration_seconds: rec.durationSeconds,
				seen_at: nowIso()
			};
			if (verboseSkips) console.log(`  Skip: ${basename(rec.sourcePath)} (${reason})`);
		} else eligible.push(rec);
	}
	const skipSummary = Object.entries(skipCounts).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none";
	const scanLine = `Scan summary: found=${recordings.length}; eligible=${eligible.length}; skipped=${recordings.length - eligible.length} (${skipSummary})`;
	const samplesLine = !verboseSkips && Object.keys(skipSamples).length ? `Skipped samples: ${Object.entries(skipSamples).map(([reason, names]) => `${reason}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `…(+${names.length - 3})` : ""}`).join(" | ")}` : "";
	const latestOnly = Boolean(opts.latest);
	const targets = latestOnly ? eligible.slice(0, 1) : eligible;
	if (targets.length && !opts.dryRun) {
		if (targets.some((rec) => !resumableTranscriptFiles(config, rec, state, mode, force)) && !config.volcano) {
			if (shouldLogIdleStatus(`asr-misconfig:${config.recordDir}`)) console.error("ASR not configured: Volcano needs VOLCANO_ASR_KEY / VOLCANO_TOS_*. Skipping; run `vn doctor`, fix config, then re-run.");
			return;
		}
		if (mode === "notes" && !piAuthAvailable()) {
			if (shouldLogIdleStatus(`pi-noauth:${config.recordDir}`)) console.error("pi is not logged in (~/.pi/agent/auth.json missing). Skipping to avoid spending ASR on notes whose summary would fail. Run `pi` to log in, then re-run.");
			return;
		}
	}
	if (!targets.length) {
		if (verboseSkips || shouldLogIdleStatus(`idle:${config.recordDir}:${recordings.length}:${skipSummary}:${samplesLine}`)) {
			console.log(scanLine);
			if (samplesLine) console.log(samplesLine);
			console.log("Idle: no new recordings to process. (repeated idle logs suppressed for 30m)");
		}
	} else {
		console.log(scanLine);
		if (samplesLine) console.log(samplesLine);
		console.log(`Queue: processing ${targets.length} recording(s)${latestOnly ? " (--latest)" : ""}. Remaining after this run: ${Math.max(0, eligible.length - targets.length)}`);
	}
	for (const rec of targets) try {
		const resumeFromTranscriptFiles = resumableTranscriptFiles(config, rec, state, mode, force);
		const result = await processRecording(config, rec, {
			...opts,
			resumeFromTranscriptFiles
		});
		if (!opts.dryRun) {
			state.processed_source_ids[rec.sourceId] = {
				source_path: rec.sourcePath,
				processed_at: nowIso(),
				status: result.status,
				title: result.title,
				final_paths: result.final_paths
			};
			delete state.skipped_source_ids[rec.sourceId];
		}
	} catch (e) {
		console.error(`ERROR processing ${rec.sourcePath}: ${e?.message || e}`);
		state.skipped_source_ids[rec.sourceId] = {
			source_path: rec.sourcePath,
			reason: `error:${e?.message || e}`,
			seen_at: nowIso()
		};
	}
	if (!opts.dryRun) await writeJson(statePath, state);
}
function plistPath() {
	return join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}
function xmlEscape(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
async function launchAgentEnv() {
	loadDotZshrcEnv();
	const env = { PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
	for (const k of ENV_KEYS) {
		const v = process.env[k];
		if (v !== void 0) env[k] = v;
	}
	if (!env.VOICENOTE_PI_BIN?.startsWith("/")) {
		const w = await runCommand("which", [env.VOICENOTE_PI_BIN || "pi"], 5e3);
		const p = w.code === 0 ? w.stdout.trim().split("\n")[0] || "" : "";
		if (p && existsSync(p)) env.VOICENOTE_PI_BIN = p;
	}
	return env;
}
async function installLaunchAgent() {
	const cliPath = fileURLToPath(import.meta.url);
	const plist = plistPath();
	await mkdir(dirname(plist), { recursive: true });
	await mkdir(LOG_DIR, { recursive: true });
	const bunPath = existsSync("/opt/homebrew/bin/bun") ? "/opt/homebrew/bin/bun" : process.execPath;
	const env = await launchAgentEnv();
	const envEntries = Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join("\n");
	await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
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
`, "utf8");
	const summary = Object.keys(env).join(", ");
	console.log(`LaunchAgent written: ${plist}`);
	console.log(`Embedded env keys: ${summary}`);
	console.log(`Enable with: launchctl bootstrap gui/$(id -u) ${plist}`);
}
async function uninstallLaunchAgent() {
	await runCommand("launchctl", [
		"bootout",
		`gui/${process.getuid?.()}`,
		plistPath()
	], 1e4);
	console.log(`Bootout attempted: ${plistPath()}`);
}
async function listMeetings(opts) {
	const config = getConfig();
	const month = opts.month || `${(/* @__PURE__ */ new Date()).getFullYear()}-${pad((/* @__PURE__ */ new Date()).getMonth() + 1)}`;
	const dir = join(config.workspace, month);
	if (!existsSync(dir)) {
		console.log(`No notes in ${dir}`);
		return;
	}
	const entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
	if (!entries.length) {
		console.log(`No notes in ${dir}`);
		return;
	}
	for (const name of entries) console.log(join(dir, name));
}
async function notesIndexPath(config) {
	const p = join(config.workspace, "_index", "notes.jsonl");
	const legacy = join(config.workspace, "_index", "meetings.jsonl");
	if (!existsSync(p) && existsSync(legacy)) await rename(legacy, p).catch(() => {});
	return p;
}
async function lastMeeting() {
	const indexPath = await notesIndexPath(getConfig());
	if (!existsSync(indexPath)) {
		console.log("No notes indexed yet.");
		return;
	}
	const lines = (await readFile(indexPath, "utf8")).trim().split("\n").filter(Boolean);
	const last = lines[lines.length - 1];
	if (!last) {
		console.log("No notes indexed yet.");
		return;
	}
	let obj;
	try {
		obj = JSON.parse(last);
	} catch {
		console.log(last);
		return;
	}
	console.log(`Title:        ${obj.title}`);
	console.log(`Date:         ${obj.date} ${obj.start_time || ""}-${obj.end_time || ""}`);
	console.log(`Status:       ${obj.status || "unknown"}`);
	console.log(`Notes:        ${obj.final_paths?.notes || obj.local_paths?.notes}`);
	console.log(`Transcript:   ${obj.final_paths?.transcript || obj.local_paths?.transcript}`);
	console.log(`Audio:        ${obj.final_paths?.audio || obj.local_paths?.audio}`);
}
async function openTarget(arg) {
	const config = getConfig();
	let target = config.workspace;
	if (arg === "config") target = CONFIG_DIR;
	else if (arg === "logs") target = LOG_DIR;
	else if (arg) {
		const month = `${(/* @__PURE__ */ new Date()).getFullYear()}-${pad((/* @__PURE__ */ new Date()).getMonth() + 1)}`;
		const dir = join(config.workspace, month);
		if (existsSync(dir)) {
			const matches = (await readdir(dir)).filter((f) => f.includes(arg) && f.endsWith(".md"));
			if (matches.length) target = join(dir, matches[matches.length - 1]);
		}
	}
	await runCommand("open", [target], 5e3);
	console.log(`open ${target}`);
}
async function forgetRecording(needle) {
	const statePath = join(getConfig().workspace, "_state", "processed.json");
	const state = await readJson(statePath, {
		processed_source_ids: {},
		skipped_source_ids: {}
	});
	let removed = 0;
	for (const bucket of ["processed_source_ids", "skipped_source_ids"]) for (const id of Object.keys(state[bucket] || {})) {
		const entry = state[bucket][id];
		if (id === needle || entry?.source_path?.includes(needle)) {
			delete state[bucket][id];
			removed++;
		}
	}
	await writeJson(statePath, state);
	console.log(`forgot ${removed} record(s)`);
}
async function showLog(opts) {
	const lines = Number(opts.lines || 30);
	const wanted = [opts.date ? join(LOG_DIR, `${opts.date}.log`) : dailyLogPath()];
	if (opts.err) wanted.push(join(LOG_DIR, "launchd.err.log"));
	const files = wanted.filter((f) => existsSync(f));
	if (!files.length) {
		console.log(`No log file: ${wanted.join(", ")}`);
		return;
	}
	const args = ["-n", String(lines)];
	if (opts.follow) args.push("-F");
	args.push(...files);
	await new Promise((res) => spawn("tail", args, { stdio: "inherit" }).on("close", () => res()));
}
async function showErrors(opts) {
	if (!existsSync(LOG_DIR)) {
		console.log("No logs.");
		return;
	}
	const files = (await readdir(LOG_DIR)).filter((f) => f.endsWith(".log")).sort().slice(-3);
	const lineCount = Number(opts.lines || 20);
	const errors = [];
	for (const f of files) {
		const content = await readFile(join(LOG_DIR, f), "utf8").catch(() => "");
		for (const line of content.split("\n")) if (line.includes("[ERROR]") || line.includes("ERROR processing")) errors.push(line);
	}
	for (const line of errors.slice(-lineCount)) console.log(line);
}
async function upgradeSelf() {
	const cmd = existsSync("/opt/homebrew/bin/bun") ? "/opt/homebrew/bin/bun" : "bun";
	console.log(`$ ${cmd} remove -g @kid7st/voicenote || true`);
	await new Promise((res) => spawn(cmd, [
		"remove",
		"-g",
		"@kid7st/voicenote"
	], { stdio: "inherit" }).on("close", () => res()));
	console.log(`$ ${cmd} add -g git+https://github.com/kid7st/voicenote.git#main`);
	const addCode = await new Promise((res) => spawn(cmd, [
		"add",
		"-g",
		"git+https://github.com/kid7st/voicenote.git#main"
	], { stdio: "inherit" }).on("close", (c) => res(c ?? 1)).on("error", () => res(1)));
	if (addCode !== 0) {
		console.error(`Upgrade failed: \`${cmd} add -g\` exited ${addCode}. The previous global install was already removed and may be gone; re-run \`vn upgrade\` (or the install command) to repair.`);
		process.exitCode = 1;
		return;
	}
	if (existsSync(plistPath())) {
		console.log("Refreshing LaunchAgent plist for the upgraded version…");
		const code = await new Promise((res) => spawn("vn", ["install-launch-agent"], { stdio: "inherit" }).on("close", (c) => res(c ?? 1)).on("error", () => res(1)));
		if (code !== 0) {
			console.error(`Warning: \`vn install-launch-agent\` failed (exit ${code}); the LaunchAgent still points at the previous version. Ensure vn is on PATH and re-run \`vn install-launch-agent\`.`);
			return;
		}
		const uid = process.getuid?.();
		await runCommand("launchctl", [
			"bootout",
			`gui/${uid}`,
			plistPath()
		], 1e4);
		const bs = await runCommand("launchctl", [
			"bootstrap",
			`gui/${uid}`,
			plistPath()
		], 1e4);
		if (bs.code !== 0) {
			console.error(`Warning: launchctl bootstrap failed: ${(bs.stderr || bs.stdout).trim()}. Reload manually: launchctl bootstrap gui/$(id -u) ${plistPath()}`);
			return;
		}
		console.log("LaunchAgent reloaded.");
	}
}
async function doctor() {
	const config = getConfig();
	console.log(`version=${VERSION}`);
	console.log(`bun=${process.versions.bun || "not-bun"}`);
	console.log(`node=${process.version}`);
	console.log(`recordDir=${config.recordDir} exists=${existsSync(config.recordDir)}`);
	console.log(`workspace=${config.workspace}`);
	if (config.volcano) {
		const auth = config.volcano.appKey && config.volcano.accessKey ? "old-console (X-Api-App-Key + X-Api-Access-Key)" : config.volcano.apiKey ? "new-console (X-Api-Key)" : "missing";
		console.log(`volcano.auth=${auth}`);
		console.log(`volcano.resourceId=${config.volcano.resourceId}`);
		console.log(`volcano.tos=bucket:${config.volcano.tos.bucket} region:${config.volcano.tos.region} endpoint:${config.volcano.tos.endpoint} keep:${config.volcano.tos.keep}`);
		console.log(`volcano.tos.accessKey=${config.volcano.tos.accessKey ? "loaded" : "missing"} secretKey=${config.volcano.tos.secretKey ? "loaded" : "missing"}`);
		if (config.volcano.language) console.log(`volcano.language=${config.volcano.language}`);
	} else console.log(`volcano=not configured`);
	console.log(`summaryBackend=pi:${piProviderCandidates().join("→")}`);
	console.log(`pi.bin=${piCodexBin()} providers=${piProviderCandidates().join(",")} model.summary=${piCodexModelFor()}`);
	console.log(`pi.thinking=${piThinkingLevel()}`);
	const tools = piSummaryTools();
	console.log(`pi.summaryTools=${tools || "<disabled>"}`);
	if (tools) console.log(`pi.contextDir=${summaryContextDir(config)} (summary agent cwd + read/grep cross-reference root)`);
	const piCheck = await runCommand(piCodexBin(), ["--version"], 15e3);
	const piVer = piCheck.stdout.trim() || piCheck.stderr.trim() || "missing";
	console.log(`pi.version=${piCheck.code === 0 ? piVer : "missing"}`);
	console.log(`pi.auth=${piAuthAvailable() ? "logged-in" : "NOT logged-in — run `pi` to sign in, else the summary step will fail"}`);
	console.log(`defaultMode=notes`);
	console.log(`http_proxy=${process.env.http_proxy || "<unset>"}`);
	console.log(`speakers.self=${config.speakers.self.name || "<unset>"}`);
	console.log(`speakers.known=${config.speakers.known.length}`);
	console.log(`launch_agent_plist=${plistPath()}`);
	const ff = await runCommand("ffprobe", ["-version"], 5e3);
	console.log(`ffprobe=${ff.code === 0 ? "ok" : "missing"}`);
	const ffmpeg = await runCommand("ffmpeg", ["-version"], 5e3);
	console.log(`ffmpeg=${ffmpeg.code === 0 ? "ok" : "missing"}`);
}
const cli = cac("vn");
cli.command("run", "Scan recorder and process recordings (Volcano ASR + pi-codex notes)").option("--mode <mode>", "Output mode: notes (default) | transcript", { default: "notes" }).option("--latest", "Only process newest eligible recording").option("--force", "Reprocess already processed recordings").option("--dry-run", "Do not copy / transcribe / write files").option("--pdf", "Also render notes to PDF (only meaningful for --mode notes)").option("--verbose", "Print per-file skip details during scan").action(runPipeline);
cli.command("list", "List notes in a month").option("--month <YYYY-MM>", "Month to list (default: current month)").action(listMeetings);
cli.command("last", "Print summary of most recent processed recording").action(lastMeeting);
cli.command("open [target]", "Open notes dir, config dir (`config`), logs dir (`logs`), or a note matching the slug").action((target) => openTarget(target));
cli.command("forget <key>", "Remove a recording from processed/skipped state so it can be reprocessed").action((key) => forgetRecording(key));
cli.command("log", "Print the daily log (today by default)").option("--lines <n>", "How many trailing lines to print", { default: 30 }).option("-f, --follow", "Follow the log live (tail -F)").option("--err", "Also include launchd.err.log").option("--date <YYYY-MM-DD>", "Show a specific day instead of today").action(showLog);
cli.command("errors", "Show recent ERROR lines from daily logs").option("--lines <n>", "How many lines to print", { default: 20 }).action(showErrors);
cli.command("upgrade", "Upgrade to the latest published version via bun add -g").action(upgradeSelf);
cli.command("doctor", "Check environment").action(doctor);
cli.command("install-launch-agent", "Write LaunchAgent plist").action(installLaunchAgent);
cli.command("uninstall-launch-agent", "Unload LaunchAgent").action(uninstallLaunchAgent);
cli.command("status", "Print LaunchAgent status").action(async () => {
	await runCommand("launchctl", ["print", `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`], 1e4).then((r) => process.stdout.write(r.stdout || r.stderr));
});
cli.help();
cli.version(VERSION);
cli.parse();
//#endregion
export {};
