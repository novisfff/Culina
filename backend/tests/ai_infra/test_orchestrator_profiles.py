from ._support import *
from app.ai.workflows.orchestrator_profiles import (
    COOKING_ASSISTANT_PROFILE,
    DEFAULT_ORCHESTRATOR_PROFILE,
    resolve_orchestrator_profile,
)


class OrchestratorProfileTestCase(AIAgentInfraTestCase):
        def test_resolves_cooking_assistant_profile_from_quick_task_and_subject(self) -> None:
            self.assertEqual(
                resolve_orchestrator_profile(quick_task="cooking_assistant", subject={}).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                resolve_orchestrator_profile(quick_task=None, subject={"source": "recipe_cook_page"}).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                resolve_orchestrator_profile(
                    quick_task=None,
                    subject={"extra": {"surface": "recipe_cook_page"}},
                ).key,
                COOKING_ASSISTANT_PROFILE.key,
            )
            self.assertEqual(
                resolve_orchestrator_profile(quick_task=None, subject={"source": "ai_workspace"}).key,
                DEFAULT_ORCHESTRATOR_PROFILE.key,
            )

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
            self.assertIn("ui.propose_actions", provider.tool_names)
            self.assertIn("recipe.read_by_id", provider.tool_names)
            self.assertIn("小灶", provider.system)
            self.assertIn("个人小助手", provider.system)
            self.assertIn("寒暄", provider.system)
            self.assertIn("不要主动讲当前步骤", provider.system)
            self.assertIn("默认不要使用 Markdown", provider.system)
            self.assertIn("不要说 recipe_cook", provider.system)
            self.assertIn("系统 AI 助手", provider.system)
            self.assertIn("调用页面动作前", provider.system)
            self.assertIn("工具调用完成后", provider.system)
            self.assertIn("不要放任何给用户看的话术字段", provider.system)
            self.assertEqual(provider.user_payload["injectedSkills"], ["cooking_assistant"])
            self.assertEqual(provider.user_payload["allowedDraftTypes"], [])
