from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

from app.core.config import get_settings
from app.core.enums import ImageGenerationMode, MealType, MediaEntityType

STYLE_KEY = "culina-still-life-v1"
PROMPT_VERSION = "4"
DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DASHSCOPE_SYNC_ENDPOINT = "/services/aigc/multimodal-generation/generation"
OPENAI_IMAGE_GENERATIONS_ENDPOINT = "/images/generations"
OPENAI_IMAGE_EDITS_ENDPOINT = "/images/edits"

BASE_STYLE_PROMPT = """
你是一名严格遵守 Culina 统一视觉语言的美食静物摄影师。
最终画面必须是半写实厨房静物摄影，不是插画，不是电商硬广，不是卡通，不是拼贴。
主体必须单一明确，构图克制，留白稳定，适配卡片裁切，画面干净且易识别。
主体与关键特征必须位于画面中央安全区，四周保留稳定边距，轻微裁切后仍应完整可辨识。
不要把主体、器皿边缘、切面、关键纹理或主要高光压在画面边缘。
布光固定为柔和自然侧光，整体色调固定为暖中性色，使用奶油白、浅鼠尾草、淡木色、低饱和橙棕。
背景固定为干净台面或安静厨房环境，只允许极少量辅助道具，且仅在帮助识别主体时出现。
图像内部绝对不要出现任何额外文字、字母、数字、logo、商标、标题、标签、字幕、印章、贴纸、包装文案、菜单字样或装饰性排版。
即使主体附近有标签牌、包装、瓶贴、说明卡、印刷图案，也必须移除或改成不可读的纯净表面，不能保留任何可辨识字符。
严格禁止人物、手、包装袋、品牌标识、文字、水印、分镜、夸张滤镜、强反光、重阴影、杂乱背景。
严格禁止高饱和网红感、商品硬照感、夸张摆盘、戏剧化打光。
""".strip()

REFERENCE_MODE_APPENDIX = """
保留参考图里的主体身份、形态、切面、颜色和可识别特征。
移除原图里的杂物、噪点、桌面凌乱、手部、包装、标签、反射、环境色污染。
如果参考图中存在任何文字、logo、包装印刷、标签贴纸、店名、菜单字样或水印，必须彻底清除，不能在生成图里保留。
不要复制原背景和原构图，而是把主体统一归一到 Culina house style。
目标是生成一张像同一家工作室拍摄的标准主图，而不是简单美化原图。
即使参考图主体原本靠边，也要重新整理到中央安全区，保留主体完整轮廓和边距。
""".strip()

MEAL_TYPE_LABELS = {
    MealType.BREAKFAST: "早餐",
    MealType.LUNCH: "午餐",
    MealType.DINNER: "晚餐",
    MealType.SNACK: "加餐/夜宵",
}

ENTITY_SIZES_BY_MODE = {
    ImageGenerationMode.TEXT: {
        MediaEntityType.INGREDIENT: "1536*1152",
        MediaEntityType.FOOD: "1664*1040",
        MediaEntityType.RECIPE: "1664*1040",
        MediaEntityType.RECIPE_SCENE: "1664*1040",
        MediaEntityType.FOOD_SCENE: "1664*1040",
        MediaEntityType.MEAL_LOG: "1664*1040",
    },
    ImageGenerationMode.REFERENCE: {
        MediaEntityType.INGREDIENT: "1280*960",
        MediaEntityType.FOOD: "1280*800",
        MediaEntityType.RECIPE: "1280*800",
        MediaEntityType.RECIPE_SCENE: "1280*800",
        MediaEntityType.FOOD_SCENE: "1280*800",
        MediaEntityType.MEAL_LOG: "1280*800",
    },
}

CONTENT_TYPE_TO_EXTENSION = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}

SUPPORTED_REFERENCE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/bmp"}


def _join(values: list[str]) -> str:
    return "、".join(item for item in values if item)


