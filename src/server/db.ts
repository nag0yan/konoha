import { Pool } from "pg";

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
    CREATE TABLE IF NOT EXISTS vm_apps (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL, files jsonb, error text, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE vm_apps ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
    ALTER TABLE vm_apps ADD COLUMN IF NOT EXISTS revision_error text;
  `);
}
