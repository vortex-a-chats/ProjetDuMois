/**
 * Script to download and process INSEE data (population and budgets)
 * for French municipalities and link them to OSM boundaries
 */

const CONFIG = require('../config.json');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
// Use csv-parse if available, otherwise use a simple CSV parser
let csv;
try {
	csv = require('csv-parse/sync');
} catch (e) {
	// Fallback: simple CSV parser
	csv = {
		parse: (content, options) => {
			const lines = content.split('\n').filter(l => l.trim());
			if (lines.length === 0) return [];
			const headers = lines[0].split(options.delimiter || ';');
			return lines.slice(1).map(line => {
				const values = line.split(options.delimiter || ';');
				const obj = {};
				headers.forEach((h, i) => {
					obj[h.trim()] = values[i] ? values[i].trim() : '';
				});
				return obj;
			});
		}
	};
}

// Détecter l'environnement et construire la DB_URL appropriée
let DB_URL = process.env.DB_URL || CONFIG.DB_URL;

// Si DB_URL contient "host" (connexion Docker), essayer de se connecter depuis l'hôte
if (DB_URL && DB_URL.includes('@host:')) {
	const { execSync } = require('child_process');
	
	// Essayer de détecter le port depuis docker-compose
	let postgresPort = process.env.POSTGRES_PORT;
	
	if (!postgresPort) {
		try {
			// Essayer de lire le port depuis docker-compose ps
			const output = execSync('docker-compose ps pgsqldb 2>/dev/null | grep -oP "0.0.0.0:\\K\\d+(?=->5432)" || echo ""', { encoding: 'utf8', timeout: 2000 });
			const portMatch = output.trim();
			if (portMatch) {
				postgresPort = portMatch;
			}
		} catch (e) {
			// Ignorer les erreurs
		}
	}
	
	// Par défaut, docker-compose utilise 5433
	postgresPort = postgresPort || '5433';
	
	// Utiliser les identifiants Docker par défaut (postgres:pgpassword) depuis l'hôte
	const dbUser = process.env.POSTGRES_USER || 'postgres';
	const dbPassword = process.env.POSTGRES_PASSWORD || 'pgpassword';
	const dbName = process.env.POSTGRES_DB || 'pdm';
	
	DB_URL = `postgres://${dbUser}:${dbPassword}@localhost:${postgresPort}/${dbName}`;
	console.log(`ℹ️  Connexion depuis l'hôte, utilisation de localhost:${postgresPort}`);
}

if (!DB_URL) {
	console.error('❌ DB_URL is not defined');
	process.exit(1);
}

const pool = new Pool({
	connectionString: DB_URL
});

// INSEE API endpoints and data sources
// Population data: use the latest population légale file from INSEE
// Format: CSV with columns CODEGEO (INSEE code) and POP (population)
// Note: URLs may change when INSEE publishes new data
// Try these URLs in order:
// 1. https://www.insee.fr/fr/statistiques/fichier/6683035/ensemble.csv (format complet)
// 2. https://www.insee.fr/fr/statistiques/6683035 (page principale, chercher le lien de téléchargement)
// 3. data.gouv.fr API for INSEE data
// URLs to try in order (may need to be updated when INSEE publishes new data)
// If all fail, you can manually download the file from:
// https://www.insee.fr/fr/statistiques/6683035 (chercher "Télécharger" ou "Download")
// and place it in WORK_DIR/insee/population.csv
// Alternative: search on data.gouv.fr for "population légale 2022"
const POPULATION_CSV_URLS = [
	// Try INSEE direct URLs first (may return 500 errors)
	'https://www.insee.fr/fr/statistiques/fichier/6683035/ensemble.csv',
	'https://www.insee.fr/fr/statistiques/fichier/6683035/base-cc-evol-struct-pop-2022.csv',
	// Note: If these fail, the script will provide instructions for manual download
];

