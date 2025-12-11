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
	echo "== Reuse existing history file"
	prev_osh="${OSH_UPDATED}"
	if [ -f ${CONFIG.WORK_DIR}/osh_timestamp ]; then
		prev_timestamp=$(cat ${CONFIG.WORK_DIR}/osh_timestamp)
		if [ -n "$prev_timestamp" ]; then
			echo "Timestamp: $prev_timestamp"
			# Check if timestamp is too old (more than 30 days), if so, re-download full file
			timestamp_age=$(($(date +%s) - $(date -d "$prev_timestamp" +%s 2>/dev/null || echo 0)))
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
		else
			echo "WARNING: Timestamp file exists but is empty"
			echo "         Re-downloading full OSH file to ensure consistency..."
			rm -f "${OSH_UPDATED}"
			prev_osh=""
		fi
	else
		echo "WARNING: No timestamp found"
		echo "         Re-downloading full OSH file to ensure consistency..."
		rm -f "${OSH_UPDATED}"
		prev_osh=""
	fi
else
	echo "== OSH file not found or is empty"
	prev_osh=""
fi

if [ ! -f "${OSH_UPDATED}" ] || [ ! -s "${OSH_UPDATED}" ] || [ -z "$prev_osh" ]; then
	echo "== Get cookies for authorized download of OSH PBF file"
	
	# Tentative d'authentification avec retries en cas d'erreur 503
	MAX_RETRIES=3
	RETRY_DELAY=10
	retry_count=0
	auth_success=false
	AUTH_OUTPUT="${CONFIG.WORK_DIR}/auth_output.log"
	
	while [ $retry_count -lt $MAX_RETRIES ]; do
		rm -f "\${AUTH_OUTPUT}" "${COOKIES}"
		auth_output=$(python3 ${__dirname}/../lib/sendfile_osm_oauth_protector/oauth_cookie_client.py \\
			--osm-host ${CONFIG.OSM_URL} \\
			-u "${CONFIG.OSM_USER}" -p "${CONFIG.OSM_PASS}" \\
			-c ${CONFIG.OSH_PBF_URL.split("/").slice(0, 3).join("/")}/get_cookie \\
			-o "${COOKIES}" 2>&1)
		auth_exit_code=$?
		echo "\$auth_output" > "\${AUTH_OUTPUT}"
		
		if [ $auth_exit_code -eq 0 ]; then
			auth_success=true
			break
		else
			retry_count=$((retry_count + 1))
			# Vérifier si c'est une erreur 503 (service temporairement indisponible)
			if echo "\$auth_output" | grep -q "HTTP code 503"; then
				if [ $retry_count -lt $MAX_RETRIES ]; then
					echo "   ⚠️  OSM service temporarily unavailable (503). Retrying in \${RETRY_DELAY} seconds... (attempt \$retry_count/\$MAX_RETRIES)"
					sleep $RETRY_DELAY
					continue
				else
					echo "ERROR: OSM service is temporarily unavailable (HTTP 503)."
					echo "This is usually a temporary issue with the OSM servers."
					echo "Please try again in a few minutes."
					rm -f "${COOKIES}" "\${AUTH_OUTPUT}"
					exit 1
				fi
			fi
		fi
	done
	
	rm -f "\${AUTH_OUTPUT}"
	
	if [ "$auth_success" = "false" ]; then
		echo "ERROR: Failed to obtain authentication cookie from OSM after $MAX_RETRIES attempts."
		echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
		echo "The OSH PBF file requires OSM authentication to download."
		rm -f "${COOKIES}"
		exit 1
	fi

	if [ ! -f "${COOKIES}" ] || [ ! -s "${COOKIES}" ]; then
		echo "ERROR: Cookie file is missing or empty. Authentication may have failed."
		if [ -f "${COOKIES}" ]; then
			echo "Saving cookie file content to ${COOKIES}.html for inspection..."
			cp "${COOKIES}" "${COOKIES}.html"
			echo "Attempting to open cookie file in Firefox..."
			if command -v firefox >/dev/null 2>&1; then
				firefox "file://${COOKIES}.html" 2>/dev/null &
				echo "Cookie file opened in Firefox"
			elif [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then
				xdg-open "file://${COOKIES}.html" 2>/dev/null &
				echo "Cookie file opened in default browser"
			else
				echo "Could not open browser automatically. Please open manually: file://${COOKIES}.html"
			fi
		fi
		echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
		rm -f "${COOKIES}"
		exit 1
	fi
	
	# Check if cookie file contains HTML (authentication failed)
	if head -1 "${COOKIES}" | grep -qi "<!DOCTYPE html\|<html"; then
		echo "ERROR: Cookie file contains HTML instead of a cookie. Authentication failed."
		echo "Saving HTML response to ${HTML_ERROR_FILE_AUTH} for inspection..."
		cp "${COOKIES}" "${HTML_ERROR_FILE_AUTH}"
		echo ""
		# Save the file path to a location accessible from host
		if [ -d "/data/files/pdm" ]; then
			cp "${HTML_ERROR_FILE_AUTH}" "/data/files/pdm/auth_error.html" 2>/dev/null || true
			echo "File also saved to /data/files/pdm/auth_error.html (accessible from host)"
		fi
		echo ""
		FILENAME=$(basename "${HTML_ERROR_FILE_AUTH}")
		echo "Run this command on the host to open the error page in Firefox:"
		echo "  docker-compose exec pdm cat ${HTML_ERROR_FILE_AUTH} > \${FILENAME} && firefox \${FILENAME}"
		echo ""
		echo "Or use the helper script:"
		echo "  ./open_error_in_firefox.sh pdm ${HTML_ERROR_FILE_AUTH}"
		echo ""
		echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
		rm -f "${COOKIES}"
		exit 1
	fi

	echo "== Download OSH PBF file"
	# wget -N ne retélécharge pas si le fichier existe déjà et est à jour
	# Vérifier d'abord si le fichier existe et est valide
	if [ -f "${OSH_UPDATED}" ] && [ -s "${OSH_UPDATED}" ]; then
		file_type=$(file -b "${OSH_UPDATED}" | head -c 20)
		if ! echo "$file_type" | grep -qi "html\|text"; then
			echo "   => OSH file already exists and appears valid. Using wget -N to check for updates..."
		fi
	fi
	if ! wget -N --no-cookies --header "Cookie: $(cat ${COOKIES} | cut -d ';' -f 1)" -P "${CONFIG.WORK_DIR}" -O "${OSH_UPDATED}" "${CONFIG.OSH_PBF_URL}" 2>&1; then
		echo "ERROR: Failed to download OSH PBF file."
		echo "This may be due to:"
		echo "  - Invalid OSM credentials"
		echo "  - Network connectivity issues"
		echo "  - The OSH PBF URL is incorrect or inaccessible"
		rm -f "${COOKIES}" "${OSH_UPDATED}"
		exit 1
	fi

	# Check if downloaded file is actually a PBF file (not an HTML error page)
	if [ -f "${OSH_UPDATED}" ]; then
		file_type=$(file -b "${OSH_UPDATED}" | head -c 20)
		if echo "$file_type" | grep -qi "html\|text"; then
			echo "ERROR: Downloaded file appears to be an HTML page instead of a PBF file."
			echo "This usually means authentication failed. The file contains:"
			head -5 "${OSH_UPDATED}"
			echo ""
			echo "Saving HTML response to ${HTML_ERROR_FILE_PBF} for inspection..."
			cp "${OSH_UPDATED}" "${HTML_ERROR_FILE_PBF}"
			echo ""
			# Save the file path to a location accessible from host
			if [ -d "/data/files/pdm" ]; then
				cp "${HTML_ERROR_FILE_PBF}" "/data/files/pdm/pbf_download_error.html" 2>/dev/null || true
				echo "File also saved to /data/files/pdm/pbf_download_error.html (accessible from host)"
			fi
			echo ""
			FILENAME=$(basename "${HTML_ERROR_FILE_PBF}")
			echo "Run this command on the host to open the error page in Firefox:"
			echo "  docker-compose exec pdm cat ${HTML_ERROR_FILE_PBF} > \${FILENAME} && firefox \${FILENAME}"
			echo ""
			echo "Or use the helper script:"
			echo "  ./open_error_in_firefox.sh pdm ${HTML_ERROR_FILE_PBF}"
			echo ""
			echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
			rm -f "${COOKIES}" "${OSH_UPDATED}"
			exit 1
		fi
		if [ ! -s "${OSH_UPDATED}" ]; then
			echo "ERROR: Downloaded file is empty."
			rm -f "${COOKIES}" "${OSH_UPDATED}"
			exit 1
		fi
	fi

	if ! wget -N --no-cookies --header "Cookie: $(cat ${COOKIES} | cut -d ';' -f 1)" -P "${CONFIG.WORK_DIR}" "${CONFIG.OSH_PBF_URL.replace("-internal.osh.pbf", ".poly")}" 2>&1; then
		echo "WARNING: Failed to download polygon file, but continuing with PBF file."
	fi
	rm -f "${COOKIES}"
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
		# Ensure polygon file exists; download from Geofabrik if missing
		if [ ! -f "${OSH_POLY}" ] || [ ! -s "${OSH_POLY}" ]; then
			echo "   => Polygon file missing, downloading from Geofabrik..."
			if ! wget -O "${OSH_POLY}" "https://download.geofabrik.de/europe/france.poly" 2>&1; then
				echo "ERROR: Unable to download polygon file."
				exit 1
			fi
		fi
	osmium extract -p "${OSH_POLY}" --with-history -s complete_ways "${OSH_UPDATED_NEW}" -O -o "${OSH_UPDATED}"
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
curtime=$(date -d '3 hours ago' -Iseconds --utc)
echo \${curtime/"+00:00"/"Z"} > ${CONFIG.WORK_DIR}/osh_timestamp
echo "Done"
`;

// Ensure work directory exists
if (!fs.existsSync(CONFIG.WORK_DIR)) {
	fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });
}

fs.writeFileSync(OUTPUT_SCRIPT, script);
fs.chmodSync(OUTPUT_SCRIPT, '755');
console.log("Written Bash script");
