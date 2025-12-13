const CONFIG = require('../config.json');
const fs = require('fs');
const projects = require('../website/projects');
const { foldProjects, getProjectDays } = require('../website/utils');
const fetch = require('node-fetch');
const booleanContains = require('@turf/boolean-contains').default;
const {Pool, Client} = require('pg')

// Get project filter and options from command line arguments
const args = process.argv.slice(2);
const forceRecalculate = args.includes('--force-recalculate') || process.env.FORCE_RECALCULATE === 'true';
const targetProjectId = args.find(arg => !arg.startsWith('--') && projects[arg]) || null;

let projectsToProcess = Object.values(projects);

if (targetProjectId) {
	// Filter to only the specified project
	if (!projects[targetProjectId]) {
		console.error(`ERROR: Project "${targetProjectId}" not found.`);
		console.error(`Available projects: ${Object.keys(projects).join(', ')}`);
		process.exit(1);
	}
	projectsToProcess = [projects[targetProjectId]];
	console.log(`Processing only project: ${targetProjectId}`);
} else {
	console.log(`Processing all ${projectsToProcess.length} projects`);
}

if (forceRecalculate) {
	console.log(`Mode: Force recalculation of all dates (--force-recalculate enabled)`);
} else {
	console.log(`Mode: Calculate only missing dates (default)`);
}

/*
 * Generates 31_projects_update_tmp.sh script
 * in order to update projects statistics and data daily
 */

// Constants
const OSH_UPDATED = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.osh.pbf");
const OSH_FILTERED = CONFIG.WORK_DIR + '/filtered.osh.pbf';
const OSH_USEFULL = CONFIG.WORK_DIR + '/usefull.osh.pbf';
const IMPOSM_ENABLED = CONFIG.DB_USE_IMPOSM_UPDATE;
if (IMPOSM_ENABLED == null){
	IMPOSM_ENABLED = true;
}

const OSC2CSV = __dirname+'/osc2csv.xslt';
const OSC_USEFULL = CONFIG.WORK_DIR + '/extract_filtered.osc.gz';

const CSV_CHANGES = CONFIG.WORK_DIR + '/change.csv';
const CSV_NOTES = (project) => `${CONFIG.WORK_DIR}/notes_${project}.csv`;
const CSV_NOTES_CONTRIBS = (project) => `${CONFIG.WORK_DIR}/user_notes_${project}.csv`;
const CSV_NOTES_USERS = (project) => `${CONFIG.WORK_DIR}/usernames_notes_${project}.csv`;

const PSQL = `psql -d ${process.env.DB_URL}`;
const OUTPUT_SCRIPT = CONFIG.WORK_DIR + '/31_projects_update_tmp.sh';
const HAS_BOUNDARY = `${PSQL} -c "SELECT * FROM pdm_boundary LIMIT 1" > /dev/null 2>&1 `;

const pgPool = new Pool({
	connectionString: `${process.env.DB_URL}`
});

// Notes statistics
function processNotes(project) {
	const days = getProjectDays(project);
	const today = new Date().toISOString().split("T")[0];
	const notesSources = project.datasources.filter(ds => ds.source === "notes");
	if(notesSources.length > 0) {
		const notesPerDay = {};
		const userNotes = [];
		const userNames = {};
		days.forEach(day => notesPerDay[day] = { open: 0, closed: 0 });

		// Review each note source
		const promises = notesSources.map((noteSource, nsid) => {
			// Call OSM API for each term
			const subpromises = noteSource.terms.map(term => (
				fetch(`${CONFIG.OSM_URL}/api/0.6/notes/search.json?q=${encodeURIComponent(term)}&limit=10000&closed=-1&from=${project.start_date}`)
				.then(res => res.json())
			));

			// Process received notes
			const countedNotes = [];
			return Promise.all(subpromises).then(results => {
				results.forEach(result => {
					result.features.forEach(f => {
						if(!countedNotes.includes(f.properties.id)) {
							countedNotes.push(f.properties.id);
							if(booleanContains(CONFIG.GEOJSON_BOUNDS, f)) {
								// Append note to count for each day it was opened
								const start = f.properties.date_created.split(" ")[0];
								const end = f.properties.closed_at ? f.properties.closed_at.split(" ")[0] : today;
								days.forEach(day => {
									if(f.properties.status === "closed" && end <= day) {
										notesPerDay[day].closed++;
									}
									else if(start <= day && day <= end) {
										notesPerDay[day].open++;
									}
								});

								// Add as user contribution
								if(f.properties.comments.length >= 1 && f.properties.comments[0].uid) {
									userNotes.push([
										project.id,
										f.properties.comments[0].uid,
										start,
										"note",
										(project.statistics && project.statistics.points && project.statistics.points.note) || 1
									]);
									userNames[f.properties.comments[0].uid] = f.properties.comments[0].user;
								}
							}
						}
					});
				});
				return true;
			});
		});

		// Merge all statistics from all sources
		Promise.all(promises).then(() => {
			// Notes per day
			const csvText = Object.entries(notesPerDay).map(e => `${project.id},${e[0]},${e[1].open},${e[1].closed}`).join("\n");
			fs.writeFile(CSV_NOTES(project.id), csvText, (err) => {
				if(err) { console.error(err); }
				else { console.log("Written note stats"); }
			});

			// User notes
			const csvUserNotes = userNotes.map(un => un.join(",")).join("\n");
			fs.writeFile(CSV_NOTES_CONTRIBS(project.id), csvUserNotes, (err) => {
				if(err) { console.error(err); }
				else { console.log("Written user notes contributions"); }
			});

			// User names from notes
			const csvUserNames = Object.entries(userNames).map(e => `${e[0]},${e[1]}`).join("\n");
			fs.writeFile(CSV_NOTES_USERS(project.id), csvUserNames, (err) => {
				if(err) { console.error(err); }
				else { console.log("Written user names from notes"); }
			});

			return true;
		});
	}

	return notesSources;
}

