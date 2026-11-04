CREATE TABLE IF NOT EXISTS media_assets (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','video','music','reference')),
 prompt TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('processing','complete','error')),
 object_key TEXT,
 mime_type TEXT,
 size INTEGER NOT NULL DEFAULT 0,
 job TEXT,
 usage_id TEXT,
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_owner ON media_assets(user_id,created_at);
CREATE TABLE IF NOT EXISTS browser_sessions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 url TEXT NOT NULL,
 title TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_sessions_owner ON browser_sessions(user_id,created_at);
CREATE TABLE IF NOT EXISTS work_artifacts (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 name TEXT NOT NULL,
 object_key TEXT NOT NULL,
 mime_type TEXT NOT NULL,
 size INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_artifacts_owner ON work_artifacts(user_id,created_at);
CREATE INDEX IF NOT EXISTS work_artifacts_conversation ON work_artifacts(conversation_id);
