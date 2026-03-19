import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.js";
import { extractRSCContent } from "./rsc-extract.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";
import { extractGitHub } from "./github-extract.js";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube, extractYouTubeFrame, extractYouTubeFrames, getYouTubeStreamInfo } from "./youtube-extract.js";
import { extractWithUrlContext, extractWithGeminiWeb } from "./gemini-url-context.js";
import { isVideoFile, extractVideo, extractVideoFrame, getLocalVideoDuration } from "./video-extract.js";
import { formatSeconds } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;
const UNPAYWALL_EMAIL = "pi-agent@localhost";
const ARXIV_API_BASE = "https://export.arxiv.org/api/query";

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some(p => isNaN(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string, label: string, requestedCount: number,
	frames: VideoFrame[], error: string | null, duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		duration,
	};
}

async function extractLocalFrames(
	filePath: string, timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractVideoFrame(filePath, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

/** Extract structured metadata from an arXiv abstract or PDF URL via the arXiv Atom API. */
async function extractArxivMetadata(
	arxivId: string,
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		const apiUrl = `${ARXIV_API_BASE}?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
		const res = await fetch(apiUrl, {
			signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
			headers: { "Accept": "application/atom+xml" },
		});
		if (!res.ok) return null;
		const xml = await res.text();

		// Parse key fields from Atom XML without a full XML parser
		const get = (tag: string) => {
			const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
			return m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
		};
		const getAll = (tag: string): string[] => {
			const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
			const results: string[] = [];
			for (const m of xml.matchAll(re)) {
				results.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
			}
			return results;
		};

		const title = get("title").replace(/^Title:\s*/i, "").trim();
		const summary = get("summary");
		const published = get("published");
		const updated = get("updated");
		const year = published ? published.slice(0, 4) : "";

		// Authors are <author><name>...</name></author>
		const authorBlocks = xml.match(/<author>[\s\S]*?<\/author>/gi) ?? [];
		const authors = authorBlocks.map(b => {
			const nm = b.match(/<name>([^<]+)<\/name>/i);
			return nm ? nm[1].trim() : "";
		}).filter(Boolean);

		// Categories
		const categories = getAll("arxiv:primary_category")
			.concat(getAll("category"))
			.map(c => {
				const tm = c.match(/term="([^"]+)"/);
				return tm ? tm[1] : c;
			})
			.filter(Boolean);

		// DOI if present
		const doiMatch = xml.match(/<arxiv:doi>([^<]+)<\/arxiv:doi>/i);
		const doi = doiMatch ? doiMatch[1].trim() : "";

		// Journal ref if present
		const journalMatch = xml.match(/<arxiv:journal_ref>([^<]+)<\/arxiv:journal_ref>/i);
		const journalRef = journalMatch ? journalMatch[1].trim() : "";

		if (!title && !summary) return null;

		const lines: string[] = [
			`# ${title || arxivId}`,
			"",
			`> **arXiv:** ${arxivId}  `,
			`> **URL:** ${url}  `,
		];
		if (authors.length) lines.push(`> **Authors:** ${authors.slice(0, 10).join(", ")}${authors.length > 10 ? " et al." : ""}  `);
		if (year) lines.push(`> **Published:** ${published}  `);
		if (updated && updated !== published) lines.push(`> **Updated:** ${updated}  `);
		if (categories.length) lines.push(`> **Categories:** ${[...new Set(categories)].slice(0, 6).join(", ")}  `);
		if (doi) lines.push(`> **DOI:** https://doi.org/${doi}  `);
		if (journalRef) lines.push(`> **Journal:** ${journalRef}  `);
		lines.push("", "---", "", "## Abstract", "", summary || "(no abstract available)");

		return {
			url,
			title: title || arxivId,
			content: lines.join("\n"),
			error: null,
		};
	} catch {
		return null;
	}
}

/**
 * For DOI URLs, attempt to find an open-access version via Unpaywall before
 * falling through to normal extraction.  Returns null if nothing useful found.
 */
