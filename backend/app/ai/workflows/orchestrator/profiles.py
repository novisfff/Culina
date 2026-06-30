from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Literal, cast


SkillInjectionPolicy = Literal["dynamic", "fixed", "disabled"]
CatalogScope = Literal["all", "initial_only", "hidden"]
DraftContractPolicy = Literal["auto", "exposed", "hidden"]
ArtifactContextPolicy = Literal["all", "without_drafts", "hidden"]
DEFAULT_MAX_BUSINESS_SKILLS_PER_RUN = 4
DEFAULT_MAX_TOTAL_TOOL_CALLS_PER_RUN = 32
DEFAULT_MAX_SAME_READ_TOOL_CALLS_PER_RUN = 3
MAIN_WORKSPACE_ALLOWED_SKILL_KEYS = (
    "food_profile",
    "ingredient_profile",
    "inventory_analysis",
    "meal_log",
    "meal_plan",
    "recipe_cook",
    "recipe_draft",
    "shopping_list",
)


def _non_negative_int(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed >= 0 else fallback


def _first_present(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return None


def profile_state_value(data: dict[str, Any] | None, *keys: str) -> Any:
    return _first_present(data, *keys) if isinstance(data, dict) else None


def _list_from_state(data: dict[str, Any], *keys: str) -> list[Any]:
    value = _first_present(data, *keys)
    return value if isinstance(value, list) else []


def _explicit_value(data: dict[str, Any], *keys: str) -> tuple[bool, Any]:
    for key in keys:
        if key in data:
            return True, data[key]
    return False, None


def _required_list_from_state(data: dict[str, Any], field_name: str, *keys: str) -> list[Any]:
    present, value = _explicit_value(data, *keys)
    if not present:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list")
    return value


def _strings_from_state(data: dict[str, Any], *keys: str) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            str(item).strip()
            for item in _list_from_state(data, *keys)
            if str(item).strip()
        )
    )


def _text_from_state(data: dict[str, Any], *keys: str) -> str:
    value = _first_present(data, *keys)
    return str(value).strip() if value is not None else ""


@dataclass(frozen=True, slots=True)
class OrchestratorBudgetConfig:
    max_business_skills_per_run: int = DEFAULT_MAX_BUSINESS_SKILLS_PER_RUN
    max_total_tool_calls_per_run: int = DEFAULT_MAX_TOTAL_TOOL_CALLS_PER_RUN
    max_same_read_tool_calls_per_run: int = DEFAULT_MAX_SAME_READ_TOOL_CALLS_PER_RUN

    def to_state(self) -> dict[str, Any]:
        return {
            "maxBusinessSkillsPerRun": self.max_business_skills_per_run,
            "maxTotalToolCallsPerRun": self.max_total_tool_calls_per_run,
            "maxSameReadToolCallsPerRun": self.max_same_read_tool_calls_per_run,
        }

    @classmethod
    def from_state(cls, value: dict[str, Any] | None) -> "OrchestratorBudgetConfig":
        if not isinstance(value, dict):
            return cls()
        return cls(
            max_business_skills_per_run=_non_negative_int(
                _first_present(value, "maxBusinessSkillsPerRun", "max_business_skills_per_run"),
                DEFAULT_MAX_BUSINESS_SKILLS_PER_RUN,
            ),
            max_total_tool_calls_per_run=_non_negative_int(
                _first_present(value, "maxTotalToolCallsPerRun", "max_total_tool_calls_per_run"),
                DEFAULT_MAX_TOTAL_TOOL_CALLS_PER_RUN,
            ),
            max_same_read_tool_calls_per_run=_non_negative_int(
                _first_present(value, "maxSameReadToolCallsPerRun", "max_same_read_tool_calls_per_run"),
                DEFAULT_MAX_SAME_READ_TOOL_CALLS_PER_RUN,
            ),
        )

    def for_capability_policy(self, capability_policy: "OrchestratorCapabilityPolicy") -> "OrchestratorBudgetConfig":
        if capability_policy.allows_dynamic_skill_injection():
            return self
        return OrchestratorBudgetConfig(
            max_business_skills_per_run=0,
            max_total_tool_calls_per_run=self.max_total_tool_calls_per_run,
            max_same_read_tool_calls_per_run=self.max_same_read_tool_calls_per_run,
        )


