import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface BraveConfig {
	braveApiKey?: string;
}

let cachedConfig: BraveConfig | null = null;

function loadConfig(): BraveConfig {
	if (cachedConfig) return cachedConfig;
	if (existsSync(CONFIG_PATH)) {
		try {
			cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as BraveConfig;
			return cachedConfig;
		} catch {
			cachedConfig = {};
		}
	} else {
		cachedConfig = {};
	}
	return cachedConfig;
}

function getApiKey(): string {
	const config = loadConfig();
	const key = process.env.BRAVE_API_KEY || config.braveApiKey;
	if (!key) {
		throw new Error(
			"Brave API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { \"braveApiKey\": \"your-key\" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://api.search.brave.com/"
		);
	}
	return key;
}

export function isBraveAvailable(): boolean {
	const config = loadConfig();
	return Boolean(process.env.BRAVE_API_KEY || config.braveApiKey);
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

	const includes = filters
		.filter((f) => !f.startsWith("-"))
		.map((f) => f.toLowerCase());
	const excludes = filters
		.filter((f) => f.startsWith("-"))
		.map((f) => f.slice(1).toLowerCase());

	if (includes.length > 0 && !includes.some((d) => domain === d || domain.endsWith(`.${d}`))) {
		return false;
	}
	if (excludes.some((d) => domain === d || domain.endsWith(`.${d}`))) {
		return false;
	}
	return true;
}

function mapRecency(recency: SearchOptions["recencyFilter"]): string | null {
	if (!recency) return null;
	const map: Record<string, string> = {
		day: "pd",
		week: "pw",
		month: "pm",
		year: "py",
	};
	return map[recency] ?? null;
}

interface BraveWebResult {
	title?: string;
	url?: string;
	description?: string;
}

interface BraveResponse {
	web?: {
		results?: BraveWebResult[];
	};
}

export async function searchWithBrave(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = getApiKey();
	const activityId = activityMonitor.logStart({ type: "api", query: `brave: ${query}` });
	const numResults = Math.min(options.numResults ?? 5, 20);

	// When a domain include-filter is set, request more raw results so post-filtering
	// has a better chance of finding matches within those domains.
	const hasDomainIncludes = options.domainFilter?.some(f => !f.startsWith("-"));
	const rawCount = hasDomainIncludes ? Math.min(50, numResults * 10) : numResults;

	const params = new URLSearchParams();
	params.set("q", query);
	params.set("count", String(rawCount));
	const freshness = mapRecency(options.recencyFilter);
	if (freshness) params.set("freshness", freshness);

	let response: Response;
	try {
		response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			headers: {
				"X-Subscription-Token": apiKey,
				"Accept": "application/json",
			},
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
		throw new Error(`Brave API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = await response.json() as BraveResponse;
	activityMonitor.logComplete(activityId, response.status);

	const seen = new Set<string>();
	const results: SearchResult[] = [];
	for (const item of data.web?.results ?? []) {
		const url = item.url?.trim();
		if (!url || seen.has(url) || !matchesDomainFilter(url, options.domainFilter)) continue;
		seen.add(url);
		results.push({
			title: item.title?.trim() || "Untitled",
			url,
			snippet: item.description?.trim() || "",
		});
		if (results.length >= numResults) break;
	}

	// Build a meaningful answer from snippets so agents have context without fetching each URL
	const answer = results.length > 0
		? results
			.filter(r => r.snippet)
			.slice(0, 5)
			.map(r => `**${r.title}**: ${r.snippet}`)
			.join("\n\n") || `Found ${results.length} results for: ${query}`
		: `No Brave results found for: ${query}`;

	return { answer, results };
}
