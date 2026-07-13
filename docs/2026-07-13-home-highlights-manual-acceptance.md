# Home Household Highlights — 部署后手工验收清单

**环境**
- Worktree: `.worktrees/home-highlights-accept` @ `origin/main` (+ MySQL 8.4 TEXT migration fix)
- Frontend: http://127.0.0.1:5173/
- Backend:  http://127.0.0.1:8010/  (docs: /docs)
- DB: `backend/.env` → MySQL 8.4.9，Alembic head `4a5b6c7d8e9f`
- 家庭：`星星家的厨房`（已有成员：林然 Owner / 爷爷 / 安安）

**验收原则**
- 一次成功事务最多 1 条高亮；失败 / 409 / 422 / 回滚 / 幂等重放 **不得**增加高亮
- 首页只请求 `/api/activity-highlights`，Family 才请求 `/api/activity-logs`
- 高亮摘要不伪造（例如无 meal 时不做「并记录用餐」）
- 另一家庭不得看到本家庭高亮与演员名

---

## 0. 启动与迁移冒烟（已完成可勾）

- [x] 生产库 `alembic upgrade head` 到 `4a5b6c7d8e9f`
- [x] `activity_logs.highlight_kind` / `highlight_summary` 存在
- [x] 后端 `/docs` 200；`GET /api/activity-highlights` 未登录 401
- [x] 前端 http://127.0.0.1:5173/ 可打开
- [ ] 登录两个账号（建议：林然 + 爷爷 或 安安）

---

## 1. 首页三问结构

### 桌面（≥1280 宽）
- [ ] 可见「今天吃什么 / 今天必须处理什么 / 家里发生了什么」
- [ ] 推荐最多 3 张；「换一批」在 N≤3 时禁用
- [ ] 紧凑日历 7 天
- [ ] 问题 2/3 为两列（约 56/44）
- [ ] 高亮最多 5 条；无菜品/食物图片

### 手机（≤767 宽，或 DevTools iPhone）
- [ ] Hero 保留：Culina / 搜索 / 提醒 / 厨房图 / 家庭 meta / 新增食材 / 查看记录 / 四项统计
- [ ] 推荐仅 1 张；「换一个」N≤1 禁用
- [ ] 问题 2/3 上下单列；高亮最多 3 条
- [ ] 仅 Hero meta 与紧凑日历可横滑；根页面无横向溢出
- [ ] 底部主导航仍在

### 远端状态
- [ ] Network 断掉 highlights 后：问题 1/2 仍可用；问题 3 显示失败+重试（空列表刷新失败也应有「刷新失败，重试」）
- [ ] 成功 0 条：Hero/统计为「本周协作 0 次」；无缓存失败为「本周协作 --」

---

## 2. 查询拆分（DevTools Network）

- [ ] 首页：有 `GET /api/activity-highlights?limit=5`，**无** `GET /api/activity-logs`
- [ ] 切到 Family：有 `GET /api/activity-logs`（无 limit），**无** highlights 请求
- [ ] 首页 highlights 慢/失败时，不出现全屏 boot loading

---

## 3. 业务事务矩阵（每条：业务结果 + 高亮条数）

> 每做完一项：首页问题 3 看摘要；Family「查看完整记录」看审计粒度。

### 3.1 采购入库 / 盘点 / 撤销 / 过期处理
- [ ] **购物入库**成功 → 1 条 `shopping` 高亮（如「完成 N 项采购入库」）
- [ ] **同一 Idempotency / client_request_id 重放** → 业务结果不变，高亮仍 1 条
- [ ] **库存盘点**成功 → 1 条 `inventory` 高亮
- [ ] 盘点重放 → 高亮仍 1 条
- [ ] **撤销入库** → 1 条新 `shopping` 高亮（「撤销一次采购入库」）
- [ ] **撤销盘点** → 1 条新 `inventory` 高亮
- [ ] **再次撤销**已撤销单 → 失败/无业务变化，**不**新增高亮
- [ ] **集中销毁过期批次** → 1 条 `inventory`（「集中处理 N 个过期批次」）
- [ ] **snooze / 保留 / 改保质期** → 仅审计，**无**高亮

