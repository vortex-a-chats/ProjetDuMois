const CONFIG = require('../config.json');
const fs = require('fs');
const projects = require('../website/projects');
const yaml = require('js-yaml');

// Get project filter from command line arguments
const targetProjectId = process.argv[2] || null;
let projectsToProcess = Object.entries(projects);

if (targetProjectId) {
	// Filter to only the specified project
	if (!projects[targetProjectId]) {
		console.error(`ERROR: Project "${targetProjectId}" not found.`);
		console.error(`Available projects: ${Object.keys(projects).join(', ')}`);
		process.exit(1);
	}
	projectsToProcess = [[targetProjectId, projects[targetProjectId]]];
	console.log(`Processing only project: ${targetProjectId}`);
} else {
	console.log(`Processing all ${projectsToProcess.length} projects`);
}

/*
 * Generates 21_features_update_tmp.sh
 * in order to update minutely/hourly OSM features
 */

// Constants
const OSM_PBF_LATEST = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".osm.pbf");
const OSM_PBF_LATEST_UNSTABLE = OSM_PBF_LATEST.replace(".osm.pbf", ".new.osm.pbf");
const OSM_PBF_LATEST_UNSTABLE_FILTERED = OSM_PBF_LATEST.replace(".osm.pbf", ".new-local.osm.pbf");
const OSM_POLY = OSM_PBF_LATEST.replace("-internal.osm.pbf", ".poly");
const OSH_FILE = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.osh.pbf");
const IMPOSM_ENABLED = CONFIG.hasOwnProperty("DB_USE_IMPOSM_UPDATE") ? CONFIG.DB_USE_IMPOSM_UPDATE : true;
const IMPOSM_YML = CONFIG.WORK_DIR + '/imposm.yml';
const IMPOSM_CACHE_DIR = CONFIG.WORK_DIR + '/imposm_cache';
const IMPOSM_DIFF_DIR = CONFIG.WORK_DIR + '/imposm_diffs';
const OSC_FULL = CONFIG.WORK_DIR + '/changes_features.osc.gz';
const OSC_LOCAL = CONFIG.WORK_DIR + '/changes_features.local.osc.gz';
const OUTPUT_SCRIPT = CONFIG.WORK_DIR + '/21_features_update_tmp.sh';
const UNINSTALL_SCRIPT = CONFIG.WORK_DIR + '/91_project_uninstall_tmp.sql';

// Generate Imposm YAML config file
const yamlData = {
	tables: {
		'boundary_osm': {
			type: 'polygon',
			mapping: { boundary: ['administrative'] },
			filters: {
				require: { 'admin_level': ['4','6','8'] }
			},
			columns: [
				{ name: 'osm_id', type: 'id' },
				{ name: 'name', key: 'name', type: 'string' },
				{ name: 'admin_level', key: 'admin_level', type: 'integer' },
				{ name: 'tags', type: 'hstore_tags' },
				{ name: 'geom', type: 'geometry' }
			]
		}
	},
	tags: { load_all: true }
};

const preSQL = [
	"DROP MATERIALIZED VIEW IF EXISTS pdm_boundary_tiles CASCADE",
	"DROP MATERIALIZED VIEW IF EXISTS pdm_boundary_subdivide CASCADE"
]; // Suppression des ressources projets
const postSQL = []; // Creation des ressources projets
const postUpdateSQL = [];

if(IMPOSM_ENABLED) {
	preSQL.push(`DROP MATERIALIZED VIEW IF EXISTS pdm_boundary CASCADE`);
	postSQL.push(`CREATE MATERIALIZED VIEW pdm_boundary AS SELECT *, ST_Centroid(geom)::GEOMETRY(Point, 3857) AS centre FROM pdm_boundary_osm`);
	postSQL.push(`CREATE INDEX pdm_boundary_osm_id_idx ON pdm_boundary(osm_id);`);
	postUpdateSQL.push(`REFRESH MATERIALIZED VIEW pdm_boundary`);
}

