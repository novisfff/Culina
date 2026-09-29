"""httpcore's public network backend keeps TLS identity when CONNECT uses an IP.

httpcore 1.0's proxy tunnel does not apply the sni_hostname request extension.
Wrap its public NetworkStream rather than disabling certificate verification or
mutating private connection-pool state. HTTPS proxy TLS is a separate layer.
"""
from __future__ import annotations

import ssl
from typing import Any

import httpcore


class _OriginTLSStream(httpcore.NetworkStream):
    def __init__(self, stream: httpcore.NetworkStream, *, hostname: str, proxy_tls: bool):
        self._stream = stream
        self._hostname = hostname
        self._proxy_tls = proxy_tls

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return self._stream.read(max_bytes, timeout)

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._stream.write(buffer, timeout)

    def close(self) -> None:
        self._stream.close()

    def get_extra_info(self, info: str) -> Any:
        return self._stream.get_extra_info(info)

    def start_tls(self, ssl_context: ssl.SSLContext, server_hostname: str | None = None,
                  timeout: float | None = None) -> httpcore.NetworkStream:
        stream = self._stream.start_tls(
            ssl_context, server_hostname=server_hostname if self._proxy_tls else self._hostname,
            timeout=timeout,
        )
        return _OriginTLSStream(stream, hostname=self._hostname, proxy_tls=False)


class PinnedProxyBackend(httpcore.SyncBackend):
    def __init__(self, *, hostname: str, proxy_tls: bool):
        self._hostname = hostname
        self._proxy_tls = proxy_tls

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        stream = super().connect_tcp(host, port, timeout, local_address, socket_options)
        return _OriginTLSStream(stream, hostname=self._hostname, proxy_tls=self._proxy_tls)