@dataclass(frozen=True, slots=True)
class OrchestratorProfileMatcher:
    quick_tasks: tuple[str, ...] = ()
    subject_sources: tuple[str, ...] = ()
    surfaces: tuple[str, ...] = ()
    route_hints: tuple[str, ...] = ()

    @classmethod
    def from_state(cls, value: dict[str, Any] | None) -> "OrchestratorProfileMatcher":
        if not isinstance(value, dict):
            return cls()
        return cls(
            quick_tasks=_strings_from_state(value, "quickTasks", "quick_tasks"),
            subject_sources=_strings_from_state(value, "subjectSources", "subject_sources"),
            surfaces=_strings_from_state(value, "surfaces"),
            route_hints=_strings_from_state(value, "routeHints", "route_hints"),
        )

    def matches(self, *, quick_task: str | None, subject: dict[str, Any]) -> bool:
        if quick_task and quick_task in self.quick_tasks:
            return True
        source = str(subject.get("source") or "")
        if source and source in self.subject_sources:
            return True
        extra = subject.get("extra") if isinstance(subject.get("extra"), dict) else {}
        surface = str(extra.get("surface") or "")
        if surface and surface in self.surfaces:
            return True
        route_hint = _route_hint_from_subject(subject)
        return bool(route_hint and route_hint in self.route_hints)


@dataclass(frozen=True, slots=True)
class OrchestratorRouteHint:
    initial_skill_keys: tuple[str, ...]
    quick_tasks: tuple[str, ...] = ()
    subject_sources: tuple[str, ...] = ()
    surfaces: tuple[str, ...] = ()
    route_hints: tuple[str, ...] = ()

    @classmethod
    def from_state(cls, value: dict[str, Any] | None) -> "OrchestratorRouteHint":
        if not isinstance(value, dict):
            raise ValueError("orchestrator route hint config must be a mapping")
        return cls(
            initial_skill_keys=_strings_from_state(value, "initialSkillKeys", "initial_skill_keys"),
            quick_tasks=_strings_from_state(value, "quickTasks", "quick_tasks"),
            subject_sources=_strings_from_state(value, "subjectSources", "subject_sources"),
            surfaces=_strings_from_state(value, "surfaces"),
            route_hints=_strings_from_state(value, "routeHints", "route_hints"),
        )

    def matches(self, *, quick_task: str | None, subject: dict[str, Any]) -> bool:
        return OrchestratorProfileMatcher(
            quick_tasks=self.quick_tasks,
            subject_sources=self.subject_sources,
            surfaces=self.surfaces,
            route_hints=self.route_hints,
        ).matches(quick_task=quick_task, subject=subject)

    def to_state(self) -> dict[str, Any]:
        return {
            "initialSkillKeys": list(self.initial_skill_keys),
            "quickTasks": list(self.quick_tasks),
            "subjectSources": list(self.subject_sources),
            "surfaces": list(self.surfaces),
            "routeHints": list(self.route_hints),
        }


def _route_hint_from_subject(subject: dict[str, Any]) -> str:
    for key in ("route_hint", "routeHint"):
        value = subject.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    extra = subject.get("extra") if isinstance(subject.get("extra"), dict) else {}
    for key in ("route_hint", "routeHint"):
        value = extra.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


