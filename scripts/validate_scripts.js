#!/usr/bin/env node

/**
 * Script de validation des scripts bash générés
 * Vérifie la syntaxe de tous les scripts *_tmp.sh générés
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Charger la config si elle existe
let WORK_DIR = '/tmp/pdm';
try {
	const CONFIG = require('../config.json');
	if (CONFIG.WORK_DIR) {
		WORK_DIR = CONFIG.WORK_DIR;
	}
} catch (error) {
	// Si config.json n'existe pas, utiliser la valeur par défaut
	console.log('⚠️  config.json non trouvé, utilisation de /tmp/pdm par défaut\n');
}

// Chemins des scripts à vérifier
const scriptPaths = [
	path.join(WORK_DIR, '11_pbf_update_tmp.sh'),
	path.join(WORK_DIR, '21_features_update_tmp.sh'),
	path.join(WORK_DIR, '31_projects_update_tmp.sh'),
	path.join(__dirname, '..', 'db', '11_pbf_update_tmp.sh'),
	path.join(__dirname, '..', 'db', '21_features_update_tmp.sh'),
	path.join(__dirname, '..', 'db', '31_projects_update_tmp.sh')
];

let errors = 0;
let validated = 0;

console.log('🔍 Validation des scripts bash générés...\n');

for (const scriptPath of scriptPaths) {
	// Normaliser le chemin pour éviter les problèmes
	const normalizedPath = path.resolve(scriptPath);
	const relativePath = path.relative(process.cwd(), normalizedPath);
	
	if (!fs.existsSync(normalizedPath)) {
		console.log(`⚠️  ${relativePath} - Fichier non trouvé (sera généré lors de l'exécution)`);
		continue;
	}
	
	// Vérifier que c'est un fichier (pas un répertoire)
	const stats = fs.statSync(normalizedPath);
	if (!stats.isFile()) {
		console.log(`⚠️  ${relativePath} - N'est pas un fichier`);
		continue;
	}
	
	try {
		// Vérifier la syntaxe avec bash -n (mode vérification sans exécution)
		execSync(`bash -n "${normalizedPath}"`, { 
			stdio: 'pipe',
			encoding: 'utf8',
			timeout: 5000
		});
		console.log(`✓ ${relativePath} - Syntaxe valide`);
		validated++;
	} catch (error) {
		console.error(`❌ ${relativePath} - Erreur de syntaxe:`);
		if (error.stdout && error.stdout.toString().trim()) {
			console.error(error.stdout.toString());
		}
		if (error.stderr && error.stderr.toString().trim()) {
			console.error(error.stderr.toString());
		}
		if (error.message && !error.message.includes('Command failed')) {
			console.error(error.message);
		}
		errors++;
	}
}

console.log('\n' + '='.repeat(50));
if (errors === 0) {
	console.log(`✅ Tous les scripts sont valides (${validated} fichier(s) vérifié(s))`);
	process.exit(0);
} else {
	console.error(`❌ ${errors} erreur(s) trouvée(s) sur ${validated + errors} fichier(s) vérifié(s)`);
	process.exit(1);
}