projectsToProcess.forEach(e => {
	const [ id, project ] = e;
	// Extract project name: for "2025-02_data_center", we want "data_center" (everything after the first underscore)
	const projectNameParts = id.split("_");
	const projectName = projectNameParts.length > 1 ? projectNameParts.slice(1).join("_") : id;

	if (IMPOSM_ENABLED) {
		const tableData = {
			mapping: project.database.imposm.mapping,
			columns: [
				{ name: 'osm_id', type: 'id' },
				{ name: 'name', key: 'name', type: 'string' },
				{ name: 'tags', type: 'hstore_tags' },
				{ name: 'geom', type: 'geometry' }
			]
		};

		project.database.imposm.types.forEach(type => {
			yamlData.tables[`project_${projectName}_${type}`] = Object.assign({ type }, tableData);
		});

		preSQL.push(`DROP VIEW IF EXISTS pdm_project_${projectName} CASCADE`);
		postSQL.push(
			`CREATE OR REPLACE VIEW pdm_project_${projectName} AS `
			+ project.database.imposm.types.map(type => {
				const osmid = type === "point" ? "CONCAT('node/', osm_id) AS osm_id" : "CASE WHEN osm_id < 0 THEN CONCAT('relation/', -osm_id) ELSE CONCAT('way/', osm_id) END AS osm_id";
				const geom = type === "point" ? "geom::GEOMETRY(Point, 3857)" : "ST_PointOnSurface(geom)::GEOMETRY(Point, 3857) AS geom";
				return `SELECT ${osmid}, name, hstore_to_json(tags) AS tags, tags ?| ARRAY['note','fixme'] AS needs_check, ${geom} FROM pdm_project_${projectName}_${type}`
			}).join(" UNION ALL ")
		);

		if(project.database.compare) {
			// Table definition
			project.database.compare.types.forEach(type => {
				yamlData.tables[`project_${projectName}_compare_${type}`] = Object.assign({ type }, tableData, { mapping: project.database.compare.mapping });
			});

			preSQL.push(`DROP VIEW IF EXISTS pdm_project_${projectName}_compare CASCADE`);
			postSQL.push(
				`CREATE OR REPLACE VIEW pdm_project_${projectName}_compare AS `
				+ project.database.compare.types.map(type => {
					const osmid = type === "point" ? "CONCAT('node/', osm_id) AS osm_id" : "CASE WHEN osm_id < 0 THEN CONCAT('relation/', -osm_id) ELSE CONCAT('way/', osm_id) END AS osm_id";
					const geom = type === "point" ? "geom::GEOMETRY(Point, 3857)" : "ST_Centroid(geom)::GEOMETRY(Point, 3857) AS geom";
					return `SELECT ${osmid}, name, hstore_to_json(tags) AS tags, ${geom} FROM pdm_project_${projectName}_compare_${type}`
				}).join(" UNION ALL ")
			);
		}
	}

	// Comparison tables
	if(project.database.compare) {
		preSQL.push(`DROP MATERIALIZED VIEW IF EXISTS pdm_project_${projectName}_compare_tiles`);
		postSQL.push(
			`CREATE MATERIALIZED VIEW IF NOT EXISTS pdm_project_${projectName}_compare_tiles AS SELECT * FROM pdm_project_${projectName}_compare WHERE osm_id NOT IN (SELECT DISTINCT c.osm_id FROM pdm_project_${projectName}_compare c, pdm_project_${projectName} b WHERE ST_DWithin(c.geom, b.geom, ${project.database.compare.radius}))`
		);
		postSQL.push(`CREATE INDEX ON pdm_project_${projectName}_compare_tiles USING GIST(geom)`);
		postUpdateSQL.push(`REFRESH MATERIALIZED VIEW pdm_project_${projectName}_compare_tiles`);

		preSQL.push(`DROP VIEW IF EXISTS pdm_project_${projectName}_compare_tiles_filtered CASCADE`);
		postSQL.push(
			`CREATE VIEW pdm_project_${projectName}_compare_tiles_filtered AS SELECT a.* FROM pdm_project_${projectName}_compare_tiles a LEFT JOIN pdm_compare_exclusions b ON b.project = '${id}' AND a.osm_id = b.osm_id WHERE b.osm_id IS NULL`
		);
	}
});

if (IMPOSM_ENABLED){
	fs.writeFile(IMPOSM_YML, yaml.safeDump(yamlData), err => {
		if(err) {
			throw new Error(err);
		}
	});
}