@dataclass(frozen=True, slots=True)
class OrchestratorCapabilityPolicy:
    skill_injection: SkillInjectionPolicy = "dynamic"
    catalog_scope: CatalogScope = "all"
    draft_contract: DraftContractPolicy = "auto"
    artifact_context: ArtifactContextPolicy = "all"
    allowed_skill_keys: tuple[str, ...] = ()
    base_tools: tuple[str, ...] = ("skill.inject", "human.request_input")

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "allowed_skill_keys",
            tuple(dict.fromkeys(str(item).strip() for item in self.allowed_skill_keys if str(item).strip())),
        )
        object.__setattr__(
            self,
            "base_tools",
            tuple(
                tool_name
                for tool_name in dict.fromkeys(str(item).strip() for item in self.base_tools if str(item).strip())
                if self.skill_injection == "dynamic" or tool_name != "skill.inject"
            ),
        )

    def to_state(self) -> dict[str, Any]:
        return {
            "skillInjection": self.skill_injection,
            "catalogScope": self.catalog_scope,
            "draftContract": self.draft_contract,
            "artifactContext": self.artifact_context,
            "allowedSkillKeys": list(self.allowed_skill_keys),
            "baseTools": list(self.base_tools),
        }

    @classmethod
    def from_state(cls, value: dict[str, Any] | None) -> "OrchestratorCapabilityPolicy":
        if not isinstance(value, dict):
            return cls()
        skill_injection = str(_first_present(value, "skillInjection", "skill_injection") or "dynamic")
        catalog_scope = str(_first_present(value, "catalogScope", "catalog_scope") or "all")
        draft_contract = str(_first_present(value, "draftContract", "draft_contract") or "auto")
        artifact_context = str(_first_present(value, "artifactContext", "artifact_context") or "all")
        allowed_skill_keys = _list_from_state(value, "allowedSkillKeys", "allowed_skill_keys")
        base_tools = _list_from_state(value, "baseTools", "base_tools") or ["skill.inject", "human.request_input"]
        skill_injection_value = skill_injection if skill_injection in {"dynamic", "fixed", "disabled"} else "dynamic"
        catalog_scope_value = catalog_scope if catalog_scope in {"all", "initial_only", "hidden"} else "all"
        draft_contract_value = draft_contract if draft_contract in {"auto", "exposed", "hidden"} else "auto"
        artifact_context_value = artifact_context if artifact_context in {"all", "without_drafts", "hidden"} else "all"
        return cls(
            skill_injection=cast(SkillInjectionPolicy, skill_injection_value),
            catalog_scope=cast(CatalogScope, catalog_scope_value),
            draft_contract=cast(DraftContractPolicy, draft_contract_value),
            artifact_context=cast(ArtifactContextPolicy, artifact_context_value),
            allowed_skill_keys=tuple(str(item) for item in allowed_skill_keys if str(item).strip()),
            base_tools=tuple(str(item) for item in base_tools if str(item).strip()),
        )

    def allows_skill(self, skill_key: str) -> bool:
        if self.skill_injection == "disabled":
            return False
        if self.skill_injection == "fixed":
            return skill_key in self.allowed_skill_keys
        return not self.allowed_skill_keys or skill_key in self.allowed_skill_keys

    def allows_dynamic_skill_injection(self) -> bool:
        return self.skill_injection == "dynamic"

    def exposes_catalog_records(self) -> bool:
        return self.catalog_scope == "all"

    def exposes_dynamic_injection_contract(self) -> bool:
        return self.skill_injection == "dynamic"

    def exposes_draft_contract(self, *, has_draft_capability: bool = True) -> bool:
        if self.draft_contract == "hidden":
            return False
        if self.draft_contract == "exposed":
            return True
        return has_draft_capability


