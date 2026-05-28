from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.enums import (
    ActivityAction,
    AiMode,
    Difficulty,
    FoodType,
    InventoryStatus,
    MealType,
    MediaSource,
    MembershipStatus,
    UserRole,
)
from app.core.security import get_password_hash
from app.core.utils import create_id, utcnow
from app.db.transactions import commit_session
from app.models.domain import (
    AIConversation,
    AIRecommendation,
    ActivityLog,
    Family,
    Food,
    Ingredient,
    InventoryDeductionSuggestion,
    InventoryItem,
    MealLog,
    MealLogFood,
    MediaAsset,
    Membership,
    Recipe,
    RecipeIngredient,
    RecipeStep,
    ShoppingListItem,
    User,
    UserCredential,
)
from app.services.media import build_ai_cover_svg, save_svg_asset


def _create_user(
    db: Session,
    *,
    family_id: str,
    username: str,
    display_name: str,
    role: UserRole,
    password: str,
    created_by: str,
    email: str | None = None,
) -> tuple[User, Membership]:
    user = User(
        id=create_id("user"),
        username=username,
        display_name=display_name,
        email=email,
        avatar_seed=display_name,
        is_active=True,
        created_by=created_by,
        updated_by=created_by,
    )
    db.add(user)
    db.flush()

    credential = UserCredential(
        id=create_id("credential"),
        user_id=user.id,
        password_hash=get_password_hash(password),
    )
    membership = Membership(
        id=create_id("membership"),
        family_id=family_id,
        user_id=user.id,
        role=role,
        status=MembershipStatus.ACTIVE,
        created_by=created_by,
        updated_by=created_by,
    )
    db.add_all([credential, membership])
    db.flush()
    return user, membership


def reset_all_data(db: Session) -> None:
    for model in [
        InventoryDeductionSuggestion,
        MealLogFood,
        MealLog,
        Food,
        RecipeStep,
        RecipeIngredient,
        Recipe,
        ShoppingListItem,
        InventoryItem,
        Ingredient,
        ActivityLog,
        AIConversation,
        AIRecommendation,
        MediaAsset,
        Membership,
        UserCredential,
        User,
        Family,
    ]:
        db.execute(delete(model))
    commit_session(db)


