from ._support import *
from app.ai.workflows.orchestrator.profiles import (
    COOKING_ASSISTANT_PROFILE,
    DEFAULT_ORCHESTRATOR_PROFILE,
    DEFAULT_MAX_BUSINESS_SKILLS_PER_RUN,
    DEFAULT_MAX_SAME_READ_TOOL_CALLS_PER_RUN,
    DEFAULT_MAX_TOTAL_TOOL_CALLS_PER_RUN,
    MAIN_WORKSPACE_ALLOWED_SKILL_KEYS,
    MAIN_WORKSPACE_PROFILE,
    ORCHESTRATOR_PROFILE_REGISTRY,
    OrchestratorBudgetConfig,
    OrchestratorCapabilityPolicy,
    OrchestratorProfile,
    OrchestratorProfileRegistry,
    OrchestratorRouteHint,
    profile_with_skill_route_hints,
    validate_orchestrator_profile_registry,
)
from app.ai.workflows.orchestrator.payloads import OrchestratorPromptPayloadBuilder
from app.ai.workflows.orchestrator.tools import SkillInjectionManager
from app.ai.skills import CatalogSkill, SkillManifest, SkillRegistry, build_workspace_skill_registry


class OrchestratorProfileTestCase(AIAgentInfraTestCase):
        def test_resolves_cooking_assistant_profile_from_quick_task_and_subject(self) -> None:
            self.assertEqual(
                ORCHESTRATOR_PROFILE_REGISTRY.resolve(quick_task="cooking_assistant", subject={}).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                ORCHESTRATOR_PROFILE_REGISTRY.resolve(quick_task=None, subject={"source": "recipe_cook_page"}).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                ORCHESTRATOR_PROFILE_REGISTRY.resolve(
                    quick_task=None,
                    subject={"extra": {"surface": "recipe_cook_page"}},
                ).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                ORCHESTRATOR_PROFILE_REGISTRY.resolve(quick_task=None, subject={"source": "ai_workspace"}).key,
                DEFAULT_ORCHESTRATOR_PROFILE.key,
            )

        def test_default_profile_is_main_workspace_assistant(self) -> None:
            profile = ORCHESTRATOR_PROFILE_REGISTRY.resolve(quick_task=None, subject={})
            self.assertEqual(profile.key, MAIN_WORKSPACE_PROFILE.key)
            self.assertIs(DEFAULT_ORCHESTRATOR_PROFILE, MAIN_WORKSPACE_PROFILE)
            self.assertIs(ORCHESTRATOR_PROFILE_REGISTRY.get("main_workspace"), MAIN_WORKSPACE_PROFILE)
            self.assertIn("Culina 的主 AI 助手", profile.system_prompt_addon)
            self.assertIn("Markdown", profile.system_prompt_addon)
            self.assertEqual(profile.capability_policy.skill_injection, "dynamic")
            self.assertEqual(profile.capability_policy.allowed_skill_keys, MAIN_WORKSPACE_ALLOWED_SKILL_KEYS)
            self.assertFalse(profile.capability_policy.allows_skill("cooking_assistant"))
            self.assertTrue(profile.capability_policy.allows_skill("recipe_cook"))
            self.assertIn("skill.inject", profile.capability_policy.base_tools)
            self.assertEqual(profile.budget_config.max_business_skills_per_run, DEFAULT_MAX_BUSINESS_SKILLS_PER_RUN)
            self.assertEqual(profile.budget_config.max_total_tool_calls_per_run, DEFAULT_MAX_TOTAL_TOOL_CALLS_PER_RUN)
            self.assertEqual(profile.budget_config.max_same_read_tool_calls_per_run, DEFAULT_MAX_SAME_READ_TOOL_CALLS_PER_RUN)

        def test_main_profile_uses_catalog_route_hints_for_initial_skills(self) -> None:
            profile = ORCHESTRATOR_PROFILE_REGISTRY.resolve(quick_task="today_recommendation", subject={})
            self.assertEqual(profile.key, MAIN_WORKSPACE_PROFILE.key)
            self.assertEqual(
                MAIN_WORKSPACE_PROFILE.initial_skill_keys_for(quick_task="today_recommendation", subject={}),
                [],
            )
            profile = profile_with_skill_route_hints(profile, build_workspace_skill_registry())
            expected_route_hints = {
                "meal_plan": "meal_plan",
                "meal_planning": "meal_plan",
                "today_recommendation": "meal_plan",
                "recipe": "recipe_draft",
                "recipe_draft": "recipe_draft",
                "recipe_cook": "recipe_cook",
                "cook_recipe": "recipe_cook",
                "shopping": "shopping_list",
                "shopping_list": "shopping_list",
                "inventory": "inventory_analysis",
                "inventory_analysis": "inventory_analysis",
                "inventory_summary": "inventory_analysis",
                "inventory_operation": "inventory_analysis",
                "food": "food_profile",
                "food_profile": "food_profile",
                "ingredient": "ingredient_profile",
                "ingredient_profile": "ingredient_profile",
                "meal_log": "meal_log",
                "meal_record": "meal_log",
            }
            for route_hint, skill_key in expected_route_hints.items():
                with self.subTest(route_hint=route_hint):
                    self.assertEqual(
                        profile.initial_skill_keys_for(quick_task=route_hint, subject={}),
                        [skill_key],
                    )
                    self.assertEqual(
                        profile.initial_skill_keys_for(quick_task=None, subject={"extra": {"routeHint": route_hint}}),
                        [skill_key],
                    )
            self.assertEqual(
                profile.initial_skill_keys_for(quick_task=None, subject={}),
                [],
            )

        def test_main_profile_can_extend_route_hints_from_skill_catalog(self) -> None:
            registry = SkillRegistry()
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="custom_skill",
                        name="自定义能力",
                        description="用于测试动态 route hints。",
                        route_hints=["custom_quick_task", "custom_surface_hint"],
                    )
                )
            )

            profile = OrchestratorProfile(
                key="custom_workspace",
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="dynamic",
                    allowed_skill_keys=("custom_skill",),
                ),
            )
            profile = profile_with_skill_route_hints(profile, registry)

            self.assertEqual(
                profile.initial_skill_keys_for(quick_task="custom_quick_task", subject={}),
                ["custom_skill"],
            )
            self.assertEqual(
                profile.initial_skill_keys_for(quick_task=None, subject={"extra": {"routeHint": "custom_surface_hint"}}),
                ["custom_skill"],
            )

        def test_dynamic_profile_rejects_ambiguous_catalog_route_hints(self) -> None:
            registry = SkillRegistry()
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="first_skill",
                        name="第一能力",
                        description="用于测试 route hint 冲突。",
                        route_hints=["shared_hint"],
                    )
                )
            )
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="second_skill",
                        name="第二能力",
                        description="用于测试 route hint 冲突。",
                        route_hints=["shared_hint"],
                    )
                )
            )

            with self.assertRaisesRegex(ValueError, "ambiguous skill route hint shared_hint"):
                validate_orchestrator_profile_registry(
                    OrchestratorProfileRegistry(
                        profiles=(OrchestratorProfile(key="unrestricted_dynamic"),),
                        default_profile=OrchestratorProfile(key="unrestricted_dynamic"),
                    ),
                    registry,
                )
            with self.assertRaisesRegex(ValueError, "ambiguous skill route hints"):
                profile_with_skill_route_hints(OrchestratorProfile(key="unrestricted_dynamic"), registry)

        def test_dynamic_profile_route_hint_conflicts_respect_allowed_skill_keys(self) -> None:
            registry = SkillRegistry()
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="first_skill",
                        name="第一能力",
                        description="用于测试允许能力范围。",
                        route_hints=["shared_hint"],
                    )
                )
            )
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="second_skill",
                        name="第二能力",
                        description="用于测试允许能力范围。",
                        route_hints=["shared_hint"],
                    )
                )
            )
            profile = OrchestratorProfile(
                key="restricted_dynamic",
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="dynamic",
                    allowed_skill_keys=("first_skill",),
                ),
            )

            validate_orchestrator_profile_registry(
                OrchestratorProfileRegistry(profiles=(profile,), default_profile=profile),
                registry,
            )
            profile = profile_with_skill_route_hints(profile, registry)

            self.assertEqual(
                profile.initial_skill_keys_for(quick_task="shared_hint", subject={}),
                ["first_skill"],
            )

        def test_fixed_profile_ignores_catalog_route_hints(self) -> None:
            registry = SkillRegistry()
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="custom_skill",
                        name="自定义能力",
                        description="用于测试固定 profile 不动态扩展 route hints。",
                        route_hints=["custom_quick_task"],
                    )
                )
            )

            profile = profile_with_skill_route_hints(COOKING_ASSISTANT_PROFILE, registry)

            self.assertIs(profile, COOKING_ASSISTANT_PROFILE)
            self.assertEqual(
                profile.initial_skill_keys_for(quick_task="custom_quick_task", subject={"source": "recipe_cook_page"}),
                ["cooking_assistant"],
            )

        def test_cooking_profile_uses_fixed_capability_surface(self) -> None:
            policy = COOKING_ASSISTANT_PROFILE.capability_policy
            self.assertEqual(policy.skill_injection, "fixed")
            self.assertEqual(policy.catalog_scope, "initial_only")
            self.assertEqual(policy.draft_contract, "hidden")
            self.assertEqual(policy.artifact_context, "without_drafts")
            self.assertFalse(policy.exposes_draft_contract(has_draft_capability=True))
            self.assertFalse(policy.exposes_draft_contract(has_draft_capability=False))
            self.assertEqual(policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertEqual(policy.to_state()["allowedSkillKeys"], ["cooking_assistant"])
            self.assertEqual(policy.to_state()["artifactContext"], "without_drafts")
            self.assertEqual(policy.base_tools, ())
            self.assertEqual(policy.to_state()["baseTools"], [])
            self.assertNotIn("skill.inject", policy.base_tools)
            self.assertEqual(COOKING_ASSISTANT_PROFILE.budget_config.max_business_skills_per_run, 0)
            self.assertEqual(
                COOKING_ASSISTANT_PROFILE.initial_skill_keys_for(
                    quick_task="cooking_assistant",
                    subject={"source": "recipe_cook_page"},
                ),
                ["cooking_assistant"],
            )

        def test_profile_config_accepts_snake_case_input_but_outputs_stable_state(self) -> None:
            policy = OrchestratorCapabilityPolicy.from_state(
                {
                    "skill_injection": "fixed",
                    "catalog_scope": "initial_only",
                    "draft_contract": "hidden",
                    "artifact_context": "without_drafts",
                    "allowed_skill_keys": ["cooking_assistant", "", "cooking_assistant"],
                    "base_tools": ["human.request_input", ""],
                }
            )
            self.assertEqual(policy.skill_injection, "fixed")
            self.assertEqual(policy.catalog_scope, "initial_only")
            self.assertEqual(policy.draft_contract, "hidden")
            self.assertEqual(policy.artifact_context, "without_drafts")
            self.assertEqual(policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertEqual(policy.base_tools, ("human.request_input",))
            self.assertEqual(
                policy.to_state(),
                {
                    "skillInjection": "fixed",
                    "catalogScope": "initial_only",
                    "draftContract": "hidden",
                    "artifactContext": "without_drafts",
                    "allowedSkillKeys": ["cooking_assistant"],
                    "baseTools": ["human.request_input"],
                },
            )

            budget = OrchestratorBudgetConfig.from_state(
                {
                    "max_business_skills_per_run": 2,
                    "max_total_tool_calls_per_run": 9,
                    "max_same_read_tool_calls_per_run": 1,
                }
            )
            self.assertEqual(
                budget.to_state(),
                {
                    "maxBusinessSkillsPerRun": 2,
                    "maxTotalToolCallsPerRun": 9,
                    "maxSameReadToolCallsPerRun": 1,
                },
            )

        def test_profile_registry_can_be_built_from_external_config_shape(self) -> None:
            registry = OrchestratorProfileRegistry.from_state(
                {
                    "default_profile_key": "main_workspace",
                    "profiles": [
                        {
                            "key": "recipe_cook_page",
                            "initial_skill_keys": ["cooking_assistant", "cooking_assistant", ""],
                            "allowed_surface": "recipe_cook_page",
                            "response_style": "short_spoken",
                            "system_prompt_addon": "外置小灶 profile。",
                            "matcher": {
                                "quick_tasks": ["cooking_assistant"],
                                "subject_sources": ["recipe_cook_page"],
                                "surfaces": ["recipe_cook_page"],
                                "route_hints": ["recipe_cook_page"],
                            },
                            "capability_policy": {
                                "skill_injection": "fixed",
                                "catalog_scope": "initial_only",
                                "draft_contract": "hidden",
                                "artifact_context": "without_drafts",
                                "base_tools": ["human.request_input"],
                            },
                            "budget_config": {
                                "max_business_skills_per_run": 2,
                                "max_total_tool_calls_per_run": 9,
                                "max_same_read_tool_calls_per_run": 1,
                            },
                            "route_hints": [
                                {
                                    "initial_skill_keys": ["cooking_assistant"],
                                    "quick_tasks": ["cook_now"],
                                    "route_hints": ["cook_now"],
                                }
                            ],
                        },
                        {
                            "key": "main_workspace",
                            "responseStyle": "markdown_friendly",
                            "systemPromptAddon": "外置主助手 profile。",
                            "capabilityPolicy": {
                                "skillInjection": "dynamic",
                                "allowedSkillKeys": ["meal_plan", "recipe_draft"],
                            },
                            "budgetConfig": {
                                "maxBusinessSkillsPerRun": 3,
                                "maxTotalToolCallsPerRun": 21,
                            },
                        },
                    ],
                }
            )

            self.assertEqual(registry.default_profile.key, "main_workspace")
            cooking_profile = registry.resolve(
                quick_task="cooking_assistant",
                subject={"extra": {"surface": "recipe_cook_page"}},
            )
            self.assertEqual(cooking_profile.key, "recipe_cook_page")
            self.assertEqual(cooking_profile.initial_skill_keys, ["cooking_assistant"])
            self.assertEqual(cooking_profile.capability_policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertEqual(cooking_profile.budget_config.max_business_skills_per_run, 2)
            self.assertEqual(
                cooking_profile.initial_skill_keys_for(quick_task="cook_now", subject={}),
                ["cooking_assistant"],
            )
            main_profile = registry.get("main_workspace")
            self.assertEqual(main_profile.response_style, "markdown_friendly")
            self.assertEqual(main_profile.capability_policy.allowed_skill_keys, ("meal_plan", "recipe_draft"))
            self.assertEqual(main_profile.budget_config.max_total_tool_calls_per_run, 21)

        def test_profile_from_state_supports_top_level_matcher_fields(self) -> None:
            profile = OrchestratorProfile.from_state(
                {
                    "key": "inventory_page",
                    "quickTasks": ["inventory_summary"],
                    "subjectSources": ["inventory_page"],
                    "surfaces": ["inventory_page"],
                    "routeHints": [
                        {
                            "initialSkillKeys": ["inventory_analysis"],
                            "routeHints": ["inventory_summary"],
                        }
                    ],
                    "capabilityPolicy": {
                        "skillInjection": "dynamic",
                        "allowedSkillKeys": ["inventory_analysis"],
                    },
                }
            )

            self.assertEqual(profile.matcher.quick_tasks, ("inventory_summary",))
            self.assertTrue(profile.matcher.matches(quick_task=None, subject={"source": "inventory_page"}))
            self.assertEqual(
                profile.initial_skill_keys_for(
                    quick_task=None,
                    subject={"extra": {"routeHint": "inventory_summary"}},
                ),
                ["inventory_analysis"],
            )

        def test_profile_registry_from_state_rejects_missing_default_profile(self) -> None:
            with self.assertRaisesRegex(ValueError, "Default orchestrator profile is not registered"):
                OrchestratorProfileRegistry.from_state(
                    {
                        "defaultProfileKey": "missing",
                        "profiles": [
                            {
                                "key": "main_workspace",
                            }
                        ],
                    }
                )

        def test_profile_registry_from_state_rejects_invalid_external_config_shape(self) -> None:
            invalid_registry_shapes = [
                ({"profiles": "main_workspace"}, "orchestrator profile registry config must include profiles"),
                ({"profiles": [None]}, "orchestrator profile config must be a mapping"),
                (
                    {"profiles": [{"key": "main_workspace", "route_hints": "meal_plan"}]},
                    "route_hints must be a list",
                ),
                (
                    {"profiles": [{"key": "main_workspace", "route_hints": [None]}]},
                    "orchestrator route hint config must be a mapping",
                ),
                (
                    {"profiles": [{"key": "main_workspace", "matcher": "workspace"}]},
                    "orchestrator profile matcher must be a mapping",
                ),
                (
                    {"profiles": [{"key": "main_workspace", "capability_policy": "dynamic"}]},
                    "orchestrator profile capability_policy must be a mapping",
                ),
                (
                    {"profiles": [{"key": "main_workspace", "budget_config": 3}]},
                    "orchestrator profile budget_config must be a mapping",
                ),
            ]

            for payload, message in invalid_registry_shapes:
                with self.subTest(message=message):
                    with self.assertRaisesRegex(ValueError, message):
                        OrchestratorProfileRegistry.from_state(payload)

        def test_disabled_profile_policy_removes_skill_injection_surface(self) -> None:
            policy = OrchestratorCapabilityPolicy.from_state(
                {
                    "skill_injection": "disabled",
                    "catalog_scope": "hidden",
                    "draft_contract": "hidden",
                    "artifact_context": "hidden",
                }
            )

            self.assertEqual(policy.skill_injection, "disabled")
            self.assertEqual(policy.base_tools, ("human.request_input",))
            self.assertFalse(policy.allows_dynamic_skill_injection())
            self.assertFalse(policy.exposes_dynamic_injection_contract())
            self.assertFalse(policy.allows_skill("meal_plan"))
            self.assertFalse(policy.allows_skill("cooking_assistant"))
            self.assertEqual(
                OrchestratorBudgetConfig(max_business_skills_per_run=3).for_capability_policy(policy).max_business_skills_per_run,
                0,
            )

        def test_fixed_profile_defaults_allowed_skills_to_initial_skills(self) -> None:
            profile = OrchestratorProfile(
                key="recipe_page_helper",
                initial_skill_keys=["cooking_assistant", "cooking_assistant", ""],
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="fixed",
                    catalog_scope="initial_only",
                    draft_contract="hidden",
                    artifact_context="without_drafts",
                    base_tools=("human.request_input",),
                ),
            )

            self.assertEqual(profile.initial_skill_keys, ["cooking_assistant"])
            self.assertEqual(profile.capability_policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertTrue(profile.capability_policy.allows_skill("cooking_assistant"))
            self.assertFalse(profile.capability_policy.allows_skill("meal_plan"))

        def test_fixed_profile_defaults_allowed_skills_to_route_hint_skills(self) -> None:
            profile = OrchestratorProfile(
                key="recipe_page_helper",
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="fixed",
                    catalog_scope="initial_only",
                    draft_contract="hidden",
                    artifact_context="without_drafts",
                    base_tools=("human.request_input",),
                ),
                route_hints=(
                    OrchestratorRouteHint(
                        initial_skill_keys=("cooking_assistant",),
                        quick_tasks=("cooking_assistant",),
                    ),
                ),
            )

            self.assertEqual(profile.capability_policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertEqual(
                profile.initial_skill_keys_for(quick_task="cooking_assistant", subject={}),
                ["cooking_assistant"],
            )

        def test_disabled_profile_drops_configured_initial_skills(self) -> None:
            profile = OrchestratorProfile(
                key="plain_explainer",
                initial_skill_keys=["meal_plan"],
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="disabled",
                    catalog_scope="hidden",
                    draft_contract="hidden",
                    artifact_context="hidden",
                ),
            )

            self.assertEqual(profile.initial_skill_keys, [])
            self.assertFalse(profile.capability_policy.allows_skill("meal_plan"))

        def test_profile_registry_validation_rejects_unknown_and_disallowed_skills(self) -> None:
            registry = SkillRegistry()
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="cooking_assistant",
                        name="小灶",
                        description="测试做菜助手。",
                    )
                )
            )
            registry.register(
                CatalogSkill(
                    SkillManifest(
                        key="other_skill",
                        name="其他能力",
                        description="测试未授权能力。",
                    )
                )
            )
            valid_profile = OrchestratorProfile(
                key="recipe_page_helper",
                initial_skill_keys=["cooking_assistant"],
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="fixed",
                    catalog_scope="initial_only",
                    draft_contract="hidden",
                    artifact_context="without_drafts",
                    base_tools=("human.request_input",),
                ),
            )
            validate_orchestrator_profile_registry(
                OrchestratorProfileRegistry(profiles=(valid_profile,), default_profile=valid_profile),
                registry,
            )

            unknown_profile = OrchestratorProfile(
                key="unknown_skill_profile",
                initial_skill_keys=["missing_skill"],
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="fixed",
                    catalog_scope="initial_only",
                    draft_contract="hidden",
                    artifact_context="without_drafts",
                    base_tools=("human.request_input",),
                ),
            )
            with self.assertRaisesRegex(ValueError, "unknown skill"):
                validate_orchestrator_profile_registry(
                    OrchestratorProfileRegistry(profiles=(unknown_profile,), default_profile=unknown_profile),
                    registry,
                )

            disallowed_profile = OrchestratorProfile(
                key="disallowed_skill_profile",
                initial_skill_keys=["cooking_assistant"],
                capability_policy=OrchestratorCapabilityPolicy(
                    skill_injection="fixed",
                    catalog_scope="initial_only",
                    draft_contract="hidden",
                    artifact_context="without_drafts",
                    allowed_skill_keys=("other_skill",),
                    base_tools=("human.request_input",),
                ),
            )
            with self.assertRaisesRegex(ValueError, "outside capability policy"):
                validate_orchestrator_profile_registry(
                    OrchestratorProfileRegistry(profiles=(disallowed_profile,), default_profile=disallowed_profile),
                    registry,
                )

        def test_base_tools_must_be_control_tools(self) -> None:
            policy = OrchestratorCapabilityPolicy.from_state(
                {
                    "skill_injection": "dynamic",
                    "base_tools": ["human.request_input", "inventory.read_summary"],
                }
            )
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-invalid-base-tool",
                run_id="run-invalid-base-tool",
                conversation=[],
                current_message="库存怎么样",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-invalid-base-tool",
                        run_id="run-invalid-base-tool",
                    ),
                ),
            )

            with self.assertRaisesRegex(ValueError, "base tools must be control tools"):
                SkillInjectionManager(build_workspace_skill_registry()).tool_definitions(
                    [],
                    context,
                    policy,
                )

        def test_payload_builder_accepts_snake_case_profile_state(self) -> None:
            builder = OrchestratorPromptPayloadBuilder(
                SkillInjectionManager(build_workspace_skill_registry())
            )
            profile_state = {
                "key": "external_cooking_profile",
                "response_style": "short_spoken",
                "system_prompt_addon": "外部做菜助手 profile。",
                "capability_policy": {
                    "skill_injection": "fixed",
                    "catalog_scope": "initial_only",
                    "draft_contract": "hidden",
                    "artifact_context": "without_drafts",
                    "allowed_skill_keys": ["cooking_assistant"],
                    "base_tools": ["human.request_input"],
                },
                "budget_config": {
                    "max_business_skills_per_run": 3,
                    "max_total_tool_calls_per_run": 7,
                    "max_same_read_tool_calls_per_run": 1,
                },
            }

            policy = builder.capability_policy(profile_state)
            budget = builder.budget_config(profile_state, policy)

            self.assertEqual(policy.skill_injection, "fixed")
            self.assertEqual(policy.artifact_context, "without_drafts")
            self.assertEqual(policy.allowed_skill_keys, ("cooking_assistant",))
            self.assertEqual(budget.max_business_skills_per_run, 0)
            self.assertEqual(budget.max_total_tool_calls_per_run, 7)
            self.assertEqual(budget.max_same_read_tool_calls_per_run, 1)

            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-external-profile",
                run_id="run-external-profile",
                conversation=[],
                current_message="下一步",
                orchestrator_profile=profile_state,
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-external-profile",
                        run_id="run-external-profile",
                    ),
                ),
            )
            prompt = builder.system_prompt(context, ["cooking_assistant"])
            metadata = prompt_contract_metadata(prompt)
            self.assertEqual(metadata["profileKey"], "external_cooking_profile")
            self.assertEqual(metadata["responseStyle"], "short_spoken")
            self.assertEqual(metadata["capabilityPolicy"]["skillInjection"], "fixed")
            self.assertEqual(metadata["capabilityPolicy"]["artifactContext"], "without_drafts")
            self.assertIn("外部做菜助手 profile。", prompt)

        def test_dynamic_profile_catalog_records_respect_allowed_skill_keys(self) -> None:
            builder = OrchestratorPromptPayloadBuilder(
                SkillInjectionManager(build_workspace_skill_registry())
            )
            profile_state = MAIN_WORKSPACE_PROFILE.to_state()
            profile_state["key"] = "restricted_workspace"
            profile_state["capabilityPolicy"] = {
                **profile_state["capabilityPolicy"],
                "allowedSkillKeys": ["meal_plan"],
            }
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-restricted-profile",
                run_id="run-restricted-profile",
                conversation=[],
                current_message="今晚吃什么？",
                orchestrator_profile=profile_state,
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-restricted-profile",
                        run_id="run-restricted-profile",
                    ),
                ),
            )

            prompt = builder.system_prompt(context, [])
            metadata = prompt_contract_metadata(prompt)

            self.assertEqual(metadata["profileKey"], "restricted_workspace")
            self.assertEqual(metadata["catalogRecordKeys"], ["meal_plan"])
            self.assertIn('"key": "meal_plan"', prompt)
            self.assertNotIn('"key": "recipe_draft"', prompt)
            self.assertNotIn('"key": "cooking_assistant"', prompt)

        def test_disabled_profile_does_not_preinject_business_skills(self) -> None:
            class DisabledProfileProvider(BaseChatProvider):
                model_name = "disabled-profile-model"

                def __init__(self) -> None:
                    self.system = ""
                    self.user_payload: dict[str, Any] = {}
                    self.tool_names: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del tool_handler, max_rounds
                    self.system = system
                    self.user_payload = json.loads(user)
                    self.tool_names = sorted(tool.name for tool in tools())
                    text = "这里只能做普通解释，不能调用业务能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            profile_state = {
                "key": "plain_explainer",
                "responseStyle": "plain",
                "systemPromptAddon": "只回答当前页面说明，不读取或写入家庭业务数据。",
                "capabilityPolicy": {
                    "skillInjection": "disabled",
                    "catalogScope": "hidden",
                    "draftContract": "hidden",
                    "artifactContext": "hidden",
                },
            }
            provider = DisabledProfileProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-disabled-profile",
                run_id="run-disabled-profile",
                conversation=[],
                current_message="解释一下这个页面。",
                orchestrator_profile=profile_state,
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-disabled-profile",
                        run_id="run-disabled-profile",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context, injected_skill_keys=["meal_plan", "cooking_assistant"])

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], [])
            self.assertEqual(provider.user_payload["injectedSkills"], [])
            self.assertEqual(provider.tool_names, ["human.request_input"])
            self.assertNotIn("skill.inject", provider.tool_names)
            self.assertNotIn("meal_plan.create_draft", provider.tool_names)
            metadata = prompt_contract_metadata(provider.system)
            self.assertEqual(metadata["profileKey"], "plain_explainer")
            self.assertEqual(metadata["capabilityPolicy"]["skillInjection"], "disabled")
            self.assertFalse(metadata["includeCatalogRecords"])
            self.assertFalse(metadata["includeDynamicInjectionContract"])
            self.assertFalse(metadata["includeDraftContract"])
            self.assertEqual(metadata["catalogRecordKeys"], [])
            self.assertEqual(metadata["injectedSkillKeys"], [])
            self.assertEqual(metadata["artifactContextPolicy"], "hidden")
            self.assertNotIn("Catalog records:", provider.system)
            self.assertNotIn("skill.inject", provider.system)
            self.assertNotIn("allowedDraftTypes", provider.user_payload)

        def test_profile_registry_rejects_duplicate_profile_keys(self) -> None:
            with self.assertRaises(ValueError):
                OrchestratorProfileRegistry(
                    profiles=(MAIN_WORKSPACE_PROFILE, MAIN_WORKSPACE_PROFILE),
                    default_profile=MAIN_WORKSPACE_PROFILE,
                )

        def test_main_profile_auto_draft_contract_requires_active_draft_capability(self) -> None:
            policy = MAIN_WORKSPACE_PROFILE.capability_policy

            self.assertEqual(policy.draft_contract, "auto")
            self.assertFalse(policy.exposes_draft_contract(has_draft_capability=False))
            self.assertTrue(policy.exposes_draft_contract(has_draft_capability=True))

        def test_cooking_profile_preinjects_skill_and_adds_surface_prompt(self) -> None:
            class CapturingProvider(BaseChatProvider):
                model_name = "profile-test-model"

                def __init__(self) -> None:
                    self.system = ""
                    self.user_payload: dict[str, Any] = {}
                    self.tool_names: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del tool_handler, max_rounds
                    self.system = system
                    self.user_payload = json.loads(user)
                    tool_list = tools() if callable(tools) else tools
                    self.tool_names = sorted(tool.name for tool in tool_list)
                    text = "这一步先把鸡蛋炒到刚凝固就盛出。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = CapturingProvider()
            profile = COOKING_ASSISTANT_PROFILE
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-cooking-profile",
                run_id="run-cooking-profile",
                conversation=[
                    {
                        "id": "message-1",
                        "role": "user",
                        "content": "这一步做到什么程度？",
                        "artifacts": [],
                    }
                ],
                current_message="这一步做到什么程度？",
                subject={
                    "source": "recipe_cook_page",
                    "recipe_id": "recipe-tomato",
                    "extra": {"surface": "recipe_cook_page", "currentStepIndex": 1},
                },
                orchestrator_profile=profile.to_state(),
                quick_task="cooking_assistant",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-cooking-profile",
                        run_id="run-cooking-profile",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context, injected_skill_keys=profile.initial_skill_keys)

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.context_summary["orchestrator"]["profileKey"], "recipe_cook_page")
            self.assertEqual(result.context_summary["orchestrator"]["responseStyle"], "short_spoken")
            self.assertEqual(
                result.context_summary["orchestrator"]["capabilityPolicy"]["artifactContext"],
                "without_drafts",
            )
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxBusinessSkillsPerRun"], 0)
            self.assertIn("ui.propose_actions", provider.tool_names)
            self.assertIn("recipe.read_by_id", provider.tool_names)
            self.assertNotIn("human.request_input", provider.tool_names)
            self.assertNotIn("skill.inject", provider.tool_names)
            metadata = prompt_contract_metadata(provider.system)
            self.assertEqual(metadata["profileKey"], "recipe_cook_page")
            self.assertEqual(metadata["responseStyle"], "short_spoken")
            self.assertEqual(metadata["injectedSkillKeys"], ["cooking_assistant"])
            self.assertEqual(metadata["allowedDraftTypes"], [])
            self.assertFalse(metadata["includeCatalogRecords"])
            self.assertFalse(metadata["includeDynamicInjectionContract"])
            self.assertFalse(metadata["includeDraftContract"])
            self.assertFalse(metadata["includeAllowedDraftTypes"])
            self.assertEqual(metadata["artifactContextPolicy"], "without_drafts")
            self.assertTrue(metadata["includeArtifactContextContract"])
            self.assertEqual(metadata["catalogRecordKeys"], [])
            self.assertEqual(metadata["capabilityPolicy"]["skillInjection"], "fixed")
            self.assertEqual(metadata["capabilityPolicy"]["catalogScope"], "initial_only")
            self.assertEqual(metadata["capabilityPolicy"]["draftContract"], "hidden")
            self.assertEqual(metadata["capabilityPolicy"]["artifactContext"], "without_drafts")
            self.assertEqual(metadata["capabilityPolicy"]["allowedSkillKeys"], ["cooking_assistant"])
            self.assertLess(len(provider.system), 4200)
            self.assertIn("小灶", provider.system)
            self.assertNotIn("Catalog records:", provider.system)
            self.assertNotIn("Injected skills:", provider.system)
            self.assertNotIn('"key": "meal_plan"', provider.system)
            self.assertNotIn("skill.inject", provider.system)
            self.assertNotIn("本轮最多生成一个 draft", provider.system)
            self.assertNotIn("这些是当前已注入 Skill 允许的 draft_types", provider.system)
            self.assertNotIn("workspace.read_artifact", provider.system)
            self.assertIn("已按 profile 过滤", provider.system)
            self.assertEqual(provider.user_payload["injectedSkills"], ["cooking_assistant"])
            self.assertNotIn("allowedDraftTypes", provider.user_payload)

        def test_fixed_profile_filters_polluted_resume_skill_keys(self) -> None:
            class ResumeProfileProvider(BaseChatProvider):
                model_name = "fixed-profile-resume-model"

                def __init__(self) -> None:
                    self.system = ""
                    self.user_payload: dict[str, Any] = {}
                    self.tool_names: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del tool_handler, max_rounds
                    self.system = system
                    self.user_payload = json.loads(user)
                    self.tool_names = sorted(tool.name for tool in tools())
                    text = "继续做菜页当前步骤。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = ResumeProfileProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-cooking-resume-profile",
                run_id="run-cooking-resume-profile",
                conversation=[],
                current_message="继续",
                subject={"source": "recipe_cook_page"},
                orchestrator_profile=COOKING_ASSISTANT_PROFILE.to_state(),
                quick_task="cooking_assistant",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-cooking-resume-profile",
                        run_id="run-cooking-resume-profile",
                    ),
                ),
                current_run_artifacts=[
                    {
                        "id": "human_input:resume",
                        "type": "human.input_result",
                        "kind": "human_input",
                        "status": "completed",
                        "payload": {"summary": "继续"},
                    }
                ],
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context, injected_skill_keys=["meal_plan", "cooking_assistant", "recipe_draft"])

            self.assertEqual(result.status, "completed")
            orchestrator = result.context_summary["orchestrator"]
            self.assertEqual(orchestrator["injectedSkills"], ["cooking_assistant"])
            self.assertEqual(orchestrator["injectionHistory"][0]["source"], "existing")
            self.assertEqual(provider.user_payload["injectedSkills"], ["cooking_assistant"])
            self.assertEqual(provider.user_payload["injectionHistory"][0]["source"], "existing")
            self.assertIn("recipe.read_by_id", provider.tool_names)
            self.assertNotIn("skill.inject", provider.tool_names)
            self.assertNotIn("meal_plan.create_draft", provider.tool_names)
            self.assertNotIn("recipe.create_draft", provider.tool_names)
            metadata = prompt_contract_metadata(provider.system)
            self.assertEqual(metadata["injectedSkillKeys"], ["cooking_assistant"])
            self.assertEqual(metadata["catalogRecordKeys"], [])
            self.assertFalse(metadata["includeDynamicInjectionContract"])
            self.assertFalse(metadata["includeDraftContract"])
            self.assertNotIn('"key": "meal_plan"', provider.system)

        def test_cooking_profile_payload_filters_draft_artifacts(self) -> None:
            profile = COOKING_ASSISTANT_PROFILE
            agent = WorkspaceOrchestratorAgent(
                provider=MagicMock(),
                skill_registry=build_workspace_skill_registry(),
            )
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-cooking-artifacts",
                run_id="run-cooking-artifacts",
                conversation=[
                    {
                        "id": "message-1",
                        "role": "assistant",
                        "content": "之前生成过一个草稿和一张卡片。",
                        "artifacts": [
                            {
                                "id": "draft-recipe-1",
                                "type": "recipe",
                                "kind": "draft",
                                "status": "proposed",
                                "payload": {"draftType": "recipe", "title": "番茄炒蛋"},
                            },
                            {
                                "id": "card-1",
                                "type": "inventory_summary",
                                "kind": "result_card",
                                "status": "completed",
                                "payload": {"title": "库存概览"},
                            },
                        ],
                    }
                ],
                current_message="下一步",
                subject={"source": "recipe_cook_page"},
                orchestrator_profile=profile.to_state(),
                quick_task="cooking_assistant",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-cooking-artifacts",
                        run_id="run-cooking-artifacts",
                    ),
                ),
                previous_results=[
                    SkillResult(
                        text="已生成草稿和卡片。",
                        drafts=[
                            {
                                "draft_type": "meal_plan",
                                "payload": {"draftType": "meal_plan", "items": []},
                                "schema_version": "meal_plan.v1",
                            }
                        ],
                        cards=[{"id": "card-2", "type": "today_recommendation", "data": {"title": "今日推荐"}}],
                    )
                ],
                current_run_artifacts=[
                    {
                        "id": "approval-1",
                        "type": "approval_decision",
                        "kind": "approval_decision",
                        "status": "approved",
                        "payload": {
                            "approval": {"id": "approval-1", "status": "approved"},
                            "draft": {"id": "draft-1", "draft_type": "meal_plan", "payload": {"draftType": "meal_plan"}},
                        },
                    },
                    {
                        "id": "human-1",
                        "type": "human.input_result",
                        "kind": "human_input",
                        "status": "completed",
                        "payload": {"summary": "用户选择继续", "text": "继续"},
                    },
                ],
            )

            payload = agent.prompt_payload_builder.user_payload(context, ["cooking_assistant"], [])

            self.assertEqual(payload["conversation"][0]["artifacts"][0]["type"], "inventory_summary")
            self.assertEqual([artifact["type"] for artifact in payload["artifacts"]], ["inventory_summary", "human.input_result", "today_recommendation"])
            self.assertEqual([artifact["type"] for artifact in payload["currentRunArtifacts"]], ["human.input_result"])
            self.assertEqual(payload["previousResults"][0]["drafts"], [])
            self.assertEqual(payload["previousResults"][0]["cards"][0]["type"], "today_recommendation")
            self.assertNotIn("allowedDraftTypes", payload)

        def test_provider_user_input_uses_stable_subject_prefix_when_declared(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=MagicMock(),
                skill_registry=build_workspace_skill_registry(),
            )
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-stable-prefix",
                run_id="run-stable-prefix",
                conversation=[],
                current_message="下一步呢？",
                subject={
                    "source": "recipe_cook_page",
                    "recipe_id": "recipe-tomato",
                    "extra": {
                        "stableContext": {
                            "recipeId": "recipe-tomato",
                            "recipeTitle": "番茄炒蛋",
                            "steps": [{"id": "step-1", "text": "炒蛋。"}],
                            "ingredients": [{"id": "ri-egg", "name": "鸡蛋"}],
                        },
                        "runtimeContext": {
                            "currentStepIndex": 1,
                            "sessionRevision": 7,
                            "timers": [{"id": "timer-main", "remainingSeconds": 90}],
                            "assistantConversation": [{"role": "user", "text": "你好"}],
                        },
                    },
                },
                orchestrator_profile=COOKING_ASSISTANT_PROFILE.to_state(),
                quick_task="cooking_assistant",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-stable-prefix",
                        run_id="run-stable-prefix",
                    ),
                ),
            )

            user_input = agent.prompt_payload_builder.provider_user_input(
                context,
                ["cooking_assistant"],
                [],
            )

            self.assertIsInstance(user_input, ProviderUserInput)
            assert isinstance(user_input, ProviderUserInput)
            self.assertEqual(len(user_input.prefix_messages), 1)
            stable_payload = json.loads(user_input.prefix_messages[0])
            runtime_payload = json.loads(user_input.text)
            stable_text = json.dumps(stable_payload, ensure_ascii=False)
            runtime_text = json.dumps(runtime_payload, ensure_ascii=False)
            self.assertEqual(stable_payload["type"], "stableSubject")
            self.assertEqual(stable_payload["subject"]["recipeTitle"], "番茄炒蛋")
            self.assertNotIn("currentMessage", stable_payload)
            self.assertNotIn("timers", stable_text)
            self.assertNotIn("sessionRevision", stable_text)
            self.assertNotIn("assistantConversation", stable_text)
            self.assertEqual(runtime_payload["currentMessage"], "下一步呢？")
            self.assertEqual(runtime_payload["subject"]["runtimeContext"]["currentStepIndex"], 1)
            self.assertNotIn("stableContext", runtime_payload["subject"])
            self.assertNotIn("ingredients", runtime_text)
