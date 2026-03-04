import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface SearxngConfigFile {
	searxng?: {
		baseUrl?: string;
		apiKey?: string;
	};
}

interface SearxngConfig {
	baseUrl: string | null;
	apiKey: string | null;
}

let cachedConfig: SearxngConfig | null = null;

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function loadConfig(): SearxngConfig {
	if (cachedConfig) return cachedConfig;

	let file: SearxngConfigFile = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			file = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as SearxngConfigFile;
		} catch {
			file = {};
		}
	}

	const envBase = process.env.SEARXNG_BASE_URL?.trim();
	const fileBase = file.searxng?.baseUrl?.trim();
	const envKey = process.env.SEARXNG_API_KEY?.trim();
	const fileKey = file.searxng?.apiKey?.trim();

	cachedConfig = {
		baseUrl: envBase ? normalizeBaseUrl(envBase) : (fileBase ? normalizeBaseUrl(fileBase) : null),
		apiKey: envKey || fileKey || null,
	};
	return cachedConfig;
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function matchesDomainFilter(url: string, filters: string[] | undefined): boolean {
	if (!filters?.length) return true;
	const domain = extractDomain(url);
	if (!domain) return false;

	const includes = filters.filter((f) => !f.startsWith("-")).map((f) => f.toLowerCase());
	const excludes = filters.filter((f) => f.startsWith("-")).map((f) => f.slice(1).toLowerCase());

	if (includes.length > 0 && !includes.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
	if (excludes.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
	return true;
}

function mapTimeRange(recency: SearchOptions["recencyFilter"]): string | null {
	if (!recency) return null;
	const map: Record<string, string> = {
		day: "day",
		week: "week",
		month: "month",
		year: "year",
	};
	return map[recency] ?? null;
}

export function isSearxngAvailable(): boolean {
	return Boolean(loadConfig().baseUrl);
}

interface SearxngResponse {
	results?: Array<{
		title?: string;
		url?: string;
		content?: string;
	}>;
	answer?: string;
}

export async function searchWithSearxng(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const config = loadConfig();
	if (!config.baseUrl) {
		throw new Error(
			"SearXNG base URL not configured. Set searxng.baseUrl in ~/.pi/web-search.json or SEARXNG_BASE_URL env var"
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query: `searxng: ${query}` });
	const numResults = Math.min(options.numResults ?? 5, 20);

	const params = new URLSearchParams();
	params.set("q", query);
	params.set("format", "json");
	params.set("language", "all");
	params.set("safesearch", "0");
	const timeRange = mapTimeRange(options.recencyFilter);
	if (timeRange) params.set("time_range", timeRange);

	const headers: Record<string, string> = { "Accept": "application/json" };
	if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

	let response: Response;
	try {
		response = await fetch(`${config.baseUrl}/search?${params.toString()}`, {
			headers,
			signal: AbortSignal.any([
				AbortSignal.timeout(30000),
				...(options.signal ? [options.signal] : []),
			]),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = await response.text();
		throw new Error(`SearXNG error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = await response.json() as SearxngResponse;
	activityMonitor.logComplete(activityId, response.status);

	const seen = new Set<string>();
	const results: SearchResult[] = [];
	for (const item of data.results ?? []) {
		const url = item.url?.trim();
		if (!url || seen.has(url) || !matchesDomainFilter(url, options.domainFilter)) continue;
		seen.add(url);
		results.push({
			title: item.title?.trim() || "Untitled",
			url,
			snippet: item.content?.trim() || "",
		});
		if (results.length >= numResults) break;
	}

	const answer = (data.answer?.trim() || (results.length > 0
		? `Found ${results.length} SearXNG results for: ${query}`
		: `No SearXNG results found for: ${query}`));

	return { answer, results };
}
