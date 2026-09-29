from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_lease_migration_roundtrip_and_indexes():
    path = Path(__file__).resolve().parents[2] / 'alembic/versions/c5d6e7f8a9b0_add_ai_run_execution_leases.py'
    spec = spec_from_file_location('lease_migration', path)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine('sqlite://')
    try:
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE families (id VARCHAR(64) PRIMARY KEY)'))
            connection.execute(text('CREATE TABLE ai_agent_runs (id VARCHAR(64) PRIMARY KEY)'))
            module.op = Operations(MigrationContext.configure(connection))
            module.upgrade()
            inspector = inspect(connection)
            assert {column['name'] for column in inspector.get_columns('ai_run_execution_leases')} == {'run_id', 'family_id', 'worker_id', 'fencing_token', 'lease_until', 'heartbeat_at', 'provider_started'}
            assert {index['name'] for index in inspector.get_indexes('ai_run_execution_leases')} == {'ix_ai_run_execution_leases_expiry', 'ix_ai_run_execution_leases_family_id'}
            connection.execute(text("INSERT INTO ai_run_execution_leases (run_id, family_id) VALUES ('run', 'family')"))
            assert connection.execute(text('SELECT fencing_token, provider_started FROM ai_run_execution_leases')).one() == (0, 0)
            module.downgrade()
            assert 'ai_run_execution_leases' not in inspect(connection).get_table_names()
            module.upgrade()
            assert 'ai_run_execution_leases' in inspect(connection).get_table_names()
    finally:
        engine.dispose()
