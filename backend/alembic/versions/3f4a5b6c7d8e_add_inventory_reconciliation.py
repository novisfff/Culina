"""add inventory reconciliation

Revision ID: 3f4a5b6c7d8e
Revises: 2e3f4a5b6c7d
Create Date: 2026-07-12 12:00:00.000000
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "3f4a5b6c7d8e"
down_revision = "2e3f4a5b6c7d"
branch_labels = None
depends_on = None


def _table_columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    return {column["name"] for column in inspect(bind).get_columns(table_name)}


def _create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12]}"


def _add_column_if_missing(table_name: str, column: sa.Column) -> None:
    if column.name in _table_columns(table_name):
        return
    op.add_column(table_name, column)


def _has_fk(table_name: str, constraint_name: str) -> bool:
    bind = op.get_bind()
    return any(fk.get("name") == constraint_name for fk in inspect(bind).get_foreign_keys(table_name))


def _create_fk_if_missing(
    constraint_name: str,
    source_table: str,
    referent_table: str,
    local_cols: list[str],
    remote_cols: list[str],
    *,
    ondelete: str,
) -> None:
    if _has_fk(source_table, constraint_name):
        return
    op.create_foreign_key(
        constraint_name,
        source_table,
        referent_table,
        local_cols,
        remote_cols,
        ondelete=ondelete,
    )


def _representative_key(row: Any) -> tuple[bool, date, float, str]:
    expiry_date = row["expiry_date"] if hasattr(row, "keys") else row.expiry_date
    updated_at = row["updated_at"] if hasattr(row, "keys") else row.updated_at
    row_id = row["id"] if hasattr(row, "keys") else row.id
    return (
        expiry_date is None,
        expiry_date or date.max,
        -updated_at.timestamp() if isinstance(updated_at, datetime) else 0.0,
        row_id,
    )


def _backfill_ingredient_inventory_states() -> None:
    connection = op.get_bind()
    inventory_columns = _table_columns("inventory_items")
    has_review_fields = {
        "expiry_alert_snoozed_until",
        "expiry_reviewed_at",
        "expiry_reviewed_by",
    }.issubset(inventory_columns)

    inventory_items = sa.table(
        "inventory_items",
        sa.column("id", sa.String(64)),
        sa.column("family_id", sa.String(64)),
        sa.column("ingredient_id", sa.String(64)),
        sa.column("quantity", sa.Numeric(10, 2)),
        sa.column("disposed_quantity", sa.Numeric(10, 2)),
        sa.column("status", sa.String(32)),
        sa.column("purchase_date", sa.Date()),
        sa.column("expiry_date", sa.Date()),
        sa.column("storage_location", sa.String(120)),
        sa.column("notes", sa.Text()),
        sa.column("updated_at", sa.DateTime(timezone=True)),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("created_by", sa.String(64)),
        sa.column("updated_by", sa.String(64)),
        sa.column("expiry_alert_snoozed_until", sa.Date()),
        sa.column("expiry_reviewed_at", sa.DateTime(timezone=True)),
        sa.column("expiry_reviewed_by", sa.String(64)),
    )
    ingredients = sa.table(
        "ingredients",
        sa.column("id", sa.String(64)),
        sa.column("family_id", sa.String(64)),
        sa.column("quantity_tracking_mode", sa.String(32)),
    )
    states = sa.table(
        "ingredient_inventory_states",
        sa.column("id", sa.String(64)),
        sa.column("family_id", sa.String(64)),
        sa.column("ingredient_id", sa.String(64)),
        sa.column("availability_level", sa.String(32)),
        sa.column("inventory_status", sa.String(32)),
        sa.column("purchase_date", sa.Date()),
        sa.column("expiry_date", sa.Date()),
        sa.column("storage_location", sa.String(120)),
        sa.column("notes", sa.Text()),
        sa.column("expiry_alert_snoozed_until", sa.Date()),
        sa.column("expiry_reviewed_at", sa.DateTime(timezone=True)),
        sa.column("expiry_reviewed_by", sa.String(64)),
        sa.column("last_confirmed_at", sa.DateTime(timezone=True)),
        sa.column("last_confirmed_by", sa.String(64)),
        sa.column("last_confirmation_source", sa.String(32)),
        sa.column("row_version", sa.Integer()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
        sa.column("created_by", sa.String(64)),
        sa.column("updated_by", sa.String(64)),
    )

    select_columns = [
        inventory_items.c.id,
        inventory_items.c.family_id,
        inventory_items.c.ingredient_id,
        inventory_items.c.quantity,
        inventory_items.c.disposed_quantity,
        inventory_items.c.status,
        inventory_items.c.purchase_date,
        inventory_items.c.expiry_date,
        inventory_items.c.storage_location,
        inventory_items.c.notes,
        inventory_items.c.updated_at,
        inventory_items.c.created_at,
        inventory_items.c.created_by,
        inventory_items.c.updated_by,
    ]
    if has_review_fields:
        select_columns.extend(
            [
                inventory_items.c.expiry_alert_snoozed_until,
                inventory_items.c.expiry_reviewed_at,
                inventory_items.c.expiry_reviewed_by,
            ]
        )

    rows = connection.execute(
        sa.select(*select_columns)
        .select_from(
            inventory_items.join(
                ingredients,
                sa.and_(
                    inventory_items.c.ingredient_id == ingredients.c.id,
                    inventory_items.c.family_id == ingredients.c.family_id,
                ),
            )
        )
        .where(ingredients.c.quantity_tracking_mode == "not_track_quantity")
        .where(inventory_items.c.quantity - inventory_items.c.disposed_quantity > 0)
    ).mappings().all()

    grouped: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for row in rows:
        grouped[(row["family_id"], row["ingredient_id"])].append(row)

    now = datetime.now(timezone.utc)
    payloads: list[dict[str, Any]] = []
    for (family_id, ingredient_id), presence_rows in grouped.items():
        representative = min(presence_rows, key=_representative_key)
        payload: dict[str, Any] = {
            "id": _create_id("inventory-state"),
            "family_id": family_id,
            "ingredient_id": ingredient_id,
            "availability_level": "present_unknown",
            "inventory_status": representative["status"] or "fresh",
            "purchase_date": representative["purchase_date"],
            "expiry_date": representative["expiry_date"],
            "storage_location": representative["storage_location"] or None,
            "notes": representative["notes"] or "",
            "expiry_alert_snoozed_until": None,
            "expiry_reviewed_at": None,
            "expiry_reviewed_by": None,
            "last_confirmed_at": None,
            "last_confirmed_by": None,
            "last_confirmation_source": None,
            "row_version": 1,
            "created_at": representative["created_at"] or now,
            "updated_at": representative["updated_at"] or now,
            "created_by": representative["created_by"],
            "updated_by": representative["updated_by"],
        }
        if has_review_fields:
            payload["expiry_alert_snoozed_until"] = representative["expiry_alert_snoozed_until"]
            payload["expiry_reviewed_at"] = representative["expiry_reviewed_at"]
            payload["expiry_reviewed_by"] = representative["expiry_reviewed_by"]
        payloads.append(payload)

    if payloads:
        op.bulk_insert(states, payloads)


def upgrade() -> None:
    # Ingredient.row_version
    _add_column_if_missing(
        "ingredients",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )

    # InventoryItem confirmation fields (row_version/expiry already from P0.1)
    _add_column_if_missing(
        "inventory_items",
        sa.Column("last_confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    _add_column_if_missing(
        "inventory_items",
        sa.Column("last_confirmed_by", sa.String(length=64), nullable=True),
    )
    _add_column_if_missing(
        "inventory_items",
        sa.Column("last_confirmation_source", sa.String(length=32), nullable=True),
    )
    _create_fk_if_missing(
        "fk_inventory_items_last_confirmed_by_users",
        "inventory_items",
        "users",
        ["last_confirmed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    # Food.row_version + confirmation fields
    _add_column_if_missing(
        "foods",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )
    _add_column_if_missing(
        "foods",
        sa.Column("inventory_last_confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    _add_column_if_missing(
        "foods",
        sa.Column("inventory_last_confirmed_by", sa.String(length=64), nullable=True),
    )
    _add_column_if_missing(
        "foods",
        sa.Column("inventory_confirmation_source", sa.String(length=32), nullable=True),
    )
    _create_fk_if_missing(
        "fk_foods_inventory_last_confirmed_by_users",
        "foods",
        "users",
        ["inventory_last_confirmed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    # ShoppingListItem.row_version
    _add_column_if_missing(
        "shopping_list_items",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )

    op.create_table(
        "ingredient_inventory_states",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("ingredient_id", sa.String(length=64), nullable=False),
        sa.Column("availability_level", sa.String(length=32), nullable=False),
        sa.Column("inventory_status", sa.String(length=32), nullable=False),
        sa.Column("purchase_date", sa.Date(), nullable=True),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column("storage_location", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("expiry_alert_snoozed_until", sa.Date(), nullable=True),
        sa.Column("expiry_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expiry_reviewed_by", sa.String(length=64), nullable=True),
        sa.Column("last_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_confirmed_by", sa.String(length=64), nullable=True),
        sa.Column("last_confirmation_source", sa.String(length=32), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ingredient_id"], ["ingredients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["expiry_reviewed_by"],
            ["users.id"],
            name="fk_ingredient_inventory_states_expiry_reviewed_by_users",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["last_confirmed_by"],
            ["users.id"],
            name="fk_ingredient_inventory_states_last_confirmed_by_users",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "family_id",
            "ingredient_id",
            name="uq_ingredient_inventory_states_family_ingredient",
        ),
    )
    op.create_index(
        "ix_ingredient_inventory_states_family_availability",
        "ingredient_inventory_states",
        ["family_id", "availability_level"],
    )
    op.create_index(
        "ix_ingredient_inventory_states_family_storage_availability",
        "ingredient_inventory_states",
        ["family_id", "storage_location", "availability_level"],
    )
    op.create_index(
        "ix_ingredient_inventory_states_family_expiry",
        "ingredient_inventory_states",
        ["family_id", "expiry_date"],
    )
    op.create_index(
        "ix_ingredient_inventory_states_family_confirmed",
        "ingredient_inventory_states",
        ["family_id", "last_confirmed_at"],
    )

    op.create_table(
        "inventory_operations",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("operation_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("client_request_id", sa.String(length=120), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revertible_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reverted_by", sa.String(length=64), nullable=True),
        sa.Column("summary_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["reverted_by"],
            ["users.id"],
            name="fk_inventory_operations_reverted_by_users",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "family_id",
            "client_request_id",
            name="uq_inventory_operations_family_request",
        ),
    )
    op.create_index(
        "ix_inventory_operations_family_applied",
        "inventory_operations",
        ["family_id", "applied_at"],
    )
    op.create_index(
        "ix_inventory_operations_family_status_revertible",
        "inventory_operations",
        ["family_id", "status", "revertible_until"],
    )

    op.create_table(
        "inventory_operation_lines",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("operation_id", sa.String(length=64), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("change_type", sa.String(length=32), nullable=False),
        sa.Column("before_snapshot", sa.JSON(), nullable=True),
        sa.Column("after_snapshot", sa.JSON(), nullable=True),
        sa.Column("before_row_version", sa.Integer(), nullable=True),
        sa.Column("after_row_version", sa.Integer(), nullable=True),
        sa.Column("change_metadata", sa.JSON(), nullable=True),
        sa.Column("snapshot_schema_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["inventory_operations.id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "operation_id",
            "sequence",
            name="uq_inventory_operation_lines_sequence",
        ),
        sa.UniqueConstraint(
            "operation_id",
            "entity_type",
            "entity_id",
            name="uq_inventory_operation_lines_entity",
        ),
    )

    _backfill_ingredient_inventory_states()


def downgrade() -> None:
    op.drop_table("inventory_operation_lines")
    op.drop_index("ix_inventory_operations_family_status_revertible", table_name="inventory_operations")
    op.drop_index("ix_inventory_operations_family_applied", table_name="inventory_operations")
    op.drop_table("inventory_operations")
    op.drop_index("ix_ingredient_inventory_states_family_confirmed", table_name="ingredient_inventory_states")
    op.drop_index("ix_ingredient_inventory_states_family_expiry", table_name="ingredient_inventory_states")
    op.drop_index(
        "ix_ingredient_inventory_states_family_storage_availability",
        table_name="ingredient_inventory_states",
    )
    op.drop_index(
        "ix_ingredient_inventory_states_family_availability",
        table_name="ingredient_inventory_states",
    )
    op.drop_table("ingredient_inventory_states")

    if "row_version" in _table_columns("shopping_list_items"):
        op.drop_column("shopping_list_items", "row_version")

    if _has_fk("foods", "fk_foods_inventory_last_confirmed_by_users"):
        op.drop_constraint("fk_foods_inventory_last_confirmed_by_users", "foods", type_="foreignkey")
    for column_name in (
        "inventory_confirmation_source",
        "inventory_last_confirmed_by",
        "inventory_last_confirmed_at",
        "row_version",
    ):
        if column_name in _table_columns("foods"):
            op.drop_column("foods", column_name)

    if _has_fk("inventory_items", "fk_inventory_items_last_confirmed_by_users"):
        op.drop_constraint(
            "fk_inventory_items_last_confirmed_by_users",
            "inventory_items",
            type_="foreignkey",
        )
    for column_name in (
        "last_confirmation_source",
        "last_confirmed_by",
        "last_confirmed_at",
    ):
        if column_name in _table_columns("inventory_items"):
            op.drop_column("inventory_items", column_name)

    if "row_version" in _table_columns("ingredients"):
        op.drop_column("ingredients", "row_version")
