"""Keep shared family plans when their creator is deleted.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
"""

from alembic import op
import sqlalchemy as sa


revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None

_NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}
_CREATOR_FK = "fk_food_plan_items_user_id_users"


def _creator_fk_name() -> str:
    for constraint in sa.inspect(op.get_bind()).get_foreign_keys("food_plan_items"):
        if constraint["constrained_columns"] == ["user_id"] and constraint["referred_table"] == "users":
            return constraint["name"] or _CREATOR_FK
    raise RuntimeError("food_plan_items creator foreign key is missing")


def upgrade() -> None:
    previous_fk = _creator_fk_name()
    with op.batch_alter_table("food_plan_items", naming_convention=_NAMING) as batch:
        batch.drop_constraint(previous_fk, type_="foreignkey")
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=True)
        batch.create_foreign_key(_CREATOR_FK, "users", ["user_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    # Do not delete shared plans or invent a personal owner during rollback.
    missing_creator = op.get_bind().execute(
        sa.text("SELECT id FROM food_plan_items WHERE user_id IS NULL LIMIT 1")
    ).first()
    if missing_creator is not None:
        raise RuntimeError("Cannot restore personal plan ownership while shared plans have no creator")
    previous_fk = _creator_fk_name()
    with op.batch_alter_table("food_plan_items", naming_convention=_NAMING) as batch:
        batch.drop_constraint(previous_fk, type_="foreignkey")
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=False)
        batch.create_foreign_key(_CREATOR_FK, "users", ["user_id"], ["id"], ondelete="CASCADE")
