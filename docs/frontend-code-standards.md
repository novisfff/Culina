# 前端代码规范

更新时间：2026-06-11

本文档定义 Culina 前端日常开发的默认约定。前端是移动优先的家庭饮食管理 PWA，代码应服务“快速记录、清晰查看、低维护成本”的家庭使用场景，而不是后台管理系统式体验。

## 1. 技术栈与入口

- 技术栈：React 18、TypeScript、Vite、React Query、Vitest。
- 前端目录：`frontend/`。
- 应用入口：`frontend/src/main.tsx`、`frontend/src/App.tsx`。
- API 封装：`frontend/src/api/`。
- 通用工具：`frontend/src/lib/`、`frontend/src/hooks/`。
- 样式入口：`frontend/src/styles.css`，业务样式位于 `frontend/src/styles/`。

常用命令：

```bash
npm run dev
npm run build
npm test
npm --prefix frontend run smoke
```

## 2. 职责分层

新增代码前先判断职责，再决定放在哪里：

- 页面结构和用户可见 UI 放在 `*Page.tsx`、`*View.tsx` 或具体组件里。
- 页面状态、弹窗状态、选中项、草稿和步骤流放在 `use*State.ts`。
- 创建、更新、删除、确认、AI 生成等提交流程放在 `use*Actions.ts` 或 `use*ActionState.ts`。
- 筛选、排序、统计、分组和页面展示数据整理放在 `use*Data.ts` 或 `*ViewModel.ts`。
- 请求 payload、默认值、类型转换、业务规则和可测试计算放在 `*Model.ts`。
- 静态选项、枚举映射、状态文案和业务配置放在 `*Options.ts`。
- 跨业务通用能力优先复用 `src/lib`、`src/hooks`、`src/api` 中已有封装。

组件应该主要表达界面结构和交互入口，不应同时承担数据请求、缓存失效、复杂状态机和 payload 组装。能写成纯函数的业务逻辑不要绑在 React 组件里。

## 3. 应用与工作区

`App.tsx` 是应用组合层，应负责：

- 组合应用壳、登录态、顶层导航和主要工作区。
- 连接全局查询、跨业务 mutation contract 和顶层 loading/error 状态。
- 把必要数据和动作传给业务工作台。

`App.tsx` 不应承载具体业务页面的大段 JSX、完整表单提交流程、弹窗内部状态或重复 query key。

`Workspace` 是单个业务域的组合层，例如食材、菜谱、食物。它应组合本业务域的数据 hook、状态 hook、action hook 和页面 view，并向 view 提供清晰 props。不要在 workspace 中堆叠大量页面 JSX、复杂派生数据或重复业务动作。

## 4. 页面、移动端与弹窗

`*Page.tsx` / `*View.tsx` 用于表达页面级界面：

- 接收已经准备好的数据、状态和回调。
- 按用户任务组织页面结构，例如列表、详情、编辑、做菜、移动端首页。
- 不直接调用 API，不直接写 React Query mutation。
- 不在 view 内重复实现筛选、排序、统计等派生数据。

移动端页面按独立用户体验设计，不作为桌面页面的简单条件分支：

- 主要业务域应有独立移动端 view/page。
- 移动端和桌面端共享数据 hook、action hook、model helper，不共享大段 JSX。
- 移动端可以拥有不同的信息架构、排序和操作入口，但业务规则必须与桌面端一致。

Dialog、Drawer、Overlay 是独立交互单元：

- 接收 `open`、`value`、`onSubmit`、`onClose` 等清晰 props。
- 可以维护与展示强绑定的轻量局部状态。
- 不直接决定全局缓存失效。
- 不自行拉取业务全量数据。
- 不隐藏复杂 submit workflow。

## 5. 数据请求与缓存

React Query 的 key 和缓存失效必须集中维护：

