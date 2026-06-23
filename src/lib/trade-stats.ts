export interface TradeStatRecord {
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
  exitCondition?: string
  errorTag?: string
  errorCost?: number
  agentSource?: string
  note?: string
}

export interface TradeDayStats {
  date: string
  records: TradeStatRecord[]
  tradeCount: number
  buyCount: number
  sellCount: number
  buyAmount: number
  sellAmount: number
  totalFee: number
  totalStampTax: number
  totalTransferFee: number
  netPnL: number
}

export interface DateRange {
  start?: string
  end?: string
}

export interface MonthlyStat {
  month: string
  netPnL: number
  tradeCount: number
}

export interface StockStat {
  code: string
  name: string
  tradeCount: number
  buyCount: number
  sellCount: number
  netPnL: number
  totalFee: number
}

export interface OverallStats {
  totalTradeCount: number
  totalBuyCount: number
  totalSellCount: number
  totalBuyAmount: number
  totalSellAmount: number
  totalFee: number
  totalStampTax: number
  totalTransferFee: number
  totalNetPnL: number
  totalErrorCost: number
  maxDayProfit: number
  maxDayLoss: number
  winDays: number
  lossDays: number
  breakEvenDays: number
  avgDayNetPnL: number
  hasUnknownCost: boolean
  totalUnknownQty: number
}

export interface ModeGroupConfig {
  [mode: string]: string[]
}

export interface PositionRuleConfig {
  accountEquity: number
  heavyPositionRatio: number
  fullAttackRatio: number
  idealHoldingCountMin: number
  idealHoldingCountMax: number
}

export interface ModeStat {
  mode: string
  buyCount: number
  buyAmount: number
  avgBuyAmount: number
  heavyBuyCount: number
  realizedPnL: number
  realizedCount: number
  winCount: number
  lossCount: number
  winRate: number
  buyCountRatio: number
}

export interface CertaintyStat {
  level: string
  buyCount: number
  heavyBuyCount: number
  realizedPnL: number
  winCount: number
  lossCount: number
  winRate: number
}

export interface PlannedTradeStat {
  plannedBuyCount: number
  unplannedBuyCount: number
  untaggedBuyCount: number
  plannedRatio: number
}

export interface ErrorCostStat {
  tag: string
  tradeCount: number
  errorCost: number
}

export interface TradingHealthStat {
  scoredBuyCount: number
  averageScore: number
  plannedRatio: number
  modeTaggedRatio: number
  certaintyTaggedRatio: number
  exitPlanTaggedRatio: number
}

export interface HeavyPositionStat {
  buyCount: number
  winCount: number
  lossCount: number
  openCount: number
  buyAmount: number
  realizedPnL: number
  contributionRatio: number
  winRate: number
}

export interface ConcentrationStat {
  avgHoldingCount: number
  idealDayCount: number
  outOfRangeDayCount: number
  idealDayRatio: number
  maxHoldingCount: number
}

export interface RealizedTrade {
  date: string
  code: string
  name: string
  quantity: number
  proceeds: number
  costBasis: number
  fee: number
  pnl: number
  modeTag?: string
  certaintyTag?: string
}

export interface HoldingCycle {
  code: string
  name: string
  startDate: string
  endDate: string
  buyCount: number
  buyAmount: number
  sellAmount: number
  pnl: number
  modeTag?: string
  certaintyTag?: string
}

export interface DashboardComputedStats {
  days: TradeDayStats[]
  monthly: MonthlyStat[]
  stocks: StockStat[]
  profitStocks: StockStat[]
  lossStocks: StockStat[]
  overall: OverallStats
  modeStats: ModeStat[]
  certaintyStats: CertaintyStat[]
  planned: PlannedTradeStat
  errorCostStats: ErrorCostStat[]
  health: TradingHealthStat
  heavy: HeavyPositionStat
  concentration: ConcentrationStat
  realizedTrades: RealizedTrade[]
  holdingCycles: HoldingCycle[]
  cycleWinRate: number
  unknownCostSales: Map<string, UnknownCostSale[]>
}

interface HeaderMap {
  time?: number
  code?: number
  name?: number
  direction?: number
  quantity?: number
  price?: number
  amount?: number
  fee?: number
  stampTax?: number
  transferFee?: number
  status?: number
  modeTag?: number
  certaintyTag?: number
  errorTag?: number
  errorCost?: number
  plannedTrade?: number
  exitCondition?: number
  agentSource?: number
  note?: number
}

interface Lot {
  quantity: number
  costPerShare: number
  modeTag?: string
  certaintyTag?: string
  isHeavy: boolean
}

interface UnknownCostSale {
  date: string
  quantity: number
  proceeds: number
}

interface FifoResult {
  dailyRealizedPnL: Map<string, number>
  stockRealizedPnL: Map<string, { name: string; pnl: number; fees: number }>
  realizedTrades: RealizedTrade[]
  holdings: Map<string, Lot[]>
  unknownCostSales: Map<string, UnknownCostSale[]>
  hasUnknownCost: boolean
}

