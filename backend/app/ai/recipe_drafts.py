from __future__ import annotations

import json
import re
from typing import Any

from app.ai.context import AgentContext
from app.ai.schemas import AgentRunRequest
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
QUALITY_MIN_STEP_COUNT = 4


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
你是 Culina 的家庭菜谱生成智能体，负责把用户给出的少量信息补全为规范、可执行、适合家庭厨房的菜谱。
你必须只返回一个 JSON object。
不要返回 Markdown、注释、代码块、前后解释、标题、序号或任何多余文本。
不要使用 Markdown 代码围栏包裹输出，包括三个反引号加 json 语言标记；如果你仍然输出了代码块，代码块内部也必须是纯 JSON。
菜谱必须真实可做，步骤要写清楚处理、切配规格、调味顺序、火候、时间、状态判断和安全注意，不要使用夸张、含糊或无法复现的表达。
如果用户选择了系统食材，ingredient_items 中必须保留对应 ingredient_id，并优先使用该食材默认单位。
如果用户输入自由食材，ingredient_id 必须为 null。
ingredient_items 必须分层包含主料、必要辅料和关键调味料；为每一项生成适合 servings 的具体 quantity、unit、note，不能都写 1 或“适量”；调味料可用 克、勺、撮、瓣、片 等家庭可执行单位。
步骤数量必须为 4 到 8 步。每步必须包含 title、text、icon、summary、estimated_minutes、tip、key_points。
每个步骤的 text 至少写两句，必须包含具体动作、用量/比例线索、火力或温度、时间范围、完成状态判断；不要只写“翻炒均匀”“煮熟即可”这类笼统一句话。
步骤要按“备菜 / 预处理或腌制 / 正式烹调 / 调味收尾 / 装盘检查”的顺序覆盖；涉及肉蛋海鲜时必须写熟透判断。
icon 只能从 pan、tomato、bowl、timer、tip、plate 中选择。difficulty 只能是 easy、medium、hard。
summary 要概括本步目的，tip 要给出火候、口味或失败规避建议，key_points 每步最多 3 条且必须是可执行短句。不要生成不存在的品牌、人物、医疗功效或营养治疗承诺。
返回 JSON 结构固定为：
{
  "title": "菜谱名",
  "servings": 2,
  "prep_minutes": 20,
  "difficulty": "easy",
  "ingredient_items": [
    {"ingredient_id": "或 null", "ingredient_name": "食材名", "quantity": 1, "unit": "单位", "note": "处理备注"}
  ],
  "steps": [
    {"title": "步骤名", "text": "详细操作", "icon": "pan", "summary": "一句话说明", "estimated_minutes": 5, "tip": "小贴士", "key_points": ["要点"]}
  ],
  "tips": "整体技巧",
  "scene_tags": ["标签"]
}