- query key 统一放在 `frontend/src/api/queryKeys.ts`。
- mutation 成功后的缓存失效统一放在 `frontend/src/api/cacheInvalidation.ts`。
- 组件和业务 hook 不手写裸字符串 query key，例如 `['foods']`。
- 同一业务动作的失效范围只定义一次。
- 非首屏必要数据应延迟到对应工作区或激活状态后加载。

API 调用优先通过 `frontend/src/api` 中的 client 与类型封装。修改后端字段、枚举或响应形状时，必须同步更新前端类型、API 封装、view model 和相关测试。

## 6. 图片、资源、日期和存储

通用能力优先复用已有封装：

- 图片上传、参考图生成、文本生成使用 `frontend/src/hooks/useImageComposer.ts`。
- 资源 URL 解析使用 `frontend/src/lib/assets.ts`。
- 日期格式化、周范围和日期比较使用 `frontend/src/lib/date.ts`。
- localStorage 读写使用 `frontend/src/lib/storage.ts`。
- 新增浏览器存储 key 时使用明确业务前缀。

不要在组件里临时拼接媒体 URL、重复实现日期逻辑或直接散落 `localStorage` 调用。

## 7. 样式与体验

样式应按基础层、业务层和移动端层组织：

- `frontend/src/styles.css` 只作为样式聚合入口。
- 业务样式放入 `frontend/src/styles/*`。
- 新增样式使用业务域前缀，避免跨业务的泛选择器。
- 不新增影响全站的裸标签选择器，除非它属于 foundation 层。
- 移动端样式优先放在移动端样式层或对应业务样式文件，不在组件中堆叠大量 inline style。

体验默认值：

- 移动优先，点击区足够大，首屏任务明确。
- 视觉风格温暖、家庭化、照片驱动。
- 避免企业后台式密集表格作为主要体验。
- 空状态、加载态、错误态和提交中状态必须可理解。

## 基础组件统一化

高频基础组件优先放在 `frontend/src/components/ui-kit/`，并通过 `frontend/src/components/ui-kit.tsx` 兼容出口导出。

- 弹窗、确认框、表单动作、下拉选择、搜索输入、数量单位输入、状态块和徽标属于基础组件。
- 基础组件只负责结构、视觉、可访问性、loading/disabled/error 状态和手机端触控尺寸。
- 食材、食物、菜谱、AI 审批等业务规则不得写入基础组件；这些规则应留在业务 model、hook 或具体业务组件中。
- 手机端和桌面/pad 端共享基础语义和 props；弹层、选择器、导航和长列表可在组件内部使用不同 presentation。
- 基础组件样式放在 `frontend/src/styles/00-ui-kit.css`，使用 `.ui-*` 前缀；业务域样式继续放在对应业务 CSS 文件中。

## 8. 文件体量

文件体量是健康检查，不是开发目标：

- 新增 React TSX 文件默认应保持职责单一，避免把无关状态、请求、派生数据和大量 JSX 堆到同一处。
- 已有大文件不应无边界扩张；如果文件变大，优先检查职责是否清晰。
- 如果文件较长但职责单一、调用清楚、测试明确，可以接受。

## 9. 测试与验证

按变更范围选择验证：

- 文档或注释变更不要求跑完整前端测试。
- model/helper 变更至少跑对应单测。
- 页面结构、工作区编排或状态流变更至少跑 `test`、`build`。
- 响应式、移动端或导航变更应补跑 `smoke`。

推荐命令：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

## 10. Review Checklist

提交前检查：

- 新代码是否放在对应职责层，而不是顺手写进当前文件？
- 组件是否主要表达 UI，而不是同时处理请求、缓存、状态机和 payload？
- 移动端主要页面是否有独立 view/page？
- 派生数据和业务规则是否可测试？
- query key 和缓存失效是否集中维护？
- 图片、日期、资源 URL、localStorage 是否复用已有工具？
- 新增样式是否有业务前缀，是否避免污染其他页面？
- 本次变更的验证命令是否匹配风险范围？
