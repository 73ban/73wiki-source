import type { LlmConfig } from "@/stores/wiki-store"

export interface ProviderDefinition {
  value: LlmConfig["provider"]
  label: string
  models: string[]
  defaultEndpoint?: string
  endpointLabel?: string
  endpointHint?: string
  apiKeyHint?: string
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    value: "openai",
    label: "OpenAI",
    models: [],
    apiKeyHint: "Requires an OpenAI API key. ChatGPT Pro membership does not include API credits.",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    models: [],
  },
  {
    value: "google",
    label: "Gemini",
    models: [],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    models: [],
    endpointLabel: "DeepSeek Endpoint",
    endpointHint: "留空，按你的账号后台填写 URL。",
  },
  {
    value: "qwen",
    label: "Qwen",
    models: [],
    endpointLabel: "Qwen Endpoint",
    endpointHint: "留空，按你的账号后台填写 URL。",
  },
  {
    value: "minimax",
    label: "MiniMax",
    models: [],
    endpointLabel: "MiniMax Endpoint",
    endpointHint: "留空，按你的账号后台填写 URL。",
  },
  {
    value: "zhipu",
    label: "智谱",
    models: [],
    endpointLabel: "智谱 Endpoint",
    endpointHint: "留空，按你的账号后台填写 URL。",
  },
  {
    value: "ollama",
    label: "Ollama (Local)",
    models: [],
  },
  {
    value: "custom",
    label: "OpenAI Compatible",
    models: [],
    endpointLabel: "API Endpoint",
    endpointHint: "留空，自己填写兼容接口 URL。",
  },
]

export const FONT_SCALE_PRESETS = [0.9, 1, 1.1, 1.2, 1.3, 1.4]

export function getProviderDefinition(
  provider: LlmConfig["provider"],
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((item) => item.value === provider)
}

export function getDefaultModel(provider: LlmConfig["provider"]): string {
  return getProviderDefinition(provider)?.models[0] ?? ""
}

export function applyProviderDefaults(
  current: LlmConfig,
  provider: LlmConfig["provider"],
): LlmConfig {
  return {
    ...current,
    provider,
  }
}

export function formatFontScale(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
