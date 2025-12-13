-- Migration script for quality completion tracking
-- This script creates tables and views to track quality scores for project objects
-- Run this with: psql -d $DB_URL -f db/01_quality_completion.sql

-- Table to store quality completion scores per object at each timestamp
CREATE TABLE IF NOT EXISTS pdm_quality_completion (
    project VARCHAR NOT NULL,
    osmid VARCHAR NOT NULL,
    ts TIMESTAMP NOT NULL,
    completion_percentage INT NOT NULL CHECK (completion_percentage >= 0 AND completion_percentage <= 100),
    tags_present TEXT[],
    tags_missing TEXT[],
    CONSTRAINT pdm_quality_completion_pk PRIMARY KEY(project, osmid, ts)
);

CREATE INDEX IF NOT EXISTS pdm_quality_completion_project_ts_idx ON pdm_quality_completion(project, ts);
CREATE INDEX IF NOT EXISTS pdm_quality_completion_project_percentage_idx ON pdm_quality_completion(project, completion_percentage);

-- Table to store aggregated quality statistics per day
CREATE TABLE IF NOT EXISTS pdm_quality_stats (
    project VARCHAR NOT NULL,
    ts TIMESTAMP NOT NULL,
    total_objects INT NOT NULL,
    avg_completion NUMERIC(5,2) NOT NULL,
    fully_complete INT NOT NULL DEFAULT 0,
    partially_complete INT NOT NULL DEFAULT 0,
    incomplete INT NOT NULL DEFAULT 0,
    CONSTRAINT pdm_quality_stats_pk PRIMARY KEY(project, ts)
);

CREATE INDEX IF NOT EXISTS pdm_quality_stats_project_ts_idx ON pdm_quality_stats(project, ts);

-- Function to calculate quality completion for a project
-- This function will be called from the update script
CREATE OR REPLACE FUNCTION pdm_calculate_quality_completion(
    p_project VARCHAR,
    p_required_tags TEXT[],
    p_timestamp TIMESTAMP DEFAULT NOW()
) RETURNS VOID AS $$
DECLARE
    v_project_table VARCHAR;
    v_table_exists BOOLEAN;
    v_parts TEXT[];
    v_last_part TEXT;
