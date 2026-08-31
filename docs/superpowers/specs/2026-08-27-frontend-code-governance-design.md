# Culina 前端代码治理设计规格

状态：提案规格，基于 `b559246669dd3fd9ec463658ce2ed4504df2a1ba`（`origin/main`）。

关联体检：[2026-08-27 前端代码治理体检](../../plans/2026-08-27-frontend-code-governance-assessment.md)。

## 1. 目标与非目标

### 1.1 目标

1. 让前端复杂度、CSS 债务和资源体积变成可复现、可比较、可阻断的工程信号。
2. 把应用壳、工作区、查询、mutation、视图和样式的所有权固定在可审查的边界内，减少跨域联动。
3. 在不改变现有 API、导航、React Query key、AI 草稿/审批和移动端行为的前提下，逐步降低首屏和路由增量传输。
4. 让重构每一步都有行为测试、契约测试、资源报告和固定视口证据，能够单独提交、回滚和定位回归。

### 1.2 非目标

- 不借治理之名重做产品信息架构、后端 API、AI runtime 或数据库模型。
- 不把文件行数变成唯一 KPI；行数只是触发审查的信号，职责、依赖和行为契约优先。
- 不一次性搬迁所有 `components/<domain>` 到 `features/<domain>`，也不重复实现已经存在的 ui-kit/overlay。
- 不在没有 ratchet baseline、manifest 和回滚路径时，直接把当前历史预算改成全仓硬失败。

## 2. 不可破坏的契约

以下契约在整个治理期间必须保持不变；若确需改变，必须另开产品/接口规格，不得藏在“拆文件”提交中：

- `frontend/src/api/queryKeys.ts` 是唯一 query key 来源；`cacheInvalidation.ts` 是 mutation 成功后的失效来源。
- `AppNavigationState`、`AppNavigationTarget`、任务关闭后的 focus 恢复和持久化版本保持兼容。
- 家庭/用户/会话隔离、AI conversation/run/approval 状态、SSE part 合并和取消状态语义保持兼容。
- 认证 loading、首次工作区 loading、后台 refresh、局部错误、空状态、失败保留草稿和重复提交保护保持兼容。
- 桌面、平板和手机共享 data/actions/model；允许独立 View 和信息排序，不允许用隐藏桌面 DOM 冒充移动体验。
- 图片、日期、存储和资源 URL 继续使用既有 `useImageComposer`、`lib/date`、`lib/storage`、`lib/assets` 封装。
- 现有 P0 行为测试、AI contract 测试和必要的 Usage 边界测试不因文件移动而删除；测试迁移必须先有等价行为证据。

## 3. 目标架构

### 3.1 应用组合层

`App.tsx` 的目标职责只有：认证分支、应用壳、导航服务、全局通知、路由选择和各工作区的 typed runtime 连接。建议的组合边界如下：

```text
main.tsx
  └─ AppShellRoot
      ├─ useAuth / useAppNavigationState
      ├─ useAppShellQueries       # family, members, notifications, highlights
      ├─ AppWorkspaceRouter       # 只按 navigation 选择 route entry
      └─ AppOverlayHost           # 全局搜索、通知、跨域 operation overlay

app/queries/
  ├─ useAppShellQueries.ts
  ├─ useHomeQueries.ts
  ├─ useEatQueries.ts
  ├─ useIngredientQueries.ts
  └─ useFamilyQueries.ts

app/mutations/
  ├─ useIngredientMutations.ts
  ├─ useInventoryMutations.ts
  ├─ useRecipeMutations.ts
  ├─ useFoodMutations.ts
  ├─ useMealMutations.ts
  └─ useAiConversationMutations.ts
```

迁移初期保留 `useAppWorkspaceQueries` 和 `useAppMutations` 作为兼容 facade，内部委托上述域 hook；facade 只用于渐进迁移，不能继续增加新 query/mutation。每完成一个域就删除对应 facade 字段并更新调用方。

### 3.2 Typed workspace port

工作区不接收一长串未分组 props，也不直接拿 `QueryClient`。每个 route 由组合层创建一个显式 port：

