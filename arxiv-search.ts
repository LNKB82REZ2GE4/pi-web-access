/**
 * arXiv Academic Search
 *
 * Uses the arXiv Atom API (no key needed) to search CS, math, physics, biology, and
 * other preprint categories.  Returns structured metadata: title, authors, abstract,
 * categories, and both abstract and PDF URLs.
 *
 * Docs: https://arxiv.org/help/api/user-manual
 */

import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";

/** arXiv is always available — no API key required. */
export function isArxivAvailable(): boolean {
	return true;
}

/** Map common subject terms to arXiv category codes for tighter searches. */
function inferArxivCategories(query: string): string {
	const q = query.toLowerCase();
	const has = (re: RegExp) => re.test(q);
	if (has(/\b(machine learning|deep learning|neural network|llm|transformer|nlp|computer vision|reinforcement learning|gpt|bert|diffusion model|embedding|fine.?tun|rag|retrieval augmented)\b/)) return "cs.LG,cs.AI,cs.CL,cs.CV";
	if (has(/\b(computer science|algorithm|complexity|data structure|graph theory|cryptography)\b/)) return "cs";
	if (has(/\b(physics|quantum|cosmology|astrophysics|particle physics|condensed matter)\b/)) return "physics,cond-mat,astro-ph";
	if (has(/\b(biology|genomics|protein|bioinformatics|epidemiology|neuroscience|genetics|evolution)\b/)) return "q-bio";
	if (has(/\b(mathematics|algebra|topology|analysis|probability|statistics)\b/)) return "math,stat";
	if (has(/\b(economics|game theory|finance|econometrics)\b/)) return "econ,q-fin";
	return ""; // no category filter — search all
}

interface ArxivEntry {
	id: string;
	title: string;
	summary: string;
	authors: string[];
	published: string;
	updated: string;
	categories: string[];
	doiLink: string | null;
	pdfUrl: string;
	absUrl: string;
}

function parseAtomFeed(xml: string): ArxivEntry[] {
	const entries: ArxivEntry[] = [];

	// Split on <entry> blocks
	const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi);

	for (const match of entryMatches) {
		const block = match[1];

		const get = (tag: string) => {
			const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
			return m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
		};

		// arXiv ID from <id>http://arxiv.org/abs/XXXX.YYYY</id>
		const rawId = get("id");
		const idMatch = rawId.match(/arxiv\.org\/abs\/([\w.v/-]+)/i);
		const arxivId = idMatch ? idMatch[1] : rawId;

		const title = get("title");
		const summary = get("summary");
		const published = get("published").slice(0, 10); // YYYY-MM-DD
		const updated = get("updated").slice(0, 10);

		// Authors
		const authorBlocks = block.match(/<author>[\s\S]*?<\/author>/gi) ?? [];
		const authors = authorBlocks.map(b => {
			const nm = b.match(/<name>([^<]+)<\/name>/i);
			return nm ? nm[1].trim() : "";
		}).filter(Boolean);

		// Categories: <category term="cs.LG" .../>
		const catMatches = block.matchAll(/<category[^>]+term="([^"]+)"/gi);
		const categories: string[] = [];
		for (const cm of catMatches) categories.push(cm[1]);

		// DOI link
		const doiMatch = block.match(/rel="related"[^>]+href="https?:\/\/dx\.doi\.org\/([^"]+)"|href="https?:\/\/doi\.org\/([^"]+)"/i);
		const doi = doiMatch ? (doiMatch[1] || doiMatch[2]) : null;

		const absUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : rawId;
		const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}` : "";

		if (!title) continue;

		entries.push({
			id: arxivId,
			title,
			summary,
			authors,
			published,
			updated,
			categories,
			doiLink: doi,
			pdfUrl,
			absUrl,
		});
	}

	return entries;
}

function formatEntry(entry: ArxivEntry): SearchResult {
	const authorStr = entry.authors.slice(0, 5).join(", ")
		+ (entry.authors.length > 5 ? " et al." : "");
	const catStr = entry.categories.slice(0, 4).join(", ");
	const metaParts = [authorStr, entry.published, catStr].filter(Boolean);
	const metaLine = metaParts.join(" · ");
	const abstractSnippet = entry.summary
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 280)
		+ (entry.summary.length > 280 ? "…" : "");
	const snippet = [metaLine, abstractSnippet].filter(Boolean).join(" — ");

	return {
		title: entry.title,
		url: entry.absUrl,
		snippet,
	};
}

export async function searchWithArxiv(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query: `arxiv: ${query}` });
	const numResults = Math.min(options.numResults ?? 10, 20);

	const params = new URLSearchParams();

	// Build search query with optional category filter
	let searchQuery = `all:${query}`;
	const cats = inferArxivCategories(query);
	if (cats) {
		const catFilter = cats.split(",").map(c => `cat:${c.trim()}`).join(" OR ");
		searchQuery = `(${searchQuery}) AND (${catFilter})`;
	}

	// Recency filter: arXiv uses submittedDate in the search query
	if (options.recencyFilter) {
		const now = new Date();
		const cutoff = new Date(now);
		if (options.recencyFilter === "day") cutoff.setDate(now.getDate() - 1);
		else if (options.recencyFilter === "week") cutoff.setDate(now.getDate() - 7);
		else if (options.recencyFilter === "month") cutoff.setMonth(now.getMonth() - 1);
		else if (options.recencyFilter === "year") cutoff.setFullYear(now.getFullYear() - 1);
		const fmt = (d: Date) =>
			`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
		searchQuery += ` AND submittedDate:[${fmt(cutoff)}0000 TO ${fmt(now)}2359]`;
	}

	params.set("search_query", searchQuery);
	params.set("start", "0");
	params.set("max_results", String(numResults));
	params.set("sortBy", "relevance");
	params.set("sortOrder", "descending");

	let response: Response;
	try {
		response = await fetch(`${ARXIV_API_BASE}?${params.toString()}`, {
			headers: { "Accept": "application/atom+xml" },
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
		throw new Error(`arXiv API error ${response.status}`);
	}

	const xml = await response.text();
	activityMonitor.logComplete(activityId, response.status);

	// Check for arXiv error in feed
	if (xml.includes("<title>Error</title>")) {
		const errMsg = xml.match(/<summary>([^<]+)<\/summary>/)?.[1] ?? "arXiv returned an error";
		throw new Error(`arXiv API error: ${errMsg}`);
	}

	const entries = parseAtomFeed(xml);

	if (entries.length === 0) {
		return {
			answer: `No arXiv papers found for: ${query}`,
			results: [],
		};
	}

	const results = entries.slice(0, numResults).map(formatEntry);

	// Build a useful answer from abstracts
	const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
	const total = totalMatch ? parseInt(totalMatch[1], 10) : results.length;

	const snippets = results
		.filter(r => r.snippet)
		.slice(0, 4)
		.map(r => `**${r.title}**: ${r.snippet}`)
		.join("\n\n");

	const answer = `Found ${total.toLocaleString()} arXiv papers for: "${query}"\n\n${snippets}`;

	return { answer, results };
}
