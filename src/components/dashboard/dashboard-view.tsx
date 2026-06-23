import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Calendar,
  Database,
  Package,
  Percent,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { listDirectory, readFile } from "@/commands/fs"
import { refreshAnalytics, type AnalyticsSummary, type AnalyticsTagStat } from "@/commands/analytics"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { loadWikiSystemConfig, type WikiSystemConfig } from "@/lib/wiki-config"
import { normalizePath } from "@/lib/path-utils"
import {
  calculateCurrentHoldings,
  computeDashboardStats,
  formatMoney,
  parseTradeMarkdown,
  type DateRange,
  type ModeStat,
  type TradeDayStats,
} from "@/lib/trade-stats"
import { useWikiStore } from "@/stores/wiki-store"

type DashboardTab = "stats" | "brain" | "holdings" | "discipline" | "analytics" | "candidates"
type FlatFile = { name: string; path: string; is_dir: boolean }
type CandidateTrackingRow = {
  sourceFile: string
  sourceDate: string
  stock: string
  code: string
  name: string
  role: string
  mode: string
  reason: string
  d1: string
  d3: string
  d5: string
  d10: string
  maxGain: string
  maxDrawdown: string
  conclusion: string
  autoFilled: boolean
  quoteDays: number
}
type PlannedTradeDay = {
  sourceFiles: Set<string>
  actionableCodes: Set<string>
  actionableNames: Set<string>
}
type MarketQuote = {
  date: string
  code: string
  name: string
  close: number
  high: number
  low: number
  pctChange?: number
  prevClose?: number
  sourceFile: string
}
type MarketQuoteIndex = {
  byCode: Map<string, MarketQuote[]>
  byName: Map<string, MarketQuote[]>
}
type ParsedTradeFile = {
  file: FlatFile
  date: string
  priority: number
  stats: TradeDayStats
}
type DashboardCache = {
  projectPath: string
  dataVersion: number
  config: WikiSystemConfig
  days: TradeDayStats[]
  analytics: AnalyticsSummary | null
  analyticsError: string | null
  candidateRows: CandidateTrackingRow[]
}

const BUILT_IN_TRADE_SOURCE_DIRS = [
  "raw/01-交割单",
  "raw/交割单",
  "raw/交易记录",
  "raw/01-交易记录",
]

const BUILT_IN_TRADE_INCLUDE_PATTERNS = ["交割单", "交易记录", "委托明细"]
const BUILT_IN_TRADE_EXCLUDE_PATTERNS = ["持仓", "账户", "资产", "复盘", "分析", "摄入", "摘要"]
let dashboardCache: DashboardCache | null = null