```ts
type WorkspacePort<Data, Actions> = {
  data: Data;
  actions: Actions;
  navigation: AppNavigationService;
};

type IngredientWorkspacePort = WorkspacePort<IngredientData, IngredientActions> & {
  shell: { notice: NoticeApi; notificationCenter: ReactNode };
};
```

约束：

- `Data`、`Actions`、`shell` 三组均使用明确业务类型；禁止 `Record<string, unknown>`、`any` 或把整个 `api` 对象透传。
- `Actions` 只暴露业务动词和必要的 `isPending`/错误状态；缓存失效、重试和服务端冲突在 action hook 内完成。
- View/Page 只接收准备好的数据、状态和回调；不得导入 `api/client`、`useQuery`、`useMutation` 或 `queryClient`。
- 不建立一个包含所有域的全局 Context。若需要 Context，只能在单一工作区内部提供稳定的只读 view model 或 overlay controller，并写出 provider 的边界测试。

### 3.3 工作区目标分层

```text
<Domain>Route / <Domain>Workspace      # 组合 hook 和 View，不拼 payload
  ├─ use<Domain>Queries                 # query key、enabled、refresh 语义
  ├─ use<Domain>State                   # 选中项、tab、draft、步骤流
  ├─ use<Domain>Actions                 # API、busy、错误、失效、冲突恢复
  ├─ use<Domain>Data / <Domain>ViewModel # 筛选、分组、统计、展示模型
  ├─ <Domain>Model / <Domain>Options    # 纯转换、默认值、校验、文案
  └─ <Domain>DesktopView + <Domain>MobileView
```

现有 `FoodWorkspace`、`IngredientWorkspace`、`AiWorkspace` 和 `EatTaskBodies` 先在原目录按职责拆分；只有新建或大规模迁移的业务模块才优先进入 `features/<domain>`。这样不会为了目录一致性制造一次性大搬迁。

### 3.4 CSS 层与所有权

目标层顺序固定为：

```css
@layer reset, tokens, primitives, shell, domain, responsive, compatibility;
```

- `reset/tokens`：`00-foundation.css`，canonical token 只在此定义。
- `primitives`：`00-ui-kit.css`，只包含跨域基础组件。
- `shell`：AppShell、全局通知、全局搜索和 overlay frame 的共用布局。
- `domain`：Home、Eat/Recipe/Meal、Ingredients/Inventory、Food、AI、Family、Model Usage 各自的业务规则。
- `responsive`：跟随 domain 的手机/平板重排；不再保留全站末端 `07-mobile.css` 作为“最后覆盖一切”的隐式层。
- `compatibility`：迁移期的旧 class/alias，必须有 owner、删除条件和到期版本；不得加入新的业务规则。

每个 selector 归属 `style-ownership.json` 的一个 owner。共享 selector 必须登记消费者和理由；新 selector 不能以裸标签或无域前缀形式进入业务层。`!important`、非 canonical 断点和 raw token 都必须进入带原因/到期日的例外 registry。

### 3.5 资源与 chunk 边界

逻辑入口固定为 `home`、`eat`、`ingredients`、`ai`、`family`；Family 下的 model usage、request logs、AI services 是二级入口。目标依赖图：

```text
main.tsx
  └─ global shell (auth, navigation, foundation, ui-kit, shell CSS)
      ├─ home route
      ├─ eat route
      │   ├─ discover/plan/history
      │   └─ task: food/recipe/cook/meal-create/detail
      ├─ ingredients route
      ├─ ai route
      │   ├─ conversation shell
      │   ├─ message/markdown renderer
      │   └─ approval / human-input editors
      └─ family route
          ├─ profile
          ├─ model usage / request logs
          └─ family model settings
```

路由 entry 可以共享已经加载的 shell，但不能静态引入另一个工作区的完整 View、query 或样式。共享模块的重复传输必须由 manifest 报告，而不是靠人工猜测。

## 4. 度量与门禁契约

### 4.1 Baseline B0

B0 固定为 `b559246669dd3fd9ec463658ce2ed4504df2a1ba`，由脚本写入 `frontend/scripts/frontend-health-baseline.json`，同时记录 Node、npm、Vite、TypeScript、Vitest 版本和构建环境。B0 的关键值：

