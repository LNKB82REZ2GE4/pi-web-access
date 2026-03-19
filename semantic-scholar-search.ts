/**
 * Semantic Scholar Academic Search
 *
 * Uses the free Semantic Scholar Graph API to search 200M+ academic papers.
 * Returns structured metadata: title, authors, year, abstract, citation count, venue.
 * An optional API key can be configured for higher rate limits (10 req/s vs 1 req/s).
 *
 * Docs: https://api.semanticscholar.org/api-docs/graph#tag/Paper-Data/operation/get_graph_get_paper_search
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_FIELDS = "paperId,title,abstract,authors,year,citationCount,externalIds,url,venue,publicationTypes,openAccessPdf";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface S2Config {
	semanticScholarApiKey?: string;
}

let cachedConfig: S2Config | null = null;

function loadConfig(): S2Config {
	if (cachedConfig) return cachedConfig;
	if (existsSync(CONFIG_PATH)) {
		try {
			cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as S2Config;
			return cachedConfig;
		} catch {
			cachedConfig = {};
		}
	} else {
		cachedConfig = {};
	}
	return cachedConfig;
}

function getApiKey(): string | null {
	const config = loadConfig();
	return process.env.SEMANTIC_SCHOLAR_API_KEY || config.semanticScholarApiKey || null;
}

/** Semantic Scholar is always available (no key required, just rate-limited without one). */
export function isSemanticScholarAvailable(): boolean {
	return true;
}

interface S2Paper {
	paperId?: string;
	title?: string;
	abstract?: string | null;
	authors?: Array<{ authorId?: string; name?: string }>;
	year?: number | null;
	citationCount?: number;
	externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string; [k: string]: string | undefined };
	url?: string;
	venue?: string;
	publicationTypes?: string[];
	openAccessPdf?: { url?: string; status?: string } | null;
}

interface S2Response {
	total?: number;
	offset?: number;
	next?: number;
	data?: S2Paper[];
}

function formatPaperResult(paper: S2Paper): SearchResult {
	const title = paper.title?.trim() || "(untitled)";

	// Prefer OA PDF URL, then canonical S2 URL, then DOI link
	let url = paper.openAccessPdf?.url || paper.url || "";
	if (!url && paper.externalIds?.DOI) {
		url = `https://doi.org/${paper.externalIds.DOI}`;
	}
	if (!url && paper.externalIds?.ArXiv) {
		url = `https://arxiv.org/abs/${paper.externalIds.ArXiv}`;
	}
	if (!url && paper.paperId) {
		url = `https://www.semanticscholar.org/paper/${paper.paperId}`;
	}

	const authorList = (paper.authors ?? [])
		.map(a => a.name?.trim())
		.filter(Boolean)
		.slice(0, 5);
	const authorStr = authorList.length > 0
		? (authorList.length < (paper.authors?.length ?? 0) ? `${authorList.join(", ")} et al.` : authorList.join(", "))
		: "";

	const pubTypes = paper.publicationTypes?.join(", ") ?? "";
	const venue = paper.venue?.trim() ?? "";
	const year = paper.year ? String(paper.year) : "";
	const citations = paper.citationCount !== undefined ? `${paper.citationCount} citations` : "";

	const metaParts = [
		authorStr,
		year,
		venue || pubTypes,
		citations,
	].filter(Boolean);

	// Snippet: abstract (first 300 chars) + meta line
	const abstractSnippet = paper.abstract
		? paper.abstract.replace(/\s+/g, " ").trim().slice(0, 300) + (paper.abstract.length > 300 ? "…" : "")
		: "";

	const metaLine = metaParts.join(" · ");
	const snippet = [metaLine, abstractSnippet].filter(Boolean).join(" — ");

	return { title, url, snippet };
}

export async function searchWithSemanticScholar(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query: `s2: ${query}` });
	const numResults = Math.min(options.numResults ?? 10, 20);

	const params = new URLSearchParams();
	params.set("query", query);
	params.set("fields", S2_FIELDS);
	params.set("limit", String(numResults));
	params.set("offset", "0");

	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	const apiKey = getApiKey();
	if (apiKey) headers["x-api-key"] = apiKey;

	let response: Response;
	try {
		response = await fetch(`${S2_SEARCH_URL}?${params.toString()}`, {
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
		throw new Error(`Semantic Scholar API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = await response.json() as S2Response;
	activityMonitor.logComplete(activityId, response.status);

	const papers = data.data ?? [];

	// Apply domain filter (include/exclude specific paper URL domains)
	const filtered = options.domainFilter?.length
		? papers.filter(p => {
			const url = formatPaperResult(p).url;
			if (!url) return true;
			try {
				const domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
				const includes = options.domainFilter!.filter(f => !f.startsWith("-")).map(f => f.toLowerCase());
				const excludes = options.domainFilter!.filter(f => f.startsWith("-")).map(f => f.slice(1).toLowerCase());
				if (includes.length > 0 && !includes.some(d => domain === d || domain.endsWith(`.${d}`))) return false;
				if (excludes.some(d => domain === d || domain.endsWith(`.${d}`))) return false;
				return true;
			} catch { return true; }
		})
		: papers;

	const results = filtered.slice(0, numResults).map(formatPaperResult);

	if (results.length === 0) {
		return {
			answer: `No Semantic Scholar results found for: ${query}`,
			results: [],
		};
	}

	// Build a useful answer from abstracts
	const total = data.total ?? results.length;
	const snippets = results
		.filter(r => r.snippet)
		.slice(0, 4)
		.map(r => `**${r.title}**: ${r.snippet}`)
		.join("\n\n");

	const answer = `Found ${total.toLocaleString()} Semantic Scholar papers for: "${query}"\n\n${snippets}`;

	return { answer, results };
}
