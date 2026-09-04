# DashScope Unified Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace split DashScope adapters with one SDK-backed `dashscope` provider using a single API key and scenario-based routing.

**Architecture:** Keep existing family binding, dispatch credential, usage settlement, and transport boundaries. Add a native DashScope chat adapter and route audio/realtime through the same adapter kind while deriving protocol from capability and request context.

**Tech Stack:** FastAPI, SQLAlchemy, Python 3.13, `dashscope==1.27.3`, pytest, React 18, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-dashscope-unified-provider-design.md`

## Global Constraints

- DashScope adapter kind is exactly `dashscope`; `dashscope_http` and `dashscope_realtime` are removed.
- DashScope uses one API key and server-owned official endpoints.
- Existing authorization, dispatch permits, usage settlement, media limits, and realtime ticket checks remain mandatory.

### Task 1: Consolidate adapter contract and dependency

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/app/services/family_model_settings/types.py`
- Modify: `backend/app/schemas/family_model_settings.py`
- Modify: `backend/app/services/family_model_settings/adapter_registry.py`
- Test: `backend/tests/family_model_settings/test_adapter_registry.py`

- [ ] Write failing tests asserting `dashscope` supports all required capabilities, requires `api_key`, and old kinds are rejected.
- [ ] Run the focused registry/schema tests and confirm failure.
- [ ] Add `dashscope==1.27.3`, replace the literal union and registry entry, and encode official endpoint policy.
- [ ] Run focused tests and `git diff --check`.

### Task 2: Native DashScope chat provider

**Files:**
- Create: `backend/app/ai/runtime/dashscope_chat.py`
- Modify: `backend/app/ai/runtime/factory.py`
- Modify: `backend/app/ai/runtime/provider.py`
- Test: `backend/tests/ai_runtime/test_dashscope_chat.py`

- [ ] Add failing tests for Generation text, MultiModalConversation image routing, stream normalization, and tool-call normalization.
- [ ] Run the new tests and verify missing provider behavior fails.
- [ ] Implement SDK-backed provider with deferred credential resolution and existing usage/trace hooks.
- [ ] Route `dashscope` bindings in the factory and export the provider.
- [ ] Run focused runtime tests.

### Task 3: Audio/realtime and configuration migration

**Files:**
- Modify: `backend/app/services/ai_audio/dashscope_audio.py`
- Modify: `backend/app/services/ai_audio/service.py`
- Modify: `backend/app/services/ai_audio/config.py`
- Modify: `backend/app/services/family_model_settings/validation.py`
- Modify: `backend/app/services/family_model_settings/capability_tests.py`
- Modify: `backend/app/services/family_model_settings/connection_tests.py`
- Test: `backend/tests/ai_audio/test_ai_audio_service.py`
- Test: `backend/tests/family_model_settings/test_capability_tests.py`

- [ ] Add failing tests requiring `dashscope` for STT/TTS/realtime and rejecting split kinds.
- [ ] Update native SDK/WebSocket routing to use the common kind and official endpoints while retaining settlement and ticket checks.
- [ ] Run focused audio/configuration tests.

### Task 4: Frontend contract and documentation cleanup

**Files:**
- Modify: `frontend/src/api/types/modelUsage.ts`
- Modify: `frontend/src/features/family-model-settings/familyModelSettingsOptions.ts`
- Modify: `frontend/src/features/family-model-settings/ProviderProfileEditor.tsx`
- Modify: affected frontend tests and docs.

- [ ] Add failing Vitest assertions for a single DashScope option and hidden endpoint/realtime split.
- [ ] Update type/options/editor and remove stale references.
- [ ] Run targeted Vitest and frontend typecheck.

### Task 5: Verification

- [ ] Run focused backend pytest suites, backend compileall, frontend typecheck, and `git diff --check`.
- [ ] Review all changed references to ensure no `dashscope_http` or `dashscope_realtime` remains in production code.