export function DashboardView() {
  const project = useWikiStore((state) => state.project)
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const [loading, setLoading] = useState(true)
  const [dayStats, setDayStats] = useState<TradeDayStats[]>([])
  const [config, setConfig] = useState<WikiSystemConfig | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [candidateRows, setCandidateRows] = useState<CandidateTrackingRow[]>([])
  const [activeTab, setActiveTab] = useState<DashboardTab>("stats")
  const [marketPrices, setMarketPrices] = useState<Record<string, string>>({})
  const [dateStart, setDateStart] = useState(() => getCurrentMonthRange().start)
  const [dateEnd, setDateEnd] = useState(() => getCurrentMonthRange().end)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setAnalyticsError(null)

      if (!project) {
        if (!cancelled) {
          setDayStats([])
          setConfig(null)
          setAnalytics(null)
          setCandidateRows([])
          setLoading(false)
        }
        return
      }

      const projectPath = normalizePath(project.path)
      if (dashboardCache && dashboardCache.projectPath === projectPath && dashboardCache.dataVersion === dataVersion) {
        setConfig(dashboardCache.config)
        setDayStats(dashboardCache.days)
        setCandidateRows(dashboardCache.candidateRows)
        setAnalytics(dashboardCache.analytics)
        setAnalyticsError(dashboardCache.analyticsError)
        setLoading(false)
        return
      }

      const nextConfig = await loadWikiSystemConfig(projectPath)
      const loadedDays = await loadTradeDays(projectPath, nextConfig)
      const plannedTradeIndex = await loadPlannedTradeIndex(projectPath)
      const enrichedDays = applyPlannedTradeIndex(loadedDays, plannedTradeIndex)
      const marketQuoteIndex = await loadMarketQuoteIndex(projectPath)
      const loadedCandidateRows = applyCandidateMarketBackfill(await loadCandidateTracking(projectPath), marketQuoteIndex)
      const records = enrichedDays.flatMap((day) => day.records)

      let nextAnalytics: AnalyticsSummary | null = null
      let nextAnalyticsError: string | null = null
      if (nextConfig.analytics.enabled && nextConfig.analytics.preferDuckDb) {
        try {
          nextAnalytics = await refreshAnalytics(projectPath, nextConfig.analytics.databasePath, records)
        } catch (err) {
          nextAnalyticsError = err instanceof Error ? err.message : String(err)
        }
      }

      if (!cancelled) {
        dashboardCache = {
          projectPath,
          dataVersion,
          config: nextConfig,
          days: enrichedDays,
          analytics: nextAnalytics,
          analyticsError: nextAnalyticsError,
          candidateRows: loadedCandidateRows,
        }
        setConfig(nextConfig)
        setDayStats(enrichedDays)
        setCandidateRows(loadedCandidateRows)
        setAnalytics(nextAnalytics)
        setAnalyticsError(nextAnalyticsError)
        setDateStart((current) => current || getCurrentMonthRange().start)
        setDateEnd((current) => current || getCurrentMonthRange().end)
        setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [project, dataVersion])

  const range: DateRange = useMemo(() => ({ start: dateStart || undefined, end: dateEnd || undefined }), [dateStart, dateEnd])
  const stats = useMemo(
    () =>
      computeDashboardStats(
        dayStats,
        range,
        config?.dashboard.modeGroups,
        config?.dashboard.positionRules,
      ),
    [dayStats, range, config],
  )

  const priceRecord = useMemo(() => {
    const result: Record<string, number> = {}
    for (const [code, value] of Object.entries(marketPrices)) {
      const price = Number.parseFloat(value)
      if (Number.isFinite(price) && price > 0) result[code] = price
    }
    return result
  }, [marketPrices])

  const holdings = useMemo(() => calculateCurrentHoldings(dayStats, priceRecord), [dayStats, priceRecord])
  const accountEquity = config?.dashboard.positionRules.accountEquity ?? config?.analytics.metrics.accountEquity ?? 0
  const rankingTopN = config?.dashboard.rankingTopN ?? 10
  const latestDay = stats.days[stats.days.length - 1]
  const winRateDenominator = stats.overall.winDays + stats.overall.lossDays + stats.overall.breakEvenDays
  const dayWinRate = winRateDenominator > 0 ? stats.overall.winDays / winRateDenominator : 0
  const cycleWinRate = stats.cycleWinRate
  const strictModeStats = (config?.dashboard.modeLibrary?.length
    ? stats.modeStats.filter((mode) => config.dashboard.modeLibrary.includes(mode.mode))
    : stats.modeStats)
  const conclusionCards = config?.dashboard.brainConclusionCards ?? []
  const showConclusionCard = (id: string) => conclusionCards.length === 0 || conclusionCards.includes(id)

  if (loading) return <CenteredMessage>加载交易统计数据中...</CenteredMessage>
  if (!project) return <CenteredMessage>请先打开或创建一个交易项目。</CenteredMessage>

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold">交易统计看板</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              数据源：交割单 Markdown{analytics ? ` + DuckDB (${analytics.tradeCount} 笔)` : ""}
            </p>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-1">
              <TabButton icon={BarChart3} label="收益统计" value="stats" activeTab={activeTab} onClick={setActiveTab} />
              <TabButton icon={Target} label="交易大脑" value="brain" activeTab={activeTab} onClick={setActiveTab} />
              <TabButton icon={Package} label="当前持仓" value="holdings" activeTab={activeTab} onClick={setActiveTab} />
              <TabButton icon={ShieldCheck} label="每日纪律" value="discipline" activeTab={activeTab} onClick={setActiveTab} />
              <TabButton icon={Database} label="DuckDB" value="analytics" activeTab={activeTab} onClick={setActiveTab} />
              <TabButton icon={Target} label="候选跟踪" value="candidates" activeTab={activeTab} onClick={setActiveTab} />
            </div>
            <DashboardDateRangePicker
              start={dateStart}
              end={dateEnd}
              onStart={setDateStart}
              onEnd={setDateEnd}
              onReset={() => {
                const range = getCurrentMonthRange()
                setDateStart(range.start)
                setDateEnd(range.end)
              }}
            />
          </div>
        </div>

        {stats.days.length === 0 && (
          <EmptyState
            icon={BarChart3}
            title="当前日期区间没有交易数据"
            description="调整日期范围，或检查 73wiki.system.json 里的 tradeSourceDirs / includeFilePatterns。"
          />
        )}

        {activeTab === "stats" && stats.days.length > 0 && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="区间总盈亏"
                value={
                  stats.overall.hasUnknownCost
                    ? "成本不完整"
                    : `${stats.overall.totalNetPnL >= 0 ? "+" : ""}${formatMoney(stats.overall.totalNetPnL)}`
                }
                detail={stats.overall.hasUnknownCost ? `已识别 ${stats.overall.totalNetPnL >= 0 ? "+" : ""}${formatMoney(stats.overall.totalNetPnL)}` : undefined}
                icon={stats.overall.totalNetPnL >= 0 ? TrendingUp : TrendingDown}
                tone={stats.overall.hasUnknownCost ? "neutral" : stats.overall.totalNetPnL >= 0 ? "positive" : "negative"}
              />
              <KpiCard title="持股周期胜率" value={formatPercent(cycleWinRate)} icon={Percent} tone={cycleWinRate >= 0.5 ? "positive" : "negative"} />
              <KpiCard title="买入次数" value={String(stats.overall.totalBuyCount)} icon={Activity} tone="neutral" />
              <KpiCard title="买入总额" value={formatMoney(stats.overall.totalBuyAmount)} icon={Wallet} tone="neutral" />
            </div>

            {stats.overall.hasUnknownCost && (
              <WarningBox>
                部分卖出记录缺少区间前或更早买入成本，存在成本未知数量 {stats.overall.totalUnknownQty} 股。建议补齐更早交割单。
              </WarningBox>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title="月度盈亏">
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.monthly.map((item) => ({ ...item, label: item.month.slice(5) + "月" }))} margin={{ left: 28, right: 12, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis tickFormatter={(value) => `${(Number(value) / 10000).toFixed(1)}w`} />
                      <Tooltip formatter={(value: number) => [`${value >= 0 ? "+" : ""}${formatMoney(value)}`, "已实现盈亏"]} />
                      <Bar dataKey="netPnL" radius={[4, 4, 0, 0]}>
                        {stats.monthly.map((entry, index) => (
                          <Cell key={`${entry.month}-${index}`} fill={entry.netPnL >= 0 ? "#10b981" : "#ef4444"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>

              <Panel title={`个股盈利排行榜 Top ${rankingTopN}`}>
                <SimpleTable
                  headers={["排名", "股票", "成交", "盈亏"]}
                  rows={stats.profitStocks.slice(0, rankingTopN).map((stock, index) => [
                    String(index + 1),
                    `${stock.name} ${stock.code}`,
                    String(stock.tradeCount),
                    `${stock.netPnL >= 0 ? "+" : ""}${formatMoney(stock.netPnL)}`,
                  ])}
                  toneColumn={3}
                />
              </Panel>
            </div>

            <Panel title={`个股亏损排行榜 Top ${rankingTopN}`}>
              <SimpleTable
                headers={["排名", "股票", "成交", "亏损"]}
                rows={stats.lossStocks.slice(0, rankingTopN).map((stock, index) => [
                  String(index + 1),
                  `${stock.name} ${stock.code}`,
                  String(stock.tradeCount),
                  `${stock.netPnL >= 0 ? "+" : ""}${formatMoney(stock.netPnL)}`,
                ])}
                toneColumn={3}
              />
            </Panel>
          </>
        )}

        {activeTab === "brain" && stats.days.length > 0 && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="重仓买入次数" value={String(stats.heavy.buyCount)} icon={Target} tone="neutral" />
              <KpiCard title="重仓胜率" value={formatPercent(stats.heavy.winRate)} icon={Percent} tone={stats.heavy.winRate >= 0.5 ? "positive" : "negative"} />
              <KpiCard
                title="重仓已实现盈亏"
                value={`${stats.heavy.realizedPnL >= 0 ? "+" : ""}${formatMoney(stats.heavy.realizedPnL)}`}
                icon={stats.heavy.realizedPnL >= 0 ? TrendingUp : TrendingDown}
                tone={stats.heavy.realizedPnL >= 0 ? "positive" : "negative"}
              />
              <KpiCard title="1-3只持仓纪律" value={formatPercent(stats.concentration.idealDayRatio)} icon={ShieldCheck} tone={stats.concentration.idealDayRatio >= 0.7 ? "positive" : "negative"} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="交易健康分" value={stats.health.scoredBuyCount > 0 ? stats.health.averageScore.toFixed(0) : "-"} icon={ShieldCheck} tone={stats.health.averageScore >= 70 ? "positive" : stats.health.averageScore >= 50 ? "neutral" : "negative"} />
              <KpiCard title="计划内买入占比" value={stats.planned.plannedBuyCount + stats.planned.unplannedBuyCount > 0 ? formatPercent(stats.planned.plannedRatio) : "-"} icon={Target} tone={stats.planned.plannedRatio >= 0.8 ? "positive" : stats.planned.plannedRatio >= 0.5 ? "neutral" : "negative"} />
              <KpiCard title="模式标注率" value={formatPercent(stats.health.modeTaggedRatio)} icon={BarChart3} tone={stats.health.modeTaggedRatio >= 0.8 ? "positive" : stats.health.modeTaggedRatio >= 0.5 ? "neutral" : "negative"} />
              <KpiCard title="确定性标注率" value={formatPercent(stats.health.certaintyTaggedRatio)} icon={Activity} tone={stats.health.certaintyTaggedRatio >= 0.8 ? "positive" : stats.health.certaintyTaggedRatio >= 0.5 ? "neutral" : "negative"} />
              <KpiCard title="错误成本金额" value={formatMoney(stats.overall.totalErrorCost)} icon={AlertTriangle} tone={stats.overall.totalErrorCost > 0 ? "negative" : "positive"} />
            </div>

            <Panel title="交易大脑结论">
              <div className="grid gap-3 md:grid-cols-2">
                {showConclusionCard("heavyProfit") && (
                  <BrainItem
                    ok={stats.heavy.realizedPnL >= 0}
                    title="重仓是否放大利润"
                    detail={`重仓贡献 ${formatPercent(stats.heavy.contributionRatio)}，已实现 ${formatMoney(stats.heavy.realizedPnL)}。`}
                  />
                )}
                {showConclusionCard("heavyWinRate") && (
                  <BrainItem
                    ok={stats.heavy.winRate >= 0.5}
                    title="重仓胜率是否合格"
                    detail={`重仓闭环胜率 ${formatPercent(stats.heavy.winRate)}，盈利 ${stats.heavy.winCount} 次，亏损 ${stats.heavy.lossCount} 次。`}
                  />
                )}
                {showConclusionCard("concentration") && (
                  <BrainItem
                    ok={stats.concentration.idealDayRatio >= 0.7}
                    title="是否保持集中持仓"
                    detail={`平均持仓 ${stats.concentration.avgHoldingCount.toFixed(1)} 只，理想区间日占比 ${formatPercent(stats.concentration.idealDayRatio)}。`}
                  />
                )}
                {showConclusionCard("cycleWinRate") && (
                  <BrainItem
                    ok={cycleWinRate >= dayWinRate}
                    title="持股周期胜率质量"
                    detail={`按日胜率 ${formatPercent(dayWinRate)}，持股周期胜率 ${formatPercent(cycleWinRate)}。`}
                  />
                )}
                <BrainItem
                  ok={stats.health.averageScore >= 70}
                  title="交易健康分"
                  detail={`区间买入健康分 ${stats.health.scoredBuyCount > 0 ? stats.health.averageScore.toFixed(0) : "-"}，计划内买入 ${stats.planned.plannedBuyCount} 次，计划外 ${stats.planned.unplannedBuyCount} 次，未标注 ${stats.planned.untaggedBuyCount} 次。`}
                />
                <BrainItem
                  ok={stats.health.exitPlanTaggedRatio >= 0.7}
                  title="退出条件标注"
                  detail={`买入记录中带退出/止损/不及预期等条件的比例为 ${formatPercent(stats.health.exitPlanTaggedRatio)}。`}
                />
              </div>
            </Panel>

            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title="半路 / 低吸 / 打板 次数占比">
                <SimpleTable
                  headers={["模式", "买入次数", "占比", "胜率", "盈亏额"]}
                  rows={strictModeStats.map((mode) => [
                    mode.mode,
                    String(mode.buyCount),
                    formatPercent(mode.buyCountRatio),
                    formatPercent(mode.winRate),
                    `${mode.realizedPnL >= 0 ? "+" : ""}${formatMoney(mode.realizedPnL)}`,
                  ])}
                  toneColumn={4}
                />
              </Panel>

              <Panel title="确定性等级表现">
                <SimpleTable
                  headers={["等级", "买入", "重仓", "胜率", "盈亏额"]}
                  rows={stats.certaintyStats.map((item) => [
                    item.level,
                    String(item.buyCount),
                    String(item.heavyBuyCount),
                    formatPercent(item.winRate),
                    `${item.realizedPnL >= 0 ? "+" : ""}${formatMoney(item.realizedPnL)}`,
                  ])}
                  toneColumn={4}
                />
              </Panel>

              <Panel title="错误成本金额">
                <SimpleTable
                  headers={["错误标签", "次数", "错误成本"]}
                  rows={stats.errorCostStats.map((item) => [
                    item.tag,
                    String(item.tradeCount),
                    formatMoney(item.errorCost),
                  ])}
                  toneColumn={2}
                />
              </Panel>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title="区间交易日明细">
                <SimpleTable
                  headers={["日期", "成交", "买入", "卖出", "已实现盈亏"]}
                  rows={[...stats.days].reverse().map((day) => [
                    day.date,
                    String(day.tradeCount),
                    formatMoney(day.buyAmount),
                    formatMoney(day.sellAmount),
                    `${day.netPnL >= 0 ? "+" : ""}${formatMoney(day.netPnL)}`,
                  ])}
                  toneColumn={4}
                />
              </Panel>
            </div>
          </>
        )}

        {activeTab === "holdings" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="持仓股票数" value={String(holdings.length)} icon={Package} tone="neutral" />
              <KpiCard title="持仓总市值" value={formatMoney(holdings.reduce((sum, item) => sum + item.marketPrice * item.quantity, 0))} icon={Wallet} tone="neutral" />
              <KpiCard title="持仓总成本" value={formatMoney(holdings.reduce((sum, item) => sum + item.totalCost, 0))} icon={Activity} tone="neutral" />
              <KpiCard
                title="总浮动盈亏"
                value={`${holdings.reduce((sum, item) => sum + item.unrealizedPnL, 0) >= 0 ? "+" : ""}${formatMoney(holdings.reduce((sum, item) => sum + item.unrealizedPnL, 0))}`}
                icon={TrendingUp}
                tone={holdings.reduce((sum, item) => sum + item.unrealizedPnL, 0) >= 0 ? "positive" : "negative"}
              />
            </div>

            <Panel title="当前持仓明细">
              {holdings.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">当前无持仓。</div>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-4">代码</th>
                        <th className="py-2 pr-4">名称</th>
                        <th className="py-2 pr-4 text-right">持股数</th>
                        <th className="py-2 pr-4 text-right">成本均价</th>
                        <th className="py-2 pr-4 text-right">市价</th>
                        <th className="py-2 pr-4 text-right">市值</th>
                        <th className="py-2 text-right">浮动盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((holding) => {
                        const marketValue = holding.marketPrice * holding.quantity
                        return (
                          <tr key={holding.code} className="border-b border-border/50 last:border-0">
                            <td className="py-2 pr-4 font-medium">{holding.code}</td>
                            <td className="py-2 pr-4">{holding.name}</td>
                            <td className="py-2 pr-4 text-right">{holding.quantity}</td>
                            <td className="py-2 pr-4 text-right">{formatMoney(holding.avgCost)}</td>
                            <td className="py-2 pr-4 text-right">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={marketPrices[holding.code] ?? ""}
                                placeholder="市价"
                                className="h-7 w-24 text-right text-sm"
                                onChange={(event) => setMarketPrices((prev) => ({ ...prev, [holding.code]: event.target.value }))}
                              />
                            </td>
                            <td className="py-2 pr-4 text-right">{holding.marketPrice > 0 ? formatMoney(marketValue) : "-"}</td>
                            <td className={`py-2 text-right font-medium ${holding.unrealizedPnL > 0 ? "text-emerald-500" : holding.unrealizedPnL < 0 ? "text-red-500" : ""}`}>
                              {holding.marketPrice > 0 ? `${holding.unrealizedPnL >= 0 ? "+" : ""}${formatMoney(holding.unrealizedPnL)}` : "-"}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}

        {activeTab === "discipline" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="最近交易日" value={latestDay?.date ?? "-"} icon={Calendar} tone="neutral" />
              <KpiCard title="当日交易次数" value={latestDay ? String(latestDay.tradeCount) : "0"} icon={Activity} tone={config && latestDay && latestDay.tradeCount > config.analytics.metrics.maxTradesPerDay ? "negative" : "neutral"} />
              <KpiCard title="区间换手金额" value={formatMoney(stats.overall.totalBuyAmount + stats.overall.totalSellAmount)} icon={Wallet} tone="neutral" />
              <KpiCard title="账户本金" value={formatMoney(accountEquity)} icon={Target} tone="neutral" />
            </div>

            <Panel title="纪律检查">
              <div className="grid gap-3 md:grid-cols-2">
                <BrainItem ok={!config || !latestDay || latestDay.tradeCount <= config.analytics.metrics.maxTradesPerDay} title="交易频率" detail={`上限 ${config?.analytics.metrics.maxTradesPerDay ?? "-"} 笔，最近交易日 ${latestDay?.tradeCount ?? 0} 笔。`} />
                <BrainItem ok={stats.concentration.idealDayRatio >= 0.7} title="持仓集中度" detail={`理想持仓 ${config?.dashboard.positionRules.idealHoldingCountMin ?? 1}-${config?.dashboard.positionRules.idealHoldingCountMax ?? 3} 只，区间达标 ${formatPercent(stats.concentration.idealDayRatio)}。`} />
                <BrainItem ok={stats.heavy.lossCount <= stats.heavy.winCount} title="重仓亏损约束" detail={`重仓盈利 ${stats.heavy.winCount} 次，亏损 ${stats.heavy.lossCount} 次。`} />
                <BrainItem ok={!stats.overall.hasUnknownCost} title="数据完整性" detail={stats.overall.hasUnknownCost ? "存在成本未知卖出记录，统计可信度下降。" : "交割单成本链条完整。"} />
              </div>
            </Panel>
          </>
        )}

        {activeTab === "analytics" && (
          <>
            {analyticsError && <WarningBox>DuckDB 暂不可用，统计看板已回退到前端计算。错误：{analyticsError}</WarningBox>}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="DuckDB 状态" value={analytics ? "已入库" : "未启用"} icon={Database} tone={analytics ? "positive" : "neutral"} />
              <KpiCard title="入库交易笔数" value={String(analytics?.tradeCount ?? 0)} icon={Activity} tone="neutral" />
              <KpiCard title="交易日数量" value={String(analytics?.tradingDayCount ?? 0)} icon={Calendar} tone="neutral" />
              <KpiCard title="DuckDB健康分" value={analytics?.averageHealthScore != null ? analytics.averageHealthScore.toFixed(0) : "-"} icon={ShieldCheck} tone={(analytics?.averageHealthScore ?? 0) >= 70 ? "positive" : (analytics?.averageHealthScore ?? 0) >= 50 ? "neutral" : "negative"} />
              <KpiCard title="DuckDB错误成本" value={formatMoney(analytics?.totalErrorCost ?? 0)} icon={AlertTriangle} tone={(analytics?.totalErrorCost ?? 0) > 0 ? "negative" : "positive"} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <ModeStatsPanel title="模式统计" stats={strictModeStats} />
              <TagStatsPanel title="错误成本统计" emptyLabel="交割单尚未标注错误标签" stats={analytics?.errorStats ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <TagStatsPanel title="确定性等级统计" emptyLabel="交割单尚未标注确定性等级" stats={analytics?.certaintyStats ?? []} />
              <TagStatsPanel title="计划内/计划外统计" emptyLabel="交割单尚未标注计划内字段" stats={analytics?.plannedStats ?? []} />
            </div>

            <Panel title="配置文件">
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>项目配置：{normalizePath(project.path)}/73wiki.system.json</p>
                <p>数据库：{analytics?.databasePath ?? config?.analytics.databasePath ?? ".73wiki/analytics.duckdb"}</p>
                <p>日期默认值、重仓阈值、模式分组、排行榜数量，都可以直接改配置文件。</p>
              </div>
            </Panel>
          </>
        )}

        {activeTab === "candidates" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="候选记录数" value={String(candidateRows.length)} icon={Target} tone="neutral" />
              <KpiCard title="有效候选" value={String(candidateRows.filter((row) => row.conclusion.includes("有效")).length)} icon={TrendingUp} tone="positive" />
              <KpiCard title="失效候选" value={String(candidateRows.filter((row) => row.conclusion.includes("失效")).length)} icon={TrendingDown} tone="negative" />
              <KpiCard title="待观察" value={String(candidateRows.filter((row) => row.conclusion.includes("待观察") || !row.conclusion).length)} icon={Activity} tone="neutral" />
              <KpiCard title="行情回填" value={String(candidateRows.filter((row) => row.autoFilled).length)} icon={Database} tone="neutral" />
            </div>

            <Panel title="候选票 D+ 跟踪">
              <SimpleTable
                headers={["股票", "角色", "模式", "D+1", "D+3", "D+5", "D+10", "最大涨幅", "最大回撤", "结论", "行情日"]}
                rows={candidateRows.map((row) => [
                  row.stock,
                  row.role,
                  row.mode,
                  row.d1,
                  row.d3,
                  row.d5,
                  row.d10,
                  row.maxGain,
                  row.maxDrawdown,
                  row.conclusion,
                  row.quoteDays > 0 ? String(row.quoteDays) : "-",
                ])}
              />
            </Panel>

            <Panel title="候选票来源文件">
              <SimpleTable
                headers={["来源", "股票", "入池原因"]}
                rows={candidateRows.map((row) => [row.sourceFile, row.stock, row.reason])}
              />
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

function DashboardDateRangePicker({
  start,
  end,
  onStart,
  onEnd,
  onReset,
}: {
  start: string
  end: string
  onStart: (value: string) => void
  onEnd: (value: string) => void
  onReset: () => void
}) {
  const startParts = parseDateParts(start) ?? parseDateParts(formatDateForInput(new Date()))!
  const endParts = parseDateParts(end) ?? startParts
  const [open, setOpen] = useState(false)
  const [activeSide, setActiveSide] = useState<"start" | "end">("start")
  const [visibleYear, setVisibleYear] = useState(startParts.year)
  const [visibleMonth, setVisibleMonth] = useState(startParts.month)
  const visibleDays = daysInMonth(visibleYear, visibleMonth)
  const today = formatDateForInput(new Date())

  useEffect(() => {
    const parts = activeSide === "start" ? parseDateParts(start) : parseDateParts(end)
    if (!parts) return
    setVisibleYear(parts.year)
    setVisibleMonth(parts.month)
  }, [activeSide, start, end])

  function updateMonth(year: number, month: number) {
    const nextYear = Math.max(2000, Math.min(2099, Number.isFinite(year) ? year : visibleYear))
    const nextMonth = Math.max(1, Math.min(12, Number.isFinite(month) ? month : visibleMonth))
    setVisibleYear(nextYear)
    setVisibleMonth(nextMonth)
  }

  function selectDay(day: number) {
    const value = formatDateParts(visibleYear, visibleMonth, day)
    if (activeSide === "start") {
      onStart(value)
      if (end && value > end) onEnd(value)
      setActiveSide("end")
    } else {
      onEnd(value)
      if (start && value < start) onStart(value)
      setOpen(false)
      setActiveSide("start")
    }
  }

  function selectWholeMonth(offset = 0) {
    const base = new Date(visibleYear, visibleMonth - 1 + offset, 1)
    const year = base.getFullYear()
    const month = base.getMonth() + 1
    updateMonth(year, month)
    onStart(formatDateParts(year, month, 1))
    onEnd(formatDateParts(year, month, daysInMonth(year, month)))
    setActiveSide("start")
    setOpen(false)
  }

  function resetToCurrentMonth() {
    onReset()
    const currentMonth = getCurrentMonthRange()
    const parts = parseDateParts(currentMonth.start)
    if (parts) updateMonth(parts.year, parts.month)
    setActiveSide("start")
    setOpen(false)
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-card/95 p-2 text-sm shadow-sm">
        <span className="px-1 font-semibold text-foreground">统计区间</span>
        <span className="rounded-lg border border-primary/30 bg-background px-3 py-1.5 font-semibold text-foreground">
          {formatDisplayDate(start)}
        </span>
        <span className="font-bold text-foreground">到</span>
        <span className="rounded-lg border border-primary/30 bg-background px-3 py-1.5 font-semibold text-foreground">
          {formatDisplayDate(end)}
        </span>
        <Button size="sm" className="h-8 border border-primary bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/90" onClick={resetToCurrentMonth}>
          本月
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 border-primary/60 bg-background px-3 font-semibold text-foreground hover:bg-primary/10"
          onClick={() => {
            setOpen((value) => !value)
            setActiveSide("start")
          }}
        >
          自定义
        </Button>
      </div>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-primary/40 bg-popover p-3 text-sm text-popover-foreground shadow-xl">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">选择日期</span>
        <Input
          type="number"
          min={2000}
          max={2099}
          value={visibleYear}
          onChange={(event) => updateMonth(Number(event.target.value), visibleMonth)}
              className="h-8 w-20 border-primary/40 bg-background font-semibold text-foreground"
              aria-label="选择年份"
        />
        <select
          value={visibleMonth}
          onChange={(event) => updateMonth(visibleYear, Number(event.target.value))}
              className="h-8 rounded-md border border-primary/40 bg-background px-2 font-semibold text-foreground"
              aria-label="选择月份"
        >
          {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
            <option key={month} value={month}>
                  {month}月
            </option>
          ))}
        </select>
            <Button size="sm" variant="outline" className="h-8 border-primary/40 font-semibold text-foreground" onClick={() => selectWholeMonth(-1)}>
              上月
            </Button>
            <Button size="sm" variant="outline" className="h-8 border-primary/40 font-semibold text-foreground" onClick={() => selectWholeMonth(0)}>
              全月
            </Button>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-foreground">
        <button
          type="button"
          onClick={() => setActiveSide("start")}
              className={`rounded-md border px-2.5 py-1.5 font-semibold ${
            activeSide === "start" ? "border-primary bg-primary text-primary-foreground" : "border-primary/40 bg-background"
          }`}
        >
              开始 {formatDisplayDate(start)}
        </button>
        <span className="font-bold text-foreground">到</span>
        <button
          type="button"
          onClick={() => setActiveSide("end")}
              className={`rounded-md border px-2.5 py-1.5 font-semibold ${
            activeSide === "end" ? "border-primary bg-primary text-primary-foreground" : "border-primary/40 bg-background"
          }`}
        >
              结束 {formatDisplayDate(end)}
        </button>
      </div>

          <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: visibleDays }, (_, index) => index + 1).map((day) => {
          const value = formatDateParts(visibleYear, visibleMonth, day)
          const selected = value === start || value === end
          const inRange = start && end && value > start && value < end
              const isSameMonthSelection = (value === start && startParts.month === visibleMonth) || (value === end && endParts.month === visibleMonth)
          return (
            <button
              key={day}
              type="button"
              onClick={() => selectDay(day)}
                  className={`h-8 rounded-md border text-sm font-semibold transition-colors ${
                    selected || isSameMonthSelection
                  ? "border-primary bg-primary text-primary-foreground"
                  : inRange
                    ? "border-primary/20 bg-primary/10 text-foreground"
                    : value === today
                      ? "border-primary/50 bg-background text-primary"
                      : "border-border bg-background text-foreground hover:border-primary/50"
              }`}
            >
              {day}
            </button>
          )
        })}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            先点开始日，再点结束日；结束日选完会自动收起。
          </div>
      </div>
      )}
    </div>
  )
}

function parseDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return { year, month, day }
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function formatDateParts(year: number, month: number, day: number): string {
  const safeDay = Math.max(1, Math.min(daysInMonth(year, month), day))
  return `${year}-${String(month).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`
}

function formatDisplayDate(value: string): string {
  return value ? value.replace(/-/g, "/") : "--"
}

function DateRangePicker({
  start,
  end,
  onStart,
  onEnd,
  onReset,
}: {
  start: string
  end: string
  onStart: (value: string) => void
  onEnd: (value: string) => void
  onReset: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-sm">
      <span className="text-muted-foreground">统计区间</span>
      <Input type="date" value={start} onChange={(event) => onStart(event.target.value)} className="h-8 w-36" />
      <span className="text-muted-foreground">到</span>
      <Input type="date" value={end} onChange={(event) => onEnd(event.target.value)} className="h-8 w-36" />
      <Button size="sm" className="h-8 border border-primary bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/90" onClick={onReset}>
        默认
      </Button>
    </div>
  )
}

async function loadTradeDays(projectPath: string, config: WikiSystemConfig): Promise<TradeDayStats[]> {
  const files: FlatFile[] = []
  const sourceDirs = uniqueStrings([...config.analytics.tradeSourceDirs, ...BUILT_IN_TRADE_SOURCE_DIRS])
  for (const dir of sourceDirs) {
    const fullDir = `${projectPath}/${dir}`
    try {
      files.push(...flattenFiles(await listDirectory(fullDir)).filter((file) => shouldUseTradeFile(file.name, config)))
    } catch {
      // A configured source directory can be absent.
    }
  }

  const parsedFiles: ParsedTradeFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const normalizedFilePath = normalizePath(file.path)
    if (seen.has(normalizedFilePath)) continue
    seen.add(normalizedFilePath)
    try {
      const content = await readFile(file.path)
      const date = extractDate(file.name) ?? file.name.replace(/\.md$/i, "")
      const parsed = parseTradeMarkdown(date, content)
      if (parsed.tradeCount > 0) {
        parsedFiles.push({
          file,
          date,
          priority: tradeFilePriority(file.name),
          stats: parsed,
        })
      }
    } catch (err) {
      console.error("Failed to parse trade file:", file.path, err)
    }
  }

  return selectBestTradeFilesByDate(parsedFiles).map((item) => item.stats).sort((a, b) => a.date.localeCompare(b.date))
}

function tradeFilePriority(fileName: string): number {
  if (fileName.includes("交割单")) return 0
  if (fileName.includes("交易记录")) return 1
  if (fileName.includes("委托明细")) return 2
  return 3
}

function selectBestTradeFilesByDate(files: ParsedTradeFile[]): ParsedTradeFile[] {
  const bestByDate = new Map<string, ParsedTradeFile>()
  for (const item of files) {
    const existing = bestByDate.get(item.date)
    if (!existing || item.priority < existing.priority || (item.priority === existing.priority && item.stats.tradeCount > existing.stats.tradeCount)) {
      bestByDate.set(item.date, item)
    }
  }
  return Array.from(bestByDate.values())
}

async function loadPlannedTradeIndex(projectPath: string): Promise<Map<string, PlannedTradeDay>> {
  const root = `${projectPath}/wiki/07-作战室`
  let files: FlatFile[] = []
  try {
    files = flattenFiles(await listDirectory(root)).filter(
      (file) => !file.is_dir && file.name.endsWith(".md") && (file.name.includes("候选票评分") || file.name.includes("交易计划") || file.name.includes("明日作战")),
    )
  } catch {
    return new Map()
  }

  const index = new Map<string, PlannedTradeDay>()
  for (const file of files) {
    const date = extractDate(file.name)
    if (!date) continue
    try {
      const content = await readFile(file.path)
      const planned = parsePlannedTradesFromContent(content)
      if (planned.codes.size === 0 && planned.names.size === 0) continue
      const day = index.get(date) ?? { sourceFiles: new Set<string>(), actionableCodes: new Set<string>(), actionableNames: new Set<string>() }
      day.sourceFiles.add(file.name)
      for (const code of planned.codes) day.actionableCodes.add(code)
      for (const name of planned.names) day.actionableNames.add(name)
      index.set(date, day)
    } catch {
      // Ignore unreadable plan files.
    }
  }
  return index
}

function parsePlannedTradesFromContent(content: string): { codes: Set<string>; names: Set<string> } {
  const codes = new Set<string>()
  const names = new Set<string>()
  const lines = content.split("\n")
  let header: string[] | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("|")) {
      if (/^\|\s*:?-{2,}/.test(trimmed)) continue
      const parts = splitMarkdownTableRow(trimmed)
      if (parts.some((part) => part.includes("处理") || part.includes("计划"))) {
        header = parts
        continue
      }
      if (!header) continue
      const action = readTableField(parts, header, "处理") || parts[parts.length - 1] || ""
      if (!/(主计划|备选)/.test(action) || /观察|删除|禁买/.test(action)) continue
      const stock = readTableField(parts, header, "股票") || readTableField(parts, header, "代码/名称") || parts[0] || ""
      addStockToken(stock, codes, names)
      continue
    }

    header = null
    if (/^(主计划股票|备选股票)/.test(trimmed)) {
      addStockToken(trimmed.replace(/^(主计划股票|备选股票)\s*[:：]\s*/, ""), codes, names)
    }
  }

  return { codes, names }
}

function addStockToken(value: string, codes: Set<string>, names: Set<string>) {
  const text = value.trim()
  if (!text || text.includes("代码/名称")) return
  const code = text.match(/\b\d{6}\b/)?.[0]
  if (code) codes.add(code)
  const name = text.replace(/\b\d{6}\b/g, "").replace(/[，,、/|]/g, " ").trim()
  if (name && !/^(主计划|备选|观察|删除|禁买)$/.test(name)) names.add(name)
}

function applyPlannedTradeIndex(days: TradeDayStats[], planIndex: Map<string, PlannedTradeDay>): TradeDayStats[] {
  return days.map((day) => {
    const plan = planIndex.get(day.date)
    if (!plan) return day
    const records = day.records.map((record) => {
      if (record.direction !== "buy" || record.plannedTrade !== undefined) return record
      const matched = plan.actionableCodes.has(record.code) || plan.actionableNames.has(record.name)
      const sourceNote = matched
        ? `作战室评分表计划内：${Array.from(plan.sourceFiles).join(", ")}`
        : `计划外：未匹配作战室评分表 ${Array.from(plan.sourceFiles).join(", ")}`
      return {
        ...record,
        plannedTrade: matched,
        note: record.note ? `${record.note}；${sourceNote}` : sourceNote,
      }
    })
    return buildTradeDayFromRecords(day, records)
  })
}

function buildTradeDayFromRecords(day: TradeDayStats, records: TradeDayStats["records"]): TradeDayStats {
  const buyRecords = records.filter((record) => record.direction === "buy")
  const sellRecords = records.filter((record) => record.direction === "sell")
  return {
    ...day,
    records,
    tradeCount: records.length,
    buyCount: buyRecords.length,
    sellCount: sellRecords.length,
    buyAmount: buyRecords.reduce((sum, record) => sum + record.amount, 0),
    sellAmount: sellRecords.reduce((sum, record) => sum + record.amount, 0),
    totalFee: records.reduce((sum, record) => sum + record.fee, 0),
    totalStampTax: records.reduce((sum, record) => sum + record.stampTax, 0),
    totalTransferFee: records.reduce((sum, record) => sum + record.transferFee, 0),
  }
}

async function loadCandidateTracking(projectPath: string): Promise<CandidateTrackingRow[]> {
  const root = `${projectPath}/wiki/09-统计与进化`
  let files: FlatFile[] = []
  try {
    files = flattenFiles(await listDirectory(root)).filter(
      (file) => !file.is_dir && file.name.endsWith(".md") && file.name.includes("候选票"),
    )
  } catch {
    return []
  }

  const rows: CandidateTrackingRow[] = []
  for (const file of files) {
    try {
      const content = await readFile(file.path)
      rows.push(...parseCandidateTrackingRows(file.name, content))
    } catch {
      // Ignore unreadable tracking files.
    }
  }
  return rows
}

async function loadMarketQuoteIndex(projectPath: string): Promise<MarketQuoteIndex> {
  const root = `${projectPath}/raw/04-行情市场数据`
  const quotes: MarketQuote[] = []
  let files: FlatFile[] = []
  try {
    files = flattenFiles(await listDirectory(root)).filter(
      (file) => !file.is_dir && file.name.toLowerCase().endsWith(".json"),
    )
  } catch {
    return { byCode: new Map(), byName: new Map() }
  }

  for (const file of files) {
    try {
      const content = await readFile(file.path)
      quotes.push(...parseMarketQuoteJson(file.name, file.path, content))
    } catch {
      // Ignore unreadable or non-market json files.
    }
  }

  const byCode = new Map<string, MarketQuote[]>()
  const byName = new Map<string, MarketQuote[]>()
  for (const quote of quotes) {
    const codeRows = byCode.get(quote.code) ?? []
    codeRows.push(quote)
    byCode.set(quote.code, codeRows)
    if (quote.name) {
      const nameRows = byName.get(quote.name) ?? []
      nameRows.push(quote)
      byName.set(quote.name, nameRows)
    }
  }
  for (const rows of [...byCode.values(), ...byName.values()]) {
    rows.sort((a, b) => a.date.localeCompare(b.date))
  }
  return { byCode, byName }
}

function parseMarketQuoteJson(fileName: string, filePath: string, content: string): MarketQuote[] {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== "object") return []
  const root = parsed as Record<string, unknown>
  const date = extractDate(filePath) ?? extractDate(String(root.fetched_at ?? "")) ?? extractDate(fileName)
  if (!date) return []

  const stocks = root.stocks as Record<string, unknown> | undefined
  const data = stocks?.data as Record<string, unknown> | undefined
  const diff = data?.diff
  if (!Array.isArray(diff)) return []

  const quotes: MarketQuote[] = []
  for (const item of diff) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const code = String(row.f12 ?? "").trim()
    const close = toFiniteNumber(row.f2)
    const high = toFiniteNumber(row.f15)
    const low = toFiniteNumber(row.f16)
    if (!/^\d{6}$/.test(code) || close == null || high == null || low == null) continue
    quotes.push({
      date,
      code,
      name: String(row.f14 ?? "").trim(),
      close,
      high,
      low,
      pctChange: toFiniteNumber(row.f3),
      prevClose: toFiniteNumber(row.f18),
      sourceFile: fileName,
    })
  }
  return quotes
}

