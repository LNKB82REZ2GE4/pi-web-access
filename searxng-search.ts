import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const DEFAULT_EXCLUDE_DOMAINS = [
	"zhihu.com",
	"zhidao.baidu.com",
	"baidu.com",
];

interface SearxngConfigFile {
	searxng?: {
		baseUrl?: string;
		apiKey?: string;
		language?: string;
		excludeDomains?: string[];
	};
}

interface SearxngConfig {
	baseUrl: string | null;
	apiKey: string | null;
	language: string | null;
	excludeDomains: string[];
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
	const envLanguage = process.env.SEARXNG_LANGUAGE?.trim();
	const fileLanguage = file.searxng?.language?.trim();
	const envExcludes = process.env.SEARXNG_EXCLUDE_DOMAINS?.split(",").map((d) => d.trim()).filter(Boolean) ?? [];
	const fileExcludes = file.searxng?.excludeDomains?.map((d) => d.trim()).filter(Boolean) ?? [];

	cachedConfig = {
		baseUrl: envBase ? normalizeBaseUrl(envBase) : (fileBase ? normalizeBaseUrl(fileBase) : null),
		apiKey: envKey || fileKey || null,
		language: envLanguage || fileLanguage || null,
		excludeDomains: [...new Set([...DEFAULT_EXCLUDE_DOMAINS, ...fileExcludes, ...envExcludes].map((d) => d.toLowerCase()))],
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

function matchesDomainFilter(url: string, filters: string[] | undefined, implicitExcludes: string[] = []): boolean {
	const domain = extractDomain(url);
	if (!domain) return false;

	const includes = filters?.filter((f) => !f.startsWith("-")).map((f) => f.toLowerCase()) ?? [];
	const explicitExcludes = filters?.filter((f) => f.startsWith("-")).map((f) => f.slice(1).toLowerCase()) ?? [];
	const excludes = [...explicitExcludes, ...implicitExcludes];

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

function inferCategories(query: string): string {
	const q = query.toLowerCase();
	const has = (re: RegExp) => re.test(q);

	const tech = has(/\b(code|coding|programming|developer|api|sdk|library|framework|python|javascript|typescript|node|npm|pip|uv|docker|kubernetes|linux|git|github|stack ?overflow|bug|debug|algorithm|function|module|package|cli|bash|shell|regex|sql|database|orm|frontend|backend|devops|ci\/cd)\b/);

	// Broad academic/scientific detection — many queries won't use the word "paper" but are clearly academic
	const academic = has(
		/\b(paper|preprint|preprints|research|journal|study|studies|systematic review|scoping review|literature review|meta-analysis|meta analysis|arxiv|pubmed|medline|semantic scholar|springer|nature|science|cell|lancet|nejm|bmj|jama|ieee|acm|doi|citation|citations|abstract|finding|findings|evidence|methodology|methods|empirical|cohort|randomized|rct|controlled trial|clinical trial|hypothesis|dataset|benchmark|survey|review article|conference paper|proceedings|thesis|dissertation|biomedical|bioinformatics|genomics|proteomics|epidemiology|neuroscience|machine learning|deep learning|neural network|transformer|diffusion model|large language model|llm|nlp|natural language|computer vision|reinforcement learning|gradient|backprop|fine.?tun|quantization|embedding|vector store|attention mechanism|bert|gpt)\b/,
	);
	const newsOrFinance = has(/\b(news|latest|breaking|market|markets|stocks?|equity|bond|fed|inflation|cpi|gdp|earnings|financial|finance|reuters|bloomberg|ft|wsj|economic|economy|geopolit)\b/);

	if (tech) return "general,it,q&a,packages";
	if (academic) return "general,science,scholar";
	if (newsOrFinance) return "general,news";
	return "general";
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
	params.set("categories", inferCategories(query));
	if (config.language) params.set("language", config.language);
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
		if (!url || seen.has(url) || !matchesDomainFilter(url, options.domainFilter, config.excludeDomains)) continue;
		seen.add(url);
		results.push({
			title: item.title?.trim() || "Untitled",
			url,
			snippet: item.content?.trim() || "",
		});
		if (results.length >= numResults) break;
	}

	// Build a meaningful answer from snippets when the API doesn't provide one
	const answer = data.answer?.trim()
		|| (results.length > 0
			? results
				.filter(r => r.snippet)
				.slice(0, 5)
				.map(r => `**${r.title}**: ${r.snippet}`)
				.join("\n\n") || `Found ${results.length} results for: ${query}`
			: `No SearXNG results found for: ${query}`);

	return { answer, results };
}
