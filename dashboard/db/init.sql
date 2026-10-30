-- Creates the "dashboard" role and database in the existing PostgreSQL service.
-- Safe to run more than once: each step checks whether its object already exists.
-- The password is read from the DASHBOARD_DB_PASSWORD environment variable of the psql process
-- (\getenv, psql 15 or later) and is never stored in this file or passed on a command line.
--
-- Run as the PostgreSQL admin user, connected to the "postgres" database, for example:
--   export DASHBOARD_DB_PASSWORD   (already set in this shell)
--   docker compose exec -T -e DASHBOARD_DB_PASSWORD postgres \
--     psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 < dashboard/db/init.sql
--
-- psql does not substitute variables inside DO blocks, and CREATE DATABASE cannot run inside one,
-- so each statement is built by a SELECT and executed with \gexec.

-- A failing statement must not be copied into the server log, because CREATE ROLE holds the password.
SET log_min_error_statement = 'panic';

\getenv pw DASHBOARD_DB_PASSWORD
\if :{?pw}
\else
  \set pw ''
\endif
SELECT :'pw' = '' AS pw_missing \gset
\if :pw_missing
  DO $$ BEGIN RAISE EXCEPTION 'DASHBOARD_DB_PASSWORD is not set for psql (pass it with docker compose exec -e DASHBOARD_DB_PASSWORD)'; END $$;
\endif

SELECT format('CREATE ROLE dashboard LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard')
\gexec

SELECT 'CREATE DATABASE dashboard OWNER dashboard'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'dashboard')
\gexec

REVOKE CONNECT ON DATABASE dashboard FROM PUBLIC;
GRANT CONNECT ON DATABASE dashboard TO dashboard;
