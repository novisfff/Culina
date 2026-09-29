# AI Run 租约与失联回收

## 已确认范围

用户已确认：自动回收失联任务并解除会话阻塞，但不自动重发模型请求；需要再次调用模型时必须由用户明确重试。仅修改聊天、审批恢复、补充信息恢复的执行生命周期，不修改图片 Worker、流式传输协议或其他业务功能。

## 不变量

- 业务事实以现有 Draft/Approval/Operation 为准；回收器不调用模型、不执行领域写入、不撤销已完成操作。
- 同一 Run 的执行拥有者由数据库租约唯一确定，fencing token 单调递增；已失效执行者不能写业务、Timeline、checkpoint 或独立错误收口记录。
- 普通 waiting_approval/waiting_input 不需要心跳，不是失联。已经领取恢复任务但尚未消费的 claim 需要过期收口。
- 多实例启动只扫描过期租约，不能清理全部 running。
- 取消优先；没有待交互对象的中断 Run 进入 failed 并提供安全说明；已完成 Operation 卡保留，不能把部分完成伪装成整个任务完成。
- 用户重试仍先走 recover_or_replay_draft_run，禁止已有操作被重新执行。

## 存储与执行

增加 ai_run_execution_leases，主键 run_id，保存 family_id、worker_id、fencing_token、lease_until、heartbeat_at、provider_started。单独表避免把高频心跳与 Run JSON 写入混在一起。默认租约 90 秒、心跳 15 秒、回收扫描 10 秒，参数受校验。

领取在事务中校验 Run 状态与恢复 claim，拒绝抢占未过期拥有者。过期拥有者只能先回收，不能被新线程直接续跑。未领取前崩溃通过 Run 创建时间 / 恢复 claim 时间的同等宽限期处理。MySQL 使用数据库 UTC 时间。

Worker Session 的行锁、DML、flush、commit 边界统一校验并锁定 fence；checkpoint 使用同一执行身份的独立事务。图节点返回/中断前提交该节点事务，再写 checkpoint，避免两个 Session 互相等待自己的 fence。模型发出前完成前一阶段的数据库提交、检查拥有权并持久化 provider_started，再释放数据库锁进行网络请求；已经发出的请求无法撤回，但迟到结果不能再写业务或推进下一模型回合。

心跳用独立 Session，更新时校验拥有者、token、有效期，不复活过期租约。锁冲突跳过该轮，数据库不可用时失败关闭，不能因心跳线程仍存活就认可拥有权。

## 回收

回收器按租约→Run 顺序领取，冲突跳过，锁后再次检查有效期。回收与 fence 递增、消息收口、activeRunId 更新在同一事务。

1. cancelling 或已有取消请求：复用取消收口。
2. 存在 pending 审批：恢复 waiting_approval，保留草稿。
3. 存在尚未回答的用户输入 part：恢复 waiting_input。
4. 已有 Operation：保留业务结果并说明后续处理中断；显式重试只重放既有业务结果。
5. 曾发出模型请求但没有足够持久化结果：显示结果未确认、没有自动重发、手动重试可能再次计费。
6. 其余：显示处理中断，可手动重试。

恢复 claim 过期但未消费时清除 claim，保持原等待状态；不把用户已提交的批准当成新的批准，不自动推进 continuation。

## 迁移与部署

新增 Alembic migration，不改旧 migration。旧版本进程没有 fence，首次发布必须停止旧版本执行进程后启动新版本；不能声称新增 fence 能阻止不理解该协议的旧代码。无租约的历史活动记录经过宽限期后回收，正常等待记录保留。

## 验证

定向 pytest 覆盖唯一领取、续租、过期不复活、代次变化、跨家庭、旧 Session/Timeline/checkpoint 回滚、取消、等待、Operation 保留、未知 Provider、历史无租约记录、启动健康租约保护、同步/流式/审批/输入恢复。MySQL 专用测试库验证真实锁竞争；无测试库明确记录缺口。前端不改变 DTO，以既有 failed/cancelled/waiting 状态和普通消息说明兼容呈现。


## 实施验证边界

完成所有权协议后仍使用进程内线程执行工作，并未声称拥有外部调用 exactly-once 保证。健康心跳保护正在执行的请求；进程丢失后只收口事实，重复调用必须由用户明确发起。内存 SQLite 对共享连接另做事务串行化且不启动后台心跳；生产并发验收仍须在独立 MySQL 测试库执行。