const DEFAULT_POSITION_RULES: PositionRuleConfig = {
  accountEquity: 200000,
  heavyPositionRatio: 0.3,
  fullAttackRatio: 0.5,
  idealHoldingCountMin: 1,
  idealHoldingCountMax: 3,
}

const DEFAULT_MODE_GROUPS: ModeGroupConfig = {
  半路: ["半路", "追涨", "分时突破", "鍗婅矾"],
  低吸: ["低吸", "水下低吸", "回踩", "浣庡惛"],
  打板: ["打板", "扫板", "排板", "涨停", "鎵撴澘", "鎵澘", "鎺掓澘", "娑ㄥ仠"],
}

export function parseTradeMarkdown(date: string, content: string): TradeDayStats {
  const lines = content.split("\n")
  const records: TradeStatRecord[] = []
  let headerMap: HeaderMap | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) {
      headerMap = null
      continue
    }
    if (isSeparatorRow(trimmed)) continue

    const parts = splitMarkdownRow(trimmed)
    if (parts.length < 4) continue

    if (looksLikeTradeHeader(parts)) {
      headerMap = buildHeaderMap(parts)
      continue
    }

    if (!headerMap) continue
    const record = parseTradeRow(date, parts, headerMap)
    if (record) records.push(record)
  }

  return buildDayStats(date, records)
}

function buildDayStats(date: string, records: TradeStatRecord[]): TradeDayStats {
  const buyRecords = records.filter((record) => record.direction === "buy")
  const sellRecords = records.filter((record) => record.direction === "sell")
  const totalFee = records.reduce((sum, record) => sum + record.fee, 0)
  const totalStampTax = records.reduce((sum, record) => sum + record.stampTax, 0)
  const totalTransferFee = records.reduce((sum, record) => sum + record.transferFee, 0)
  const buyAmount = buyRecords.reduce((sum, record) => sum + record.amount, 0)
  const sellAmount = sellRecords.reduce((sum, record) => sum + record.amount, 0)

  return {
    date,
    records,
    tradeCount: records.length,
    buyCount: buyRecords.length,
    sellCount: sellRecords.length,
    buyAmount,
    sellAmount,
    totalFee,
    totalStampTax,
    totalTransferFee,
    netPnL: 0,
  }
}

function splitMarkdownRow(line: string): string[] {
  const parts = line.split("|").map((part) => part.trim())
  if (parts[0] === "") parts.shift()
  if (parts[parts.length - 1] === "") parts.pop()
  return parts
}

function isSeparatorRow(line: string): boolean {
  return /^\|\s*:?-{2,}/.test(line)
}

function looksLikeTradeHeader(parts: string[]): boolean {
  const joined = parts.join(" ")
  return (
    hasAny(joined, ["代码", "证券代码", "浠ｇ爜", "璇佸埜浠ｇ爜"]) &&
    hasAny(joined, ["名称", "证券名称", "鍚嶇О", "璇佸埜鍚嶇О"]) &&
    hasAny(joined, ["方向", "操作", "买卖", "业务", "鎿嶄綔", "涔板崠", "鏂瑰悜"])
  )
}

function buildHeaderMap(parts: string[]): HeaderMap {
  const map: HeaderMap = {}
  parts.forEach((part, index) => {
    if (hasAny(part, ["时间", "成交时间", "委托时间", "鏃堕棿", "鎴愪氦鏃堕棿"])) map.time = index
    else if (hasAny(part, ["代码", "证券代码", "浠ｇ爜", "璇佸埜浠ｇ爜"])) map.code = index
    else if (hasAny(part, ["名称", "证券名称", "鍚嶇О", "璇佸埜鍚嶇О"])) map.name = index
    else if (hasAny(part, ["方向", "操作", "买卖", "业务", "鎿嶄綔", "涔板崠", "鏂瑰悜"])) map.direction = index
    else if (hasAny(part, ["成交数量", "成交量", "数量", "股数", "委托量", "鎴愪氦閲", "鏁伴噺", "鑲℃暟", "濮旀墭閲"])) map.quantity = index
    else if (hasAny(part, ["成交价格", "成交价", "价格", "均价", "委托价", "鎴愪氦浠", "浠锋牸", "鍧囦环", "濮旀墭浠"])) map.price = index
    else if (hasAny(part, ["成交金额", "发生金额", "金额", "清算金额", "閲戦", "鍙戠敓閲", "闁叉垿"])) map.amount = index
    else if (hasAny(part, ["手续费", "佣金", "鎵嬬画璐", "浣ｉ噾"])) map.fee = index
    else if (hasAny(part, ["印花税", "鍗拌姳绋"])) map.stampTax = index
    else if (hasAny(part, ["过户费", "杩囨埛璐"])) map.transferFee = index
    else if (hasAny(part, ["状态", "成交状态", "鐘舵€"])) map.status = index
    else if (hasAny(part, ["模式", "交易模式", "买点", "妯″紡"])) map.modeTag = index
    else if (hasAny(part, ["确定性", "等级", "胜率等级"])) map.certaintyTag = index
    else if (hasAny(part, ["退出条件", "止损条件", "卖出条件", "exit_condition", "exit_plan"])) map.exitCondition = index
    else if (hasAny(part, ["错误成本", "纪律成本", "error_cost", "mistake_cost"])) map.errorCost = index
    else if (hasAny(part, ["错误", "纪律", "问题", "error", "mistake", "閿欒", "绾緥"])) map.errorTag = index
    else if (hasAny(part, ["计划", "作战室", "是否计划内"])) map.plannedTrade = index
    else if (hasAny(part, ["智能体", "来源", "建议来源", "鏅鸿兘浣", "鏉ユ簮"])) map.agentSource = index
    else if (hasAny(part, ["备注", "说明", "理由", "澶囨敞"])) map.note = index
  })

  return {
    time: map.time ?? 0,
    direction: map.direction ?? 1,
    code: map.code ?? 2,
    name: map.name ?? 3,
    price: map.price ?? 4,
    quantity: map.quantity ?? 5,
    amount: map.amount,
    fee: map.fee,
    stampTax: map.stampTax,
    transferFee: map.transferFee,
    status: map.status,
    modeTag: map.modeTag,
    certaintyTag: map.certaintyTag,
    errorTag: map.errorTag,
    errorCost: map.errorCost,
    plannedTrade: map.plannedTrade,
    exitCondition: map.exitCondition,
    agentSource: map.agentSource,
    note: map.note,
  }
}