@dataclass(slots=True)
class ImageGenerationRequest:
    entity_type: MediaEntityType
    mode: ImageGenerationMode
    title: str = ""
    category: str = ""
    notes: str = ""
    tags: list[str] = field(default_factory=list)
    scene: str = ""
    meal_type: MealType | None = None
    food_names: list[str] = field(default_factory=list)
    ingredient_names: list[str] = field(default_factory=list)
    reference_image_bytes: bytes | None = None
    reference_filename: str | None = None
    size: str = ""
    quality: str = "standard"
    output_format: str = "png"
    background: str = "opaque"


@dataclass(slots=True)
class ImageGenerationResult:
    prompt: str
    binary_content: bytes | None = None
    file_extension: str = ".png"
    mime_type: str = "image/png"
    svg_markup: str | None = None
    style_key: str = STYLE_KEY
    prompt_version: str = PROMPT_VERSION


@dataclass(slots=True)
class ImageProviderConfig:
    provider: str = "disabled"
    api_base: str = DEFAULT_DASHSCOPE_BASE_URL
    api_key: str = ""
    model: str = ""


def INGREDIENT_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"主体食材：{request.title or '家庭常备食材'}",
        f"分类：{request.category or '未分类'}",
        f"备注：{request.notes or '无额外备注'}",
    ]
    return "\n".join(
        [
            "为单一食材生成一张主图，主体必须是这份原料本体，不要出现成菜摆盘。",
            *detail,
            "优先表现食材的天然质感、表皮颜色、切面和新鲜状态。",
        ]
    )


def FOOD_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"食物名称：{request.title or '家庭食物'}",
        f"分类：{request.category or '未分类'}",
        f"口味/标签：{_join(request.tags) or '无'}",
        f"场景：{request.scene or '家庭日常'}",
        f"备注：{request.notes or '无额外备注'}",
        f"涉及食材：{_join(request.ingredient_names) or '未提供'}",
    ]
    return "\n".join(
        [
            "为家庭食物生成一张半写实静物主图，突出成品本身，不做餐厅广告大片。",
            *detail,
            "呈现家庭厨房语境下的真实食物质感，避免商业海报式夸张摆盘。",
        ]
    )


def RECIPE_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"菜谱标题：{request.title or '家庭菜谱'}",
        f"适用场景：{request.scene or '家庭日常'}",
        f"场景标签：{_join(request.tags) or '无'}",
        f"提示说明：{request.notes or '无额外说明'}",
        f"涉及食材：{_join(request.ingredient_names) or '未提供'}",
        f"输出尺寸：{request.size or ENTITY_SIZES_BY_MODE[request.mode][MediaEntityType.RECIPE]}",
    ]
    return "\n".join(
        [
            "为菜谱生成一张突出真实成菜状态的家庭静物图，同时保持克制、温暖和家庭感。",
            *detail,
            "构图要自然平衡，主体清晰但不过分居中，左右都保留有真实食物、餐具或厨房环境细节。",
            "画面使用暖色自然光、奶油白或浅暖色家庭厨房/餐桌背景，整体明亮通透，适合做菜谱封面。",
            "不要把主体压到边缘，不要生成大片纯色留白，不要卡片封面式僵硬居中。",
            "避免文字、水印、标签牌、人物、手部、暗色餐厅风、夸张餐厅摆盘、飞溅特效、商业广告构图和过度摆拍。",
        ]
    )


def FOOD_SCENE_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"食物场景名称：{request.title or request.scene or '家庭用餐场景'}",
        f"场景说明：{request.notes or '适合家庭日常安排的一组食物入口'}",
        f"场景标签：{_join(request.tags) or request.scene or '家庭日常'}",
        f"代表食材/菜品线索：{_join(request.ingredient_names + request.food_names) or '不指定具体菜品'}",
    ]
    return "\n".join(
        [
            "为食物场景入口生成一张统一风格主图，画面表达这个用餐场景的氛围和食材方向，而不是某一道具体菜的广告图。",
            *detail,
            "画面中可以出现一到三样相关家庭菜、食材或餐具作为线索，但主体仍要简洁、留白稳定、适合做圆角卡片封面。",
            "不要出现人物、手、文字、菜单、标签牌、品牌包装或复杂餐桌陈列。",
        ]
    )


