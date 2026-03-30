-- User files: persistent file storage for user uploads and conversation artifacts
CREATE TABLE user_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT DEFAULT 0,
    is_folder BOOLEAN NOT NULL DEFAULT false,
    parent_id UUID REFERENCES user_files(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'upload',
    conversation_id TEXT,
    storage_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_files_user_id ON user_files(user_id);
CREATE INDEX idx_user_files_parent_id ON user_files(parent_id);
CREATE INDEX idx_user_files_conversation_id ON user_files(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_user_files_user_path ON user_files(user_id, path);
