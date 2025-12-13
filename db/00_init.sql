-- User names
CREATE TABLE pdm_user_names(
	userid BIGINT NOT NULL,
	username VARCHAR NOT NULL,
	CONSTRAINT pdm_user_names_pk PRIMARY KEY(userid)
);

-- Projects
CREATE TABLE pdm_projects(
	project VARCHAR PRIMARY KEY,
	start_date TIMESTAMP NOT NULL,
	end_date TIMESTAMP NULL,
	lastupdate_date TIMESTAMP NULL
);

CREATE TABLE pdm_projects_points (
	project VARCHAR,
	contrib VARCHAR,
	points integer not null,
	PRIMARY KEY (project, contrib)
);

-- User contributions through all projects
CREATE TABLE pdm_changes(
	project VARCHAR NOT NULL,
	action VARCHAR NOT NULL,
	osmid VARCHAR NOT NULL,
	version INT NOT NULL,
	ts TIMESTAMP NOT NULL,
	username VARCHAR,
	userid BIGINT,
	tags JSONB,
	contrib VARCHAR DEFAULT NULL,
	changeset_id BIGINT,

	CONSTRAINT pdm_changes_pk PRIMARY KEY(project,osmid,version)
);

CREATE INDEX ON pdm_changes(project);
CREATE INDEX ON pdm_changes(action);
CREATE INDEX ON pdm_changes(osmid);
CREATE INDEX ON pdm_changes(version);
CREATE INDEX ON pdm_changes(ts);

-- Users contributions
-- No osmid, then no primary key on this table (several contribs can occur at the same ts)
CREATE TABLE pdm_user_contribs(
	project VARCHAR NOT NULL,
	userid BIGINT NOT NULL,
	ts TIMESTAMP NOT NULL,
	contribution VARCHAR NOT NULL,
	verified BOOLEAN NOT NULL DEFAULT TRUE,
	points INT NOT NULL DEFAULT 1
);

CREATE INDEX ON pdm_user_contribs(project);
CREATE INDEX ON pdm_user_contribs(userid);

-- User badges
DROP TABLE IF EXISTS pdm_user_badges;

-- Features overall counts
CREATE TABLE pdm_feature_counts(
	project VARCHAR NOT NULL,
	ts TIMESTAMP NOT NULL,
	amount INT NOT NULL,

	CONSTRAINT pdm_feature_counts_pk PRIMARY KEY(project,ts)
);

CREATE INDEX ON pdm_feature_counts(project);

-- Note counts
CREATE TABLE pdm_note_counts(
	project VARCHAR NOT NULL,
	ts TIMESTAMP NOT NULL,
	open INT NOT NULL,
	closed INT NOT NULL
);

CREATE INDEX ON pdm_note_counts(project);

-- Global note counts (France)
CREATE TABLE IF NOT EXISTS pdm_note_counts_global(
	ts TIMESTAMP NOT NULL,
	open INT NOT NULL,
	closed INT NOT NULL,
	CONSTRAINT pdm_note_counts_global_pk PRIMARY KEY(ts)
);

CREATE INDEX ON pdm_note_counts_global(ts);

-- Note counts per boundary
CREATE TABLE IF NOT EXISTS pdm_note_counts_per_boundary(
	boundary BIGINT NOT NULL,
	ts TIMESTAMP NOT NULL,
	open INT NOT NULL,
	closed INT NOT NULL,
	CONSTRAINT pdm_note_counts_per_boundary_pk PRIMARY KEY(boundary, ts)
);

CREATE INDEX ON pdm_note_counts_per_boundary using btree (boundary);
CREATE INDEX ON pdm_note_counts_per_boundary using btree (ts);

-- Statistics per project and administrative boundary
-- boundary can be null until we'll able to get geometry of deleted features
CREATE TABLE pdm_features_boundary (
	project VARCHAR NOT NULL,
	osmid VARCHAR NOT NULL,
	boundary BIGINT,
	start_ts TIMESTAMP NOT NULL,
	end_ts TIMESTAMP,

	UNIQUE(project,osmid,boundary)
);