async function resolveDoiOpenAccess(
	doi: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const apiUrl = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`;
		const res = await fetch(apiUrl, {
			signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
			headers: { "Accept": "application/json" },
		});
		if (!res.ok) return null;
		const data = await res.json() as {
			best_oa_location?: { url?: string; url_for_pdf?: string } | null;
			oa_locations?: Array<{ url?: string; url_for_pdf?: string }>;
		};

		// Prefer a PDF link, then any OA URL
		const best = data.best_oa_location;
		if (best?.url_for_pdf) return best.url_for_pdf;
		if (best?.url) return best.url;
		for (const loc of data.oa_locations ?? []) {
			if (loc.url_for_pdf) return loc.url_for_pdf;
			if (loc.url) return loc.url;
		}
		return null;
	} catch {
		return null;
	}
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	if (options?.frames && !options.timestamp) {
		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
			}
			if (streamInfo.duration === null) {
				const error = "Cannot determine video duration. Use a timestamp range instead.";
				return { url, title: "Frames", content: error, error };
			}
			const dur = Math.floor(streamInfo.duration);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
		}

		const videoInfo = isVideoFile(url);
		if (videoInfo) {
			const durationResult = await getLocalVideoDuration(videoInfo.absolutePath);
			if (typeof durationResult !== "number") {
				return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
			}
			const dur = Math.floor(durationResult);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractLocalFrames(videoInfo.absolutePath, timestamps);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
		}

		return { url, title: "", content: "", error: "Frame extraction only works with YouTube and local video files" };
	}

	if (options?.timestamp) {
		const spec = parseTimestampSpec(options.timestamp);
		if (spec) {
			const frameCount = options.frames;
			const ytInfo = isYouTubeURL(url);
			if (ytInfo.isYouTube && ytInfo.videoId) {
				const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
				if ("error" in streamInfo) {
					if (spec.type === "range") {
						const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
						return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
					}
					if (frameCount) {
						const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
						const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
						return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
					}
					return { url, title: `Frame at ${options.timestamp}`, content: streamInfo.error, error: streamInfo.error };
				}

				if (spec.type === "range") {
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
						const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
						return { url, title: `Frames ${label}`, content: error, error };
					}
					const timestamps = frameCount
						? computeRangeTimestamps(spec.start, spec.end, frameCount)
						: computeRangeTimestamps(spec.start, spec.end);
					const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
					return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
				}

				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					if (streamInfo.duration !== null && end > streamInfo.duration) {
						const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
						return { url, title: `Frames ${label}`, content: error, error };
					}
					const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
					const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
					return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
				}

				if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frame at ${options.timestamp}`, content: error, error };
				}
				const frame = await extractYouTubeFrame(ytInfo.videoId, spec.seconds, streamInfo);
				if ("error" in frame) {
					return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
			}

			const videoInfo = isVideoFile(url);
			if (videoInfo) {
				if (spec.type === "range") {
					const timestamps = frameCount
						? computeRangeTimestamps(spec.start, spec.end, frameCount)
						: computeRangeTimestamps(spec.start, spec.end);
					const result = await extractLocalFrames(videoInfo.absolutePath, timestamps);
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
				}

				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
					const result = await extractLocalFrames(videoInfo.absolutePath, timestamps);
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
				}

				const frame = await extractVideoFrame(videoInfo.absolutePath, spec.seconds);
				if ("error" in frame) {
					return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
			}
		}
	}

	const videoInfo = isVideoFile(url);
	if (videoInfo) {
		const result = await extractVideo(videoInfo, signal, options);
		return result ?? { url, title: "", content: "", error: "Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ~/.pi/web-search.json" };
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	// --- arXiv structured extraction (abs page only — PDF URLs fall through to full PDF extraction) ---
	const arxivAbsMatch = url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/i);
	if (arxivAbsMatch) {
		const arxivResult = await extractArxivMetadata(arxivAbsMatch[1], url, signal);
		if (arxivResult) return arxivResult;
		// Fall through to generic HTML extraction if API fails
	}

	// --- DOI open-access resolution ---
	const doiMatch = url.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)/i);
	if (doiMatch) {
		const oaUrl = await resolveDoiOpenAccess(doiMatch[1], signal);
		if (oaUrl && oaUrl !== url) {
			// Recursively extract from the OA version; if it fails, continue with original URL
			const oaResult = await extractContent(oaUrl, signal, options);
			if (!oaResult.error) return { ...oaResult, url };
		}
		// Fall through to normal HTTP extraction of the DOI redirect
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return ghResult;
	} catch {}

	const ytInfo = isYouTubeURL(url);
	if (ytInfo.isYouTube && isYouTubeEnabled()) {
		try {
			const ytResult = await extractYouTube(url, signal, options?.prompt, options?.model);
			if (ytResult) return ytResult;
		} catch {}
		return {
			url,
			title: "",
			content: "",
			error: "Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.",
		};
	}

	const httpResult = await extractViaHttp(url, signal, options);

	if (!httpResult.error || signal?.aborted) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return httpResult;

	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;

	const geminiResult = await extractWithUrlContext(url, signal)
		?? await extractWithGeminiWeb(url, signal);

	if (geminiResult) return geminiResult;

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Set GEMINI_API_KEY in ~/.pi/web-search.json",
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
	return { ...httpResult, error: guidance };
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isPDFContent) {
			try {
				const buffer = await response.arrayBuffer();
				const result = await extractPDFToMarkdown(buffer, url);
				activityMonitor.logComplete(activityId, response.status);
				// Return the full extracted text inline so agents can read the paper.
				// Also include a footer note pointing to the saved file for human reference.
				const footer = `\n\n---\n*PDF also saved to: ${result.outputPath} (${result.pages} pages, ${result.chars.toLocaleString()} chars)*`;
				return {
					url,
					title: result.title,
					content: result.content + footer,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
			};
		}

		const markdown = turndown.turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
}