@dataclass(frozen=True, slots=True)
class OrchestratorProfile:
    key: str
    initial_skill_keys: list[str] = field(default_factory=list)
    system_prompt_addon: str = ""
    response_style: str = ""
    allowed_surface: str | None = None
    matcher: OrchestratorProfileMatcher = field(default_factory=OrchestratorProfileMatcher)
    capability_policy: OrchestratorCapabilityPolicy = field(default_factory=OrchestratorCapabilityPolicy)
    budget_config: OrchestratorBudgetConfig = field(default_factory=OrchestratorBudgetConfig)
    route_hints: tuple[OrchestratorRouteHint, ...] = ()

    @classmethod
    def from_state(cls, value: dict[str, Any]) -> "OrchestratorProfile":
        if not isinstance(value, dict):
            raise ValueError("orchestrator profile config must be a mapping")
        key = _text_from_state(value, "key")
        if not key:
            raise ValueError("orchestrator profile config must include key")
        raw_route_hints = _required_list_from_state(value, "route_hints", "routeHints", "route_hints")
        route_hints = tuple(OrchestratorRouteHint.from_state(item) for item in raw_route_hints)
        matcher_present, raw_matcher = _explicit_value(value, "matcher")
        if matcher_present and not isinstance(raw_matcher, dict):
            raise ValueError("orchestrator profile matcher must be a mapping")
        capability_present, raw_capability = _explicit_value(value, "capabilityPolicy", "capability_policy")
        if capability_present and not isinstance(raw_capability, dict):
            raise ValueError("orchestrator profile capability_policy must be a mapping")
        budget_present, raw_budget = _explicit_value(value, "budgetConfig", "budget_config")
        if budget_present and not isinstance(raw_budget, dict):
            raise ValueError("orchestrator profile budget_config must be a mapping")
        matcher = OrchestratorProfileMatcher.from_state(raw_matcher if isinstance(raw_matcher, dict) else value)
        return cls(
            key=key,
            initial_skill_keys=list(_strings_from_state(value, "initialSkillKeys", "initial_skill_keys")),
            system_prompt_addon=_text_from_state(value, "systemPromptAddon", "system_prompt_addon"),
            response_style=_text_from_state(value, "responseStyle", "response_style"),
            allowed_surface=_text_from_state(value, "allowedSurface", "allowed_surface") or None,
            matcher=matcher,
            capability_policy=OrchestratorCapabilityPolicy.from_state(raw_capability if capability_present else None),
            budget_config=OrchestratorBudgetConfig.from_state(raw_budget if budget_present else None),
            route_hints=route_hints,
        )

    def __post_init__(self) -> None:
        initial_skill_keys = list(dict.fromkeys(str(item).strip() for item in self.initial_skill_keys if str(item).strip()))
        object.__setattr__(self, "initial_skill_keys", initial_skill_keys)
        policy = self.capability_policy
        if policy.skill_injection == "disabled":
            object.__setattr__(self, "initial_skill_keys", [])
            return
        if policy.skill_injection == "fixed" and not policy.allowed_skill_keys:
            route_hint_skill_keys = [
                key
                for hint in self.route_hints
                for key in hint.initial_skill_keys
            ]
            object.__setattr__(
                self,
                "capability_policy",
                replace(policy, allowed_skill_keys=tuple(dict.fromkeys([*initial_skill_keys, *route_hint_skill_keys]))),
            )

    def to_state(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "initialSkillKeys": list(self.initial_skill_keys),
            "systemPromptAddon": self.system_prompt_addon,
            "responseStyle": self.response_style,
            "allowedSurface": self.allowed_surface,
            "capabilityPolicy": self.capability_policy.to_state(),
            "budgetConfig": self.budget_config.to_state(),
            "routeHints": [hint.to_state() for hint in self.route_hints],
        }

    def initial_skill_keys_for(self, *, quick_task: str | None, subject: dict[str, Any] | None) -> list[str]:
        value = subject or {}
        keys = list(self.initial_skill_keys)
        for hint in self.route_hints:
            if hint.matches(quick_task=quick_task, subject=value):
                keys.extend(hint.initial_skill_keys)
        return list(dict.fromkeys(keys))


