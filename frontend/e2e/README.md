# Culina P0 浏览器测试

这里保存已经从 `scripts/smoke.mjs` 迁出的阻断式 P0 浏览器测试。测试使用标准 Playwright Test runner，但暂时复用 legacy smoke 的完整 API fixture；剩余长尾场景仍由 legacy smoke 覆盖。

## 本地运行

先构建前端，再运行 P0：

```bash
npm run frontend:build
npm run frontend:e2e:p0
```

P0 固定覆盖三个代表视口：

- phone：375×812，触屏移动端；
- tablet：1180×820，触屏横屏；
- desktop：1440×960。

失败证据写入：

- HTML 报告：`frontend/playwright-report/index.html`；
- Trace、失败截图和视频：`frontend/test-results/`；
- 受 Git 管理的视觉基线：`frontend/e2e/__screenshots__/`，文件名按 `darwin` 和 `linux` 分平台保存。

成功的 HTML 报告也会附带登录入口、家庭首页、食材页和记一餐弹窗的关键节点截图，便于人工快速抽检。这些截图只存入本次报告，不作为视觉基线提交。

配置使用 `trace: retain-on-failure`、`screenshot: only-on-failure` 和 `video: retain-on-failure`。CI 无重试，避免偶发通过掩盖不稳定用例。

## 更新视觉基线

只有确认 UI 变化符合设计规范时才执行：

```bash
npm --prefix frontend run e2e:p0:update
npm run frontend:e2e:p0
```

提交前逐张检查新增或变化的 PNG。普通 P0 命令不会接受截图差异；不要在 CI 中使用 `--update-snapshots`。

## CI 门禁与渐进迁移

`Frontend E2E P0` 是阻断式门禁，覆盖登录入口、家庭首页、食物与食材导航、吃过的页面以及记一餐弹窗。首批视觉基线覆盖三个代表视口的登录卡；记一餐弹窗暂时使用可见状态、搜索交互和 legacy smoke 几何断言。它没有 `continue-on-error`。

同仓库 PR 的 P0 Artifact 会由受信任的 `Publish Playwright Report` 工作流发布到 `https://novisfff.github.io/Culina/playwright/pr-<PR编号>/`，并通过一条稳定的 PR 评论提供入口。每次提交覆盖同一 PR 的旧报告，失败报告同样发布；PR 关闭时删除对应页面。fork PR 不自动公开报告，只保留 Actions Artifact。

`Frontend Legacy Smoke (Non-blocking)` 继续运行现有完整视口和长尾场景，在迁移期间保留 `continue-on-error: true`。满足以下任一条件后再移除该设置：

1. legacy smoke 剩余场景均已迁入独立 Playwright Test spec；或
2. legacy smoke 至少连续 10 次 CI 运行完全通过，且不存在依赖重跑才能通过的记录。

移除前还要确认对应 GitHub 分支保护已把 `Frontend E2E P0` 配置为 required check。
