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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS elo_history (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), game_id INTEGER,
  elo_after INTEGER NOT NULL, delta INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
