-- Lets the dashboard role write the chat call log (6B-3) into the existing langfuse tables, the
-- same tables the explainer writes. Grants only what chat/log.js needs: connect to the database,
-- use the langfuse schema, and SELECT and INSERT on langfuse.trace and langfuse.observation.
-- Both tables take their ids from gen_random_uuid() defaults and use no sequence, so there is no
-- sequence to grant. Nothing is revoked, created or changed otherwise. Safe to run more than once.
--
-- The database is the one that holds the langfuse schema (LANGFUSE_DB_NAME, the same value as
-- POSTGRES_DB on this stack). Its name is read from the LANGFUSE_DB_NAME environment variable of the
-- psql process, and psql must be connected to that database. Run as the PostgreSQL admin user:
--   docker compose exec -T -e LANGFUSE_DB_NAME postgres \
--     sh -c 'psql -U "$POSTGRES_USER" -d "$LANGFUSE_DB_NAME" -v ON_ERROR_STOP=1' < dashboard/db/dashboard_chat_grant.sql

\unset db
\getenv db LANGFUSE_DB_NAME
\if :{?db}
\else
  \set db ''
\endif
SELECT :'db' = '' AS db_missing, :'db' <> current_database() AS db_other \gset

\if :db_missing
  DO $$ BEGIN RAISE EXCEPTION 'LANGFUSE_DB_NAME is not set for psql (pass it with docker compose exec -e LANGFUSE_DB_NAME)'; END $$;
\elif :db_other
  DO $$ BEGIN RAISE EXCEPTION 'connect psql to the LANGFUSE_DB_NAME database (-d "$LANGFUSE_DB_NAME")'; END $$;
\else
  GRANT CONNECT ON DATABASE :"db" TO dashboard;
  GRANT USAGE ON SCHEMA langfuse TO dashboard;
  GRANT SELECT, INSERT ON langfuse.trace, langfuse.observation TO dashboard;
\endif
\unset db
