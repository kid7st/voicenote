#!/usr/bin/env bun
import { createRequire } from "node:module";
import { cac } from "cac";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
//#region \0rolldown/runtime.js
var __require = /* @__PURE__ */ createRequire(import.meta.url);
//#endregion
//#region src/cli.ts
const VERSION = "0.6.0";
const LAUNCH_AGENT_LABEL = "com.kid7st.voicenote";
const LOG_DIR = join(os.homedir(), ".local/state/voicenote/logs");
const LOCK_PATH = join(os.homedir(), ".local/state/voicenote/run.lock");
const CONFIG_DIR = join(os.homedir(), ".config/voicenote");
const SPEAKERS_PATH = join(CONFIG_DIR, "speakers.json");
const ARCHIVE_PATH = join(CONFIG_DIR, "archive.json");
const DOCUMENTS_ROOT = join(os.homedir(), "Documents");
const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".wma",
	".aac",
	".flac"
]);
const ZSHRC_ENV_KEYS = [
	"OPENAI_API_KEY",
	"OPENAI_TRANSCRIBE_MODEL",
	"OPENAI_SUMMARY_MODEL",
	"OPENAI_CLEAN_TRANSCRIPT_MODEL",
	"OPENAI_TIMEOUT_SECONDS",
	"OPENAI_MAX_RETRIES",
	"VOICENOTE_DEVICE_VOLUME",
	"VOICENOTE_RECORD_DIR",
	"VOICENOTE_WORKSPACE",
	"VOICENOTE_MIN_BYTES",
	"VOICENOTE_MIN_DURATION_SECONDS",
	"VOICENOTE_AUTO_ARCHIVE_THRESHOLD",
	"VOICENOTE_PENDING_REVIEW_THRESHOLD",
	"VOICENOTE_CLEAN_TRANSCRIPT",
	"VOICENOTE_TURBO_MIN_DURATION_SECONDS",
	"VOICENOTE_TURBO_CHUNK_SECONDS",
	"VOICENOTE_TURBO_OVERLAP_SECONDS",
	"VOICENOTE_TURBO_CONCURRENCY",
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
	"LOCAL_NO_PROXY"
];
function applyDerivedProxy() {
	const host = process.env.LOCAL_PROXY_HOST;
	const port = process.env.LOCAL_PROXY_PORT;
	if (!host || !port) return;
	const url = `http://${host}:${port}`;
	const noProxy = process.env.LOCAL_NO_PROXY || "localhost,127.0.0.1,::1";
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
	if (!process.env.no_proxy) process.env.no_proxy = noProxy;
	if (!process.env.NO_PROXY) process.env.NO_PROXY = noProxy;
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
	for (const key of ZSHRC_ENV_KEYS) {
		if (process.env[key]) continue;
		const pattern = new RegExp(`(?:^|\\n)\\s*export\\s+${key}=(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`);
		const match = content.match(pattern);
		const value = match?.[1] ?? match?.[2] ?? match?.[3];
		if (value !== void 0) process.env[key] = value;
	}
	applyDerivedProxy();
}
function getConfig() {
	loadDotZshrcEnv();
	const deviceVolume = process.env.VOICENOTE_DEVICE_VOLUME || "VTR6500";
	return {
		deviceVolume,
		recordDir: process.env.VOICENOTE_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`,
		workspace: expandHome(process.env.VOICENOTE_WORKSPACE || "~/Documents/00-Inbox/meetings"),
		minBytes: Number(process.env.VOICENOTE_MIN_BYTES || 1e5),
		minDurationSeconds: Number(process.env.VOICENOTE_MIN_DURATION_SECONDS || 60),
		autoArchiveThreshold: Number(process.env.VOICENOTE_AUTO_ARCHIVE_THRESHOLD || .85),
		pendingReviewThreshold: Number(process.env.VOICENOTE_PENDING_REVIEW_THRESHOLD || .6),
		transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize",
		cleanTranscriptModel: process.env.OPENAI_CLEAN_TRANSCRIPT_MODEL || process.env.OPENAI_SUMMARY_MODEL || "gpt-5.5",
		summaryModel: process.env.OPENAI_SUMMARY_MODEL || "gpt-5.5",
		cleanTranscript: ![
			"0",
			"false",
			"no"
		].includes((process.env.VOICENOTE_CLEAN_TRANSCRIPT || "1").toLowerCase()),
		turboMinDurationSeconds: Number(process.env.VOICENOTE_TURBO_MIN_DURATION_SECONDS || 1200),
		turboChunkSeconds: Number(process.env.VOICENOTE_TURBO_CHUNK_SECONDS || 600),
		turboOverlapSeconds: Number(process.env.VOICENOTE_TURBO_OVERLAP_SECONDS || 5),
		turboConcurrency: Number(process.env.VOICENOTE_TURBO_CONCURRENCY || 3),
		openaiTimeoutSeconds: Number(process.env.OPENAI_TIMEOUT_SECONDS || 300),
		openaiMaxRetries: Number(process.env.OPENAI_MAX_RETRIES || 2),
		speakers: loadSpeakers(),
		archive: loadArchive()
	};
}
const DEFAULT_SPEAKERS = {
	self: {
		name: null,
		aliases: []
	},
	known: []
};
const DEFAULT_ARCHIVE = {
	fallback: "00-Inbox/meetings/",
	allowed_roots: [
		"20-Companies",
		"40-Side-Projects",
		"10-Personal",
		"30-Career-History",
		"00-Inbox"
	],
	rules: []
};
function loadJsonSync(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
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
function loadArchive() {
	ensureConfigSeed();
	const data = loadJsonSync(ARCHIVE_PATH, DEFAULT_ARCHIVE);
	return {
		fallback: data.fallback || DEFAULT_ARCHIVE.fallback,
		allowed_roots: Array.isArray(data.allowed_roots) ? data.allowed_roots : DEFAULT_ARCHIVE.allowed_roots,
		rules: Array.isArray(data.rules) ? data.rules : []
	};
}
let configSeeded = false;
function ensureConfigSeed() {
	if (configSeeded) return;
	configSeeded = true;
	try {
		if (!existsSync(CONFIG_DIR)) __require("node:fs").mkdirSync(CONFIG_DIR, { recursive: true });
		if (!existsSync(SPEAKERS_PATH)) __require("node:fs").writeFileSync(SPEAKERS_PATH, JSON.stringify(DEFAULT_SPEAKERS, null, 2) + "\n", "utf8");
		if (!existsSync(ARCHIVE_PATH)) __require("node:fs").writeFileSync(ARCHIVE_PATH, JSON.stringify(DEFAULT_ARCHIVE, null, 2) + "\n", "utf8");
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
		prefix: `${month}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	};
}
function safeSlug(text, maxLen = 48) {
	return (text || "").trim().replace(/[\\/:*?"<>|\n\r\t]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/g, "") || "meeting";
}
function formatSeconds(seconds) {
	const total = Math.max(0, Math.round(seconds || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor(total % 3600 / 60);
	const s = total % 60;
	return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function parseTimestampToSeconds(value) {
	const parts = value.split(":").map(Number);
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return Number(value) || 0;
}
async function mapLimit(items, concurrency, worker) {
	const results = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await worker(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
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
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
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
async function appendPendingReview(config, meta) {
	const path = join(config.workspace, "_index", "pending-review.md");
	await mkdir(dirname(path), { recursive: true });
	if (!existsSync(path)) await writeFile(path, "# voicenote pending review\n\n", "utf8");
	await appendFile(path, `\n## ${meta.title || "未命名会议"}\n\n- 生成时间：${nowIso()}\n- 日期：${meta.date || ""}\n- 置信度：${meta.archive_confidence}\n- 建议路径：\`${meta.suggested_archive_path || ""}\`\n- 原因：${meta.archive_reason || ""}\n- 纪要：\`${meta.final_paths?.notes || meta.local_paths?.notes || ""}\`\n\n`, "utf8");
}
function dailyLogPath() {
	const d = /* @__PURE__ */ new Date();
	return join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}
let logWired = false;
function wireDailyLog() {
	if (logWired) return;
	logWired = true;
	try {
		__require("node:fs").mkdirSync(LOG_DIR, { recursive: true });
	} catch {}
	const path = dailyLogPath();
	const append = (level, args) => {
		const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
		const stamped = `${nowIso()} [${level}] ${line}\n`;
		try {
			__require("node:fs").appendFileSync(path, stamped, "utf8");
		} catch {}
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
async function acquireRunLock() {
	await mkdir(dirname(LOCK_PATH), { recursive: true });
	try {
		await mkdir(LOCK_PATH);
	} catch (e) {
		if (e?.code !== "EEXIST") throw e;
		try {
			const st = await stat(LOCK_PATH);
			if (Date.now() - st.mtimeMs > 1800 * 1e3) {
				await rmdir(LOCK_PATH).catch(() => {});
				try {
					await mkdir(LOCK_PATH);
				} catch {
					return null;
				}
			} else return null;
		} catch {
			return null;
		}
	}
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		await rmdir(LOCK_PATH).catch(() => {});
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
function shouldSkip(rec, state, config, force) {
	if (state.processed_source_ids?.[rec.sourceId] && !force) return [true, "already_processed"];
	if (rec.sizeBytes < config.minBytes) return [true, `too_small:${rec.sizeBytes}<${config.minBytes}`];
	if (rec.durationSeconds !== null && rec.durationSeconds < config.minDurationSeconds) return [true, `too_short:${rec.durationSeconds.toFixed(1)}<${config.minDurationSeconds}`];
	return [false, ""];
}
function initialLocalFiles(config, rec) {
	const { month, prefix } = dateParts(rec.recordedAt);
	return {
		audio: join(config.workspace, "_audio", month, `${prefix}-original${extname(rec.sourcePath).toLowerCase()}`),
		transcript: join(config.workspace, "_transcripts", month, `${prefix}-transcript.md`),
		notes: join(config.workspace, month, `${prefix}-meeting.md`),
		metadata: join(config.workspace, "_metadata", month, `${prefix}-metadata.json`)
	};
}
async function titledLocalFiles(config, rec, meta, files) {
	const { month, prefix } = dateParts(rec.recordedAt);
	const base = `${prefix}-${safeSlug(meta.title || "meeting")}`;
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
function openaiClient(config) {
	loadDotZshrcEnv();
	return new OpenAI({
		apiKey: process.env.OPENAI_API_KEY,
		timeout: config.openaiTimeoutSeconds * 1e3,
		maxRetries: config.openaiMaxRetries
	});
}
function formatTranscriptionResult(result) {
	if (typeof result === "string") return result.trim();
	if (Array.isArray(result?.segments)) {
		const lines = result.segments.map((seg) => {
			const text = String(seg.text || "").trim();
			if (!text) return "";
			const speaker = seg.speaker || "Speaker";
			return `[${formatSeconds(seg.start)}-${formatSeconds(seg.end)}] Speaker ${speaker}: ${text}`;
		}).filter(Boolean);
		if (lines.length) return lines.join("\n");
	}
	if (result?.text) return String(result.text).trim();
	return String(result);
}
async function transcribeAudio(config, audioPath) {
	const client = openaiClient(config);
	const isDiarize = config.transcribeModel === "gpt-4o-transcribe-diarize";
	const kwargs = {
		model: config.transcribeModel,
		file: createReadStream(audioPath),
		stream: true
	};
	if (isDiarize) {
		kwargs.response_format = "diarized_json";
		kwargs.chunking_strategy = "auto";
	}
	const stream = await client.audio.transcriptions.create(kwargs);
	const segments = [];
	let doneText = "";
	for await (const ev of stream) {
		const t = ev?.type;
		if (!t) continue;
		if (t === "transcript.text.segment") segments.push(ev);
		else if (t === "transcript.text.done") doneText = String(ev.text || "");
		else if (t === "transcript.text.delta" && !isDiarize) doneText += String(ev.delta || "");
	}
	if (segments.length) return formatTranscriptionResult({ segments });
	return doneText.trim() || "";
}
async function splitAudioForTurbo(config, audioPath, durationSeconds) {
	const tempDir = join(os.tmpdir(), `voicenote-turbo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(tempDir, { recursive: true });
	const chunks = [];
	const chunk = Math.max(60, config.turboChunkSeconds);
	const overlap = Math.max(0, Math.min(config.turboOverlapSeconds, 30));
	for (let base = 0, index = 0; base < durationSeconds; base += chunk, index++) {
		const start = Math.max(0, base - (index > 0 ? overlap : 0));
		const end = Math.min(durationSeconds, base + chunk + overlap);
		const out = join(tempDir, `chunk-${String(index + 1).padStart(3, "0")}${extname(audioPath).toLowerCase() || ".mp3"}`);
		const result = await runCommand("ffmpeg", [
			"-y",
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			String(start),
			"-t",
			String(Math.max(1, end - start)),
			"-i",
			audioPath,
			"-vn",
			"-acodec",
			"copy",
			out
		], 12e4);
		if (result.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg split failed for chunk ${index + 1}: ${result.stderr}`);
		chunks.push({
			index: index + 1,
			start,
			duration: end - start,
			path: out
		});
	}
	return {
		tempDir,
		chunks
	};
}
function offsetChunkTranscript(text, chunk) {
	const out = [`## Chunk ${String(chunk.index).padStart(2, "0")} (${formatSeconds(chunk.start)}-${formatSeconds(chunk.start + chunk.duration)})`];
	for (const line of text.split("\n")) {
		const m = line.match(/^\[(\d{2}(?::\d{2}){1,2})-(\d{2}(?::\d{2}){1,2})\]\s*(.*)$/);
		if (!m) {
			if (line.trim()) out.push(line);
			continue;
		}
		const start = formatSeconds(parseTimestampToSeconds(m[1]) + chunk.start);
		const end = formatSeconds(parseTimestampToSeconds(m[2]) + chunk.start);
		const rest = m[3].replace(/^Speaker\s+/i, `Chunk ${String(chunk.index).padStart(2, "0")} Speaker `);
		out.push(`[${start}-${end}] ${rest}`);
	}
	return out.join("\n");
}
async function reconcileMergedTranscript(config, merged, rec) {
	const client = openaiClient(config);
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

${speakerContextBlock(config.speakers)}`;
	const user = `录音时间：${rec.recordedAt.toISOString()}\n源文件：${basename(rec.sourcePath)}\n\n请合并并校准以下分块 transcript：\n\n${merged}`;
	const req = {
		model: config.cleanTranscriptModel,
		messages: [{
			role: "system",
			content: system
		}, {
			role: "user",
			content: user
		}]
	};
	if (!config.cleanTranscriptModel.toLowerCase().startsWith("gpt-5")) req.temperature = 0;
	return (await client.chat.completions.create(req)).choices[0]?.message?.content?.trim() || merged;
}
async function transcribeAudioTurbo(config, audioPath, rec) {
	const { tempDir, chunks } = await splitAudioForTurbo(config, audioPath, rec.durationSeconds || await ffprobeDuration(audioPath) || 0);
	try {
		console.log(`Turbo: split into ${chunks.length} chunks; concurrency=${config.turboConcurrency}; chunk=${config.turboChunkSeconds}s; overlap=${config.turboOverlapSeconds}s`);
		const rawMerged = (await mapLimit(chunks, config.turboConcurrency, async (chunk) => {
			console.log(`Turbo: transcribing chunk ${chunk.index}/${chunks.length} (${formatSeconds(chunk.start)}-${formatSeconds(chunk.start + chunk.duration)})`);
			return offsetChunkTranscript(await transcribeAudio(config, chunk.path), chunk);
		})).join("\n\n");
		console.log("Turbo: reconciling merged transcript speakers/context");
		return {
			transcript: await reconcileMergedTranscript(config, rawMerged, rec),
			rawMerged,
			chunks
		};
	} finally {
		await rm(tempDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
function speakerContextBlock(speakers) {
	return `Speaker context（用于尽可能把 Speaker A/B/C 还原成真实姓名，但只在证据充分时替换）：\n- ${speakers.self.name ? `用户本人：${speakers.self.name}${speakers.self.aliases.length ? `（别名：${speakers.self.aliases.join("、")}）` : ""}` : "用户本人姓名未配置。"}\n- 其他已知说话人：\n${speakers.known.length ? speakers.known.map((k) => `- ${k.name}${k.aliases?.length ? `（别名：${k.aliases.join("、")}）` : ""}${k.relationship ? `，${k.relationship}` : ""}`).join("\n") : "（无其他已知说话人）"}\n\n判断规则：\n- 录音只有一个说话人，且本人姓名已配置，可以把 Speaker A 视为本人。\n- 多人对话中若某说话人被其他人称呼为本人姓名/别名，则该说话人为本人。\n- 多人对话中若某说话人被其他人称呼为已知说话人的姓名/别名，则该说话人为该已知说话人。\n- 其他无法确认的，保留 Speaker A/B/C，不要硬猜。`;
}
async function cleanTranscript(config, transcript, rec) {
	if (!config.cleanTranscript || !transcript.trim() || transcript.startsWith("[NO_OPENAI]")) return transcript;
	const client = openaiClient(config);
	const system = `你是中文会议录音转写清洗助手。你的任务不是总结，而是把原始转写整理成更准确、更易读的 transcript。

规则：
- 保留时间戳；保留 Speaker 标签结构。
- 修正明显错别字、标点和中英文术语。
- 不要删除实质信息，不要添加原文没有的信息。
- 对听不清或明显可疑的词，用「[不确定：原词?]」标记。
- 如果连续多段同一说话人表达同一意思，可以轻微整理语序，但不要改写成纪要。
- 输出纯 transcript 文本，不要 markdown 标题，不要解释。

${speakerContextBlock(config.speakers)}

说话人替换规则：
- 仅在证据充分时把 \`Speaker A\` / \`Speaker B\` 等标签替换为真实姓名。例如全局都使用 \`Speaker A:\` 改写为 \`石洋:\`。
- 替换时保持时间戳行格式不变，例如：\`[00:05-00:21] 石洋: ...\`。
- 没把握的保留原标签。`;
	const user = `录音时间：${rec.recordedAt.toISOString()}\n源文件：${basename(rec.sourcePath)}\n\n请清洗以下转写：\n\n${transcript}`;
	const req = {
		model: config.cleanTranscriptModel,
		messages: [{
			role: "system",
			content: system
		}, {
			role: "user",
			content: user
		}]
	};
	if (!config.cleanTranscriptModel.toLowerCase().startsWith("gpt-5")) req.temperature = 0;
	return (await client.chat.completions.create(req)).choices[0]?.message?.content?.trim() || transcript;
}
function archiveRulesBlock(archive) {
	return `归档目标（按下列规则匹配，路径中的 {YYYY-MM} 会被替换为录音月份）：\n${archive.rules.length ? archive.rules.map((r) => `- ${r.target}\n  - 关键词：${(r.keywords || []).join("、") || "（无）"}\n  - 说明：${r.description || ""}`).join("\n") : "（暂无定制规则，建议在 ~/.config/voicenote/archive.json 中补充）"}\n\nFallback：${archive.fallback}\n允许的根目录：${archive.allowed_roots.join("、")}\n如果不能确定，使用 fallback 路径。`;
}
function summaryMessages(config, transcript, rec, localAudioPath, opts = {}) {
	const system = `你是石洋的个人语义整理助手，不是通用会议纪要模板生成器。

你的目标不是复刻“会议纪要”格式，而是把一段录音变成一份最高效的理解材料：让石洋快速知道这段讨论真正讲了什么、为什么重要、里面有什么思想/判断/事项、应该关注什么、后续该做什么。

核心原则：
1. 结构完全由内容决定。不要套用任何固定模板，不要为了形式输出固定章节。
2. 优先抓“语义价值”，而不是逐段复述。重点提炼观点、问题、判断、取舍、隐含假设、行动线索和后续关注点。
3. 可以自由选择表达形态：短备忘、战略 memo、问题树、决策记录、行动清单、思维导图式层级、时间线、学习笔记、产品/技术分析、复盘等；选最适合这段内容的一种或几种。
4. 如果讨论是思想性/探索性的，重点帮助读者理解思路脉络、关键概念、推理链条、值得回看的点；不要硬拆待办。
5. 如果讨论是执行性/项目性的，重点明确结论、事项、负责人、风险、下一步；不要硬写思想总结。
6. 如果讨论很短，只输出最少但有用的内容；如果讨论很长，可以先给阅读指南，再展开。
7. 避免空话、套话和形式主义标题。每个标题都应该有信息量。
8. transcript 中如果出现真实姓名（参考下方 Speaker context），直接用真实姓名；只在没把握时保留 Speaker A/B/C。
9. 不确定或疑似转写错误的词要明确标注，不要当成事实。
10. 如果当前是 Fast mode，输入 transcript 是“未单独清洗的原始转写”。你必须在生成内容前先在内部完成清理和梳理：纠正明显错别字、统一术语、还原 speaker、合并口语重复、修正标点和断句；但不要编造原文没有的信息。

输出必须是合法 JSON，不要 markdown fence。

${speakerContextBlock(config.speakers)}

${archiveRulesBlock(config.archive)}

归档置信度规则：
- >= 0.85：非常明确属于某个规则匹配的目录，可自动归档
- 0.60 - 0.85：有合理建议，但仍需人工确认
- < 0.60：无法确定，使用 fallback 路径

路径要求：必须是相对 ~/Documents 的路径，不能以 / 开头，不能包含 ..。`;
	const user = `请基于下面 transcript 生成一份“语义整理笔记”。

处理模式：${opts.fastMode ? "Fast mode（已跳过单独 transcript 清洗；请在生成笔记时完成内部清理、纠错、梳理和 speaker 还原）" : "Quality mode（transcript 已经过单独清洗或 reconciliation）"}

你要服务的阅读场景：
- 石洋以后打开这篇笔记时，应该能立刻知道：这段录音值得看什么、核心思想/事项是什么、哪些地方需要理解、哪些问题还没解决、下一步应该做什么。
- 不要假设这一定是“会议”；它可能是自言自语、产品思考、技术讨论、商业判断、学习笔记、灵感记录、电话沟通或执行任务。
- 不要参考飞书/通用会议纪要结构。markdown 的结构由内容语义决定。

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
  "markdown": "完整 markdown 正文。必须从 # 标题 开始。结构完全由你根据语义设计，不要包含底部来源与归档 details，系统会自动追加。",
  "action_items": [{"task": "string", "owner": "string|null", "due_date": "YYYY-MM-DD|null", "priority": "high|medium|low|null", "note": "string|null"}],
  "decisions": [{"decision": "string", "reason": "string|null", "owner": "string|null", "date": "YYYY-MM-DD|null"}],
  "open_questions": [{"question": "string", "next_step": "string|null"}],
  "key_quotes_or_details": ["string"],
  "transcription_uncertainties": ["string"],
  "suggested_archive_path": "string|null",
  "archive_confidence": 0.0,
  "archive_reason": "string|null"
}

markdown 质量要求：
- 第一屏要高信噪比：读者不用看完整 transcript，也能知道这段内容为什么值得保留。
- 不要输出空章节；不要输出“无明确记录/未知/未识别”这类占位内容。
- 不要强制包含“总结、待办、智能章节、关键决策、金句”等标题；只有语义上需要时才用。
- 如果有行动项，用具体可执行语言；如果没有明确行动项，不要硬造。
- 如果有思想/判断，写出推理链，而不只是结论。
- 如果有争议、风险、待验证假设，要明显标出。
- 如果时间戳能帮助回看关键片段，可以少量使用；不要为了形式做完整时间线。
- 如果 transcript 有不确定词，放在上下文里提醒读者，不要把不确定词当事实。
- Fast mode 下尤其要避免把原始转写里的口吃、重复、错别字直接搬进笔记；正文应呈现清理和梳理后的内容。

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
async function summarizeTranscript(config, transcript, rec, localAudioPath, opts = {}) {
	const client = openaiClient(config);
	const req = {
		model: config.summaryModel,
		messages: summaryMessages(config, transcript, rec, localAudioPath, opts),
		response_format: { type: "json_object" }
	};
	if (!config.summaryModel.toLowerCase().startsWith("gpt-5")) req.temperature = .2;
	const content = (await client.chat.completions.create(req)).choices[0]?.message?.content || "{}";
	return JSON.parse(content);
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
		"action_items",
		"decisions",
		"open_questions",
		"key_quotes_or_details",
		"transcription_uncertainties"
	]) if (!Array.isArray(meta[key])) meta[key] = [];
	meta.participants = meta.participants.filter((p) => typeof p === "string" && p.trim() && !isSpeakerLabel(p));
	meta.archive_confidence = Math.max(0, Math.min(1, Number(meta.archive_confidence || 0)));
	return meta;
}
function sourceDetails(meta, audioPath, transcriptPath) {
	return `<details>\n<summary>来源与归档信息</summary>\n\n- 纪要生成来源：voicenote 自动转写\n- 原始音频：\`${audioPath}\`\n- 完整转写：\`${transcriptPath}\`\n- 建议归档路径：\`${meta.suggested_archive_path || ""}\`\n- 归档置信度：${meta.archive_confidence}\n- 归档原因：${meta.archive_reason || "无"}\n\n</details>`;
}
function markdownNotes(meta, audioPath, transcriptPath) {
	let body = typeof meta.markdown === "string" && meta.markdown.trim() ? meta.markdown.trim() : `# ${meta.title || "未命名录音纪要"}\n`;
	if (!body.startsWith("#")) body = `# ${meta.title || "未命名录音纪要"}\n\n${body}`;
	if (!body.includes("来源与归档信息")) body = `${body.trim()}\n\n${sourceDetails(meta, audioPath, transcriptPath)}`;
	return `${body.trim()}\n`;
}
function transcriptMarkdown(config, rec, transcript, rawTranscript, opts = {}) {
	const raw = rawTranscript && rawTranscript.trim() !== transcript.trim() ? `\n\n---\n\n## 原始转写\n\n${rawTranscript.trim()}\n` : "";
	const cleanModel = opts.fastMode ? "Fast mode：跳过单独清洗，纪要生成时内部清理" : config.cleanTranscript ? config.cleanTranscriptModel : "未启用";
	const section = opts.fastMode ? "原始转写（Fast mode，未单独清洗）" : "清洗后转写";
	return `# 录音转写：${basename(rec.sourcePath)}\n\n- 源文件：\`${rec.sourcePath}\`\n- 转写模型：\`${config.transcribeModel}\`\n- 清洗模型：\`${cleanModel}\`\n- 录音时间：${rec.recordedAt.toISOString()}\n- 文件大小：${rec.sizeBytes} bytes\n- 时长：${rec.durationSeconds ?? "未知"} seconds\n- 转写时间：${nowIso()}\n\n---\n\n## ${section}\n\n${transcript.trim()}${raw}`;
}
function sanitizeArchivePath(config, pathValue, rec) {
	if (!pathValue) return null;
	let raw = String(pathValue).trim().replace(/^`|`$/g, "").replace(/^~\/?/, "").replace(/^\//, "");
	if (raw.startsWith("Documents/")) raw = raw.slice(10);
	if (raw.split("/").includes("..")) return null;
	if (!config.archive.allowed_roots.some((root) => raw.startsWith(root))) return null;
	const { month } = dateParts(rec.recordedAt);
	raw = raw.replace(/\{YYYY-MM\}/g, month);
	const parts = raw.split("/").filter(Boolean);
	if (["20-Companies", "40-Side-Projects"].includes(parts[0] || "") && !parts.includes("meetings")) raw = `${raw.replace(/\/$/, "")}/meetings/${month}`;
	else if (parts.at(-1) === "meetings") raw = `${raw.replace(/\/$/, "")}/${month}`;
	return raw;
}
async function moveToArchive(config, files, meta, rec) {
	const relDir = sanitizeArchivePath(config, meta.suggested_archive_path, rec);
	if (!relDir || meta.archive_confidence < config.autoArchiveThreshold || relDir.startsWith("00-Inbox")) return [{}, relDir];
	const targetDir = join(DOCUMENTS_ROOT, relDir);
	await mkdir(targetDir, { recursive: true });
	const { prefix } = dateParts(rec.recordedAt);
	const base = `${prefix}-${safeSlug(meta.title || "meeting")}`;
	const targets = {
		audio: join(targetDir, `${base}-original${extname(files.audio)}`),
		transcript: join(targetDir, `${base}-transcript.md`),
		notes: join(targetDir, `${base}.md`),
		metadata: join(targetDir, `${base}-metadata.json`)
	};
	for (const [key, src] of Object.entries(files)) if (existsSync(src)) await rename(src, targets[key]);
	return [targets, relDir];
}
async function processRecording(config, rec, opts) {
	console.log(`Processing: ${rec.sourcePath}`);
	let files = initialLocalFiles(config, rec);
	if (opts.dryRun) return {
		source_path: rec.sourcePath,
		source_id: rec.sourceId,
		would_copy_to: files.audio,
		size_bytes: rec.sizeBytes,
		duration_seconds: rec.durationSeconds
	};
	await mkdir(dirname(files.audio), { recursive: true });
	await copyFile(rec.sourcePath, files.audio);
	let rawTranscript;
	let transcript;
	let meta;
	if (opts.noOpenai || opts.openai === false) {
		transcript = "[NO_OPENAI] 未执行 OpenAI 转写。";
		meta = {
			title: basename(rec.sourcePath, extname(rec.sourcePath)),
			markdown: `# ${basename(rec.sourcePath, extname(rec.sourcePath))}\n\n未执行 OpenAI 总结。`,
			suggested_archive_path: config.archive.fallback,
			archive_confidence: 0,
			archive_reason: "no_openai 模式，无法判断归档位置。"
		};
	} else {
		const fastMode = Boolean(opts.fast);
		const turboMode = Boolean(opts.turbo) && (rec.durationSeconds || 0) >= config.turboMinDurationSeconds;
		if (Boolean(opts.turbo) && !turboMode) console.log(`Turbo requested but skipped: duration ${rec.durationSeconds ?? "unknown"}s < ${config.turboMinDurationSeconds}s`);
		if (turboMode) {
			const turbo = await transcribeAudioTurbo(config, files.audio, rec);
			rawTranscript = turbo.rawMerged;
			transcript = turbo.transcript;
			meta = await summarizeTranscript(config, transcript, rec, files.audio, { fastMode });
			meta.processing_mode = fastMode ? "turbo-fast" : "turbo";
			meta.turbo = {
				chunk_seconds: config.turboChunkSeconds,
				overlap_seconds: config.turboOverlapSeconds,
				concurrency: config.turboConcurrency,
				chunks: turbo.chunks.map((c) => ({
					index: c.index,
					start: c.start,
					duration: c.duration
				}))
			};
		} else {
			rawTranscript = await transcribeAudio(config, files.audio);
			transcript = fastMode ? rawTranscript : await cleanTranscript(config, rawTranscript, rec);
			meta = await summarizeTranscript(config, transcript, rec, files.audio, { fastMode });
			meta.processing_mode = fastMode ? "fast" : "quality";
		}
	}
	meta = normalizeMetadata(meta, rec);
	files = await titledLocalFiles(config, rec, meta, files);
	await mkdir(dirname(files.transcript), { recursive: true });
	await mkdir(dirname(files.notes), { recursive: true });
	await writeFile(files.transcript, transcriptMarkdown(config, rec, transcript, rawTranscript, { fastMode: Boolean(opts.fast) && !String(meta.processing_mode || "").startsWith("turbo") }), "utf8");
	await writeFile(files.notes, markdownNotes(meta, files.audio, files.transcript), "utf8");
	meta.source_audio_path = rec.sourcePath;
	meta.source_id = rec.sourceId;
	meta.source_size_bytes = rec.sizeBytes;
	meta.source_modified_at = rec.modifiedAt;
	meta.duration_seconds = rec.durationSeconds;
	meta.transcribe_model = config.transcribeModel;
	meta.clean_transcript_model = meta.processing_mode === "fast" ? null : config.cleanTranscript ? config.cleanTranscriptModel : null;
	meta.summary_model = config.summaryModel;
	meta.processed_at = nowIso();
	meta.local_paths = files;
	meta.final_paths = {
		audio: null,
		transcript: null,
		notes: null,
		metadata: null
	};
	if (opts.noArchive || opts.archive === false) {
		meta.archive_status = "inbox_only";
		meta.final_paths = files;
		await writeJson(files.metadata, meta);
	} else {
		await writeJson(files.metadata, meta);
		const [finalPaths] = await moveToArchive(config, files, meta, rec);
		if (Object.keys(finalPaths).length) {
			meta.archive_status = "auto_moved";
			meta.final_paths = finalPaths;
			await writeFile(finalPaths.notes, markdownNotes(meta, finalPaths.audio, finalPaths.transcript), "utf8");
			await writeJson(finalPaths.metadata, meta);
		} else {
			meta.archive_status = meta.archive_confidence >= config.pendingReviewThreshold ? "pending_review" : "inbox_only";
			meta.final_paths = files;
			await writeJson(files.metadata, meta);
			if (meta.archive_status === "pending_review") await appendPendingReview(config, meta);
		}
	}
	await appendJsonl(join(config.workspace, "_index", "meetings.jsonl"), meta);
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
		console.log(`Recorder not mounted or record dir missing: ${config.recordDir}`);
		return;
	}
	const recordings = await scanRecordings(config);
	const eligible = [];
	for (const rec of recordings) {
		const [skip, reason] = shouldSkip(rec, state, config, Boolean(opts.force));
		if (skip) {
			if (!state.skipped_source_ids[rec.sourceId] && reason !== "already_processed") state.skipped_source_ids[rec.sourceId] = {
				source_path: rec.sourcePath,
				reason,
				size_bytes: rec.sizeBytes,
				duration_seconds: rec.durationSeconds,
				seen_at: nowIso()
			};
			console.log(`Skip: ${basename(rec.sourcePath)} (${reason})`);
		} else eligible.push(rec);
	}
	const targets = opts.latestOnly ? eligible.slice(0, 1) : eligible;
	for (const rec of targets) try {
		const result = await processRecording(config, rec, opts);
		if (!opts.dryRun) {
			state.processed_source_ids[rec.sourceId] = {
				source_path: rec.sourcePath,
				processed_at: nowIso(),
				archive_status: result.archive_status,
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
async function installLaunchAgent() {
	const cliPath = fileURLToPath(import.meta.url);
	const plist = plistPath();
	await mkdir(dirname(plist), { recursive: true });
	await mkdir(LOG_DIR, { recursive: true });
	await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${existsSync("/opt/homebrew/bin/bun") ? "/opt/homebrew/bin/bun" : process.execPath}</string>
    <string>${cliPath}</string>
    <string>run</string>
    <string>--once</string>
    <string>--turbo</string>
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
    <key>PATH</key>
    <string>${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`, "utf8");
	console.log(`LaunchAgent written: ${plist}`);
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
		console.log(`No meetings in ${dir}`);
		return;
	}
	const entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
	if (!entries.length) {
		console.log(`No meetings in ${dir}`);
		return;
	}
	for (const name of entries) console.log(join(dir, name));
}
async function lastMeeting() {
	const indexPath = join(getConfig().workspace, "_index", "meetings.jsonl");
	if (!existsSync(indexPath)) {
		console.log("No meetings indexed yet.");
		return;
	}
	const lines = (await readFile(indexPath, "utf8")).trim().split("\n").filter(Boolean);
	const last = lines[lines.length - 1];
	if (!last) {
		console.log("No meetings indexed yet.");
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
	console.log(`Status:       ${obj.archive_status} (confidence ${obj.archive_confidence})`);
	console.log(`Suggested:    ${obj.suggested_archive_path}`);
	console.log(`Notes:        ${obj.final_paths?.notes || obj.local_paths?.notes}`);
	console.log(`Transcript:   ${obj.final_paths?.transcript || obj.local_paths?.transcript}`);
	console.log(`Audio:        ${obj.final_paths?.audio || obj.local_paths?.audio}`);
}
async function showPending() {
	const path = join(getConfig().workspace, "_index", "pending-review.md");
	if (!existsSync(path)) {
		console.log("No pending review entries.");
		return;
	}
	process.stdout.write(await readFile(path, "utf8"));
}
async function openTarget(args) {
	const config = getConfig();
	let target = config.workspace;
	const arg = args[0];
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
async function forgetRecording(args) {
	if (!args.length) {
		console.log("Usage: vn forget <source_id|filename>");
		return;
	}
	const needle = args[0];
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
	console.log(`$ ${cmd} add -g @kid7st/voicenote@latest`);
	const child = spawn(cmd, [
		"add",
		"-g",
		"@kid7st/voicenote@latest"
	], { stdio: "inherit" });
	await new Promise((res) => child.on("close", () => res()));
}
async function watchLoop(opts) {
	const interval = Number(opts.interval || 60) * 1e3;
	for (;;) {
		await runPipeline({ once: true });
		if (opts.once) return;
		await new Promise((res) => setTimeout(res, interval));
	}
}
async function doctor() {
	const config = getConfig();
	console.log(`version=${VERSION}`);
	console.log(`bun=${process.versions.bun || "not-bun"}`);
	console.log(`node=${process.version}`);
	console.log(`recordDir=${config.recordDir} exists=${existsSync(config.recordDir)}`);
	console.log(`workspace=${config.workspace}`);
	console.log(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "loaded" : "missing"}`);
	console.log(`transcribeModel=${config.transcribeModel}`);
	console.log(`cleanTranscriptModel=${config.cleanTranscriptModel}`);
	console.log(`summaryModel=${config.summaryModel}`);
	console.log(`turbo=minDuration:${config.turboMinDurationSeconds}s chunk:${config.turboChunkSeconds}s overlap:${config.turboOverlapSeconds}s concurrency:${config.turboConcurrency}`);
	console.log(`http_proxy=${process.env.http_proxy || "<unset>"}`);
	console.log(`speakers.self=${config.speakers.self.name || "<unset>"}`);
	console.log(`speakers.known=${config.speakers.known.length}`);
	console.log(`archive.rules=${config.archive.rules.length}`);
	console.log(`launch_agent_plist=${plistPath()}`);
	const ff = await runCommand("ffprobe", ["-version"], 5e3);
	console.log(`ffprobe=${ff.code === 0 ? "ok" : "missing"}`);
	const ffmpeg = await runCommand("ffmpeg", ["-version"], 5e3);
	console.log(`ffmpeg=${ffmpeg.code === 0 ? "ok" : "missing"}`);
}
const cli = cac("vn");
cli.command("run", "Scan recorder and process recordings (default once)").option("--once", "Scan once and exit", { default: true }).option("--latest-only", "Only process newest eligible recording").option("--force", "Reprocess already processed recordings").option("--dry-run", "Do not copy/transcribe/archive").option("--no-openai", "Copy only and create placeholder notes").option("--no-archive", "Do not auto-move out of Inbox").option("--fast", "Skip separate transcript cleanup; summary model cleans/organizes transcript internally").option("--turbo", "For long audio: split into chunks, transcribe in parallel, then reconcile speakers/context").action(runPipeline);
cli.command("watch", "Continuously poll the recorder").option("--interval <seconds>", "Poll interval seconds", { default: 60 }).action(watchLoop);
cli.command("list", "List meeting notes in a month").option("--month <YYYY-MM>", "Month to list (default: current month)").action(listMeetings);
cli.command("last", "Print summary of most recent processed recording").action(lastMeeting);
cli.command("pending", "Print pending-review.md").action(showPending);
cli.command("open [target]", "Open meetings dir, config dir (`config`), logs dir (`logs`), or a note matching the slug").action((target) => openTarget(target ? [target] : []));
cli.command("forget <key>", "Remove a recording from processed/skipped state so it can be reprocessed").action((key) => forgetRecording([key]));
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