function parseTradeRow(date: string, parts: string[], map: HeaderMap): TradeStatRecord | null {
  const status = readCell(parts, map.status)
  if (status && !isFilledTrade(status)) return null

  const direction = parseDirection(readCell(parts, map.direction))
  if (!direction) return null

  const quantity = parseNumber(readCell(parts, map.quantity))
  const price = parseNumber(readCell(parts, map.price))
  const explicitAmount = parseNumber(readCell(parts, map.amount))
  const amount = Math.abs(explicitAmount > 0 ? explicitAmount : price * quantity)
  if (quantity <= 0 || amount <= 0) return null

  const exitCondition = normalizeOptional(readCell(parts, map.exitCondition))
  const noteText = normalizeOptional(readCell(parts, map.note))
  const note = [exitCondition, noteText].filter(Boolean).join("；") || undefined
  const rawMode = normalizeOptional(readCell(parts, map.modeTag)) ?? inferModeTag(note)
  const certaintyTag = normalizeOptional(readCell(parts, map.certaintyTag)) ?? inferCertaintyTag(note)
  const plannedTrade = parsePlannedTrade(readCell(parts, map.plannedTrade), note)

  return {
    date,
    time: normalizeOptional(readCell(parts, map.time)),
    code: readCell(parts, map.code),
    name: readCell(parts, map.name),
    direction,
    quantity,
    price,
    amount,
    fee: Math.abs(parseNumber(readCell(parts, map.fee))),
    stampTax: Math.abs(parseNumber(readCell(parts, map.stampTax))),
    transferFee: Math.abs(parseNumber(readCell(parts, map.transferFee))),
    modeTag: rawMode,
    certaintyTag,
    plannedTrade,
    exitCondition,
    errorTag: normalizeOptional(readCell(parts, map.errorTag)),
    errorCost: Math.abs(parseNumber(readCell(parts, map.errorCost))) || undefined,
    agentSource: normalizeOptional(readCell(parts, map.agentSource)),
    note,
  }
}

function readCell(parts: string[], index: number | undefined): string {
  if (index == null) return ""
  return parts[index]?.trim() ?? ""
}

function parseDirection(value: string): TradeStatRecord["direction"] | null {
  const text = value.trim()
  if (/^B$/i.test(text)) return "buy"
  if (/^S$/i.test(text)) return "sell"
  if (hasAny(text, ["买入", "证券买入", "融资买入", "涔板叆", "璇佸埜涔板叆", "铻嶈祫涔板叆"])) return "buy"
  if (hasAny(text, ["卖出", "证券卖出", "融资卖出", "鍗栧嚭", "璇佸埜鍗栧嚭", "铻嶈祫鍗栧嚭"])) return "sell"
  return null
}

function isFilledTrade(value: string): boolean {
  const text = value.trim()
  if (!text) return true
  if (hasAny(text, ["未成交", "已撤", "撤单", "废单", "鏈垚浜", "宸叉挙", "鎾ゅ崟", "搴熷崟"])) return false
  return hasAny(text, ["成交", "已成", "部成", "部分成交", "鎴愪氦", "宸叉垚", "閮ㄦ垚"])
}

function parseNumber(value: string): number {
  const cleaned = value
    .replace(/,/g, "")
    .replace(/[锟鈥斺€￥¥\s]/g, "")
    .replace(/[^\d.-]/g, "")
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "-" || trimmed === "--" || trimmed === "—" || trimmed === "鈥?" || trimmed === "閳?") return undefined
  return trimmed
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle))
}

