# ymj8903668-droid 独立镜像仓库结构

## 建议仓库名

- `ymj8903668-droid-mirror`

## 顶层目录

- `README.md`
- `manifests/`
- `snapshots/`
- `notes/`
- `scripts/`

## 目录说明

### `manifests/`

放元数据和索引。

- `backup-manifest.json`
- `repo-list.csv`
- `restore-plan.md`

### `snapshots/`

放 6 个项目的镜像副本。

- `snapshots/trading-review-wiki/`
- `snapshots/QUEST/`
- `snapshots/WeKnora/`
- `snapshots/wechat-radar/`
- `snapshots/wx-cli/`
- `snapshots/wiki/`

### `notes/`

放抽取出来的说明和使用笔记。

- `trading-review-wiki.md`
- `QUEST.md`
- `WeKnora.md`
- `wechat-radar.md`
- `wx-cli.md`
- `wiki.md`

### `scripts/`

放拉取和更新脚本。

- `mirror-repos.ps1`
- `mirror-repos.sh`

## 使用原则

- 这个仓库只做镜像，不改上游逻辑。
- 上游一旦有更新，重新拉镜像即可。
- 你在 Mac 上只需要 clone 这一个镜像仓库。

## 和 73WIKI 的关系

- `73WIKI` 继续做交易主链。
- `ymj8903668-droid-mirror` 做外部项目备份。
- 两个仓库分开，避免把外部项目污染到主交易系统里。

