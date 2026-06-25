# ymj8903668-droid 仓库备份方案

## 目标

把 6 个上游项目纳入你自己的仓库体系，后续即使上游不开放，也能保留可恢复的镜像与引用清单。

## 方式

- 主仓中保留 `external/ymj8903668-droid/`
- 该目录只放备份清单、拉取脚本和镜像快照指针
- 真正的镜像仓库放在 `external/ymj8903668-droid/snapshots/`

## 6 个项目

- `trading-review-wiki`
- `QUEST`
- `WeKnora`
- `wechat-radar`
- `wx-cli`
- `wiki`

## 建议

- 先用脚本拉取 mirror
- 再把关键 README、schema、启动脚本、docs 摘出来同步到 `wiki/99-迁移/` 下
- 不建议把整个上游源码直接混进主交易逻辑目录