function inferModeTag(note?: string): string | undefined {
  if (!note) return undefined
  return classifyMode(note, DEFAULT_MODE_GROUPS)
}

function inferCertaintyTag(note?: string): string | undefined {
  if (!note) return undefined
  const match = note.match(/A\+|A|B|C/)
  return match?.[0]
}

function parsePlannedTrade(value: string, note?: string): boolean | undefined {
  const text = `${value} ${note ?? ""}`.trim()
  if (!text) return undefined
  if (hasAny(text, ["非计划", "计划外", "冲动", "模式外", "临时追", "盘中乱追"])) return false
  if (hasAny(text, ["计划内", "作战室", "主计划", "备选计划"])) return true
  return undefined
}

function classifyMode(value: string | undefined, modeGroups: ModeGroupConfig = DEFAULT_MODE_GROUPS): string {
  if (!value) return "未标注"
  for (const [mode, aliases] of Object.entries(modeGroups)) {
    if ([mode, ...aliases].some((alias) => value.includes(alias))) return mode
  }
  return value.trim() || "未标注"
}

function isInRange(date: string, range?: DateRange): boolean {
  if (range?.start && date < range.start) return false
  if (range?.end && date > range.end) return false
  return true
}

function runFifoEngine(records: TradeStatRecord[], rules: PositionRuleConfig = DEFAULT_POSITION_RULES): FifoResult {
  const sorted = [...records].sort((a, b) => {
    const left = `${a.date}T${a.time || "00:00:00"}`
    const right = `${b.date}T${b.time || "00:00:00"}`
    return left.localeCompare(right)
  })

  const holdings = new Map<string, Lot[]>()
  const dailyRealizedPnL = new Map<string, number>()
  const stockRealizedPnL = new Map<string, { name: string; pnl: number; fees: number }>()
  const unknownCostSales = new Map<string, UnknownCostSale[]>()
  const realizedTrades: RealizedTrade[] = []
  let hasUnknownCost = false

  for (const record of sorted) {
    const lots = holdings.get(record.code) ?? []

    if (record.direction === "buy") {
      const totalCost = Math.abs(record.amount) + record.fee + record.transferFee
      const costPerShare = record.quantity > 0 ? totalCost / record.quantity : 0
      lots.push({
        quantity: record.quantity,
        costPerShare,
        modeTag: record.modeTag,
        certaintyTag: record.certaintyTag,
        isHeavy: rules.accountEquity > 0 ? record.amount / rules.accountEquity >= rules.heavyPositionRatio : false,
      })
      holdings.set(record.code, lots)
      continue
    }

    let remaining = record.quantity
    const realizedParts: RealizedTrade[] = []

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0]
      const deduct = Math.min(remaining, lot.quantity)
      const ratio = deduct / record.quantity
      const proceeds = record.amount * ratio - record.fee * ratio - record.stampTax * ratio - record.transferFee * ratio
      const costBasis = deduct * lot.costPerShare
      const fee = record.fee * ratio + record.stampTax * ratio + record.transferFee * ratio
      const pnl = proceeds - costBasis

      realizedParts.push({
        date: record.date,
        code: record.code,
        name: record.name,
        quantity: deduct,
        proceeds,
        costBasis,
        fee,
        pnl,
        modeTag: lot.modeTag,
        certaintyTag: lot.certaintyTag,
      })

      lot.quantity -= deduct
      remaining -= deduct
      if (lot.quantity <= 0) lots.shift()
    }

    holdings.set(record.code, lots)

    if (remaining > 0) {
      hasUnknownCost = true
      const netProceeds = record.amount - record.fee - record.stampTax - record.transferFee
      const unknownSales = unknownCostSales.get(record.code) ?? []
      const unknownProceeds = record.quantity > 0 ? netProceeds * (remaining / record.quantity) : 0
      unknownSales.push({ date: record.date, quantity: remaining, proceeds: unknownProceeds })
      unknownCostSales.set(record.code, unknownSales)
    }

    for (const realized of realizedParts) {
      realizedTrades.push(realized)
      dailyRealizedPnL.set(realized.date, (dailyRealizedPnL.get(realized.date) ?? 0) + realized.pnl)
      const stockStat = stockRealizedPnL.get(realized.code) ?? { name: realized.name, pnl: 0, fees: 0 }
      stockStat.pnl += realized.pnl
      stockStat.fees += realized.fee
      stockRealizedPnL.set(realized.code, stockStat)
    }
  }

  return { dailyRealizedPnL, stockRealizedPnL, realizedTrades, holdings, unknownCostSales, hasUnknownCost }
}

