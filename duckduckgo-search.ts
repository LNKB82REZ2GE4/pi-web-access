import { parseHTML } from "linkedom";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

export function isDuckDuckGoAvailable(): boolean {
	return true;
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

function resolveDuckDuckGoUrl(href: string): string | null {
	if (!href) return null;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/l/?")) {
		try {
			const u = new URL(`https://duckduckgo.com${href}`);
			const target = u.searchParams.get("uddg");
			return target ? decodeURIComponent(target) : null;
		} catch {
			return null;
		}
	}
	if (href.startsWith("http://") || href.startsWith("https://")) return href;
	return null;
}

function buildQuery(query: string, options: SearchOptions): string {
	let q = query;

	// Inject site: operator for domain-include filters so DuckDuckGo filters at the index
	// level rather than relying on post-hoc filtering (which can yield 0 results).
	const includes = options.domainFilter?.filter(f => !f.startsWith("-")) ?? [];
	if (includes.length === 1) {
		q = `site:${includes[0]} ${q}`;
	} else if (includes.length > 1) {
		// DuckDuckGo supports (site:a.com OR site:b.com) syntax
		q = `(${includes.map(d => `site:${d}`).join(" OR ")}) ${q}`;
	}

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		q += ` ${labels[options.recencyFilter]}`;
	}
	return q;
}

export async function searchWithDuckDuckGo(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query: `duckduckgo: ${query}` });
	const numResults = Math.min(options.numResults ?? 5, 20);
	// When site: is already in the query we still parse up to 50 raw results for better recall
	const hasDomainIncludes = options.domainFilter?.some(f => !f.startsWith("-"));
	const parseLimit = hasDomainIncludes ? 50 : numResults;

	const body = new URLSearchParams();
	body.set("q", buildQuery(query, options));
	body.set("kl", "us-en");

	let response: Response;
	try {
		response = await fetch(DUCKDUCKGO_HTML_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			},
			body: body.toString(),
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
		throw new Error(`DuckDuckGo HTML search failed: ${response.status}`);
	}

	const html = await response.text();
	activityMonitor.logComplete(activityId, response.status);

	if (html.includes("anomaly-modal") || html.includes("anomaly.js")) {
		throw new Error("DuckDuckGo blocked automated search with an anti-bot challenge");
	}

	const { document } = parseHTML(html);
	const anchors = Array.from(document.querySelectorAll("a.result__a, .result__title a"));
	const seen = new Set<string>();
	const results: SearchResult[] = [];

	for (const anchor of anchors) {
		if (results.length >= numResults) break;
		const href = (anchor.getAttribute("href") || "").trim();
		const url = resolveDuckDuckGoUrl(href);
		// When site: was used in the query, domain includes are already enforced at search level;
		// we still run the filter for excludes.
		if (!url || seen.has(url) || seen.size >= parseLimit) continue;
		if (!matchesDomainFilter(url, options.domainFilter)) continue;
		seen.add(url);

		const parent = anchor.closest(".result");
		const snippet = (parent?.querySelector(".result__snippet")?.textContent || "").trim();
		const title = (anchor.textContent || "Untitled").trim();

		results.push({ title, url, snippet });
	}

	const answer = results.length > 0
		? `Found ${results.length} DuckDuckGo web results for: ${query}`
		: `No DuckDuckGo results found for: ${query}`;

	return { answer, results };
}
