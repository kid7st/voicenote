#!/usr/bin/env bun
import { createRequire } from "node:module";
import { cac } from "cac";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
//#region \0rolldown/runtime.js
var __require = /* @__PURE__ */ createRequire(import.meta.url);
//#endregion
//#region src/cli.ts
const LAUNCH_AGENT_LABEL = "com.kid7st.voicenote";
const LOG_DIR_REL = ".local/state/voicenote/logs";
const cli = cac("vn");
const DOCUMENTS_ROOT = expandHome("~/Documents");
const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".wma",
	".aac",
	".flac"
]);
function expandHome(path) {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
	return path;
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
const ZSHRC_ENV_KEYS = [
	"OPENAI_API_KEY",
	"OPENAI_TRANSCRIBE_MODEL",
	"OPENAI_SUMMARY_MODEL",
	"OPENAI_CLEAN_TRANSCRIPT_MODEL",
	"OPENAI_TIMEOUT_SECONDS",
	"OPENAI_MAX_RETRIES",
	"PHILIPS_DEVICE_VOLUME",
	"PHILIPS_RECORD_DIR",
	"PHILIPS_WORKSPACE",
	"PHILIPS_MIN_BYTES",
	"PHILIPS_MIN_DURATION_SECONDS",
	"PHILIPS_AUTO_ARCHIVE_THRESHOLD",
	"PHILIPS_PENDING_REVIEW_THRESHOLD",
	"PHILIPS_CLEAN_TRANSCRIPT",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"no_proxy",
	"NO_PROXY"
];
let zshrcEnvLoaded = false;
function loadDotZshrcEnv() {
	if (zshrcEnvLoaded) return;
	zshrcEnvLoaded = true;
	const zshrc = join(os.homedir(), ".zshrc");
	if (!existsSync(zshrc)) return;
	const content = readFileSyncSafe(zshrc);
	if (!content) return;
	for (const key of ZSHRC_ENV_KEYS) {
		if (process.env[key]) continue;
		const pattern = new RegExp(`(?:^|\\n)\\s*export\\s+${key}=(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`);
		const match = content.match(pattern);
		const value = match?.[1] ?? match?.[2] ?? match?.[3];
		if (value !== void 0) process.env[key] = value;
	}
}
function readFileSyncSafe(path) {
	try {
		return __require("node:fs").readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
function getConfig() {
	const deviceVolume = process.env.PHILIPS_DEVICE_VOLUME || "VTR6500";
	return {
		deviceVolume,
		recordDir: process.env.PHILIPS_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`,
		workspace: expandHome(process.env.PHILIPS_WORKSPACE || "~/Documents/00-Inbox/meetings"),
		minBytes: Number(process.env.PHILIPS_MIN_BYTES || 1e5),
		minDurationSeconds: Number(process.env.PHILIPS_MIN_DURATION_SECONDS || 60),
		autoArchiveThreshold: Number(process.env.PHILIPS_AUTO_ARCHIVE_THRESHOLD || .85),
		pendingReviewThreshold: Number(process.env.PHILIPS_PENDING_REVIEW_THRESHOLD || .6),
		transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize",
		cleanTranscriptModel: process.env.OPENAI_CLEAN_TRANSCRIPT_MODEL || process.env.OPENAI_SUMMARY_MODEL || "gpt-5.5",
		summaryModel: process.env.OPENAI_SUMMARY_MODEL || "gpt-5.5",
		cleanTranscript: ![
			"0",
			"false",
			"no"
		].includes((process.env.PHILIPS_CLEAN_TRANSCRIPT || "1").toLowerCase()),
		openaiTimeoutSeconds: Number(process.env.OPENAI_TIMEOUT_SECONDS || 300),
		openaiMaxRetries: Number(process.env.OPENAI_MAX_RETRIES || 2)
	};
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
	await Bun.write(path, (existsSync(path) ? await readFile(path, "utf8") : "") + JSON.stringify(data) + "\n");
}
async function appendPendingReview(config, metadata) {
	const path = join(config.workspace, "_index", "pending-review.md");
	await mkdir(dirname(path), { recursive: true });
	let current = existsSync(path) ? await readFile(path, "utf8") : "# PHILIPS Recorder Pending Review\n\n";
	current += `\n## ${metadata.title || "未命名会议"}\n\n- 生成时间：${nowIso()}\n- 日期：${metadata.date || ""}\n- 置信度：${metadata.archive_confidence}\n- 建议路径：\`${metadata.suggested_archive_path || ""}\`\n- 原因：${metadata.archive_reason || ""}\n- 纪要：\`${metadata.final_paths?.notes || metadata.local_paths?.notes || ""}\`\n\n`;
	await writeFile(path, current, "utf8");
}
function parseRecordedAt(path) {
	const match = basename(path, extname(path)).match(/(20\d{12})/);
	if (match?.[1]) {
		const s = match[1];
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
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => stdout += String(d));
		child.stderr.on("data", (d) => stderr += String(d));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				stdout,
				stderr,
				code: code ?? 1
			});
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
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
	const value = Number(result.stdout.trim());
	return Number.isFinite(value) ? value : null;
}
async function walk(dir) {
	const entries = [];
	if (!existsSync(dir)) return entries;
	for await (const entry of new Bun.Glob("**/*").scan({
		cwd: dir,
		absolute: true,
		dot: true
	})) entries.push(entry);
	return entries;
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
	const files = await walk(config.recordDir);
	const recordings = [];
	for (const file of files) {
		if (!isCandidateFile(file)) continue;
		const st = await stat(file).catch(() => null);
		if (!st?.isFile()) continue;
		const recordedAt = parseRecordedAt(file);
		recordings.push({
			sourcePath: file,
			sizeBytes: st.size,
			modifiedAt: st.mtime.toISOString(),
			durationSeconds: await ffprobeDuration(file),
			sourceId: await sourceIdFor(file),
			recordedAt
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
function formatSeconds(seconds) {
	const total = Math.max(0, Math.round(seconds || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor(total % 3600 / 60);
	const s = total % 60;
	return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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
function openaiClient(config) {
	loadDotZshrcEnv();
	return new OpenAI({
		apiKey: process.env.OPENAI_API_KEY,
		timeout: config.openaiTimeoutSeconds * 1e3,
		maxRetries: config.openaiMaxRetries
	});
}
async function transcribeAudio(config, audioPath) {
	const client = openaiClient(config);
	const kwargs = {
		model: config.transcribeModel,
		file: createReadStream(audioPath)
	};
	if (config.transcribeModel === "gpt-4o-transcribe-diarize") {
		kwargs.response_format = "diarized_json";
		kwargs.chunking_strategy = "auto";
	}
	return formatTranscriptionResult(await client.audio.transcriptions.create(kwargs));
}
async function cleanTranscript(config, transcript, rec) {
	if (!config.cleanTranscript || !transcript.trim() || transcript.startsWith("[NO_OPENAI]")) return transcript;
	const client = openaiClient(config);
	const messages = [{
		role: "system",
		content: `你是中文会议录音转写清洗助手。你的任务不是总结，而是把原始转写整理成更准确、更易读的 transcript。\n\n规则：\n- 保留时间戳和 Speaker A/B/C 标签；不要合并成无说话人的全文。\n- 修正明显错别字、标点和中英文术语。\n- 不要删除实质信息，不要添加原文没有的信息。\n- 对听不清或明显可疑的词，用「[不确定：原词?]」标记。\n- 如果连续多段同一说话人表达同一意思，可以轻微整理语序，但不要改写成纪要。\n- 输出纯 transcript 文本，不要 markdown 标题，不要解释。`
	}, {
		role: "user",
		content: `录音时间：${rec.recordedAt.toISOString()}\n源文件：${basename(rec.sourcePath)}\n\n请清洗以下转写：\n\n${transcript}`
	}];
	const req = {
		model: config.cleanTranscriptModel,
		messages
	};
	if (!config.cleanTranscriptModel.toLowerCase().startsWith("gpt-5")) req.temperature = 0;
	return (await client.chat.completions.create(req)).choices[0]?.message?.content?.trim() || transcript;
}
function summaryMessages(transcript, rec, localAudioPath) {
	const system = `你是一个高水平中文智能纪要助手，能力目标接近飞书妙记/智能纪要，但不要机械照抄任何固定模板。\n\n核心原则：\n1. 让 GPT 自己根据会议内容设计最佳纪要结构。\n2. 不要被固定字段限制；不要强行输出“概览/主要内容/方案/风险/建议”等章节。\n3. 只有内容里真的有的信息才写；没有就省略。\n4. 长会议可以有“总结、待办、智能章节、关键决策、金句时刻”等；短语音备忘可以只保留“总结、下一步”。\n5. 如果 transcript 有时间戳，请优先生成“智能章节”式的时间线结构；但短录音不必硬拆很多章节。\n6. 如果 transcript 有 Speaker A/B/C，请用于区分发言和观点，但不要把 Speaker A 当作真实姓名。\n7. 不确定或疑似转写错误的词要明确标注，不要当成事实。\n8. 输出给用户阅读的 markdown 要直接可用，少废话、少空章节、少元数据噪音。\n\n你必须输出合法 JSON，不要 markdown fence。\n\n可用归档根目录：
- 20-Companies/kua.ai/：Kua.ai、跨海科技、Kuahai, Inc.、跨境电商 SaaS、公司客户项目
- 20-Companies/ai-creator-llc/：AI Creator LLC、美国 LLC、AI Creator 相关业务
- 40-Side-Projects/<项目名>/：个人副业/独立项目
- 10-Personal/<分类>/：个人身份、学习、简历、教育
- 30-Career-History/<公司名>/：历史雇主/已退出公司
- 00-Inbox/meetings/：无法确定\n\n归档置信度规则：\n- >= 0.85：非常明确属于某个公司/项目/个人分类，可自动归档\n- 0.60-0.85：有合理建议，但仍需人工确认\n- < 0.60：无法确定，留在 Inbox\n\n归档路径规则：\n- 公司会议优先使用 meetings/YYYY-MM/。\n- 客户项目可使用 projects/<客户名>/meetings/YYYY-MM/。\n- 路径必须是相对 ~/Documents 的路径，不能以 / 开头，不能包含 ..。`;
	const user = `请基于下面 transcript 生成一份“智能纪要”。\n\n你可以参考飞书妙记常见结构，但不要机械套用。可选结构包括：\n- 总结\n- 待办\n- 智能章节（带时间戳）\n- 关键决策\n- 金句时刻\n- 待确认问题\n- 相关链接 / 原始转写入口\n\n请自行判断哪些章节该出现、顺序如何、标题如何命名。尤其是短录音，应该更简洁。\n\n录音信息：\n- 源文件：${rec.sourcePath}\n- 本地音频：${localAudioPath}\n- 录音文件名推断时间：${rec.recordedAt.toISOString()}\n- 文件大小：${rec.sizeBytes} bytes\n- 时长：${rec.durationSeconds} seconds\n\n请输出 JSON，字段如下：\n{\n  "title": "中文标题",\n  "date": "YYYY-MM-DD",\n  "start_time": "HH:mm|null",\n  "end_time": "HH:mm|null",\n  "participants": ["只填写真实识别出的人名；不要填写 Speaker A/B"],\n  "organizations": ["string"],\n  "projects": ["string"],\n  "markdown": "完整 markdown 纪要正文。必须从 # 标题 开始。结构由你自行设计，不要包含底部来源与归档 details，系统会自动追加。",\n  "action_items": [{"task": "string", "owner": "string|null", "due_date": "YYYY-MM-DD|null", "priority": "high|medium|low|null", "note": "string|null"}],\n  "decisions": [{"decision": "string", "reason": "string|null", "owner": "string|null", "date": "YYYY-MM-DD|null"}],\n  "open_questions": [{"question": "string", "next_step": "string|null"}],\n  "key_quotes_or_details": ["string"],\n  "transcription_uncertainties": ["string"],\n  "suggested_archive_path": "string|null",\n  "archive_confidence": 0.0,\n  "archive_reason": "string|null"\n}\n\nmarkdown 写作要求：\n- 不要输出空章节。\n- 不要输出“未知/未识别/无明确记录”。\n- 顶部只放必要信息；不要堆太多路径、模型、置信度。\n- 如果适合，使用类似“智能章节”的时间线：\`## 智能章节\` + \`### 00:05 xxx\`。\n- 待办用可执行语言；如果没有明确待办，不要硬写待办。\n- 对短录音，markdown 应简洁，通常 2-4 个章节就够。\n- 如果有转写不确定词，放到“待确认”或“转写不确定处”。\n\nTranscript：\n${transcript}`;
	return [{
		role: "system",
		content: system
	}, {
		role: "user",
		content: user
	}];
}
async function summarizeTranscript(config, transcript, rec, localAudioPath) {
	const client = openaiClient(config);
	const req = {
		model: config.summaryModel,
		messages: summaryMessages(transcript, rec, localAudioPath),
		response_format: { type: "json_object" }
	};
	if (!config.summaryModel.toLowerCase().startsWith("gpt-5")) req.temperature = .2;
	const content = (await client.chat.completions.create(req)).choices[0]?.message?.content || "{}";
	return JSON.parse(content);
}
function normalizeMetadata(meta, rec) {
	const d = rec.recordedAt;
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	meta.date ||= date;
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
	meta.archive_confidence = Math.max(0, Math.min(1, Number(meta.archive_confidence || 0)));
	return meta;
}
function sourceDetails(meta, audioPath, transcriptPath) {
	return `<details>\n<summary>来源与归档信息</summary>\n\n- 纪要生成来源：PHILIPS VTR6500 录音自动转写\n- 原始音频：\`${audioPath}\`\n- 完整转写：\`${transcriptPath}\`\n- 建议归档路径：\`${meta.suggested_archive_path || ""}\`\n- 归档置信度：${meta.archive_confidence}\n- 归档原因：${meta.archive_reason || "无"}\n\n</details>`;
}
function markdownNotes(meta, audioPath, transcriptPath) {
	let body = typeof meta.markdown === "string" && meta.markdown.trim() ? meta.markdown.trim() : `# ${meta.title || "未命名录音纪要"}\n`;
	if (!body.startsWith("#")) body = `# ${meta.title || "未命名录音纪要"}\n\n${body}`;
	if (!body.includes("来源与归档信息")) body = `${body.trim()}\n\n${sourceDetails(meta, audioPath, transcriptPath)}`;
	return `${body.trim()}\n`;
}
function transcriptMarkdown(config, rec, transcript, rawTranscript) {
	const raw = rawTranscript && rawTranscript.trim() !== transcript.trim() ? `\n\n---\n\n## 原始转写\n\n${rawTranscript.trim()}\n` : "";
	return `# 录音转写：${basename(rec.sourcePath)}\n\n- 源文件：\`${rec.sourcePath}\`\n- 转写模型：\`${config.transcribeModel}\`\n- 清洗模型：\`${config.cleanTranscript ? config.cleanTranscriptModel : "未启用"}\`\n- 录音时间：${rec.recordedAt.toISOString()}\n- 文件大小：${rec.sizeBytes} bytes\n- 时长：${rec.durationSeconds ?? "未知"} seconds\n- 转写时间：${nowIso()}\n\n---\n\n## 清洗后转写\n\n${transcript.trim()}${raw}`;
}
function sanitizeArchivePath(pathValue, rec) {
	if (!pathValue) return null;
	let raw = String(pathValue).trim().replace(/^`|`$/g, "").replace(/^~\/?/, "").replace(/^\//, "");
	if (raw.startsWith("Documents/")) raw = raw.slice(10);
	if (raw.split("/").includes("..")) return null;
	if (![
		"20-Companies",
		"40-Side-Projects",
		"10-Personal",
		"30-Career-History",
		"00-Inbox"
	].some((root) => raw.startsWith(root))) return null;
	const { month } = dateParts(rec.recordedAt);
	const parts = raw.split("/").filter(Boolean);
	if (["20-Companies", "40-Side-Projects"].includes(parts[0] || "") && !parts.includes("meetings")) raw = `${raw.replace(/\/$/, "")}/meetings/${month}`;
	else if (parts.at(-1) === "meetings") raw = `${raw.replace(/\/$/, "")}/${month}`;
	return raw;
}
async function moveToArchive(config, files, meta, rec) {
	const relDir = sanitizeArchivePath(meta.suggested_archive_path, rec);
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
	if (opts.noOpenai) {
		transcript = "[NO_OPENAI] 未执行 OpenAI 转写。";
		meta = {
			title: basename(rec.sourcePath, extname(rec.sourcePath)),
			date: void 0,
			start_time: void 0,
			participants: [],
			organizations: [],
			projects: [],
			markdown: `# ${basename(rec.sourcePath, extname(rec.sourcePath))}\n\n未执行 OpenAI 总结。`,
			suggested_archive_path: "00-Inbox/meetings/",
			archive_confidence: 0,
			archive_reason: "no_openai 模式，无法判断归档位置。"
		};
	} else {
		rawTranscript = await transcribeAudio(config, files.audio);
		transcript = await cleanTranscript(config, rawTranscript, rec);
		meta = await summarizeTranscript(config, transcript, rec, files.audio);
	}
	meta = normalizeMetadata(meta, rec);
	files = await titledLocalFiles(config, rec, meta, files);
	await mkdir(dirname(files.transcript), { recursive: true });
	await mkdir(dirname(files.notes), { recursive: true });
	await writeFile(files.transcript, transcriptMarkdown(config, rec, transcript, rawTranscript), "utf8");
	await writeFile(files.notes, markdownNotes(meta, files.audio, files.transcript), "utf8");
	meta.source_audio_path = rec.sourcePath;
	meta.source_id = rec.sourceId;
	meta.source_size_bytes = rec.sizeBytes;
	meta.source_modified_at = rec.modifiedAt;
	meta.duration_seconds = rec.durationSeconds;
	meta.transcribe_model = config.transcribeModel;
	meta.clean_transcript_model = config.cleanTranscript ? config.cleanTranscriptModel : null;
	meta.processed_at = nowIso();
	meta.local_paths = files;
	meta.final_paths = {
		audio: null,
		transcript: null,
		notes: null,
		metadata: null
	};
	if (opts.noArchive) {
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
function lockPath() {
	return join(os.homedir(), ".local/state/voicenote/run.lock");
}
async function acquireRunLock() {
	const lock = lockPath();
	await mkdir(dirname(lock), { recursive: true });
	try {
		await mkdir(lock);
	} catch (e) {
		if (e?.code !== "EEXIST") throw e;
		try {
			const st = await stat(lock);
			if (Date.now() - st.mtimeMs > 1800 * 1e3) {
				await rmdir(lock).catch(() => {});
				try {
					await mkdir(lock);
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
		await rmdir(lock).catch(() => {});
	};
	const cleanup = () => {
		release();
	};
	process.once("exit", cleanup);
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
async function runPipeline(opts) {
	loadDotZshrcEnv();
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
async function doctor() {
	loadDotZshrcEnv();
	const config = getConfig();
	console.log(`bun=${process.versions.bun || "not-bun"}`);
	console.log(`node=${process.version}`);
	console.log(`recordDir=${config.recordDir} exists=${existsSync(config.recordDir)}`);
	console.log(`workspace=${config.workspace}`);
	console.log(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "loaded" : "missing"}`);
	console.log(`transcribeModel=${config.transcribeModel}`);
	console.log(`cleanTranscriptModel=${config.cleanTranscriptModel}`);
	console.log(`summaryModel=${config.summaryModel}`);
	const ff = await runCommand("ffprobe", ["-version"], 5e3);
	console.log(`ffprobe=${ff.code === 0 ? "ok" : "missing"}`);
}
function plistPath() {
	return join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}
async function installLaunchAgent() {
	const cliPath = fileURLToPath(import.meta.url);
	const plist = plistPath();
	await mkdir(dirname(plist), { recursive: true });
	const logDir = join(os.homedir(), LOG_DIR_REL);
	await mkdir(logDir, { recursive: true });
	await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${LAUNCH_AGENT_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${existsSync("/opt/homebrew/bin/bun") ? "/opt/homebrew/bin/bun" : process.execPath}</string>\n    <string>${cliPath}</string>\n    <string>run</string>\n    <string>--once</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StartInterval</key>\n  <integer>60</integer>\n  <key>StandardOutPath</key>\n  <string>${logDir}/launchd.out.log</string>\n  <key>StandardErrorPath</key>\n  <string>${logDir}/launchd.err.log</string>\n  <key>WorkingDirectory</key>\n  <string>${os.homedir()}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n  </dict>\n</dict>\n</plist>\n`, "utf8");
	console.log(`LaunchAgent written: ${plist}`);
	console.log(`Enable with: launchctl bootstrap gui/$(id -u) ${plist}`);
}
async function uninstallLaunchAgent() {
	const plist = plistPath();
	await runCommand("launchctl", [
		"bootout",
		`gui/${process.getuid?.()}`,
		plist
	], 1e4);
	console.log(`Bootout attempted: ${plist}`);
}
cli.command("run", "Scan recorder and process recordings").option("--once", "Scan once and exit").option("--latest-only", "Only process newest eligible recording").option("--force", "Reprocess already processed recordings").option("--dry-run", "Do not copy/transcribe/archive").option("--no-openai", "Copy only and create placeholder notes").option("--no-archive", "Do not auto-move out of Inbox").action(runPipeline);
cli.command("doctor", "Check environment").action(doctor);
cli.command("install-launch-agent", "Write LaunchAgent plist").action(installLaunchAgent);
cli.command("uninstall-launch-agent", "Unload LaunchAgent").action(uninstallLaunchAgent);
cli.command("status", "Print LaunchAgent status").action(async () => {
	await runCommand("launchctl", ["print", `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`], 1e4).then((r) => process.stdout.write(r.stdout || r.stderr));
});
cli.help();
cli.version("0.2.0");
cli.parse();
//#endregion
export {};
