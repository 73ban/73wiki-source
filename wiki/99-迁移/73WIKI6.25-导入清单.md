# 73WIKI6.25 导入清单

## 目标

把 ymj8903668-droid 的 6 个项目先放入新的 `73WIKI6.25` 仓库，作为 Mac 迁移底座。

## 6 个项目

- `trading-review-wiki`
- `QUEST`
- `WeKnora`
- `wechat-radar`
- `wx-cli`
- `wiki`

## 建议目录

在 `73WIKI6.25` 仓库里建立：

- `external/ymj8903668-droid/snapshots/trading-review-wiki/`
- `external/ymj8903668-droid/snapshots/QUEST/`
- `external/ymj8903668-droid/snapshots/WeKnora/`
- `external/ymj8903668-droid/snapshots/wechat-radar/`
- `external/ymj8903668-droid/snapshots/wx-cli/`
- `external/ymj8903668-droid/snapshots/wiki/`

## 导入方式

1. 先把新仓库 clone 到本地。
2. 运行 `external/ymj8903668-droid/mirror-repos.ps1` 拉取镜像。
3. 再把镜像目录复制或移动到 `73WIKI6.25` 仓库里。
4. 提交一次完整快照。

## 当前状态

- 本地还没有 `73WIKI6.25` 的 clone。
- 现阶段只能先准备脚本和清单，不能直接写入那个仓库。

