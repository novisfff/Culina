from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.ai.skills.base import SkillContext
from app.ai.workflows.orchestrator.profiles import OrchestratorCapabilityPolicy, profile_state_value


@dataclass(frozen=True, slots=True)
class OrchestratorPromptConfig:
    identity: str
    response_style: tuple[str, ...] = field(default_factory=tuple)
    orchestration_contract: tuple[str, ...] = field(default_factory=tuple)
    dynamic_injection_contract: tuple[str, ...] = field(default_factory=tuple)
    tool_contract: tuple[str, ...] = field(default_factory=tuple)
    draft_contract: tuple[str, ...] = field(default_factory=tuple)
    approval_resume_contract: tuple[str, ...] = field(default_factory=tuple)
    artifact_context_contract: tuple[str, ...] = field(default_factory=tuple)
    filtered_artifact_context_contract: tuple[str, ...] = field(default_factory=tuple)
    output_contract: tuple[str, ...] = field(default_factory=tuple)


DEFAULT_ORCHESTRATOR_PROMPT = OrchestratorPromptConfig(
    identity="你是 Culina AI 工作台的主 Orchestrator。",
    response_style=(
        "你可以输出普通 assistant 文本，也可以调用工具；普通文本会直接展示给用户。",
    ),
    orchestration_contract=(
        "你负责直接回答、调用已授权工具，并组织用户可见回复。",
        "本系统采用 agent run loop：每次只推进一个有边界的下一步动作，而不是一次性完成所有后续动作。",
        "Skill 是能力和上下文注入包，不是独立子 agent；注入后本 run 内持续可见。",
    ),
    dynamic_injection_contract=(
        "主工作台需要新能力时，按需调用 skill.inject 注入 Skill，并调用已注入 Skill 的工具。",
        "初始只能根据 catalog record 判断需要哪些能力；如果需要新能力，必须先调用 skill.inject。",
        "调用 skill.inject 时，skills 只能填写 catalog record 的 key，也就是 skill.yaml:key；",
        "不要使用 SKILL.md:name、目录 slug 或短横线形式。例如必须写 inventory_analysis，不能写 inventory-analysis。",
    ),
    tool_contract=(
        "你不能调用未注入 Skill 的业务工具。",
        "需要输出 result card 时，必须调用已授权且明确返回 card 的工具；不要用普通文本或自造 JSON 代替卡片。",
    ),
    draft_contract=(
        "正式写入必须通过 draft tool 生成草稿并等待 approval；不要声称已经完成正式写入。",
        "本轮最多生成一个 draft；生成 draft 后必须结束当前动作并等待 approval。",
        "准备调用 draft tool 前，必须先输出普通文本，说明接下来要生成什么草稿以及为什么。",
        "调用 draft tool 后，不要再输出任何用户可见文本；不要说“已生成”“请确认”“草稿准备好了”。",
        "只有当前已注入 Skill 的 execution record 声明了对应 handoff 时，draft tool 才能携带 typed continuation；reason、目标 Skill、恢复 Skill、目标草稿类型和 state schema 必须与声明完全一致，state 只保留紧凑编排信息。",
    ),
    approval_resume_contract=(
        "当 currentRunArtifacts 里出现 approval_decision 且 approval.status=rejected 时，把它当作 HumanInLoop 工具返回：先尊重拒绝结果，再判断是结束、调整重做，还是继续处理同一任务中的下一项。",
        "拒绝后不要默认停止，也不要推进该草稿的 continuation；是否调整、结束或处理同一任务的其他项目，由你基于原始目标、拒绝结果和当前上下文决定。",
        "每次 draft 确认后都会回到本 Orchestrator；当 currentRunArtifacts 里出现 type=workflow.continuation 且 status=ready 时，按其已验证 payload 恢复对应 Skill；rejected 或 failed 不得推进。旧存量草稿产生的 draft_after_approval / resume_after_approval artifact 仅用于兼容读取。",
        "当 currentRunArtifacts 同时包含 approval_decision 和确认后继续 artifact 时，确认后的总结和下一步说明都由本 Orchestrator 输出；",
        "在调用下一个工具前，用普通文本简短说明已按确认完成了什么，以及接下来继续做什么，例如“已创建白切鸡。接下来我继续整理下一份菜谱草稿。”",
        "确认后如果马上需要生成下一个 draft，把这段自然语言作为下一个 draft 前置说明，而不是上一个 draft 的尾巴。",
    ),
    artifact_context_contract=(
        "你看到的历史 conversation artifacts、artifacts、currentRunArtifacts 和 previousResults 默认是摘要索引，不是完整业务对象。",
        "这些摘要只用于判断已经处理到哪一步、有哪些 draft/approval/entity ID、数量和少量预览项；不要假设其中有完整 payload、approval schema、菜谱 steps 或 ingredient_items。",
        "当确实需要复用某个历史草稿或审批的完整内容时，必须调用 workspace.read_artifact 并传入对应 ID；不要根据摘要补全或编造完整草稿。",
    ),
    filtered_artifact_context_contract=(
        "当前入口看到的 artifacts、currentRunArtifacts 和 previousResults 已按 profile 过滤。",
        "如果上下文里没有 draft 或 approval 摘要，就不要尝试处理历史草稿、审批或正式写入恢复；只使用当前入口可见的普通卡片、人机补充和页面上下文。",
    ),
    output_contract=(
        "不要输出 XML 标签、JSON 状态对象或 structured_result。",
    ),
)


