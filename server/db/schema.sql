-- Schema for the drone-swarm server (docs/implementation-plan.md §3.2). Idempotent: safe to run many times.
-- Verified on timescale/timescaledb-ha:pg17 (TimescaleDB 2.28, PostGIS 3.6).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY,
  name text NOT NULL,
  origin_lat double precision NOT NULL,
  origin_lon double precision NOT NULL,
  theta_deg double precision NOT NULL,
  cell_m double precision NOT NULL,
  grid_n integer NOT NULL,
  sc double precision NOT NULL DEFAULT 0.5,            -- scene units per metre
  meta jsonb NOT NULL DEFAULT '{}'
);

-- kind: city (CITY JSON), cac_js (source text), height_map (float32 LE gzip), landmarks (json), buildings (optional)
CREATE TABLE IF NOT EXISTS site_layers (
  site_id text NOT NULL REFERENCES sites ON DELETE CASCADE,
  kind text NOT NULL,
  content_type text NOT NULL,
  data bytea,
  json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, kind)
);

CREATE TABLE IF NOT EXISTS no_fly_zones (
  id serial PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites ON DELETE CASCADE,
  name text NOT NULL,
  label text,
  floor_m real NOT NULL DEFAULT 0,
  ceiling_m real NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL,               -- circle approximated with 64 points
  CONSTRAINT no_fly_zones_site_name_key UNIQUE (site_id, name)
);
CREATE INDEX IF NOT EXISTS no_fly_zones_geom_idx ON no_fly_zones USING gist (geom);

CREATE TABLE IF NOT EXISTS drones (
  id text PRIMARY KEY,
  site_id text NOT NULL,
  swarm text,
  kind text NOT NULL CHECK (kind IN ('sim', 'real'))
);

CREATE TABLE IF NOT EXISTS missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id text NOT NULL,
  swarm text NOT NULL DEFAULT 'A',
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED', 'RUNNING', 'DONE', 'ABORTED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS mission_waypoints (
  mission_id uuid NOT NULL REFERENCES missions ON DELETE CASCADE,
  seq int NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  alt_m real NOT NULL,
  PRIMARY KEY (mission_id, seq)
);

CREATE TABLE IF NOT EXISTS telemetry (
  ts timestamptz NOT NULL,
  site_id text NOT NULL,
  drone_id text NOT NULL,
  lat double precision,
  lon double precision,
  alt_m real,
  vx real, vy real, vz real,
  heading real,
  battery real,
  link real,
  temp real,
  state text
);

-- hypertable on ts, 1 day chunks (no-op if it already is one)
SELECT create_hypertable('telemetry', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS telemetry_drone_ts_idx ON telemetry (drone_id, ts DESC);

-- columnstore (compression) after 7 days, retention 90 days
ALTER TABLE telemetry SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'drone_id',
  timescaledb.orderby = 'ts DESC'
);
CALL add_columnstore_policy('telemetry', after => INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);
