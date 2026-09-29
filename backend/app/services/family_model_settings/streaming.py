"""Bounded streaming responses; no provider payload is retained after consumption."""
from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from queue import Empty, Full, Queue
from threading import Event, Thread

from app.services.family_model_settings.errors import (
    FamilyModelProviderResponseTooLarge,
    FamilyModelProviderTransportError,
)


@dataclass(slots=True)
class ProviderStreamResponse:
    status_code: int
    headers: Mapping[str, str]
    chunks: Iterator[bytes]
    max_bytes: int
    abort: Callable[[], None]
    _closed: Event = field(default_factory=Event, init=False, repr=False)
    _reader: Thread | None = field(default=None, init=False, repr=False)
    _iterated: bool = field(default=False, init=False, repr=False)

    def close(self) -> None:
        if not self._closed.is_set():
            self._closed.set()
            self.abort()
        if self._reader is not None:
            self._reader.join(timeout=1)

    def header(self, name: str) -> str | None:
        return next((v for k, v in self.headers.items() if k.lower() == name.lower()), None)

    def _content_length(self) -> int | None:
        raw = self.header("content-length")
        if raw is None:
            return None
        if not raw.isascii() or not raw.isdecimal():
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid")
        try:
            length = int(raw)
        except ValueError as exc:
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc
        if length > self.max_bytes:
            raise FamilyModelProviderResponseTooLarge()
        return length

    def validate_headers(self) -> None:
        self._content_length()
        # Both dialers request identity. Reject noncompliant compression instead
        # of permitting a small wire payload to inflate beyond the memory cap.
        if (self.header("content-encoding") or "identity").strip().lower() != "identity":
            raise FamilyModelProviderTransportError("family_model_provider_encoding_unsupported")

    def iter_bytes(self, *, check_cancel: Callable[[], None] | None = None) -> Iterator[bytes]:
        if self._iterated or self._closed.is_set():
            raise FamilyModelProviderTransportError("family_model_provider_stream_already_consumed")
        self._iterated = True
        self.validate_headers()
        expected = self._content_length()
        total = 0
        source = self.chunks if check_cancel is None else self._interruptible_chunks(check_cancel)
        try:
            for chunk in source:
                total += len(chunk)
                if total > self.max_bytes:
                    raise FamilyModelProviderResponseTooLarge()
                if chunk:
                    yield chunk
            if expected is not None and total != expected:
                raise FamilyModelProviderTransportError("family_model_provider_response_incomplete")
        finally:
            try:
                close = getattr(source, "close", None)
                if close is not None:
                    close()
            finally:
                self.close()

    def _interruptible_chunks(self, check_cancel: Callable[[], None]) -> Iterator[bytes]:
        """Keep cancellation/DB access on the caller, not the network reader.

        At most one queued chunk plus the reader's current chunk is prefetched.
        Shutdown interrupts an idle socket read; no requests/retries occur here.
        """
        queue: Queue[bytes | BaseException | None] = Queue(maxsize=1)
        stop = self._closed

        def put(value: bytes | BaseException | None) -> None:
            while not stop.is_set():
                try:
                    queue.put(value, timeout=0.1)
                    return
                except Full:
                    pass

        def read() -> None:
            try:
                for chunk in self.chunks:
                    if stop.is_set():
                        return
                    put(chunk)
            except BaseException as exc:
                put(exc)
            finally:
                put(None)

        check_cancel()
        self._reader = Thread(target=read, name="provider-stream-reader", daemon=True)
        self._reader.start()
        try:
            while not stop.is_set():
                check_cancel()
                try:
                    value = queue.get(timeout=0.1)
                except Empty:
                    continue
                check_cancel()
                if value is None:
                    return
                if isinstance(value, BaseException):
                    raise value
                yield value
        finally:
            self.close()
