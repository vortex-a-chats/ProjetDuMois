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

# Télécharger le dump de notes (seulement si plus récent ou absent)
if [ ! -f "$NOTES_DUMP_FILE" ] || [ ! -s "$NOTES_DUMP_FILE" ]; then
	echo "   => Downloading notes dump (this may take a while)..."
	if ! wget -N -P "$TMP_NOTES_DIR" "$NOTES_DUMP_URL" 2>&1; then
		echo "   ⚠️  Error downloading notes dump"
		exit 1
	fi
else
	echo "   => Using existing notes dump file"
fi

# Décompresser le dump avec Python (bz2 est intégré dans Python)
if [ ! -f "$NOTES_DUMP_XML" ] || [ "$NOTES_DUMP_FILE" -nt "$NOTES_DUMP_XML" ]; then
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
		
		let notesOpen = 0;
		let notesClosed = 0;
		let buffer = '';
		let inNoteTag = false;
		let currentNoteTag = '';
		
		// Lire le fichier par chunks pour éviter de charger tout en mémoire
		const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 }); // 64KB chunks
		
		await new Promise((resolve, reject) => {
			stream.on('data', (chunk) => {
				buffer += chunk;
				
				// Chercher les balises <note> dans le buffer
				let noteStart = buffer.indexOf('<note');
				while (noteStart !== -1) {
					// Trouver la fin de la balise <note>
					const noteEnd = buffer.indexOf('>', noteStart);
					if (noteEnd === -1) {
						// La balise n'est pas complète, garder le reste pour le prochain chunk
						buffer = buffer.substring(noteStart);
						break;
					}
					
					const noteTag = buffer.substring(noteStart, noteEnd + 1);
					
					// Extraire lat et lon des attributs
					const latMatch = noteTag.match(/lat="([^"]*)"/);
					const lonMatch = noteTag.match(/lon="([^"]*)"/);
					
					if (latMatch && lonMatch) {
						const lat = parseFloat(latMatch[1]);
						const lon = parseFloat(lonMatch[1]);
						
						// Vérifier si la note est dans la bbox de la France
						if (!isNaN(lat) && !isNaN(lon) && lat >= 41.0 && lat <= 51.0 && lon >= 2.0 && lon <= 8.0) {
							// Vérifier le statut (closed si closed_at existe dans les attributs)
							if (noteTag.includes('closed_at="')) {
								notesClosed++;
							} else {
								notesOpen++;
							}
						}
					}
					
					// Chercher la prochaine balise <note>
					buffer = buffer.substring(noteEnd + 1);
					noteStart = buffer.indexOf('<note');
				}
			});
			
			stream.on('end', () => {
				resolve();
			});
			
			stream.on('error', (err) => {
				reject(err);
			});
		});
		
		console.log(\`   => Found \${notesOpen} open notes and \${notesClosed} closed notes\`);
		
		// Insérer dans la base de données
		const currentDate = process.argv[3];
		await pool.query(
			\`INSERT INTO pdm_note_counts_global (ts, open, closed) VALUES (\$1, \$2, \$3) ON CONFLICT (ts) DO UPDATE SET open = EXCLUDED.open, closed = EXCLUDED.closed\`,
			[\`\${currentDate}T23:59:59Z\`, notesOpen, notesClosed]
		);
		
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

# Nettoyer les fichiers temporaires (garder le dump compressé pour éviter de le retélécharger)
rm -f "$NOTES_DUMP_XML"
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
	exit 0
fi

# Extraire les relations de type=route et route=hiking depuis le fichier OSH
TMP_RELATIONS_DIR="${CONFIG.WORK_DIR}"
mkdir -p "$TMP_RELATIONS_DIR"
TMP_RELATIONS="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}.json"

echo "   => Extracting relations from OSH file (this may take a while)..."
TMP_FILTERED="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_filtered.osm.pbf"
TMP_SORTED="$TMP_RELATIONS_DIR/hiking_relations_\${CURRENT_DATE}_sorted.osm.pbf"

if ! osmium tags-filter "$OSH_FILE" r/type=route,route=hiking -o "$TMP_FILTERED" --overwrite 2>&1; then
	echo "   ⚠️  Error extracting relations from OSH file"
	rm -f "$TMP_FILTERED" "$TMP_SORTED"
	exit 1
fi

# Trier le fichier pour qu'il soit dans le bon ordre (nodes, ways, relations)
echo "   => Sorting relations file..."
if ! osmium sort "$TMP_FILTERED" -o "$TMP_SORTED" --overwrite 2>&1; then
	echo "   ⚠️  Error sorting relations file"
	rm -f "$TMP_FILTERED" "$TMP_SORTED"
	exit 1
fi

# Convertir le PBF trié en JSON pour traitement
if ! osmium export "$TMP_SORTED" -o "$TMP_RELATIONS" --overwrite 2>&1; then
	echo "   ⚠️  Error converting PBF to JSON"
	rm -f "$TMP_FILTERED" "$TMP_SORTED" "$TMP_RELATIONS"
	exit 1
fi

# Vérifier que le fichier existe et n'est pas vide
if [ ! -f "$TMP_RELATIONS" ] || [ ! -s "$TMP_RELATIONS" ]; then
	echo "   ⚠️  No relations extracted from OSH file"
	rm -f "$TMP_FILTERED" "$TMP_SORTED" "$TMP_RELATIONS"
	exit 0
fi

# Compter les relations dans le fichier
ELEMENT_COUNT=$(grep -o '"type":"relation"' "$TMP_RELATIONS" 2>/dev/null | wc -l || echo "0")
if [ "$ELEMENT_COUNT" = "0" ]; then
	echo "   ⚠️  No relations found in OSH file"
	rm -f "$TMP_FILTERED" "$TMP_SORTED" "$TMP_RELATIONS"
	exit 0
fi
echo "   => Found $ELEMENT_COUNT relations in OSH file"

# Utiliser Node.js pour traiter les relations et leurs membres
node - <<'NODEJS'
const fs = require('fs');
const { Pool } = require('pg');
const DB_URL = process.env.DB_URL || '${DB_URL}';
const pool = new Pool({ connectionString: DB_URL });

async function processHikingRoutes() {
	try {
		const filePath = process.argv[2];
		if (!fs.existsSync(filePath)) {
			console.error('   ❌ Relations file not found:', filePath);
			process.exit(1);
		}
		
		const fileContent = fs.readFileSync(filePath, 'utf8');
		if (!fileContent || fileContent.trim().length === 0) {
			console.error('   ❌ Relations file is empty');
			process.exit(1);
		}
		
		let data;
		try {
			data = JSON.parse(fileContent);
		} catch (parseError) {
			console.error('   ❌ Failed to parse JSON from Overpass response:', parseError.message);
			console.error('   First 200 chars of response:', fileContent.substring(0, 200));
			process.exit(1);
		}
		
		const relations = (data.elements || []).filter(el => el.type === 'relation');
		
		if (relations.length === 0) {
			console.log('   ⚠️  No relations found in response');
			await pool.end();
			process.exit(0);
		}
		
		console.log(\`   => Found \${relations.length} hiking routes to process\`);
		
		const today = new Date().toISOString().split('T')[0] + 'T23:59:59Z';
		let processed = 0;
		let errors = 0;
		
		for (const rel of relations) {
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
				// Note: changeset_id, username, userid ne sont pas disponibles directement depuis Overpass
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
		
		console.log(\`   => Processed \${processed} hiking routes successfully\`);
		if (errors > 0) {
			console.log(\`   ⚠️  \${errors} relations had errors\`);
		}
		
		await pool.end();
	} catch (error) {
		console.error('   ❌ Error processing hiking routes:', error.message);
		console.error(error.stack);
		process.exit(1);
	}
}

processHikingRoutes();
NODEJS
	"$TMP_RELATIONS"
	
	rm -f "$TMP_FILTERED" "$TMP_SORTED" "$TMP_RELATIONS"
fi
`;

script += `
echo ""
echo "== Global statistics update completed"
`;

fs.writeFileSync(OUTPUT_SCRIPT, script);
fs.chmodSync(OUTPUT_SCRIPT, '755');

console.log(`Update script generated: ${OUTPUT_SCRIPT}`);
console.log("Uninstall script: N/A (no uninstall needed for global stats)");