def MEAL_LOG_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    meal_label = MEAL_TYPE_LABELS.get(request.meal_type, "家庭用餐")
    detail = [
        f"用餐类型：{meal_label}",
        f"餐食名称：{_join(request.food_names) or '家庭餐食'}",
        f"记录备注：{request.notes or '无额外备注'}",
    ]
    return "\n".join(
        [
            "为一顿家庭用餐生成一张统一风格静物图，不保留纪实抓拍感。",
            *detail,
            "画面像安静整理后的家庭餐桌静物，不出现人物、手部或现场混乱背景。",
        ]
    )


def build_ai_image_prompt(request: ImageGenerationRequest) -> str:
    entity_prompt = {
        MediaEntityType.INGREDIENT: INGREDIENT_PROMPT_BUILDER,
        MediaEntityType.FOOD: FOOD_PROMPT_BUILDER,
        MediaEntityType.RECIPE: RECIPE_PROMPT_BUILDER,
        MediaEntityType.RECIPE_SCENE: FOOD_SCENE_PROMPT_BUILDER,
        MediaEntityType.FOOD_SCENE: FOOD_SCENE_PROMPT_BUILDER,
        MediaEntityType.MEAL_LOG: MEAL_LOG_PROMPT_BUILDER,
    }[request.entity_type](request)

    sections = [BASE_STYLE_PROMPT, entity_prompt]
    if request.mode == ImageGenerationMode.REFERENCE:
        sections.append(REFERENCE_MODE_APPENDIX)
    return "\n\n".join(section.strip() for section in sections if section.strip())


def _svg_palette(seed_text: str) -> tuple[str, str, str, str]:
    palette = [
        ("#faf5ee", "#e9d8bd", "#b78663", "#8ea08a"),
        ("#faf3ea", "#decbb1", "#c18a65", "#93a497"),
        ("#f8f2e8", "#dbc5a5", "#b97a57", "#8aa093"),
        ("#f9f3eb", "#e1ceb8", "#c58a6c", "#95a08a"),
    ]
    index = sum(ord(char) for char in seed_text) % len(palette)
    return palette[index]


def _resolve_placeholder_size(request: ImageGenerationRequest) -> tuple[int, int]:
    if request.size:
        width_text, separator, height_text = request.size.partition("*")
        if separator:
            try:
                width = int(width_text)
                height = int(height_text)
            except ValueError:
                width = 0
                height = 0
            if width > 0 and height > 0:
                return width, height
    return (1536, 1152) if request.entity_type == MediaEntityType.INGREDIENT else (1600, 1000)


