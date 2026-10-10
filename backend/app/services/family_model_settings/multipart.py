"""Encode bounded provider file uploads for the shared HTTP transport."""

from collections.abc import Mapping
from uuid import uuid4


def provider_multipart_form(
    fields: Mapping[str, str],
    *,
    filename: str,
    payload: bytes,
    media_type: str,
    file_field: str = "file",
) -> tuple[bytes, str]:
    boundary = f"----CulinaProvider{uuid4().hex}"
    safe_filename = filename.replace("\\", "_").replace('"', "_").replace("\r", "_").replace("\n", "_")
    if file_field not in {"file", "image[]"}:
        raise ValueError("provider_multipart_file_field_invalid")
    chunks: list[bytes] = []
    for key, value in fields.items():
        if any(char in key for char in '\r\n"'):
            raise ValueError("provider_multipart_field_invalid")
        chunks.extend((
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
            value.encode("utf-8"), b"\r\n",
        ))
    chunks.extend((
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_filename}"\r\n'.encode(),
        f"Content-Type: {media_type}\r\n\r\n".encode(), payload, b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"
