const { Pool } = require('pg');
const fs = require('fs');
const https = require('https');
const http = require('http');

const CONFIG = require('../config.json');
const DB_URL = process.env.DB_URL || CONFIG.DB_URL;

const pool = new Pool({
	connectionString: DB_URL
});

const PSQL = `psql -d "${DB_URL}"`;
const OUTPUT_SCRIPT = '/tmp/pdm/41_global_stats_update_tmp.sh';

let script = `#!/bin/bash
set -e

# Créer le répertoire de log au début pour éviter les erreurs
# Utiliser /tmp/pdm pour les logs car c'est accessible dans le conteneur Docker
LOG_DIR="/tmp/pdm/.cursor"
mkdir -p "$LOG_DIR"

${PSQL} -c "SELECT 1" > /dev/null 2>&1 || {
	echo "ERROR: Cannot connect to database"
	exit 1
}

echo "== Create tables if they don't exist"
${PSQL} -c "CREATE TABLE IF NOT EXISTS pdm_note_counts_global(
	ts TIMESTAMP NOT NULL,
	open INT NOT NULL,
	closed INT NOT NULL,
	CONSTRAINT pdm_note_counts_global_pk PRIMARY KEY(ts)
);" || {
	echo "ERROR: Failed to create pdm_note_counts_global table"
	exit 1
}

${PSQL} -c "CREATE INDEX IF NOT EXISTS pdm_note_counts_global_ts_idx ON pdm_note_counts_global(ts);" || true

${PSQL} -c "CREATE TABLE IF NOT EXISTS pdm_relation_hiking (
	osm_id BIGINT PRIMARY KEY,
	name VARCHAR,
	tags JSONB,
	geom GEOMETRY(Polygon, 3857),
	created_at TIMESTAMP DEFAULT NOW()
);" || {
	echo "ERROR: Failed to create pdm_relation_hiking table"
	exit 1
}

${PSQL} -c "CREATE INDEX IF NOT EXISTS pdm_relation_hiking_geom_idx ON pdm_relation_hiking USING GIST(geom);" || true
${PSQL} -c "CREATE INDEX IF NOT EXISTS pdm_relation_hiking_name_idx ON pdm_relation_hiking(name);" || true

${PSQL} -c "CREATE TABLE IF NOT EXISTS pdm_relation_hiking_members (
	relation_id BIGINT NOT NULL,
	ts TIMESTAMP NOT NULL,
	member_count INT NOT NULL,
	changeset_id BIGINT,
	username VARCHAR,
	userid BIGINT,
	CONSTRAINT pdm_relation_hiking_members_pk PRIMARY KEY(relation_id, ts)
);" || {
	echo "ERROR: Failed to create pdm_relation_hiking_members table"
	exit 1
}

${PSQL} -c "CREATE INDEX IF NOT EXISTS pdm_relation_hiking_members_relation_idx ON pdm_relation_hiking_members(relation_id);" || true
${PSQL} -c "CREATE INDEX IF NOT EXISTS pdm_relation_hiking_members_ts_idx ON pdm_relation_hiking_members(ts);" || true

echo ""
echo "== Notes statistics (France)"
`;

