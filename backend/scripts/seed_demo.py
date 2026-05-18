from __future__ import annotations

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

import argparse

from app.db.session import SessionLocal
from app.services.seed import seed_demo_data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    db = SessionLocal()
    try:
        seed_demo_data(db, force=args.force)
    finally:
        db.close()


if __name__ == "__main__":
    main()