def build_orchestrator_system_prompt(
    *,
    config: OrchestratorPromptConfig,
    context: SkillContext,
    catalog_records: list[dict[str, Any]],
    injected_skill_records: list[dict[str, Any]],
    injected_skill_instruction_sections: list[str],
    allowed_draft_types: list[str],
    profile_state: dict[str, Any] | None = None,
    include_catalog_records: bool = True,
    include_dynamic_injection_contract: bool = True,
    include_draft_contract: bool = True,
    include_allowed_draft_types: bool = True,
    include_injected_skill_records: bool = True,
    artifact_context_policy: str = "all",
) -> str:
    profile = profile_state if profile_state is not None else context.orchestrator_profile or {}
    profile_addon = str(profile_state_value(profile, "systemPromptAddon", "system_prompt_addon") or "").strip()
    capability_policy = profile_state_value(profile, "capabilityPolicy", "capability_policy")
    capability_policy_state = (
        OrchestratorCapabilityPolicy.from_state(capability_policy).to_state()
        if isinstance(capability_policy, dict)
        else {}
    )
    prompt_metadata = {
        "profileKey": str(profile_state_value(profile, "key") or ""),
        "responseStyle": str(profile_state_value(profile, "responseStyle", "response_style") or ""),
        "capabilityPolicy": capability_policy_state,
        "includeCatalogRecords": include_catalog_records,
        "includeDynamicInjectionContract": include_dynamic_injection_contract,
        "includeDraftContract": include_draft_contract,
        "includeAllowedDraftTypes": include_allowed_draft_types,
        "artifactContextPolicy": artifact_context_policy,
        "includeArtifactContextContract": artifact_context_policy != "hidden",
        "catalogRecordKeys": [str(record.get("key") or "") for record in catalog_records if isinstance(record, dict)],
        "injectedSkillKeys": [str(record.get("key") or "") for record in injected_skill_records if isinstance(record, dict)],
        "allowedDraftTypes": allowed_draft_types,
    }
    contract_lines = [
        config.identity,
        *config.response_style,
        *config.orchestration_contract,
    ]
    if include_dynamic_injection_contract:
        contract_lines.extend(config.dynamic_injection_contract)
    contract_lines.extend(config.tool_contract)
    if include_draft_contract:
        contract_lines.extend(config.draft_contract)
        contract_lines.extend(config.approval_resume_contract)
    if artifact_context_policy == "all":
        contract_lines.extend(config.artifact_context_contract)
    elif artifact_context_policy != "hidden":
        contract_lines.extend(config.filtered_artifact_context_contract)
    if include_allowed_draft_types:
        contract_lines.append(
            f"这些是当前已注入 Skill 允许的 draft_types：{json.dumps(allowed_draft_types, ensure_ascii=False)}。"
        )
    contract_lines.extend(config.output_contract)
    sections = [
        _join_prompt_lines(contract_lines),
        "Prompt contract metadata:\n" + json.dumps(prompt_metadata, ensure_ascii=False, default=str),
        "Injected skill instructions:\n" + "\n\n---\n\n".join(injected_skill_instruction_sections),
    ]
    if include_injected_skill_records:
        sections.insert(2, "Injected skills:\n" + json.dumps(injected_skill_records, ensure_ascii=False, default=str))
    if include_catalog_records:
        sections.insert(1, "Catalog records:\n" + json.dumps(catalog_records, ensure_ascii=False, default=str))
    if profile_addon:
        sections.append("Surface profile instructions:\n" + profile_addon)
    return "\n\n".join(sections)


def _join_prompt_lines(lines: list[str]) -> str:
    return "\n".join(line for line in lines if line)
