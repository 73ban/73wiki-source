import { useState, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveLanguage, saveAppTheme, saveFontScale } from "@/lib/project-store"
import {
  PROVIDER_DEFINITIONS,
  FONT_SCALE_PRESETS,
  formatFontScale,
} from "@/lib/llm-catalog"
import { THEME_PRESETS } from "@/types/theme"
import type { AppTheme } from "@/types/theme"
import { WikiDoctorDialog } from "./wiki-doctor-dialog"
import { Stethoscope } from "lucide-react"
import type { CustomLlmProfile, LlmConfig, LlmProvider, ProviderModelSlot, ProviderProfiles } from "@/stores/wiki-store"

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const HISTORY_OPTIONS = [2, 4, 6, 8, 10, 20]
const EMPTY_MODEL_SLOT: ProviderModelSlot = { endpoint: "", apiKey: "", model: "" }

function ensureTwoModelSlots(slots?: ProviderModelSlot[]): ProviderModelSlot[] {
  return [
    { ...EMPTY_MODEL_SLOT, ...(slots?.[0] ?? {}) },
    { ...EMPTY_MODEL_SLOT, ...(slots?.[1] ?? {}) },
  ]
}

function writeCurrentSlot(
  profiles: ProviderProfiles,
  provider: LlmProvider,
  slotIndex: number,
  slot: ProviderModelSlot,
): ProviderProfiles {
  const slots = ensureTwoModelSlots(profiles[provider]?.modelSlots)
  slots[slotIndex] = slot
  return {
    ...profiles,
    [provider]: { modelSlots: slots },
  }
}

