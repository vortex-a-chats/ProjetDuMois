const CONFIG = require('../config.json');
const fs = require('fs');

/*
 * Generates 11_pbf_update_tmp.sh script
 * in order to update pbf, osh raw files for downstream processing
 */

const OSH_POLY = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace("-internal.osh.pbf", ".poly");
const OSH_UPDATED = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.osh.pbf");
const OSH_UPDATED_NEW = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.new.osh.pbf");
const OSM_PBF_NOW = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".osm.pbf");
const IMPOSM_ENABLED = CONFIG.DB_USE_IMPOSM_UPDATE;
if (IMPOSM_ENABLED == null){
	IMPOSM_ENABLED = true;
}

const OSC_UPDATES = CONFIG.WORK_DIR + '/changes.osc.gz';

const COOKIES = CONFIG.WORK_DIR + '/cookie.txt';
const PSQL = `psql -d ${process.env.DB_URL}`;
const OUTPUT_SCRIPT = CONFIG.WORK_DIR + '/11_pbf_update_tmp.sh';
const HTML_ERROR_FILE_AUTH = CONFIG.WORK_DIR + '/auth_error.html';
const HTML_ERROR_FILE_PBF = CONFIG.WORK_DIR + '/pbf_download_error.html';

// Script text
const separator = `echo "-------------------------------------------------------------------"
echo ""`;