function applyCandidateMarketBackfill(rows: CandidateTrackingRow[], quoteIndex: MarketQuoteIndex): CandidateTrackingRow[] {
  return rows.map((row) => {
    if (!row.sourceDate) return row
    const quotes = getCandidateQuotes(row, quoteIndex)
    if (quotes.length === 0) return row

    const baseline = findBaselineQuote(quotes, row.sourceDate)
    if (!baseline || baseline.close <= 0) return { ...row, quoteDays: quotes.filter((quote) => quote.date > row.sourceDate).length }

    const futureQuotes = dedupeQuotesByDate(quotes.filter((quote) => quote.date > row.sourceDate))
    if (futureQuotes.length === 0) return { ...row, quoteDays: 0 }

    const pick = (offset: number) => futureQuotes[offset - 1]
    const d1 = pick(1)
    const d3 = pick(3)
    const d5 = pick(5)
    const d10 = pick(10)
    const windowQuotes = futureQuotes.slice(0, 10)
    const maxGain = Math.max(...windowQuotes.map((quote) => quote.high / baseline.close - 1))
    const maxDrawdown = Math.min(...windowQuotes.map((quote) => quote.low / baseline.close - 1))
    const autoConclusion = buildAutoCandidateConclusion(maxGain, maxDrawdown, futureQuotes.length)

    const next = {
      ...row,
      d1: row.d1 || formatDQuote(d1, baseline),
      d3: row.d3 || formatDQuote(d3, baseline),
      d5: row.d5 || formatDQuote(d5, baseline),
      d10: row.d10 || formatDQuote(d10, baseline),
      maxGain: row.maxGain || formatSignedPercent(maxGain),
      maxDrawdown: row.maxDrawdown || formatSignedPercent(maxDrawdown),
      conclusion: row.conclusion || autoConclusion,
      autoFilled: true,
      quoteDays: futureQuotes.length,
    }
    return next
  })
}