def _render_placeholder_svg(request: ImageGenerationRequest) -> str:
    seed = request.title or _join(request.food_names) or _join(request.ingredient_names) or request.entity_type.value
    base, plate, accent, herb = _svg_palette(seed)
    width, height = _resolve_placeholder_size(request)
    shift_x = (sum(ord(char) for char in seed) % 64) - 32
    shift_y = (sum(ord(char) * 3 for char in seed) % 40) - 20
    tilt = (sum(ord(char) * 5 for char in seed) % 14) - 7
    return f"""
    <svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="{width}" height="{height}" rx="54" fill="{base}"/>
      <circle cx="{width*0.28 + shift_x:.1f}" cy="{height*0.24 + shift_y/2:.1f}" r="{min(width, height)*0.145:.1f}" fill="white" fill-opacity="0.18"/>
      <circle cx="{width*0.72 - shift_x:.1f}" cy="{height*0.25 - shift_y/3:.1f}" r="{min(width, height)*0.155:.1f}" fill="{accent}" fill-opacity="0.08"/>
      <ellipse cx="{width*0.5 + shift_x/3:.1f}" cy="{height*0.58 + shift_y/3:.1f}" rx="{width*0.2:.1f}" ry="{height*0.22:.1f}" fill="{herb}" fill-opacity="0.08"/>
      <ellipse cx="{width*0.44 + shift_x/2:.1f}" cy="{height*0.56 + shift_y:.1f}" rx="{width*0.13:.1f}" ry="{height*0.18:.1f}" transform="rotate({tilt} {width*0.44 + shift_x/2:.1f} {height*0.56 + shift_y:.1f})" fill="white" fill-opacity="0.28"/>
      <ellipse cx="{width*0.56 - shift_x/2:.1f}" cy="{height*0.54 - shift_y/2:.1f}" rx="{width*0.145:.1f}" ry="{height*0.19:.1f}" transform="rotate({-tilt} {width*0.56 - shift_x/2:.1f} {height*0.54 - shift_y/2:.1f})" fill="{plate}" fill-opacity="0.22"/>
      <path d="M{width*0.61:.1f} {height*0.34:.1f}C{width*0.63:.1f} {height*0.31:.1f} {width*0.66:.1f} {height*0.29:.1f} {width*0.69:.1f} {height*0.29:.1f}C{width*0.68:.1f} {height*0.33:.1f} {width*0.66:.1f} {height*0.37:.1f} {width*0.63:.1f} {height*0.4:.1f}C{width*0.61:.1f} {height*0.43:.1f} {width*0.58:.1f} {height*0.44:.1f} {width*0.54:.1f} {height*0.44:.1f}C{width*0.55:.1f} {height*0.39:.1f} {width*0.57:.1f} {height*0.36:.1f} {width*0.61:.1f} {height*0.34:.1f}Z" fill="white" fill-opacity="0.78"/>
      <path d="M{width*0.57:.1f} {height*0.38:.1f}C{width*0.59:.1f} {height*0.35:.1f} {width*0.62:.1f} {height*0.34:.1f} {width*0.65:.1f} {height*0.34:.1f}C{width*0.64:.1f} {height*0.38:.1f} {width*0.62:.1f} {height*0.41:.1f} {width*0.6:.1f} {height*0.44:.1f}C{width*0.58:.1f} {height*0.47:.1f} {width*0.56:.1f} {height*0.48:.1f} {width*0.53:.1f} {height*0.48:.1f}C{width*0.54:.1f} {height*0.44:.1f} {width*0.55:.1f} {height*0.41:.1f} {width*0.57:.1f} {height*0.38:.1f}Z" fill="{accent}" fill-opacity="0.42"/>
      <ellipse cx="{width*0.5:.1f}" cy="{height*0.54:.1f}" rx="{width*0.065:.1f}" ry="{height*0.088:.1f}" fill="white" fill-opacity="0.32"/>
    </svg>
    """.strip()


def _normalize_request(request: ImageGenerationRequest) -> ImageGenerationRequest:
    if request.size:
        return request
    return replace(request, size=ENTITY_SIZES_BY_MODE[request.mode][request.entity_type])


def _guess_reference_mime_type(filename: str | None) -> str:
    mime_type, _ = mimetypes.guess_type(filename or "")
    if mime_type not in SUPPORTED_REFERENCE_MIME_TYPES:
        raise ValueError("参考图仅支持 JPG、PNG、WEBP、BMP")
    return mime_type


