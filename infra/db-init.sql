-- Run once as a superuser. The app role is NOT a superuser, so row-level security applies to it.
CREATE ROLE sailes LOGIN PASSWORD 'sailes';
CREATE DATABASE sailes OWNER sailes;
CREATE DATABASE sailes_test OWNER sailes;
\c sailes
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
\c sailes_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