function getCandidateQuotes(row: CandidateTrackingRow, quoteIndex: MarketQuoteIndex): MarketQuote[] {
  if (row.code) return quoteIndex.byCode.get(row.code) ?? []
  if (row.name) return quoteIndex.byName.get(row.name) ?? []
  return []
}

function findBaselineQuote(quotes: MarketQuote[], sourceDate: string): MarketQuote | null {
  const exact = quotes.find((quote) => quote.date === sourceDate)
  if (exact) return exact
  const before = quotes.filter((quote) => quote.date < sourceDate)
  return before.length > 0 ? before[before.length - 1] : null
}

function dedupeQuotesByDate(quotes: MarketQuote[]): MarketQuote[] {
  const byDate = new Map<string, MarketQuote>()
  for (const quote of quotes) {
    if (!byDate.has(quote.date)) byDate.set(quote.date, quote)
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
}

function buildAutoCandidateConclusion(maxGain: number, maxDrawdown: number, quoteDays: number): string {
  if (quoteDays < 3) return "自动：待观察"
  if (maxGain >= 0.08 && maxDrawdown > -0.08) return "自动：有效"
  if (maxDrawdown <= -0.08 && maxGain < 0.05) return "自动：失效"
  return "自动：待观察"
}

function formatDQuote(quote: MarketQuote | undefined, baseline: MarketQuote): string {
  if (!quote) return ""
  return `${formatSignedPercent(quote.close / baseline.close - 1)} ${quote.date.slice(5)}`
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return ""
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(number) ? number : undefined
}

function parseCandidateTrackingRows(sourceFile: string, content: string): CandidateTrackingRow[] {
  const lines = content.split("\n")
  let header: string[] | null = null
  const rows: CandidateTrackingRow[] = []
  const sourceDate = extractDate(sourceFile) ?? ""

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) {
      header = null
      continue
    }
    if (/^\|\s*:?-{2,}/.test(trimmed)) continue

    const parts = splitMarkdownTableRow(trimmed)
    if (parts.length < 6) continue

    if (parts.includes("股票") && parts.some((part) => part.includes("D+1"))) {
      header = parts
      continue
    }
    if (!header) continue

    const stock = readTableField(parts, header, "股票")
    if (!stock || stock.includes("代码/名称")) continue
    const stockIdentity = parseStockIdentity(stock)

    rows.push({
      sourceFile,
      sourceDate,
      stock,
      code: stockIdentity.code,
      name: stockIdentity.name,
      role: readTableField(parts, header, "角色"),
      mode: readTableField(parts, header, "模式"),
      reason: readTableField(parts, header, "入池原因"),
      d1: readTableField(parts, header, "D+1"),
      d3: readTableField(parts, header, "D+3"),
      d5: readTableField(parts, header, "D+5"),
      d10: readTableField(parts, header, "D+10"),
      maxGain: readTableField(parts, header, "最大涨幅"),
      maxDrawdown: readTableField(parts, header, "最大回撤"),
      conclusion: readTableField(parts, header, "结论"),
      autoFilled: false,
      quoteDays: 0,
    })
  }

  return rows
}

