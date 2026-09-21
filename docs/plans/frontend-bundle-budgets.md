# 前端体积预算 v2

## 目标和生效规则

体积门禁用于发现明显加载成本回退，并给正常功能开发留出空间。预算是按场景制定的性能上限，不是对某次产物大小的复制。唯一活动配置为 `frontend/scripts/bundle-budgets.json`（version 2）。

旧 health baseline 继续用于结构健康检查；其中的 bundle 数值不再参与 v2。旧 `phase`、`completedPhase`、`budget-rollout-state.json` 只保留兼容历史 v1 工具和 fixtures，不控制当前门禁，修改它们不能豁免 v2。

## 计量口径

- 首屏：`main.initial.assets` 的全部静态依赖及已登记启动样式，分别计算 gzip JS、CSS，不再只看入口文件。
- 页面／弹窗：当前逻辑入口的完整资源集合，扣除 `main.initial.assets` 中确定已在启动时加载的资源。仅被另一个页面引用的共享依赖不代表已经缓存，不能直接扣除。
- 全站：manifest 中 JS/CSS 按文件去重计算一次。页面行存在共享依赖重叠，**不得相加**作为全站大小。
- `app-workspace-composition` 是组合入口，采用宽松总量档，不使用普通页面增量阈值。
- 图片仍受原有公共资源检查约束，不混入 JS 预算。

当前 manifest 的页面 `routeTotal` 包含可达的懒加载后代，因此页面数字是保守上界，可能包含尚未打开的弹窗，不宣称是真实首屏网络传输量。独立弹窗另有自身预算；后续若细化入口加载边界，需要同步更新度量与校准，不靠提高预算掩盖计量变化。新规则不直接使用旧 `routeTransfer`，因为该字段会扣除被其他入口共享但未必已经加载的资源。

## 页面档位

以下均为 KiB gzip，前者为提醒线，后者为阻断线。档位按页面职责和当前测量校准，不逐次跟随构建自动上涨。

| 档位 | JS 提醒 / 阻断 | CSS 提醒 / 阻断 | 适用 |
| --- | ---: | ---: | --- |
| startup | 160 / 192 | 72 / 96 | 应用启动 |
| small | 32 / 48 | 24 / 40 | 简单记录、搜索、轻弹窗 |
| standard | 64 / 96 | 48 / 64 | 普通管理页面与表单 |
| complex | 128 / 192 | 64 / 96 | 图表、复合业务页面 |
| rich | 192 / 256 | 64 / 96 | AI 富交互和草稿渲染 |
| composition | 640 / 800 | 192 / 256 | 工作区组合总入口 |
| 全站去重总量 | 768 / 1024 | 256 / 320 | 累计增长防线 |

小页面不会因为恰好只有 6 KiB 就被限定为 8 KiB；相同职责使用同一档位。大功能引入新依赖时，应结合加载路径说明是否需要升档；不自动修改预算或历史快照绕过失败。

## 本次增长

PR 的 current 构建与目标分支准确 SHA 的构建比较，两者使用同一 Node 环境及各自 lockfile。新增入口无可比数据时明确标记为新增，只检查绝对预算；已有入口缺失、未登记、manifest 错误均失败。

| 类型 | 增长提醒 | 增长阻断 |
| --- | --- | --- |
| 首屏 JS | max(5 KiB, 基准 3%) | max(20 KiB, 基准 10%) |
| 页面／弹窗 JS | max(10 KiB, 基准 5%) | max(40 KiB, 基准 15%) |
| 首屏／页面 CSS | max(3 KiB, 基准 5%) | max(10 KiB, 基准 15%) |
| 组合／全站 JS | max(32 KiB, 基准 5%) | max(128 KiB, 基准 20%) |
| 组合／全站 CSS | max(16 KiB, 基准 5%) | max(64 KiB, 基准 20%) |

增长与绝对预算分别判断，任意硬条件触发即失败；历史超预算不会因为本次没有增长就放行。提醒不阻断。

## CI 与本地

CI：PR 比较 base SHA；merge queue 比较 merge-group base SHA；push 比较 before SHA；手动运行比较父提交。目标构建缓存以 SHA、操作系统、架构、Node 版本和缓存格式版本隔离，失败不降级到旧快照。新增构建步骤在缓存命中时跳过；失败仍上传已有产物。

`npm run frontend:build` 执行 v2 绝对预算；无 base 时会明确标注 absolute-only。需要复现完整 CI 增量检查时指定同一份目标产物：

```bash
npm --prefix frontend run check:bundle -- --mode=target --require-base \
  --base-manifest=/absolute/path/base-manifest.json --base-commit=<base-sha>
```

`check:bundle` 默认 report 为只读报告，不阻断体积超限；manifest 损坏不会伪装成成功。常规 build 和 CI 均使用同一套绝对预算判断。CI 额外具备目标分支比较证据。

日志和 Job Summary 显示每个入口 JS/CSS 的基准、当前、差值、硬上限、剩余空间和原因；附最大变化文件辅助定位。产物按源码模块集合匹配，chunk 重组时会标注为近似归因，不把文件名哈希变化当成精确新增依赖证明。

## 校准记录

首次校准使用 PR #142 的 CI 构建产物（run 35579273278）。这张表仅作为分档依据，不参与执行时计算上限。

| 入口 | 档位 | 当前 JS | JS 硬上限 | 当前 CSS | CSS 硬上限 |
| --- | --- | ---: | ---: | ---: | ---: |
| main | startup | 122.0 | 192 | 52.9 | 96 |
| app-workspace-composition | composition | 530.3 | 800 | 143.7 | 256 |
| app-overlay-host | complex | 70.6 | 192 | 24.0 | 96 |
| home | standard | 38.0 | 96 | 26.3 | 64 |
| eat | complex | 121.3 | 192 | 31.3 | 96 |
| meal-log | standard | 31.4 | 96 | 23.2 | 64 |
| ingredients | complex | 91.2 | 192 | 37.0 | 96 |
| food | complex | 103.0 | 192 | 27.7 | 96 |
| ai | rich | 127.9 | 256 | 45.7 | 96 |
| family-profile | small | 16.7 | 48 | 13.8 | 40 |
| family-model-settings | standard | 38.7 | 96 | 0.0 | 64 |
| family-model-settings-desktop | standard | 38.7 | 96 | 0.0 | 64 |
| family-model-settings-mobile | standard | 38.7 | 96 | 0.0 | 64 |
| model-usage | complex | 63.3 | 192 | 35.0 | 96 |
| model-usage-requests | small | 13.8 | 48 | 0.0 | 40 |
| markdown | small | 1.6 | 48 | 0.0 | 40 |
| ai-approval | rich | 127.3 | 256 | 0.0 | 96 |
| ai-human-input | rich | 127.3 | 256 | 0.0 | 96 |
| ai-debug | small | 9.7 | 48 | 0.0 | 40 |
| inventory-operation | standard | 25.2 | 96 | 22.3 | 64 |
| home-dialogs | standard | 43.2 | 96 | 0.0 | 64 |
| search | small | 5.0 | 48 | 1.7 | 40 |
| shopping-dialog | small | 14.5 | 48 | 0.0 | 40 |
| route-overlays | small | 0.0 | 48 | 13.7 | 40 |
| all-assets | 全站 | 551.7 | 1024 | 206.9 | 320 |
