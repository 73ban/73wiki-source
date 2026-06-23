import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { ModeGroupConfig, PositionRuleConfig } from "@/lib/trade-stats"

export interface RawIngestConfig {
  enabled: boolean
  pollIntervalMs: number
  stablePolls: number
  publishToChat: boolean
  conversationTitle: string
  extensions: string[]
  ignoredPathIncludes: string[]
  monitorDirs: string[]
  fileNamePattern: string
  contentTags: string[]
  clipboard: {
    enabled: boolean
    pollIntervalSeconds: number
    endpoint: string
  }
}

export interface AnalyticsMetricConfig {
  accountEquity: number
  maxTradesPerDay: number
  maxTurnoverRatio: number
  heavyTradeAmountThreshold: number
}

export interface AnalyticsConfig {
  enabled: boolean
  preferDuckDb: boolean
  databasePath: string
  tradeSourceDirs: string[]
  includeFilePatterns: string[]
  excludeFilePatterns: string[]
  metrics: AnalyticsMetricConfig
  modeTags: string[]
  errorTags: string[]
  agentTags: string[]
}

export interface DashboardDateRangeConfig {
  start: string
  end: string
}

export interface DashboardConfig {
  defaultDateRange: DashboardDateRangeConfig
  rankingTopN: number
  winRateMode: "tradingDay" | "closedTrade"
  positionRules: PositionRuleConfig
  modeGroups: ModeGroupConfig
  modeLibrary: string[]
  certaintyLevels: string[]
  errorTags: string[]
  brainConclusionCards: string[]
  visibleCards: string[]
}

export interface FileTreeConfig {
  autoRefresh: boolean
  pollIntervalMs: number
  watchDirs: string[]
}

export interface WikiSystemConfig {
  version: number
  rawIngest: RawIngestConfig
  analytics: AnalyticsConfig
  dashboard: DashboardConfig
  fileTree: FileTreeConfig
}

export const DEFAULT_WIKI_SYSTEM_CONFIG: WikiSystemConfig = {
  version: 1,
  rawIngest: {
    enabled: false,
    pollIntervalMs: 4000,
    stablePolls: 2,
    publishToChat: true,
    conversationTitle: "Auto ingest",
    extensions: [
      ".md",
      ".txt",
      ".csv",
      ".json",
      ".jsonl",
      ".yaml",
      ".yml",
      ".html",
      ".htm",
      ".xml",
      ".pdf",
      ".rtf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
    ],
    ignoredPathIncludes: ["/raw/sources/", "\\raw\\sources\\", "/.cache/", "\\.cache\\"],
    monitorDirs: ["raw/研报新闻", "raw/交割单", "raw/个股研究", "raw/竞价换手率", "raw/日复盘"],
    fileNamePattern: "^([0-9]{4}-[0-9]{2}-[0-9]{2}).*\\.md$",
    contentTags: ["研报新闻", "持仓", "逻辑", "封单", "复盘"],
    clipboard: {
      enabled: false,
      pollIntervalSeconds: 3,
      endpoint: "",
    },
  },
  analytics: {
    enabled: true,
    preferDuckDb: true,
    databasePath: ".73wiki/analytics.duckdb",
    tradeSourceDirs: ["raw/交割单", "raw/交易记录"],
    includeFilePatterns: ["交割单", "交易记录", "委托明细"],
    excludeFilePatterns: ["复盘", "分析", "摄入", "摘要", "关键", "持仓", "账户", "资产"],
    metrics: {
      accountEquity: 200000,
      maxTradesPerDay: 8,
      maxTurnoverRatio: 2,
      heavyTradeAmountThreshold: 100000,
    },
    modeTags: ["半路", "低吸", "打板", "排板", "模式外"],
    errorTags: ["卖点拖延", "模式外交易", "退潮日硬做", "幻想持仓", "低确定性重仓"],
    agentTags: ["大鸟", "河马", "龙虾", "老虎", "自己"],
  },
  dashboard: {
    defaultDateRange: {
      start: "2026-03-05",
      end: "2026-05-05",
    },
    rankingTopN: 10,
    winRateMode: "tradingDay",
    positionRules: {
      accountEquity: 200000,
      heavyPositionRatio: 0.3,
      fullAttackRatio: 0.5,
      idealHoldingCountMin: 1,
      idealHoldingCountMax: 3,
    },
    modeGroups: {
      半路: ["半路", "追涨", "分时突破", "鍗婅矾"],
      低吸: ["低吸", "水下低吸", "回踩", "浣庡惛"],
      打板: ["打板", "扫板", "排板", "涨停", "鎵撴澘", "鎵澘", "鎺掓澘", "娑ㄥ仠"],
    },
    modeLibrary: ["低吸", "半路", "打板"],
    certaintyLevels: ["A+", "A", "B", "C"],
    errorTags: ["模式外", "卖点拖延", "退潮期硬做", "冲动交易", "重仓错误"],
    brainConclusionCards: ["heavyProfit", "heavyWinRate", "concentration", "cycleWinRate"],
    visibleCards: [
      "totalNetPnL",
      "winRate",
      "buyCount",
      "heavyWinRate",
      "modeDistribution",
      "profitRanking",
      "lossRanking",
      "concentration",
    ],
  },
  fileTree: {
    autoRefresh: false,
    pollIntervalMs: 15000,
    watchDirs: ["raw", "wiki"],
  },
}

