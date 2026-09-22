"""Per-call guard, including fallback/optional-parameter dispatches.

Do not mutate family/fixed provider instances: tests and factories may share them.
ContextVar stays active while a generator is consumed and is reset on close/error.
"""
from contextvars import ContextVar
from functools import wraps

_stream_cancel_check = ContextVar("chat_execution_stream_cancel_check", default=None)


def current_stream_cancel_check():
    return _stream_cancel_check.get()


_dispatch_guard = ContextVar("chat_execution_dispatch_guard", default=None)


def check_dispatch_guard() -> None:
    guard = _dispatch_guard.get()
    if guard is not None:
        guard()


class GuardedChatProvider:
    def __init__(self, provider, guard, *, cancel_check=None):
        self._provider, self._guard = provider, guard
        self._cancel_check = cancel_check

    def __getattr__(self, name):
        value = getattr(self._provider, name)
        if name not in {"generate", "generate_with_tools", "stream_generate"}:
            return value
        if name == "stream_generate":
            @wraps(value)
            def stream(*args, **kwargs):
                token = _dispatch_guard.set(self._guard)
                cancel_token = _stream_cancel_check.set(self._cancel_check)
                try:
                    self._guard()
                    yield from value(*args, **kwargs)
                finally:
                    _stream_cancel_check.reset(cancel_token)
                    _dispatch_guard.reset(token)
            return stream

        @wraps(value)
        def invoke(*args, **kwargs):
            token = _dispatch_guard.set(self._guard)
            cancel_token = _stream_cancel_check.set(self._cancel_check)
            try:
                self._guard()
                return value(*args, **kwargs)
            finally:
                _stream_cancel_check.reset(cancel_token)
                _dispatch_guard.reset(token)
        return invoke
