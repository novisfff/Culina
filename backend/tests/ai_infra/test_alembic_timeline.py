from __future__ import annotations

from pathlib import Path
import importlib.util

from app.models.domain import AIConversation, AIConversationEvent, AIMessage


MIGRATION_PATH = Path(__file__).parents[2] / "alembic" / "versions" / "a3b4c5d6e7f8_add_ai_conversation_events.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("ai_timeline_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_timeline_migration_is_attached_to_current_head() -> None:
    migration = _load_migration()
    assert migration.revision == "a3b4c5d6e7f8"
    assert migration.down_revision == "9d0e1f2a3b4c"


def test_timeline_models_expose_required_constraints() -> None:
    assert "timeline_version" in AIConversation.__table__.c
    assert "timeline_position" in AIMessage.__table__.c
    assert "snapshot_sequence" in AIMessage.__table__.c
    assert "sequence" in AIConversationEvent.__table__.c
    assert any(
        constraint.name == "uq_ai_conversation_events_conversation_sequence"
        for constraint in AIConversationEvent.__table__.constraints
    )
