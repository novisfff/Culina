from __future__ import annotations

import argparse
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db.session import SessionLocal
from app.models.domain import Food, Ingredient, Recipe
from app.services.search.indexing import upsert_food_search_document, upsert_ingredient_search_document, upsert_recipe_search_document
from app.services.search.vector_cleanup import cleanup_stale_vector_points
from app.services.search.vector_indexing import index_pending_search_documents

VALID_SCOPES = {"ingredients", "foods", "recipes"}
VECTOR_SCOPE_BY_REBUILD_SCOPE = {"ingredients": "ingredient", "foods": "food", "recipes": "recipe"}


def rebuild_search_index(*, scopes: Iterable[str], family_id: str | None = None) -> dict[str, int]:
    selected_scopes = set(scopes)
    stats = {"ingredients": 0, "foods": 0, "recipes": 0}
    with SessionLocal() as db:
        if "ingredients" in selected_scopes:
            statement = select(Ingredient)
            if family_id:
                statement = statement.where(Ingredient.family_id == family_id)
            for ingredient in db.scalars(statement):
                upsert_ingredient_search_document(db, ingredient)
                stats["ingredients"] += 1

        if "foods" in selected_scopes:
            statement = select(Food)
            if family_id:
                statement = statement.where(Food.family_id == family_id)
            for food in db.scalars(statement):
                upsert_food_search_document(db, food)
                stats["foods"] += 1

        if "recipes" in selected_scopes:
            statement = select(Recipe).options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
            if family_id:
                statement = statement.where(Recipe.family_id == family_id)
            for recipe in db.scalars(statement):
                upsert_recipe_search_document(db, recipe)
                stats["recipes"] += 1

        db.commit()
    return stats


def index_all_pending_vectors(*, batch_size: int = 20) -> dict[str, int]:
    stats = {"indexed": 0, "failed": 0, "skipped": 0}
    while True:
        with SessionLocal() as db:
            batch_stats = index_pending_search_documents(db, batch_size=batch_size)
            db.commit()
        for key in stats:
            stats[key] += batch_stats[key]
        if not any(batch_stats.values()):
            break
    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild Culina search document index.")
    parser.add_argument("--scope", action="append", choices=sorted(VALID_SCOPES), help="Scope to rebuild. Can be passed multiple times.")
    parser.add_argument("--family-id", default=None, help="Limit rebuild to one family id.")
    parser.add_argument("--all", action="store_true", help="Rebuild all supported scopes.")
    parser.add_argument("--vectors", action="store_true", help="Also index pending vectors after rebuilding search documents.")
    parser.add_argument("--vector-batch-size", type=int, default=20, help="Vector indexing batch size when --vectors is used.")
    parser.add_argument("--cleanup-vectors", action="store_true", help="Delete stale Qdrant points after rebuilding search documents.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    scopes = set(args.scope or [])
    if args.all or not scopes:
        scopes = set(VALID_SCOPES)
    stats = rebuild_search_index(scopes=scopes, family_id=args.family_id)
    vector_stats = None
    if args.vectors:
        vector_stats = index_all_pending_vectors(batch_size=args.vector_batch_size)
    cleanup_stats = None
    if args.cleanup_vectors:
        with SessionLocal() as db:
            cleanup_stats = cleanup_stale_vector_points(
                db,
                family_id=args.family_id,
                scopes=[VECTOR_SCOPE_BY_REBUILD_SCOPE[scope] for scope in sorted(scopes)],
            )
    print(
        "Search index rebuild complete: "
        f"ingredients={stats['ingredients']} foods={stats['foods']} recipes={stats['recipes']}"
    )
    if vector_stats is not None:
        print(
            "Search vector indexing complete: "
            f"indexed={vector_stats['indexed']} failed={vector_stats['failed']} skipped={vector_stats['skipped']}"
        )
    if cleanup_stats is not None:
        print(
            "Search vector cleanup complete: "
            f"scanned={cleanup_stats['scanned']} deleted={cleanup_stats['deleted']} failed={cleanup_stats['failed']}"
        )


if __name__ == "__main__":
    main()