def seed_demo_data(db: Session, *, force: bool = False) -> None:
    if force:
        reset_all_data(db)

    existing_user = db.scalar(select(User.id).limit(1))
    if existing_user:
        return

    system_actor = "system"
    family = Family(
        id=create_id("family"),
        name="星星家的厨房",
        motto="今天吃得好，明天更有劲儿",
        location="上海",
        created_by=system_actor,
        updated_by=system_actor,
    )
    db.add(family)
    db.flush()

    owner, _ = _create_user(
        db,
        family_id=family.id,
        username="linran",
        display_name="林然",
        role=UserRole.OWNER,
        password="Culina123!",
        created_by=system_actor,
        email="linran@culina.demo",
    )
    anna, anna_membership = _create_user(
        db,
        family_id=family.id,
        username="anan",
        display_name="安安",
        role=UserRole.MEMBER,
        password="Culina123!",
        created_by=owner.id,
        email="anan@culina.demo",
    )
    grandpa, _ = _create_user(
        db,
        family_id=family.id,
        username="yeye",
        display_name="爷爷",
        role=UserRole.MEMBER,
        password="Culina123!",
        created_by=owner.id,
        email="yeye@culina.demo",
    )

    tomato = Ingredient(
        id=create_id("ingredient"),
        family_id=family.id,
        name="番茄",
        category="蔬菜",
        default_unit="个",
        default_storage="冷藏",
        notes="适合做番茄炒蛋、汤面",
        created_by=owner.id,
        updated_by=owner.id,
    )
    egg = Ingredient(
        id=create_id("ingredient"),
        family_id=family.id,
        name="鸡蛋",
        category="蛋奶",
        default_unit="个",
        default_storage="冷藏",
        notes="早餐和家常菜高频使用",
        created_by=owner.id,
        updated_by=owner.id,
    )
    pepper = Ingredient(
        id=create_id("ingredient"),
        family_id=family.id,
        name="青椒",
        category="蔬菜",
        default_unit="个",
        default_storage="冷藏",
        notes="适合搭配肉片和鸡蛋",
        created_by=owner.id,
        updated_by=owner.id,
    )
    salmon = Ingredient(
        id=create_id("ingredient"),
        family_id=family.id,
        name="三文鱼",
        category="水产",
        default_unit="块",
        default_storage="冷冻",
        notes="适合煎烤或蒸制",
        created_by=owner.id,
        updated_by=owner.id,
    )
    rice = Ingredient(
        id=create_id("ingredient"),
        family_id=family.id,
        name="米饭",
        category="主食",
        default_unit="份",
        default_storage="常温",
        notes="主食基础库存",
        created_by=owner.id,
        updated_by=owner.id,
    )
    db.add_all([tomato, egg, pepper, salmon, rice])
    db.flush()

    tomato_image = save_svg_asset(
        db,
        family_id=family.id,
        user_id=owner.id,
        title="番茄",
        svg_markup=build_ai_cover_svg("番茄"),
        source=MediaSource.AI,
    )
    tomato_image.entity_type = "ingredient"
    tomato_image.entity_id = tomato.id

    inventory_items = [
        InventoryItem(
            id=create_id("inventory"),
            family_id=family.id,
            ingredient_id=tomato.id,
            quantity=Decimal("2"),
            unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=utcnow().date(),
            expiry_date=utcnow().date() + timedelta(days=2),
            storage_location="冷藏",
            notes="适合优先做熟食",
            low_stock_threshold=Decimal("3"),
            created_by=owner.id,
            updated_by=owner.id,
        ),
        InventoryItem(
            id=create_id("inventory"),
            family_id=family.id,
            ingredient_id=egg.id,
            quantity=Decimal("8"),
            unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=utcnow().date(),
            expiry_date=utcnow().date() + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("4"),
            created_by=owner.id,
            updated_by=owner.id,
        ),
        InventoryItem(
            id=create_id("inventory"),
            family_id=family.id,
            ingredient_id=pepper.id,
            quantity=Decimal("1"),
            unit="个",
            status=InventoryStatus.EXPIRING,
            purchase_date=utcnow().date(),
            expiry_date=utcnow().date() + timedelta(days=1),
            storage_location="冷藏",
            notes="明天前吃掉口感更好",
            low_stock_threshold=Decimal("2"),
            created_by=owner.id,
            updated_by=owner.id,
        ),
        InventoryItem(
            id=create_id("inventory"),
            family_id=family.id,
            ingredient_id=salmon.id,
            quantity=Decimal("2"),
            unit="块",
            status=InventoryStatus.FROZEN,
            purchase_date=utcnow().date(),
            expiry_date=utcnow().date() + timedelta(days=7),
            storage_location="冷冻",
            notes="",
            low_stock_threshold=Decimal("1"),
            created_by=owner.id,
            updated_by=owner.id,
        ),
        InventoryItem(
            id=create_id("inventory"),
            family_id=family.id,
            ingredient_id=rice.id,
            quantity=Decimal("4"),
            unit="份",
            status=InventoryStatus.FRESH,
            purchase_date=utcnow().date(),
            expiry_date=None,
            storage_location="常温",
            notes="",
            low_stock_threshold=Decimal("2"),
            created_by=owner.id,
            updated_by=owner.id,
        ),
    ]
    db.add_all(inventory_items)

    recipe_tomato_egg = Recipe(
        id=create_id("recipe"),
        family_id=family.id,
        title="番茄炒蛋",
        servings=2,
        prep_minutes=18,
        difficulty=Difficulty.EASY,
        tips="如果想更清淡，减少油量并延长小火翻炒时间。",
        scene_tags=["工作日晚餐", "孩子也能吃"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    recipe_salmon = Recipe(
        id=create_id("recipe"),
        family_id=family.id,
        title="清蒸三文鱼",
        servings=2,
        prep_minutes=25,
        difficulty=Difficulty.MEDIUM,
        tips="适合安排在周末或家庭轻食日晚餐。",
        scene_tags=["周末轻食", "高蛋白"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    db.add_all([recipe_tomato_egg, recipe_salmon])
    db.flush()

    for order, item in enumerate(
        [
            (recipe_tomato_egg.id, tomato.id, "番茄", Decimal("2"), "个", "切块"),
            (recipe_tomato_egg.id, egg.id, "鸡蛋", Decimal("3"), "个", "打散"),
            (recipe_tomato_egg.id, pepper.id, "青椒", Decimal("1"), "个", "可选增加清爽度"),
            (recipe_salmon.id, salmon.id, "三文鱼", Decimal("1"), "块", "提前解冻"),
            (recipe_salmon.id, pepper.id, "青椒", Decimal("0.5"), "个", "切丝点缀"),
            (recipe_salmon.id, rice.id, "米饭", Decimal("2"), "份", "搭配主食"),
        ]
    ):
        db.add(
            RecipeIngredient(
                id=create_id("recipe-ingredient"),
                recipe_id=item[0],
                ingredient_id=item[1],
                ingredient_name=item[2],
                quantity=item[3],
                unit=item[4],
                note=item[5],
                sort_order=order,
            )
        )

    for recipe_id, steps in [
        (
            recipe_tomato_egg.id,
            [
                ("炒鸡蛋", "先炒鸡蛋到七分熟盛出备用。", "pan", "热锅下油，快速翻炒蛋液。", 6, "火力中大，避免久炒导致口感变老。", ["鸡蛋充分打散，炒出来更蓬松。", "油稍多一些，鸡蛋更嫩滑。", "蛋液刚凝固立刻盛出，避免过老。"]),
                ("炒番茄", "番茄翻炒出汁后回锅鸡蛋，最后再下青椒。", "tomato", "番茄炒出汁后回锅鸡蛋。", 7, "番茄先炒软，汤汁会更自然。", ["番茄切块后先下锅。", "出汁后再放鸡蛋。", "青椒最后下，保持清爽。"]),
                ("调味出锅", "根据家庭口味补盐或一点糖提鲜。", "bowl", "调味均匀即可出锅。", 3, "少量糖可以平衡番茄酸味。", ["先尝味再加盐。", "翻炒均匀即可。", "出锅前保持锅内有少量汁水。"]),
            ],
        ),
        (
            recipe_salmon.id,
            [
                ("蒸鱼", "三文鱼调味后冷水上锅蒸 8-10 分钟。", "timer", "冷水上锅蒸熟。", 10, "鱼肉刚熟最嫩，不要久蒸。", ["表面薄薄调味。", "水开后计时更稳定。"]),
                ("淋油提香", "出锅后搭配青椒丝和热油提香。", "plate", "热油激香后装盘。", 3, "热油少量即可。", ["青椒丝铺在鱼肉上。", "淋油后马上上桌。"]),
            ],
        ),
    ]:
        for order, (title, step, icon, summary, minutes, tip, key_points) in enumerate(steps):
            db.add(
                RecipeStep(
                    id=create_id("step"),
                    recipe_id=recipe_id,
                    title=title,
                    text=step,
                    icon=icon,
                    summary=summary,
                    estimated_minutes=minutes,
                    tip=tip,
                    key_points=key_points,
                    sort_order=order,
                )
            )

    recipe_foods = [
        Food(
            id=create_id("food"),
            family_id=family.id,
            name=recipe_tomato_egg.title,
            type=FoodType.SELF_MADE.value,
            category="家常菜",
            flavor_tags=recipe_tomato_egg.scene_tags,
            scene_tags=recipe_tomato_egg.scene_tags,
            suitable_meal_types=[MealType.DINNER.value],
            source_name="家庭厨房",
            purchase_source="家庭厨房",
            scene=recipe_tomato_egg.scene_tags[0],
            notes=recipe_tomato_egg.tips,
            routine_note="",
            favorite=False,
            recipe_id=recipe_tomato_egg.id,
            created_by=owner.id,
            updated_by=owner.id,
        ),
        Food(
            id=create_id("food"),
            family_id=family.id,
            name=recipe_salmon.title,
            type=FoodType.SELF_MADE.value,
            category="家常菜",
            flavor_tags=recipe_salmon.scene_tags,
            scene_tags=recipe_salmon.scene_tags,
            suitable_meal_types=[MealType.DINNER.value],
            source_name="家庭厨房",
            purchase_source="家庭厨房",
            scene=recipe_salmon.scene_tags[0],
            notes=recipe_salmon.tips,
            routine_note="",
            favorite=False,
            recipe_id=recipe_salmon.id,
            created_by=owner.id,
            updated_by=owner.id,
        ),
    ]
    db.add_all(recipe_foods)
    db.flush()

    for item in [("番茄炒蛋", recipe_tomato_egg.id), ("清蒸三文鱼", recipe_salmon.id)]:
        asset = save_svg_asset(
            db,
            family_id=family.id,
            user_id=owner.id,
            title=item[0],
            svg_markup=build_ai_cover_svg(item[0]),
            source=MediaSource.AI,
        )
        asset.entity_type = "recipe"
        asset.entity_id = item[1]

    db.add(
        ShoppingListItem(
            id=create_id("shopping"),
            family_id=family.id,
            title="番茄",
            quantity=Decimal("4"),
            unit="个",
            reason="补充本周家常菜库存",
            done=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
    )

    db.add_all(
        [
            ActivityLog(
                id=create_id("activity"),
                family_id=family.id,
                actor_id=owner.id,
                action=ActivityAction.CREATE,
                entity_type="Family",
                entity_id=family.id,
                summary=f"创建家庭 {family.name}",
                created_at=utcnow(),
            ),
            ActivityLog(
                id=create_id("activity"),
                family_id=family.id,
                actor_id=owner.id,
                action=ActivityAction.INVITE,
                entity_type="Membership",
                entity_id=anna_membership.id,
                summary=f"邀请 {anna.display_name} 加入家庭",
                created_at=utcnow(),
            ),
            ActivityLog(
                id=create_id("activity"),
                family_id=family.id,
                actor_id=owner.id,
                action=ActivityAction.CREATE,
                entity_type="Recipe",
                entity_id=recipe_tomato_egg.id,
                summary="新增菜谱 番茄炒蛋",
                created_at=utcnow(),
            ),
        ]
    )

    recommendation = AIRecommendation(
        id=create_id("recommendation"),
        family_id=family.id,
        title="今晚推荐：清蒸三文鱼",
        detail="匹配库存度 100%，建议准备 25 分钟。另外别忘了优先处理：番茄 库存偏低。",
        created_at=utcnow(),
    )
    reminder = AIRecommendation(
        id=create_id("recommendation"),
        family_id=family.id,
        title="库存优先提醒",
        detail="目前最需要关注的是：番茄 库存偏低、青椒 即将到期。现有库存里可以优先消耗 番茄2个、鸡蛋8个、青椒1个、三文鱼2块、米饭4份。",
        created_at=utcnow(),
    )
    db.add_all([recommendation, reminder])
    commit_session(db)