### 3.2 菜单计划 / 餐食
- [ ] **创建计划** → 1 条 `meal_plan`
- [ ] **只改备注** → 无新高亮
- [ ] **改食物/日期/餐次** → 1 条新 `meal_plan`
- [ ] **只改 status/cooked 标记** → 无新 `meal_plan` 高亮
- [ ] **删除计划** → 1 条 `meal_plan`
- [ ] **新建餐食记录** → 1 条 `meal`
- [ ] **quick-add 首次** → 1 条 `meal`；**同一计划再 quick-add 无新 entry** → 无新高亮
- [ ] **餐食改评分/照片/补充** → 无新高亮
- [ ] **菜谱完成且记录用餐** → 1 条 `meal`（「完成 X 并记录用餐」）
- [ ] **菜谱完成且不记录用餐** → 1 条 `meal`（「完成 X」，**无**「并记录用餐」）
- [ ] 一次 cook 即使扣库存+完成计划，也只有 **1** 条 meal 高亮

### 3.3 家庭
- [ ] **邀请成员成功** → 1 条 `family`（「邀请 {名} 加入家庭」）
- [ ] **改家庭资料 / 成员资料 / 个人资料** → 无新高亮

### 3.4 AI 审批
- [ ] **AI meal_plan 审批成功**（含 create/material update）→ 1 条 `AIOperation` 级 `meal_plan` 高亮
- [ ] **AI meal_plan 仅 note 更新** → 无高亮
- [ ] **AI shopping_list 审批** → 业务写入成功，**无**高亮
- [ ] **AI meal_log create** → 1 条 `meal`，摘要含正确餐次（早餐/午餐/晚餐…）
- [ ] **AI recipe_cook createMealLog=true** → 「完成 X 并记录用餐」
- [ ] **AI recipe_cook createMealLog=false** → 「完成 X」
- [ ] **同 kind composite** → 1 条聚合高亮
- [ ] **跨 kind composite** → 业务成功，**无**高亮
- [ ] **拒绝审批** → 无业务、无高亮
- [ ] 人为制造 after_success/执行失败 → 操作 failed + draft pending_retry，业务回滚，无高亮

### 3.5 失败路径
- [ ] 过期/冲突 409、校验 422、跨家庭 → 无新高亮
- [ ] 首页 highlights 接口 500：其他两问仍可用

---

## 4. Family 完整审计与导航

- [ ] 首页「查看完整记录」→ 切到 Family 且打开 activity（桌面 modal / 手机 page）
- [ ] 关闭 activity 后仍停留在 Family 页
- [ ] 桌面↔手机切换时 `activity` 业务状态不丢，只换 presentation
- [ ] 首次 loading 显示骨架，不闪「暂无家庭活动」
- [ ] 无缓存失败：错误+「重试活动记录」
- [ ] 有缓存刷新失败：保留旧行 +「刷新失败，重试」
- [ ] Family overview 统计在首次 loading/error 时为 `--`，不伪造成 0
- [ ] 完整日志含 audit-only 细粒度（note 更新、snooze 等），首页高亮不含这些

---

## 5. 周菜单导航

- [ ] 首页紧凑日历选一天 →「查看完整周菜单」
- [ ] **桌面**：跳转食物页并聚焦周菜单 section，**不**自动打开计划详情
- [ ] **手机**：打开「手机周菜单」轻量页；返回可用；点某一项才开详情
- [ ] 全局搜索点到计划项仍走 `target:item` 打开详情

---

## 6. 家庭隔离

- [ ] 用另一账号/家庭（若有）登录：看不到上一家庭的高亮与演员真实姓名泄露
- [ ] 无演员映射时显示「家庭成员」

---

## 7. 回归抽检

- [ ] 普通 shopping-list CRUD、菜谱收藏/评分/照片：audit-only，无高亮
- [ ] 推荐列表刷新后游标重置（换一批不会卡在过期窗口）
- [ ] 本周协作数字：首页用服务端 `week_highlight_count`（上海自然周）；Family 仍为近 7×24h 全量审计统计（允许与首页不同）

---

## 记录模板（每条事务）

| # | 操作 | 期望高亮 kind/摘要 | 实际高亮条数 | 幂等重放条数 | 通过? |
|---|---|---|---|---|---|
| 1 | | | | | |
| … | | | | | |
