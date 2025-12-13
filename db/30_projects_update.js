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
const forceExtract = args.includes('--force-extract') || process.env.FORCE_EXTRACT === 'true';
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

if (forceExtract) {
	console.log(`Mode: Force OSH extraction (--force-extract enabled, will recreate OSC files)`);
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
const PBF_UPDATE_SCRIPT = __dirname+'/11_pbf_update_tmp.sh';
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

# Fonction pour vérifier et régénérer le fichier OSH si nécessaire
check_and_regenerate_osh() {
	local osh_file="${OSH_UPDATED}"
	local needs_regeneration=false
	
	# Vérifier que le fichier existe
	if [ ! -f "$osh_file" ]; then
		echo "⚠️  OSH file not found: $osh_file"
		needs_regeneration=true
	else
		# Vérifier la taille du fichier
		local osh_size=$(stat -f%z "$osh_file" 2>/dev/null || stat -c%s "$osh_file" 2>/dev/null || echo "0")
		local osh_size_mb=$((osh_size / 1024 / 1024))
		
		# Vérifier que le fichier n'est pas vide (minimum 1 MB pour être valide)
		if [ "$osh_size" -lt 1048576 ]; then
			echo "⚠️  OSH file is too small or empty: $osh_file"
			echo "   File size: $osh_size bytes ($osh_size_mb MB)"
			echo "   Expected minimum: 1 MB"
			needs_regeneration=true
		else
			# Vérifier que le fichier est un fichier PBF valide (pas HTML/text)
			local first_bytes=$(head -c 20 "$osh_file" 2>/dev/null || echo "")
			if echo "$first_bytes" | grep -qi "<!DOCTYPE\|<html\|text/html"; then
				echo "⚠️  OSH file appears to be invalid (HTML/text instead of PBF): $osh_file"
				echo "   The file may be an error page from the server."
				needs_regeneration=true
			fi
		fi
	fi
	
	# Si le fichier est invalide, régénérer
	if [ "$needs_regeneration" = "true" ]; then
		echo "   => Regenerating OSH file by running update_pbf..."
		echo ""
		
		# Générer le script update_pbf
		if ! npm run pbf:update 2>&1; then
			echo "❌ ERROR: Failed to generate update_pbf script"
			exit 1
		fi
		
		# Exécuter le script update_pbf
		local pbf_script="${CONFIG.WORK_DIR}/11_pbf_update_tmp.sh"
		if [ ! -f "$pbf_script" ]; then
			pbf_script="${PBF_UPDATE_SCRIPT}"
		fi
		
		if [ -f "$pbf_script" ]; then
			if ! bash "$pbf_script" 2>&1; then
				echo "❌ ERROR: Failed to regenerate OSH file"
				echo "   Please check the update_pbf script output above for details"
				exit 1
			fi
		else
			echo "❌ ERROR: update_pbf script not found: $pbf_script"
			exit 1
		fi
		
		# Vérifier à nouveau que le fichier existe maintenant et est valide
		if [ ! -f "$osh_file" ]; then
			echo "❌ ERROR: OSH file still not found after regeneration: $osh_file"
			exit 1
		fi
		
		local osh_size=$(stat -f%z "$osh_file" 2>/dev/null || stat -c%s "$osh_file" 2>/dev/null || echo "0")
		if [ "$osh_size" -lt 1048576 ]; then
			echo "❌ ERROR: OSH file is still too small after regeneration: $osh_file"
			echo "   File size: $osh_size bytes"
			exit 1
		fi
		
		echo "   ✓ OSH file successfully regenerated"
		echo ""
	fi
}

# Vérifier et régénérer le fichier OSH si nécessaire
check_and_regenerate_osh

# Afficher la taille du fichier (maintenant qu'on est sûr qu'il est valide)
OSH_SIZE=$(stat -f%z "${OSH_UPDATED}" 2>/dev/null || stat -c%s "${OSH_UPDATED}" 2>/dev/null || echo "0")
OSH_SIZE_MB=$((OSH_SIZE / 1024 / 1024))

# Afficher la taille du fichier
if [ "$OSH_SIZE_MB" -gt 1024 ]; then
	OSH_SIZE_GB=$(echo "scale=2; \$OSH_SIZE / 1024 / 1024 / 1024" | bc)
	echo "✓ OSH file found: \$OSH_SIZE_GB GB"
else
	echo "✓ OSH file found: \$OSH_SIZE_MB MB"
fi
${separator}
`;

projectsToProcess.forEach(project => {
	let oshInput = OSH_UPDATED;
	// Extract project name: for "2025-02_data_center", we want "data_center" (everything after the first underscore)
	const projectNameParts = project.id.split("_");
	const projectName = projectNameParts.length > 1 ? projectNameParts.slice(1).join("_") : project.id;
	const oshProject = OSH_FILTERED.replace("filtered", projectName);
	const oshFiltered = OSH_FILTERED.replace("filtered", `${projectName}.filtered`);
	const days = getProjectDays(project);

	let tagFilterParts = project.database.osmium_tag_filter.split("&");

	script += `
echo "== Begin process for project ${project.id}"
FORCE_RECALCULATE="${forceRecalculate ? 'true' : 'false'}"
FORCE_EXTRACT="${forceExtract ? 'true' : 'false'}"
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
# Vérifier aussi si le fichier OSC existe et est récent (moins de 24h)
# Sauf si --force-extract est activé
SKIP_EXTRACTION=false
TMP_OSC="${CONFIG.WORK_DIR}/tmp_${projectName}_changes.osc"
OSH_EXTRACTION_RECENT=false

# Si --force-extract est activé, supprimer le fichier OSC pour forcer la recréation
if [ "$FORCE_EXTRACT" = "true" ]; then
	if [ -f "\${TMP_OSC}" ]; then
		rm -f "\${TMP_OSC}"
		echo "   🔄 Mode --force-extract activé, fichier OSC supprimé pour forcer la recréation"
	fi
fi

# Vérifier l'âge du fichier OSC s'il existe ET n'est pas vide (sauf si --force-extract est activé)
# Le fichier doit exister, avoir une taille > 0, et être récent (< 24h)
if [ "$FORCE_EXTRACT" != "true" ] && [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
	OSC_MTIME=$(stat -c %Y "\${TMP_OSC}" 2>/dev/null || stat -f %m "\${TMP_OSC}" 2>/dev/null || echo "0")
	if [ "$OSC_MTIME" != "0" ]; then
		now_unix=$(date +%s)
		osc_age=$((now_unix - OSC_MTIME))
		if [ $osc_age -lt 86400 ] && [ $osc_age -ge 0 ]; then
			OSH_EXTRACTION_RECENT=true
			hours_ago=$((osc_age / 3600))
			echo "   ⏭️  Fichier OSC existe et date de \${hours_ago}h, extraction OSH ignorée"
		fi
	fi
elif [ "$FORCE_EXTRACT" != "true" ] && [ -f "\${TMP_OSC}" ] && [ ! -s "\${TMP_OSC}" ]; then
	# Le fichier OSC existe mais est vide, on doit forcer l'extraction
	echo "   ⚠️  Fichier OSC existe mais est vide, extraction OSH nécessaire"
	rm -f "\${TMP_OSC}"
	OSH_EXTRACTION_RECENT=false
fi

# Vérifier aussi le timestamp de dernière mise à jour (sauf si --force-extract est activé)
# MAIS seulement si le fichier OSC existe et n'est pas vide
if [ "$FORCE_EXTRACT" != "true" ] && [ "\$OSH_EXTRACTION_RECENT" = "false" ] && [[ -n "\$prev_timestamp" ]]; then
	# Vérifier d'abord si le fichier OSC existe et n'est pas vide
	if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
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
	else
		# Le fichier OSC n'existe pas ou est vide, on doit forcer l'extraction
		echo "   ⚠️  Fichier OSC manquant ou vide, extraction OSH nécessaire"
		SKIP_EXTRACTION=false
	fi
fi

# Si le fichier OSC est récent, on skip aussi l'extraction (sauf si --force-extract est activé)
if [ "$FORCE_EXTRACT" != "true" ] && [ "\$OSH_EXTRACTION_RECENT" = "true" ]; then
	SKIP_EXTRACTION=true
fi

# Si --force-extract est activé, forcer l'extraction même si la dernière mise à jour date de moins de 24h
if [ "$FORCE_EXTRACT" = "true" ]; then
	SKIP_EXTRACTION=false
	echo "   🔄 Mode --force-extract activé, extraction OSH forcée (ignorant les vérifications de cache)"
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
# Utiliser OSH_EXTRACTION_RECENT qui a été vérifié plus haut (sauf si --force-extract)
if [ "$FORCE_EXTRACT" = "true" ]; then
	OSC_EXISTS_AND_RECENT="false"
	echo "   🔄 Mode --force-extract activé, extraction OSH forcée"
else
	OSC_EXISTS_AND_RECENT="\$OSH_EXTRACTION_RECENT"
fi

# Convert OSH to OSC directly - use pipe for single filter, minimal intermediate files for multiple filters
# Skip extraction si le fichier OSC existe déjà et est récent
`;
	if (tagFilterParts.length === 1) {
		// Single filter - use pipe to avoid creating intermediate file
		script += `
# Single tag filter - extract changes from OSH using derive-changes
if [ "\$OSC_EXISTS_AND_RECENT" = "false" ]; then
echo "   => Applying tag filter: ${tagFilterParts[0]}"
echo "   => Extracting changes from OSH file..."
TMP_FILTERED_OSH="\${TMP_OSC}.filtered.osh.pbf"
TMP_OSM_OLD="\${TMP_OSC}.old.osm.pbf"
TMP_OSM_NEW="\${TMP_OSC}.new.osm.pbf"
CONVERSION_FAILED=false

# Step 1: Filter OSH file
if ! osmium tags-filter "${OSH_UPDATED}" ${tagFilterParts[0]} -O -f osh.pbf -o "\${TMP_FILTERED_OSH}" 2>&1; then
	EXIT_CODE=$?
	echo "   ❌ Failed to filter OSH file (exit code: \$EXIT_CODE)"
	echo "   => Check osmium tags-filter error messages above for details"
	CONVERSION_FAILED=true
fi

# Step 2: Extract state at start date (or very old date)
if [ "\$CONVERSION_FAILED" = "false" ]; then
	OLD_DATE="1970-01-01T00:00:00Z"
	if ! osmium time-filter "\${TMP_FILTERED_OSH}" "\$OLD_DATE" -O -f osm.pbf -o "\${TMP_OSM_OLD}" 2>&1; then
		EXIT_CODE=$?
		echo "   ❌ Failed to extract old state from OSH (exit code: \$EXIT_CODE)"
		CONVERSION_FAILED=true
	fi
fi

# Step 3: Extract state at end date (current)
if [ "\$CONVERSION_FAILED" = "false" ]; then
	FUTURE_DATE="2099-12-31T23:59:59Z"
	if ! osmium time-filter "\${TMP_FILTERED_OSH}" "\$FUTURE_DATE" -O -f osm.pbf -o "\${TMP_OSM_NEW}" 2>&1; then
		EXIT_CODE=$?
		echo "   ❌ Failed to extract new state from OSH (exit code: \$EXIT_CODE)"
		CONVERSION_FAILED=true
	fi
fi

# Step 4: Derive changes between old and new state
if [ "\$CONVERSION_FAILED" = "false" ]; then
	if osmium derive-changes "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}" -O -o "\${TMP_OSC}" 2>&1; then
		if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
			OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
			echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
		else
			echo "   ⚠️  OSC file is empty or missing after conversion"
			echo "   => This may indicate no changes were found"
			touch "${CSV_CHANGES}"
		fi
		rm -f "\${TMP_FILTERED_OSH}" "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
	else
		EXIT_CODE=$?
		echo "   ❌ Failed to derive changes from OSH (exit code: \$EXIT_CODE)"
		echo "   => Check osmium derive-changes error messages above for details"
		CONVERSION_FAILED=true
		rm -f "\${TMP_FILTERED_OSH}" "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
		touch "${CSV_CHANGES}"
	fi
fi

# If conversion failed, exit to prevent processing with zero objects
if [ "\$CONVERSION_FAILED" = "true" ]; then
	echo "   ❌ Conversion failed, aborting project update"
	exit 1
fi
else
	echo "   ⏭️  Extraction OSH ignorée, utilisation du fichier OSC existant"
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
				? `"${CONFIG.WORK_DIR}/tmp_${projectName}_filtered_final.osh.pbf"`
				: `"${CONFIG.WORK_DIR}/tmp_${projectName}_filtered_${index}.osh.pbf"`;
			
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
	# Convert filtered OSH to OSC using derive-changes
	if [ "\$OSC_EXISTS_AND_RECENT" = "false" ]; then
	echo "   => Extracting changes from filtered OSH file..."
	TMP_OSM_OLD="\${TMP_OSC}.old.osm.pbf"
	TMP_OSM_NEW="\${TMP_OSC}.new.osm.pbf"
	CONVERSION_FAILED=false
	
	# Extract state at start date (or very old date)
	OLD_DATE="1970-01-01T00:00:00Z"
	if ! osmium time-filter "\${TMP_INPUT}" "\$OLD_DATE" -O -f osm.pbf -o "\${TMP_OSM_OLD}" 2>&1; then
		EXIT_CODE=$?
		echo "   ❌ Failed to extract old state from OSH (exit code: \$EXIT_CODE)"
		CONVERSION_FAILED=true
	fi
	
	# Extract state at end date (current)
	if [ "\$CONVERSION_FAILED" = "false" ]; then
		FUTURE_DATE="2099-12-31T23:59:59Z"
		if ! osmium time-filter "\${TMP_INPUT}" "\$FUTURE_DATE" -O -f osm.pbf -o "\${TMP_OSM_NEW}" 2>&1; then
			EXIT_CODE=$?
			echo "   ❌ Failed to extract new state from OSH (exit code: \$EXIT_CODE)"
			CONVERSION_FAILED=true
		fi
	fi
	
	# Derive changes between old and new state
	if [ "\$CONVERSION_FAILED" = "false" ]; then
		if osmium derive-changes "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}" -O -o "\${TMP_OSC}" 2>&1; then
			if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
				OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
				echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
			else
				echo "   ⚠️  OSC file is empty or missing after conversion"
				echo "   => This may indicate no changes were found"
				touch "${CSV_CHANGES}"
			fi
			rm -f "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
		else
			EXIT_CODE=$?
			echo "   ❌ Failed to derive changes from OSH (exit code: \$EXIT_CODE)"
			echo "   => Check osmium derive-changes error messages above for details"
			CONVERSION_FAILED=true
			rm -f "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
			touch "${CSV_CHANGES}"
		fi
	fi
	
	# Clean up intermediate filtered file immediately
	rm -f "\${TMP_INPUT}"
	
	# If conversion failed, exit to prevent processing with zero objects
	if [ "\$CONVERSION_FAILED" = "true" ]; then
		echo "   ❌ Conversion failed, aborting project update"
		exit 1
	fi
	else
		echo "   ⏭️  Extraction OSH ignorée, utilisation du fichier OSC existant"
	fi
else
	echo "   ⚠️  Tag filtering failed, skipping OSC conversion"
fi
`;
	} else {
		// No filters - just export directly
		script += `
# No tag filters - extract changes from OSH using derive-changes
if [ "\$OSC_EXISTS_AND_RECENT" = "false" ]; then
echo "   => Extracting changes from OSH file (no tag filters)..."
TMP_OSM_OLD="\${TMP_OSC}.old.osm.pbf"
TMP_OSM_NEW="\${TMP_OSC}.new.osm.pbf"
CONVERSION_FAILED=false

# Extract state at start date (or very old date)
OLD_DATE="1970-01-01T00:00:00Z"
if ! osmium time-filter "${OSH_UPDATED}" "\$OLD_DATE" -O -f osm.pbf -o "\${TMP_OSM_OLD}" 2>&1; then
	EXIT_CODE=$?
	echo "   ❌ Failed to extract old state from OSH (exit code: \$EXIT_CODE)"
	CONVERSION_FAILED=true
fi

# Extract state at end date (current)
if [ "\$CONVERSION_FAILED" = "false" ]; then
	FUTURE_DATE="2099-12-31T23:59:59Z"
	if ! osmium time-filter "${OSH_UPDATED}" "\$FUTURE_DATE" -O -f osm.pbf -o "\${TMP_OSM_NEW}" 2>&1; then
		EXIT_CODE=$?
		echo "   ❌ Failed to extract new state from OSH (exit code: \$EXIT_CODE)"
		CONVERSION_FAILED=true
	fi
fi

# Derive changes between old and new state
if [ "\$CONVERSION_FAILED" = "false" ]; then
	if osmium derive-changes "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}" -O -o "\${TMP_OSC}" 2>&1; then
		if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
			OSC_SIZE=$(stat -c%s "\${TMP_OSC}" 2>/dev/null || stat -f%z "\${TMP_OSC}" 2>/dev/null || echo "0")
			echo "   => Changes extracted successfully (OSC file size: \$OSC_SIZE bytes)"
		else
			echo "   ⚠️  OSC file is empty or missing after conversion"
			echo "   => This may indicate no changes were found"
			touch "${CSV_CHANGES}"
		fi
		rm -f "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
	else
		EXIT_CODE=$?
		echo "   ❌ Failed to derive changes from OSH (exit code: \$EXIT_CODE)"
		echo "   => Check osmium derive-changes error messages above for details"
		CONVERSION_FAILED=true
		rm -f "\${TMP_OSM_OLD}" "\${TMP_OSM_NEW}"
		touch "${CSV_CHANGES}"
	fi
fi

# If conversion failed, exit to prevent processing with zero objects
if [ "\$CONVERSION_FAILED" = "true" ]; then
	echo "   ❌ Conversion failed, aborting project update"
	exit 1
fi
else
	echo "   ⏭️  Extraction OSH ignorée, utilisation du fichier OSC existant"
fi
`;
	}

	script += `
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
import re

project = '${project.id}'
reader = csv.reader(sys.stdin)
writer = csv.writer(sys.stdout, quoting=csv.QUOTE_MINIMAL)
for row in reader:
	if len(row) < 8:
		continue
	action = row[0]
	typeid = row[1]
	version = row[2]
	timestamp = row[3]
	username = row[4].strip('\\"')
	uid = row[5]
	changeset_id = row[6] if len(row) > 6 and row[6] and row[6] != 'null' else ''
	# Tags is everything from field 7 onwards, join with commas
	tags_str = ','.join(row[7:]) if len(row) > 7 else '{}'
	# Remove outer quotes if present
	if tags_str.startswith('"') and tags_str.endswith('"'):
		tags_str = tags_str[1:-1]
	# The XSLT generates JSON with double quotes escaped as ""
	# Convert "" to " for proper JSON parsing
	tags_str = tags_str.replace('""', '"')
	# Try to parse as JSON to validate and normalize
	tags = None
	try:
		tags = json.loads(tags_str)
	except json.JSONDecodeError:
		# If JSON parsing fails, try to rebuild from the XSLT format
		# The XSLT format is: "key":"value","key2":"value2"
		try:
			# Extract key-value pairs from XSLT format: "key":"value"
			# Handle escaped quotes in values
			pairs = []
			pattern = r'\"([^\"]+)\":\"([^\"]*(?:\\\\.[^\"]*)*)\"'
			for match in re.finditer(pattern, tags_str):
				key = match.group(1)
				value = match.group(2).replace('\\\\"', '"')
				pairs.append((key, value))
			if pairs:
				tags = dict(pairs)
			else:
				tags = {}
		except:
			tags = {}
	
	# Convert back to JSON string, ensuring it's valid
	if tags is not None:
		tags_str = json.dumps(tags, ensure_ascii=False)
	else:
		tags_str = '{}'
	
	# Extract OSM ID from type/id (e.g., 'node/123' -> '123')
	if '/' in typeid:
		osmid = typeid.split('/')[1]
	else:
		osmid = typeid
	
	# Output: project,action,osmid,version,timestamp,username,userid,changeset_id,tags
	writer.writerow([project, action, osmid, version, timestamp, username, uid, changeset_id, tags_str])
" > "${CSV_CHANGES}"
	else
		xsltproc "${OSC2CSV}" "\${TMP_OSC}" | python3 -c "
import sys
import csv
import json
import re

project = '${project.id}'
reader = csv.reader(sys.stdin)
writer = csv.writer(sys.stdout, quoting=csv.QUOTE_MINIMAL)
for row in reader:
	if len(row) < 8:
		continue
	action = row[0]
	typeid = row[1]
	version = row[2]
	timestamp = row[3]
	username = row[4].strip('\\"')
	uid = row[5]
	# Tags is everything from field 7 onwards, join with commas
	tags_str = ','.join(row[7:]) if len(row) > 7 else '{}'
	# Remove outer quotes if present
	if tags_str.startswith('"') and tags_str.endswith('"'):
		tags_str = tags_str[1:-1]
	# The XSLT generates JSON with double quotes escaped as ""
	# Convert "" to " for proper JSON parsing
	tags_str = tags_str.replace('""', '"')
	# Try to parse as JSON to validate and normalize
	tags = None
	try:
		tags = json.loads(tags_str)
	except json.JSONDecodeError:
		# If JSON parsing fails, try to rebuild from the XSLT format
		# The XSLT format is: "key":"value","key2":"value2"
		try:
			# Extract key-value pairs from XSLT format: "key":"value"
			# Handle escaped quotes in values
			pairs = []
			pattern = r'\"([^\"]+)\":\"([^\"]*(?:\\\\.[^\"]*)*)\"'
			for match in re.finditer(pattern, tags_str):
				key = match.group(1)
				value = match.group(2).replace('\\\\"', '"')
				pairs.append((key, value))
			if pairs:
				tags = dict(pairs)
			else:
				tags = {}
		except:
			tags = {}
	
	# Convert back to JSON string, ensuring it's valid
	if tags is not None:
		tags_str = json.dumps(tags, ensure_ascii=False)
	else:
		tags_str = '{}'
	
	# Extract OSM ID from type/id (e.g., 'node/123' -> '123')
	if '/' in typeid:
		osmid = typeid.split('/')[1]
	else:
		osmid = typeid
	
	# Output: project,action,osmid,version,timestamp,username,userid,tags
	writer.writerow([project, action, osmid, version, timestamp, username, uid, tags_str])
" > "${CSV_CHANGES}"
	fi
	# Ne pas supprimer le fichier OSC s'il est récent (moins de 24h) pour pouvoir le réutiliser
	if [ -f "\${TMP_OSC}" ] && [ -s "\${TMP_OSC}" ]; then
		OSC_MTIME=$(stat -c %Y "\${TMP_OSC}" 2>/dev/null || stat -f %m "\${TMP_OSC}" 2>/dev/null || echo "0")
		if [ "$OSC_MTIME" != "0" ]; then
			now_unix=$(date +%s)
			osc_age=$((now_unix - OSC_MTIME))
			if [ $osc_age -ge 86400 ]; then
				# Fichier OSC plus vieux que 24h, on peut le supprimer
				rm -f "\${TMP_OSC}"
			else
				# Fichier OSC récent, on le garde pour la prochaine fois
				echo "   ℹ️  Fichier OSC conservé pour réutilisation (âge: $((osc_age / 3600))h)"
			fi
		else
			rm -f "\${TMP_OSC}"
		fi
	else
		rm -f "\${TMP_OSC}"
	fi
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

${PSQL} -v project_id="'${project.id}'" -v project_table="pdm_project_${projectName}" -f "${__dirname}/33_changes_populate.sql"
if ${HAS_BOUNDARY}; then
	echo "   => Associate features with boundaries"
	if ${PSQL} -c "SELECT * FROM pdm_boundary_subdivide LIMIT 1" > /dev/null 2>&1; then
		${PSQL} -v project_id="'${project.id}'" -v project_table="pdm_project_${projectName}" -f "${__dirname}/33_changes_boundary.sql"
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
	let osmStats = OSH_USEFULL.replace("usefull.osh.pbf", `${projectName}.stats.osm.pbf`);
	let osmStatsFiltered = OSH_USEFULL.replace("usefull.osh.pbf", `${projectName}.filtered.stats.osm.pbf`);

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
	# Apply time-filter first on the full OSH file, then apply tag filters
	# This is more efficient and works better with small regions
	if osmium time-filter "${OSH_UPDATED}" \${day}T23:59:59Z --no-progress -O -o ${osmStats} -f osh.pbf 2>/dev/null; then
		if [ -f "${osmStats}" ] && [ -s "${osmStats}" ]; then
			`;
	let tagFilterLastPart = tagFilterParts.pop();
	tagFilterParts.forEach(tagFilter => {
		script += `
			if osmium tags-filter "${osmStats}" ${tagFilter} --no-progress -O -o "${osmStatsFiltered}" -f osh.pbf 2>/dev/null; then
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
				# Convert to OSM format for counting
				# Since the file is already filtered by tags, we count all objects in it
				# This ensures we count the same objects that are in the database (nodes and ways, not relations)
				if osmium export "${osmStats}" -f osm.pbf -O -o "${osmStats}.osm.pbf" 2>/dev/null; then
					# Count all objects in the filtered file (nodes + ways)
					# Use fileinfo to get accurate counts
					nbday=$(osmium fileinfo "${osmStats}.osm.pbf" --extended --no-progress 2>/dev/null | grep -E "nodes|ways" | grep -oE '[0-9]+' | paste -sd+ | bc 2>/dev/null || echo "0")
					rm -f "${osmStats}.osm.pbf"
				else
					# Fallback: count from OSH file using fileinfo
					nbday=$(osmium fileinfo "${osmStats}" --extended --no-progress 2>/dev/null | grep -E "nodes|ways" | grep -oE '[0-9]+' | paste -sd+ | bc 2>/dev/null || echo "0")
				fi
				if [ "$nbday" == "" ]; then
					nbday="0"
				fi
			else
				nbday="0"
			fi
		else
			echo "   ⚠️  OSM stats file is empty or missing after time-filter, skipping count for \${day}"
			nbday="0"
		fi
	else
		echo "   ⚠️  Failed to filter by time, skipping count for \${day}"
		nbday="0"
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
