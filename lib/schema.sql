PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- events
CREATE TABLE IF NOT EXISTS events (
    event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type        TEXT    NOT NULL CHECK(length(event_type) <= 128),
    domain            TEXT    NOT NULL CHECK(length(domain) <= 64),
    subdomain         TEXT    NOT NULL DEFAULT '' CHECK(length(subdomain) <= 64),
    payload           TEXT    NOT NULL,
    schema_version    TEXT    NOT NULL DEFAULT '1.0.0',
    idempotency_key   TEXT    NOT NULL UNIQUE,
    emitted_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    dedup_expires_at  INTEGER NOT NULL,
    metadata          TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_event_type       ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_domain           ON events(domain);
CREATE INDEX IF NOT EXISTS idx_events_subdomain        ON events(subdomain);
CREATE INDEX IF NOT EXISTS idx_events_type_domain      ON events(event_type, domain);
CREATE INDEX IF NOT EXISTS idx_events_emitted_at       ON events(emitted_at);
CREATE INDEX IF NOT EXISTS idx_events_expires_at       ON events(expires_at);
CREATE INDEX IF NOT EXISTS idx_events_dedup_expires_at ON events(dedup_expires_at);

-- subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id          TEXT    PRIMARY KEY,
    plugin                   TEXT    NOT NULL,
    role                     TEXT    NOT NULL CHECK(role IN ('provider','subscriber')),
    event_type_filter        TEXT    NOT NULL,
    schema_version           TEXT,
    registered_at            INTEGER NOT NULL,
    deregistered_at          INTEGER,
    health_check_interval_ms INTEGER DEFAULT 60000
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plugin ON subscriptions(plugin);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active
    ON subscriptions(plugin, role) WHERE deregistered_at IS NULL;

-- cursors
CREATE TABLE IF NOT EXISTS cursors (
    cursor_id         TEXT    PRIMARY KEY,
    subscription_id   TEXT    NOT NULL
                        REFERENCES subscriptions(subscription_id) ON DELETE RESTRICT,
    last_event_id     INTEGER NOT NULL DEFAULT 0,
    acked_at          INTEGER,
    created_at        INTEGER NOT NULL,
    deregistered_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cursors_subscription_id ON cursors(subscription_id);
CREATE INDEX IF NOT EXISTS idx_cursors_active
    ON cursors(subscription_id) WHERE deregistered_at IS NULL;

-- dead_letters: events that exhausted retries for a specific cursor.
-- Physically separate from events so poll()'s WB-003 MIN(event_id) check stays
-- correct. Denormalized so rows survive the 24h dedup_expires_at sweep of the
-- originating event. No automatic TTL — operator-managed via dlq subcommands.
CREATE TABLE IF NOT EXISTS dead_letters (
    dl_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    cursor_id         TEXT    NOT NULL
                        REFERENCES cursors(cursor_id) ON DELETE RESTRICT,
    subscription_id   TEXT    NOT NULL
                        REFERENCES subscriptions(subscription_id) ON DELETE RESTRICT,
    event_id          INTEGER NOT NULL,
    event_type        TEXT    NOT NULL,
    domain            TEXT    NOT NULL,
    subdomain         TEXT    NOT NULL DEFAULT '',
    payload           TEXT    NOT NULL,
    emitted_at        INTEGER NOT NULL,
    attempts          INTEGER NOT NULL,
    last_error        TEXT,
    dead_lettered_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_cursor_id        ON dead_letters(cursor_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_subscription_id  ON dead_letters(subscription_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_dead_lettered_at ON dead_letters(dead_lettered_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_event_id         ON dead_letters(event_id);

-- delivery_attempts: per-cursor retry state for events currently in flight.
-- Created on first handler failure, deleted on successful ack or DLQ transition.
-- Survives process restarts so the retry counter is restored on the next poll.
CREATE TABLE IF NOT EXISTS delivery_attempts (
    cursor_id        TEXT    NOT NULL
                       REFERENCES cursors(cursor_id) ON DELETE CASCADE,
    event_id         INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 1,
    last_attempt_at  INTEGER NOT NULL,
    last_error       TEXT,
    PRIMARY KEY (cursor_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_cursor_id ON delivery_attempts(cursor_id);

-- schema_migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (1, unixepoch() * 1000, 'initial schema');

INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (2, unixepoch() * 1000, 'add dead_letters and delivery_attempts tables');
