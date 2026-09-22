from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from contextlib import contextmanager
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import select
import socket
from threading import Event, Thread

import pytest

from app.ai.runtime.family_transport import DeferredBindingTransport
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.transport import ProviderTransport, ProviderTransportSettings
from app.services.family_model_settings.types import DispatchCredential, ResolvedCapabilityBinding


FIRST = b'data: {"choices":[{"delta":{"content":"A"}}]}\n\n'
TAIL = b'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n'


class PublicResolver:
    answers = ("93.184.216.34",)

    def resolve_all(self, host):
        return self.answers


def settings(**overrides):
    return replace(ProviderTransportSettings(
        connect_timeout_seconds=1, request_timeout_seconds=2,
        response_max_bytes=4096, media_max_bytes=4096, redirect_limit=0,
    ), **overrides)


@contextmanager
def gated_server(*, first=FIRST, tail=TAIL, status=200, headers=None, chunked=False, tls_context=None):
    sent = Event()
    release = Event()
    finished = Event()
    calls = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            calls.append((self.path, dict(self.headers)))
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream")
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(first) + len(tail)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            try:
                def send(data):
                    if chunked:
                        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    else:
                        self.wfile.write(data)
                    self.wfile.flush()
                send(first)
                sent.set()
                for _ in range(500):
                    if release.wait(0.01):
                        break
                    if select.select([self.connection], [], [], 0)[0]:
                        if not self.connection.recv(1):
                            return
                send(tail)
                if chunked:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                finished.set()
                self.close_connection = True

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls_context is not None:
        server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, sent, release, finished, calls
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(2)


def local_transport(monkeypatch, port, *, proxy=False, **overrides):
    # Keep the real SSRF policy: intercept only the actual TCP dial to map the
    # authorized public target to our isolated local HTTP fixture.
    real_connect = socket.create_connection
    targets = []

    def connect(address, *args, **kwargs):
        targets.append(address)
        host, target_port = address
        if host in {"93.184.216.34", "2606:4700:4700::1111"}:
            address = ("127.0.0.1", port)
        return real_connect(address, *args, **kwargs)

    monkeypatch.setattr(socket, "create_connection", connect)
    policy = ProviderNetworkPolicy(resolver=PublicResolver(), allow_insecure_public_transports=True)
    transport = ProviderTransport(policy=policy, settings=settings(
        egress_proxy_url=f"http://127.0.0.1:{port}" if proxy else "", **overrides,
    ))
    return transport, targets


def deferred(transport):
    binding = ResolvedCapabilityBinding(
        family_id="family-stream", config_revision_id="revision-stream",
        provider_profile_id="profile-stream", provider_profile_version_id="profile-v1",
        adapter_kind="openai_compatible_http", auth_mode="api_key",
        endpoint=transport.policy.authorize("http://provider.example/v1", protocol="http"),
        websocket_endpoint=None, requested_model="model-stream", billing_model="model-stream",
        capability="llm", variant_key="primary", billing_scheme_key="llm-split-v1", options={},
    )
    return DeferredBindingTransport(binding=binding, transport=transport,
        resolve_credential=lambda *_: DispatchCredential(
            family_id="family-stream", provider_profile_id="profile-stream",
            secret_version_id="secret-v1", api_key="synthetic-test-key",
        ))


@pytest.mark.parametrize("proxy", [False, True], ids=["direct", "egress"])
@pytest.mark.parametrize("chunked", [False, True], ids=["content-length", "chunked"])
def test_first_event_is_consumed_before_server_releases_tail(monkeypatch, proxy, chunked):
    with gated_server(chunked=chunked) as (port, sent, release, finished, calls):
        transport, targets = local_transport(monkeypatch, port, proxy=proxy)
        facade = deferred(transport)
        with ThreadPoolExecutor(max_workers=1) as pool:
            def first_event():
                events = facade.request_json(suffix="chat/completions", payload={"stream": True}, permit=None, stream=True)
                return events, next(events)
            future = pool.submit(first_event)
            try:
                assert sent.wait(2), "fixture did not send first event"
                try:
                    events, first = future.result(timeout=0.5)
                except FutureTimeout:
                    pytest.fail("first SSE event is blocked on the unreleased response tail")
                assert first == {"choices": [{"delta": {"content": "A"}}]}
                assert not release.is_set()
                release.set()
                assert list(events) == [{"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2}}]
            finally:
                release.set()
        assert len(calls) == 1
        assert calls[0][1]["Host"] == "provider.example"
        if proxy:
            assert calls[0][0] == "http://93.184.216.34:80/v1/chat/completions"
        else:
            assert targets == [("93.184.216.34", 80)]


@pytest.mark.parametrize("proxy", [False, True])
def test_stream_cumulative_limit_with_no_content_length(monkeypatch, proxy):
    from app.services.family_model_settings.errors import FamilyModelProviderResponseTooLarge

    with gated_server(chunked=True) as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, response_max_bytes=len(FIRST) + 1)
        events = deferred(transport).request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        assert next(events)["choices"][0]["delta"]["content"] == "A"
        release.set()
        with pytest.raises(FamilyModelProviderResponseTooLarge):
            list(events)
        assert len(calls) == 1


@pytest.mark.parametrize("proxy", [False, True])
@pytest.mark.parametrize("kind", ["oversize", "encoding", "redirect"])
def test_headers_rejected_without_reading_body_or_following_redirect(monkeypatch, proxy, kind):
    from app.services.family_model_settings.errors import (
        FamilyModelEndpointBlocked, FamilyModelProviderResponseTooLarge, FamilyModelProviderTransportError,
    )

    headers = {"Content-Encoding": "gzip"} if kind == "encoding" else {"Location": "http://169.254.169.254/latest"}
    error = {"oversize": FamilyModelProviderResponseTooLarge, "encoding": FamilyModelProviderTransportError,
             "redirect": FamilyModelEndpointBlocked}[kind]
    with gated_server(status=302 if kind == "redirect" else 200, headers=headers) as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, response_max_bytes=1 if kind == "oversize" else 4096)
        with pytest.raises(error):
            deferred(transport).request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        assert not release.is_set()
        assert finished.wait(1), "rejected stream connection stayed open"
        assert len(calls) == 1


