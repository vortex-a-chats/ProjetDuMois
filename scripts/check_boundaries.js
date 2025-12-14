#!/usr/bin/env node

/**
 * Script pour vérifier que les boundaries sont bien remplies en base
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Charger la configuration
const configPath = path.join(__dirname, '..', 'config.json');
let CONFIG = {};
if (fs.existsSync(configPath)) {
  CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} else {
  console.error('❌ config.json non trouvé');
  process.exit(1);
}

// Détecter l'environnement et construire la DB_URL appropriée
let DB_URL = process.env.DB_URL || CONFIG.DB_URL;

// Si DB_URL contient "host" (connexion Docker), essayer de se connecter depuis l'hôte
if (DB_URL && DB_URL.includes('@host:')) {
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
  // car les identifiants dans config.json peuvent être différents
  const dbUser = process.env.POSTGRES_USER || 'postgres';
  const dbPassword = process.env.POSTGRES_PASSWORD || 'pgpassword';
  const dbName = process.env.POSTGRES_DB || 'pdm';
  
  DB_URL = `postgres://${dbUser}:${dbPassword}@localhost:${postgresPort}/${dbName}`;
  console.log(`ℹ️  Connexion depuis l'hôte, utilisation de localhost:${postgresPort}`);
  console.log(`   (Utilisation des identifiants Docker par défaut)`);
}

if (!DB_URL) {
  console.error('❌ DB_URL non défini dans config.json ou variable d\'environnement');
  console.error('   Vous pouvez aussi exécuter le script dans le conteneur Docker:');
  console.error('   docker-compose exec pdm node /opt/pdm/scripts/check_boundaries.js');
  process.exit(1);
}

const pool = new Pool({ 
  connectionString: DB_URL,
  // Timeout de connexion plus court pour détecter rapidement les erreurs
  connectionTimeoutMillis: 5000
});

async function checkBoundaries() {
  try {
    console.log('🔍 Vérification des boundaries en base de données...\n');

    // Vérifier si pdm_boundary_osm existe
    const boundaryOsmCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'pdm_boundary_osm'
      ) AS exists;
    `);

    if (!boundaryOsmCheck.rows[0].exists) {
      console.log('⚠️  La table pdm_boundary_osm n\'existe pas.');
      console.log('   → Exécutez: docker-compose exec pdm ./docker-entrypoint.sh features:update init');
      return;
    }

    // Compter les boundaries dans pdm_boundary_osm
    const boundaryOsmCount = await pool.query(`
      SELECT COUNT(*) as count FROM pdm_boundary_osm;
    `);
    console.log(`✓ Table pdm_boundary_osm: ${boundaryOsmCount.rows[0].count} boundaries`);

    // Vérifier si pdm_boundary (vue matérialisée) existe
    const boundaryCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_matviews 
        WHERE schemaname = 'public' AND matviewname = 'pdm_boundary'
      ) AS exists;
    `);

    if (!boundaryCheck.rows[0].exists) {
      console.log('⚠️  La vue matérialisée pdm_boundary n\'existe pas.');
      console.log('   → Exécutez: docker-compose exec pdm ./docker-entrypoint.sh features:update init');
      return;
    }

    // Compter les boundaries dans pdm_boundary
    const boundaryCount = await pool.query(`
      SELECT COUNT(*) as count FROM pdm_boundary;
    `);
    console.log(`✓ Vue matérialisée pdm_boundary: ${boundaryCount.rows[0].count} boundaries`);

    // Vérifier pdm_boundary_subdivide
    const subdivideCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_matviews 
        WHERE schemaname = 'public' AND matviewname = 'pdm_boundary_subdivide'
      ) AS exists;
    `);

    if (subdivideCheck.rows[0].exists) {
      const subdivideCount = await pool.query(`
        SELECT COUNT(*) as count FROM pdm_boundary_subdivide;
      `);
      console.log(`✓ Vue matérialisée pdm_boundary_subdivide: ${subdivideCount.rows[0].count} boundaries`);
    } else {
      console.log('⚠️  La vue matérialisée pdm_boundary_subdivide n\'existe pas.');
    }

    // Vérifier pdm_features_boundary
    const featuresBoundaryCount = await pool.query(`
      SELECT COUNT(*) as count FROM pdm_features_boundary;
    `);
    console.log(`✓ Table pdm_features_boundary: ${featuresBoundaryCount.rows[0].count} associations projet/boundary`);

    // Vérifier pdm_feature_counts_per_boundary
    const countsPerBoundary = await pool.query(`
      SELECT COUNT(DISTINCT boundary) as count FROM pdm_feature_counts_per_boundary;
    `);
    console.log(`✓ Table pdm_feature_counts_per_boundary: ${countsPerBoundary.rows[0].count} boundaries avec statistiques`);

    // Afficher quelques exemples de boundaries
    const examples = await pool.query(`
      SELECT osm_id, name, admin_level 
      FROM pdm_boundary 
      ORDER BY admin_level, name 
      LIMIT 10;
    `);

    if (examples.rows.length > 0) {
      console.log('\n📋 Exemples de boundaries:');
      examples.rows.forEach(row => {
        console.log(`   - ${row.name || 'Sans nom'} (OSM ID: ${row.osm_id}, admin_level: ${row.admin_level})`);
      });
    }

    console.log('\n✅ Vérification terminée');

  } catch (error) {
    console.error('❌ Erreur lors de la vérification:', error.message);
    
    // Suggestions selon le type d'erreur
    if (error.message.includes('getaddrinfo') || error.message.includes('EAI_AGAIN')) {
      console.error('\n💡 Suggestions:');
      console.error('   1. Vérifiez que le conteneur PostgreSQL est démarré:');
      console.error('      docker-compose ps pgsqldb');
      console.error('   2. Exécutez le script dans le conteneur Docker:');
      console.error('      docker-compose exec pdm node /opt/pdm/scripts/check_boundaries.js');
      console.error('   3. Ou définissez POSTGRES_PORT si vous utilisez un port différent:');
      console.error('      POSTGRES_PORT=5433 node scripts/check_boundaries.js');
    } else if (error.message.includes('password authentication failed') || error.message.includes('authentication')) {
      console.error('\n💡 Vérifiez les identifiants dans config.json');
    } else if (error.message.includes('timeout')) {
      console.error('\n💡 La connexion a expiré. Vérifiez que PostgreSQL est accessible.');
    }
    
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkBoundaries();

