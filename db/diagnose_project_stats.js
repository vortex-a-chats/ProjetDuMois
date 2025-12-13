#!/usr/bin/env node

/**
 * Script de diagnostic pour vérifier pourquoi les statistiques d'un projet ne sont pas calculées
 * Usage: node db/diagnose_project_stats.js <project_id>
 */

const CONFIG = require('../config.json');
const projects = require('../website/projects');
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const projectId = process.argv[2];

if (!projectId) {
	console.error('Usage: node db/diagnose_project_stats.js <project_id>');
	process.exit(1);
}

if (!projects[projectId]) {
	console.error(`❌ Projet "${projectId}" introuvable.`);
	console.error(`Projets disponibles: ${Object.keys(projects).join(', ')}`);
	process.exit(1);
}

const project = projects[projectId];
const pool = new Pool({ connectionString: process.env.DB_URL || CONFIG.DB_URL });

async function diagnose() {
	console.log(`\n🔍 Diagnostic pour le projet: ${projectId}\n`);
	console.log('='.repeat(60));
	
	// 1. Vérifier la configuration du projet
	console.log('\n1️⃣  Configuration du projet:');
	console.log(`   - Titre: ${project.title}`);
	console.log(`   - Date de début: ${project.start_date}`);
	console.log(`   - Date de fin: ${project.end_date}`);
	console.log(`   - Filtre Osmium: ${project.database?.osmium_tag_filter || 'NON DÉFINI'}`);
	console.log(`   - Statistics.count: ${project.statistics?.count || false}`);
	
	if (!project.statistics?.count) {
		console.log('   ⚠️  ATTENTION: statistics.count est désactivé, les statistiques ne seront pas calculées!');
	}
	
	// 2. Vérifier dans la base de données
	console.log('\n2️⃣  Vérification dans la base de données:');
	try {
		const result = await pool.query(
			'SELECT COUNT(*) as count, MIN(ts) as first_ts, MAX(ts) as last_ts FROM pdm_feature_counts WHERE project = $1',
			[projectId]
		);
		const count = parseInt(result.rows[0].count);
		if (count === 0) {
			console.log('   ❌ Aucune statistique trouvée dans pdm_feature_counts');
		} else {
			console.log(`   ✅ ${count} enregistrement(s) trouvé(s)`);
			console.log(`   - Première date: ${result.rows[0].first_ts}`);
			console.log(`   - Dernière date: ${result.rows[0].last_ts}`);
		}
		
		// Vérifier le projet dans pdm_projects
		const projectResult = await pool.query(
			'SELECT * FROM pdm_projects WHERE project = $1',
			[projectId]
		);
		if (projectResult.rows.length === 0) {
			console.log('   ⚠️  Le projet n\'est pas enregistré dans pdm_projects');
		} else {
			console.log(`   ✅ Projet enregistré dans pdm_projects`);
			console.log(`   - lastupdate_date: ${projectResult.rows[0].lastupdate_date || 'NULL'}`);
		}
	} catch (err) {
		console.log(`   ❌ Erreur lors de la vérification: ${err.message}`);
	}
	
	// 3. Vérifier les fichiers OSH
	console.log('\n3️⃣  Vérification des fichiers OSH:');
	const OSH_UPDATED = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".latest.osh.pbf");
	const OSH_USEFULL = CONFIG.WORK_DIR + '/usefull.osh.pbf';
	const projectShortId = projectId.split("_").pop();
	const oshUsefull = OSH_USEFULL.replace("usefull", `${projectShortId}.usefull`);
	
	if (fs.existsSync(OSH_UPDATED)) {
		const stats = fs.statSync(OSH_UPDATED);
		console.log(`   ✅ ${OSH_UPDATED} existe (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
	} else {
		console.log(`   ❌ ${OSH_UPDATED} n'existe pas`);
		console.log('   ⚠️  Le fichier OSH doit être téléchargé et mis à jour avant de calculer les stats');
	}
	
	if (fs.existsSync(oshUsefull)) {
		const stats = fs.statSync(oshUsefull);
		console.log(`   ✅ ${oshUsefull} existe (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
	} else {
		console.log(`   ⚠️  ${oshUsefull} n'existe pas (sera créé lors de l'exécution du script)`);
	}
	
	// 4. Vérifier le script généré
	console.log('\n4️⃣  Vérification du script de mise à jour:');
	const scriptPath = CONFIG.WORK_DIR + '/31_projects_update_tmp.sh';
	if (fs.existsSync(scriptPath)) {
		console.log(`   ✅ Script trouvé: ${scriptPath}`);
		// Vérifier si le projet est dans le script
		const scriptContent = fs.readFileSync(scriptPath, 'utf8');
		if (scriptContent.includes(projectId)) {
			console.log(`   ✅ Le projet ${projectId} est présent dans le script`);
		} else {
			console.log(`   ⚠️  Le projet ${projectId} n'est PAS présent dans le script`);
		}
	} else {
		console.log(`   ⚠️  Script non trouvé: ${scriptPath}`);
		console.log('   💡 Exécutez: npm run projects:update pour générer le script');
	}
	
	// 5. Test du filtre osmium (si le fichier OSH existe)
	console.log('\n5️⃣  Test du filtre Osmium:');
	if (fs.existsSync(OSH_UPDATED) && project.database?.osmium_tag_filter) {
		try {
			const tagFilter = project.database.osmium_tag_filter;
			console.log(`   Test du filtre: ${tagFilter}`);
			
			// Créer un fichier temporaire pour le test
			const testFile = CONFIG.WORK_DIR + `/test_${projectShortId}.osm.pbf`;
			
			// Extraire avec le filtre
			try {
				execSync(`osmium tags-filter "${OSH_UPDATED}" -R ${tagFilter} -O -o "${testFile}" --no-progress 2>&1`, { 
					stdio: 'pipe',
					timeout: 30000 
				});
				
				if (fs.existsSync(testFile) && fs.statSync(testFile).size > 0) {
					// Compter les objets
					const countOutput = execSync(
						`osmium tags-count "${testFile}" --no-progress -F osm.pbf ${tagFilter.split("/").pop()} 2>&1 || echo "0"`,
						{ encoding: 'utf8', timeout: 10000 }
					);
					
					const count = countOutput.trim().split('\t')[0] || '0';
					console.log(`   ✅ Filtre fonctionne: ${count} objet(s) trouvé(s) dans le fichier OSH`);
					
					// Nettoyer
					fs.unlinkSync(testFile);
				} else {
					console.log(`   ⚠️  Fichier filtré vide ou inexistant`);
					if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
				}
			} catch (err) {
				console.log(`   ❌ Erreur lors du test du filtre: ${err.message}`);
				if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
			}
		} catch (err) {
			console.log(`   ⚠️  Impossible de tester le filtre: ${err.message}`);
		}
	} else {
		console.log('   ⚠️  Fichier OSH non disponible ou filtre non défini');
	}
	
	// 6. Recommandations
	console.log('\n6️⃣  Recommandations:');
	console.log('   Pour calculer les statistiques:');
	console.log('   1. Vérifiez que le fichier OSH est à jour:');
	console.log('      npm run pbf:update');
	console.log('   2. Générez le script de mise à jour:');
	console.log('      npm run projects:update');
	console.log('   3. Exécutez le script généré:');
	console.log(`      bash ${CONFIG.WORK_DIR}/31_projects_update_tmp.sh`);
	console.log('   Ou pour un projet spécifique:');
	console.log(`      node db/30_projects_update.js ${projectId}`);
	console.log(`      bash ${CONFIG.WORK_DIR}/31_projects_update_tmp.sh`);
	
	console.log('\n' + '='.repeat(60) + '\n');
	
	await pool.end();
}

diagnose().catch(err => {
	console.error('❌ Erreur:', err);
	process.exit(1);
});