输出示例：
{
  "title": "番茄炒蛋",
  "servings": 2,
  "prep_minutes": 15,
  "difficulty": "easy",
  "ingredient_items": [
    {"ingredient_id": null, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"},
    {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 3, "unit": "个", "note": "打散备用"},
    {"ingredient_id": null, "ingredient_name": "盐", "quantity": 2, "unit": "克", "note": "少量多次调味"}
  ],
  "steps": [
    {"title": "备菜", "text": "番茄洗净切块，鸡蛋打散备用。保持食材大小接近，方便后面均匀受热。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切块后可先把汁水控掉一些。", "key_points": ["番茄切块", "鸡蛋打散"]},
    {"title": "炒制", "text": "热锅少油，中火先炒鸡蛋到刚凝固后盛出。再下番茄炒出汁，回锅翻匀后调味，看到汤汁略收就关火。", "icon": "pan", "summary": "先炒蛋再炒番茄", "estimated_minutes": 8, "tip": "中火更容易保持鸡蛋嫩、番茄出汁。", "key_points": ["先炒蛋", "中火翻炒"]},
    {"title": "收尾", "text": "最后尝味，按口味补一点盐。确认鸡蛋和番茄都熟透后装盘，表面可撒少量葱花。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 2, "tip": "最后一次调味不要一下加太多。", "key_points": ["出锅前尝味", "熟透再装盘"]}
  ],
  "tips": "少油少盐，适合家常快手菜。",
  "scene_tags": ["家常菜", "快手菜"]
}
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


def _main_ingredient_text(names: list[str]) -> str:
    return "、".join(names[:4]) if names else "主要食材"


def _fallback_recipe_steps(names: list[str]) -> list[dict[str, Any]]:
    subject = _main_ingredient_text(names)
    return [
        {
            "title": "备菜与调味",
            "text": f"将{subject}清洗处理，蔬菜切成约 2-3 厘米入口大小，肉蛋类按需要切片、切块或打散。把盐、生抽、葱姜蒜等调味料提前量好放在手边，易出水食材单独沥干。",
            "icon": "tomato",
            "summary": "清洗切配并备好调味",
            "estimated_minutes": 6,
            "tip": "食材大小接近，后面受热会更均匀。",
            "key_points": ["切配大小一致", "调味料提前备好", "易出水食材沥干"],
        },
        {
            "title": "预处理增香",
            "text": "热锅后加入少量油，保持中小火，先下葱姜蒜或需要煎香的食材处理 1-2 分钟。闻到香味或看到边缘微微变色后，再进入正式烹调，避免一开始火太大导致糊底。",
            "icon": "bowl",
            "summary": "先用温和火力激发香味",
            "estimated_minutes": 3,
            "tip": "如果是蛋液或肉片，可先滑熟或煎至定型后盛出。",
            "key_points": ["中小火起香", "边缘变色再继续", "避免糊底"],
        },
        {
            "title": "分批烹调",
            "text": "转中火，先放不易熟的食材翻炒 2-4 分钟，看到颜色变深、边缘变软后再加入容易熟的食材。锅里偏干时沿锅边加入 2-3 勺水或高汤，短暂焖 1-2 分钟帮助熟透。",
            "icon": "pan",
            "summary": "按成熟速度分批下锅",
            "estimated_minutes": 8,
            "tip": "先难熟后易熟，可以避免有的过软、有的夹生。",
            "key_points": ["先难熟后易熟", "中火稳定翻炒", "偏干时少量补水"],
        },
        {
            "title": "调味收汁",
            "text": "加入盐、生抽或其他家庭常用调味，先少量加入再翻匀 30 秒到 1 分钟。尝味后再补调味，看到汤汁略收、食材表面均匀裹味时即可准备出锅。",
            "icon": "timer",
            "summary": "少量多次调味并收汁",
            "estimated_minutes": 3,
            "tip": "最后调味更容易控制咸淡，也能保留食材口感。",
            "key_points": ["少量多次调味", "出锅前尝味", "汤汁略收即可"],
        },
        {
            "title": "检查装盘",
            "text": "关火前检查食材状态，蔬菜应熟而不塌，肉蛋海鲜类要确认中心熟透、没有透明感或生心。装盘后静置 1 分钟再上桌，表面可按口味撒少量葱花或香菜。",
            "icon": "plate",
            "summary": "确认熟透并装盘",
            "estimated_minutes": 2,
            "tip": "如果不确定是否熟透，宁可多加热 1 分钟再出锅。",
            "key_points": ["确认中心熟透", "口感熟而不塌", "静置后上桌"],
        },
    ]


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


def _enhance_step(raw_step: dict[str, Any], fallback_step: dict[str, Any]) -> dict[str, Any]:
    text = _string(raw_step.get("text"))
    if _is_low_quality_step(text):
        text = f"{text}。{fallback_step['text']}" if text else fallback_step["text"]
    summary = _string(raw_step.get("summary"), fallback_step["summary"])
    tip = _string(raw_step.get("tip"), fallback_step["tip"])
    key_points = _list_of_strings(raw_step.get("key_points"), maximum=3) or fallback_step["key_points"]
    icon = _string(raw_step.get("icon"), fallback_step["icon"])
    return {
        "title": _string(raw_step.get("title"), fallback_step["title"]),
        "text": text,
        "icon": icon if icon in STEP_ICONS else fallback_step["icon"],
        "summary": summary if len(summary) >= 4 else fallback_step["summary"],
        "estimated_minutes": _int(raw_step.get("estimated_minutes"), fallback_step["estimated_minutes"], minimum=1, maximum=60),
        "tip": tip if len(tip) >= 6 else fallback_step["tip"],
        "key_points": key_points[:3],
    }


def _normalize_steps(raw_steps: Any, context: AgentContext, request: AgentRunRequest) -> list[dict[str, Any]]:
    fallback_steps = _fallback_recipe_steps(_draft_subject_names(context, request))
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
            fallback_step = fallback_steps[min(index, len(fallback_steps) - 1)]
            steps.append(_enhance_step({**raw, "text": text}, fallback_step))
    if len(steps) < QUALITY_MIN_STEP_COUNT:
        existing_titles = {step["title"] for step in steps}
        for fallback_step in fallback_steps:
            if len(steps) >= QUALITY_MIN_STEP_COUNT:
                break
            if fallback_step["title"] not in existing_titles:
                steps.append(fallback_step)
                existing_titles.add(fallback_step["title"])
    return steps[:8]


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
        "scene_tags": _list_of_strings(payload.get("scene_tags"), maximum=6) or default_scene_tags[:6],
        "media_ids": [],
    }
    return draft


def build_recipe_image_render_payload(draft: dict[str, Any]) -> dict[str, Any]:
    ingredient_names = [
        item["ingredient_name"]
        for item in draft.get("ingredient_items", [])
        if isinstance(item, dict) and isinstance(item.get("ingredient_name"), str)
    ]
    scene_tags = _list_of_strings(draft.get("scene_tags"), maximum=6)
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