| 指标 | B0 |
| --- | ---: |
| TS/TSX/CSS 源文件 / 行数 | 565 / 231,782 |
| CSS 行数（`src/styles`） | 73,489 |
| `!important` / `@media` | 837 / 214 |
| selector block / declaration（启发式） | 10,316 / 39,038 |
| token drift baseline 命中 | 50 |
| 全量测试文件 / 测试数 | 214 / 1,786 |
| V8 行 / 分支 / 函数覆盖率 | 71.11% / 75.84% / 66.58% |
| 主 JS gzip / 主 CSS gzip | 263.20 KiB / 189.83 KiB |
| AI / Ingredient / Food entry gzip | 85.84 / 52.44 / 25.21 KiB |
| FamilySettings entry gzip | 10.13 KiB |

用户提供的 71,713 行 CSS、260.39 kB 主 JS 等数字来自较早快照（原脚本单位沿用 kB）；治理以 B0 的新鲜构建数字为唯一比较基线，文档中的预算统一使用 KiB，避免把不同 commit 或单位混成一个门槛。

### 4.2 检查模式

所有检查脚本都提供三种显式模式：

1. `report`：只输出 JSON/Markdown，供本地分析和 artifact 使用；不用于 required check。
2. `ratchet`：立即启用。对既有文件和已登记入口，债务指标不得增加；新增文件必须显式声明 owner 和初始预算。bundle 允许的压缩误差最多 512 bytes，超出即失败。源代码总行数只报告，不单独阻断。
3. `target`：按阶段目标启用。对已完成迁移的入口和 CSS owner 使用最终预算；尚未迁移的 legacy scope 继续使用 ratchet，避免“现状一次性变红”。

baseline 更新只能通过独立治理 PR/提交完成，并同时提交报告 diff、原因、owner、替代方案和回滚方式。功能 PR 不得悄悄提高 baseline 或把新 chunk 标成 optional。

### 4.3 阶段目标

以下是项目级目标；每个阶段仍以“职责是否清楚、行为是否保持”为完成条件。数值是上限，不能通过把代码移动到未登记文件来规避。

| 指标 | B0 | Phase 0 ratchet | Phase 1 CSS exit | 最终目标 |
| --- | ---: | ---: | ---: | ---: |
| CSS 行数（legacy scope） | 73,489 | 不增加 | ≤67,000 | ≤60,000 |
| `!important` | 837 | 不增加，新值禁止 | ≤650 | ≤300；只保留登记例外 |
| `@media` | 214 | 不增加非 canonical 查询 | ≤180 | ≤140 |
| token drift 命中 | 50 | 不增加 | ≤25 | 0（runtime allow-list 除外） |
| 未分类 undefined variable | 24 个引用名 | 不增加 | 0 个无理由引用 | 0 |
| 重复 selector 名（启发式） | 约 1,527 | 不增加 | ≤1,100 | ≤500 |
| `App.tsx` | 1,914 行 | 不增加 | — | ≤850，只有组合逻辑 |
| `IngredientWorkspace.tsx` | 3,639 行 | 不增加 | — | ≤900 |
| `FoodWorkspace.tsx` | 2,493 行 | 不增加 | — | ≤900 |
| `AiWorkspace.tsx` | 1,740 行 | 不增加 | — | ≤800 |
| `EatTaskBodies.tsx` | 1,957 行 | 不增加 | — | ≤900 |
| `InventoryReconciliationDialog.tsx` | 1,755 行 | 不增加 | — | ≤800 |

行数目标只针对生产文件的职责重构；模型、类型和测试不为了凑数字切成无意义碎片。若新功能使总量上涨，必须在同一 owner 内抵消债务，或走带报告的 baseline 评审。

### 4.4 Bundle 定义与目标

