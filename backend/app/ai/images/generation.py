from __future__ import annotations

import base64
import mimetypes
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from app.core.enums import ImageGenerationMode, MealType, MediaEntityType
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
)
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import DispatchPermit

if TYPE_CHECKING:
    from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter

STYLE_KEY = "culina-still-life-v1"
PROMPT_VERSION = "7"
DASHSCOPE_SYNC_ENDPOINT = "/services/aigc/multimodal-generation/generation"
OPENAI_IMAGE_GENERATIONS_ENDPOINT = "/images/generations"
OPENAI_IMAGE_EDITS_ENDPOINT = "/images/edits"
STANDARD_IMAGE_SIZE = "1536*1152"

BASE_STYLE_PROMPT = """
你是一名为 Culina 家庭饮食应用拍摄统一主图的美食静物摄影师。
最终画面应是半写实、干净、温暖的厨房或餐桌静物摄影，适合中国家庭日常饮食语境。
先判断主体的真实形态和使用场景，再决定呈现方式；包装、容器、外壳、切面、纹理、自然颜色和摆放方式如果是识别主体的重要特征，应保留并重新整理为干净自然的主图，如果只是无关杂物，则简化或移除。
画面统一为约 4:3 卡片比例并重新构图，视觉焦点明确，主体和关键特征位于中央安全区，四周保留稳定边距，轻微裁切后仍完整可辨识。
不要默认把所有主体放进盘子里；根据主体自然选择无容器、原包装、存储容器、烹饪器具或餐具，容器和道具只在帮助识别主体或符合真实家庭使用场景时出现。
布光为柔和自然侧光，整体明亮通透，以暖中性、浅木色、奶油白和低饱和背景为主；食材、食物和包装本身的自然颜色应真实保留。
背景可以是干净台面、浅色餐具或安静厨房环境，只允许少量帮助识别主体的辅助道具，避免杂乱和过度摆拍。
图像内部不要凭空新增文字、字母、数字、真实 logo、商标、品牌名、条码、标题、标签、字幕、菜单、水印或装饰性排版；如果这些信息来自参考图且属于主体身份或包装识别的一部分，可以保留。
当主体包含包装、瓶罐或标签时，可以保留包装的形状、材质、主色、文字、标识和整体视觉节奏；文字和品牌信息应以参考图为准，不要新增、替换或臆造参考图中没有的信息。
避免人物、手部、杂乱背景、强反光、重阴影、夸张滤镜、高饱和网红感、商业广告构图、戏剧化打光和千篇一律的盘装摆拍。
""".strip()

PROFILE_STYLE_PROMPT = """
你是一名为 Culina 家庭饮食应用制作资料图的视觉设计师。
最终画面应温暖、明亮、干净、克制，适合家庭厨房产品中的头像、家庭封面或资料卡使用。
画面统一为约 4:3 卡片比例并重新构图，视觉焦点明确，主体位于中央安全区，四周保留稳定边距，轻微裁切后仍完整可辨识。
可以使用柔和摄影感、温暖插画感或抽象厨房元素，但整体应保持 Culina 的浅色、低饱和、家庭日常气质。
图像内部不要凭空新增文字、字母、数字、真实 logo、商标、品牌名、标签、字幕、菜单、水印或装饰性排版；如果这些信息来自参考图且是用户想保留的身份线索，可以保留。
避免杂乱背景、强反光、重阴影、夸张滤镜、高饱和网红感、商业广告构图和戏剧化打光。
""".strip()

REFERENCE_MODE_APPENDIX = """
参考图只用于识别主体身份、真实形态和必要特征，包括外形、颜色、质地、切面、容器或包装结构；不要把参考图当作构图、光线、背景、色调或摄影风格模板。
生成结果必须像“重新在 Culina 统一摄影棚里拍了一张标准主图”，而不是对原照片做修图、抠图、临摹或风格迁移。
必须重新构建为与纯文字生成模式一致的 Culina house style：柔和自然侧光、浅色低饱和背景、干净台面或安静厨房环境、少量克制辅助道具。
如果包装、容器、标签或标识是主体身份的一部分，可以保留其形状、材质、主色、整体布局气质以及参考图中已有的可读文字、真实 logo、商标、条码或说明文字。
不要复制原图的拍摄角度、取景比例、桌面材质、环境、阴影、滤镜、曝光、杂乱程度、手机随手拍质感或商品硬广质感。
移除或简化原图里的无关杂物、噪点、桌面凌乱、手部、反射和环境色污染。
如果参考图中存在文字、logo、包装印刷、标签贴纸、店名、菜单字样或水印，先判断它是否属于主体身份或用户要保留的包装信息；属于主体信息时可以保留，不属于主体信息时简化或移除。
即使参考图主体原本靠边、过暗、过曝、被遮挡、角度随意或背景复杂，也要重新整理到中央安全区，保留主体完整轮廓和稳定边距。
如果参考图与文字信息冲突，以文字信息和 Culina 统一风格优先；参考图仅作为主体识别补充。
""".strip()

