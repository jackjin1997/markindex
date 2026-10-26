export * from './config.js'
export * from './types.js'
export { approxTokens, type TokenCounter } from './text/tokens.js'
export { segmentForIndex, segmentQuery } from './text/segment.js'
export * from './parse/markdown.js'
export * from './tree/build.js'
export * from './tree/optimize.js'
export { openStore, StoreLockedError, type Store } from './store/db.js'
export { scanLibrary, normalizeIgnorePatterns, IGNORE_FILE, type ScanOptions, type ScannedFile } from './library/scan.js'
export {
  indexLibrary,
  indexFormat,
  SUSPECT_SETEXT_CHARS,
  type IndexFormatOptions,
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
export {
  TOOL_CONTRACT,
  AGENT_INSTRUCTIONS,
  type ToolName,
  type ToolInput,
} from './tools/contract.js'
export { splitByBudget, type Envelope, type ErrorCode, type NextSteps } from './tools/envelope.js'
export { openLibrary, defaultDbFile, type Library, type OpenLibraryOptions } from './library.js'
export { createAiSdkTools } from './adapters/ai-sdk.js'
export { retrieve, RETRIEVE_MAX_STEPS, RETRIEVE_MAX_INPUT_TOKENS, type Evidence, type RetrieveOptions, type RetrieveResult } from './retrieve.js'
export { createMcpServer } from './adapters/mcp.js'
export { resolveSummaryModel, ProviderError } from './llm/provider.js'
export {
  parseQuestions,
  QuestionFileError,
  type EvalQuestion,
  type Gold,
  type QuestionIssue,
} from './eval/questions.js'
export { matchesGold, firstHitRank, aggregate, evidenceLineRanges, evidencePrecision, type LineRange, type EvidenceRef, type QuestionResult, type Summary, type Aggregate } from './eval/score.js'
export { runEval, checkGold, type EvalMode, type RunEvalOptions, type EvalReport } from './eval/run.js'