def _encode_reference_data_uri(binary_payload: bytes | None, filename: str | None) -> str:
    if not binary_payload:
        raise ValueError("缺少参考图内容")
    mime_type = _guess_reference_mime_type(filename)
    encoded = base64.b64encode(binary_payload).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_provider_error(payload: dict) -> str | None:
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    for key in ("message", "msg"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    output = payload.get("output")
    if isinstance(output, dict):
        for key in ("message", "msg"):
            value = output.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _extract_image_url(payload: dict) -> str:
    output = payload.get("output")
    if not isinstance(output, dict):
        raise RuntimeError("图像生成服务未返回有效结果")

    choices = output.get("choices")
    if not isinstance(choices, list):
        raise RuntimeError(_extract_provider_error(payload) or "图像生成结果缺少 choices")

    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            image_url = item.get("image")
            if isinstance(image_url, str) and image_url.strip():
                return image_url.strip()

    raise RuntimeError(_extract_provider_error(payload) or "图像生成结果中未找到图片地址")


def _infer_extension_from_url(url: str) -> str | None:
    path = Path(unquote(urlparse(url).path))
    suffix = path.suffix.lower()
    return suffix if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"} else None


def _format_openai_size(size: str) -> str:
    if not size:
        return "auto"
    normalized = size.strip().lower().replace("*", "x")
    if normalized in {"auto", "1024x1024", "1536x1024", "1024x1536"}:
        return normalized
    width_text, separator, height_text = normalized.partition("x")
    if not separator:
        return "auto"
    try:
        width = int(width_text)
        height = int(height_text)
    except ValueError:
        return "auto"
    if width <= 0 or height <= 0:
        return "auto"
    ratio = width / height
    if ratio > 1.15:
        return "1536x1024"
    if ratio < 0.87:
        return "1024x1536"
    return "1024x1024"


def _normalize_openai_output_format(output_format: str) -> str:
    normalized = output_format.strip().lower().lstrip(".")
    return normalized if normalized in {"png", "jpeg", "webp"} else "png"


def _openai_mime_type(output_format: str) -> str:
    return "image/jpeg" if output_format == "jpeg" else f"image/{output_format}"


def _extract_openai_image_payload(payload: dict) -> tuple[bytes | None, str | None]:
    data = payload.get("data")
    if not isinstance(data, list):
        raise RuntimeError(_extract_provider_error(payload) or "OpenAI 图像生成结果缺少 data")
    for item in data:
        if not isinstance(item, dict):
            continue
        b64_json = item.get("b64_json")
        if isinstance(b64_json, str) and b64_json.strip():
            try:
                return base64.b64decode(b64_json), None
            except ValueError as exc:
                raise RuntimeError("OpenAI 图像生成返回了无效 base64 数据") from exc
        image_url = item.get("url")
        if isinstance(image_url, str) and image_url.strip():
            return None, image_url.strip()
    raise RuntimeError(_extract_provider_error(payload) or "OpenAI 图像生成结果中未找到图片数据")


class BaseImageGenerationProvider:
    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:  # pragma: no cover - interface
        raise NotImplementedError

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:  # pragma: no cover - interface
        raise NotImplementedError


class MockImageGenerationProvider(BaseImageGenerationProvider):
    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        return ImageGenerationResult(
            prompt=build_ai_image_prompt(normalized),
            svg_markup=_render_placeholder_svg(normalized),
            file_extension=".svg",
            mime_type="image/svg+xml",
        )

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        return ImageGenerationResult(
            prompt=build_ai_image_prompt(normalized),
            svg_markup=_render_placeholder_svg(normalized),
            file_extension=".svg",
            mime_type="image/svg+xml",
        )


class DashScopeImageGenerationProvider(BaseImageGenerationProvider):
    def __init__(self, config: ImageProviderConfig) -> None:
        self.base_url = (config.api_base or DEFAULT_DASHSCOPE_BASE_URL).rstrip("/")
        self.api_key = config.api_key
        self.model = config.model
        self.timeout = httpx.Timeout(120.0, connect=10.0, read=120.0, write=30.0)

    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        return self._generate(
            request=normalized,
            model=self.model,
            prompt=prompt,
            content=[{"text": prompt}],
        )

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        return self._generate(
            request=normalized,
            model=self.model,
            prompt=prompt,
            content=[
                {"text": prompt},
                {"image": _encode_reference_data_uri(normalized.reference_image_bytes, normalized.reference_filename)},
            ],
        )

    def _generate(
        self,
        *,
        request: ImageGenerationRequest,
        model: str,
        prompt: str,
        content: list[dict[str, str]],
    ) -> ImageGenerationResult:
        payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": content,
                    }
                ]
            },
            "parameters": {
                "size": request.size,
                "n": 1,
                "watermark": False,
            },
        }

        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.base_url}{DASHSCOPE_SYNC_ENDPOINT}",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                response.raise_for_status()
                response_payload = response.json()
                image_url = _extract_image_url(response_payload)
                download_response = client.get(image_url, follow_redirects=True)
                download_response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise RuntimeError("调用 Wan 图片生成服务失败") from exc
        except ValueError as exc:  # pragma: no cover - invalid provider response
            raise RuntimeError("Wan 图像生成返回了无效响应") from exc

        content_type = download_response.headers.get("content-type", "").split(";")[0].strip().lower()
        file_extension = CONTENT_TYPE_TO_EXTENSION.get(content_type) or _infer_extension_from_url(image_url) or ".png"
        mime_type = content_type or "image/png"
        return ImageGenerationResult(
            prompt=prompt,
            binary_content=download_response.content,
            file_extension=file_extension,
            mime_type=mime_type,
        )