// Notes globales en France - utiliser le dump de notes depuis planet.openstreetmap.org
// Note: Les notes OSM ne sont pas dans les fichiers OSH, elles sont disponibles via les dumps XML
// Ce script sauvegarde une mesure quotidienne dans pdm_note_counts_global avec le timestamp de fin de journée
// Si exécuté plusieurs fois le même jour, la mesure est mise à jour (ON CONFLICT DO UPDATE)
const today = new Date().toISOString().split('T')[0];
script += `
CURRENT_DATE="${today}"
NOTES_OPEN=0
NOTES_CLOSED=0

# Télécharger et traiter le dump de notes depuis planet.openstreetmap.org
# Bbox approximative de la France: minlon=2.0, minlat=41.0, maxlon=8.0, maxlat=51.0
echo "   => Downloading notes dump from planet.openstreetmap.org..."

TMP_NOTES_DIR="${CONFIG.WORK_DIR}"
mkdir -p "$TMP_NOTES_DIR"
NOTES_DUMP_URL="https://planet.openstreetmap.org/notes/planet-notes-latest.osn.bz2"
NOTES_DUMP_FILE="$TMP_NOTES_DIR/planet-notes-latest.osn.bz2"
NOTES_DUMP_XML="$TMP_NOTES_DIR/planet-notes-latest.osn"
NOTES_FRANCE_XML="$TMP_NOTES_DIR/notes-france-\${CURRENT_DATE}.osn"

# Télécharger le dump de notes (seulement si absent, vide, trop petit, ou plus vieux que 24h)
# #region agent log
SHOULD_DOWNLOAD=false
MIN_SIZE=314572800  # 300 Mo en bytes

if [ ! -f "$NOTES_DUMP_FILE" ] || [ ! -s "$NOTES_DUMP_FILE" ]; then
	SHOULD_DOWNLOAD=true
	echo "   => Notes dump file missing or empty, will download"
else
	# Vérifier la taille du fichier (doit faire au moins 300 Mo)
	FILE_SIZE=$(stat -c%s "$NOTES_DUMP_FILE" 2>/dev/null || stat -f%z "$NOTES_DUMP_FILE" 2>/dev/null || echo "0")
	FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
	
	if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
		SHOULD_DOWNLOAD=true
		echo "   => Notes dump file is too small: \${FILE_SIZE_MB} MB (expected at least 300 MB), will re-download"
	else
		# Vérifier l'âge du fichier (24 heures = 86400 secondes)
		FILE_AGE=$(($(date +%s) - $(stat -c %Y "$NOTES_DUMP_FILE" 2>/dev/null || echo 0)))
		if [ $FILE_AGE -gt 86400 ]; then
			SHOULD_DOWNLOAD=true
			FILE_AGE_HOURS=$((FILE_AGE / 3600))
			echo "   => Notes dump file is $FILE_AGE_HOURS hours old (older than 24h), will download"
		else
			FILE_AGE_HOURS=$((FILE_AGE / 3600))
			echo "   => Using existing notes dump file (size: \${FILE_SIZE_MB} MB, age: $FILE_AGE_HOURS hours, less than 24h)"
		fi
	fi
fi
# #endregion agent log

if [ "$SHOULD_DOWNLOAD" = "true" ]; then
	echo "   => Downloading notes dump (this may take a while)..."
	# Supprimer le fichier existant s'il est trop petit
	if [ -f "$NOTES_DUMP_FILE" ]; then
		rm -f "$NOTES_DUMP_FILE"
	fi
	if ! wget -N -P "$TMP_NOTES_DIR" "$NOTES_DUMP_URL" 2>&1; then
		echo "   ⚠️  Error downloading notes dump"
		exit 1
	fi
	
	# Vérifier que le fichier téléchargé fait au moins 300 Mo
	# Si le fichier est trop petit, il est probablement corrompu ou incomplet
	FILE_SIZE=$(stat -c%s "$NOTES_DUMP_FILE" 2>/dev/null || stat -f%z "$NOTES_DUMP_FILE" 2>/dev/null || echo "0")
	FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
	
	if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
		echo "   ⚠️  Notes dump file is too small after download: \${FILE_SIZE_MB} MB (expected at least 300 MB)"
		echo "   => File may be corrupted or incomplete, removing and re-downloading..."
		rm -f "$NOTES_DUMP_FILE"
		echo "   => Re-downloading notes dump from planet.openstreetmap.org..."
		if ! wget -N -P "$TMP_NOTES_DIR" "$NOTES_DUMP_URL" 2>&1; then
			echo "   ⚠️  Error re-downloading notes dump"
			exit 1
		fi
		# Vérifier à nouveau la taille après le re-téléchargement
		FILE_SIZE=$(stat -c%s "$NOTES_DUMP_FILE" 2>/dev/null || stat -f%z "$NOTES_DUMP_FILE" 2>/dev/null || echo "0")
		FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
		if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
			echo "   ❌ Notes dump file is still too small after re-download: \${FILE_SIZE_MB} MB"
			echo "   ❌ The file on planet.openstreetmap.org may be corrupted or the download failed"
			exit 1
		fi
		echo "   ✓ Notes dump file size OK after re-download: \${FILE_SIZE_MB} MB"
	else
		echo "   ✓ Notes dump file size OK: \${FILE_SIZE_MB} MB"
	fi
fi

# Décompresser le dump avec Python (bz2 est intégré dans Python)
# #region agent log
SHOULD_DECOMPRESS=false
LOG_FILE="/tmp/pdm/.cursor/debug.log"
touch "$LOG_FILE" 2>/dev/null || true
if [ ! -f "$NOTES_DUMP_XML" ]; then
	SHOULD_DECOMPRESS=true
	echo "   => Decompressing notes dump (file missing)..."
	echo "{\"location\":\"40_global_stats_update.js:123\",\"message\":\"decompression needed - file missing\",\"data\":{\"file\":\"$NOTES_DUMP_XML\"},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
elif [ "$NOTES_DUMP_FILE" -nt "$NOTES_DUMP_XML" ]; then
	SHOULD_DECOMPRESS=true
	echo "   => Decompressing notes dump (compressed file is newer)..."
	echo "{\"location\":\"40_global_stats_update.js:126\",\"message\":\"decompression needed - compressed newer\",\"data\":{\"compressed\":\"$NOTES_DUMP_FILE\",\"decompressed\":\"$NOTES_DUMP_XML\"},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
else
	# Vérifier l'âge du fichier décompressé (24 heures = 86400 secondes)
	XML_FILE_AGE=$(($(date +%s) - $(stat -c %Y "$NOTES_DUMP_XML" 2>/dev/null || echo 0)))
	if [ $XML_FILE_AGE -gt 86400 ]; then
		SHOULD_DECOMPRESS=true
		XML_FILE_AGE_HOURS=$((XML_FILE_AGE / 3600))
		echo "   => Decompressing notes dump (decompressed file is $XML_FILE_AGE_HOURS hours old, older than 24h)..."
		echo "{\"location\":\"40_global_stats_update.js:131\",\"message\":\"decompression needed - file too old\",\"data\":{\"file\":\"$NOTES_DUMP_XML\",\"ageHours\":$XML_FILE_AGE_HOURS},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
	else
		XML_FILE_AGE_HOURS=$((XML_FILE_AGE / 3600))
		echo "   => Using existing decompressed notes dump (age: $XML_FILE_AGE_HOURS hours, less than 24h)"
		echo "{\"location\":\"40_global_stats_update.js:137\",\"message\":\"using existing decompressed file\",\"data\":{\"file\":\"$NOTES_DUMP_XML\",\"ageHours\":$XML_FILE_AGE_HOURS},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
	fi
fi
# #endregion agent log

if [ "$SHOULD_DECOMPRESS" = "true" ]; then
	echo "   => Decompressing notes dump..."
	# Vérifier que le fichier compressé existe et n'est pas vide
	if [ ! -f "$NOTES_DUMP_FILE" ] || [ ! -s "$NOTES_DUMP_FILE" ]; then
		echo "   ⚠️  Notes dump file is missing or empty"
		exit 1
	fi
	
	# Utiliser Python pour décompresser (Python a bz2 intégré)
	if command -v python3 > /dev/null 2>&1; then
		python3 -c "
import bz2
import sys
try:
    with bz2.open('$NOTES_DUMP_FILE', 'rb') as f_in:
        with open('$NOTES_DUMP_XML', 'wb') as f_out:
            f_out.write(f_in.read())
    sys.exit(0)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1
		DECOMPRESS_ERROR=$?
	elif command -v bunzip2 > /dev/null 2>&1; then
		bunzip2 -c "$NOTES_DUMP_FILE" > "$NOTES_DUMP_XML" 2>&1
		DECOMPRESS_ERROR=$?
	elif command -v bzip2 > /dev/null 2>&1; then
		bzip2 -dc "$NOTES_DUMP_FILE" > "$NOTES_DUMP_XML" 2>&1
		DECOMPRESS_ERROR=$?
	else
		echo "   ⚠️  No decompression tool available (python3, bunzip2, or bzip2)"
		exit 1
	fi
	
	if [ $DECOMPRESS_ERROR -ne 0 ] || [ ! -f "$NOTES_DUMP_XML" ] || [ ! -s "$NOTES_DUMP_XML" ]; then
		echo "   ⚠️  Error decompressing notes dump (exit code: $DECOMPRESS_ERROR)"
		echo "   ⚠️  File size: $(stat -c%s "$NOTES_DUMP_FILE" 2>/dev/null || echo "unknown") bytes"
		rm -f "$NOTES_DUMP_XML"
		exit 1
	fi
	echo "   => Decompression successful"
else
	echo "   => Using existing decompressed notes dump"
fi

# Vérifier si le parsing a été fait il y a moins d'une heure
NOTES_PARSE_TIMESTAMP_FILE="$TMP_NOTES_DIR/.notes_parse_timestamp"
SHOULD_PARSE_NOTES=true

if [ -f "$NOTES_PARSE_TIMESTAMP_FILE" ]; then
	LAST_PARSE_TIME=$(cat "$NOTES_PARSE_TIMESTAMP_FILE" 2>/dev/null || echo "0")
	CURRENT_TIME=$(date +%s)
	TIME_SINCE_LAST_PARSE=$((CURRENT_TIME - LAST_PARSE_TIME))
	ONE_HOUR=3600
	
	if [ $TIME_SINCE_LAST_PARSE -lt $ONE_HOUR ]; then
		SHOULD_PARSE_NOTES=false
		MINUTES_SINCE=$((TIME_SINCE_LAST_PARSE / 60))
		echo "   => Notes were parsed $MINUTES_SINCE minutes ago (less than 1 hour), skipping parsing"
	fi
fi

if [ "$SHOULD_PARSE_NOTES" = "true" ]; then
	# Parser directement le XML avec Node.js (osmium ne supporte pas les fichiers .osn)
	echo "   => Processing notes XML file (this may take a while)..."
	
	# Utiliser Node.js pour parser le XML et compter les notes
	node - "$NOTES_DUMP_XML" "\${CURRENT_DATE}" <<'NODEJS'
const fs = require('fs');
const { Pool } = require('pg');
const DB_URL = process.env.DB_URL || '${DB_URL}';
const pool = new Pool({ connectionString: DB_URL });

async function processNotes() {
	try {
		const filePath = process.argv[2];
		if (!filePath || filePath === 'undefined') {
			console.error('   ❌ Notes file path not provided');
			process.exit(1);
		}
		if (!fs.existsSync(filePath)) {
			console.error('   ❌ Notes file not found:', filePath);
			process.exit(1);
		}
		
		console.log('   => Parsing notes XML file (streaming mode for large file)...');
		
		// Map pour stocker les comptages par date: Map<dateString, {open: number, closed: number}>
		const notesByDate = new Map();
		const notesByBoundary = new Map(); // Map<boundaryId, Map<dateString, {open: number, closed: number}>>
		const allNotes = []; // Stocker toutes les notes pour traitement par zone
		let buffer = '';
		let inNote = false;
		let currentNote = null;
		let noteDepth = 0;
		
		// Lire le fichier par chunks pour éviter de charger tout en mémoire
		const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 }); // 64KB chunks
		
		// Fonction pour extraire une date au format YYYY-MM-DD depuis un timestamp ISO
		function extractDate(isoString) {
			if (!isoString) return null;
			return isoString.split('T')[0];
		}
		
		// Fonction pour obtenir toutes les dates entre deux dates (incluses)
		function getDatesBetween(startDate, endDate) {
			const dates = [];
			const start = new Date(startDate);
			const end = new Date(endDate);
			const current = new Date(start);
			
			while (current <= end) {
				dates.push(current.toISOString().split('T')[0]);
				current.setDate(current.getDate() + 1);
			}
			return dates;
		}
		
		// Fonction pour traiter une note complète
		function processNote(note) {
			const lat = parseFloat(note.lat);
			const lon = parseFloat(note.lon);
			
			// Vérifier si la note est dans la bbox de la France
			if (isNaN(lat) || isNaN(lon) || lat < 41.0 || lat > 51.0 || lon < 2.0 || lon > 8.0) {
				return;
			}
			
			const createdDate = extractDate(note.created_at);
			const closedDate = extractDate(note.closed_at);
			const isClosed = !!closedDate;
			const today = new Date().toISOString().split('T')[0];
			
			if (!createdDate) {
				return; // Pas de date de création, ignorer
			}
			
			// Déterminer la période de vie de la note
			const endDate = closedDate || today;
			const dates = getDatesBetween(createdDate, endDate);
			
			// Pour chaque date, compter la note comme ouverte ou fermée
			dates.forEach(date => {
				if (!notesByDate.has(date)) {
					notesByDate.set(date, { open: 0, closed: 0 });
				}
				const counts = notesByDate.get(date);
				
				if (isClosed && date >= closedDate) {
					// Note fermée à partir de la date de fermeture
					counts.closed++;
				} else {
					// Note ouverte avant la date de fermeture (ou jamais fermée)
					counts.open++;
				}
			});
			
			// Stocker la note pour traitement par zone
			allNotes.push({
				lat,
				lon,
				createdDate,
				closedDate,
				isClosed
			});
		}
		
		await new Promise((resolve, reject) => {
			stream.on('data', (chunk) => {
				buffer += chunk;
				
				// Parser le XML de manière plus robuste pour capturer les balises complètes
				let pos = 0;
				while (pos < buffer.length) {
					if (!inNote) {
						// Chercher le début d'une balise <note>
						const noteStart = buffer.indexOf('<note', pos);
						if (noteStart === -1) {
							// Plus de balises <note>, garder le reste du buffer
							buffer = buffer.substring(pos);
							break;
						}
						
						// Extraire les attributs de la balise <note>
						const tagEnd = buffer.indexOf('>', noteStart);
						if (tagEnd === -1) {
							// La balise n'est pas complète, garder le reste pour le prochain chunk
							buffer = buffer.substring(noteStart);
							break;
						}
						
						const noteTag = buffer.substring(noteStart, tagEnd + 1);
						
						// Extraire tous les attributs
						const latMatch = noteTag.match(/lat="([^"]*)"/);
						const lonMatch = noteTag.match(/lon="([^"]*)"/);
						const createdMatch = noteTag.match(/created_at="([^"]*)"/);
						const closedMatch = noteTag.match(/closed_at="([^"]*)"/);
						
						if (latMatch && lonMatch && createdMatch) {
							currentNote = {
								lat: latMatch[1],
								lon: lonMatch[1],
								created_at: createdMatch[1],
								closed_at: closedMatch ? closedMatch[1] : null
							};
							inNote = true;
							noteDepth = 1;
							pos = tagEnd + 1;
							
							// Vérifier si c'est une balise auto-fermante
							if (noteTag.endsWith('/>')) {
								// Note complète, traiter immédiatement
								processNote(currentNote);
								currentNote = null;
								inNote = false;
								noteDepth = 0;
							}
						} else {
							pos = tagEnd + 1;
						}
					} else {
						// On est dans une note, chercher la balise de fermeture </note>
						const closeTag = buffer.indexOf('</note>', pos);
						if (closeTag === -1) {
							// La balise de fermeture n'est pas dans ce chunk
							buffer = buffer.substring(pos);
							break;
						}
						
						// Note complète, traiter
						if (currentNote) {
							processNote(currentNote);
							currentNote = null;
						}
						
						inNote = false;
						noteDepth = 0;
						pos = closeTag + 7; // 7 = longueur de '</note>'
					}
				}
				
				// Si on n'a pas trouvé de balise complète, garder le reste
				if (pos >= buffer.length) {
					buffer = '';
				}
			});
			
			stream.on('end', () => {
				// Traiter la dernière note si elle est incomplète
				if (currentNote && inNote) {
					processNote(currentNote);
				}
				resolve();
			});
			
			stream.on('error', (err) => {
				reject(err);
			});
		});
		
		console.log(\`   => Found notes across \${notesByDate.size} different dates\`);
		
		// #region agent log
		const LOG_FILE = '/tmp/pdm/.cursor/debug.log';
		const logDir = require('path').dirname(LOG_FILE);
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}
		const dateKeys = Array.from(notesByDate.keys()).sort();
		fs.appendFileSync(LOG_FILE, JSON.stringify({location:'40_global_stats_update.js:363',message:'before inserting dates',data:{totalDates:notesByDate.size,firstDate:dateKeys[0],lastDate:dateKeys[dateKeys.length-1],sampleDates:dateKeys.slice(0,10)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'}) + '\\n');
		// #endregion agent log
		
		// Insérer les comptages par date dans la base de données (global)
		console.log('   => Inserting note counts by date into database...');
		const dateInserts = [];
		let dateInsertCount = 0;
		for (const [date, counts] of notesByDate.entries()) {
			dateInsertCount++;
			if (dateInsertCount <= 10 || dateInsertCount % 100 === 0) {
				// #region agent log
				fs.appendFileSync(LOG_FILE, JSON.stringify({location:'40_global_stats_update.js:369',message:'inserting date',data:{date,open:counts.open,closed:counts.closed,index:dateInsertCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'}) + '\\n');
				// #endregion agent log
			}
			dateInserts.push(
				pool.query(
					\`INSERT INTO pdm_note_counts_global (ts, open, closed) VALUES (\$1, \$2, \$3) ON CONFLICT (ts) DO UPDATE SET open = EXCLUDED.open, closed = EXCLUDED.closed\`,
					[\`\${date}T23:59:59Z\`, counts.open, counts.closed]
				)
			);
		}
		await Promise.all(dateInserts);
		// #region agent log
		fs.appendFileSync(LOG_FILE, JSON.stringify({location:'40_global_stats_update.js:376',message:'after inserting dates',data:{insertedCount:dateInserts.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'}) + '\\n');
		// #endregion agent log
		console.log(\`   => Inserted/updated \${dateInserts.length} date entries\`);
		
		// Traiter les notes par zone si pdm_boundary existe
		console.log('   => Processing notes by boundary...');
		const boundaryCheck = await pool.query(
			\`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pdm_boundary') AS exists\`
		);
		
		if (boundaryCheck.rows[0] && boundaryCheck.rows[0].exists) {
			// Créer une table temporaire pour les notes
			await pool.query(\`
				CREATE TEMP TABLE temp_notes (
					lat FLOAT NOT NULL,
					lon FLOAT NOT NULL,
					is_closed BOOLEAN NOT NULL
				)
			\`);
			
			// Insérer les notes dans la table temporaire par batch
			const batchSize = 1000;
			const notesArray = Array.from(notesByBoundary.values());
			const boundaryCounts = new Map(); // Map<boundaryId, {open: number, closed: number}>
			
			for (let i = 0; i < notesArray.length; i += batchSize) {
				const batch = notesArray.slice(i, i + batchSize);
				const values = batch.map(note => 
					\`(\${note.lat}, \${note.lon}, \${note.isClosed})\`
				).join(', ');
				
				await pool.query(\`
					INSERT INTO temp_notes (lat, lon, is_closed) 
					VALUES \${values}
				\`);
			}
			
			// Trouver les zones pour chaque note
			// On cherche les zones de niveau administratif 4, 6 et 8 (régions, départements, communes)
			// On prend la zone la plus spécifique (admin_level le plus élevé)
			const result = await pool.query(\`
				WITH notes_with_boundaries AS (
					SELECT DISTINCT ON (tn.lat, tn.lon)
						tn.lat,
						tn.lon,
						tn.is_closed,
						b.osm_id AS boundary_id
					FROM temp_notes tn
					CROSS JOIN LATERAL (
						SELECT osm_id, admin_level
						FROM pdm_boundary
						WHERE admin_level IN (4, 6, 8)
							AND ST_Within(
								ST_SetSRID(ST_MakePoint(tn.lon, tn.lat), 4326),
								ST_Transform(geom, 4326)
							)
						ORDER BY admin_level DESC
						LIMIT 1
					) b
				)
				SELECT boundary_id, is_closed, COUNT(*) as count
				FROM notes_with_boundaries
				WHERE boundary_id IS NOT NULL
				GROUP BY boundary_id, is_closed
			\`);
			
			// Agréger les résultats
			for (const row of result.rows) {
				const boundaryId = parseInt(row.boundary_id);
				if (!boundaryCounts.has(boundaryId)) {
					boundaryCounts.set(boundaryId, { open: 0, closed: 0 });
				}
				const counts = boundaryCounts.get(boundaryId);
				if (row.is_closed) {
					counts.closed += parseInt(row.count);
				} else {
					counts.open += parseInt(row.count);
				}
			}
			
			// Nettoyer la table temporaire
			await pool.query(\`DROP TABLE IF EXISTS temp_notes\`);
			
			// Insérer les comptages par zone dans la base de données
			if (boundaryCounts.size > 0) {
				const insertPromises = [];
				for (const [boundaryId, counts] of boundaryCounts.entries()) {
					insertPromises.push(
						pool.query(
							\`INSERT INTO pdm_note_counts_per_boundary (boundary, ts, open, closed) 
							VALUES (\$1, \$2, \$3, \$4) 
							ON CONFLICT (boundary, ts) 
							DO UPDATE SET open = EXCLUDED.open, closed = EXCLUDED.closed\`,
							[boundaryId, \`\${currentDate}T23:59:59Z\`, counts.open, counts.closed]
						)
					);
				}
				await Promise.all(insertPromises);
				console.log(\`   => Notes counts saved for \${boundaryCounts.size} boundaries\`);
			} else {
				console.log('   ⚠️  No notes matched to boundaries');
			}
		} else {
			console.log('   ℹ️  pdm_boundary table not found, skipping boundary-based processing');
		}
		
		console.log('   => Notes counts saved to database');
		await pool.end();
		process.exit(0);
	} catch (error) {
		console.error('   ❌ Error processing notes:', error.message);
		process.exit(1);
	}
}

processNotes();
NODEJS

	# Enregistrer le timestamp du parsing après un parsing réussi
	echo "$(date +%s)" > "$NOTES_PARSE_TIMESTAMP_FILE"
	echo "   => Notes parsing completed, timestamp saved"
fi

# Nettoyer les fichiers temporaires (garder le dump compressé pour éviter de le retélécharger)
# Ne supprimer le fichier décompressé que s'il a plus de 24h pour éviter de le recréer à chaque exécution
# #region agent log
LOG_FILE="/tmp/pdm/.cursor/debug.log"
touch "$LOG_FILE" 2>/dev/null || true

if [ -f "$NOTES_DUMP_XML" ]; then
	XML_FILE_AGE=$(($(date +%s) - $(stat -c %Y "$NOTES_DUMP_XML" 2>/dev/null || echo 0)))
	if [ $XML_FILE_AGE -gt 86400 ]; then
		echo "{\"location\":\"40_global_stats_update.js:536\",\"message\":\"removing old decompressed file\",\"data\":{\"file\":\"$NOTES_DUMP_XML\",\"ageHours\":$((XML_FILE_AGE / 3600))},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
		rm -f "$NOTES_DUMP_XML"
	else
		echo "{\"location\":\"40_global_stats_update.js:536\",\"message\":\"keeping decompressed file\",\"data\":{\"file\":\"$NOTES_DUMP_XML\",\"ageHours\":$((XML_FILE_AGE / 3600))},\"timestamp\":$(date +%s000),\"sessionId\":\"debug-session\",\"runId\":\"run1\",\"hypothesisId\":\"A\"}" >> "$LOG_FILE"
	fi
fi
# #endregion agent log
`;