// Budget data: use data.gouv.fr API or direct CSV files
// Note: Budget data may require authentication or different sources
// For now, we'll use a placeholder URL that can be updated
const BUDGET_CSV_URL = null; // To be configured based on available data sources

async function downloadFile(url, filePath) {
	console.log(`📥 Downloading ${url}...`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	const buffer = await response.buffer();
	fs.writeFileSync(filePath, buffer);
	console.log(`✓ Downloaded to ${filePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
}

async function downloadFileWithFallback(urls, filePath) {
	for (const url of urls) {
		try {
			// Handle data.gouv.fr API responses
			if (url.includes('data.gouv.fr/api')) {
				console.log(`   Fetching dataset info from ${url}...`);
				const apiResponse = await fetch(url);
				if (apiResponse.ok) {
					const apiData = await apiResponse.json();
					// Find CSV resource in the dataset
					if (apiData.resources && Array.isArray(apiData.resources)) {
						const csvResource = apiData.resources.find(r => 
							r.format === 'csv' || r.url.endsWith('.csv') || r.title.toLowerCase().includes('csv')
						);
						if (csvResource && csvResource.url) {
							console.log(`   Found CSV resource: ${csvResource.url}`);
							await downloadFile(csvResource.url, filePath);
						} else {
							throw new Error('No CSV resource found in dataset');
						}
					} else {
						throw new Error('Invalid API response format');
					}
				} else {
					throw new Error(`API returned ${apiResponse.status}`);
				}
			} else {
				await downloadFile(url, filePath);
			}
			
			// Verify file is not empty and contains data (not just metadata)
			const stats = fs.statSync(filePath);
			if (stats.size > 10000) { // At least 10KB (should contain many communes)
				// Quick check: verify it contains data lines, not just headers
				const content = fs.readFileSync(filePath, 'utf-8').substring(0, 5000);
				if (content.match(/\d{5}/)) { // Contains at least one 5-digit code (INSEE code)
					return true;
				} else {
					console.log(`⚠️  File doesn't seem to contain INSEE codes, trying next URL...`);
					fs.unlinkSync(filePath);
				}
			} else {
				console.log(`⚠️  File too small (${stats.size} bytes), trying next URL...`);
				fs.unlinkSync(filePath);
			}
		} catch (error) {
			console.log(`⚠️  Failed to download from ${url}: ${error.message}`);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
	}
	return false;
}

async function processPopulationData(filePath) {
	console.log('📊 Processing population data...');
	
	// Read CSV file
	let content = fs.readFileSync(filePath, 'utf-8');
	
	// Remove BOM if present
	if (content.charCodeAt(0) === 0xFEFF) {
		content = content.slice(1);
	}
	
	// Find the line with column headers (usually contains "CODEGEO" or similar)
	const lines = content.split('\n');
	let headerLineIndex = -1;
	
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].toUpperCase();
		if (line.includes('CODEGEO') || (line.includes('CODE') && line.includes('LIB'))) {
			headerLineIndex = i;
			break;
		}
	}
	
	if (headerLineIndex === -1) {
		console.error('❌ Could not find header line in CSV file');
		console.log('   First 10 lines:');
		lines.slice(0, 10).forEach((line, i) => console.log(`   ${i + 1}: ${line.substring(0, 80)}`));
		return [];
	}
	
	console.log(`   Found header at line ${headerLineIndex + 1}`);
	
	// Extract data starting from the header line
	const dataContent = lines.slice(headerLineIndex).join('\n');
	
	const records = csv.parse(dataContent, {
		columns: true,
		skip_empty_lines: true,
		delimiter: ';',
		skip_records_with_error: true,
		relax_column_count: true
	});
	
	const inseeData = [];
	
	for (const record of records) {
		// Extract INSEE code and population
		// Try various possible column names
		const inseeCode = record.CODGEO || record.Code || record['Code INSEE'] || record['Code commune INSEE'] || 
		                  record.CODE || record['CODE'] || record.code || record['code'];
		const population = parseInt(record.POP || record.Population || record['Population totale'] || record['PTOT'] || 
		                           record.POP_TOT || record['POP_TOT'] || record['POP'] || 
		                           record['2022'] || record['POP2022'] || '0');
		const name = record.LIBGEO || record.Nom || record['Nom de la commune'] || record['Nom'] || 
		             record.LIBELLE || record['LIBELLE'] || record.LIB || record['LIB'] || '';
		
		// INSEE code should be 5 digits (communes) or 3 digits (départements)
		// We focus on communes (5 digits)
		const codeStr = inseeCode ? inseeCode.toString().trim() : '';
		if (codeStr && /^\d{5}$/.test(codeStr) && population > 0) {
			inseeData.push({
				insee_code: codeStr,
				population: population,
				name: name.toString().trim()
			});
		}
	}
	
	console.log(`✓ Processed ${inseeData.length} municipalities`);
	if (inseeData.length === 0 && records.length > 0) {
		console.log(`⚠️  Warning: Found ${records.length} records but none matched the expected format`);
		if (records.length > 0) {
			console.log(`   Sample record keys: ${Object.keys(records[0] || {}).join(', ')}`);
			console.log(`   Sample record: ${JSON.stringify(records[0]).substring(0, 200)}`);
		}
	}
	return inseeData;
}

