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

-- schema_migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (1, unixepoch() * 1000, 'initial schema');