export function computeDashboardStats(
  dayStatsList: TradeDayStats[],
  range?: DateRange,
  modeGroups: ModeGroupConfig = DEFAULT_MODE_GROUPS,
  rules: Partial<PositionRuleConfig> = {},
): DashboardComputedStats {
  const positionRules = { ...DEFAULT_POSITION_RULES, ...rules }
  const sortedDays = [...dayStatsList].sort((a, b) => a.date.localeCompare(b.date))
  const allRecords = sortedDays.flatMap((day) => day.records)
  const fifo = runFifoEngine(allRecords, positionRules)

  const daysWithPnl = sortedDays.map((day) => ({
    ...day,
    netPnL: fifo.dailyRealizedPnL.get(day.date) ?? 0,
  }))
  const rangedDays = daysWithPnl.filter((day) => isInRange(day.date, range))
  const rangedRecords = rangedDays.flatMap((day) => day.records)
  const rangedRealized = fifo.realizedTrades.filter((trade) => isInRange(trade.date, range))
  const allCycles = buildHoldingCycles(allRecords, fifo.realizedTrades)
  const rangedCycles = allCycles.filter((cycle) => isInRange(cycle.endDate, range))

  const monthly = buildMonthlyStats(rangedDays)
  const stocks = buildStockStats(rangedDays, rangedRealized)
  const overall = buildOverallStats(rangedDays, fifo, range)
  const modeStats = buildModeStats(rangedRecords, rangedRealized, rangedCycles, modeGroups, positionRules)
  const certaintyStats = buildCertaintyStats(rangedRecords, rangedRealized, rangedCycles, positionRules)
  const planned = buildPlannedStats(rangedRecords)
  const errorCostStats = buildErrorCostStats(rangedRecords)
  const health = buildTradingHealthStats(rangedRecords)
  const heavy = buildHeavyStats(rangedRecords, rangedRealized, positionRules)
  const concentration = buildConcentrationStats(allRecords, range, positionRules)
  const cycleWins = rangedCycles.filter((cycle) => cycle.pnl > 0).length
  const cycleLosses = rangedCycles.filter((cycle) => cycle.pnl < 0).length

  return {
    days: rangedDays,
    monthly,
    stocks,
    profitStocks: stocks.filter((stock) => stock.netPnL > 0).sort((a, b) => b.netPnL - a.netPnL),
    lossStocks: stocks.filter((stock) => stock.netPnL < 0).sort((a, b) => a.netPnL - b.netPnL),
    overall,
    modeStats,
    certaintyStats,
    planned,
    errorCostStats,
    health,
    heavy,
    concentration,
    realizedTrades: rangedRealized,
    holdingCycles: rangedCycles,
    cycleWinRate: cycleWins + cycleLosses > 0 ? cycleWins / (cycleWins + cycleLosses) : 0,
    unknownCostSales: fifo.unknownCostSales,
  }
}

function buildMonthlyStats(days: TradeDayStats[]): MonthlyStat[] {
  const monthMap = new Map<string, MonthlyStat>()
  for (const day of days) {
    const month = day.date.slice(0, 7)
    const existing = monthMap.get(month) ?? { month, netPnL: 0, tradeCount: 0 }
    existing.netPnL += day.netPnL
    existing.tradeCount += day.tradeCount
    monthMap.set(month, existing)
  }
  return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month))
}

function buildStockStats(days: TradeDayStats[], realizedTrades: RealizedTrade[]): StockStat[] {
  const stockMap = new Map<string, StockStat>()
  for (const day of days) {
    for (const record of day.records) {
      const existing = stockMap.get(record.code) ?? {
        code: record.code,
        name: record.name,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        netPnL: 0,
        totalFee: 0,
      }
      existing.tradeCount += 1
      if (record.direction === "buy") existing.buyCount += 1
      else existing.sellCount += 1
      existing.totalFee += record.fee + record.stampTax + record.transferFee
      stockMap.set(record.code, existing)
    }
  }

  for (const realized of realizedTrades) {
    const existing = stockMap.get(realized.code) ?? {
      code: realized.code,
      name: realized.name,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      netPnL: 0,
      totalFee: 0,
    }
    existing.netPnL += realized.pnl
    existing.totalFee += realized.fee
    stockMap.set(realized.code, existing)
  }

  return Array.from(stockMap.values()).sort((a, b) => b.netPnL - a.netPnL)
}

