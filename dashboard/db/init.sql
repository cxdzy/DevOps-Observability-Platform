-- Creates the "dashboard" role and database in the existing PostgreSQL service.
-- Safe to run more than once: each step checks whether its object already exists.
-- The password comes from the psql variable pw and is never stored in this file.
--
-- Run as the PostgreSQL admin user, connected to the "postgres" database, for example:
--   docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
--     -v pw="$DASHBOARD_DB_PASSWORD" < dashboard/db/init.sql
--
-- psql does not substitute variables inside DO blocks, and CREATE DATABASE cannot run inside one,
-- so each statement is built by a SELECT and executed with \gexec.

SELECT format('CREATE ROLE dashboard LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard')
\gexec

SELECT 'CREATE DATABASE dashboard OWNER dashboard'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'dashboard')
\gexec

REVOKE CONNECT ON DATABASE dashboard FROM PUBLIC;
GRANT CONNECT ON DATABASE dashboard TO dashboard;