// Itinéraires de randonnée - extraire depuis le fichier OSH
const OSH_UPDATED = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.osh.pbf");
script += `
echo ""
echo "== Hiking routes statistics"
echo "   => Extracting hiking routes from OSH file..."

# Vérifier que le fichier OSH existe
OSH_FILE="${OSH_UPDATED}"
if [ ! -f "$OSH_FILE" ]; then
	echo "   ⚠️  OSH file not found: $OSH_FILE"
	echo "   ⚠️  Skipping hiking routes extraction. Run update_pbf first."
else

# Extraire les relations de type=route et route=hiking depuis le fichier OSH
TMP_RELATIONS_DIR="${CONFIG.WORK_DIR}"
mkdir -p "$TMP_RELATIONS_DIR"
TMP_RELATIONS="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}.json"

echo "   => Extracting relations from OSH file (this may take a while)..."
TMP_FILTERED="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_filtered.osm.pbf"
TMP_SORTED="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_sorted.osm.pbf"

# Bbox des Alpes françaises (Ouest, Sud, Est, Nord)
# Approximation: 5.0, 44.0, 7.5, 46.5
ALPS_BBOX="5.0,44.0,7.5,46.5"

# Extraire les relations avec type=route ET route=hiking
# La syntaxe osmium tags-filter : r/ pour relations, puis les tags séparés
# Pour avoir type=route ET route=hiking, on utilise deux filtres séparés
echo "   => Filtering hiking routes by tags..."
if ! osmium tags-filter "$OSH_FILE" r/type=route r/route=hiking -o "$TMP_FILTERED" --overwrite 2>&1; then
	echo "   ⚠️  Error extracting relations from OSH file"
	rm -f "$TMP_FILTERED" "$TMP_SORTED"
	exit 1
fi

# Vérifier que le fichier filtré contient bien des données
if [ ! -f "$TMP_FILTERED" ] || [ ! -s "$TMP_FILTERED" ]; then
	echo "   ⚠️  Filtered file is empty or missing. No relations with type=route and route=hiking found."
	rm -f "$TMP_FILTERED" "$TMP_SORTED"
	exit 0
fi

# Convertir le fichier OSH filtré en OSM (dernière version) avant extraction par bbox
# Cela évite le problème de tri et réduit la taille du fichier
echo "   => Converting OSH to OSM (latest version)..."
TMP_OSM_BEFORE_BBOX="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_before_bbox.osm.pbf"
future_date=$(date -u -d "+10 years" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-12-31T23:59:59Z")
if ! osmium time-filter "$TMP_FILTERED" "$future_date" -O -o "$TMP_OSM_BEFORE_BBOX" -f osm.pbf 2>&1; then
	echo "   ⚠️  Error converting OSH to OSM"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_RELATIONS"
	exit 1
fi

# Extraire uniquement les relations dans la bbox des Alpes françaises
# Utiliser complete_ways pour inclure les ways complètes qui traversent la bbox
echo "   => Extracting relations within French Alps bbox ($ALPS_BBOX)..."
TMP_OSM="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_latest.osm.pbf"
if ! osmium extract --bbox "$ALPS_BBOX" -s complete_ways "$TMP_OSM_BEFORE_BBOX" -o "$TMP_OSM" --overwrite 2>&1; then
	echo "   ⚠️  Error extracting by bbox"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_RELATIONS"
	exit 1
fi

# Vérifier d'abord si le fichier filtré par bbox contient des relations
# Utiliser osmium fileinfo pour vérifier le contenu
RELATION_COUNT=$(osmium fileinfo "$TMP_OSM" --extended --no-progress 2>/dev/null | grep -i "relation" | grep -oE '[0-9]+' | head -1 || echo "0")
if [ "$RELATION_COUNT" = "0" ] || [ -z "$RELATION_COUNT" ]; then
	echo "   ⚠️  No relations found in bbox-filtered file (type=route and route=hiking in French Alps)"
	echo "   ℹ️  This is normal if there are no hiking routes in the French Alps region"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_SORTED"
	exit 0
fi
echo "   => Found $RELATION_COUNT relations in French Alps bbox"

# Convertir le PBF OSM en JSON pour traitement
echo "   => Converting to JSON format (this may take a while)..."
if ! osmium export "$TMP_OSM" -o "$TMP_RELATIONS" --overwrite 2>&1; then
	echo "   ⚠️  Error converting PBF to JSON"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_RELATIONS"
	exit 1
fi

# Vérifier que le fichier JSON existe et n'est pas vide
if [ ! -f "$TMP_RELATIONS" ] || [ ! -s "$TMP_RELATIONS" ]; then
	echo "   ⚠️  JSON file is empty or missing"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_SORTED" "$TMP_RELATIONS"
	exit 0
fi

# Compter les relations dans le fichier JSON (format osmium export)
ELEMENT_COUNT=$(grep -o '"type":"relation"' "$TMP_RELATIONS" 2>/dev/null | wc -l || echo "0")
if [ "$ELEMENT_COUNT" = "0" ]; then
	# Essayer un autre format de comptage (peut-être que le format JSON est différent)
	ELEMENT_COUNT=$(grep -c '"type": "relation"' "$TMP_RELATIONS" 2>/dev/null || echo "0")
fi
if [ "$ELEMENT_COUNT" = "0" ]; then
	echo "   ⚠️  No relations found in JSON file (format may be different)"
	echo "   ℹ️  File size: $(wc -c < "$TMP_RELATIONS" 2>/dev/null || echo 0) bytes"
	rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_SORTED" "$TMP_RELATIONS"
	exit 0
fi
echo "   => Found $ELEMENT_COUNT relations in JSON file"

# Utiliser Node.js pour traiter les relations et leurs membres
node - "$TMP_RELATIONS" <<'NODEJS'
const fs = require('fs');
const { Pool } = require('pg');
const DB_URL = process.env.DB_URL || '${DB_URL}';
const pool = new Pool({ connectionString: DB_URL });

async function processHikingRoutes() {
	try {
		const filePath = process.argv[2];
		if (!filePath || filePath === 'undefined') {
			console.error('   ❌ Relations file path not provided');
			process.exit(1);
		}
		if (!fs.existsSync(filePath)) {
			console.error('   ❌ Relations file not found:', filePath);
			process.exit(1);
		}
		
		// Traitement en streaming avec traitement par chunks
		// Utiliser un buffer et parser les objets JSON au fur et à mesure
		const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
		
		let buffer = '';
		let braceDepth = 0;
		let inString = false;
		let escapeNext = false;
		let currentObj = '';
		let relations = [];
		let relationCount = 0;
		
		await new Promise((resolve, reject) => {
			stream.on('data', (chunk) => {
				buffer += chunk;
				
				for (let i = 0; i < buffer.length; i++) {
					const char = buffer[i];
					
					if (escapeNext) {
						currentObj += char;
						escapeNext = false;
						continue;
					}
					
					if (char === '\\\\') {
						escapeNext = true;
						currentObj += char;
						continue;
					}
					
					if (char === '"' && !escapeNext) {
						inString = !inString;
						currentObj += char;
						continue;
					}
					
					if (inString) {
						currentObj += char;
						continue;
					}
					
					if (char === '{') {
						if (braceDepth === 0) {
							currentObj = '{';
						} else {
							currentObj += char;
						}
						braceDepth++;
					} else if (char === '}') {
						currentObj += char;
						braceDepth--;
						
						if (braceDepth === 0) {
							try {
								const obj = JSON.parse(currentObj);
								if (obj.type === 'relation') {
									relations.push(obj);
									relationCount++;
									if (relationCount % 100 === 0) {
										console.log(\`   => Processing... \${relationCount} relations found so far\`);
									}
									// Traiter immédiatement si on a assez de relations pour éviter la surcharge mémoire
									if (relations.length >= 50) {
										processBatch(relations);
										relations = [];
									}
								}
							} catch (e) {
								// Ignorer les erreurs de parsing
							}
							currentObj = '';
						}
					} else if (braceDepth > 0) {
						currentObj += char;
					}
				}
				
				// Garder seulement la partie non traitée du buffer
				if (braceDepth === 0) {
					buffer = '';
				} else {
					// Garder la partie en cours de traitement
					buffer = currentObj;
					currentObj = '';
				}
			});
			
			stream.on('end', () => {
				resolve();
			});
			
			stream.on('error', (err) => {
				reject(err);
			});
		});
		
		// Traiter les dernières relations
		if (relations.length > 0) {
			processBatch(relations);
		}
		
		if (relationCount === 0) {
			console.log('   ⚠️  No relations found in file');
			await pool.end();
			process.exit(0);
		}
		
		console.log(\`   => Found \${relationCount} hiking routes total\`);
		
		const today = new Date().toISOString().split('T')[0] + 'T23:59:59Z';
		let processed = 0;
		let errors = 0;
		
		async function processBatch(relationsBatch) {
			for (const rel of relationsBatch) {
			try {
				const osmId = rel.id;
				const name = rel.tags?.name || null;
				const tags = JSON.stringify(rel.tags || {});
				const members = rel.members || [];
				const memberCount = members.length;
				
				// Insérer ou mettre à jour la relation
				await pool.query(\`
					INSERT INTO pdm_relation_hiking (osm_id, name, tags, created_at)
					VALUES (\$1, \$2, \$3::jsonb, NOW())
					ON CONFLICT (osm_id) DO UPDATE SET
						name = EXCLUDED.name,
						tags = EXCLUDED.tags
				\`, [osmId, name, tags]);
				
				// Insérer le décompte de membres pour aujourd'hui
				// Note: changeset_id, username, userid ne sont pas disponibles directement depuis osmium export
				// On les laisse NULL pour l'instant, ils seront mis à jour lors des mises à jour via l'API OSM
				await pool.query(\`
					INSERT INTO pdm_relation_hiking_members (relation_id, ts, member_count, changeset_id, username, userid)
					VALUES (\$1, \$2, \$3, NULL, NULL, NULL)
					ON CONFLICT (relation_id, ts) DO UPDATE SET
						member_count = EXCLUDED.member_count
				\`, [osmId, today, memberCount]);
				
				processed++;
			} catch (relError) {
				console.error(\`   ⚠️  Error processing relation \${rel.id}: \${relError.message}\`);
				errors++;
			}
			}
		}
		
		console.log(\`   => Processed \${relationCount} hiking routes successfully\`);
		if (errors > 0) {
			console.log(\`   ⚠️  \${errors} relations had errors\`);
		}
		
		await pool.end();
		process.exit(0);
	} catch (error) {
		console.error('   ❌ Error processing hiking routes:', error.message);
		console.error(error.stack);
		process.exit(1);
	}
}

processHikingRoutes();
NODEJS

# Nettoyer les fichiers temporaires
rm -f "$TMP_FILTERED" "$TMP_OSM_BEFORE_BBOX" "$TMP_OSM" "$TMP_RELATIONS"
fi
`;

script += `
echo ""
echo "== Global statistics update completed"

# Mettre à jour le timestamp du parsing de notes à la fin de l'exécution
# Cela indique que le script a été exécuté, même si le parsing a été sauté
# Utiliser le même WORK_DIR que défini au début du script
NOTES_PARSE_TIMESTAMP_FILE="$TMP_NOTES_DIR/.notes_parse_timestamp"
mkdir -p "$TMP_NOTES_DIR"
echo "$(date +%s)" > "$NOTES_PARSE_TIMESTAMP_FILE"
echo "   => Notes parse timestamp updated at end of execution"
`;

// Créer le répertoire si nécessaire
const outputDir = require('path').dirname(OUTPUT_SCRIPT);
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(OUTPUT_SCRIPT, script);
fs.chmodSync(OUTPUT_SCRIPT, '755');

console.log(`Update script generated: ${OUTPUT_SCRIPT}`);
console.log("Uninstall script: N/A (no uninstall needed for global stats)");