// Projects installation
// Beware of async queries
console.log("Projects installation");

let projectsQry = "INSERT INTO pdm_projects (project, start_date, end_date) VALUES ";
let projectPointsQry = "INSERT INTO pdm_projects_points (project, contrib, points) VALUES ";
let projectPointsLength = 0;
let projectLength = 0;

projectsToProcess.forEach(project => {
	projectsQry += `('${project.id}', '${project.start_date}', '${project.end_date}'),`;
	projectLength++;

	// Vérifier que statistics et statistics.points existent avant de les utiliser
	if (project.statistics && project.statistics.points && typeof project.statistics.points === 'object') {
		Object.entries(project.statistics.points).forEach(([contrib,value]) => {
			projectPointsQry += `('${project.id}','${contrib}', ${value}),`;
			projectPointsLength++;
		});
	}
});

projectsQry = `${projectsQry.substring(0, projectsQry.length-1)} ON CONFLICT (project) DO UPDATE SET start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date`;
pgPool.query(projectsQry, (err, res) => {
	if (err){
		throw new Error(`Erreur installation projets: ${err}`);
	}
	console.log(projectLength+" project(s) installed");
});

// Ne construire et exécuter la requête que s'il y a des points à insérer
if (projectPointsLength > 0) {
	projectPointsQry = `${projectPointsQry.substring(0, projectPointsQry.length-1)} ON CONFLICT (project, contrib) DO UPDATE SET points=EXCLUDED.points`;
	pgPool.query(projectPointsQry, (err, res) => {
		if (err){
			throw new Error(`Erreur installation points projet: ${err}`);
		}
		console.log(projectPointsLength+" project(s) point(s) installed");
	});
} else {
	console.log("No project points to install");
}

// Script text
const separator = `echo "-------------------------------------------------------------------"
echo ""`;

// Full script
var script = `#!/bin/bash

# Script for updating current projects
# Generated automatically by npm run projects:update

set -e

mode="$1"
echo "== Prerequisites"
nbProjects=$(${PSQL} -tAc "select count(*) from pdm_projects" | sed 's/[^0-9]*//g' )
nbPoints=$(${PSQL} -tAc "select count(*) from pdm_projects_points" | sed 's/[^0-9]*//g' )

if [[ $nbProjects < 1 ]]; then
  echo "WARN: No known projects in SQL projects table"
fi
if [[ $nbPoints < 1 ]]; then
  echo "WARN: No declared points for projects contributions"
fi
if [ -f ${CONFIG.WORK_DIR}/osh_timestamp ]; then
        osh_timestamp=$(cat ${CONFIG.WORK_DIR}/osh_timestamp)
        echo "OSH Timestamp: $osh_timestamp"
else
        echo "No OSH timestamp found"
fi
${separator}
`;

