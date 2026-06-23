import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, CircleAlert, Clock, Database, FileCheck2, FileQuestion, RefreshCw, Save, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { writeFile } from "@/commands/fs"
import { getIngestCoverage, type IngestCoverage, type IngestLogEntry } from "@/lib/ingest-log"
import { loadCodexEngineStatus, type BrainFileStatus, type CodexEngineStatus, type CodexReportSummary, type DailyLoopSummary, type HistoryReplaySummary } from "@/lib/codex-ingest-status"
import { DEFAULT_WIKI_SYSTEM_CONFIG, loadWikiSystemConfig, type WikiSystemConfig } from "@/lib/wiki-config"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

const INTERVAL_PRESETS = [
  { label: "1 分钟", value: 60_000 },
  { label: "3 分钟", value: 180_000 },
  { label: "5 分钟", value: 300_000 },
  { label: "10 分钟", value: 600_000 },
  { label: "15 分钟", value: 900_000 },
  { label: "30 分钟", value: 1_800_000 },
  { label: "24 小时", value: 86_400_000 },
]

export function IngestView() {
  const project = useWikiStore((s) => s.project)
  const [config, setConfig] = useState<WikiSystemConfig | null>(null)
  const [coverage, setCoverage] = useState<IngestCoverage | null>(null)
  const [engineStatus, setEngineStatus] = useState<CodexEngineStatus | null>(null)
  const [saved, setSaved] = useState(false)

  const projectPath = project ? normalizePath(project.path) : ""

  const load = useCallback(async () => {
    if (!projectPath) return
    const nextConfig = await loadWikiSystemConfig(projectPath)
    setConfig(nextConfig)
    setCoverage(await getIngestCoverage(projectPath))
    setEngineStatus(await loadCodexEngineStatus(projectPath))
  }, [projectPath])

  useEffect(() => {
    load()
  }, [load])

  async function saveConfig() {
    if (!projectPath || !config) return
    await writeFile(`${projectPath}/73wiki.system.json`, `${JSON.stringify(config, null, 2)}\n`)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!project) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">请先打开项目。</div>
  }

  if (!config) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载自动摄入设置中...</div>
  }

  const rawIngest = config.rawIngest
  const fileTree = config.fileTree ?? DEFAULT_WIKI_SYSTEM_CONFIG.fileTree

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">自动摄入设置</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              配置 RAW 自动摄入、文件树刷新时间，并查看每天哪些 RAW 已摄入、失败或尚未摄入。
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={load}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
            <Button onClick={saveConfig}>
              <Save className="mr-2 h-4 w-4" />
              {saved ? "已保存" : "保存设置"}
            </Button>
          </div>
        </div>

        <section className="rounded-xl border bg-card p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">研报/新闻自动摄入</h3>
              <p className="text-xs text-muted-foreground">检测 RAW 新文件，自动触发 LLM 分析和知识库更新。</p>
            </div>
            <Switch
              checked={rawIngest.enabled}
              onChange={(enabled) => setConfig({ ...config, rawIngest: { ...rawIngest, enabled } })}
            />
          </div>

          <div className="space-y-5">
            <div>
              <Label>检查间隔</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {INTERVAL_PRESETS.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setConfig({ ...config, rawIngest: { ...rawIngest, pollIntervalMs: item.value } })}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      rawIngest.pollIntervalMs === item.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>监控目录</Label>
              <div className="mt-2 space-y-2">
                {rawIngest.monitorDirs.map((dir, index) => (
                  <div key={`${dir}-${index}`} className="flex gap-2">
                    <Input
                      value={dir}
                      onChange={(event) => updateMonitorDir(index, event.target.value)}
                    />
                    <Button variant="ghost" size="icon" onClick={() => removeMonitorDir(index)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => addMonitorDir()}>
                  增加目录
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>文件名匹配规则</Label>
                <Input
                  value={rawIngest.fileNamePattern}
                  onChange={(event) =>
                    setConfig({ ...config, rawIngest: { ...rawIngest, fileNamePattern: event.target.value } })
                  }
                />
                <p className="text-xs text-muted-foreground">默认匹配日期 Markdown，可留空表示只按扩展名判断。</p>
              </div>
              <div className="space-y-2">
                <Label>内容标记</Label>
                <Input
                  value={rawIngest.contentTags.join(",")}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      rawIngest: {
                        ...rawIngest,
                        contentTags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                      },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">逗号分隔多个标记。</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>文件树刷新间隔（毫秒）</Label>
                <Input
                  type="number"
                  min={3000}
                  step={1000}
                  value={fileTree.pollIntervalMs}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      fileTree: {
                        ...fileTree,
                        pollIntervalMs: Number(event.target.value) || 3000,
                      },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">默认 3000ms，新 RAW 文件会在几秒内显示。</p>
              </div>
              <div className="space-y-2">
                <Label>浏览器剪藏服务地址（高级，可留空）</Label>
                <Input
                  value={rawIngest.clipboard.endpoint}
                  placeholder="不使用就留空"
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      rawIngest: {
                        ...rawIngest,
                        clipboard: { ...rawIngest.clipboard, endpoint: event.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border bg-card p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">自动摄入记录</h3>
              <p className="text-xs text-muted-foreground">
                RAW 文件总数 {coverage?.rawFiles.length ?? 0}，未完成摄入 {coverage?.uningestedFiles.length ?? 0}。
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <LogTable title="最近摄入记录" entries={(coverage?.entries ?? []).slice(0, 30)} projectPath={projectPath} />
            <UningestedTable files={(coverage?.uningestedFiles ?? []).slice(0, 50)} projectPath={projectPath} />
          </div>
        </section>

        <CodexEnginePanel status={engineStatus} />
      </div>
    </div>
  )

  function updateMonitorDir(index: number, value: string) {
    const next = [...rawIngest.monitorDirs]
    next[index] = value
    setConfig({ ...config!, rawIngest: { ...rawIngest, monitorDirs: next } })
  }

  function removeMonitorDir(index: number) {
    setConfig({
      ...config!,
      rawIngest: {
        ...rawIngest,
        monitorDirs: rawIngest.monitorDirs.filter((_, itemIndex) => itemIndex !== index),
      },
    })
  }

  function addMonitorDir() {
    setConfig({
      ...config!,
      rawIngest: {
        ...rawIngest,
        monitorDirs: [...rawIngest.monitorDirs, "raw/新目录"],
      },
    })
  }
}

function CodexEnginePanel({ status }: { status: CodexEngineStatus | null }) {
  if (!status) {
    return (
      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          正在读取 Codex 交易大脑底座状态...
        </div>
      </section>
    )
  }

  const brainRows = status.brain.filter((item) => item.exists || item.count > 0)
  const latestDaily = status.dailyLoops[0]
  const latestReplay = status.historyReplays[0]

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">Codex 交易大脑底座</h3>
          <p className="text-xs text-muted-foreground">
            只读展示 data/facts、data/brain、manifest 审核、daily-loop 和历史复盘模板状态；不会写 RAW，也不会生成买入建议。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs text-muted-foreground">
          <FileCheck2 className="h-3.5 w-3.5" />
          apply 前置审核
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard
          icon={Database}
          title="Temporal Facts"
          value={`${status.temporalFacts.count}`}
          detail={`${status.temporalIndexExists ? "索引已建立" : "索引未建立"}${status.temporalFacts.invalid ? ` / ${status.temporalFacts.invalid} 行异常` : ""}`}
        />
        <MetricCard
          icon={FileCheck2}
          title="Brain Memory"
          value={`${status.brain.reduce((sum, item) => sum + item.count, 0)}`}
          detail={`${brainRows.length}/${status.brain.length} 个文件可读`}
        />
        <MetricCard
          icon={Clock}
          title="Daily Loop"
          value={latestDaily ? latestDaily.mode ?? "unknown" : "未运行"}
          detail={latestDaily ? `${latestDaily.generatedAt ?? latestDaily.path} / D+ ${latestDaily.factsReady ?? 0}` : "没有运行报告"}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <CodexReportList reports={status.reports} />
        <BrainFileList files={status.brain} />
        <DailyLoopList loops={status.dailyLoops} />
        <HistoryReplayList replays={status.historyReplays} latest={latestReplay} />
      </div>
    </section>
  )
}

function MetricCard({ icon: Icon, title, value, detail }: { icon: typeof Database; title: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function CodexReportList({ reports }: { reports: CodexReportSummary[] }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">Manifest 审核队列</h4>
      {reports.length === 0 ? (
        <EmptyState text="暂无 codex-ingest 审核报告" />
      ) : (
        <div className="space-y-2">
          {reports.map((report) => (
            <div key={report.id} className="rounded-md border border-border/60 p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{report.id}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  W {report.writes} / F {report.factWrites}
                </span>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {report.sourceRelativePath ?? report.path}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {report.createdAt ?? "未记录时间"} / {report.hasReview ? "有 review" : "无 review"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BrainFileList({ files }: { files: BrainFileStatus[] }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">Brain Memory 文件</h4>
      <div className="space-y-2">
        {files.map((file) => (
          <div key={file.name} className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2 text-sm">
            <span className="truncate">{file.name}</span>
            <span className={`shrink-0 text-xs ${file.invalid ? "text-red-500" : "text-muted-foreground"}`}>
              {file.exists ? `${file.count} 条${file.invalid ? ` / ${file.invalid} 异常` : ""}` : "缺失"}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DailyLoopList({ loops }: { loops: DailyLoopSummary[] }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">Daily Loop 报告</h4>
      {loops.length === 0 ? (
        <EmptyState text="暂无 daily-loop 运行报告" />
      ) : (
        <div className="space-y-2">
          {loops.map((loop) => (
            <div key={loop.path} className="rounded-md border border-border/60 p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{loop.mode ?? "unknown"}</span>
                <span className="text-xs text-muted-foreground">{loop.dryRun ? "dry-run" : "write"}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                扫描 {loop.candidatesScanned ?? 0} / D+ {loop.factsReady ?? 0} / facts {loop.factsWritten ?? 0}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{loop.generatedAt ?? loop.path}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HistoryReplayList({ replays, latest }: { replays: HistoryReplaySummary[]; latest?: HistoryReplaySummary }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">历史复盘模板</h4>
      {replays.length === 0 ? (
        <EmptyState text="暂无历史复盘模板" />
      ) : (
        <div className="space-y-2">
          {replays.map((replay) => (
            <div key={replay.path} className="rounded-md border border-border/60 p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{replay.from ?? "unknown"} 至 {replay.to ?? "unknown"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{replay.count ?? 0} 个</span>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {replay.path}{latest?.path === replay.path ? " / 最新" : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-8 text-center text-sm text-muted-foreground">{text}</div>
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  )
}

function LogTable({ title, entries, projectPath }: { title: string; entries: IngestLogEntry[]; projectPath: string }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">{title}</h4>
      {entries.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">暂无摄入记录</div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-md border border-border/60 p-2 text-sm">
              <div className="flex items-center gap-2">
                <StatusIcon status={entry.status} />
                <span className="truncate font-medium">{entry.relativePath || getRelativePath(entry.sourcePath, projectPath)}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {entry.status} · {new Date(entry.updatedAt).toLocaleString()}
                {entry.error ? ` · ${entry.error}` : ""}
              </div>
              {entry.writtenFiles && entry.writtenFiles.length > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">写入 {entry.writtenFiles.length} 个 Wiki 文件</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UningestedTable({ files, projectPath }: { files: string[]; projectPath: string }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-3 font-medium">尚未完成自动摄入的 RAW</h4>
      {files.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">当前没有待摄入文件</div>
      ) : (
        <div className="space-y-2">
          {files.map((file) => (
            <div key={file} className="flex items-center gap-2 rounded-md border border-border/60 p-2 text-sm">
              <FileQuestion className="h-4 w-4 text-amber-500" />
              <span className="truncate">{getRelativePath(file, projectPath)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: IngestLogEntry["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
  if (status === "failed") return <CircleAlert className="h-4 w-4 text-red-500" />
  if (status === "waiting" || status === "processing") return <Clock className="h-4 w-4 text-blue-500" />
  return <FileQuestion className="h-4 w-4 text-muted-foreground" />
}
