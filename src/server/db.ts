import { Pool, type PoolClient } from "pg";
import { checkAdditiveChange, type AppSpec, type Entity } from "../shared/spec.ts";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://konoha:local-development-only@127.0.0.1:55432/konoha",
});
pool.on("error", (error) => console.error("Idle database connection failed:", error));

export async function initialize(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apps (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
      spec jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
      default_visibility text NOT NULL CHECK (default_visibility IN ('shared', 'private'))
    );
    CREATE TABLE IF NOT EXISTS members (
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'member')),
      PRIMARY KEY (app_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS app_versions (
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      version integer NOT NULL, spec jsonb NOT NULL, prompt text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, version)
    );
    CREATE TABLE IF NOT EXISTS app_code_revisions (
      revision integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      source text NOT NULL,
      UNIQUE (app_id, revision)
    );
    ALTER TABLE app_code_revisions ADD COLUMN IF NOT EXISTS sample_input jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS app_code_revisions_by_app ON app_code_revisions (app_id, revision DESC);
    CREATE TABLE IF NOT EXISTS app_code_releases (
      app_id uuid PRIMARY KEY,
      revision integer NOT NULL,
      FOREIGN KEY (app_id, revision) REFERENCES app_code_revisions(app_id, revision) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS vm_apps (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL, files jsonb, error text, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE vm_apps ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
    ALTER TABLE vm_apps ADD COLUMN IF NOT EXISTS revision_error text;
  `);
}

export function schemaName(appId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(appId)) {
    throw new Error("Invalid application ID");
  }
  return `app_${appId.replaceAll("-", "")}`;
}

export function quoteIdentifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("Invalid SQL identifier");
  return `"${name}"`;
}

function sqlType(type: Entity["fields"][number]["type"]): string {
  switch (type) {
    case "text": return "text";
    case "number": return "double precision";
    case "boolean": return "boolean";
  }
}

export async function applySpec(client: PoolClient, appId: string, next: AppSpec, previous?: AppSpec): Promise<void> {
  if (previous) checkAdditiveChange(previous, next);
  const schema = quoteIdentifier(schemaName(appId));
  if (!previous) await client.query(`CREATE SCHEMA ${schema}`);
  for (const entity of next.entities) {
    const table = `${schema}.${quoteIdentifier(entity.name)}`;
    const existing = previous?.entities.find((item) => item.name === entity.name);
    if (!existing) {
      await client.query(`CREATE TABLE ${table} (
        id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES public.users(id),
        visibility text NOT NULL CHECK (visibility IN ('shared', 'private')),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    }
    for (const field of entity.fields) {
      if (!existing?.fields.some((item) => item.name === field.name)) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(field.name)} ${sqlType(field.type)}`);
      }
    }
  }
}