CREATE INDEX ON pdm_features_boundary USING btree(project);
CREATE INDEX ON pdm_features_boundary USING btree(osmid);
CREATE INDEX ON pdm_features_boundary USING btree(boundary);

CREATE TABLE pdm_feature_counts_per_boundary(
	project VARCHAR NOT NULL,
	boundary BIGINT NOT NULL,
	ts TIMESTAMP NOT NULL,
	amount INT NOT NULL,

	CONSTRAINT pdm_feature_counts_per_boundary_pk PRIMARY KEY(project, boundary, ts)
);

CREATE INDEX ON pdm_feature_counts_per_boundary using btree (project);
CREATE INDEX ON pdm_feature_counts_per_boundary using btree (boundary);

-- Extensions for Imposm
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;

-- Leaderboard view
CREATE OR REPLACE VIEW pdm_leaderboard AS
WITH stats AS (
	SELECT userid, project, SUM(points) AS amount
	FROM pdm_user_contribs
	GROUP BY userid, project
	ORDER BY SUM(points) DESC
), scores AS (
	SELECT project, row_number() over (PARTITION BY project ORDER BY amount DESC) AS pos, amount
	FROM (
		SELECT DISTINCT project, amount
		FROM stats
		ORDER BY project, amount DESC
	) a
)
SELECT st.project, st.userid, un.username, st.amount, sc.pos
FROM stats st
JOIN scores sc ON st.project = sc.project AND sc.amount = st.amount
JOIN pdm_user_names un ON st.userid = un.userid;

-- OSM compare feature exclusions
CREATE TABLE pdm_compare_exclusions(
	project VARCHAR NOT NULL,
	osm_id VARCHAR NOT NULL,
	ts TIMESTAMP NOT NULL DEFAULT current_timestamp,
	userid BIGINT,
	CONSTRAINT pdm_compare_exclusions_pk PRIMARY KEY(project, osm_id)
);

-- Quality completion tracking
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
    -- Extract the last part after the last underscore, or use the whole project id if no underscore
    v_parts := string_to_array(p_project, '_');
    IF array_length(v_parts, 1) IS NULL OR array_length(v_parts, 1) = 0 THEN
        v_last_part := p_project;
    ELSE
        v_last_part := v_parts[array_length(v_parts, 1)];
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

