-- Migration: Add changeset_id column to pdm_changes table
-- This migration adds support for storing changeset IDs to enable direct links to changesets

-- Add changeset_id column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'pdm_changes' 
        AND column_name = 'changeset_id'
    ) THEN
        ALTER TABLE pdm_changes ADD COLUMN changeset_id BIGINT;
        CREATE INDEX IF NOT EXISTS pdm_changes_changeset_id_idx ON pdm_changes(changeset_id);
        RAISE NOTICE 'Column changeset_id added to pdm_changes';
    ELSE
        RAISE NOTICE 'Column changeset_id already exists in pdm_changes';
    END IF;
END $$;