function parseFontScaleInput(value: string): number | null {
  const normalized = value.trim().replace("%", "")
  if (!normalized) return null
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  const scale = parsed > 10 ? parsed / 100 : parsed
  return Math.min(2, Math.max(0.5, scale))
}

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const appTheme = useWikiStore((s) => s.appTheme)
  const setAppTheme = useWikiStore((s) => s.setAppTheme)
  const fontScale = useWikiStore((s) => s.fontScale)
  const setFontScale = useWikiStore((s) => s.setFontScale)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)

  const [provider, setProvider] = useState(llmConfig.provider)
  const [apiKey, setApiKey] = useState(llmConfig.apiKey)
  const [model, setModel] = useState(llmConfig.model)
  const [ollamaUrl, setOllamaUrl] = useState(llmConfig.ollamaUrl)
  const [customEndpoint, setCustomEndpoint] = useState(llmConfig.customEndpoint)
  const [customProfiles, setCustomProfiles] = useState<CustomLlmProfile[]>(llmConfig.customProfiles ?? [])
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfiles>(llmConfig.providerProfiles ?? {})
  const [activeProfileId, setActiveProfileId] = useState("")
  const [activeSlotIndex, setActiveSlotIndex] = useState(0)
  const [maxContextSize, setMaxContextSize] = useState(llmConfig.maxContextSize ?? 204800)
  const [searchProvider, setSearchProvider] = useState(searchApiConfig.provider)
  const [searchApiKey, setSearchApiKey] = useState(searchApiConfig.apiKey)
  const [embeddingEnabled, setEmbeddingEnabled] = useState(embeddingConfig.enabled)
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState(embeddingConfig.endpoint)
  const [embeddingApiKey, setEmbeddingApiKey] = useState(embeddingConfig.apiKey)
  const [embeddingModel, setEmbeddingModel] = useState(embeddingConfig.model)
  const [saved, setSaved] = useState(false)
  const [currentLang, setCurrentLang] = useState(i18n.language)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [fontScaleInput, setFontScaleInput] = useState(formatFontScale(fontScale))
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setProvider(llmConfig.provider)
    setApiKey(llmConfig.apiKey)
    setModel(llmConfig.model)
    setOllamaUrl(llmConfig.ollamaUrl)
    setCustomEndpoint(llmConfig.customEndpoint)
    setCustomProfiles(llmConfig.customProfiles ?? [])
    setProviderProfiles(llmConfig.providerProfiles ?? {})
    setMaxContextSize(llmConfig.maxContextSize ?? 204800)
  }, [llmConfig])

  useEffect(() => {
    setSearchProvider(searchApiConfig.provider)
    setSearchApiKey(searchApiConfig.apiKey)
  }, [searchApiConfig])

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setFontScaleInput(formatFontScale(fontScale))
  }, [fontScale])

  const currentProvider = PROVIDER_DEFINITIONS.find((item) => item.value === provider)
  const currentModelSlots = ensureTwoModelSlots(providerProfiles[provider]?.modelSlots)

  async function handleSave() {
    const { saveLlmConfig, saveSearchApiConfig, saveEmbeddingConfig } = await import("@/lib/project-store")
    const nextProviderProfiles = writeCurrentSlot(providerProfiles, provider, activeSlotIndex, {
      endpoint: provider === "ollama" ? ollamaUrl : customEndpoint,
      apiKey,
      model,
    })
    const nextProfiles = activeProfileId
      ? customProfiles.map((profile) =>
          profile.id === activeProfileId
            ? {
                ...profile,
                provider,
                endpoint: provider === "ollama" ? ollamaUrl : customEndpoint,
                apiKey,
                model,
              }
            : profile,
        )
      : customProfiles
    const newConfig = {
      provider,
      apiKey,
      model,
      ollamaUrl,
      customEndpoint,
      maxContextSize,
      customProfiles: nextProfiles,
      providerProfiles: nextProviderProfiles,
    }
    const newSearchConfig = { provider: searchProvider, apiKey: searchApiKey }
    const newEmbeddingConfig = {
      enabled: embeddingEnabled,
      endpoint: embeddingEndpoint,
      apiKey: embeddingApiKey,
      model: embeddingModel,
    }

    setSearchApiConfig(newSearchConfig)
    await saveSearchApiConfig(newSearchConfig)
    setEmbeddingConfig(newEmbeddingConfig)
    await saveEmbeddingConfig(newEmbeddingConfig)
    setCustomProfiles(nextProfiles)
    setProviderProfiles(nextProviderProfiles)
    setLlmConfig(newConfig)
    await saveLlmConfig(newConfig)

    setSaved(true)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
  }

  async function handleLanguageChange(lang: string) {
    await i18n.changeLanguage(lang)
    setCurrentLang(lang)
    await saveLanguage(lang)
  }

  async function handleThemeChange(theme: AppTheme) {
    setAppTheme(theme)
    await saveAppTheme(theme)
  }

  async function handleFontScaleChange(scale: number) {
    setFontScale(scale)
    await saveFontScale(scale)
  }

  async function handleFontScaleInputApply() {
    const parsed = parseFontScaleInput(fontScaleInput)
    if (!parsed) {
      setFontScaleInput(formatFontScale(fontScale))
      return
    }
    await handleFontScaleChange(parsed)
  }

  function handleProviderChange(nextProvider: typeof provider) {
    const nextProfiles = writeCurrentSlot(providerProfiles, provider, activeSlotIndex, {
      endpoint: provider === "ollama" ? ollamaUrl : customEndpoint,
      apiKey,
      model,
    })
    const slots = ensureTwoModelSlots(nextProfiles[nextProvider]?.modelSlots)
    const nextSlot = slots[0]
    setProviderProfiles(nextProfiles)
    setProvider(nextProvider)
    setActiveSlotIndex(0)
    setApiKey(nextSlot.apiKey)
    setModel(nextSlot.model)
    if (nextProvider === "ollama") {
      setOllamaUrl(nextSlot.endpoint)
      setCustomEndpoint("")
    } else {
      setCustomEndpoint(nextSlot.endpoint)
    }
  }

  function handleSelectModelSlot(index: number) {
    const nextProfiles = writeCurrentSlot(providerProfiles, provider, activeSlotIndex, {
      endpoint: provider === "ollama" ? ollamaUrl : customEndpoint,
      apiKey,
      model,
    })
    const nextSlot = ensureTwoModelSlots(nextProfiles[provider]?.modelSlots)[index]
    setProviderProfiles(nextProfiles)
    setActiveSlotIndex(index)
    setApiKey(nextSlot.apiKey)
    setModel(nextSlot.model)
    if (provider === "ollama") {
      setOllamaUrl(nextSlot.endpoint)
    } else {
      setCustomEndpoint(nextSlot.endpoint)
    }
  }

  function updateCurrentModelSlot(field: keyof ProviderModelSlot, value: string) {
    if (field === "endpoint") {
      if (provider === "ollama") setOllamaUrl(value)
      else setCustomEndpoint(value)
    }
    if (field === "apiKey") setApiKey(value)
    if (field === "model") setModel(value)
    setProviderProfiles((profiles) =>
      writeCurrentSlot(profiles, provider, activeSlotIndex, {
        endpoint: field === "endpoint" ? value : provider === "ollama" ? ollamaUrl : customEndpoint,
        apiKey: field === "apiKey" ? value : apiKey,
        model: field === "model" ? value : model,
      }),
    )
  }

  function handleSelectProfile(profile: CustomLlmProfile) {
    const nextProvider = profile.provider as LlmConfig["provider"]
    setActiveProfileId(profile.id)
    setProvider(nextProvider)
    setApiKey(profile.apiKey)
    setModel(profile.model)
    if (nextProvider === "ollama") {
      setOllamaUrl(profile.endpoint || ollamaUrl)
    } else {
      setCustomEndpoint(profile.endpoint)
    }
  }

  function handleCreateProfile() {
    const profile: CustomLlmProfile = {
      id: `profile-${Date.now()}`,
      name: `${currentProvider?.label ?? provider} ${model || "新模型"}`,
      provider,
      endpoint: provider === "ollama" ? ollamaUrl : customEndpoint,
      apiKey,
      model,
    }
    setCustomProfiles((profiles) => [profile, ...profiles])
    setActiveProfileId(profile.id)
  }

  function handleDeleteProfile(profileId: string) {
    setCustomProfiles((profiles) => profiles.filter((profile) => profile.id !== profileId))
    if (activeProfileId === profileId) setActiveProfileId("")
  }

  function handleRenameProfile(profileId: string, name: string) {
    setCustomProfiles((profiles) =>
      profiles.map((profile) => (profile.id === profileId ? { ...profile, name } : profile)),
    )
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-xl">
        <h2 className="mb-6 text-2xl font-bold">{t("settings.title")}</h2>

        <div className="space-y-6">
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.language")}</h3>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => handleLanguageChange(lang.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    currentLang === lang.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.appearance")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.appearanceHint")}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => handleThemeChange(preset.key)}
                  className={`group relative flex flex-col items-center gap-2 rounded-lg border p-3 transition-all ${
                    appTheme === preset.key
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/50 hover:bg-accent"
                  }`}
                >
                  <div
                    className="h-10 w-full rounded-md shadow-inner"
                    style={{ backgroundColor: preset.previewColor }}
                  />
                  <span className="text-xs font-medium">
                    {i18n.language === "zh" ? preset.label : preset.labelEn}
                  </span>
                  {appTheme === preset.key && (
                    <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                      OK
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">Font Size</div>
                  <div className="text-xs text-muted-foreground">
                    Adjust the entire app scale and keep it after restart.
                  </div>
                </div>
                <div className="rounded-md border px-2 py-1 text-sm font-medium">
                  {formatFontScale(fontScale)}
                </div>
              </div>
              <input
                type="range"
                min={0.9}
                max={1.4}
                step={0.05}
                value={fontScale}
                onChange={(e) => handleFontScaleChange(Number(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg accent-primary"
              />
              <div className="flex flex-wrap gap-2">
                {FONT_SCALE_PRESETS.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    onClick={() => handleFontScaleChange(scale)}
                    className={`rounded-md border px-2.5 py-1 text-sm transition-colors ${
                      Math.abs(fontScale - scale) < 0.001
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {formatFontScale(scale)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={fontScaleInput}
                  onChange={(event) => setFontScaleInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      handleFontScaleInputApply()
                    }
                  }}
                  className="h-9 w-28"
                  aria-label="Custom font scale percentage"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-9 border border-primary bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/90"
                  onClick={handleFontScaleInputApply}
                >
                  应用
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.llmProvider")}</h3>

            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>厂家模型槽位</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    每个厂家固定 2 个模型槽位。URL、KEY、模型名称全部由你自定义，不使用内置型号。
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {currentModelSlots.map((slot, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => handleSelectModelSlot(index)}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      activeSlotIndex === index
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:bg-accent"
                    }`}
                  >
                    <div className="font-medium">模型槽位 {index + 1}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {slot.model || "模型名称空白"} / {slot.endpoint || "URL 空白"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("settings.provider")}</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDER_DEFINITIONS.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => handleProviderChange(item.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      provider === item.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {provider !== "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="customEndpoint">
                  {currentProvider?.endpointLabel || t("settings.customEndpoint")}
                </Label>
                <Input
                  id="customEndpoint"
                  value={customEndpoint}
                  onChange={(e) => updateCurrentModelSlot("endpoint", e.target.value)}
                  placeholder="留空，自己填写 URL"
                />
                <p className="text-xs text-muted-foreground">
                  {currentProvider?.endpointHint || t("settings.customEndpointHint")}
                </p>
              </div>
            )}

            {provider === "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="ollamaUrl">{t("settings.ollamaUrl")}</Label>
                <Input
                  id="ollamaUrl"
                  value={ollamaUrl}
                  onChange={(e) => updateCurrentModelSlot("endpoint", e.target.value)}
                  placeholder="留空，自己填写 URL"
                />
              </div>
            )}

            {provider !== "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="apiKey">{t("settings.apiKey")}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => updateCurrentModelSlot("apiKey", e.target.value)}
                  placeholder="留空，自己填写 KEY"
                />
                {currentProvider?.apiKeyHint && (
                  <p className="text-xs text-muted-foreground">{currentProvider.apiKeyHint}</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="model">{t("settings.model")}</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => updateCurrentModelSlot("model", e.target.value)}
                placeholder="留空，自己填写模型名称"
              />
            </div>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Context Window</h3>
            <p className="text-xs text-muted-foreground">
              Maximum context size sent to the LLM. Larger context allows more wiki pages in each query but costs more tokens.
            </p>
            <div className="space-y-3">
              <ContextSizeSelector value={maxContextSize} onChange={setMaxContextSize} />
            </div>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Web Search (Deep Research)</h3>
            <p className="text-xs text-muted-foreground">
              Enable AI-powered web research to automatically find relevant sources for knowledge gaps.
            </p>

            <div className="space-y-2">
              <Label>Search Provider</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "none" as const, label: "Disabled" },
                  { value: "tavily" as const, label: "Tavily" },
                ].map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setSearchProvider(item.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      searchProvider === item.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {searchProvider !== "none" && (
              <div className="space-y-2">
                <Label htmlFor="searchApiKey">API Key</Label>
                <Input
                  id="searchApiKey"
                  type="password"
                  value={searchApiKey}
                  onChange={(e) => setSearchApiKey(e.target.value)}
                  placeholder="Enter your Tavily API key (tavily.com)"
                />
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Vector Search (Embedding)</h3>
              <button
                onClick={() => setEmbeddingEnabled(!embeddingEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  embeddingEnabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    embeddingEnabled ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enable semantic search using embeddings. Uses the same LLM provider endpoint. Improves search quality for synonym matching and cross-domain discovery.
            </p>
            {embeddingEnabled && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input
                    value={embeddingEndpoint}
                    onChange={(e) => setEmbeddingEndpoint(e.target.value)}
                    placeholder="e.g. http://127.0.0.1:1234/v1/embeddings"
                  />
                </div>
                <div className="space-y-2">
                  <Label>API Key (optional)</Label>
                  <Input
                    type="password"
                    value={embeddingApiKey}
                    onChange={(e) => setEmbeddingApiKey(e.target.value)}
                    placeholder="Leave empty for local models"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Input
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder="e.g. text-embedding-qwen3-embedding-0.6b"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Embedding service can be different from the chat LLM. Supports any OpenAI-compatible /v1/embeddings endpoint.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Chat History</h3>
            <p className="text-xs text-muted-foreground">
              Number of previous messages included when talking to AI. More context improves continuity but uses more tokens.
            </p>
            <div className="space-y-2">
              <Label>Max conversation messages sent to AI</Label>
              <div className="flex flex-wrap gap-2">
                {HISTORY_OPTIONS.map((count) => (
                  <button
                    key={count}
                    onClick={() => setMaxHistoryMessages(count)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      maxHistoryMessages === count
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Currently: {maxHistoryMessages} messages ({maxHistoryMessages / 2} rounds of conversation)
              </p>
            </div>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Wiki Doctor</h3>
            <p className="text-xs text-muted-foreground">
              Detect and repair wiki structure issues such as duplicate folders, misplaced files, and index problems.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setDoctorOpen(true)}
            >
              <Stethoscope className="mr-2 size-4" />
              Open Wiki Doctor
            </Button>
          </div>

          <Button onClick={handleSave} className="w-full">
            {saved ? t("settings.saved") : t("settings.save")}
          </Button>
        </div>
      </div>

      <WikiDoctorDialog open={doctorOpen} onOpenChange={setDoctorOpen} />
    </div>
  )
}

const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

function ContextSizeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, index) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value) ? index : best
  }, 0)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor(value * 0.6 / 1000)}K chars for wiki content
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value, 10)].value)}
        className="h-2 w-full cursor-pointer appearance-none rounded-lg accent-primary"
        style={{
          background: `linear-gradient(to right, #4f46e5 ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%, #e5e7eb ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%)`,
        }}
      />
      <div className="mt-1 flex justify-between">
        {CONTEXT_PRESETS.map((preset, index) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            className={`px-0.5 text-[9px] ${
              index === closestIndex ? "font-bold text-primary" : "text-muted-foreground/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatSize(chars: number): string {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M characters`
  if (chars >= 1000) return `${Math.round(chars / 1000)}K characters`
  return `${chars} characters`
}
