from __future__ import annotations

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace

import app.main as main


def test_lifespan_forces_media_bucket_private_before_workers(monkeypatch) -> None:
    events: list[str] = []

    class FakeDb:
        def begin(self):
            return nullcontext()

    class RecordingWorker:
        def __init__(self, name: str) -> None:
            self.name = name

        def start(self) -> None:
            events.append(f"{self.name}:start")

        def stop(self) -> None:
            events.append(f"{self.name}:stop")

    monkeypatch.setattr(main, "SessionLocal", lambda: nullcontext(FakeDb()))
    monkeypatch.setattr(main, "initialize_configured_admin", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        main,
        "validate_family_model_credential_keyring_references",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(main, "ensure_media_bucket", lambda: events.append("media:private"))
    monkeypatch.setattr(main, "ImageGenerationWorker", lambda: RecordingWorker("image"))
    monkeypatch.setattr(main, "SearchIndexWorker", lambda: RecordingWorker("search"))
    monkeypatch.setattr(main, "ModelUsageMaintenanceWorker", lambda: RecordingWorker("usage"))
    monkeypatch.setattr(
        main,
        "FamilyModelSettingsMaintenanceWorker",
        lambda: RecordingWorker("family-model"),
    )
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            model_usage_required=False,
            model_usage_maintenance_enabled=False,
            family_model_maintenance_enabled=False,
        ),
    )

    async def exercise_lifespan() -> None:
        async with main.lifespan(object()):
            assert events[:3] == ["media:private", "image:start", "search:start"]

    asyncio.run(exercise_lifespan())
    assert events.count("media:private") == 1
