from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import MembershipStatus, UserRole
from app.core.security import get_password_hash, verify_password
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User, UserCredential
from app.services.bootstrap import initialize_configured_admin


def make_engine():
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )


class AccountManagementTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = make_engine()
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )
        with self.SessionLocal() as db:
            self.family = Family(id="family-test", name="测试家庭", motto="", location="")
            self.owner = User(id="owner-test", username="owner", display_name="Owner", avatar_seed="Owner", is_active=True)
            self.member = User(id="member-test", username="member", display_name="Member", avatar_seed="Member", is_active=True)
            owner_membership = Membership(
                id="membership-owner",
                family_id=self.family.id,
                user_id=self.owner.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            member_membership = Membership(
                id="membership-member",
                family_id=self.family.id,
                user_id=self.member.id,
                role=UserRole.MEMBER,
                status=MembershipStatus.ACTIVE,
            )
            db.add_all(
                [
                    self.family,
                    self.owner,
                    self.member,
                    owner_membership,
                    member_membership,
                    UserCredential(id="credential-owner", user_id=self.owner.id, password_hash=get_password_hash("OldPass123")),
                    UserCredential(id="credential-member", user_id=self.member.id, password_hash=get_password_hash("MemberPass123")),
                ]
            )
            db.commit()

        def override_db():
            with self.SessionLocal() as db:
                yield db

        def override_owner_auth(db: Session = Depends(get_db)):
            user = db.get(User, self.owner.id)
            membership = db.get(Membership, "membership-owner")
            assert user is not None and membership is not None
            return user, membership

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_owner_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_update_profile_only_changes_current_user_fields(self) -> None:
        response = self.client.patch(
            "/api/auth/me",
            json={
                "display_name": "新的昵称",
                "email": "owner@example.com",
                "phone": "13800000000",
                "avatar_seed": "new-seed",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["display_name"], "新的昵称")
        with self.SessionLocal() as db:
            owner = db.get(User, self.owner.id)
            member = db.get(User, self.member.id)
            assert owner is not None and member is not None
            self.assertEqual(owner.username, "owner")
            self.assertEqual(owner.email, "owner@example.com")
            self.assertEqual(member.display_name, "Member")

    def test_update_password_requires_current_password(self) -> None:
        bad_response = self.client.patch(
            "/api/auth/password",
            json={"current_password": "WrongPass123", "new_password": "NewPass123"},
        )
        self.assertEqual(bad_response.status_code, 400)

        response = self.client.patch(
            "/api/auth/password",
            json={"current_password": "OldPass123", "new_password": "NewPass123"},
        )
        self.assertEqual(response.status_code, 204)
        with self.SessionLocal() as db:
            credential = db.query(UserCredential).filter(UserCredential.user_id == self.owner.id).one()
            self.assertFalse(verify_password("OldPass123", credential.password_hash))
            self.assertTrue(verify_password("NewPass123", credential.password_hash))

    def test_update_family_requires_owner(self) -> None:
        response = self.client.patch(
            "/api/family",
            json={"name": "真实家庭", "motto": "好好吃饭", "location": "杭州"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "真实家庭")

        def override_member_auth(db: Session = Depends(get_db)):
            user = db.get(User, self.member.id)
            membership = db.get(Membership, "membership-member")
            assert user is not None and membership is not None
            return user, membership

        app.dependency_overrides[get_current_auth] = override_member_auth
        forbidden = self.client.patch(
            "/api/family",
            json={"name": "成员不能改", "motto": "", "location": ""},
        )
        self.assertEqual(forbidden.status_code, 403)


class InitialAdminBootstrapTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = make_engine()
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def settings(self, **overrides):
        values = {
            "initial_admin_username": "admin",
            "initial_admin_password": "AdminPass123",
            "initial_admin_display_name": "家庭管理员",
            "initial_admin_email": "admin@example.com",
            "initial_admin_phone": "13800000000",
            "initial_family_name": "真实家庭",
            "initial_family_motto": "认真吃饭",
            "initial_family_location": "上海",
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_empty_database_initializes_configured_owner(self) -> None:
        with patch("app.services.bootstrap.get_settings", return_value=self.settings()):
            with self.SessionLocal() as db:
                created = initialize_configured_admin(db)
                self.assertTrue(created)
                self.assertEqual(db.query(Family).count(), 1)
                self.assertEqual(db.query(User).count(), 1)
                self.assertEqual(db.query(UserCredential).count(), 1)
                membership = db.query(Membership).one()
                self.assertEqual(membership.role, UserRole.OWNER)

    def test_existing_user_skips_initialization(self) -> None:
        with self.SessionLocal() as db:
            family = Family(id="family-existing", name="已有家庭", motto="", location="")
            user = User(id="user-existing", username="exists", display_name="Exists", avatar_seed="", is_active=True)
            db.add_all([family, user])
            db.commit()

        with patch("app.services.bootstrap.get_settings", return_value=self.settings()):
            with self.SessionLocal() as db:
                created = initialize_configured_admin(db)
                self.assertFalse(created)
                self.assertEqual(db.query(User).count(), 1)

    def test_missing_required_initial_settings_raise_clear_error(self) -> None:
        with patch("app.services.bootstrap.get_settings", return_value=self.settings(initial_admin_password="")):
            with self.SessionLocal() as db:
                with self.assertRaisesRegex(RuntimeError, "INITIAL_ADMIN_PASSWORD"):
                    initialize_configured_admin(db)


if __name__ == "__main__":
    unittest.main()