@dataclass(frozen=True, slots=True)
class OrchestratorProfileRegistry:
    profiles: tuple[OrchestratorProfile, ...]
    default_profile: OrchestratorProfile

    @classmethod
    def from_state(cls, value: dict[str, Any]) -> "OrchestratorProfileRegistry":
        if not isinstance(value, dict):
            raise ValueError("orchestrator profile registry config must be a mapping")
        profiles_present, raw_profiles = _explicit_value(value, "profiles")
        if not profiles_present or not isinstance(raw_profiles, list):
            raise ValueError("orchestrator profile registry config must include profiles")
        profiles = tuple(OrchestratorProfile.from_state(item) for item in raw_profiles)
        if not profiles:
            raise ValueError("orchestrator profile registry config must include profiles")
        default_profile_key = _text_from_state(value, "defaultProfileKey", "default_profile_key")
        default_profile = profiles[0]
        if default_profile_key:
            for profile in profiles:
                if profile.key == default_profile_key:
                    default_profile = profile
                    break
            else:
                raise ValueError(f"Default orchestrator profile is not registered: {default_profile_key}")
        return cls(profiles=profiles, default_profile=default_profile)

    def __post_init__(self) -> None:
        keys = [profile.key for profile in self.profiles]
        duplicate_keys = sorted(key for key in set(keys) if keys.count(key) > 1)
        if duplicate_keys:
            raise ValueError(f"Duplicate orchestrator profile keys: {', '.join(duplicate_keys)}")
        if self.default_profile.key not in set(keys):
            raise ValueError("Default orchestrator profile must be registered")

    def resolve(self, *, quick_task: str | None, subject: dict[str, Any] | None) -> OrchestratorProfile:
        value = subject or {}
        for profile in self.profiles:
            if profile.matcher.matches(quick_task=quick_task, subject=value):
                return profile
        return self.default_profile

    def get(self, key: str) -> OrchestratorProfile:
        for profile in self.profiles:
            if profile.key == key:
                return profile
        raise KeyError(key)


MAIN_WORKSPACE_PROFILE = OrchestratorProfile(
    key="main_workspace",
    response_style="markdown_friendly",
    capability_policy=OrchestratorCapabilityPolicy(
        skill_injection="dynamic",
        allowed_skill_keys=MAIN_WORKSPACE_ALLOWED_SKILL_KEYS,
    ),
    system_prompt_addon="""
你是 Culina 主 AI 助手，服务家庭日常饮食管理工作台。

默认使用简体中文，回复要清楚、克制，适合家庭日常记录、整理和决策。普通 assistant 文本优先使用适合 Markdown 渲染的轻量结构，让前端展示更清楚：短段落、空行、- 列表、编号步骤和 **关键词**。解释做法、清单、对比、下一步或多个建议时，避免写成一整段长文本；简单确认或追问可以只用自然短句，不要硬凑 Markdown。

你的建议必须基于当前家庭上下文。信息不足时先说明缺口，必要时读取上下文或询问用户，不要编造库存、计划、食材、菜谱、购物清单或家庭成员信息。

你是实用的家庭饮食助手，不做医疗诊断、营养诊断或治疗承诺。涉及健康、食品安全或营养风险时，保持保守、具体，并建议用户结合实际情况判断。
""".strip(),
)

DEFAULT_ORCHESTRATOR_PROFILE = MAIN_WORKSPACE_PROFILE