async function processBudgetData(filePath) {
	console.log('💰 Processing budget data...');
	
	// Budget data is more complex and may require different sources
	// For now, we'll create a placeholder structure
	// You may need to adapt this based on the actual budget data format
	
	const content = fs.readFileSync(filePath, 'utf-8');
	const records = csv.parse(content, {
		columns: true,
		skip_empty_lines: true,
		delimiter: ';'
	});
	
	const budgetData = [];
	
	for (const record of records) {
		const inseeCode = record.CODGEO || record.Code || record['Code INSEE'];
		const budget = parseInt(record.BUDGET || record['Budget total'] || record['Total des dépenses'] || '0');
		const year = parseInt(record.ANNEE || record.Year || new Date().getFullYear());
		
		if (inseeCode && budget > 0) {
			budgetData.push({
				insee_code: inseeCode,
				budget_total: budget,
				budget_year: year
			});
		}
	}
	
	console.log(`✓ Processed ${budgetData.length} budget records`);
	return budgetData;
}

async function updateDatabase(populationData, budgetData) {
	console.log('💾 Updating database...');
	
	const client = await pool.connect();
	
	try {
		await client.query('BEGIN');
		
		// Merge population and budget data
		const dataMap = new Map();
		
		// Add population data
		for (const item of populationData) {
			dataMap.set(item.insee_code, {
				insee_code: item.insee_code,
				name: item.name,
				population: item.population,
				budget_total: null,
				budget_year: null
			});
		}
		
		// Add budget data
		for (const item of budgetData) {
			if (dataMap.has(item.insee_code)) {
				dataMap.get(item.insee_code).budget_total = item.budget_total;
				dataMap.get(item.insee_code).budget_year = item.budget_year;
			} else {
				dataMap.set(item.insee_code, {
					insee_code: item.insee_code,
					name: '',
					population: null,
					budget_total: item.budget_total,
					budget_year: item.budget_year
				});
			}
		}
		
		// Insert or update INSEE data in batch to minimize database calls
		// Use COPY or batch INSERT for better performance
		const batchSize = 1000;
		const dataArray = Array.from(dataMap.values());
		
		for (let i = 0; i < dataArray.length; i += batchSize) {
			const batch = dataArray.slice(i, i + batchSize);
			const values = batch.map((data, idx) => {
				const base = idx * 5;
				return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, CURRENT_TIMESTAMP)`;
			}).join(', ');
			
			const params = batch.flatMap(data => [
				data.insee_code,
				data.name,
				data.population,
				data.budget_total,
				data.budget_year
			]);
			
			await client.query(`
				INSERT INTO pdm_insee_data (insee_code, name, population, budget_total, budget_year, last_update)
				VALUES ${values}
				ON CONFLICT (insee_code) DO UPDATE SET
					name = EXCLUDED.name,
					population = COALESCE(EXCLUDED.population, pdm_insee_data.population),
					budget_total = COALESCE(EXCLUDED.budget_total, pdm_insee_data.budget_total),
					budget_year = COALESCE(EXCLUDED.budget_year, pdm_insee_data.budget_year),
					last_update = CURRENT_TIMESTAMP
			`, params);
		}
		
		console.log(`✓ Inserted/updated ${dataArray.length} INSEE records in ${Math.ceil(dataArray.length / batchSize)} batches`);
		
		// Link boundaries to INSEE codes
		console.log('🔗 Linking boundaries to INSEE codes...');
		
		// Get all valid INSEE codes from our data in a single query
		const validInseeCodesResult = await client.query(`
			SELECT insee_code FROM pdm_insee_data
		`);
		const validInseeCodes = new Set(validInseeCodesResult.rows.map(r => r.insee_code));
		
		// Get boundaries with ref tag (which often contains INSEE code)
		const boundariesResult = await client.query(`
			SELECT osm_id, tags->>'ref' as ref, tags->>'ref:INSEE' as ref_insee, name, admin_level
			FROM pdm_boundary
			WHERE admin_level = 8
				AND (tags->>'ref' IS NOT NULL OR tags->>'ref:INSEE' IS NOT NULL)
		`);
		
		// Filter and prepare links in memory (no API calls)
		const linksToInsert = [];
		for (const boundary of boundariesResult.rows) {
			const inseeCode = boundary.ref_insee || boundary.ref;
			if (inseeCode && /^\d{5}$/.test(inseeCode) && validInseeCodes.has(inseeCode)) {
				linksToInsert.push({
					boundary_id: boundary.osm_id,
					insee_code: inseeCode
				});
			}
		}
		
		// Insert all links in batch to minimize database calls
		if (linksToInsert.length > 0) {
			const linkBatchSize = 1000;
			for (let i = 0; i < linksToInsert.length; i += linkBatchSize) {
				const batch = linksToInsert.slice(i, i + linkBatchSize);
				const values = batch.map((link, idx) => {
					const base = idx * 2;
					return `($${base + 1}, $${base + 2})`;
				}).join(', ');
				
				const params = batch.flatMap(link => [
					link.boundary_id,
					link.insee_code
				]);
				
				await client.query(`
					INSERT INTO pdm_boundary_insee (boundary_id, insee_code)
					VALUES ${values}
					ON CONFLICT (boundary_id, insee_code) DO NOTHING
				`, params);
			}
		}
		
		console.log(`✓ Linked ${linksToInsert.length} boundaries to INSEE codes in ${Math.ceil(linksToInsert.length / 1000)} batches`);
		
		await client.query('COMMIT');
		console.log('✓ Database updated successfully');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function main() {
	const workDir = CONFIG.WORK_DIR || '/tmp/pdm';
	const inseeDir = path.join(workDir, 'insee');
	
	// Create directory if it doesn't exist
	if (!fs.existsSync(inseeDir)) {
		fs.mkdirSync(inseeDir, { recursive: true });
	}
	
	const populationFile = path.join(inseeDir, 'population.csv');
	const budgetFile = path.join(inseeDir, 'budget.csv');
	
	try {
		// Download population data (only if file doesn't exist or is older than 30 days)
		// This minimizes API calls by reusing cached files
		let shouldDownloadPopulation = true;
		if (fs.existsSync(populationFile)) {
			const stats = fs.statSync(populationFile);
			const fileAge = Date.now() - stats.mtime.getTime();
			const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
			
			if (fileAge < maxAge && stats.size > 10000) {
				console.log(`ℹ️  Using existing population file (age: ${Math.floor(fileAge / (24 * 60 * 60 * 1000))} days old, size: ${(stats.size / 1024 / 1024).toFixed(2)} MB): ${populationFile}`);
				shouldDownloadPopulation = false;
			} else {
				if (stats.size <= 10000) {
					console.log(`ℹ️  Population file exists but is too small (${stats.size} bytes), will try to re-download`);
				} else {
					console.log(`ℹ️  Population file is older than 30 days, will try to re-download`);
				}
			}
		}
		
		if (shouldDownloadPopulation) {
			const downloaded = await downloadFileWithFallback(POPULATION_CSV_URLS, populationFile);
			if (!downloaded) {
				// If download failed, check if file exists (maybe manually placed)
				if (fs.existsSync(populationFile)) {
					const stats = fs.statSync(populationFile);
					if (stats.size > 10000) {
						console.log(`ℹ️  Using manually placed file: ${populationFile}`);
					} else {
						console.error(`❌ File exists but is too small (${stats.size} bytes)`);
						console.error(`   Please download the file manually from https://www.insee.fr/fr/statistiques/6683035`);
						console.error(`   and place it at: ${populationFile}`);
						throw new Error('Population file is too small or invalid');
					}
				} else {
					console.error(`\n❌ Failed to download population data from all available URLs.`);
					console.error(`\n📋 Instructions pour télécharger manuellement :`);
					console.error(`   1. Allez sur https://www.insee.fr/fr/statistiques/6683035`);
					console.error(`   2. Cherchez le lien "Télécharger" ou "Download" pour le fichier CSV`);
					console.error(`   3. Téléchargez le fichier et placez-le à : ${populationFile}`);
					console.error(`   4. Relancez la commande : npm run insee:update\n`);
					throw new Error('Failed to download population data and no file found');
				}
			}
		}
		
		// Verify file exists and is valid before processing
		if (!fs.existsSync(populationFile)) {
			console.error(`\n❌ Population file not found: ${populationFile}`);
			console.error(`\n📋 Instructions pour télécharger manuellement :`);
			console.error(`   1. Allez sur https://www.insee.fr/fr/statistiques/6683035`);
			console.error(`   2. Cherchez le lien "Télécharger" ou "Download" pour le fichier CSV`);
			console.error(`   3. Téléchargez le fichier et placez-le à : ${populationFile}`);
			console.error(`   4. Relancez la commande : npm run insee:update\n`);
			throw new Error(`Population file not found: ${populationFile}`);
		}
		
		const fileStats = fs.statSync(populationFile);
		if (fileStats.size < 10000) {
			console.warn(`⚠️  Warning: Population file is very small (${fileStats.size} bytes), may not contain all data`);
		} else {
			console.log(`✓ Population file found: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
		}
		
		// Download budget data (if available)
		// Note: Budget data may require authentication or different source
		// For now, we'll skip if not available
		let budgetData = [];
		if (BUDGET_CSV_URL) {
			let shouldDownloadBudget = true;
			if (fs.existsSync(budgetFile)) {
				const stats = fs.statSync(budgetFile);
				const fileAge = Date.now() - stats.mtime.getTime();
				const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
				
				if (fileAge < maxAge) {
					console.log(`ℹ️  Using existing budget file (age: ${Math.floor(fileAge / (24 * 60 * 60 * 1000))} days old): ${budgetFile}`);
					shouldDownloadBudget = false;
				} else {
					console.log(`ℹ️  Budget file is older than 30 days, will re-download`);
				}
			}
			
			if (shouldDownloadBudget) {
				await downloadFile(BUDGET_CSV_URL, budgetFile);
			}
			budgetData = await processBudgetData(budgetFile);
		} else {
			console.log('⚠️  Budget URL not configured, skipping budget data');
		}
		
		// Process data
		const populationData = await processPopulationData(populationFile);
		
		// Update database
		await updateDatabase(populationData, budgetData);
		
		console.log('✅ INSEE data update completed');
	} catch (error) {
		console.error('❌ Error updating INSEE data:', error);
		process.exit(1);
	} finally {
		await pool.end();
	}
}

if (require.main === module) {
	main();
}

module.exports = { main };