构建插件/脚本输出 `frontend-health-manifest.json`，每个 entry 记录 `source`、`js`、`css`、`imports`、`dynamicImports`、模块 raw bytes、gzip bytes 和去重后的传递依赖。所有预算字段和比较值以整数 bytes 存储；文档中的人类可读单位统一写作 KiB（1 KiB = 1024 bytes），不再使用含义不明确的 kB。CI 将本地构建中间文件 `frontend/dist/.vite/frontend-health-manifest.json` 复制到仓库根目录 `.artifacts/frontend-health-manifest.json`，聚合器和上传步骤只使用后者。

- `initial`: `main` entry 首次加载所需的唯一 JS/CSS 资产。
- `entryCritical`: 某 route 自己的 entry chunk（不重复计算已加载 shell）。
- `routeTotal`: route entry 的完整静态/动态传递依赖去重总和；动态按可达分支分别列出，继续用于依赖转移审计。
- `routeTransfer`: 从已加载 main shell 进入该 route 时的新增传输集合；从 `routeTotal` 中扣除已由多个 initial entry 共享的资源。预算可通过 entry 的 `routeMetric` 明确选择 `routeTotalGzipBytes` 或 cache-aware 的 `routeTransferGzipBytes`，不得隐式切换口径。
- gzip 使用 Node `gzipSync`、固定压缩级别和 1024 进制格式；报告同时保留 raw bytes，所有展示值都能由 bytes 无损换算回去。
- 所有 dynamic entry 都必须出现在配置中；新增 entry、孤儿 chunk、无法解析的 import 或 CSS 都是失败，不允许默认忽略。

阶段/最终目标：

| 入口 | 当前 entry gzip | Phase 0 ratchet | 迁移后硬目标 |
| --- | ---: | ---: | ---: |
| main JS | 263.20 KiB | 不增加 | ≤110 KiB |
| main CSS | 189.83 KiB | 不增加 | ≤100 KiB |
| AI `entryCritical` | 85.84 KiB | 不增加 | ≤10.5 KiB |
| AI `routeTransfer` | 待 manifest 首次测量 | 报告并不增加 | ≤176 KiB；完整 `routeTotal` 继续报告并审计；Markdown 单独 ≤32 KiB |
| Ingredient `entryCritical` | 52.44 KiB | 不增加 | ≤37 KiB |
| Food `entryCritical` | 25.21 KiB | 不增加 | ≤26 KiB |
| Family profile | 10.13 KiB | 不增加 | ≤7 KiB |
| Family model settings | 24.95 KiB | 纳入报告 | 按独立 entry 设 ≤20 KiB，再按真实 routeTotal 校准 |

AI 的 10.5 KiB 只表示首屏 orchestrator/shell；AI hard budget 使用 cache-aware `routeTransfer`，避免把已加载 shell 重复计入，但完整 `routeTotal` 仍必须在 manifest 中保留并接受 ratchet/依赖转移审计，不能用改名掩盖体积。

## 5. 查询、mutation 与异步状态规则

- 每个域 query hook 只计算本域 `enabled` 和 loading/refresh 语义；共享 family/members/notification 仍由 shell query 持有。
- 工作区切换不得因为顶层组合而提前请求未激活域；后台 refresh 保留旧数据并显式标记 fetching/stale。
- mutation action 必须返回服务端结果、busy、字段/流程错误和冲突恢复动作；成功后的失效只通过 `cacheInvalidation.ts`。
- 盘点、购物入库、操作撤销、AI approval 和餐食记录的多步事务必须保持当前成功/失败边界；拆分时用行为测试证明“失败不清空草稿、不会重复提交、不会发布假成功”。
- 直接在 View/Workspace 中调用 `api.consume*`、`api.restock*`、`api.record*` 或 `queryClient.fetchQuery` 的代码在相应域 action/query hook 完成前不得新增；迁移完成后应为 0（仅允许只读 loader 的明确 adapter）。

## 6. CSS/token 规则

Canonical 值来自 `frontend-ui-style` 的 `visual-system.md` 和 `responsive-and-overlays.md`：