class OpenAIImageGenerationProvider(BaseImageGenerationProvider):
    def __init__(self, config: ImageProviderConfig) -> None:
        self.base_url = (config.api_base or DEFAULT_OPENAI_BASE_URL).rstrip("/")
        self.api_key = config.api_key
        self.model = config.model or "gpt-image-2"
        self.timeout = httpx.Timeout(180.0, connect=10.0, read=180.0, write=60.0)

    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        output_format = _normalize_openai_output_format(normalized.output_format)
        payload = {
            "model": self.model,
            "prompt": prompt,
            "size": _format_openai_size(normalized.size),
            "n": 1,
            "output_format": output_format,
        }
        return self._post_json_image(
            endpoint=OPENAI_IMAGE_GENERATIONS_ENDPOINT,
            payload=payload,
            prompt=prompt,
            output_format=output_format,
        )

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        output_format = _normalize_openai_output_format(normalized.output_format)
        if not normalized.reference_image_bytes:
            raise ValueError("缺少参考图内容")
        mime_type = _guess_reference_mime_type(normalized.reference_filename)
        files = {
            "image": (
                normalized.reference_filename or "reference.png",
                normalized.reference_image_bytes,
                mime_type,
            )
        }
        data = {
            "model": self.model,
            "prompt": prompt,
            "size": _format_openai_size(normalized.size),
            "n": "1",
            "output_format": output_format,
        }
        return self._post_multipart_image(
            endpoint=OPENAI_IMAGE_EDITS_ENDPOINT,
            data=data,
            files=files,
            prompt=prompt,
            output_format=output_format,
        )

    def _post_json_image(
        self,
        *,
        endpoint: str,
        payload: dict,
        prompt: str,
        output_format: str,
    ) -> ImageGenerationResult:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.base_url}{endpoint}",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                response_payload = response.json()
                if response.is_error:
                    raise RuntimeError(_extract_provider_error(response_payload) or "OpenAI 图像生成服务返回错误")
                return self._result_from_payload(client, response_payload, prompt, output_format)
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise RuntimeError("调用 OpenAI 图片生成服务失败") from exc
        except ValueError as exc:  # pragma: no cover - invalid provider response
            raise RuntimeError("OpenAI 图像生成返回了无效响应") from exc

    def _post_multipart_image(
        self,
        *,
        endpoint: str,
        data: dict[str, str],
        files: dict[str, tuple[str, bytes, str]],
        prompt: str,
        output_format: str,
    ) -> ImageGenerationResult:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.base_url}{endpoint}",
                    data=data,
                    files=files,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                response_payload = response.json()
                if response.is_error:
                    raise RuntimeError(_extract_provider_error(response_payload) or "OpenAI 图像编辑服务返回错误")
                return self._result_from_payload(client, response_payload, prompt, output_format)
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise RuntimeError("调用 OpenAI 图片编辑服务失败") from exc
        except ValueError as exc:  # pragma: no cover - invalid provider response
            raise RuntimeError("OpenAI 图像编辑返回了无效响应") from exc

    def _result_from_payload(
        self,
        client: httpx.Client,
        payload: dict,
        prompt: str,
        output_format: str,
    ) -> ImageGenerationResult:
        binary_content, image_url = _extract_openai_image_payload(payload)
        mime_type = _openai_mime_type(output_format)
        file_extension = ".jpg" if output_format == "jpeg" else f".{output_format}"
        if binary_content is None and image_url:
            download_response = client.get(image_url, follow_redirects=True)
            download_response.raise_for_status()
            content_type = download_response.headers.get("content-type", "").split(";")[0].strip().lower()
            binary_content = download_response.content
            mime_type = content_type or mime_type
            file_extension = CONTENT_TYPE_TO_EXTENSION.get(content_type) or _infer_extension_from_url(image_url) or file_extension
        return ImageGenerationResult(
            prompt=prompt,
            binary_content=binary_content,
            file_extension=file_extension,
            mime_type=mime_type,
        )


