import type { LanguageModel } from 'ai'

/** Thrown when a `provider:model` spec cannot be resolved; the message is user-facing. */
export class ProviderError extends Error {}

/**
 * Resolves `<provider>:<model>` (e.g. `anthropic:claude-sonnet-5-5`) to a language model by dynamically importing
 * `@ai-sdk/<provider>` and calling its `<provider>(model)` export. The provider packages are not dependencies of
 * MarkIndex; a missing one yields a `ProviderError` with an install hint.
 */
export async function resolveSummaryModel(
  spec: string,
  importer: (specifier: string) => Promise<Record<string, unknown>> = (s) => import(s),
): Promise<LanguageModel> {
  const i = spec.indexOf(':')
  const provider = i > 0 ? spec.slice(0, i) : ''
  const modelId = i > 0 ? spec.slice(i + 1) : ''
  if (!/^[a-z][a-z0-9-]*$/.test(provider) || modelId === '') {
    throw new ProviderError(`Invalid --summary-model "${spec}". Expected <provider>:<model>, e.g. anthropic:claude-sonnet-5-5.`)
  }
  const pkg = `@ai-sdk/${provider}`
  let mod: Record<string, unknown>
  try {
    mod = await importer(pkg)
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' || (e as { code?: string }).code === 'MODULE_NOT_FOUND') {
      throw new ProviderError(`Provider package ${pkg} is not installed. Install it with: npm install ${pkg}`)
    }
    throw e
  }
  const factory = mod[provider]
  if (typeof factory !== 'function') {
    throw new ProviderError(`${pkg} does not export a "${provider}" model factory; cannot resolve "${spec}".`)
  }
  return (factory as (id: string) => LanguageModel)(modelId)
}