// Full script
var script = `#!/bin/bash

# Script for updating current projects
# Generated automatically by npm run pbf:update

set -e

mode="$1"

if [ ! -d "${CONFIG.WORK_DIR}" ]; then
	echo "== Create work directory"
	mkdir -p "${CONFIG.WORK_DIR}"
	${separator}
fi

if [ -f "${OSH_UPDATED}" ] && [ -s "${OSH_UPDATED}" ]; then
	# Vérifier que le fichier est valide (pas HTML, pas vide)
	# Check first bytes to detect HTML/text files (HTML usually starts with <!DOCTYPE or <html)
	first_bytes=$(head -c 20 "${OSH_UPDATED}" 2>/dev/null || echo "")
	if echo "$first_bytes" | grep -qi "<!DOCTYPE\|<html\|text/html"; then
		echo "== Existing OSH file appears to be invalid (HTML/text instead of PBF)"
		echo "   => Will re-download..."
		rm -f "${OSH_UPDATED}"
		prev_osh=""
	else
		echo "== Reuse existing history file"
		prev_osh="${OSH_UPDATED}"
		if [ -f ${CONFIG.WORK_DIR}/osh_timestamp ]; then
			prev_timestamp=$(cat ${CONFIG.WORK_DIR}/osh_timestamp)
			if [ -n "$prev_timestamp" ]; then
				echo "Timestamp: $prev_timestamp"
				# Check if timestamp is valid
				timestamp_epoch=$(date -d "$prev_timestamp" +%s 2>/dev/null || echo 0)
				current_epoch=$(date +%s)
				
				if [ $timestamp_epoch -eq 0 ] 2>/dev/null; then
					echo "WARNING: Invalid timestamp format, ignoring it"
					prev_timestamp=""
				else
					# Check if timestamp is too old (more than 30 days), if so, re-download full file
					timestamp_age=$(($current_epoch - $timestamp_epoch))
					max_age=$((30 * 24 * 3600)) # 30 days in seconds
					if [ $timestamp_age -gt $max_age ] 2>/dev/null; then
						echo "WARNING: Timestamp is more than 30 days old ($(($timestamp_age / 86400)) days)"
						echo "         This would require downloading too many incremental changes."
						echo "         Re-downloading full OSH file instead..."
						rm -f "${OSH_UPDATED}"
						prev_osh=""
					else
						echo "   => Using existing OSH file: ${OSH_UPDATED}"
					fi
				fi
			else
				echo "WARNING: Timestamp file exists but is empty"
				echo "   => Using existing OSH file (will create new timestamp later)"
				echo "   => File: ${OSH_UPDATED}"
			fi
		else
			echo "INFO: No timestamp found, but OSH file exists and appears valid"
			echo "   => Using existing OSH file (will create new timestamp later)"
			echo "   => File: ${OSH_UPDATED}"
		fi
	fi
else
	echo "== OSH file not found or is empty"
	prev_osh=""
fi

# Ne télécharger que si le fichier n'existe pas vraiment ou a été supprimé
if [ -z "$prev_osh" ] || [ ! -f "${OSH_UPDATED}" ] || [ ! -s "${OSH_UPDATED}" ]; then
	echo "== Download OSH PBF file with OSM authentication"
	echo "   => Using Python download script for better error handling"
	echo "   => URL: ${CONFIG.OSH_PBF_URL}"
	
	# Use Python script to download with authentication
	DOWNLOAD_SCRIPT="${__dirname}/download_osh_pbf.py"
	if [ ! -f "$DOWNLOAD_SCRIPT" ]; then
		echo "ERROR: Download script not found: $DOWNLOAD_SCRIPT"
		exit 1
	fi
	
	if ! python3 "$DOWNLOAD_SCRIPT" \\
		--osm-host "${CONFIG.OSM_URL}" \\
		--osm-user "${CONFIG.OSM_USER}" \\
		--osm-pass "${CONFIG.OSM_PASS}" \\
		--url "${CONFIG.OSH_PBF_URL}" \\
		--output "${OSH_UPDATED}" \\
		--work-dir "${CONFIG.WORK_DIR}" 2>&1; then
		echo "ERROR: Failed to download OSH PBF file."
		echo "URL attempted: ${CONFIG.OSH_PBF_URL}"
		echo "This may be due to:"
		echo "  - Invalid OSM credentials"
		echo "  - Network connectivity issues"
		echo "  - The OSH PBF URL is incorrect or inaccessible"
		echo ""
		echo "Please verify the OSH_PBF_URL in your config.json file."
		echo "For French regions, the URL structure is typically:"
		echo "  https://osm-internal.download.geofabrik.de/europe/france/[region]-internal.osh.pbf"
		echo "For Réunion, try:"
		echo "  https://osm-internal.download.geofabrik.de/europe/france/reunion-internal.osh.pbf"
		echo "  OR"
		echo "  https://osm-internal.download.geofabrik.de/europe/reunion-internal.osh.pbf"
		echo ""
		echo "Note: OSH PBF files require OSM authentication. Make sure your OSM_USER and OSM_PASS are correct."
		rm -f "${OSH_UPDATED}"
		exit 1
	fi

	# Download polygon file if needed (no authentication required for .poly files)
	POLY_URL="${CONFIG.OSH_PBF_URL.replace("-internal.osh.pbf", ".poly")}"
	if ! wget -N -O "${OSH_POLY}" "$POLY_URL" 2>&1; then
		echo "WARNING: Failed to download polygon file from $POLY_URL, but continuing with PBF file."
		echo "   => Will try to download from Geofabrik public mirror instead..."
		if ! wget -O "${OSH_POLY}" "https://download.geofabrik.de/europe/france.poly" 2>&1; then
			echo "WARNING: Failed to download polygon file from Geofabrik public mirror as well."
			echo "   => Continuing without polygon file (extraction step may fail if polygon is required)"
		fi
	fi
	
	prev_osh="${OSH_UPDATED}"
	prev_timestamp=""
fi
${separator}

if [[ "$mode" != "fast" ]]; then
	echo "== Build OSC changes with replication files..."
		if [ -n "$prev_timestamp" ]; then
			echo "   => Using incremental update from timestamp: $prev_timestamp"
			osmupdate --keep-tempfiles --day -t="${CONFIG.WORK_DIR}/osmupdate/" -v "$prev_osh" "$prev_timestamp" "${OSC_UPDATES}"
	else
		echo "   => No timestamp available, using full file (no incremental update needed)"
		# If no timestamp, we just extracted from the full file, so no changes to apply
		touch "${OSC_UPDATES}"
	fi
	echo "== Apply changes to OSH file..."
	if [ -n "$prev_timestamp" ] && [ -s "${OSC_UPDATES}" ]; then
		osmium apply-changes --progress -H "$prev_osh" "${OSC_UPDATES}" -O -o "${OSH_UPDATED_NEW}"
	else
		echo "   => No changes to apply (using existing file or no timestamp)"
		cp "$prev_osh" "${OSH_UPDATED_NEW}"
	fi
	echo "== Extract polygon data..."
	# Check if the OSH file is for a specific region (like Réunion) or for the whole country
	# If the URL contains a region name (not just "france"), skip polygon extraction
	OSH_URL="${CONFIG.OSH_PBF_URL}"
	OSH_FILENAME=$(basename "${OSH_URL}" .osh.pbf)
	# Check if filename contains region name (case-insensitive)
	if echo "$OSH_FILENAME" | grep -qiE "reunion|guadeloupe|martinique|guyane|mayotte"; then
		echo "   => Regional OSH file detected (${OSH_FILENAME}), skipping polygon extraction (file is already region-specific)"
		cp "${OSH_UPDATED_NEW}" "${OSH_UPDATED}"
	else
		# For France métropolitaine, extract with polygon
		# Ensure polygon file exists; download from Geofabrik if missing
		if [ ! -f "${OSH_POLY}" ] || [ ! -s "${OSH_POLY}" ]; then
			echo "   => Polygon file missing, downloading from Geofabrik..."
			if ! wget -O "${OSH_POLY}" "https://download.geofabrik.de/europe/france.poly" 2>&1; then
				echo "ERROR: Unable to download polygon file."
				exit 1
			fi
		fi
		# Use simple strategy instead of complete_ways to reduce memory usage
		# For OSH files with history, simple strategy is sufficient for polygon extraction
		osmium extract -p "${OSH_POLY}" --with-history -s simple "${OSH_UPDATED_NEW}" -O -o "${OSH_UPDATED}"
	fi
	echo "== Remove temp files"
	rm -f "${OSC_UPDATES}"
	rm -f "${OSH_UPDATED_NEW}"
else
	echo "== Skipped update of OSH PBF file"
fi
${separator}
`;

if (IMPOSM_ENABLED){
	script += `
if [[ "$mode" != "fast" ]]; then
	echo "== Write current state of OSM data as OSM.PBF"
	osmium time-filter "${OSH_UPDATED}" -O -o "${OSM_PBF_NOW}"
else
	echo "== Skipped creation of current OSM.PBF file"
fi
${separator}
`;
}

script += `
rm -f "${CONFIG.WORK_DIR}/osh_timestamp"
# Write timestamp: use current time minus 3 hours to account for replication delay
curtime=$(date -d '3 hours ago' -Iseconds --utc 2>/dev/null || date -u -Iseconds)
# Ensure timestamp is in correct format (replace +00:00 with Z)
timestamp=\${curtime/"+00:00"/"Z"}
echo "$timestamp" > ${CONFIG.WORK_DIR}/osh_timestamp
echo "OSH timestamp written: $timestamp"
echo "Done"
`;

// Ensure work directory exists
if (!fs.existsSync(CONFIG.WORK_DIR)) {
	fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });
}

fs.writeFileSync(OUTPUT_SCRIPT, script);
fs.chmodSync(OUTPUT_SCRIPT, '755');
console.log("Written Bash script");