function buildOverallStats(days: TradeDayStats[], fifo: FifoResult, range?: DateRange): OverallStats {
  const totalTradeCount = days.reduce((sum, day) => sum + day.tradeCount, 0)
  const totalBuyCount = days.reduce((sum, day) => sum + day.buyCount, 0)
  const totalSellCount = days.reduce((sum, day) => sum + day.sellCount, 0)
  const totalBuyAmount = days.reduce((sum, day) => sum + day.buyAmount, 0)
  const totalSellAmount = days.reduce((sum, day) => sum + day.sellAmount, 0)
  const totalFee = days.reduce((sum, day) => sum + day.totalFee, 0)
  const totalStampTax = days.reduce((sum, day) => sum + day.totalStampTax, 0)
  const totalTransferFee = days.reduce((sum, day) => sum + day.totalTransferFee, 0)
  const totalNetPnL = days.reduce((sum, day) => sum + day.netPnL, 0)
  const totalErrorCost = days.reduce((sum, day) => sum + day.records.reduce((inner, record) => inner + (record.errorCost ?? 0), 0), 0)
  const dayPnLs = days.map((day) => day.netPnL)
  const maxDayProfit = dayPnLs.length > 0 ? Math.max(...dayPnLs) : 0
  const maxDayLoss = dayPnLs.length > 0 ? Math.min(...dayPnLs) : 0
  const winDays = dayPnLs.filter((value) => value > 0).length
  const lossDays = dayPnLs.filter((value) => value < 0).length
  const breakEvenDays = dayPnLs.filter((value) => value === 0).length
  const avgDayNetPnL = days.length > 0 ? totalNetPnL / days.length : 0

  let totalUnknownQty = 0
  for (const sales of fifo.unknownCostSales.values()) {
    totalUnknownQty += sales.filter((value) => isInRange(value.date, range)).reduce((sum, value) => sum + value.quantity, 0)
  }

  return {
    totalTradeCount,
    totalBuyCount,
    totalSellCount,
    totalBuyAmount,
    totalSellAmount,
    totalFee,
    totalStampTax,
    totalTransferFee,
    totalNetPnL,
    totalErrorCost,
    maxDayProfit,
    maxDayLoss,
    winDays,
    lossDays,
    breakEvenDays,
    avgDayNetPnL,
    hasUnknownCost: totalUnknownQty > 0,
    totalUnknownQty,
  }
}

function buildModeStats(
  records: TradeStatRecord[],
  realizedTrades: RealizedTrade[],
  holdingCycles: HoldingCycle[],
  modeGroups: ModeGroupConfig,
  rules: PositionRuleConfig,
): ModeStat[] {
  const buyRecords = records.filter((record) => record.direction === "buy")
  const totalBuyCount = buyRecords.length
  const modeMap = new Map<string, ModeStat>()

  for (const record of buyRecords) {
    const mode = classifyMode(record.modeTag ?? record.note, modeGroups)
    const stat = modeMap.get(mode) ?? {
      mode,
      buyCount: 0,
      buyAmount: 0,
      avgBuyAmount: 0,
      heavyBuyCount: 0,
      realizedPnL: 0,
      realizedCount: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      buyCountRatio: 0,
    }
    stat.buyCount += 1
    stat.buyAmount += record.amount
    if (rules.accountEquity > 0 && record.amount / rules.accountEquity >= rules.heavyPositionRatio) {
      stat.heavyBuyCount += 1
    }
    modeMap.set(mode, stat)
  }

  for (const realized of realizedTrades) {
    const mode = classifyMode(realized.modeTag, modeGroups)
    const stat = modeMap.get(mode) ?? {
      mode,
      buyCount: 0,
      buyAmount: 0,
      avgBuyAmount: 0,
      heavyBuyCount: 0,
      realizedPnL: 0,
      realizedCount: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      buyCountRatio: 0,
    }
    stat.realizedPnL += realized.pnl
    stat.realizedCount += 1
    modeMap.set(mode, stat)
  }

  for (const cycle of holdingCycles) {
    const mode = classifyMode(cycle.modeTag, modeGroups)
    const stat = modeMap.get(mode) ?? {
      mode,
      buyCount: 0,
      buyAmount: 0,
      avgBuyAmount: 0,
      heavyBuyCount: 0,
      realizedPnL: 0,
      realizedCount: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      buyCountRatio: 0,
    }
    if (cycle.pnl > 0) stat.winCount += 1
    if (cycle.pnl < 0) stat.lossCount += 1
    modeMap.set(mode, stat)
  }

  for (const stat of modeMap.values()) {
    stat.avgBuyAmount = stat.buyCount > 0 ? stat.buyAmount / stat.buyCount : 0
    stat.buyCountRatio = totalBuyCount > 0 ? stat.buyCount / totalBuyCount : 0
    stat.winRate = stat.winCount + stat.lossCount > 0 ? stat.winCount / (stat.winCount + stat.lossCount) : 0
  }

  return Array.from(modeMap.values()).sort((a, b) => b.buyCount - a.buyCount)
}

function buildCertaintyStats(
  records: TradeStatRecord[],
  realizedTrades: RealizedTrade[],
  holdingCycles: HoldingCycle[],
  rules: PositionRuleConfig,
): CertaintyStat[] {
  const levels = ["A+", "A", "B", "C", "未标注"]
  const statMap = new Map<string, CertaintyStat>()

  function ensure(level: string): CertaintyStat {
    const key = levels.includes(level) ? level : "未标注"
    const existing = statMap.get(key)
    if (existing) return existing
    const created: CertaintyStat = {
      level: key,
      buyCount: 0,
      heavyBuyCount: 0,
      realizedPnL: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
    }
    statMap.set(key, created)
    return created
  }

  for (const record of records) {
    if (record.direction !== "buy") continue
    const stat = ensure(record.certaintyTag ?? "未标注")
    stat.buyCount += 1
    if (rules.accountEquity > 0 && record.amount / rules.accountEquity >= rules.heavyPositionRatio) {
      stat.heavyBuyCount += 1
    }
  }

  for (const realized of realizedTrades) {
    const stat = ensure(realized.certaintyTag ?? "未标注")
    stat.realizedPnL += realized.pnl
  }

  for (const cycle of holdingCycles) {
    const stat = ensure(cycle.certaintyTag ?? "未标注")
    if (cycle.pnl > 0) stat.winCount += 1
    if (cycle.pnl < 0) stat.lossCount += 1
  }

  for (const stat of statMap.values()) {
    stat.winRate = stat.winCount + stat.lossCount > 0 ? stat.winCount / (stat.winCount + stat.lossCount) : 0
  }

  return Array.from(statMap.values()).sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level))
}

