/** One search hit as a reranker sees it: the document path and the node's title path, then a stretch of its text. */
export interface RerankCandidate {
  /** `doc_path#node_id` of the hit. */
  id: string
  passage: string
}

/**
 * Scores search hits against what the reader is after. `search_documents` asks a reranker when the library was
 * opened with one (see `OpenLibraryOptions.rerank`); MarkIndex itself never calls a model for search.
 */
export interface Reranker {
  /** Shown in the search result as `rerank.by`. */
  readonly name: string
  /**
   * One score per candidate, higher is more relevant, or null for a candidate that could not be scored. Should
   * return what it has when `signal` is aborted. A rejection or a late answer leaves the keyword order in place.
   */
  score(question: string, candidates: RerankCandidate[], opts?: { signal?: AbortSignal }): Promise<(number | null)[]>
}

export interface RerankOptions {
  reranker: Reranker
  /** Keyword hits handed to the reranker per search (default 50, the most `search_documents` returns). */
  pool?: number
  /** Longest stretch of a node's text put in a passage, in characters (default 8000). */
  maxChars?: number
  /** Time allowed for scoring one search, in ms (default 8000). Candidates not scored by then count as unscored. */
  timeoutMs?: number
}