@pytest.mark.parametrize("proxy", [False, True])
@pytest.mark.parametrize("consume", [False, True])
def test_closing_consumer_releases_unfinished_connection(monkeypatch, proxy, consume):
    with gated_server() as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy)
        events = deferred(transport).request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        if consume:
            assert next(events)["choices"]
        events.close()
        events.close()
        assert finished.wait(1), "closing the iterator must not wait for the server's tail"
        assert not release.is_set()


@pytest.mark.parametrize("proxy", [False, True])
def test_idle_body_read_times_out_and_closes_connection(monkeypatch, proxy):
    from app.services.family_model_settings.errors import FamilyModelProviderTransportError

    with gated_server() as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, request_timeout_seconds=0.2)
        events = deferred(transport).request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        assert next(events)["choices"]
        with pytest.raises(FamilyModelProviderTransportError):
            next(events)
        assert finished.wait(1)
        assert not release.is_set()


@pytest.mark.parametrize("proxy", [False, True])
def test_idle_stream_can_be_cancelled_on_caller_thread(monkeypatch, proxy):
    from threading import get_ident
    from app.ai.errors import AIExecutionCancelled

    cancel = Event()
    consumed = Event()
    with gated_server() as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, request_timeout_seconds=4)

        def consume():
            caller = get_ident()

            def check_cancel():
                assert get_ident() == caller, "DB cancellation must stay on its owning thread"
                if cancel.is_set():
                    raise AIExecutionCancelled("cancelled")

            with transport.stream_request("POST", "http://provider.example/v1/chat/completions", headers={}, json={}) as response:
                for chunk in response.iter_bytes(check_cancel=check_cancel):
                    consumed.set()

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(consume)
            try:
                assert consumed.wait(2)
                cancel.set()
                with pytest.raises(AIExecutionCancelled):
                    future.result(timeout=1)
                assert finished.wait(1)
                assert not release.is_set()
            finally:
                release.set()


@pytest.mark.parametrize("proxy", [False, True])
def test_stream_reauthorizes_dns_for_each_send(monkeypatch, proxy):
    from app.services.family_model_settings.errors import FamilyModelEndpointBlocked

    with gated_server() as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy)
        facade = deferred(transport)
        events = facade.request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        events.close()
        transport.policy.resolver.answers = ("127.0.0.1",)
        with pytest.raises(FamilyModelEndpointBlocked):
            facade.request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        assert len(calls) == 1


@pytest.mark.parametrize("proxy", [False, True])
def test_response_context_closes_prefetch_even_if_iterator_is_retained(monkeypatch, proxy):
    from threading import enumerate as threads

    existing = {thread.ident for thread in threads() if thread.name == "provider-stream-reader"}
    with gated_server(first=b"x" * (256 * 1024), tail=b"tail", chunked=True) as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, response_max_bytes=512 * 1024)
        with transport.stream_request("POST", "http://provider.example/v1/chat", headers={}, json={}) as response:
            retained_iterator = response.iter_bytes(check_cancel=lambda: None)
            assert next(retained_iterator)
        try:
            assert {thread.ident for thread in threads() if thread.name == "provider-stream-reader"} <= existing
        finally:
            retained_iterator.close()


def test_http_proxy_keeps_ipv6_authority_brackets_and_original_host(monkeypatch):
    with gated_server() as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=True)
        transport.policy.resolver.answers = ("2606:4700:4700::1111",)
        events = deferred(transport).request_json(suffix="chat/completions", payload={}, permit=None, stream=True)
        assert next(events)["choices"]
        events.close()
        assert calls[0][0] == "http://[2606:4700:4700::1111]:80/v1/chat/completions"
        assert calls[0][1]["Host"] == "provider.example"
