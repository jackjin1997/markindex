/** Per-response character budget (PageIndex 100_000 x 0.95). */
export const RESPONSE_CHAR_BUDGET = 95_000
export const DEFAULT_STRUCTURE_DEPTH = 2
/** PageIndex `--summary-token-threshold` default. */
export const SUMMARY_TOKEN_THRESHOLD = 200
export const MAX_NODE_TOKENS = 8_000
export const ROUTING_COST_TOKENS = 150
/** PageIndex 20 pages x ~750 tokens; to be calibrated in Task 12. */
export const STRUCTURE_FIRST_TOKEN_THRESHOLD = 15_000
/** PageIndex `_SIMILAR_NAMES_LIMIT`. */
export const SIMILAR_NAMES_LIMIT = 3
/** Node titles longer than this many code points are cut and end with an ellipsis; the body keeps the full heading. */
export const MAX_TITLE_CHARS = 300
/**
 * Bump whenever parsing, tree building or segmentation changes what gets stored, so existing indexes are rebuilt.
 * 2: CR / CRLF / LF line endings, NFKC segmentation, capped heading titles.
 */
export const INDEX_FORMAT_VERSION = 2