// Vérifier que le fichier OSH existe et a une taille valide avant de traiter les projets
script += `
# Vérifier que osc2csv.xslt existe, le télécharger si nécessaire
OSC2CSV="${OSC2CSV}"
if [ ! -f "$OSC2CSV" ]; then
	echo "   ⚠️  osc2csv.xslt not found at $OSC2CSV, attempting to download..."
	# Créer le répertoire si nécessaire
	OSC2CSV_DIR=$(dirname "$OSC2CSV")
	if [ ! -d "$OSC2CSV_DIR" ]; then
		mkdir -p "$OSC2CSV_DIR"
		echo "   => Created directory: $OSC2CSV_DIR"
	fi
	# Essayer de télécharger depuis le dépôt GitHub
	REPO_URL="https://raw.githubusercontent.com/vdct/ProjetDuMois/main/db/osc2csv.xslt"
	if command -v wget >/dev/null 2>&1; then
		if wget -q -O "$OSC2CSV" "$REPO_URL" 2>/dev/null && [ -f "$OSC2CSV" ] && [ -s "$OSC2CSV" ]; then
			echo "   ✓ osc2csv.xslt downloaded successfully from GitHub"
		else
			echo "   ❌ Failed to download osc2csv.xslt from $REPO_URL or file is empty"
			echo "   Please ensure the file exists at $OSC2CSV"
			exit 1
		fi
	elif command -v curl >/dev/null 2>&1; then
		if curl -s -o "$OSC2CSV" "$REPO_URL" 2>/dev/null && [ -f "$OSC2CSV" ] && [ -s "$OSC2CSV" ]; then
			echo "   ✓ osc2csv.xslt downloaded successfully from GitHub"
		else
			echo "   ❌ Failed to download osc2csv.xslt from $REPO_URL or file is empty"
			echo "   Please ensure the file exists at $OSC2CSV"
			exit 1
		fi
	else
		echo "   ❌ Neither wget nor curl is available to download osc2csv.xslt"
		echo "   Please ensure the file exists at $OSC2CSV"
		exit 1
	fi
else
	echo "   ✓ osc2csv.xslt found at $OSC2CSV"
fi

# Vérifier que le fichier OSH existe et a une taille valide (au moins 8 Go)
if [ ! -f "${OSH_UPDATED}" ]; then
	echo "ERROR: OSH file not found: ${OSH_UPDATED}"
	echo "Please run 'update_pbf' first to download and update the OSH file."
	exit 1
fi

# Vérifier la taille du fichier (au moins 8 Go = 8 * 1024 * 1024 * 1024 = 8589934592 bytes)
OSH_SIZE=$(stat -f%z "${OSH_UPDATED}" 2>/dev/null || stat -c%s "${OSH_UPDATED}" 2>/dev/null || echo "0")
MIN_SIZE=8589934592
if [ "$OSH_SIZE" -lt "$MIN_SIZE" ] 2>/dev/null; then
	echo "ERROR: OSH file is too small (\$OSH_SIZE bytes, expected at least \$MIN_SIZE bytes = 8 GB)"
	echo "The OSH file appears to be corrupted or incomplete."
	echo "Please run 'update_pbf' again to download a complete OSH file."
	exit 1
fi

OSH_SIZE_GB=$(echo "scale=2; \$OSH_SIZE / 1024 / 1024 / 1024" | bc)
echo "✓ OSH file size check passed: \$OSH_SIZE_GB GB"
${separator}
`;

