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

if [ -f "${OSH_UPDATED}" ]; then
	echo "== Reuse existing history file"
	prev_osh="${OSH_UPDATED}"
	if [ -f ${CONFIG.WORK_DIR}/osh_timestamp ]; then
		prev_timestamp=$(cat ${CONFIG.WORK_DIR}/osh_timestamp)
		echo "Timestamp: $prev_timestamp"
	else
		echo "No timestamp found"
	fi

else
	echo "== Get cookies for authorized download of OSH PBF file"
	if ! python3 ${__dirname}/../lib/sendfile_osm_oauth_protector/oauth_cookie_client.py \\
		--osm-host ${CONFIG.OSM_URL} \\
		-u "${CONFIG.OSM_USER}" -p "${CONFIG.OSM_PASS}" \\
		-c ${CONFIG.OSH_PBF_URL.split("/").slice(0, 3).join("/")}/get_cookie \\
		-o "${COOKIES}" 2>&1; then
		echo "ERROR: Failed to obtain authentication cookie from OSM."
		echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
		echo "The OSH PBF file requires OSM authentication to download."
		rm -f "${COOKIES}"
		exit 1
	fi

	if [ ! -f "${COOKIES}" ] || [ ! -s "${COOKIES}" ]; then
		echo "ERROR: Cookie file is missing or empty. Authentication may have failed."
		echo "Please check your OSM credentials in config.json (OSM_USER and OSM_PASS)."
		rm -f "${COOKIES}"
		exit 1
	fi

	echo "== Download OSH PBF file"
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
	osmupdate --keep-tempfiles --day -t="${CONFIG.WORK_DIR}/osmupdate/" -v "$prev_osh" $prev_timestamp "${OSC_UPDATES}"
	echo "== Apply changes to OSH file..."
	osmium apply-changes --progress -H "$prev_osh" "${OSC_UPDATES}" -O -o "${OSH_UPDATED_NEW}"
	echo "== Extract polygon data..."
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

fs.writeFile(OUTPUT_SCRIPT, script, { mode: 0o766 }, err => {
	if(err) { throw new Error(err); }
	console.log("Written Bash script");
});
