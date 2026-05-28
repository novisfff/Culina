from __future__ import annotations

import json
import re
from typing import Any

from app.ai.kitchen.context import AgentContext
from app.ai.runtime.schemas import AgentRunRequest
from app.core.enums import Difficulty, MediaEntityType
from app.models.domain import Ingredient

STEP_ICONS = {"pan", "tomato", "bowl", "timer", "tip", "plate"}
DIFFICULTIES = {Difficulty.EASY.value, Difficulty.MEDIUM.value, Difficulty.HARD.value}
GENERIC_STEP_TEXTS = {
    "翻炒均匀",
    "煮熟即可",
    "炒熟",
    "调味",
    "出锅",
    "装盘",
    "处理食材",
}
HEAT_TERMS = ("火", "煎", "炒", "煮", "蒸", "焖", "烤", "炖", "沸", "热锅")
TIME_TERMS = ("分钟", "秒", "小时", "刻钟")
STATE_TERMS = ("熟", "变色", "透明", "收汁", "软", "香", "沸", "冒泡", "凝固", "断生", "金黄", "浓稠")
QUALITY_MIN_STEP_COUNT = 3
QUALITY_MAX_STEP_COUNT = 8
RECIPE_DRAFT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "servings", "prep_minutes", "difficulty", "ingredient_items", "steps", "tips", "scene_tags"],
    "properties": {
        "title": {"type": "string"},
        "servings": {"type": "integer", "minimum": 1, "maximum": 12},
        "prep_minutes": {"type": "integer", "minimum": 5, "maximum": 240},
        "difficulty": {"type": "string", "enum": ["easy", "medium", "hard"]},
        "ingredient_items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["ingredient_id", "ingredient_name", "quantity", "unit", "note"],
                "properties": {
                    "ingredient_id": {"type": ["string", "null"]},
                    "ingredient_name": {"type": "string"},
                    "quantity": {"type": "number", "exclusiveMinimum": 0},
                    "unit": {"type": "string"},
                    "note": {"type": "string"},
                },
            },
        },
        "steps": {
            "type": "array",
            "minItems": QUALITY_MIN_STEP_COUNT,
            "maxItems": QUALITY_MAX_STEP_COUNT,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "text", "icon", "summary", "estimated_minutes", "tip", "key_points"],
                "properties": {
                    "title": {"type": "string"},
                    "text": {"type": "string"},
                    "icon": {"type": "string", "enum": ["pan", "tomato", "bowl", "timer", "tip", "plate"]},
                    "summary": {"type": "string"},
                    "estimated_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 60},
                    "tip": {"type": "string"},
                    "key_points": {"type": "array", "maxItems": 3, "items": {"type": "string"}},
                },
            },
        },
        "tips": {"type": "string"},
        "scene_tags": {
            "type": "array",
            "maxItems": 6,
            "items": {"type": "string", "minLength": 1, "pattern": r"^[^,，、/；;\n]+$"},
        },
    },
}


