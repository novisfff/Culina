from __future__ import annotations

from urllib.parse import urljoin
from urllib.parse import urlencode

from app.core.config import Settings


def dashscope_region_host(region: str) -> str:
    region = (region or "cn-beijing").strip()
    if region == "cn-beijing":
        return "cn-beijing.maas.aliyuncs.com"
    return f"{region}.maas.aliyuncs.com"


def dashscope_http_base(settings: Settings) -> str:
    if settings.dashscope_http_api_base.strip():
        return settings.dashscope_http_api_base.rstrip("/")
    if settings.dashscope_workspace_id.strip():
        return f"https://{settings.dashscope_workspace_id}.{dashscope_region_host(settings.dashscope_region)}/api/v1"
    return "https://dashscope.aliyuncs.com/api/v1"


def dashscope_ws_base(settings: Settings) -> str:
    if settings.dashscope_websocket_api_base.strip():
        return settings.dashscope_websocket_api_base.rstrip("/")
    if settings.dashscope_workspace_id.strip():
        return f"wss://{settings.dashscope_workspace_id}.{dashscope_region_host(settings.dashscope_region)}/api-ws/v1"
    return "wss://dashscope.aliyuncs.com/api-ws/v1"


def dashscope_api_key(settings: Settings, explicit: str = "") -> str:
    return explicit.strip() or settings.dashscope_api_key.strip()


def join_api_url(base: str, path: str) -> str:
    return urljoin(base.rstrip("/") + "/", path.lstrip("/"))


def dashscope_realtime_url(settings: Settings, model: str) -> str:
    base = (settings.ai_realtime_api_base.strip() or dashscope_ws_base(settings)).rstrip("/")
    if base.endswith("/realtime"):
        endpoint = base
    else:
        endpoint = join_api_url(base, "/realtime")
    return f"{endpoint}?{urlencode({'model': model})}"