function buildPlannedStats(records: TradeStatRecord[]): PlannedTradeStat {
  const buyRecords = records.filter((record) => record.direction === "buy")
  const plannedBuyCount = buyRecords.filter((record) => record.plannedTrade === true).length
  const unplannedBuyCount = buyRecords.filter((record) => record.plannedTrade === false).length
  const untaggedBuyCount = buyRecords.length - plannedBuyCount - unplannedBuyCount
  const tagged = plannedBuyCount + unplannedBuyCount
  return {
    plannedBuyCount,
    unplannedBuyCount,
    untaggedBuyCount,
    plannedRatio: tagged > 0 ? plannedBuyCount / tagged : 0,
  }
}

function buildErrorCostStats(records: TradeStatRecord[]): ErrorCostStat[] {
  const statMap = new Map<string, ErrorCostStat>()
  for (const record of records) {
    const cost = record.errorCost ?? 0
    if (cost <= 0) continue
    const tag = record.errorTag ?? "未标注"
    const stat = statMap.get(tag) ?? { tag, tradeCount: 0, errorCost: 0 }
    stat.tradeCount += 1
    stat.errorCost += cost
    statMap.set(tag, stat)
  }
  return Array.from(statMap.values()).sort((a, b) => b.errorCost - a.errorCost)
}

function buildTradingHealthStats(records: TradeStatRecord[]): TradingHealthStat {
  const buyRecords = records.filter((record) => record.direction === "buy")
  if (buyRecords.length === 0) {
    return {
      scoredBuyCount: 0,
      averageScore: 0,
      plannedRatio: 0,
      modeTaggedRatio: 0,
      certaintyTaggedRatio: 0,
      exitPlanTaggedRatio: 0,
    }
  }

  let totalScore = 0
  let plannedCount = 0
  let modeTaggedCount = 0
  let certaintyTaggedCount = 0
  let exitPlanTaggedCount = 0

  for (const record of buyRecords) {
    let score = 0
    if (record.plannedTrade === true) {
      score += 20
      plannedCount += 1
    }
    if (record.modeTag) {
      score += 15
      modeTaggedCount += 1
    }
    if (record.certaintyTag) {
      score += 15
      certaintyTaggedCount += 1
    }
    if (record.note && hasAny(record.note, ["退出", "止损", "卖出", "不及预期", "破位", "条件"])) {
      score += 15
      exitPlanTaggedCount += 1
    }
    if (!record.note || !hasAny(record.note, ["S4", "小作文", "传闻"])) {
      score += 10
    }
    if (record.plannedTrade === false) score -= 20
    totalScore += Math.max(0, Math.min(100, score))
  }

  return {
    scoredBuyCount: buyRecords.length,
    averageScore: totalScore / buyRecords.length,
    plannedRatio: plannedCount / buyRecords.length,
    modeTaggedRatio: modeTaggedCount / buyRecords.length,
    certaintyTaggedRatio: certaintyTaggedCount / buyRecords.length,
    exitPlanTaggedRatio: exitPlanTaggedCount / buyRecords.length,
  }
}

function buildHoldingCycles(records: TradeStatRecord[], realizedTrades: RealizedTrade[]): HoldingCycle[] {
  const sorted = [...records].sort((a, b) =>
    `${a.date}T${a.time || "00:00:00"}`.localeCompare(`${b.date}T${b.time || "00:00:00"}`),
  )
  const realizedByDateCode = new Map<string, RealizedTrade[]>()
  for (const trade of realizedTrades) {
    const key = `${trade.date}|${trade.code}`
    const list = realizedByDateCode.get(key) ?? []
    list.push(trade)
    realizedByDateCode.set(key, list)
  }

  const open = new Map<string, HoldingCycle & { quantity: number }>()
  const cycles: HoldingCycle[] = []

  for (const record of sorted) {
    const current = open.get(record.code)
    if (record.direction === "buy") {
      const next = current ?? {
        code: record.code,
        name: record.name,
        startDate: record.date,
        endDate: record.date,
        buyCount: 0,
        buyAmount: 0,
        sellAmount: 0,
        pnl: 0,
        modeTag: record.modeTag,
        certaintyTag: record.certaintyTag,
        quantity: 0,
      }
      next.name = record.name || next.name
      next.buyCount += 1
      next.buyAmount += record.amount
      next.quantity += record.quantity
      if (!next.modeTag) next.modeTag = record.modeTag
      if (!next.certaintyTag) next.certaintyTag = record.certaintyTag
      open.set(record.code, next)
      continue
    }

    if (!current) continue
    current.endDate = record.date
    current.sellAmount += record.amount
    current.quantity -= record.quantity
    const key = `${record.date}|${record.code}`
    const realized = realizedByDateCode.get(key) ?? []
    current.pnl += realized.reduce((sum, trade) => sum + trade.pnl, 0)
    realizedByDateCode.set(key, [])

    if (current.quantity <= 0) {
      const { quantity: _quantity, ...closed } = current
      cycles.push(closed)
      open.delete(record.code)
    } else {
      open.set(record.code, current)
    }
  }

  return cycles.sort((a, b) => a.endDate.localeCompare(b.endDate))
}

