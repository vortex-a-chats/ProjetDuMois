#!/usr/bin/env node

/**
 * Script pour définir le timestamp du dernier parsing de notes
 * à la date actuelle moins une minute
 */

const CONFIG = require('../config.json');
const fs = require('fs');
const path = require('path');

const WORK_DIR = CONFIG.WORK_DIR || '/tmp/pdm';
const TIMESTAMP_FILE = path.join(WORK_DIR, '.notes_parse_timestamp');

// Calculer le timestamp Unix (en secondes) pour il y a une minute
const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;

// Créer le répertoire s'il n'existe pas
if (!fs.existsSync(WORK_DIR)) {
	fs.mkdirSync(WORK_DIR, { recursive: true });
}

// Écrire le timestamp dans le fichier
fs.writeFileSync(TIMESTAMP_FILE, oneMinuteAgo.toString());

const dateStr = new Date(oneMinuteAgo * 1000).toISOString();
console.log(`✅ Timestamp du dernier parsing de notes mis à jour :`);
console.log(`   Fichier : ${TIMESTAMP_FILE}`);
console.log(`   Timestamp : ${oneMinuteAgo}`);
console.log(`   Date : ${dateStr} (il y a 1 minute)`);

