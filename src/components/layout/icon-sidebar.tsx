import { useEffect, useState } from "react"
import {
  ArrowLeftRight,
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  FileText,
  FolderOpen,
  Globe,
  Network,
  PenLine,
  Radar,
  Search,
  Settings,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadProjectFileTree } from "@/lib/project-file-tree"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type WikiState } from "@/stores/wiki-store"

type NavView = WikiState["activeView"]

interface ReviewTemplate {
  id: string
  name: string
  description: string
  buildContent: (today: string) => string
}

const REVIEW_TEMPLATES: ReviewTemplate[] = [
  {
    id: "trading",
    name: "创建今日复盘",
    description: "基于复盘模板创建今日笔记，保存到 raw/日复盘/",
    buildContent: (today) => `# ${today} 交易复盘

## 一、今日操作

### 操作 1：买入/卖出 [股票名称/代码]
- 时间：
- 价格：
- 仓位：
- 模式：低吸/半路/打板
- 确定性：A+/A/B/C
- 理由：
- 结果：
- 截图：

## 二、市场环境

- 指数走势：
- 市场情绪：
- 涨停家数：
- 跌停家数：
- 主流题材：
- 特殊事件：

## 三、心态与纪律

- 是否按计划交易：
- 最强烈的情绪时刻：
- 自我评分：

## 四、关键反思

### 做对了什么
1. 

### 做错了什么
1. 

### 明日计划
1. 
`,
  },
]

const NAV_ITEMS: { view: NavView; icon: LucideIcon; label: string }[] = [
  { view: "wiki", icon: FileText, label: "知识库" },
  { view: "sources", icon: FolderOpen, label: "原始资料" },
  { view: "search", icon: Search, label: "搜索" },
  { view: "graph", icon: Network, label: "关系图" },
  { view: "dashboard", icon: BarChart3, label: "统计看板" },
  { view: "ingest", icon: Radar, label: "自动摄入" },
  { view: "plan", icon: Target, label: "交易计划" },
  { view: "lint", icon: ClipboardCheck, label: "知识体检" },
  { view: "review", icon: ClipboardList, label: "快速复盘" },
]

interface IconSidebarProps {
  onSwitchProject: () => void
}

export function IconSidebar({ onSwitchProject }: IconSidebarProps) {
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const pendingCount = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const researchActiveCount = useResearchStore((s) => s.tasks.filter((t) => t.status !== "done" && t.status !== "error").length)
  const toggleResearchPanel = useResearchStore((s) => s.setPanelOpen)
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  const [daemonStatus, setDaemonStatus] = useState<string>("starting")

  useEffect(() => {
    const check = async () => {
      try {
        const { clipServerStatus } = await import("@/commands/fs")
        setDaemonStatus(await clipServerStatus())
      } catch {
        setDaemonStatus("error")
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [])

  async function createQuickReviewFile(template: ReviewTemplate) {
    const today = new Date().toISOString().split("T")[0]
    const project = useWikiStore.getState().project
    if (!project) return

    const projectPath = normalizePath(project.path)
    const dir = template.id === "trading" ? `${projectPath}/raw/日复盘` : `${projectPath}/raw/sources`
    const fileName = template.id === "trading" ? `${today}-复盘.md` : `${today}-${template.name}.md`
    const filePath = `${dir}/${fileName}`

    let content = ""
    try {
      content = await readFile(filePath)
    } catch {
      content = template.buildContent(today)
      await createDirectory(dir)
      await writeFile(filePath, content)
      const tree = await loadProjectFileTree(projectPath)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    }

    useWikiStore.getState().setSelectedFile(filePath)
    useWikiStore.getState().setFileContent(content)
    useWikiStore.getState().setActiveView("wiki")
  }

  async function handleQuickReview() {
    const today = new Date().toISOString().split("T")[0]
    const project = useWikiStore.getState().project
    if (!project) return

    const projectPath = normalizePath(project.path)
    const tradingPath = `${projectPath}/raw/日复盘/${today}-复盘.md`
    try {
      const content = await readFile(tradingPath)
      useWikiStore.getState().setSelectedFile(tradingPath)
      useWikiStore.getState().setFileContent(content)
      useWikiStore.getState().setActiveView("wiki")
    } catch {
      setTemplateDialogOpen(true)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-12 flex-col items-center border-r bg-muted/50 py-2">
        <div className="mb-2 flex items-center justify-center">
          <div className="flex h-8 w-8 items-center justify-center rounded-[22%] bg-primary/10">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              onClick={handleQuickReview}
              className="relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <PenLine className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">快速复盘</TooltipContent>
          </Tooltip>

          <div className="my-1 h-px w-6 bg-border" />

          {NAV_ITEMS.map(({ view, icon: Icon, label }) => (
            <Tooltip key={view}>
              <TooltipTrigger
                onClick={() => setActiveView(view)}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                  activeView === view
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                {view === "review" && pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">
                {label}
                {view === "review" && pendingCount > 0 && ` (${pendingCount})`}
              </TooltipContent>
            </Tooltip>
          ))}

          <Tooltip>
            <TooltipTrigger
              onClick={() => toggleResearchPanel(!researchPanelOpen)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                researchPanelOpen
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Globe className="h-5 w-5" />
              {researchActiveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                  {researchActiveCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">Deep Research</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-col items-center gap-1 pb-1">
          <Tooltip>
            <TooltipTrigger className="flex h-6 w-6 items-center justify-center">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  daemonStatus === "running"
                    ? "bg-emerald-500"
                    : daemonStatus === "starting"
                      ? "animate-pulse bg-amber-400"
                      : "animate-pulse bg-red-500"
                }`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">Clip server: {daemonStatus}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setActiveView("settings")}
              className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "settings"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Settings className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={onSwitchProject}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <ArrowLeftRight className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">切换项目</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>快速复盘</DialogTitle>
            <DialogDescription>
              点击下方按钮，创建今日复盘并保存到 raw/日复盘/。如果今日复盘已经存在，会直接打开现有文件。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            {REVIEW_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                className="h-auto flex-col items-start justify-start whitespace-normal px-4 py-3 text-left"
                onClick={async () => {
                  setTemplateDialogOpen(false)
                  await createQuickReviewFile(template)
                }}
              >
                <span className="font-medium">{template.name}</span>
                <span className="text-xs text-primary-foreground/80">{template.description}</span>
              </Button>
            ))}
          </div>
          <DialogClose asChild>
            <Button variant="ghost" className="mt-2 w-full">
              取消
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