export async function loadWikiSystemConfig(projectPath: string): Promise<WikiSystemConfig> {
  const pp = normalizePath(projectPath)
  const configPath = `${pp}/73wiki.system.json`

  try {
    const raw = await readFile(configPath)
    const parsed = JSON.parse(raw) as Partial<WikiSystemConfig>
    return mergeConfig(parsed)
  } catch {
    const config = DEFAULT_WIKI_SYSTEM_CONFIG
    try {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    } catch {
      // The app can still run with defaults if the project is read-only.
    }
    return config
  }
}

function mergeConfig(input: Partial<WikiSystemConfig>): WikiSystemConfig {
  return {
    version: input.version ?? DEFAULT_WIKI_SYSTEM_CONFIG.version,
    rawIngest: {
      ...DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest,
      ...(input.rawIngest ?? {}),
      extensions: input.rawIngest?.extensions ?? DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.extensions,
      ignoredPathIncludes:
        input.rawIngest?.ignoredPathIncludes ?? DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.ignoredPathIncludes,
      monitorDirs: input.rawIngest?.monitorDirs ?? DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.monitorDirs,
      fileNamePattern: input.rawIngest?.fileNamePattern ?? DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.fileNamePattern,
      contentTags: input.rawIngest?.contentTags ?? DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.contentTags,
      clipboard: {
        ...DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.clipboard,
        ...(input.rawIngest?.clipboard ?? {}),
      },
    },
    analytics: {
      ...DEFAULT_WIKI_SYSTEM_CONFIG.analytics,
      ...(input.analytics ?? {}),
      tradeSourceDirs: input.analytics?.tradeSourceDirs ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.tradeSourceDirs,
      includeFilePatterns:
        input.analytics?.includeFilePatterns ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.includeFilePatterns,
      excludeFilePatterns:
        input.analytics?.excludeFilePatterns ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.excludeFilePatterns,
      metrics: {
        ...DEFAULT_WIKI_SYSTEM_CONFIG.analytics.metrics,
        ...(input.analytics?.metrics ?? {}),
      },
      modeTags: input.analytics?.modeTags ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.modeTags,
      errorTags: input.analytics?.errorTags ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.errorTags,
      agentTags: input.analytics?.agentTags ?? DEFAULT_WIKI_SYSTEM_CONFIG.analytics.agentTags,
    },
    dashboard: {
      ...DEFAULT_WIKI_SYSTEM_CONFIG.dashboard,
      ...(input.dashboard ?? {}),
      defaultDateRange: {
        ...DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.defaultDateRange,
        ...(input.dashboard?.defaultDateRange ?? {}),
      },
      positionRules: {
        ...DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.positionRules,
        ...(input.dashboard?.positionRules ?? {}),
      },
      modeGroups: input.dashboard?.modeGroups ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.modeGroups,
      modeLibrary: input.dashboard?.modeLibrary ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.modeLibrary,
      certaintyLevels: input.dashboard?.certaintyLevels ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.certaintyLevels,
      errorTags: input.dashboard?.errorTags ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.errorTags,
      brainConclusionCards:
        input.dashboard?.brainConclusionCards ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.brainConclusionCards,
      visibleCards: input.dashboard?.visibleCards ?? DEFAULT_WIKI_SYSTEM_CONFIG.dashboard.visibleCards,
    },
    fileTree: {
      ...DEFAULT_WIKI_SYSTEM_CONFIG.fileTree,
      ...(input.fileTree ?? {}),
      watchDirs: input.fileTree?.watchDirs ?? DEFAULT_WIKI_SYSTEM_CONFIG.fileTree.watchDirs,
    },
  }
}