MEAL_TYPE_LABELS = {
    MealType.BREAKFAST: "早餐",
    MealType.LUNCH: "午餐",
    MealType.DINNER: "晚餐",
    MealType.SNACK: "加餐/夜宵",
}

ENTITY_SIZES_BY_MODE = {
    ImageGenerationMode.TEXT: {
        MediaEntityType.USER: STANDARD_IMAGE_SIZE,
        MediaEntityType.FAMILY: STANDARD_IMAGE_SIZE,
        MediaEntityType.INGREDIENT: STANDARD_IMAGE_SIZE,
        MediaEntityType.FOOD: STANDARD_IMAGE_SIZE,
        MediaEntityType.RECIPE: STANDARD_IMAGE_SIZE,
        MediaEntityType.RECIPE_SCENE: STANDARD_IMAGE_SIZE,
        MediaEntityType.FOOD_SCENE: STANDARD_IMAGE_SIZE,
        MediaEntityType.MEAL_LOG: STANDARD_IMAGE_SIZE,
    },
    ImageGenerationMode.REFERENCE: {
        MediaEntityType.USER: STANDARD_IMAGE_SIZE,
        MediaEntityType.FAMILY: STANDARD_IMAGE_SIZE,
        MediaEntityType.INGREDIENT: STANDARD_IMAGE_SIZE,
        MediaEntityType.FOOD: STANDARD_IMAGE_SIZE,
        MediaEntityType.RECIPE: STANDARD_IMAGE_SIZE,
        MediaEntityType.RECIPE_SCENE: STANDARD_IMAGE_SIZE,
        MediaEntityType.FOOD_SCENE: STANDARD_IMAGE_SIZE,
        MediaEntityType.MEAL_LOG: STANDARD_IMAGE_SIZE,
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
    # Provider identity is safe diagnostic metadata.  Never put provider
    # response bodies, prompts, or image URLs in a job or usage receipt.
    reported_model: str | None = None
    provider_request_id: str | None = None


@dataclass(frozen=True, slots=True)
class MeteredImageGenerationResult:
    """One generated image paired with its settled model-usage event."""

    image: ImageGenerationResult
    usage_event_id: str


class ImageGenerationProviderError(RuntimeError):
    """Safe provider outcome for image-job recovery decisions."""

    def __init__(self, code: str, *, provider_request_id: str | None = None) -> None:
        self.code = code
        self.provider_request_id = provider_request_id
        self.usage_event_id: str | None = None
        super().__init__(code)


class ImageGenerationProviderRejected(ImageGenerationProviderError):
    """The provider (or local validation) confirmed no billable image ran."""


class ImageGenerationProviderOutcomeUncertain(ImageGenerationProviderError):
    """A send may have reached the provider; it must never be auto-replayed."""


@dataclass(frozen=True, slots=True)
class ImageProviderDependencies:
    """Short-lived dependencies used to send one family-bound image request.

    The binding deliberately contains no credential.  A concrete provider only
    invokes ``resolve_dispatch_credential`` after the caller has obtained a
    dispatch permit, which pins the active secret version for that physical
    request.
    """

    transport: ProviderTransport
    resolve_dispatch_credential: Callable[
        [ResolvedCapabilityBinding, str | None], DispatchCredential
    ]


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


def USER_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"成员显示名：{request.title or '家庭成员'}",
        f"角色/身份：{request.category or '家庭成员'}",
        f"补充信息：{request.notes or '无额外说明'}",
    ]
    return "\n".join(
        [
            "为家庭厨房应用生成一张温暖、克制的成员头像图。",
            *detail,
            "画面可以使用柔和人物插画、厨房相关小物或抽象头像构成，但不要生成可识别真人照片。",
            "按完整原图构图，主体居中，背景干净明亮，前端展示时可再做圆形遮罩。",
            "不要出现文字、姓名、Logo、水印、手部或复杂背景。",
        ]
    )


def FAMILY_PROMPT_BUILDER(request: ImageGenerationRequest) -> str:
    detail = [
        f"家庭名称：{request.title or '家庭厨房'}",
        f"所在位置：{request.category or '未提供'}",
        f"家庭口号/说明：{request.notes or '无额外说明'}",
    ]
    return "\n".join(
        [
            "为家庭厨房应用生成一张家庭封面图或家庭资料图，表达温暖、明亮、真实的家庭厨房氛围。",
            *detail,
            "主体可以是餐桌、厨房台面、绿植、餐具和少量家常食物，不出现人物。",
            "不要出现文字、Logo、水印、品牌包装、餐厅广告风或暗色背景。",
        ]
    )


def build_ai_image_prompt(request: ImageGenerationRequest) -> str:
    entity_prompt = {
        MediaEntityType.USER: USER_PROMPT_BUILDER,
        MediaEntityType.FAMILY: FAMILY_PROMPT_BUILDER,
        MediaEntityType.INGREDIENT: INGREDIENT_PROMPT_BUILDER,
        MediaEntityType.FOOD: FOOD_PROMPT_BUILDER,
        MediaEntityType.RECIPE: RECIPE_PROMPT_BUILDER,
        MediaEntityType.RECIPE_SCENE: FOOD_SCENE_PROMPT_BUILDER,
        MediaEntityType.FOOD_SCENE: FOOD_SCENE_PROMPT_BUILDER,
        MediaEntityType.MEAL_LOG: MEAL_LOG_PROMPT_BUILDER,
    }[request.entity_type](request)

    base_prompt = PROFILE_STYLE_PROMPT if request.entity_type in {MediaEntityType.USER, MediaEntityType.FAMILY} else BASE_STYLE_PROMPT
    sections = [base_prompt, entity_prompt]
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


def normalize_image_generation_request(request: ImageGenerationRequest) -> ImageGenerationRequest:
    """Use the actual provider dimensions for both billing and generation."""

    return replace(request, size=ENTITY_SIZES_BY_MODE[request.mode][request.entity_type])


# Keep the private spelling for existing internal call sites while making the
# billing boundary explicit to the image-job worker.
_normalize_request = normalize_image_generation_request


def _provider_request_id(response: ProviderResponse) -> str | None:
    return (
        response.header("x-request-id")
        or response.header("request-id")
        or response.header("x-dashscope-request-id")
        or None
    )


def _is_confirmed_not_executed_status(status_code: int) -> bool:
    # These request-level rejections have not entered image generation.  All
    # transport failures, 5xx responses, malformed success bodies, and image
    # download errors remain deliberately uncertain.
    return status_code in {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}


def _classify_provider_request_status(response: ProviderResponse) -> ImageGenerationProviderError:
    request_id = _provider_request_id(response)
    if _is_confirmed_not_executed_status(response.status_code):
        return ImageGenerationProviderRejected(
            "image_provider_request_rejected",
            provider_request_id=request_id,
        )
    return ImageGenerationProviderOutcomeUncertain(
        "image_provider_outcome_uncertain",
        provider_request_id=request_id,
    )


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
    def generate_from_text(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:  # pragma: no cover - interface
        raise NotImplementedError

    def generate_from_reference(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:  # pragma: no cover - interface
        raise NotImplementedError


class MockImageGenerationProvider(BaseImageGenerationProvider):
    def generate_from_text(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        del permit
        normalized = _normalize_request(request)
        return ImageGenerationResult(
            prompt=build_ai_image_prompt(normalized),
            svg_markup=_render_placeholder_svg(normalized),
            file_extension=".svg",
            mime_type="image/svg+xml",
        )

    def generate_from_reference(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        del permit
        normalized = _normalize_request(request)
        return ImageGenerationResult(
            prompt=build_ai_image_prompt(normalized),
            svg_markup=_render_placeholder_svg(normalized),
            file_extension=".svg",
            mime_type="image/svg+xml",
        )


class _BoundImageGenerationProvider(BaseImageGenerationProvider):
    """Provider base that never stores a decrypted family credential."""

    def __init__(
        self,
        binding: ResolvedCapabilityBinding,
        dependencies: ImageProviderDependencies,
    ) -> None:
        if binding.capability != "image_generation":
            raise ModelUsageContractError("image_binding_required")
        self.binding = binding
        self.dependencies = dependencies

    def _post_json(
        self,
        *,
        suffix: str,
        payload: Mapping[str, Any],
        permit: DispatchPermit | None,
    ) -> ProviderResponse:
        if permit is None:
            # Family credentials are authorized only through the durable usage
            # dispatch boundary.  This prevents an unmetered code path from
            # decrypting a provider key merely because it has a binding.
            raise ModelUsageContractError("image_dispatch_permit_required")
        credential: DispatchCredential | None = None
        try:
            credential = self.dependencies.resolve_dispatch_credential(
                self.binding,
                permit.credential_secret_version_id,
            )
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
            }
            if self.binding.auth_mode == "api_key":
                if not credential.api_key:
                    raise ModelUsageContractError("image_dispatch_credential_required")
                headers["Authorization"] = f"Bearer {credential.api_key}"
            if permit.provider_idempotency_key:
                headers["Idempotency-Key"] = permit.provider_idempotency_key
            return self.dependencies.transport.request(
                "POST",
                _binding_endpoint_url(self.binding, suffix),
                headers=headers,
                json=dict(payload),
            )
        except ImageGenerationProviderError:
            raise
        except (FamilyModelSettingsError, ModelUsageContractError):
            raise
        except Exception as exc:
            # ProviderTransport intentionally exposes only content-free
            # domain errors.  Any unexpected adapter failure is still an
            # ambiguous outcome once the send boundary has been crossed.
            raise ImageGenerationProviderOutcomeUncertain(
                "image_provider_outcome_uncertain"
            ) from exc
        finally:
            credential = None

    def _download_media(self, image_url: str) -> tuple[bytes, str, str]:
        try:
            media = self.dependencies.transport.download_media(
                image_url,
                source=self.binding.endpoint,
                adapter_kind=self.binding.adapter_kind,
            )
        except FamilyModelSettingsError as exc:
            raise ImageGenerationProviderOutcomeUncertain(
                "image_provider_outcome_uncertain"
            ) from exc
        content_type = media.content_type.split(";", 1)[0].strip().lower()
        file_extension = CONTENT_TYPE_TO_EXTENSION.get(content_type) or ".png"
        return media.content, content_type or "image/png", file_extension


class DashScopeImageGenerationProvider(_BoundImageGenerationProvider):
    def generate_from_text(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        return self._generate(
            request=normalized,
            prompt=prompt,
            content=[{"text": prompt}],
            permit=permit,
        )

    def generate_from_reference(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        return self._generate(
            request=normalized,
            prompt=prompt,
            content=[
                {"text": prompt},
                {"image": _encode_reference_data_uri(normalized.reference_image_bytes, normalized.reference_filename)},
            ],
            permit=permit,
        )

    def _generate(
        self,
        *,
        request: ImageGenerationRequest,
        prompt: str,
        content: list[dict[str, str]],
        permit: DispatchPermit | None,
    ) -> ImageGenerationResult:
        payload = {
            "model": self.binding.requested_model,
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
            response = self._post_json(
                suffix=DASHSCOPE_SYNC_ENDPOINT,
                payload=payload,
                permit=permit,
            )
            if not 200 <= response.status_code < 300:
                raise _classify_provider_request_status(response)
            response_payload = response.json()
            if not isinstance(response_payload, dict):
                raise RuntimeError("图像生成服务未返回有效结果")
            image_url = _extract_image_url(response_payload)
            binary_content, mime_type, file_extension = self._download_media(image_url)
        except ImageGenerationProviderError:
            raise
        except (FamilyModelSettingsError, ModelUsageContractError):
            raise
        except Exception as exc:
            # A completed provider request may have produced an image even if
            # parsing or fetching its result later fails; never auto-replay.
            raise ImageGenerationProviderOutcomeUncertain(
                "image_provider_outcome_uncertain",
                provider_request_id=_provider_request_id(response) if "response" in locals() else None,
            ) from exc

        return ImageGenerationResult(
            prompt=prompt,
            binary_content=binary_content,
            file_extension=file_extension,
            mime_type=mime_type,
            reported_model=self.binding.requested_model,
            provider_request_id=_provider_request_id(response),
        )


class OpenAIImageGenerationProvider(_BoundImageGenerationProvider):
    def generate_from_text(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        output_format = _normalize_openai_output_format(normalized.output_format)
        payload = {
            "model": self.binding.requested_model,
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
            permit=permit,
        )

    def generate_from_reference(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        normalized = _normalize_request(request)
        prompt = build_ai_image_prompt(normalized)
        output_format = _normalize_openai_output_format(normalized.output_format)
        if not normalized.reference_image_bytes:
            raise ImageGenerationProviderRejected("image_reference_invalid")
        try:
            mime_type = _guess_reference_mime_type(normalized.reference_filename)
        except ValueError as exc:
            raise ImageGenerationProviderRejected("image_reference_invalid") from exc
        # The family transport owns all outbound sends and intentionally
        # accepts JSON only.  OpenAI-compatible adapters receive the reference
        # as a bounded data URI; adapter validation has already constrained
        # this endpoint shape and the image bytes never enter a durable job
        # payload or trace.
        payload = {
            "model": self.binding.requested_model,
            "prompt": prompt,
            "size": _format_openai_size(normalized.size),
            "n": 1,
            "output_format": output_format,
            "image": _encode_reference_data_uri(
                normalized.reference_image_bytes,
                normalized.reference_filename,
            ),
            "image_mime_type": mime_type,
        }
        return self._post_json_image(
            endpoint=OPENAI_IMAGE_EDITS_ENDPOINT,
            payload=payload,
            prompt=prompt,
            output_format=output_format,
            permit=permit,
        )

    def _post_json_image(
        self,
        *,
        endpoint: str,
        payload: Mapping[str, Any],
        prompt: str,
        output_format: str,
        permit: DispatchPermit | None,
    ) -> ImageGenerationResult:
        try:
            response = self._post_json(
                suffix=endpoint,
                payload=payload,
                permit=permit,
            )
            if not 200 <= response.status_code < 300:
                raise _classify_provider_request_status(response)
            response_payload = response.json()
            if not isinstance(response_payload, dict):
                raise RuntimeError("OpenAI 图像生成结果缺少 data")
            return self._result_from_payload(
                response_payload,
                prompt,
                output_format,
                reported_model=self.binding.requested_model,
                provider_request_id=_provider_request_id(response),
            )
        except ImageGenerationProviderError:
            raise
        except (FamilyModelSettingsError, ModelUsageContractError):
            raise
        except Exception as exc:
            raise ImageGenerationProviderOutcomeUncertain(
                "image_provider_outcome_uncertain",
                provider_request_id=_provider_request_id(response) if "response" in locals() else None,
            ) from exc

    def _result_from_payload(
        self,
        payload: dict,
        prompt: str,
        output_format: str,
        *,
        reported_model: str | None,
        provider_request_id: str | None,
    ) -> ImageGenerationResult:
        binary_content, image_url = _extract_openai_image_payload(payload)
        mime_type = _openai_mime_type(output_format)
        file_extension = ".jpg" if output_format == "jpeg" else f".{output_format}"
        if binary_content is None and image_url:
            binary_content, media_mime_type, media_extension = self._download_media(image_url)
            mime_type = media_mime_type or mime_type
            file_extension = media_extension or file_extension
        return ImageGenerationResult(
            prompt=prompt,
            binary_content=binary_content,
            file_extension=file_extension,
            mime_type=mime_type,
            reported_model=reported_model,
            provider_request_id=provider_request_id,
        )


def _binding_endpoint_url(binding: ResolvedCapabilityBinding, suffix: str) -> str:
    from app.ai.runtime.family_transport import binding_endpoint_url

    return binding_endpoint_url(binding, suffix)


def image_provider_from_adapter(
    binding: ResolvedCapabilityBinding,
    *,
    dependencies: ImageProviderDependencies,
) -> BaseImageGenerationProvider:
    """Select a protocol implementation from an immutable family binding."""

    if binding.capability != "image_generation":
        raise ModelUsageContractError("image_binding_required")
    if binding.adapter_kind == "dashscope_http":
        return DashScopeImageGenerationProvider(binding, dependencies)
    if binding.adapter_kind == "openai_compatible_http":
        return OpenAIImageGenerationProvider(binding, dependencies)
    raise ModelUsageContractError("image_binding_adapter_unsupported")


class ImageGenerationClient:
    def __init__(
        self,
        *,
        text_provider: BaseImageGenerationProvider | None = None,
        reference_provider: BaseImageGenerationProvider | None = None,
    ) -> None:
        # There is deliberately no settings-derived default here.  Production
        # workers must construct this client through ``for_binding``; focused
        # tests may still inject an explicit deterministic provider.
        self.text_provider = text_provider
        self.reference_provider = reference_provider

    @classmethod
    def for_binding(
        cls,
        binding: ResolvedCapabilityBinding,
        *,
        dependencies: ImageProviderDependencies,
    ) -> "ImageGenerationClient":
        provider = image_provider_from_adapter(binding, dependencies=dependencies)
        if binding.variant_key == ImageGenerationMode.TEXT.value:
            return cls(text_provider=provider)
        if binding.variant_key == ImageGenerationMode.REFERENCE.value:
            return cls(reference_provider=provider)
        raise ModelUsageContractError("image_binding_variant_invalid")

    def generate_from_text(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        if self.text_provider is None:
            raise ModelUsageContractError("image_text_provider_not_selected")
        return self.text_provider.generate_from_text(request)

    def generate_from_reference(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        if self.reference_provider is None:
            raise ModelUsageContractError("image_reference_provider_not_selected")
        return self.reference_provider.generate_from_reference(request)

    def generate(
        self,
        request: ImageGenerationRequest,
        *,
        usage_attempt: MeteredProviderAttempt | None = None,
        usage_adapter: ImageGenerationUsageAdapter | None = None,
    ) -> ImageGenerationResult | MeteredImageGenerationResult:
        """Generate one image with an optional reserve → dispatch → settle boundary.

        Provider implementations continue to own their payloads and downloads.
        This façade is the only path that can send a metered request, so the
        worker never needs to infer whether an exception happened before or
        after a remote side effect.
        """

        if usage_attempt is None:
            return self._generate_unmetered(request)
        if usage_adapter is None:
            raise ModelUsageContractError("model_usage_adapter_required")

        # The job worker may persist its provider-attempt boundary immediately
        # after authorization.  Reuse that single permit rather than making a
        # second dispatch transition inside the client.
        permit = usage_attempt.dispatch_permit or usage_attempt.prepare_dispatch()
        try:
            image = self._generate_unmetered(request, permit=permit)
        except ImageGenerationProviderRejected as exc:
            try:
                settlement = usage_attempt.settle(
                    usage_adapter.confirmed_not_executed_receipt(
                        permit,
                        stable_provider_request_id=exc.provider_request_id,
                    )
                )
            except Exception as settlement_exc:
                self._mark_usage_outcome_uncertain(
                    usage_attempt,
                    "image_usage_settlement_failed",
                )
                raise ImageGenerationProviderOutcomeUncertain(
                    "image_usage_settlement_failed",
                    provider_request_id=exc.provider_request_id,
                ) from settlement_exc
            exc.usage_event_id = settlement.event_id
            raise
        except ImageGenerationProviderOutcomeUncertain:
            self._mark_usage_outcome_uncertain(
                usage_attempt,
                "image_provider_outcome_uncertain",
            )
            raise
        except Exception as exc:
            self._mark_usage_outcome_uncertain(
                usage_attempt,
                "image_provider_outcome_uncertain",
            )
            raise ImageGenerationProviderOutcomeUncertain(
                "image_provider_outcome_uncertain"
            ) from exc

        try:
            settlement = usage_attempt.settle(
                usage_adapter.receipt_from_provider_success(
                    permit,
                    reported_model=image.reported_model or usage_adapter.model,
                    provider_request_id=image.provider_request_id,
                )
            )
        except Exception as exc:
            self._mark_usage_outcome_uncertain(
                usage_attempt,
                "image_usage_settlement_failed",
            )
            raise ImageGenerationProviderOutcomeUncertain(
                "image_usage_settlement_failed",
                provider_request_id=image.provider_request_id,
            ) from exc
        return MeteredImageGenerationResult(image=image, usage_event_id=settlement.event_id)

    def _generate_unmetered(
        self,
        request: ImageGenerationRequest,
        *,
        permit: DispatchPermit | None = None,
    ) -> ImageGenerationResult:
        if request.mode == ImageGenerationMode.REFERENCE:
            if self.reference_provider is None:
                raise ModelUsageContractError("image_reference_provider_not_selected")
            if permit is None:
                return self.reference_provider.generate_from_reference(request)
            return self.reference_provider.generate_from_reference(request, permit=permit)
        if self.text_provider is None:
            raise ModelUsageContractError("image_text_provider_not_selected")
        if permit is None:
            return self.text_provider.generate_from_text(request)
        return self.text_provider.generate_from_text(request, permit=permit)

    @staticmethod
    def _mark_usage_outcome_uncertain(
        usage_attempt: MeteredProviderAttempt,
        error_code: str,
    ) -> None:
        try:
            usage_attempt.mark_uncertain(error_code)
        except Exception:
            # The worker still records a terminal, non-retryable image job;
            # never mask an unknown provider outcome with a ledger exception.
            return
