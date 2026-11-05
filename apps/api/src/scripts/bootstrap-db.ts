/**
 * One-time (idempotent) database setup on a managed Postgres such as AWS RDS, run with the admin
 * (master) user: creates the non-superuser app role, the app database and the extensions.
 * The app role owns the tables, and row-level security is forced on them, so tenant isolation
 * applies to everything the API does.
 *
 *   ADMIN_DATABASE_URL=postgres://admin:...@host:5432/postgres APP_DB_PASSWORD=... node dist/scripts/bootstrap-db.js
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
const appUser = process.env.APP_DB_USER ?? 'sailes';
const appDb = process.env.APP_DB_NAME ?? 'sailes';
if (!adminUrl || !appPassword) {
  console.error('Set ADMIN_DATABASE_URL and APP_DB_PASSWORD');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(appUser) || !/^[a-z_][a-z0-9_]*$/.test(appDb)) throw new Error('Invalid role or database name');

const ca = process.env.DATABASE_CA_FILE;
const ssl = ca ? { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } : undefined;
const admin = new pg.Client({ connectionString: adminUrl, ssl });
await admin.connect();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
if (role.rowCount) await admin.query(`ALTER ROLE ${appUser} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${lit(appPassword)}`);
else await admin.query(`CREATE ROLE ${appUser} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${lit(appPassword)}`);
// On RDS the admin must be a member of the role to make it a database owner.
await admin.query(`GRANT ${appUser} TO CURRENT_USER`).catch(() => {});
const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [appDb]);
if (!db.rowCount) await admin.query(`CREATE DATABASE ${appDb} OWNER ${appUser}`);
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${appDb}`;
const inDb = new pg.Client({ connectionString: url.toString(), ssl });
await inDb.connect();
for (const ext of ['vector', 'pg_trgm', 'unaccent']) await inDb.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
await inDb.query(`GRANT ALL ON SCHEMA public TO ${appUser}`);
await inDb.end();
console.log(`Database ${appDb} ready for role ${appUser}.`);
