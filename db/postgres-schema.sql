-- Postgres swap schema for Duello v1 (see README "Deploying / Postgres").
-- SQLite is the v1 default (data/duello.db). To swap, create these tables in
-- Postgres, set DATABASE_URL, and replace the SQLite helpers in server.js
-- (getUserByEmail, getUserById, createUser, updateUserElo, sessions, games,
-- elo_history) with pg equivalents. Game logic, validation, and scoring do
-- not change.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1000, elo_high INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  bot_type TEXT NOT NULL, bot_elo INTEGER NOT NULL, state JSONB NOT NULL,
  client_game_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- NOTE (v106 deploy fix): do NOT put the games_client_game_id_unique index
-- here. On an existing database CREATE TABLE IF NOT EXISTS is a no-op, so
-- the index would run before the column exists and crash initDb with
-- 'column "client_game_id" does not exist' (killed the first v106 Render
-- deploy). server.js adds the column (line 141) and creates the index
-- (line 142) after it, which is the only place the index is created.
CREATE TABLE IF NOT EXISTS elo_history (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), game_id INTEGER,
  elo_after INTEGER NOT NULL, delta INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_codes (
  email TEXT PRIMARY KEY, code_salt TEXT, code_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_token TEXT, verified_expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS password_reset_codes (
  email TEXT PRIMARY KEY, code_salt TEXT, code_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_token TEXT, verified_expires_at TIMESTAMPTZ
);
-- v141: account deletion is code-gated. Same shape as the other code
-- tables: a 6-digit code is emailed to the account's own address and
-- a verified token authorizes the delete itself.
CREATE TABLE IF NOT EXISTS delete_codes (
  email TEXT PRIMARY KEY, code_salt TEXT, code_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_token TEXT, verified_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, gender TEXT NOT NULL,
  elo INTEGER NOT NULL, photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
