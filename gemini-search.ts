import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import { getApiKey, API_BASE, DEFAULT_MODEL } from "./gemini-api.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.js";
import { isBraveAvailable, searchWithBrave } from "./brave-search.js";
import { isSearxngAvailable, searchWithSearxng } from "./searxng-search.js";
import { isDuckDuckGoAvailable, searchWithDuckDuckGo } from "./duckduckgo-search.js";
import { isSemanticScholarAvailable, searchWithSemanticScholar } from "./semantic-scholar-search.js";
import { isArxivAvailable, searchWithArxiv } from "./arxiv-search.js";

export type SearchProvider = "auto" | "perplexity" | "brave" | "searxng" | "gemini" | "duckduckgo" | "semantic-scholar" | "arxiv";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

let cachedSearchConfig: { provider: SearchProvider; searchModel?: string } | null = null;

function parseProvider(raw: unknown): SearchProvider {
	if (
		raw === "perplexity" || raw === "brave" || raw === "searxng" ||
		raw === "gemini" || raw === "duckduckgo" || raw === "auto" ||
		raw === "semantic-scholar" || raw === "arxiv"
	) {
		return raw;
	}
	return "auto";
}

function normalizeSearchModel(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getSearchConfig(): { provider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
			cachedSearchConfig = {
				provider: parseProvider(raw.provider ?? raw.searchProvider),
				searchModel: normalizeSearchModel(raw.searchModel),
			};
			return cachedSearchConfig;
		}
	} catch {}
	cachedSearchConfig = { provider: "auto", searchModel: undefined };
	return cachedSearchConfig;
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
}

function isAbortError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.toLowerCase().includes("abort");
}

/** Detect whether the query looks like it targets academic literature. */
function isAcademicQuery(query: string): boolean {
	const q = query.toLowerCase();
	return /\b(paper|papers|preprint|preprints|research|journal|study|studies|review|meta-analysis|arxiv|pubmed|semantic scholar|doi|citation|citations|abstract|findings|evidence|methodology|empirical|cohort|randomized|rct|clinical trial|hypothesis|dataset|benchmark|llm|transformer|diffusion model|neural network|deep learning|machine learning|nlp|bioinformatics|genomics|proteomics|neuroscience)\b/.test(q);
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<SearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.provider;

	// Explicit provider routing
	if (provider === "perplexity") return searchWithPerplexity(query, options);
	if (provider === "brave") return searchWithBrave(query, options);
	if (provider === "searxng") return searchWithSearxng(query, options);
	if (provider === "duckduckgo") return searchWithDuckDuckGo(query, options);
	if (provider === "semantic-scholar") return searchWithSemanticScholar(query, options);
	if (provider === "arxiv") return searchWithArxiv(query, options);

	if (provider === "gemini") {
		const result = await searchWithGeminiApi(query, options)
			?? await searchWithGeminiWeb(query, options);
		if (result) return result;
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			"  1. Set GEMINI_API_KEY (env) or geminiApiKey in ~/.pi/web-search.json\n" +
			"  2. Sign into gemini.google.com in a supported Chromium-based browser"
		);
	}

	// Auto waterfall — academic queries prefer structured academic APIs first
	const academic = isAcademicQuery(query);
	const attempts: Array<() => Promise<SearchResponse | null>> = [];

	if (academic) {
		// Academic-first order: S2 → arXiv → SearXNG → Brave → Gemini → Perplexity → DDG
		if (isSemanticScholarAvailable()) attempts.push(async () => searchWithSemanticScholar(query, options));
		if (isArxivAvailable()) attempts.push(async () => searchWithArxiv(query, options));
	}

	if (isSearxngAvailable()) attempts.push(async () => searchWithSearxng(query, options));
	if (isBraveAvailable()) attempts.push(async () => searchWithBrave(query, options));
	attempts.push(async () => await searchWithGeminiApi(query, options));
	if (isPerplexityAvailable()) attempts.push(async () => searchWithPerplexity(query, options));
	if (isDuckDuckGoAvailable()) attempts.push(async () => searchWithDuckDuckGo(query, options));

	// For non-academic queries also include academic providers at the end as a fallback
	if (!academic) {
		if (isSemanticScholarAvailable()) attempts.push(async () => searchWithSemanticScholar(query, options));
	}

	let lastError: Error | null = null;
	for (const attempt of attempts) {
		try {
			const result = await attempt();
			if (result) return result;
		} catch (err) {
			if (isAbortError(err)) throw err;
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}

	throw new Error(
		(lastError ? `${lastError.message}\n\n` : "") +
		"No search provider available. Configure one of:\n" +
		"  1. perplexityApiKey (or PERPLEXITY_API_KEY)\n" +
		"  2. braveApiKey (or BRAVE_API_KEY)\n" +
		"  3. searxng.baseUrl (or SEARXNG_BASE_URL)\n" +
		"  4. geminiApiKey (or GEMINI_API_KEY), or Chrome Gemini login\n" +
		"  5. semantic-scholar or arxiv (no key required)\n" +
		"  6. duckduckgo provider (no key)"
	);
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_MODEL;
		const body = {
			contents: [{ parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(options.signal ? [options.signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
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

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			model: "gemini-3-flash-preview",
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
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

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	// Resolve all redirects in parallel rather than sequentially
	const settled = await Promise.all(
		chunks.map(async (chunk) => {
			if (!chunk.web) return null;
			const title = chunk.web.title || "";
			let url = chunk.web.uri || "";
			if (!url) return null;

			if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
				const resolved = await resolveRedirect(url, signal);
				if (resolved) url = resolved;
			}

			return { title, url, snippet: "" } as SearchResult;
		}),
	);

	return settled.filter((r): r is SearchResult => r !== null);
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
