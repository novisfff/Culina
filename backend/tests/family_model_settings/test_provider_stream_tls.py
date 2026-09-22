from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import select
import socket
import ssl
from threading import Thread

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.services.family_model_settings.errors import FamilyModelProviderTransportError
from app.services.family_model_settings.transport import ProviderTransport
from tests.family_model_settings.test_provider_streaming import gated_server, local_transport, settings


@pytest.fixture
def tls(tmp_path, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "provider.example")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([
                x509.DNSName("provider.example"), x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            ]), critical=False).sign(key, hashes.SHA256()))
    cert_path = tmp_path / "test-ca.pem"
    key_path = tmp_path / "test-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    monkeypatch.setattr("app.services.family_model_settings.transport.certifi.where", lambda: str(cert_path))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    names = []
    context.set_servername_callback(lambda sock, name, ctx: names.append(name))
    return context, names


@contextmanager
def tunnel_proxy(origin_port, *, tls_context=None):
    targets = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_CONNECT(self):
            targets.append(self.path)
            with socket.create_connection(("127.0.0.1", origin_port), timeout=2) as upstream:
                self.send_response(200)
                self.end_headers()
                peers = [self.connection, upstream]
                try:
                    while True:
                        ready, _, _ = select.select(peers, [], [], 0.05)
                        for peer in peers:
                            if isinstance(peer, ssl.SSLSocket) and peer.pending() and peer not in ready:
                                ready.append(peer)
                        for peer in ready:
                            data = peer.recv(65536)
                            if not data:
                                return
                            (upstream if peer is self.connection else self.connection).sendall(data)
                except (OSError, ssl.SSLError):
                    return
                finally:
                    self.close_connection = True

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls_context is not None:
        server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        scheme = "https" if tls_context is not None else "http"
        yield f"{scheme}://localhost:{server.server_port}", targets
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


@pytest.mark.parametrize("address", ["93.184.216.34", "2606:4700:4700::1111"])
@pytest.mark.parametrize("proxy_scheme", [None, "http", "https"])
def test_https_stream_keeps_pinned_ip_original_host_and_verified_tls_identity(monkeypatch, tls, proxy_scheme, address):
    context, names = tls
    with gated_server(tls_context=context) as (port, sent, release, finished, calls):
        transport, connections = local_transport(monkeypatch, port)
        transport.policy.resolver.answers = (address,)

        def consume(transport):
            with transport.stream_request("POST", "https://provider.example/v1/chat", headers={}, json={}) as response:
                chunks = response.iter_bytes()
                assert next(chunks).startswith(b"data:")
                assert not release.is_set()
                chunks.close()
            assert finished.wait(1)

        if proxy_scheme is None:
            consume(transport)
            assert connections == [(address, 443)]
        else:
            with tunnel_proxy(port, tls_context=context if proxy_scheme == "https" else None) as (proxy_url, targets):
                consume(ProviderTransport(policy=transport.policy, settings=settings(egress_proxy_url=proxy_url)))
                assert targets == [f"[{address}]:443" if ":" in address else f"{address}:443"]
        assert names == (["localhost", "provider.example"] if proxy_scheme == "https" else ["provider.example"])
        assert calls[0][1]["Host"] == "provider.example"


@pytest.mark.parametrize("proxy_tls", [False, True])
def test_pinned_proxy_does_not_disable_origin_certificate_verification(monkeypatch, tls, proxy_tls):
    context, names = tls
    with gated_server(tls_context=context) as (port, *_):
        transport, _ = local_transport(monkeypatch, port)
        with tunnel_proxy(port, tls_context=context if proxy_tls else None) as (proxy_url, targets):
            transport = ProviderTransport(policy=transport.policy, settings=settings(egress_proxy_url=proxy_url))
            with pytest.raises(FamilyModelProviderTransportError):
                with transport.stream_request("POST", "https://wrong.example/v1/chat", headers={}, json={}):
                    pytest.fail("wrong origin hostname was accepted")
            assert targets == ["93.184.216.34:443"]
