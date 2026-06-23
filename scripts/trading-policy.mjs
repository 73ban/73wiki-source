export const SIGNAL_GRADE_RULES = [
  {
    grade: "A+",
    minScore: 520,
    minNovelty: 55,
    minExpectationGap: 45,
    minNextDayTradeability: 65,
    writeThemeCard: true,
    writeStockCard: true,
    enterCandidatePool: true,
    enterCorePool: true,
  },
  {
    grade: "A",
    minScore: 360,
    minNovelty: 35,
    minExpectationGap: 28,
    minNextDayTradeability: 45,
    writeThemeCard: true,
    writeStockCard: true,
    enterCandidatePool: true,
    enterCorePool: false,
  },
  {
    grade: "B",
    minScore: 220,
    minNovelty: 18,
    minExpectationGap: 15,
    minNextDayTradeability: 25,
    writeThemeCard: true,
    writeStockCard: true,
    enterCandidatePool: false,
    enterCorePool: false,
  },
  {
    grade: "C",
    minScore: 0,
    minNovelty: 0,
    minExpectationGap: 0,
    minNextDayTradeability: 0,
    writeThemeCard: false,
    writeStockCard: false,
    enterCandidatePool: false,
    enterCorePool: false,
  },
]

export const AI_SUBTHEME_REGISTRY = [
  { key: "optical-module", label: "光模块", keywords: ["光模块", "CPO", "高速光模块", "800G", "1.6T"] },
  { key: "optical-fiber-cable", label: "光纤光缆", keywords: ["光纤", "光缆", "光棒"] },
  { key: "copper-connection", label: "铜连接", keywords: ["铜连接", "AEC", "铜缆", "高速线缆"] },
  { key: "pcb-ccL", label: "PCB/覆铜板", keywords: ["PCB", "覆铜板", "CCL", "PPO树脂", "阻燃剂"] },
  { key: "ai-chip", label: "AI芯片", keywords: ["AI芯片", "GPU", "ASIC", "NPU", "算力芯片"] },
  { key: "advanced-packaging", label: "先进封装", keywords: ["先进封装", "CoWoS", "封装", "HBM"] },
  { key: "storage-memory", label: "存储", keywords: ["存储", "HBM", "DRAM", "NAND"] },
  { key: "data-center", label: "数据中心", keywords: ["数据中心", "IDC", "机柜", "智算中心"] },
  { key: "liquid-cooling", label: "液冷", keywords: ["液冷", "液冷散热", "冷板", "散热"] },
  { key: "power-supply", label: "电源", keywords: ["电源", "HVDC", "服务器电源", "UPS"] },
  { key: "compute-rental", label: "算力租赁", keywords: ["算力租赁", "算力服务", "智算服务"] },
  { key: "domestic-model", label: "国产大模型", keywords: ["大模型", "智谱", "百川", "通义", "文心", "GLM"] },
  { key: "ai-agent", label: "AI Agent", keywords: ["Agent", "智能体", "AI Agent"] },
  { key: "ai-application", label: "AI应用", keywords: ["AI应用", "AIGC", "AI办公", "AI教育", "AI医疗"] },
  { key: "robotics", label: "机器人", keywords: ["机器人", "人形机器人", "伺服", "减速器"] },
  { key: "edge-ai", label: "端侧AI", keywords: ["端侧AI", "AI眼镜", "AI手机", "AI PC"] },
]

export function classifySignalGrade(item) {
  const score = Number(item.score ?? 0)
  const novelty = Number(item.novelty ?? 0)
  const expectationGap = Number(item.expectationGap ?? 0)
  const nextDayTradeability = Number(item.nextDayTradeability ?? 0)
  for (const rule of SIGNAL_GRADE_RULES) {
    if (
      score >= rule.minScore &&
      novelty >= rule.minNovelty &&
      expectationGap >= rule.minExpectationGap &&
      nextDayTradeability >= rule.minNextDayTradeability
    ) {
      return rule
    }
  }
  return SIGNAL_GRADE_RULES[SIGNAL_GRADE_RULES.length - 1]
}

export function detectAiSubthemes(values) {
  const text = Array.isArray(values) ? values.join("\n") : String(values ?? "")
  const hits = []
  for (const subtheme of AI_SUBTHEME_REGISTRY) {
    if (subtheme.keywords.some((keyword) => text.includes(keyword))) hits.push(subtheme.label)
  }
  return [...new Set(hits)]
}
