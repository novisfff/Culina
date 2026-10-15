# Culina P0 浏览器测试

阻断式入口 `p0-critical-journeys.spec.mjs` 使用生产构建和浏览器 API mock，不依赖外部后端。它验证前端集成行为，不替代真实数据库、认证策略或 AI commit gate 的后端验收。

## 核心门禁

```bash
npm run frontend:build
npm run frontend:e2e:p0
```

9 个场景在 3 个视口独立执行，共 27 项：

- 登录请求、HttpOnly Cookie、刷新请求和会话恢复。
- 首页及工作区导航、记餐请求、列表更新、刷新后仍存在且没有重复。
- 有近期库存变更时各端仍正常加载；平板和桌面另验证撤销中的按钮禁用与撤销后刷新恢复。
- 库存、采购读取失败时显示未知值，重试后恢复；刷新失败保留旧统计并暂停行动建议。
- refresh 和 me 两个认证接口临时故障时保留恢复入口，重试成功后进入原会话。
- Owner 撤销 AI 结果、焦点保持、刷新恢复和截止时间失效。
- Member 读取自己的会话并撤销结果，不请求 Owner 模型配置。
- 模型设置下拉框 Escape、自动保存、测试及切页后的结果保留。

核心视口为手机 **375×812**、平板竖屏 **768×1024**、桌面 **1440×960**。平板覆盖 768–1023px 的专用样式，不以大于 1024px 的桌面布局代替。

记餐 mock 为每个浏览器 context 独立保存写入结果。未知 API 请求、非预期 HTTP 错误、运行时错误和 console error 均阻断；未登录入口的初次 refresh 401 是明确例外。故障恢复用例仅放行本用例明确登记的路径与状态码，其他错误仍阻断。AI mock 也使用同一个未知请求登记簿。

## 响应式专项

```bash
npm --prefix frontend run e2e:responsive
```

按需检查模型输出控件、提示词缓存开关和 Qwen 固定 WAV 控件在 375×812、390×844、430×932、768×1024、1024×768、1440×900 下的可达性与溢出。每个视口使用独立 context；某个尺寸失败不会遮蔽其他尺寸。这是独立专项，默认 CI 的 P0 命令不会执行它。

状态文案枚举、数值输入边界和 Qwen 模型变体由 `AiResultCards.test.tsx`、`ModelIntegerField.test.tsx`、`ModelAudioOptions.test.tsx` 等组件测试覆盖；核心浏览器门禁保留跨页面交互。

## 截图与失败证据

- 登录卡、家庭首页、记餐弹窗参与截图回归，基线按 `darwin` 和 `linux` 保存。
- HTML 报告：`frontend/playwright-report/index.html`。
- 失败 trace、截图和视频：`frontend/test-results/`。
- CI 零重试，保留失败证据。
- 成功节点截图默认关闭；人工巡检时使用 `CULINA_P0_CHECKPOINTS=1`，适用于核心 P0 和响应式专项。附件用于人工检查，不是自动视觉断言。

只有确认 UI 变化符合规范时才更新基线，并逐张人工检查：

```bash
npm --prefix frontend run e2e:p0:update
npm run frontend:e2e:p0
```

新增视口可用 `--update-snapshots=missing` 只生成缺失基线。新增基线必须同时准备并检查 macOS 和 Linux 版本；普通验收应使用 `--update-snapshots=none` 确认不会补写基线。禁止在 CI 中更新截图。

## CI 与报告

`Frontend E2E P0` 是阻断式门禁，不设置 `continue-on-error`。CI 复用已验证的生产构建。

同仓库 PR 的 P0 Artifact 由受信任的 `Publish Playwright Report` 工作流发布到 `https://novisfff.github.io/Culina/playwright/pr-<PR编号>/`，通过稳定的 PR 评论提供入口。失败报告同样发布；PR 关闭时删除对应页面。fork PR 只保留 Actions Artifact。

独立的 `playwright.deployment.config.mjs` 验证 nginx WebSocket 部署路径，不属于这里的 API mock P0。