BEGIN
    -- Get the project table name (e.g., pdm_project_streetlamps)
    -- Extract everything after the first underscore (e.g., "2025-02_data_center" -> "data_center")
    -- or use the whole project id if no underscore
    v_parts := string_to_array(p_project, '_');
    IF array_length(v_parts, 1) IS NULL OR array_length(v_parts, 1) <= 1 THEN
        v_last_part := p_project;
    ELSE
        -- Join all parts after the first one (skip the date part)
        v_last_part := array_to_string(v_parts[2:array_length(v_parts, 1)], '_');
    END IF;
    v_project_table := 'pdm_project_' || v_last_part;
    
    -- Check if the project table/view exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.views 
        WHERE table_schema = 'public' 
        AND table_name = v_project_table
    ) INTO v_table_exists;
    
    IF NOT v_table_exists THEN
        RAISE NOTICE 'Project table % does not exist, skipping quality calculation', v_project_table;
        RETURN;
    END IF;
    
    -- Calculate completion for each object at the given timestamp
    -- Use historical changes to reconstruct object state at that time
    EXECUTE format('
        WITH object_history AS (
            -- Get the latest change for each object before or at the timestamp
            SELECT DISTINCT ON (osmid)
                osmid,
                tags,
                ts
            FROM pdm_changes
            WHERE project = $2
                AND ts <= $3
                AND action != ''delete''
            ORDER BY osmid, ts DESC, version DESC
        ),
        current_objects AS (
            -- Get objects that exist in the project table (for objects that haven''t changed since timestamp)
            SELECT 
                osm_id::TEXT AS osmid,
                tags::jsonb AS tags_json
            FROM %I
            WHERE osm_id::TEXT NOT IN (SELECT osmid FROM object_history WHERE ts <= $3)
        ),
        historical_objects AS (
            -- Objects from history
            SELECT 
                osmid,
                CASE 
                    WHEN tags IS NULL OR tags = ''{}''::jsonb THEN ''{}''::jsonb
                    ELSE tags::jsonb
                END AS tags_json
            FROM object_history
        ),
        all_objects AS (
            SELECT osmid, tags_json FROM current_objects
            UNION ALL
            SELECT osmid, tags_json FROM historical_objects
        ),
        completion_calc AS (
            SELECT 
                osmid,
                tags_json,
                ARRAY(
                    SELECT tag FROM unnest($1) AS tag 
                    WHERE tags_json ? tag
                ) AS tags_present,
                ARRAY(
                    SELECT tag FROM unnest($1) AS tag 
                    WHERE NOT (tags_json ? tag)
                ) AS tags_missing
            FROM all_objects
        )
        INSERT INTO pdm_quality_completion (project, osmid, ts, completion_percentage, tags_present, tags_missing)
        SELECT 
            $2 AS project,
            osmid,
            $3 AS ts,
            CASE 
                WHEN array_length($1, 1) IS NULL OR array_length($1, 1) = 0 THEN 0
                ELSE ROUND(
                    (COALESCE(array_length(tags_present, 1), 0)::NUMERIC / NULLIF(array_length($1, 1), 0)) * 100
                )::INT
            END AS completion_percentage,
            COALESCE(tags_present, ARRAY[]::TEXT[]),
            COALESCE(tags_missing, ARRAY[]::TEXT[])
        FROM completion_calc
        ON CONFLICT (project, osmid, ts) DO UPDATE SET
            completion_percentage = EXCLUDED.completion_percentage,
            tags_present = EXCLUDED.tags_present,
            tags_missing = EXCLUDED.tags_missing
    ', v_project_table) USING p_required_tags, p_project, p_timestamp;
    
    -- Calculate aggregated statistics for the timestamp
    INSERT INTO pdm_quality_stats (project, ts, total_objects, avg_completion, fully_complete, partially_complete, incomplete)
    SELECT 
        project,
        p_timestamp AS ts,
        COUNT(*) AS total_objects,
        ROUND(AVG(completion_percentage)::NUMERIC, 2) AS avg_completion,
        COUNT(*) FILTER (WHERE completion_percentage = 100) AS fully_complete,
        COUNT(*) FILTER (WHERE completion_percentage >= 50 AND completion_percentage < 100) AS partially_complete,
        COUNT(*) FILTER (WHERE completion_percentage < 50) AS incomplete
    FROM pdm_quality_completion
    WHERE project = p_project AND ts = p_timestamp
    GROUP BY project
    ON CONFLICT (project, ts) DO UPDATE SET
        total_objects = EXCLUDED.total_objects,
        avg_completion = EXCLUDED.avg_completion,
        fully_complete = EXCLUDED.fully_complete,
        partially_complete = EXCLUDED.partially_complete,
        incomplete = EXCLUDED.incomplete;
    
END;
$$ LANGUAGE plpgsql;

-- Function to calculate quality completion for all dates where feature counts exist
CREATE OR REPLACE FUNCTION pdm_calculate_quality_completion_all_dates(
    p_project VARCHAR,
    p_required_tags TEXT[]
) RETURNS VOID AS $$
DECLARE
    v_date_record RECORD;
    v_count INT;
BEGIN
    -- Get all dates where feature counts exist for this project
    FOR v_date_record IN 
        SELECT DISTINCT ts 
        FROM pdm_feature_counts 
        WHERE project = p_project 
        ORDER BY ts
    LOOP
        -- Calculate completion for this date
        PERFORM pdm_calculate_quality_completion(p_project, p_required_tags, v_date_record.ts);
    END LOOP;
    
    -- Also calculate for the current date if not already done
    IF NOT EXISTS (
        SELECT 1 FROM pdm_quality_stats 
        WHERE project = p_project AND ts::date = CURRENT_DATE
    ) THEN
        PERFORM pdm_calculate_quality_completion(p_project, p_required_tags, NOW()::timestamp);
    END IF;
    
END;
$$ LANGUAGE plpgsql;