- 圆角 `10/14/20/28/999px`，控件高度 `36/44/48px`，设备层级 `767/768–1023/1024+`。
- 颜色、文字、间距、阴影和 z-index 使用 foundation token；foundation 本身必须通过 contract 校验。
- `--brand-button-radius` 应引用 `var(--radius-sm)`，不能保留 24px；`--text-muted`、`--tap-large` 等旧名要么迁移到 canonical token，要么作为有期限 alias 定义。
- runtime inline 变量（例如 model usage meter、AI debug depth、viewport inset）登记为 `runtime`，要求声明来源、fallback 和消费者；未登记且无 fallback 的 `var()` 失败。
- 新 `!important`、裸业务 selector、非 canonical media query、无 owner 的 selector 和 raw canonical token 直接失败。
- `prefers-reduced-motion`、第三方/浏览器兼容和动态照片取色可以例外，但必须有 reason、owner、测试和 expiry。

## 7. 测试与证据规则

### 7.1 测试分层

1. 纯 model/view model：先写输入边界、空值、排序、冲突和日期的 Vitest。
2. state/action hook：用 Testing Library 测试提交中、失败保留、取消、重试、旧响应不覆盖新选择。
3. Workspace/View：测用户可见标题、状态、主操作、错误和导航，不以 class 字符串作为唯一断言。
4. AI：保留 `aiWorkspaceContracts.test.ts`，补 run/approval/human-input/cancelled/partial-success 的状态矩阵。
5. E2E：关键路径在固定视口和 reduced motion 下运行，并保留失败截图/trace。

覆盖率策略：Phase 0 只产出 artifact；拆分后按域设 floor，不设置单一全局阈值。建议稳定后的 floor 为：app 80% 行/70% 分支、ingredients 75%/65%、foods 80%/70%、AI 85%/75%；低覆盖的纯 API 适配器可单独解释。任何 floor 变更必须伴随行为测试，而不是只改阈值。

### 7.2 固定视口

每个涉及 CSS、导航、overlay、workspace 或 AI composer 的工作包至少验证：

- 375×812、390×844、430×932
- 768×1024、1024×768
- 1440×900

检查长中文、英文/数字 ID、chip 换行、图片失败、200% 文字缩放、软键盘、安全区、sticky footer 和横向溢出。没有运行的视口必须在提交说明中列为缺口。

## 8. 发布、回滚与停止条件

### 8.1 发布顺序

1. 先上线 report + ratchet，不改变用户界面。
2. 完成 CSS token/ownership 和 App facade 拆分后，逐域打开 target gate。
3. 每个 route 的 manifest 达到目标后，再把对应 budget 从 warning 变成 hard failure。
4. 最后移除 compatibility alias、旧全局 CSS import 和临时 facade。

### 8.2 回滚策略

- 每个阶段使用独立提交；不得把度量脚本、CSS 大搬迁和业务行为变更混在一个不可逆提交中。
- route CSS 迁移期间保留只在本地/回滚构建启用的 `VITE_LEGACY_GLOBAL_STYLES=1` 兼容入口；生产不同时加载两套 CSS。
- 若出现任一条件，停止下一阶段并回滚最近一个阶段提交：P0 E2E 失败；任何家庭/会话隔离或 AI approval 契约失败；关键路径在任一固定视口横向溢出；routeTotal 回退超过 10%；首屏 JS/CSS 增长超过 ratchet 容差；新 selector/变量无法确定 owner。
- 回滚只恢复上一个已验证的资源和行为版本，不删除用户 localStorage、AI 草稿或 v3 cook session 数据。

## 9. 完成定义

治理计划只有在以下条件全部满足时才算完成：

- B0、每阶段报告和最终 manifest 可从干净 checkout 重现。
- 新债务门禁在 CI fail-closed；历史债务按表中目标下降，所有例外有 owner/expiry。
- `App.tsx` 只保留组合逻辑；各 workspace 的 query、state、action、view model 和 View 责任可从依赖图解释。
- 所有动态 route/chunk/CSS 被 manifest 覆盖，main 和 route hard budget 达标。
- 全量 Vitest、typecheck、build、style contract、P0 E2E 和固定视口人工审阅都有新鲜证据。
- 文档、测试、回滚开关和 compatibility alias 已更新；没有未解释的生成物、密钥或家庭隐私数据。
