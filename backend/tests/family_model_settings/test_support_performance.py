from __future__ import annotations

import pytest

from tests.family_model_settings import _support


def test_family_model_api_does_not_hash_passwords_per_fixture(monkeypatch) -> None:
    def fail_if_called(password: str) -> str:
        raise AssertionError(f"unexpected runtime password hash: {password}")

    monkeypatch.setattr(_support, "get_password_hash", fail_if_called)
    fixture = _support.family_model_api.__wrapped__()
    context = next(fixture)
    try:
        assert context.auth_state.user_id == "owner-a"
    finally:
        with pytest.raises(StopIteration):
            next(fixture)