function parseStockIdentity(stock: string): { code: string; name: string } {
  const code = stock.match(/\b\d{6}\b/)?.[0] ?? ""
  const name = stock
    .replace(/\b\d{6}\b/g, "")
    .replace(/[()（）【】\[\]，,、/|]/g, " ")
    .trim()
  return { code, name }
}

function splitMarkdownTableRow(line: string): string[] {
  const parts = line.split("|").map((part) => part.trim())
  if (parts[0] === "") parts.shift()
  if (parts[parts.length - 1] === "") parts.pop()
  return parts
}

function readTableField(parts: string[], header: string[], name: string): string {
  const index = header.findIndex((item) => item === name || item.includes(name))
  if (index < 0) return ""
  return parts[index] ?? ""
}

function shouldUseTradeFile(fileName: string, config: WikiSystemConfig): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) return false
  const includes = uniqueStrings([...config.analytics.includeFilePatterns, ...BUILT_IN_TRADE_INCLUDE_PATTERNS])
  const excludes = uniqueStrings([...config.analytics.excludeFilePatterns, ...BUILT_IN_TRADE_EXCLUDE_PATTERNS])
  if (includes.length > 0 && !includes.some((pattern) => pattern && fileName.includes(pattern))) return false
  if (excludes.some((pattern) => pattern && fileName.includes(pattern))) return false
  return true
}