projectsToProcess.forEach(project => {
	let oshInput = OSH_UPDATED;
	const oshProject = OSH_FILTERED.replace("filtered", `${project.id.split("_").pop()}`);
	const oshFiltered = OSH_FILTERED.replace("filtered", `${project.id.split("_").pop()}.filtered`);
	const oshUsefull = OSH_USEFULL.replace("usefull", `${project.id.split("_").pop()}.usefull`);
	const days = getProjectDays(project);

	let tagFilterParts = project.database.osmium_tag_filter.split("&");

	script += `
echo "== Begin process for project ${project.id}"
FORCE_RECALCULATE="${forceRecalculate ? 'true' : 'false'}"
prev_timestamp=$(${PSQL} -qtAc "SELECT to_char (lastupdate_date at time zone 'UTC', 'YYYY-MM-DD\\"T\\"HH24:MI:SS\\"Z\\"') from pdm_projects where project='${project.id}'")
if [ -n "\$prev_timestamp" ]; then
	echo "Starting from project last update: $prev_timestamp"
else
	echo "No project last update timestamp found"
fi
${separator}

cur_timestamp=$(date -Idate --utc)
cnt_timestamp=$(date -Idate --utc -d ${project.start_date})
prj_timestamp=$(date -Idate --utc -d ${project.start_date})
# Si --force-recalculate est activé, toujours utiliser start_date du projet
if [ "$FORCE_RECALCULATE" != "true" ] && [[ -n "\$prev_timestamp" ]]; then
	cnt_timestamp=$(date -Idate --utc -d \$prev_timestamp)
fi
if [[ -z \$cnt_timestamp || \$prj_timestamp>=\$cnt_timestamp ]]; then
	cnt_timestamp=$prj_timestamp
fi

# Vérifier si la dernière mise à jour date de moins de 24 heures
SKIP_EXTRACTION=false
if [[ -n "\$prev_timestamp" ]]; then
	# Convertir prev_timestamp en timestamp Unix (format ISO 8601: YYYY-MM-DDTHH:MM:SSZ)
	# Essayer différentes méthodes selon le système
	prev_unix=$(date -u -d "\$prev_timestamp" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "\$prev_timestamp" +%s 2>/dev/null || date -u -j -f "%Y-%m-%d %H:%M:%S" "\$(echo \$prev_timestamp | tr 'T' ' ' | tr -d 'Z')" +%s 2>/dev/null || echo "0")
	# Timestamp actuel
	now_unix=$(date +%s)
	# Différence en secondes (24 heures = 86400 secondes)
	diff_seconds=$((now_unix - prev_unix))
	if [ $diff_seconds -lt 86400 ] && [ $diff_seconds -ge 0 ]; then
		SKIP_EXTRACTION=true
		hours_ago=$((diff_seconds / 3600))
		echo "   ⏭️  Dernière mise à jour il y a \${hours_ago}h (\$prev_timestamp), extraction OSH et import en base ignorés"
	fi
fi

# Définir HAS_CHANGESET_ID même si on skip l'extraction (utilisé plus tard)
HAS_CHANGESET_ID=$(${PSQL} -qtAc "SELECT 1 FROM information_schema.columns WHERE table_name='pdm_changes' AND column_name='changeset_id'" 2>/dev/null | grep -q 1 && echo "1" || echo "0")

# Toujours créer pdm_changes_tmp avant de l'utiliser (même si elle sera vide si on skip l'extraction)
echo "   => Init changes table in database between \${cnt_timestamp} and \${cur_timestamp}"
${PSQL} -c "DELETE FROM pdm_changes WHERE project='${project.id}' AND ts BETWEEN '\${cnt_timestamp}T00:00:00Z' AND '\${cur_timestamp}T00:00:00Z'"
${PSQL} -c "DROP TABLE IF EXISTS pdm_changes_tmp"
${PSQL} -c "CREATE TABLE pdm_changes_tmp (LIKE pdm_changes)"

if [ "\$SKIP_EXTRACTION" = "false" ]; then
echo "   => Extract changes from OSH file and import to database"
rm -f "${CSV_CHANGES}"
TMP_OSC="${CONFIG.WORK_DIR}/tmp_${project.id.split("_").pop()}_changes.osc"
rm -f "\${TMP_OSC}"

# Convert OSH to OSC directly - use pipe for single filter, minimal intermediate files for multiple filters
`;
	if (tagFilterParts.length === 1) {
		// Single filter - use pipe to avoid creating intermediate file
		script += `
# Single tag filter - use pipe to avoid creating intermediate file
echo "   => Applying tag filter: ${tagFilterParts[0]}"
echo "   => Converting OSH to OSC format (using pipe, no intermediate file)..."
if osmium tags-filter "${OSH_UPDATED}" ${tagFilterParts[0]} -O -f osh.pbf 2>&1 | osmium export - -f osc -O -o "\${TMP_OSC}" 2>&1; then
	if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
		OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
		echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
	else
		echo "   ⚠️  OSC file is empty or missing after conversion"
		echo "   => Check osmium error messages above for details"
		touch "${CSV_CHANGES}"
	fi
else
	EXIT_CODE=$?
	echo "   ❌ Failed to convert OSH to OSC format (exit code: \$EXIT_CODE)"
	echo "   => Check osmium error messages above for details"
	touch "${CSV_CHANGES}"
fi
`;
	} else if (tagFilterParts.length > 1) {
		// Multiple filters - apply sequentially, but clean up intermediate files immediately
		script += `
# Multiple tag filters - apply sequentially with minimal intermediate files
echo "   => Applying ${tagFilterParts.length} tag filters sequentially"
TMP_INPUT="${OSH_UPDATED}"
`;
		tagFilterParts.forEach((tagFilter, index) => {
			const isLast = index === tagFilterParts.length - 1;
			const tmpFile = isLast 
				? `"${CONFIG.WORK_DIR}/tmp_${project.id.split("_").pop()}_filtered_final.osh.pbf"`
				: `"${CONFIG.WORK_DIR}/tmp_${project.id.split("_").pop()}_filtered_${index}.osh.pbf"`;
			
			script += `
# Apply filter ${index + 1}/${tagFilterParts.length}
if osmium tags-filter "\${TMP_INPUT}" ${tagFilter} -O -o ${tmpFile} 2>&1; then
	if [ -f ${tmpFile} ] && [ -s ${tmpFile} ]; then
		echo "   => Tag filter ${index + 1}/${tagFilterParts.length} applied successfully"
		${index < tagFilterParts.length - 1 ? 'rm -f "${TMP_INPUT}"' : ''}
		TMP_INPUT=${tmpFile}
	else
		echo "   ⚠️  Filtered file is empty after tag filter ${index + 1}"
		rm -f ${tmpFile}
		touch "${CSV_CHANGES}"
		FILTER_FAILED=true
	fi
else
	echo "   ⚠️  Failed to apply tag filter ${index + 1}"
	rm -f ${tmpFile}
	touch "${CSV_CHANGES}"
	FILTER_FAILED=true
fi
`;
		});
		
		script += `
if [ "\${FILTER_FAILED:-false}" != "true" ]; then
	# Convert filtered OSH to OSC
	echo "   => Converting filtered OSH to OSC format..."
	if osmium export "\${TMP_INPUT}" -f osc -O -o "\${TMP_OSC}" 2>&1; then
		if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
			OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
			echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
		else
			echo "   ⚠️  OSC file is empty or missing after conversion"
			echo "   => Check osmium export error messages above for details"
			touch "${CSV_CHANGES}"
		fi
	else
		EXIT_CODE=$?
		echo "   ❌ Failed to export OSH to OSC format (exit code: \$EXIT_CODE)"
		echo "   => Check osmium export error messages above for details"
		touch "${CSV_CHANGES}"
	fi
	# Clean up intermediate filtered file immediately
	rm -f "\${TMP_INPUT}"
else
	echo "   ⚠️  Tag filtering failed, skipping OSC conversion"
fi
`;
	} else {
		// No filters - just export directly
		script += `
# No tag filters - convert OSH to OSC directly
echo "   => Converting OSH to OSC format (no tag filters)..."
if osmium export "${OSH_UPDATED}" -f osc -O -o "\${TMP_OSC}" 2>&1; then
	if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
		OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
		echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
	else
		echo "   ⚠️  OSC file is empty or missing after conversion"
		echo "   => Check osmium export error messages above for details"
		touch "${CSV_CHANGES}"
	fi
else
	EXIT_CODE=$?
	echo "   ❌ Failed to export OSH to OSC format (exit code: \$EXIT_CODE)"
	echo "   => Check osmium export error messages above for details"
	touch "${CSV_CHANGES}"
fi
`;
	}

# Convert OSC to CSV if OSC file exists
if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
	# Extract osmid from type/id format (e.g., "node/123" -> "123") and add project column
	# Use a more robust CSV parser that handles quoted fields
	# Check if changeset_id column exists in pdm_changes to determine CSV format
	HAS_CHANGESET_ID=$(${PSQL} -qtAc "SELECT 1 FROM information_schema.columns WHERE table_name='pdm_changes' AND column_name='changeset_id'" 2>/dev/null | grep -q 1 && echo "1" || echo "0")
	# Use Python to properly parse CSV with quoted fields containing commas
	if [ "$HAS_CHANGESET_ID" = "1" ]; then
		xsltproc "${OSC2CSV}" "\${TMP_OSC}" | python3 -c "
import sys
import csv
import json

project = '${project.id}'
reader = csv.reader(sys.stdin)
for row in reader:
	if len(row) < 8:
		continue
	action = row[0]
	typeid = row[1]
	version = row[2]
	timestamp = row[3]
	username = row[4].strip('\"')
	uid = row[5]
	changeset_id = row[6] if row[6] and row[6] != 'null' else ''
	# Tags is everything from field 7 onwards, join with commas
	tags = ','.join(row[7:]) if len(row) > 7 else '{}'
	# Remove outer quotes and fix escaped quotes
	tags = tags.strip('\"').replace('\"\"', '\"')
	
	# Extract OSM ID from type/id (e.g., 'node/123' -> '123')
	if '/' in typeid:
		osmid = typeid.split('/')[1]
	else:
		osmid = typeid
	
	# Output: project,action,osmid,version,timestamp,username,userid,changeset_id,tags
	print(f'{project},{action},{osmid},{version},{timestamp},{username},{uid},{changeset_id},{tags}')
" > "${CSV_CHANGES}"
	else
		xsltproc "${OSC2CSV}" "\${TMP_OSC}" | python3 -c "
import sys
import csv

project = '${project.id}'
reader = csv.reader(sys.stdin)
for row in reader:
	if len(row) < 8:
		continue
	action = row[0]
	typeid = row[1]
	version = row[2]
	timestamp = row[3]
	username = row[4].strip('\"')
	uid = row[5]
	# Tags is everything from field 7 onwards, join with commas
	tags = ','.join(row[7:]) if len(row) > 7 else '{}'
	# Remove outer quotes and fix escaped quotes
	tags = tags.strip('\"').replace('\"\"', '\"')
	
	# Extract OSM ID from type/id (e.g., 'node/123' -> '123')
	if '/' in typeid:
		osmid = typeid.split('/')[1]
	else:
		osmid = typeid
	
	# Output: project,action,osmid,version,timestamp,username,userid,tags
	print(f'{project},{action},{osmid},{version},{timestamp},{username},{uid},{tags}')
" > "${CSV_CHANGES}"
	fi
	rm -f "\${TMP_OSC}"
else
	echo "   ⚠️  OSC file is empty or missing, CSV will be empty"
	touch "${CSV_CHANGES}"
fi

# Use the same HAS_CHANGESET_ID variable from above to determine COPY columns
if [ -f "${CSV_CHANGES}" ] && [ -s "${CSV_CHANGES}" ]; then
	if [ "$HAS_CHANGESET_ID" = "1" ]; then
		${PSQL} -c "\\COPY pdm_changes_tmp (project, action, osmid, version, ts, username, userid, changeset_id, tags) FROM '${CSV_CHANGES}' CSV"
	else
		${PSQL} -c "\\COPY pdm_changes_tmp (project, action, osmid, version, ts, username, userid, tags) FROM '${CSV_CHANGES}' CSV"
	fi
else
	echo "   ⚠️  CSV file is empty or missing, skipping import"
fi
else
	echo "   ⏭️  Extraction OSH et import en base ignorés (mise à jour récente)"
	touch "${CSV_CHANGES}"
	# La table pdm_changes_tmp a déjà été créée avant le bloc conditionnel
	# Elle sera vide, ce qui est normal si on skip l'extraction
fi

${PSQL} -v project_id="'${project.id}'" -v project_table="pdm_project_${project.id.split("_").pop()}" -f "${__dirname}/33_changes_populate.sql"
if ${HAS_BOUNDARY}; then
	echo "   => Associate features with boundaries"
	if ${PSQL} -c "SELECT * FROM pdm_boundary_subdivide LIMIT 1" > /dev/null 2>&1; then
		${PSQL} -v project_id="'${project.id}'" -v project_table="pdm_project_${project.id.split("_").pop()}" -f "${__dirname}/33_changes_boundary.sql"
	else
		echo "   WARNING: pdm_boundary_subdivide does not exist. Boundaries statistics will not be calculated."
		echo "   Run 'docker-compose exec pdm ./docker-entrypoint.sh update_features init' to initialize boundaries."
	fi
fi
${PSQL} -c "DROP TABLE pdm_changes_tmp"

if [ -f "${__dirname}/../projects/${project.id}/contribs.sql" ]; then
	echo "Including project custom contributions"
	${PSQL} -f "${__dirname}/../projects/${project.id}/contribs.sql"
fi

rm -f "${CSV_CHANGES}"
${separator}

echo "== Statistics for project ${project.id}"`;
	let osmStats = OSH_USEFULL.replace("usefull.osh.pbf", `${project.id.split("_").pop()}.stats.osm.pbf`);
	let osmStatsFiltered = OSH_USEFULL.replace("usefull.osh.pbf", `${project.id.split("_").pop()}.filtered.stats.osm.pbf`);

	// Dénombrements
	if (project.statistics.count){
		script += `
echo "   => Count features"
if [ "$FORCE_RECALCULATE" = "true" ]; then
	echo "   => Mode: Recalcul complet (toutes les dates depuis le début du projet seront recalculées)"
	# Supprimer toutes les mesures depuis le début du projet jusqu'à aujourd'hui
	${PSQL} -c "DELETE FROM pdm_feature_counts WHERE project='${project.id}' AND ts BETWEEN '\${prj_timestamp}T00:00:00Z' AND '\${cur_timestamp}T23:59:59Z'"
	if ${HAS_BOUNDARY}; then
		${PSQL} -c "DELETE FROM pdm_feature_counts_per_boundary WHERE project='${project.id}' AND ts BETWEEN '\${prj_timestamp}T00:00:00Z' AND '\${cur_timestamp}T23:59:59Z'"
	fi
	# Utiliser start_date du projet comme point de départ pour le recalcul
	cnt_timestamp=$prj_timestamp
else
	echo "   => Mode: Calcul uniquement des dates manquantes"
fi

echo "Counting from \$cnt_timestamp to \${cur_timestamp}"
days="${days.join(" ")}"
days=($\{days##*( )\})
for day in "\${days[@]}"; do
	if [[ $(date -Idate --utc -d \${cnt_timestamp}T23:59:59Z) > $(date -Idate --utc -d \${day}T00:00:00Z) ]]; then
		continue
	fi
	
	# Vérifier si une mesure existe déjà pour cette date (sauf si on force le recalcul)
	if [ "$FORCE_RECALCULATE" != "true" ]; then
		EXISTING_COUNT=$(${PSQL} -qtAc "SELECT COUNT(*) FROM pdm_feature_counts WHERE project='${project.id}' AND ts='\${day}T23:59:59Z'" 2>/dev/null | tr -d ' ' || echo "0")
		if [ "$EXISTING_COUNT" != "0" ] && [ -n "$EXISTING_COUNT" ]; then
			echo "   ⏭️  Mesure déjà existante pour \${day}, ignorée (utilisez --force-recalculate pour forcer le recalcul)"
			continue
		fi
	fi
	
	echo "Processing \${day}"
	# Check if usefull file exists and has content before processing
	if [ ! -f "${oshUsefull}" ] || [ ! -s "${oshUsefull}" ]; then
		echo "   ⚠️  Usefull file is empty or missing, skipping count for \${day}"
		nbday="0"
	else
		if osmium time-filter "${oshUsefull}" \${day}T23:59:59Z --no-progress -O -o ${osmStats} -f osm.pbf 2>/dev/null; then
			if [ -f "${osmStats}" ] && [ -s "${osmStats}" ]; then
				`;
	let tagFilterLastPart = tagFilterParts.pop();
	tagFilterParts.forEach(tagFilter => {
		script += `
				if osmium tags-filter "${osmStats}" ${tagFilter} --no-progress -O -o "${osmStatsFiltered}" 2>/dev/null; then
					if [ -f "${osmStatsFiltered}" ] && [ -s "${osmStatsFiltered}" ]; then
						mv "${osmStatsFiltered}" "${osmStats}"
					else
						echo "   ⚠️  Filtered file is empty, skipping"
						rm -f "${osmStats}" "${osmStatsFiltered}"
						nbday="0"
					fi
				else
					echo "   ⚠️  Failed to filter, skipping"
					rm -f "${osmStats}" "${osmStatsFiltered}"
					nbday="0"
				fi
				`;
	});

	script += `
				if [ -f "${osmStats}" ] && [ -s "${osmStats}" ]; then
					nbday=$(osmium tags-count "${osmStats}" --no-progress -F osm.pbf ${tagFilterLastPart} 2>/dev/null | cut -d$'\\t' -f 1 | paste -sd+ | bc 2>/dev/null || echo "0")
					if [ "$nbday" == "" ]; then
						nbday="0"
					fi
				else
					nbday="0"
				fi
			else
				echo "   ⚠️  OSM stats file is empty or missing, skipping count for \${day}"
				nbday="0"
			fi
		else
			echo "   ⚠️  Failed to filter by time, skipping count for \${day}"
			nbday="0"
		fi
	fi

	# Insérer ou mettre à jour la mesure (ON CONFLICT permet de mettre à jour si on force le recalcul)
	${PSQL} -c "INSERT INTO pdm_feature_counts (project,ts,amount) VALUES ('${project.id}', '\${day}T23:59:59Z', \${nbday}) ON CONFLICT (project,ts) DO UPDATE SET amount=EXCLUDED.amount"
	if ${HAS_BOUNDARY}; then
		if ${PSQL} -c "SELECT * FROM pdm_boundary_subdivide LIMIT 1" > /dev/null 2>&1; then
			${PSQL} -c "INSERT INTO pdm_feature_counts_per_boundary(project, boundary, ts, amount) SELECT '${project.id}' as project, boundary, '\${day}T23:59:59Z' AS ts, count(*) as amount FROM pdm_features_boundary WHERE project='${project.id}' AND ('\${day}T23:59:59Z' BETWEEN start_ts AND end_ts OR (start_ts is null and end_ts is null) OR '\${day}T23:59:59Z' > start_ts OR '\${day}T23:59:59Z' < end_ts) GROUP BY project, boundary ON CONFLICT (project,boundary,ts) DO UPDATE SET amount=EXCLUDED.amount"
		fi
	fi
done
rm -f "${osmStats}"
`;
	}

	script += `
	${separator}

	echo "== Generate user contributions between \${cnt_timestamp} and \${cur_timestamp}"
	${PSQL} -v project_id="'${project.id}'" -v start_date="'\${cnt_timestamp}T00:00:00Z'" -v end_date="'\${cur_timestamp}T00:00:00Z'" -f "${__dirname}/32_projects_contribs.sql"
	${separator}

	if [ -f '${__dirname}/../projects/${project.id}/extract.sh' ]; then
		echo "== Extract script"
		${__dirname}/../projects/${project.id}/extract.sh
		echo ""
	fi
	`;

	// Notes count (optional)
	let notesSources = processNotes(project);
	if (notesSources.length > 0){
		script += `
echo "   => Notes statistics"
${PSQL} -c "DELETE FROM pdm_note_counts WHERE project='${project.id}' AND ts BETWEEN '\${cnt_timestamp}T00:00:00Z' AND '\${cur_timestamp}T00:00:00Z'"
if [ -f "${CSV_NOTES(project.id)}" ]; then
	${PSQL} -c "\\COPY pdm_note_counts FROM '${CSV_NOTES(project.id)}' CSV"
fi
if [ -f "${CSV_NOTES_CONTRIBS(project.id)}" ]; then
	${PSQL} -c "\\COPY pdm_user_contribs(project, userid, ts, contribution, points) FROM '${CSV_NOTES_CONTRIBS(project.id)}' CSV"
fi
if [ -f "${CSV_NOTES_USERS(project.id)}" ]; then
	${PSQL} -c "CREATE TABLE pdm_user_names_notes(userid BIGINT, username VARCHAR)"
	${PSQL} -c "\\COPY pdm_user_names_notes FROM '${CSV_NOTES_USERS(project.id)}' CSV"
	${PSQL} -c "INSERT INTO pdm_user_names SELECT userid, username FROM pdm_user_names_notes ON CONFLICT (userid) DO NOTHING; DROP TABLE pdm_user_names_notes;"
fi
rm -f "${CSV_NOTES(project.id)}" "${CSV_NOTES_CONTRIBS(project.id)}" "${CSV_NOTES_USERS(project.id)}"
	${separator}`;

	}

	// Quality completion calculation (if enabled) - calculé depuis la base de données pour toutes les dates
	if (project.quality && project.quality.required_tags && Array.isArray(project.quality.required_tags) && project.quality.required_tags.length > 0) {
		const requiredTagsArray = project.quality.required_tags.map(tag => `'${tag}'`).join(',');
		script += `
echo "   => Calculate quality completion scores for all dates"
${PSQL} -c "SELECT pdm_calculate_quality_completion_all_dates('${project.id}', ARRAY[${requiredTagsArray}])"
${separator}`;
	}

script += `
# Update project lastupdate_date with current timestamp
# Use cur_timestamp (end of processing period) to mark when this update was completed
# This ensures that if the script is run again immediately, it will use a different timestamp
update_timestamp="\${cur_timestamp}T23:59:59Z"
${PSQL} -c "UPDATE pdm_projects SET lastupdate_date='$update_timestamp' WHERE project='${project.id}'"
echo "   => Project lastupdate_date set to $update_timestamp"

echo "   => Project update sucessful"
${separator}

echo "== Résumé des statistiques pour ${project.id}"
# Compter le nombre de mesures réalisées dans cette mise à jour
nb_measures=$(${PSQL} -tAc "SELECT COUNT(*) FROM pdm_feature_counts WHERE project='${project.id}' AND ts BETWEEN '\${cnt_timestamp}T00:00:00Z' AND '\${cur_timestamp}T23:59:59Z'" | sed 's/[^0-9]*//g')
if [ -z "$nb_measures" ]; then
	nb_measures="0"
fi
echo "   => Nombre de mesures réalisées: $nb_measures"

# Récupérer le nombre d'objets à la date la plus récente
latest_count=$(${PSQL} -tAc "SELECT amount FROM pdm_feature_counts WHERE project='${project.id}' ORDER BY ts DESC LIMIT 1" | sed 's/[^0-9]*//g')
latest_date=$(${PSQL} -tAc "SELECT to_char(ts, 'YYYY-MM-DD') FROM pdm_feature_counts WHERE project='${project.id}' ORDER BY ts DESC LIMIT 1")
if [ -n "$latest_count" ] && [ -n "$latest_date" ]; then
	echo "   => Nombre d'objets à la date la plus récente ($latest_date): $latest_count"
else
	echo "   => Aucune statistique disponible"
fi
${separator}
`;
});

script += `
echo "== Optimize database"
if ${HAS_BOUNDARY}; then
	if ${PSQL} -c "SELECT * FROM pdm_boundary_subdivide LIMIT 1" > /dev/null 2>&1; then
		${PSQL} -c "REFRESH MATERIALIZED VIEW pdm_boundary_subdivide"
		if ${PSQL} -c "SELECT * FROM pdm_boundary_tiles LIMIT 1" > /dev/null 2>&1; then
			${PSQL} -c "REFRESH MATERIALIZED VIEW pdm_boundary_tiles"
		fi
	fi
fi
${separator}
`;

// Ensure work directory exists
if (!fs.existsSync(CONFIG.WORK_DIR)) {
	fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });
}

fs.writeFileSync(OUTPUT_SCRIPT, script);
fs.chmodSync(OUTPUT_SCRIPT, '755');
console.log("Written Bash script");
// Force process exit to avoid hanging on async promises
setTimeout(() => process.exit(0), 1000);