def _build_provider_config(mode: ImageGenerationMode) -> ImageProviderConfig:
    settings = get_settings()
    if mode == ImageGenerationMode.REFERENCE:
        reference_provider = settings.ai_image_reference_provider
        reference_provider_name = reference_provider.strip().lower()
        reference_is_openai = reference_provider_name in {"openai", "openai-compatible", "compatible", "custom"}
        return ImageProviderConfig(
            provider=reference_provider,
            api_base=settings.ai_image_reference_api_base or (DEFAULT_OPENAI_BASE_URL if reference_is_openai else DEFAULT_DASHSCOPE_BASE_URL),
            api_key=settings.ai_image_reference_api_key,
            model=settings.ai_image_reference_model or ("gpt-image-2" if reference_is_openai else "wan2.6-image"),
        )
    text_provider = settings.ai_image_text_provider
    text_provider_name = text_provider.strip().lower()
    text_is_openai = text_provider_name in {"openai", "openai-compatible", "compatible", "custom"}
    return ImageProviderConfig(
        provider=text_provider,
        api_base=settings.ai_image_text_api_base or (DEFAULT_OPENAI_BASE_URL if text_is_openai else DEFAULT_DASHSCOPE_BASE_URL),
        api_key=settings.ai_image_text_api_key,
        model=settings.ai_image_text_model or ("gpt-image-2" if text_is_openai else "wan2.6-t2i"),
    )


def _resolve_provider(mode: ImageGenerationMode) -> BaseImageGenerationProvider:
    config = _build_provider_config(mode)
    provider_name = config.provider.strip().lower()
    if provider_name in {"", "disabled", "mock"} or not config.api_key:
        return MockImageGenerationProvider()
    if provider_name == "dashscope":
        return DashScopeImageGenerationProvider(config)
    if provider_name in {"openai", "openai-compatible", "compatible", "custom"}:
        return OpenAIImageGenerationProvider(config)
    raise RuntimeError(f"Unsupported image provider: {config.provider}")


class ImageGenerationClient:
    def __init__(
        self,
        *,
        text_provider: BaseImageGenerationProvider | None = None,
        reference_provider: BaseImageGenerationProvider | None = None,
    ) -> None:
        self.text_provider = text_provider or _resolve_provider(ImageGenerationMode.TEXT)
        self.reference_provider = reference_provider or _resolve_provider(ImageGenerationMode.REFERENCE)

    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        return self.text_provider.generate_from_text(request)

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        return self.reference_provider.generate_from_reference(request)
