import { invoke } from "@tauri-apps/api/core"
import type { TradeStatRecord } from "@/lib/trade-stats"

export interface AnalyticsTagStat {
  tag: string
  tradeCount: number
  buyAmount: number
  sellAmount: number
  fee: number
  errorCost: number
}

export interface AnalyticsSummary {
  source: "duckdb"
  databasePath: string
  tradeCount: number
  tradingDayCount: number
  totalBuyAmount: number
  totalSellAmount: number
  totalFee: number
  totalErrorCost: number
  turnoverAmount: number
  latestTradeDate: string | null
  modeStats: AnalyticsTagStat[]
  certaintyStats: AnalyticsTagStat[]
  plannedStats: AnalyticsTagStat[]
  errorStats: AnalyticsTagStat[]
  agentStats: AnalyticsTagStat[]
  averageHealthScore: number | null
}

interface AnalyticsTradeRecord {
  date: string
  time?: string
  code: string
  name: string
  direction: "buy" | "sell"
  quantity: number
  price: number
  amount: number
  fee: number
  stampTax: number
  transferFee: number
  modeTag?: string
  certaintyTag?: string
  plannedTrade?: boolean
  healthScore?: number
  errorTag?: string
  errorCost?: number
  agentSource?: string
  note?: string
}

export async function refreshAnalytics(
  projectPath: string,
  databasePath: string,
  records: TradeStatRecord[],
): Promise<AnalyticsSummary> {
  const payload: AnalyticsTradeRecord[] = records.map((record) => ({
    date: record.date,
    time: record.time,
    code: record.code,
    name: record.name,
    direction: record.direction,
    quantity: record.quantity,
    price: record.price,
    amount: record.amount,
    fee: record.fee,
    stampTax: record.stampTax,
    transferFee: record.transferFee,
    modeTag: record.modeTag,
    certaintyTag: record.certaintyTag,
    plannedTrade: record.plannedTrade,
    healthScore: calculateRecordHealthScore(record),
    errorTag: record.errorTag,
    errorCost: record.errorCost,
    agentSource: record.agentSource,
    note: record.note,
  }))

  return invoke<AnalyticsSummary>("analytics_refresh", {
    projectPath,
    databasePath,
    records: payload,
  })
}

function calculateRecordHealthScore(record: TradeStatRecord): number | undefined {
  if (record.direction !== "buy") return undefined

  let score = 0
  if (record.plannedTrade === true) score += 20
  if (record.modeTag) score += 15
  if (record.certaintyTag) score += 15
  if (record.note && ["退出", "止损", "卖出", "不及预期", "破位", "条件"].some((text) => record.note?.includes(text))) {
    score += 15
  }
  if (!record.note || !["S4", "小作文", "传闻"].some((text) => record.note?.includes(text))) {
    score += 10
  }
  if (record.plannedTrade === false) score -= 20
  return Math.max(0, Math.min(100, score))
}