-- OSM Plein Air - Hiking routes tables
CREATE TABLE IF NOT EXISTS pdm_relation_hiking (
    osm_id BIGINT PRIMARY KEY,
    name VARCHAR,
    tags JSONB,
    geom GEOMETRY(Polygon, 3857),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pdm_relation_hiking_geom_idx ON pdm_relation_hiking USING GIST(geom);
CREATE INDEX IF NOT EXISTS pdm_relation_hiking_name_idx ON pdm_relation_hiking(name);

CREATE TABLE IF NOT EXISTS pdm_relation_hiking_members (
    relation_id BIGINT NOT NULL,
    ts TIMESTAMP NOT NULL,
    member_count INT NOT NULL,
    changeset_id BIGINT,
    username VARCHAR,
    userid BIGINT,
    CONSTRAINT pdm_relation_hiking_members_pk PRIMARY KEY(relation_id, ts)
);

CREATE INDEX IF NOT EXISTS pdm_relation_hiking_members_relation_idx ON pdm_relation_hiking_members(relation_id);
CREATE INDEX IF NOT EXISTS pdm_relation_hiking_members_ts_idx ON pdm_relation_hiking_members(ts);

-- Function to generate badges for a single user and project
CREATE OR REPLACE FUNCTION pdm_get_badges(the_project VARCHAR, the_userid BIGINT) RETURNS TABLE (id VARCHAR, name VARCHAR, description VARCHAR, acquired BOOLEAN, progress INT) AS $$
DECLARE
	nb_contributions INT;
	result_userid BIGINT;
	result_count INT;
	result_position INT;
BEGIN
	-- Common badges to all projects
	IF the_project != 'meta' THEN
		-- Amount of contributions
		SELECT amount, pos INTO nb_contributions, result_position
		FROM pdm_leaderboard
		WHERE project = the_project AND userid = the_userid;

		-- 1st, 2nd and 3rd position
		IF result_position <= 3 THEN
			id := CASE WHEN result_position = 1 THEN 'score_1st' WHEN result_position = 2 THEN 'score_2nd' ELSE 'score_3rd' END;
			name := CASE WHEN result_position = 1 THEN '1ère place' WHEN result_position = 2 THEN '2ème place' ELSE '3ème place' END;
			description := 'Vous êtes sur le podium, félicitations !';
			acquired := true;
			progress := 100;
			RETURN next;
		-- Near podium
		ELSIF result_position <= 10 THEN
			id := 'score_3rd';
			name := 'Près du podium';
			description := 'Vous n''êtes qu''à quelques points d''être sur le podium !';
			acquired := false;
			progress := FLOOR((result_position - 3)::float / 7 * 100);
			RETURN next;
		END IF;

		-- Badges related to amount of contributions
		IF nb_contributions < 3 THEN
			id := '1_edit';
			name := '1er point';
			description := 'Lancez-vous dans l''aventure';
			acquired := nb_contributions >= 1;
			progress := acquired::INT * 100;
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 1 AND 5 THEN
			id := '3_edits';
			name := '3+ points';
			description := 'Premiers pas';
			acquired := nb_contributions >= 3;
			progress := FLOOR(LEAST(nb_contributions, 3)::FLOAT / 3 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 3 AND 9 THEN
			id := '6_edits';
			name := '6+ points';
			description := 'Bien parti';
			acquired := nb_contributions >= 6;
			progress := FLOOR(LEAST(nb_contributions, 6)::FLOAT / 6 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 6 AND 29 THEN
			id := '10_edits';
			name := '10+ points';
			description := 'Envie d''aller un peu plus loin';
			acquired := nb_contributions >= 10;
			progress := FLOOR(LEAST(nb_contributions, 10)::FLOAT / 10 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 10 AND 41 THEN
			id := '30_edits';
			name := '30+ points';
			description := 'J''aime bien c''est sympa comme projet';
			acquired := nb_contributions >= 30;
			progress := FLOOR(LEAST(nb_contributions, 30)::FLOAT / 30 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 30 AND 69 THEN
			id := '42_edits';
			name := '42+ points';
			description := 'La réponse à la grande question sur la vie, l''univers et le reste';
			acquired := nb_contributions >= 42;
			progress := FLOOR(LEAST(nb_contributions, 42)::FLOAT / 42 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 42 AND 99 THEN
			id := '70_edits';
			name := '70+ points';
			description := '70 points par heure, tout s''accélère';
			acquired := nb_contributions >= 70;
			progress := FLOOR(LEAST(nb_contributions, 70)::FLOAT / 70 * 100);
			RETURN next;
		END IF;

		IF nb_contributions BETWEEN 70 AND 499 THEN
			id := '100_edits';
			name := '100+ points';
			description := 'Et de 100 !';
			acquired := nb_contributions >= 100;
			progress := LEAST(nb_contributions, 100);
			RETURN next;
		END IF;

		IF nb_contributions >= 100 THEN
			id := '500_edits';
			name := '500+ points';
			description := 'Objectif Lune';
			acquired := nb_contributions >= 500;
			progress := FLOOR(LEAST(nb_contributions, 500)::FLOAT / 500 * 100);
			RETURN next;
		END IF;
	-- Meta badges
	ELSE
		-- Best contributor through all projects
		SELECT userid, COUNT(*) INTO result_userid, result_count
		FROM pdm_user_contribs
		GROUP BY userid
		ORDER BY COUNT(*) DESC
		LIMIT 1;

		id := 'best_contributor';
		name := 'N°1 des contributions';
		acquired := result_userid = the_userid;

		IF acquired THEN
			progress := 100;
			description := 'Le plus de points sur l''ensemble des projets';
			RETURN next;
		ELSE
			SELECT COUNT(*)::FLOAT / result_count * 100 INTO progress
			FROM pdm_user_contribs
			WHERE userid = the_userid;
			IF progress >= 50 THEN
				description := 'Détronez la personne ayant le plus de points à ce jour';
				RETURN next;
			END IF;
		END IF;
	END IF;
END;
$$ LANGUAGE plpgsql
IMMUTABLE ROWS 100;
