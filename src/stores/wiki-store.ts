import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"
import type { AppTheme } from "@/types/theme"

type LlmProvider = "openai" | "anthropic" | "google" | "deepseek" | "qwen" | "ollama" | "custom" | "minimax" | "zhipu"

interface ProviderModelSlot {
  endpoint: string
  apiKey: string
  model: string
}

type ProviderProfiles = Partial<Record<LlmProvider, { modelSlots: ProviderModelSlot[] }>>

interface LlmConfig {
  provider: LlmProvider
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  maxContextSize: number // max context window in characters
  customProfiles?: CustomLlmProfile[]
  providerProfiles?: ProviderProfiles
}

interface CustomLlmProfile {
  id: string
  name: string
  provider: string
  endpoint: string
  apiKey: string
  model: string
}

interface SearchApiConfig {
  provider: "tavily" | "none"
  apiKey: string
}

interface EmbeddingConfig {
  enabled: boolean
  endpoint: string // e.g. "http://127.0.0.1:1234/v1/embeddings"
  apiKey: string
  model: string // e.g. "text-embedding-qwen3-embedding-0.6b"
}

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: string
  chatExpanded: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "dashboard" | "plan" | "ingest" | "settings"
  llmConfig: LlmConfig
  searchApiConfig: SearchApiConfig
  embeddingConfig: EmbeddingConfig
  dataVersion: number
  appTheme: AppTheme
  fontScale: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setChatExpanded: (expanded: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setEmbeddingConfig: (config: EmbeddingConfig) => void
  bumpDataVersion: () => void
  setAppTheme: (theme: AppTheme) => void
  setFontScale: (scale: number) => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  selectedFile: null,
  fileContent: "",
  chatExpanded: false,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    customProfiles: [],
    providerProfiles: {},
  },

  dataVersion: 0,
  appTheme: "default",
  fontScale: 1,

  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setActiveView: (activeView) => set({ activeView }),
  searchApiConfig: {
    provider: "none",
    apiKey: "",
  },

  embeddingConfig: {
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  },

  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
  setAppTheme: (appTheme) => {
    if (appTheme === "light") {
      document.documentElement.classList.remove("dark")
    } else {
      document.documentElement.classList.add("dark")
    }
    set({ appTheme })
  },
  setFontScale: (fontScale) => {
    document.documentElement.style.setProperty("--app-font-scale", String(fontScale))
    set({ fontScale })
  },
}))

export type { WikiState, LlmConfig, LlmProvider, ProviderModelSlot, ProviderProfiles, CustomLlmProfile, SearchApiConfig, EmbeddingConfig }