COOKING_ASSISTANT_PROFILE = OrchestratorProfile(
    key="recipe_cook_page",
    initial_skill_keys=["cooking_assistant"],
    allowed_surface="recipe_cook_page",
    response_style="short_spoken",
    capability_policy=OrchestratorCapabilityPolicy(
        skill_injection="fixed",
        catalog_scope="initial_only",
        draft_contract="hidden",
        artifact_context="without_drafts",
        allowed_skill_keys=("cooking_assistant",),
        base_tools=("human.request_input",),
    ),
    budget_config=OrchestratorBudgetConfig(max_business_skills_per_run=0),
    matcher=OrchestratorProfileMatcher(
        quick_tasks=("cooking_assistant",),
        subject_sources=("recipe_cook_page",),
        surfaces=("recipe_cook_page",),
        route_hints=("cooking_assistant", "recipe_cook_page"),
    ),
    system_prompt_addon="""
你叫“小灶”，是 Culina 做菜页面里的个人小助手，不是通用 AI 工作台。

用户正在做饭，手上可能不方便，也不想看长说明。你的回复要像厨房里站在旁边提醒：短、自然、直接、好懂。

优先围绕当前菜谱、当前步骤、食材准备、缺料和计时器回答。用户说“这一步”“现在”“这个计时器”“下一步”时，先结合页面现场理解，不要要求用户重复描述。

先判断用户是在寒暄、问你能做什么、问做菜问题，还是要求操作页面。用户只是说“你好”“在吗”“小灶”这类寒暄时，短句自然回应就好，不要主动讲当前步骤、食材或计时。比如：“在呢，我是小灶。要我帮你看步骤、食材，还是计时？”

用户问“你能干嘛”这类能力问题时，简单说清楚：你能帮看步骤、食材替换、缺料、计时，也能帮切步骤和设计时。不要展开当前步骤。

不要因为页面给了当前步骤快照，就把每次回复都写成厨房建议。只有用户的问题需要做菜现场时，才使用当前步骤、食材、缺料和计时器。

默认不要使用 Markdown 格式。不要写标题、粗体、代码块、表格、JSON、XML 或系统字段名。除非确实更清楚，否则不要用列表；如果必须分点，最多 3 点，每点一句短话。

用户要求操作页面时，必须调用 ui.propose_actions 返回页面动作建议，比如下一步、上一步、切到食材、开始计时、暂停计时、设置计时。不要只用文字回答“好的”。

调用页面动作前，要先输出一句自然话告诉用户你准备做什么，并让用户稍等，比如“好的，我来帮你设一个 3 分钟倒计时，请稍等。”然后再调用 ui.propose_actions。不要只沉默调用工具。

ui.propose_actions 的参数只放结构化页面动作，不要放任何给用户看的话术字段。用户可见语言都由你在工具调用前后的普通 assistant 文本里输出。

工具调用完成后，你会继续回到 agent loop。要根据工具结果再输出一句自然、具体的结果说明，比如“好了，5 分钟倒计时已经开始了。”或“这个操作需要你先确认一下。”不要说“任务已完成”。

如果用户要做你不能直接完成的事，要说清楚原因和下一步去哪操作。不要说 recipe_cook、draft、approval、tool、sessionRevision 这类内部词。比如：
“这个我不能直接替你扣库存。你可以点页面底部的完成烹饪，确认后系统会按这次做菜扣减库存。”
“我不能直接记录餐食。完成烹饪时勾选记录餐食，就会一起保存。”
“我不能直接改菜谱。你可以回到菜谱详情页编辑；如果想让我帮你整理改法，也可以去系统 AI 助手里说。”

如果用户的问题已经超出做菜现场，比如想重新生成菜谱、整理一周菜单、批量加入购物清单、分析库存、修改食材资料，要说明这里主要陪你做完这道菜；这些更适合去系统 AI 助手继续处理。

遇到食品安全问题要保守提醒。明显变质、异味、夹生、肉蛋海鲜未熟时，不要鼓励继续吃；信息不够时问一个很短的问题。
""".strip(),
    )


ORCHESTRATOR_PROFILES = (
    COOKING_ASSISTANT_PROFILE,
    MAIN_WORKSPACE_PROFILE,
)

ORCHESTRATOR_PROFILE_REGISTRY = OrchestratorProfileRegistry(
    profiles=ORCHESTRATOR_PROFILES,
    default_profile=DEFAULT_ORCHESTRATOR_PROFILE,
)