function extractDate(fileName: string): string | null {
  return fileName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
}

function flattenFiles(nodes: { name: string; path: string; is_dir: boolean; children?: unknown[] }[]): FlatFile[] {
  const files: FlatFile[] = []
  for (const node of nodes) {
    if (node.is_dir && Array.isArray(node.children)) {
      files.push(...flattenFiles(node.children as { name: string; path: string; is_dir: boolean; children?: unknown[] }[]))
    } else if (!node.is_dir) {
      files.push({ name: node.name, path: node.path, is_dir: node.is_dir })
    }
  }
  return files
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function getCurrentMonthRange(): { start: string; end: string } {
  const now = new Date()
  return {
    start: formatDateForInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: formatDateForInput(now),
  }
}

function formatDateForInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function TabButton({
  icon: Icon,
  label,
  value,
  activeTab,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: DashboardTab
  activeTab: DashboardTab
  onClick: (value: DashboardTab) => void
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        activeTab === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}

function KpiCard({
  title,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  title: string
  value: string
  detail?: string
  icon: LucideIcon
  tone: "positive" | "negative" | "neutral"
}) {
  const toneClass = tone === "positive" ? "text-emerald-500" : tone === "negative" ? "text-red-500" : "text-primary"
  return (
    <div className="rounded-xl border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{title}</p>
        <Icon className={`h-4 w-4 ${toneClass}`} />
      </div>
      <p className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-4 font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function WarningBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-4 text-muted-foreground">
      <Icon className="h-12 w-12 opacity-50" />
      <p className="text-lg font-medium">{title}</p>
      <p className="text-sm">{description}</p>
    </div>
  )
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-muted-foreground">{children}</div>
}

function SimpleTable({
  headers,
  rows,
  toneColumn,
}: {
  headers: string[]
  rows: string[][]
  toneColumn?: number
}) {
  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">暂无数据</div>
  }
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {headers.map((header, index) => (
              <th key={header} className={`py-2 pr-4 ${index > 1 ? "text-right" : ""}`}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`} className="border-b border-border/50 last:border-0">
              {row.map((cell, index) => {
                const isTone = toneColumn === index
                const negative = cell.includes("-")
                const positive = cell.includes("+")
                return (
                  <td
                    key={`${cell}-${index}`}
                    className={`py-2 pr-4 ${index > 1 ? "text-right" : ""} ${
                      isTone && positive ? "font-medium text-emerald-500" : ""
                    } ${isTone && negative ? "font-medium text-red-500" : ""}`}
                  >
                    {cell}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BrainItem({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className={`rounded-lg border p-3 ${ok ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"}`}>
      <div className={`font-medium ${ok ? "text-emerald-500" : "text-red-500"}`}>{ok ? "通过" : "触发"}：{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{detail}</div>
    </div>
  )
}

function TagStatsPanel({ title, emptyLabel, stats }: { title: string; emptyLabel: string; stats: AnalyticsTagStat[] }) {
  return (
    <Panel title={title}>
      {stats.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        <SimpleTable
          headers={["标签", "成交", "买入", "卖出", "错误成本"]}
          rows={stats.map((stat) => [
            stat.tag,
            String(stat.tradeCount),
            formatMoney(stat.buyAmount),
            formatMoney(stat.sellAmount),
            formatMoney(stat.errorCost),
          ])}
        />
      )}
    </Panel>
  )
}

function ModeStatsPanel({ title, stats }: { title: string; stats: ModeStat[] }) {
  return (
    <Panel title={title}>
      <SimpleTable
        headers={["模式", "买入次数", "胜率", "盈亏额", "占比"]}
        rows={stats.map((stat) => [
          stat.mode,
          String(stat.buyCount),
          formatPercent(stat.winRate),
          `${stat.realizedPnL >= 0 ? "+" : ""}${formatMoney(stat.realizedPnL)}`,
          formatPercent(stat.buyCountRatio),
        ])}
        toneColumn={3}
      />
    </Panel>
  )
}