// View for multi-type layers
const sqlToFull = sqlin => sqlin.map(vs => (`psql -d ${process.env.DB_URL} -c "${vs}"`)).join("\n\t");
const sqlToScript = sqlin => sqlin.map(vs => (`${vs};`)).join("\n\t");
const preSQLFull = preSQL.length > 0 ? sqlToFull(preSQL) : "";
const postSQLFull = postSQL.length > 0 ? sqlToFull(postSQL) : "";
const postUpdateSQLFull = postUpdateSQL.length > 0 ? sqlToFull(postUpdateSQL) : "";


// Script text
const separator = `echo "-------------------------------------------------------------------"
echo ""`;

var script = `#!/bin/bash

# Script for updating OSM features for each project
# Generated automatically by npm run features:update

set -e

mode="$1"
if [ "$mode" == "" ]; then
	mode="update"
fi
`;

if (IMPOSM_ENABLED){
	script += `
echo "==== Get latest changes"
prev_timestamp=""
if [ -f ${CONFIG.WORK_DIR}/osh_timestamp ]; then
	prev_timestamp=$(cat ${CONFIG.WORK_DIR}/osh_timestamp)
	# Verify timestamp is valid
	if [ -n "$prev_timestamp" ]; then
		timestamp_epoch=$(date -d "$prev_timestamp" +%s 2>/dev/null || echo 0)
		if [ $timestamp_epoch -eq 0 ] 2>/dev/null; then
			echo "   ⚠️  WARNING: Invalid timestamp format in osh_timestamp, ignoring it"
			prev_timestamp=""
		fi
	fi
fi

# Check if OSM PBF file exists, if not create it from OSH file
if [ ! -f "${OSM_PBF_LATEST}" ]; then
	echo "   ℹ️  OSM PBF file not found, creating from OSH file..."
	OSH_FILE="${OSH_FILE}"
	if [ -f "${OSH_FILE}" ]; then
		osmium time-filter "${OSH_FILE}" -O -o "${OSM_PBF_LATEST}"
		if [ $? -eq 0 ] && [ -f "${OSM_PBF_LATEST}" ]; then
			echo "   ✓ Created ${OSM_PBF_LATEST} from OSH file"
		else
			echo "   ❌ ERROR: Failed to create OSM PBF from OSH file"
			exit 1
		fi
	else
		echo "   ❌ ERROR: Neither OSM PBF nor OSH file found."
		echo "   OSM PBF expected at: ${OSM_PBF_LATEST}"
		echo "   OSH file expected at: ${OSH_FILE}"
		echo "   Please run 'update_pbf' first."
		exit 1
	fi
fi

# Check if OSH update was done recently (within last hour)
# If so, skip the update to avoid redundant downloads
SKIP_UPDATE=false
if [ -n "$prev_timestamp" ] && [ -f "${OSM_PBF_LATEST}" ]; then
	TIMESTAMP_AGE=$(($(date +%s) - $(date -d "$prev_timestamp" +%s 2>/dev/null || echo 0)))
	if [ "$TIMESTAMP_AGE" -lt 3600 ]; then
		echo "   ℹ️  OSH update was done recently (less than 1 hour ago), skipping update"
		SKIP_UPDATE=true
	fi
fi

if [ "$SKIP_UPDATE" = "false" ]; then
	if [ -n "$prev_timestamp" ]; then
		osmupdate --keep-tempfiles --trust-tempfiles --hour \\
			-t="${CONFIG.WORK_DIR}/osmupdate/" \\
			-v "${OSM_PBF_LATEST}" "$prev_timestamp" \\
			"${OSC_FULL}"
	else
		osmupdate --keep-tempfiles --trust-tempfiles --hour \\
			-t="${CONFIG.WORK_DIR}/osmupdate/" \\
			-v "${OSM_PBF_LATEST}" \\
			"${OSC_FULL}"
	fi
	osmium apply-changes "${OSM_PBF_LATEST}" \\
		"${OSC_FULL}" \\
		-O -o "${OSM_PBF_LATEST_UNSTABLE}"
	osmium extract -p "${OSM_POLY}" -s simple -S types=boundary,multipolygon "${OSM_PBF_LATEST_UNSTABLE}" -O -o "${OSM_PBF_LATEST_UNSTABLE_FILTERED}"
	rm -f "${OSM_PBF_LATEST_UNSTABLE}" "${OSC_FULL}"
	# Update timestamp after successful update (use current time minus 3 hours to account for replication delay)
	curtime=$(date -d '3 hours ago' -Iseconds --utc 2>/dev/null || date -u -Iseconds)
	timestamp=\${curtime/"+00:00"/"Z"}
	echo "$timestamp" > ${CONFIG.WORK_DIR}/osh_timestamp
	echo "   ✓ Updated OSH timestamp: $timestamp"
else
	# Use existing file if update was skipped
	if [ ! -f "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" ]; then
		# If filtered file doesn't exist, we need to create it from the latest file
		if [ -f "${OSM_PBF_LATEST}" ]; then
			osmium extract -p "${OSM_POLY}" -s simple -S types=boundary,multipolygon "${OSM_PBF_LATEST}" -O -o "${OSM_PBF_LATEST_UNSTABLE_FILTERED}"
		else
			echo "   ⚠️  Warning: ${OSM_PBF_LATEST} not found, cannot skip update"
			SKIP_UPDATE=false
			if [ -n "$prev_timestamp" ]; then
				osmupdate --keep-tempfiles --trust-tempfiles --hour \\
					-t="${CONFIG.WORK_DIR}/osmupdate/" \\
					-v "${OSM_PBF_LATEST}" "$prev_timestamp" \\
					"${OSC_FULL}"
			else
				osmupdate --keep-tempfiles --trust-tempfiles --hour \\
					-t="${CONFIG.WORK_DIR}/osmupdate/" \\
					-v "${OSM_PBF_LATEST}" \\
					"${OSC_FULL}"
			fi
			osmium apply-changes "${OSM_PBF_LATEST}" \\
				"${OSC_FULL}" \\
				-O -o "${OSM_PBF_LATEST_UNSTABLE}"
			osmium extract -p "${OSM_POLY}" -s simple -S types=boundary,multipolygon "${OSM_PBF_LATEST_UNSTABLE}" -O -o "${OSM_PBF_LATEST_UNSTABLE_FILTERED}"
			rm -f "${OSM_PBF_LATEST_UNSTABLE}" "${OSC_FULL}"
			# Update timestamp after successful update (use current time minus 3 hours to account for replication delay)
			curtime=$(date -d '3 hours ago' -Iseconds --utc 2>/dev/null || date -u -Iseconds)
			timestamp=\${curtime/"+00:00"/"Z"}
			echo "$timestamp" > ${CONFIG.WORK_DIR}/osh_timestamp
			echo "   ✓ Updated OSH timestamp: $timestamp"
		fi
	fi
fi
${separator}

if [ "$mode" == "init" ]; then
	echo "==== Initial import with Imposm"
	rm -f "${OSM_PBF_LATEST}" "${OSC_LOCAL}"
	mv "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" "${OSM_PBF_LATEST}"
	mkdir -p "${IMPOSM_CACHE_DIR}"
	imposm import -mapping "${IMPOSM_YML}" \\
		-read "${OSM_PBF_LATEST}" \\
		-overwritecache -cachedir "${IMPOSM_CACHE_DIR}" \\
		-diff -diffdir "${IMPOSM_DIFF_DIR}"

	echo "Pre SQL..."
	${preSQLFull}

	imposm import -write \\
		-connection "${process.env.DB_URL}?prefix=pdm_" \\
		-mapping "${IMPOSM_YML}" \\
		-cachedir "${IMPOSM_CACHE_DIR}" \\
		-dbschema-import public -diff

	echo "Post SQL..."
	${postSQLFull}
	psql -d ${process.env.DB_URL} -f "${__dirname}/22_features_post_init.sql"
else
	echo "==== Apply latest changes to database"
	# Only derive changes if we have both source files
	if [ -f "${OSM_PBF_LATEST}" ] && [ -f "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" ]; then
		osmium derive-changes "${OSM_PBF_LATEST}" "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" -O -o "${OSC_LOCAL}"
	else
		echo "   ℹ️  Skipping derive-changes: source files not available"
		touch "${OSC_LOCAL}"  # Create empty file to avoid errors
	fi
	
	# Check if tables for the specific projects exist
	# Build a list of expected table names from the YAML mapping
	EXPECTED_TABLES="${projectsToProcess.map(([id, project]) => {
		const projectNameParts = id.split("_");
		const projectName = projectNameParts.length > 1 ? projectNameParts.slice(1).join("_") : id;
		return project.database.imposm.types.map(type => {
			return `pdm_project_${projectName}_${type}`;
		}).join(" ");
	}).join(" ")}"
	
	MISSING_TABLES=""
	for table in $EXPECTED_TABLES; do
		EXISTS=$(psql -d ${process.env.DB_URL} -t -c "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '$table')" 2>/dev/null | tr -d ' ' || echo "f")
		if [ "$EXISTS" != "t" ]; then
			if [ -z "$MISSING_TABLES" ]; then
				MISSING_TABLES="$table"
			else
				MISSING_TABLES="$MISSING_TABLES $table"
			fi
		fi
	done
	
	if [ -n "$MISSING_TABLES" ]; then
		echo "WARNING: Some project tables are missing: $MISSING_TABLES"
		echo "Creating missing tables..."
		echo "Pre SQL (drop views)..."
		${preSQLFull}
		imposm import -mapping "${IMPOSM_YML}" \\
			-read "${OSM_PBF_LATEST}" \\
			-overwritecache -cachedir "${IMPOSM_CACHE_DIR}" \\
			-diff -diffdir "${IMPOSM_DIFF_DIR}"
		imposm import -write \\
			-connection "${process.env.DB_URL}?prefix=pdm_" \\
			-mapping "${IMPOSM_YML}" \\
			-cachedir "${IMPOSM_CACHE_DIR}" \\
			-dbschema-import public -diff
		echo "Post SQL (create views)..."
		${postSQLFull}
		psql -d ${process.env.DB_URL} -f "${__dirname}/22_features_post_init.sql"
		rm -f "${OSM_PBF_LATEST}" "${OSC_LOCAL}"
		mv "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" "${OSM_PBF_LATEST}"
	else
		# Only apply diff if we have changes and the local OSC file exists
		if [ -f "${OSC_LOCAL}" ] && [ -s "${OSC_LOCAL}" ]; then
			imposm diff -mapping "${IMPOSM_YML}" \\
				-cachedir "${IMPOSM_CACHE_DIR}" \\
				-dbschema-production public \\
				-connection "${process.env.DB_URL}?prefix=pdm_" \\
				"${OSC_LOCAL}"
		else
			echo "   ℹ️  No changes to apply (OSC file is empty or missing)"
		fi
	fi

	echo "Post Update SQL..."
	${postUpdateSQLFull}
	
	# Only move the filtered file if it exists and we're not in skip mode
	if [ "$SKIP_UPDATE" = "false" ] && [ -f "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" ]; then
		rm -f "${OSM_PBF_LATEST}" "${OSC_LOCAL}"
		mv "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" "${OSM_PBF_LATEST}"
	elif [ "$SKIP_UPDATE" = "true" ] && [ -f "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" ]; then
		# Clean up temporary file if it was created
		rm -f "${OSM_PBF_LATEST_UNSTABLE_FILTERED}"
	fi
fi
`;
}
else {
	script += `
if [ "$mode" == "init" ]; then
	echo "Pre SQL..."
	${preSQLFull}

	echo "Post SQL..."
	${postSQLFull}
	psql -d ${process.env.DB_URL} -f "${__dirname}/22_features_post_init.sql"`;
if (postUpdateSQLFull.length > 0){
	script += `
else
	echo "Post Update SQL..."
	${postUpdateSQLFull}`;
}
script += `
fi
`;
}
script += `${separator}

echo "Done"
`;

// Ensure work directory exists
if (!fs.existsSync(CONFIG.WORK_DIR)) {
	fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });
}

// Script de mise à jour
fs.writeFile(OUTPUT_SCRIPT, script, { mode: 0o766 }, err => {
	if(err) { throw new Error(err); }
	console.log("Update script done");
});

// Ecriture du script d'uninstall des projets
fs.writeFile(UNINSTALL_SCRIPT, sqlToScript(preSQL), { mode: 0o766 }, err => {
	if(err) { throw new Error(err); }
	console.log("Uninstall script done");
});