def profile_with_skill_route_hints(profile: OrchestratorProfile, skill_registry: Any) -> OrchestratorProfile:
    if not profile.capability_policy.allows_dynamic_skill_injection():
        return profile
    conflicts = _skill_route_hint_conflicts(profile, skill_registry)
    if conflicts:
        raise ValueError(
            f"Profile {profile.key} has ambiguous skill route hints: "
            + "; ".join(
                f"{route_hint} -> {', '.join(skill_keys)}"
                for route_hint, skill_keys in conflicts.items()
            )
        )
    dynamic_hints: list[OrchestratorRouteHint] = []
    for manifest in skill_registry.list_manifests():
        skill_key = str(getattr(manifest, "key", "") or "").strip()
        if not skill_key or not profile.capability_policy.allows_skill(skill_key):
            continue
        route_hints = tuple(
            dict.fromkeys(
                str(item).strip()
                for item in getattr(manifest, "route_hints", [])
                if str(item).strip()
            )
        )
        missing_hints = tuple(
            hint
            for hint in route_hints
            if not _profile_has_route_hint(profile, skill_key=skill_key, route_hint=hint)
        )
        if missing_hints:
            dynamic_hints.append(
                OrchestratorRouteHint(
                    initial_skill_keys=(skill_key,),
                    quick_tasks=missing_hints,
                    route_hints=missing_hints,
                )
            )
    if not dynamic_hints:
        return profile
    return replace(profile, route_hints=profile.route_hints + tuple(dynamic_hints))


def _profile_has_route_hint(profile: OrchestratorProfile, *, skill_key: str, route_hint: str) -> bool:
    return any(
        skill_key in hint.initial_skill_keys
        and (route_hint in hint.quick_tasks or route_hint in hint.route_hints)
        for hint in profile.route_hints
    )


def validate_orchestrator_profile_registry(
    profile_registry: OrchestratorProfileRegistry,
    skill_registry: Any,
) -> None:
    skill_keys = set(skill_registry.keys())
    errors: list[str] = []
    for profile in profile_registry.profiles:
        policy = profile.capability_policy
        unknown_allowed = sorted(key for key in policy.allowed_skill_keys if key not in skill_keys)
        if unknown_allowed:
            errors.append(
                f"profile {profile.key} allows unknown skills: {', '.join(unknown_allowed)}"
            )
        referenced_skill_keys = list(profile.initial_skill_keys)
        for hint in profile.route_hints:
            referenced_skill_keys.extend(hint.initial_skill_keys)
        for skill_key in dict.fromkeys(referenced_skill_keys):
            if skill_key not in skill_keys:
                errors.append(f"profile {profile.key} references unknown skill: {skill_key}")
                continue
            if not policy.allows_skill(skill_key):
                errors.append(f"profile {profile.key} references skill outside capability policy: {skill_key}")
        if policy.skill_injection == "disabled" and referenced_skill_keys:
            errors.append(f"profile {profile.key} is disabled but references business skills")
        route_hint_conflicts = _skill_route_hint_conflicts(profile, skill_registry)
        for route_hint, conflicting_skill_keys in route_hint_conflicts.items():
            errors.append(
                f"profile {profile.key} has ambiguous skill route hint {route_hint}: "
                f"{', '.join(conflicting_skill_keys)}"
            )
    if errors:
        raise ValueError("Invalid orchestrator profile registry: " + "; ".join(errors))


def _skill_route_hint_conflicts(profile: OrchestratorProfile, skill_registry: Any) -> dict[str, list[str]]:
    if not profile.capability_policy.allows_dynamic_skill_injection():
        return {}
    route_hint_to_skill_keys: dict[str, list[str]] = {}
    for manifest in skill_registry.list_manifests():
        skill_key = str(getattr(manifest, "key", "") or "").strip()
        if not skill_key or not profile.capability_policy.allows_skill(skill_key):
            continue
        for route_hint in dict.fromkeys(
            str(item).strip()
            for item in getattr(manifest, "route_hints", [])
            if str(item).strip()
        ):
            route_hint_to_skill_keys.setdefault(route_hint, []).append(skill_key)
    return {
        route_hint: skill_keys
        for route_hint, skill_keys in route_hint_to_skill_keys.items()
        if len(skill_keys) > 1
    }