def _string(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def _int(value: Any, fallback: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _float(value: Any, fallback: float, *, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _list_of_strings(value: Any, *, maximum: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
        if len(result) >= maximum:
            break
    return result


def _tag_list(value: Any, *, maximum: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        for tag in re.split(r"[,，、/；;\n]+", item):
            normalized = tag.strip()
            if not normalized or normalized in seen:
                continue
            result.append(normalized)
            seen.add(normalized)
            if len(result) >= maximum:
                return result
    return result


def _subject_list(request: AgentRunRequest, key: str) -> list[str]:
    value = request.subject.get(key)
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _selected_ingredient_lines(context: AgentContext) -> list[str]:
    return [
        f"- id={item.id} 名称={item.name} 分类={item.category} 默认单位={item.default_unit} 存放={item.default_storage}"
        for item in context.ingredients
    ]


def build_recipe_draft_messages(context: AgentContext, request: AgentRunRequest) -> tuple[str, str]:
    title = _string(request.subject.get("title"))
    servings = request.subject.get("servings") or ""
    prep_minutes = request.subject.get("prepMinutes") or request.subject.get("prep_minutes") or ""
    difficulty = request.subject.get("difficulty") or ""
    scene_tags = _subject_list(request, "sceneTags") or _subject_list(request, "scene_tags")
    extra_ingredients = _subject_list(request, "extraIngredients") or _subject_list(request, "extra_ingredients")

    system = """
你是 Culina 的家庭菜谱生成智能体。只输出一个符合 schema 的 JSON object，不输出 Markdown、代码块、解释或额外文本。
硬规则：
- 菜谱必须真实可做，适合家庭厨房复做，不生成品牌、人物、医疗功效或营养治疗承诺。
- 系统食材必须保留对应 ingredient_id，并优先使用默认单位；自由食材 ingredient_id 必须为 null。
- ingredient_items 要包含主料、必要辅料和关键调味料；数量要按 servings 估算，不能都写 1 或“适量”。
- steps 必须 3 到 8 步，覆盖备菜、预处理或烹调、调味收尾、装盘检查。涉及肉蛋海鲜必须写熟透判断。
- 每步 text 至少两句，包含具体动作、用量或比例线索、火力或温度、时间范围、完成状态判断。
- icon 只能是 pan、tomato、bowl、timer、tip、plate；difficulty 只能是 easy、medium、hard。
- summary 概括本步目的，tip 给火候/口味/失败规避建议，key_points 最多 3 条可执行短句。
- scene_tags 必须是字符串数组，每个数组元素只能是一个独立标签，例如 ["家常菜","快手菜"]；禁止输出 ["家常菜、快手菜"] 这种合并标签。
JSON 字段固定为 title、servings、prep_minutes、difficulty、ingredient_items、steps、tips、scene_tags。
""".strip()

    user = "\n".join(
        [
            f"家庭名称：{context.family.name if context.family else '当前家庭'}",
            f"用户想做的菜名：{title or '未指定'}",
            f"用户说明：{request.prompt.strip() or '未填写'}",
            f"期望份量：{servings or '未指定'}",
            f"期望时长：{prep_minutes or '未指定'}",
            f"期望难度：{difficulty or '未指定'}",
            f"场景标签：{'、'.join(scene_tags) if scene_tags else '未指定'}",
            "系统食材：",
            *(_selected_ingredient_lines(context) or ["- 未选择"]),
            f"自由食材：{'、'.join(extra_ingredients) if extra_ingredients else '无'}",
            "请补齐缺失信息，优先生成适合家庭日常复做的菜谱；食材数量要按份量估算，步骤要具体到新手可以照做。",
        ]
    )
    return system, user


def _extract_json(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL | re.IGNORECASE)
    if fence:
        stripped = fence.group(1).strip()

    def try_parse(candidate: str) -> dict[str, Any] | None:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    parsed = try_parse(stripped)
    if parsed is not None:
        return parsed

    start = stripped.find("{")
    while start >= 0:
        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(stripped)):
            char = stripped[index]
            if in_string:
                if escape:
                    escape = False
                    continue
                if char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    candidate = stripped[start : index + 1]
                    parsed = try_parse(candidate)
                    if parsed is not None:
                        return parsed
                    break
        start = stripped.find("{", start + 1)
    return None


def _ingredient_by_id(context: AgentContext) -> dict[str, Ingredient]:
    return {item.id: item for item in context.ingredients}


def _fallback_ingredient_unit(name: str) -> str:
    if any(token in name for token in ["盐", "糖", "胡椒", "孜然", "辣椒粉", "淀粉"]):
        return "克"
    if any(token in name for token in ["生抽", "老抽", "醋", "料酒", "蚝油", "油"]):
        return "勺"
    if any(token in name for token in ["葱", "香菜", "薄荷"]):
        return "根"
    if any(token in name for token in ["蒜"]):
        return "瓣"
    if any(token in name for token in ["姜"]):
        return "片"
    return "份"


def _ingredient_note(name: str, ingredient: Ingredient | None = None) -> str:
    category = ingredient.category if ingredient else ""
    if any(token in name for token in ["盐", "糖", "胡椒", "孜然", "辣椒粉"]):
        return "少量多次加入，出锅前尝味调整"
    if any(token in name for token in ["生抽", "老抽", "醋", "料酒", "蚝油"]):
        return "调味用，先少量加入再按口味补"
    if any(token in name for token in ["油"]):
        return "用于润锅或提香，避免过量"
    if any(token in name for token in ["葱", "姜", "蒜", "香菜"]):
        return "切好备用，用于去腥提香或出锅点缀"
    if any(token in category for token in ["肉", "禽", "水产", "海鲜"]) or any(token in name for token in ["肉", "鸡", "牛", "鱼", "虾"]):
        return "切成均匀小块或薄片，烹调时确认中心熟透"
    if any(token in category for token in ["蔬菜", "菌菇"]) or any(token in name for token in ["菜", "菇", "番茄", "土豆"]):
        return "洗净沥干，切成大小接近的块或片"
    if any(token in category for token in ["蛋", "奶"]) or "蛋" in name:
        return "打散或按菜谱需要处理，避免过度加热"
    return "按菜谱需要清洗、切配并提前备好"


def _fallback_ingredient_quantity(name: str, ingredient: Ingredient | None) -> float:
    unit = ingredient.default_unit if ingredient else _fallback_ingredient_unit(name)
    if unit in {"克", "g"}:
        return 5 if any(token in name for token in ["盐", "糖", "胡椒", "孜然", "辣椒粉", "淀粉"]) else 200
    if unit in {"勺", "汤匙", "小勺"}:
        return 1
    if unit in {"瓣", "片", "根"}:
        return 2
    if unit in {"个", "枚", "颗"}:
        return 2
    if unit in {"斤"}:
        return 0.5
    return 1


def _is_weak_quantity(name: str, quantity: float, raw_value: Any, ingredient: Ingredient | None) -> bool:
    if raw_value is None or not isinstance(raw_value, int | float | str):
        return True
    if quantity <= 0:
        return True
    unit = ingredient.default_unit if ingredient else _fallback_ingredient_unit(name)
    if quantity == 1 and unit in {"份", "个", "枚", "颗"} and not any(token in name for token in ["盐", "糖", "油", "生抽", "老抽", "醋", "料酒"]):
        return True
    return False


def _normalize_ingredient_items(raw_items: Any, context: AgentContext, request: AgentRunRequest) -> list[dict[str, Any]]:
    selected_by_id = _ingredient_by_id(context)
    items: list[dict[str, Any]] = []
    if isinstance(raw_items, list):
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            ingredient_id = raw.get("ingredient_id")
            ingredient = selected_by_id.get(ingredient_id) if isinstance(ingredient_id, str) else None
            name = ingredient.name if ingredient else _string(raw.get("ingredient_name"))
            if not name:
                continue
            quantity = _float(raw.get("quantity"), _fallback_ingredient_quantity(name, ingredient), minimum=0.1, maximum=999)
            if _is_weak_quantity(name, quantity, raw.get("quantity"), ingredient):
                quantity = _fallback_ingredient_quantity(name, ingredient)
            items.append(
                {
                    "ingredient_id": ingredient.id if ingredient else None,
                    "ingredient_name": name,
                    "quantity": quantity,
                    "unit": ingredient.default_unit if ingredient else _string(raw.get("unit"), _fallback_ingredient_unit(name)),
                    "note": _string(raw.get("note"), _ingredient_note(name, ingredient)),
                }
            )

    existing_names = {item["ingredient_name"] for item in items}
    for ingredient in context.ingredients:
        if ingredient.name not in existing_names:
            items.append(
                {
                    "ingredient_id": ingredient.id,
                    "ingredient_name": ingredient.name,
                    "quantity": _fallback_ingredient_quantity(ingredient.name, ingredient),
                    "unit": ingredient.default_unit,
                    "note": _ingredient_note(ingredient.name, ingredient),
                }
            )
    for name in _subject_list(request, "extraIngredients") or _subject_list(request, "extra_ingredients"):
        if name not in existing_names and all(item["ingredient_name"] != name for item in items):
            items.append(
                {
                    "ingredient_id": None,
                    "ingredient_name": name,
                    "quantity": _fallback_ingredient_quantity(name, None),
                    "unit": _fallback_ingredient_unit(name),
                    "note": _ingredient_note(name),
                }
            )

    return items[:12]


def _draft_subject_names(context: AgentContext, request: AgentRunRequest) -> list[str]:
    return [item.name for item in context.ingredients] + (_subject_list(request, "extraIngredients") or _subject_list(request, "extra_ingredients"))


def _has_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _is_low_quality_step(text: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    if len(compact) < 24:
        return True
    if compact in GENERIC_STEP_TEXTS:
        return True
    quality_signals = sum(
        [
            _has_any(compact, HEAT_TERMS),
            _has_any(compact, TIME_TERMS),
            _has_any(compact, STATE_TERMS),
        ]
    )
    return quality_signals < 2


def _normalize_step(raw_step: dict[str, Any], index: int) -> dict[str, Any] | None:
    text = _string(raw_step.get("text"))
    if _is_low_quality_step(text):
        return None
    title = _string(raw_step.get("title"), f"步骤 {index + 1}")
    summary = _string(raw_step.get("summary"), title)
    tip = _string(raw_step.get("tip"), "按实际火力和食材状态微调时间。")
    key_points = _list_of_strings(raw_step.get("key_points"), maximum=3) or [title]
    icon = _string(raw_step.get("icon"), "pan")
    return {
        "title": title,
        "text": text,
        "icon": icon if icon in STEP_ICONS else "pan",
        "summary": summary,
        "estimated_minutes": _int(raw_step.get("estimated_minutes"), 5, minimum=1, maximum=60),
        "tip": tip,
        "key_points": key_points[:3],
    }


def _normalize_steps(raw_steps: Any, context: AgentContext, request: AgentRunRequest) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    if isinstance(raw_steps, list):
        for index, raw in enumerate(raw_steps):
            if isinstance(raw, str):
                text = raw.strip()
                raw = {}
            elif isinstance(raw, dict):
                text = _string(raw.get("text"))
            else:
                continue
            if not text:
                continue
            step = _normalize_step({**raw, "text": text}, index)
            if step is not None:
                steps.append(step)
    return steps[:QUALITY_MAX_STEP_COUNT]


def normalize_recipe_draft(raw_text: str, context: AgentContext, request: AgentRunRequest) -> dict[str, Any] | None:
    payload = _extract_json(raw_text)
    if payload is None:
        return None

    difficulty = payload.get("difficulty")
    subject_names = _draft_subject_names(context, request)
    default_title = _string(request.subject.get("title")) or (f"{subject_names[0]}家常菜" if subject_names else "")
    default_scene_tags = _subject_list(request, "sceneTags") or _subject_list(request, "scene_tags")
    ingredient_items = _normalize_ingredient_items(payload.get("ingredient_items"), context, request)
    steps = _normalize_steps(payload.get("steps"), context, request)
    if not _string(payload.get("title"), default_title) or not ingredient_items or len(steps) < QUALITY_MIN_STEP_COUNT:
        return None
    draft = {
        "title": _string(payload.get("title"), default_title),
        "servings": _int(payload.get("servings"), request.subject.get("servings") or 2, minimum=1, maximum=12),
        "prep_minutes": _int(payload.get("prep_minutes"), request.subject.get("prepMinutes") or request.subject.get("prep_minutes") or 20, minimum=5, maximum=240),
        "difficulty": difficulty if difficulty in DIFFICULTIES else request.subject.get("difficulty") if request.subject.get("difficulty") in DIFFICULTIES else Difficulty.EASY.value,
        "ingredient_items": ingredient_items,
        "steps": steps,
        "tips": _string(payload.get("tips"), "保存前建议按家庭口味微调用量、火候和调味。"),
        "scene_tags": _tag_list(payload.get("scene_tags"), maximum=6) or _tag_list(default_scene_tags, maximum=6),
        "media_ids": [],
    }
    return draft


def build_recipe_image_render_payload(draft: dict[str, Any]) -> dict[str, Any]:
    ingredient_names = [
        item["ingredient_name"]
        for item in draft.get("ingredient_items", [])
        if isinstance(item, dict) and isinstance(item.get("ingredient_name"), str)
    ]
    scene_tags = _tag_list(draft.get("scene_tags"), maximum=6)
    return {
        "entity_type": MediaEntityType.RECIPE.value,
        "title": _string(draft.get("title"), "家庭菜谱"),
        "category": "AI 生成菜谱",
        "notes": "\n".join(
            [
                _string(draft.get("tips")),
                "根据 AI 生成菜谱自动生成封面图，画面必须呈现成菜状态。",
                "构图要饱满均衡，主菜清晰自然，画面中保留真实餐桌、浅色餐具或相关食材细节，不要生成大片空白。",
            ]
        ).strip(),
        "tags": scene_tags,
        "scene": " / ".join(scene_tags) or "家庭日常",
        "food_names": [_string(draft.get("title"), "家庭菜谱")],
        "ingredient_names": ingredient_names,
        "size": "1792*1008",
    }