function buildHeavyStats(
  records: TradeStatRecord[],
  realizedTrades: RealizedTrade[],
  rules: PositionRuleConfig,
): HeavyPositionStat {
  const heavyBuys = records.filter(
    (record) =>
      record.direction === "buy" &&
      rules.accountEquity > 0 &&
      record.amount / rules.accountEquity >= rules.heavyPositionRatio,
  )
  const heavyRealized = realizedTrades.filter((trade) => {
    const sourceBuy = heavyBuys.find((buy) => buy.code === trade.code && buy.date <= trade.date)
    return Boolean(sourceBuy)
  })
  const realizedPnL = heavyRealized.reduce((sum, trade) => sum + trade.pnl, 0)
  const winCount = heavyRealized.filter((trade) => trade.pnl > 0).length
  const lossCount = heavyRealized.filter((trade) => trade.pnl < 0).length
  const closed = winCount + lossCount
  const totalPnL = realizedTrades.reduce((sum, trade) => sum + trade.pnl, 0)

  return {
    buyCount: heavyBuys.length,
    winCount,
    lossCount,
    openCount: Math.max(0, heavyBuys.length - closed),
    buyAmount: heavyBuys.reduce((sum, record) => sum + record.amount, 0),
    realizedPnL,
    contributionRatio: totalPnL !== 0 ? realizedPnL / totalPnL : 0,
    winRate: closed > 0 ? winCount / closed : 0,
  }
}

function buildConcentrationStats(
  records: TradeStatRecord[],
  range: DateRange | undefined,
  rules: PositionRuleConfig,
): ConcentrationStat {
  const sorted = [...records].sort((a, b) => `${a.date}T${a.time || "00:00:00"}`.localeCompare(`${b.date}T${b.time || "00:00:00"}`))
  const qtyByCode = new Map<string, number>()
  const countsByDate = new Map<string, number>()

  for (const record of sorted) {
    const current = qtyByCode.get(record.code) ?? 0
    if (record.direction === "buy") {
      qtyByCode.set(record.code, current + record.quantity)
    } else {
      const next = current - record.quantity
      if (next > 0) qtyByCode.set(record.code, next)
      else qtyByCode.delete(record.code)
    }
    if (isInRange(record.date, range)) {
      countsByDate.set(record.date, Array.from(qtyByCode.values()).filter((qty) => qty > 0).length)
    }
  }

  const counts = Array.from(countsByDate.values())
  const idealDayCount = counts.filter((count) => count >= rules.idealHoldingCountMin && count <= rules.idealHoldingCountMax).length
  const outOfRangeDayCount = counts.length - idealDayCount

  return {
    avgHoldingCount: counts.length > 0 ? counts.reduce((sum, count) => sum + count, 0) / counts.length : 0,
    idealDayCount,
    outOfRangeDayCount,
    idealDayRatio: counts.length > 0 ? idealDayCount / counts.length : 0,
    maxHoldingCount: counts.length > 0 ? Math.max(...counts) : 0,
  }
}

export interface Holding {
  code: string
  name: string
  quantity: number
  avgCost: number
  totalCost: number
  marketPrice: number
  unrealizedPnL: number
}

export function calculateCurrentHoldings(
  dayStatsList: TradeDayStats[],
  marketPrices: Record<string, number> = {},
): Holding[] {
  const allRecords = dayStatsList.flatMap((day) => day.records)
  const fifo = runFifoEngine(allRecords)
  const nameMap = new Map<string, string>()
  for (const record of allRecords) {
    nameMap.set(record.code, record.name)
  }

  const result: Holding[] = []
  for (const [code, lots] of fifo.holdings.entries()) {
    const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0)
    if (quantity <= 0) continue

    const totalCost = lots.reduce((sum, lot) => sum + lot.quantity * lot.costPerShare, 0)
    const avgCost = totalCost / quantity
    const marketPrice = marketPrices[code] ?? 0
    const unrealizedPnL = marketPrice > 0 ? (marketPrice - avgCost) * quantity : 0
    result.push({
      code,
      name: nameMap.get(code) || code,
      quantity,
      avgCost,
      totalCost,
      marketPrice,
      unrealizedPnL,
    })
  }

  return result.sort((a, b) => b.totalCost - a.totalCost)
}

export function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
