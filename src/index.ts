export * from './config.js'
export * from './types.js'
export { approxTokens, type TokenCounter } from './text/tokens.js'
export { segmentForIndex, segmentQuery } from './text/segment.js'
export * from './parse/markdown.js'
export * from './tree/build.js'
export * from './tree/optimize.js'
export { openStore, StoreLockedError, type Store } from './store/db.js'
export { scanLibrary, type ScanOptions, type ScannedFile } from './library/scan.js'
export {
  indexLibrary,
  type IndexEvent,
  type IndexOptions,
  type IndexReport,
  type IndexStatus,
} from './library/indexer.js'
export { searchNodes, type SearchHit, type SearchOptions } from './store/search.js'
export {
  summarizeDocument,
  estimateSummaryCost,
  type SummaryOptions,
  type SummarizeResult,
  type SummaryFailure,
} from './llm/summarize.js'
