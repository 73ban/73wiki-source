import { useState, useEffect, useCallback } from "react"
import {
  FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, ChevronRight, ChevronDown, Layout, Globe,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  tags: string[]
  links: string[]
  origin?: string
  confidence?: number
  status?: string
}

const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  overview:    { icon: Layout,      label: "总览",     color: "text-yellow-500", order: 0 },
  market:      { icon: BarChart3,   label: "市场环境", color: "text-emerald-500",order: 1 },
  direction:   { icon: Lightbulb,   label: "方向概念", color: "text-purple-500", order: 2 },
  stock:       { icon: Users,       label: "个股档案", color: "text-blue-500",   order: 3 },
  pattern:     { icon: GitMerge,    label: "交易模式", color: "text-red-500",    order: 4 },
  error:       { icon: HelpCircle,  label: "错误库",   color: "text-orange-500", order: 5 },
  strategy:    { icon: BookOpen,    label: "策略仓库", color: "text-cyan-500",   order: 6 },
  entity:      { icon: Users,       label: "实体",     color: "text-blue-500",   order: 7 },
  concept:     { icon: Lightbulb,   label: "概念",     color: "text-purple-500", order: 8 },
  source:      { icon: BookOpen,    label: "来源",     color: "text-orange-500", order: 9 },
  synthesis:   { icon: GitMerge,    label: "综合",     color: "text-red-500",    order: 10 },
  comparison:  { icon: BarChart3,   label: "对比",     color: "text-emerald-500",order: 11 },
  query:       { icon: HelpCircle,  label: "查询",     color: "text-green-500",  order: 12 },
}

const DEFAULT_CONFIG = { icon: FileText, label: "其他知识", color: "text-muted-foreground", order: 99 }
export function KnowledgeTree() {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "market", "direction", "stock", "pattern", "error", "strategy"]))

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiRoot = normalizePath(`${pp}/wiki`)
      const wikiNode = findNodeByPathOrName(fileTree, wikiRoot, "wiki")
      const wikiTree = wikiNode?.children ?? await listDirectory(wikiRoot)
      const mdFiles = flattenMdFiles(wikiTree)

      setPages(
        mdFiles
          .filter((file) => file.name !== "index.md" && file.name !== "log.md")
          .map((file) => buildPageInfo(file.path, file.name)),
      )
    } catch {
      setPages([])
    }
  }, [project, fileTree])

  // Reload when file tree changes (after ingest writes new pages)
  useEffect(() => {
    loadPages()
  }, [loadPages])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        请先打开项目
      </div>
    )
  }

  // Group pages by type
  const grouped = new Map<string, WikiPageInfo[]>()
  for (const page of pages) {
    const list = grouped.get(page.type) ?? []
    list.push(page)
    grouped.set(page.type, list)
  }

  // Sort groups by configured order
  const sortedGroups = [...grouped.entries()]
    .sort((a, b) => {
      const orderA = TYPE_CONFIG[a[0]]?.order ?? DEFAULT_CONFIG.order
      const orderB = TYPE_CONFIG[b[0]]?.order ?? DEFAULT_CONFIG.order
      return orderA - orderB
    })
    .map(([type, items]) => [
      type,
      [...items].sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN", { numeric: true })),
    ] as const)

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>

        {sortedGroups.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            暂无知识节点。摄入 RAW 后，这里会按知识类型和关联关系生成知识树。
          </div>
        )}

        {sortedGroups.map(([type, items]) => {
          const config = TYPE_CONFIG[type] ?? DEFAULT_CONFIG
          const Icon = config.icon
          const isExpanded = expandedTypes.has(type)

          return (
            <div key={type} className="mb-1">
              <button
                onClick={() => toggleType(type)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                <span className="flex-1 text-left font-medium">{config.label}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </button>

              {isExpanded && (
                <div className="ml-3">
                  {items.map((page) => {
                    const isSelected = selectedFile === page.path
                    return (
                      <div key={page.path}>
                        <button
                          onClick={() => setSelectedFile(page.path)}
                          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                            isSelected
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                          }`}
                          title={page.path}
                        >
                          {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                          <span className="truncate">{page.title}</span>
                          {page.links.length > 0 && (
                            <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                              关联 {page.links.length}
                            </span>
                          )}
                        </button>
                        {page.links.length > 0 && (
                          <div className="ml-5 border-l border-border/60 pl-2">
                            {page.links.slice(0, 5).map((link) => (
                              <div key={`${page.path}-${link}`} className="truncate py-0.5 text-xs text-muted-foreground">
                                ↳ {link}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Raw sources quick access */}
        <RawSourcesSection />
      </div>
    </ScrollArea>
  )
}

function RawSourcesSection() {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    if (!project || !expanded) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => setSources(flattenAllFiles(tree)))
      .catch(() => setSources([]))
  }, [project, expanded])

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">原始来源</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function buildPageInfo(path: string, fileName: string): WikiPageInfo {
  const normalizedPath = normalizePath(path)
  let type = "other"
  const title = humanizeTitle(fileName)

  // Fallback: infer type from path
  if (type === "other") {
    if (normalizedPath.includes("/01-市场环境/") || normalizedPath.includes("/市场环境/")) type = "market"
    else if (normalizedPath.includes("/02-方向概念/") || normalizedPath.includes("/方向概念/") || normalizedPath.includes("/概念/") || normalizedPath.includes("/题材档案/")) type = "direction"
    else if (normalizedPath.includes("/03-个股档案/") || normalizedPath.includes("/个股档案/") || normalizedPath.includes("/股票/") || normalizedPath.includes("/持仓档案/")) type = "stock"
    else if (normalizedPath.includes("/04-交易模式/") || normalizedPath.includes("/交易模式/") || normalizedPath.includes("/模式/")) type = "pattern"
    else if (normalizedPath.includes("/05-错误库/") || normalizedPath.includes("/错误库/") || normalizedPath.includes("/错误/")) type = "error"
    else if (normalizedPath.includes("/06-策略仓库/") || normalizedPath.includes("/策略仓库/") || normalizedPath.includes("/策略/") || normalizedPath.includes("/规则/")) type = "strategy"
    else if (normalizedPath.includes("/entities/")) type = "entity"
    else if (normalizedPath.includes("/concepts/")) type = "concept"
    else if (normalizedPath.includes("/sources/")) type = "source"
    else if (normalizedPath.includes("/queries/")) type = "query"
    else if (normalizedPath.includes("/comparisons/")) type = "comparison"
    else if (normalizedPath.includes("/synthesis/")) type = "synthesis"
    else if (fileName === "overview.md") type = "overview"
  }

  return { path, title, type, tags: [], links: [] }
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function humanizeTitle(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function findNodeByPathOrName(nodes: FileNode[], targetPath: string, name: string): FileNode | null {
  const normalizedTarget = normalizePath(targetPath).replace(/\/$/, "")
  for (const node of nodes) {
    const normalizedNodePath = normalizePath(node.path).replace(/\/$/, "")
    if (node.is_dir && (normalizedNodePath === normalizedTarget || node.name === name)) {
      return node
    }
    if (node.children) {
      const found = findNodeByPathOrName(node.children, normalizedTarget, name)
      if (found) return found
    }
  }
  return null
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
