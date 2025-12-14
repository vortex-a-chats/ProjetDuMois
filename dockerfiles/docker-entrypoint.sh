#!/bin/bash

command=${1}
otherArgs=${@: 2}

# List of available commands
AVAILABLE_COMMANDS=(
    "install: Initialize the database schema"
    "init: Full initialization (PBF update, features update, projects update)"
    "run: Start the web server"
    "start: Start the web server"
    "update_pbf: Update OSH PBF file"
    "update_features: Update OSM features in database (optionally specify project ID)"
    "update_projects: Update project statistics and history (optionally specify project ID, use --force-recalculate to recalculate all dates)"
    "update_quality: Calculate quality completion only"
    "update_global_stats: Update global statistics (notes France, hiking routes)"
    "update_daily: Run daily updates (PBF, features, projects, global stats, use --force-recalculate to recalculate all dates, use --with-quality to calculate quality completion)"
    "uninstall: Uninstall projects from database"
    "count_objects: Count objects in OSH file for a project (optionally specify project ID)"
    "latest_stats: Show latest measurement and date for each project"
    "list: List all available commands"
    "help: Show this help message"
)

# Function to update config.json with a new value
update_config_json() {
    local config_file="./config.json"
    local key=$1
    local value=$2
    
    # Créer un script Node.js temporaire pour mettre à jour le fichier
    local temp_script=$(mktemp)
    cat > "$temp_script" <<NODEJS
const fs = require('fs');
const configFile = '$config_file';
const key = '$key';
const value = process.argv[1];

let config = {};
try {
    if (fs.existsSync(configFile)) {
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
} catch (e) {
    // Si le fichier n'existe pas ou est invalide, on crée un nouveau config
}

config[key] = value;
fs.writeFileSync(configFile, JSON.stringify(config, null, '\t') + '\n');
NODEJS
    
    # Exécuter le script avec la valeur comme argument
    node "$temp_script" "$value"
    rm -f "$temp_script"
}

# Function to prompt for missing config values interactively
prompt_missing_config() {
    local config_file="./config.json"
    local needs_update=false
    
    echo ""
    echo "🔧 Configuration interactive"
    echo "Certaines variables essentielles manquent dans config.json"
    echo "Veuillez les remplir pour continuer :"
    echo ""
    
    # Check and prompt for OSM_USER
    local osm_user=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_USER || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_user" ] || [ "$osm_user" = "user" ]; then
        echo -n "OSM_USER (nom d'utilisateur OSM) : "
        read -r osm_user
        if [ -n "$osm_user" ]; then
            update_config_json "OSM_USER" "$osm_user"
            needs_update=true
        fi
    fi
    
    # Check and prompt for OSM_PASS
    local osm_pass=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_PASS || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_pass" ] || [ "$osm_pass" = "pass" ]; then
        echo -n "OSM_PASS (mot de passe OSM) : "
        read -s -r osm_pass
        echo ""
        if [ -n "$osm_pass" ]; then
            update_config_json "OSM_PASS" "$osm_pass"
            needs_update=true
        fi
    fi
    
    # Check and prompt for OSM_API_KEY
    local osm_api_key=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_KEY || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_api_key" ] || [ "$osm_api_key" = "key" ]; then
        echo -n "OSM_API_KEY (optionnel, appuyez sur Entrée pour ignorer) : "
        read -r osm_api_key
        if [ -n "$osm_api_key" ] && [ "$osm_api_key" != "key" ]; then
            update_config_json "OSM_API_KEY" "$osm_api_key"
            needs_update=true
        fi
    fi
    
    # Check and prompt for OSM_API_SECRET
    local osm_api_secret=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_SECRET || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_api_secret" ] || [ "$osm_api_secret" = "secret" ]; then
        echo -n "OSM_API_SECRET (optionnel, appuyez sur Entrée pour ignorer) : "
        read -s -r osm_api_secret
        echo ""
        if [ -n "$osm_api_secret" ] && [ "$osm_api_secret" != "secret" ]; then
            update_config_json "OSM_API_SECRET" "$osm_api_secret"
            needs_update=true
        fi
    fi
    
    # Check and prompt for OSH_PBF_URL
    local osh_pbf_url=$(node -e "try { const c = require('$config_file'); console.log(c.OSH_PBF_URL || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osh_pbf_url" ]; then
        echo -n "OSH_PBF_URL (URL du fichier OSH, ex: https://osm-internal.download.geofabrik.de/europe/france/region-internal.osh.pbf) : "
        read -r osh_pbf_url
        if [ -n "$osh_pbf_url" ]; then
            update_config_json "OSH_PBF_URL" "$osh_pbf_url"
            needs_update=true
        fi
    fi
    
    # Check DB_URL (only if not in environment)
    if [ -z "$DB_URL" ]; then
        local db_url=$(node -e "try { const c = require('$config_file'); console.log(c.DB_URL || ''); } catch(e) { console.log(''); }" 2>/dev/null)
        if [ -z "$db_url" ] || echo "$db_url" | grep -q "@host:"; then
            echo -n "DB_URL (URL de connexion PostgreSQL, ex: postgres://user:pass@host:5432/dbname) : "
            read -r db_url
            if [ -n "$db_url" ]; then
                update_config_json "DB_URL" "$db_url"
                needs_update=true
            fi
        fi
    fi
    
    if [ "$needs_update" = "true" ]; then
        echo ""
        echo "✓ Configuration mise à jour"
    fi
    echo ""
}

# Function to validate config.json
validate_config() {
    local config_file="./config.json"
    local errors=0
    local missing_vars=()
    
    # Créer le fichier config.json s'il n'existe pas avec une structure de base
    if [ ! -f "$config_file" ]; then
        echo "⚠️  config.json file not found at $config_file"
        echo "Creating initial config.json from example..."
        # Créer un config.json de base basé sur config.example.json
        if [ -f "./config.example.json" ]; then
            cp "./config.example.json" "$config_file"
        else
            # Créer un config.json minimal
            node -e "
            const fs = require('fs');
            const defaultConfig = {
                OSM_URL: 'https://www.openstreetmap.org',
                OSMOSE_URL: 'https://osmose.openstreetmap.fr',
                NOMINATIM_URL: 'https://nominatim.openstreetmap.org',
                MAPILLARY_URL: 'https://www.mapillary.com',
                MAPILLARY_API_KEY: 'yourtoken',
                REPOSITORY_URL: 'https://github.com/vdct/ProjetDuMois',
                JOSM_REMOTE_URL: 'http://localhost:8111',
                WORK_DIR: '/tmp/pdm',
                DB_USE_IMPOSM_UPDATE: true
            };
            fs.writeFileSync('$config_file', JSON.stringify(defaultConfig, null, '\t') + '\n');
            "
        fi
    fi
    
    echo "Validating config.json..."
    
    # Check OSM_USER
    local osm_user=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_USER || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_user" ] || [ "$osm_user" = "user" ]; then
        echo "  ❌ OSM_USER is missing or has default value 'user'"
        errors=$((errors + 1))
        missing_vars+=("OSM_USER")
    else
        echo "  ✓ OSM_USER is configured"
    fi
    
    # Check OSM_PASS
    local osm_pass=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_PASS || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osm_pass" ] || [ "$osm_pass" = "pass" ]; then
        echo "  ❌ OSM_PASS is missing or has default value 'pass'"
        errors=$((errors + 1))
        missing_vars+=("OSM_PASS")
    else
        echo "  ✓ OSM_PASS is configured"
    fi
    
    # Check OSM_API_KEY (if present)
    local osm_api_key=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_KEY || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -n "$osm_api_key" ] && [ "$osm_api_key" = "key" ]; then
        echo "  ⚠ OSM_API_KEY has default value 'key' (optional, but should be changed if used)"
        missing_vars+=("OSM_API_KEY")
    elif [ -n "$osm_api_key" ]; then
        echo "  ✓ OSM_API_KEY is configured"
    fi
    
    # Check OSM_API_SECRET (if present)
    local osm_api_secret=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_SECRET || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -n "$osm_api_secret" ] && [ "$osm_api_secret" = "secret" ]; then
        echo "  ⚠ OSM_API_SECRET has default value 'secret' (optional, but should be changed if used)"
        missing_vars+=("OSM_API_SECRET")
    elif [ -n "$osm_api_secret" ]; then
        echo "  ✓ OSM_API_SECRET is configured"
    fi
    
    # Check MAPILLARY_API_KEY (if present)
    local mapillary_key=$(node -e "try { const c = require('$config_file'); console.log(c.MAPILLARY_API_KEY || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -n "$mapillary_key" ] && [ "$mapillary_key" = "yourtoken" ]; then
        echo "  ⚠ MAPILLARY_API_KEY has default value 'yourtoken' (optional, but should be changed if used)"
    elif [ -n "$mapillary_key" ]; then
        echo "  ✓ MAPILLARY_API_KEY is configured"
    fi
    
    # Check OSH_PBF_URL
    local osh_pbf_url=$(node -e "try { const c = require('$config_file'); console.log(c.OSH_PBF_URL || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$osh_pbf_url" ]; then
        echo "  ❌ OSH_PBF_URL is missing"
        errors=$((errors + 1))
        missing_vars+=("OSH_PBF_URL")
    elif echo "$osh_pbf_url" | grep -q "reunion-internal.osh.pbf"; then
        echo "  ⚠ OSH_PBF_URL appears to use example value (reunion-internal.osh.pbf)"
        echo "     Make sure this is the correct region for your project"
    else
        echo "  ✓ OSH_PBF_URL is configured: $osh_pbf_url"
    fi
    
    # Check DB_URL (from config or env)
    local db_url=$(node -e "try { const c = require('$config_file'); console.log(c.DB_URL || ''); } catch(e) { console.log(''); }" 2>/dev/null)
    if [ -z "$db_url" ] && [ -z "$DB_URL" ]; then
        echo "  ❌ DB_URL is missing (neither in config.json nor in environment)"
        errors=$((errors + 1))
        missing_vars+=("DB_URL")
    elif [ -n "$DB_URL" ]; then
        # Environment variable takes precedence
        if echo "$DB_URL" | grep -q "@host:"; then
            echo "  ❌ DB_URL in environment contains placeholder 'host' - should be actual database host"
            errors=$((errors + 1))
            missing_vars+=("DB_URL")
        else
            echo "  ✓ DB_URL is configured from environment"
        fi
    elif [ -n "$db_url" ] && echo "$db_url" | grep -q "@host:"; then
        echo "  ❌ DB_URL in config.json contains placeholder 'host' - should be actual database host"
        errors=$((errors + 1))
        missing_vars+=("DB_URL")
    else
        echo "  ✓ DB_URL is configured in config.json"
    fi
    
    echo ""
    if [ $errors -gt 0 ] || [ ${#missing_vars[@]} -gt 0 ]; then
        # Si on est en mode interactif (stdin disponible), demander les valeurs manquantes
        if [ -t 0 ] && [ "$VALIDATE_RECURSIVE" != "true" ]; then
            prompt_missing_config
            # Re-valider après la mise à jour (une seule fois pour éviter la récursion infinie)
            export VALIDATE_RECURSIVE=true
            validate_config
            local result=$?
            unset VALIDATE_RECURSIVE
            return $result
        elif [ "$VALIDATE_RECURSIVE" = "true" ]; then
            # Si on est déjà en récursion, vérifier seulement les erreurs critiques
            if [ $errors -gt 0 ]; then
                echo "❌ ERROR: Some critical configuration values are still missing after update"
                return 1
            else
                echo "✓ Configuration updated, continuing..."
                return 0
            fi
        else
            echo "❌ ERROR: Found $errors critical issue(s) in config.json"
            echo "Please update config.json with your actual values before running commands."
            echo "See config.example.json for reference."
            return 1
        fi
    else
        echo "✓ All required configuration values are properly set"
        return 0
    fi
}

# Function to list available commands
list_commands() {
    echo "Available commands:"
    echo ""
    for cmd in "${AVAILABLE_COMMANDS[@]}"; do
        echo "  - $cmd"
    done
    echo ""
    echo "Usage: docker-compose exec pdm ./docker-entrypoint.sh <command> [args...]"
    echo ""
    echo "Examples:"
    echo "  # Update all projects:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_projects"
    echo ""
    echo "  # Update a specific project:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_projects 2024-12_streetlamps"
    echo ""
    echo "  # Update projects and force recalculation of all dates:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_projects --force-recalculate"
    echo ""
    echo "  # Run daily updates:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_daily"
    echo ""
    echo "  # Run daily updates with full recalculation of all dates:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_daily --force-recalculate"
    echo ""
    echo "  # Run daily updates with quality completion calculation:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_daily --with-quality"
    echo ""
    echo "  # Run daily updates with both options:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_daily --force-recalculate --with-quality"
    echo ""
    echo "  # Update features for a specific project:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh update_features 2024-12_streetlamps"
    echo ""
    echo "  # Count objects in OSH file for a project:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh count_objects 2025-01_ask_angela"
    echo ""
    echo "  # Show latest measurement and date for each project:"
    echo "  docker-compose exec pdm ./docker-entrypoint.sh latest_stats"
}

if [ -z $DB_URL ]; then
    echo "Required env variable DB_URL should be set to reach pgsql backend"
    exit 1
fi

# Handle list/help commands before validation
if [ "$command" = "list" ] || [ "$command" = "help" ] || [ -z "$command" ]; then
    list_commands
    exit 0
fi

# Validate config.json before executing commands (except for list/help)
if ! validate_config; then
    echo ""
    echo "Command execution aborted due to configuration issues."
    exit 1
fi

echo "Executing ${command} command"

# Capture start time
START_TIME=$(date +%s)

# Function to log execution time (called on exit)
log_execution_time() {
    if [ -n "$START_TIME" ]; then
        END_TIME=$(date +%s)
        EXECUTION_TIME=$((END_TIME - START_TIME))
        HOURS=$((EXECUTION_TIME / 3600))
        MINUTES=$(((EXECUTION_TIME % 3600) / 60))
        SECONDS=$((EXECUTION_TIME % 60))
        
        if [ $HOURS -gt 0 ]; then
            echo ""
            echo "⏱️  Temps d'exécution: ${HOURS}h ${MINUTES}m ${SECONDS}s"
        elif [ $MINUTES -gt 0 ]; then
            echo ""
            echo "⏱️  Temps d'exécution: ${MINUTES}m ${SECONDS}s"
        else
            echo ""
            echo "⏱️  Temps d'exécution: ${SECONDS}s"
        fi
    fi
}

# Register trap to log execution time on exit
trap log_execution_time EXIT

case $command in
"install")
    psql -d $DB_URL -f ./db/00_init.sql
    ;;
"init")
    # Vérifier si les tables de base existent, sinon exécuter install d'abord
    if ! psql -d $DB_URL -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pdm_projects')" 2>/dev/null | grep -q "t"; then
        echo "⚠️  Les tables de base n'existent pas. Exécution de 'install' d'abord..."
        psql -d $DB_URL -f ./db/00_init.sql
        if [ $? -eq 0 ]; then
            echo "✓ Installation de la base de données terminée"
        else
            echo "❌ Erreur lors de l'installation de la base de données"
            exit 1
        fi
    fi
    
    npm run pbf:update $otherArgs
    if [ -f "/tmp/pdm/11_pbf_update_tmp.sh" ]; then
        /tmp/pdm/11_pbf_update_tmp.sh
    elif [ -f "./db/11_pbf_update_tmp.sh" ]; then
        ./db/11_pbf_update_tmp.sh
    else
        echo "ERROR: Script 11_pbf_update_tmp.sh not found"
        exit 1
    fi
    npm run features:update $otherArgs
    if [ -f "/tmp/pdm/21_features_update_tmp.sh" ]; then
        /tmp/pdm/21_features_update_tmp.sh init
    elif [ -f "./db/21_features_update_tmp.sh" ]; then
        ./db/21_features_update_tmp.sh init
    else
        echo "ERROR: Script 21_features_update_tmp.sh not found"
        exit 1
    fi
    npm run projects:update $otherArgs
    if [ -f "/tmp/pdm/31_projects_update_tmp.sh" ]; then
        /tmp/pdm/31_projects_update_tmp.sh $otherArgs
    elif [ -f "./db/31_projects_update_tmp.sh" ]; then
        ./db/31_projects_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 31_projects_update_tmp.sh not found"
        exit 1
    fi
    ;;
"run")
    npm run start
    ;;
"start")
    npm run start
    ;;
"update_pbf")
    npm run pbf:update $otherArgs
    if [ -f "/tmp/pdm/11_pbf_update_tmp.sh" ]; then
        /tmp/pdm/11_pbf_update_tmp.sh || {
            # If script fails, check for error HTML files and try to open them
            if [ -f "/tmp/pdm/auth_error.html" ]; then
                echo ""
                echo "Authentication error detected. To view in Firefox, run on host:"
                echo "  ./open_error_in_firefox.sh pdm /tmp/pdm/auth_error.html"
            fi
            if [ -f "/tmp/pdm/pbf_download_error.html" ]; then
                echo ""
                echo "Download error detected. To view in Firefox, run on host:"
                echo "  ./open_error_in_firefox.sh pdm /tmp/pdm/pbf_download_error.html"
            fi
            exit 1
        }
    elif [ -f "./db/11_pbf_update_tmp.sh" ]; then
        ./db/11_pbf_update_tmp.sh || {
            if [ -f "/tmp/pdm/auth_error.html" ]; then
                echo ""
                echo "Authentication error detected. To view in Firefox, run on host:"
                echo "  ./open_error_in_firefox.sh pdm /tmp/pdm/auth_error.html"
            fi
            exit 1
        }
    else
        echo "ERROR: Script 11_pbf_update_tmp.sh not found"
        exit 1
    fi
    ;;
"update_features")
    npm run features:update -- $otherArgs
    if [ -f "/tmp/pdm/21_features_update_tmp.sh" ]; then
        /tmp/pdm/21_features_update_tmp.sh $otherArgs
    elif [ -f "./db/21_features_update_tmp.sh" ]; then
        ./db/21_features_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 21_features_update_tmp.sh not found"
        exit 1
    fi
    ;;
"update_projects")
    # Passer les arguments (y compris --force-recalculate) au script Node.js
    node db/30_projects_update.js $otherArgs
    if [ -f "/tmp/pdm/31_projects_update_tmp.sh" ]; then
        /tmp/pdm/31_projects_update_tmp.sh $otherArgs
    elif [ -f "./db/31_projects_update_tmp.sh" ]; then
        ./db/31_projects_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 31_projects_update_tmp.sh not found"
        exit 1
    fi
    ;;
"update_quality")
    echo "Collecte des projets avec mesure de qualité..."
    PROJECTS_WITH_TAGS=$(node - <<'NODE'
const fs = require('fs');
const path = require('path');
const projectsDir = path.join(process.cwd(), 'projects');
const results = [];
fs.readdirSync(projectsDir).forEach((proj) => {
  const infoPath = path.join(projectsDir, proj, 'info.json');
  try {
    const data = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const tags = data.quality && Array.isArray(data.quality.required_tags) ? data.quality.required_tags : [];
    if (tags.length > 0) {
      const tagList = tags.map(t => "'" + String(t).replace(/'/g, "''") + "'").join(',');
      results.push(proj + "|" + tagList);
    }
  } catch (e) {
    // ignore invalid json or missing files
  }
});
results.forEach(r => console.log(r));
NODE
)
    if [ -z "$PROJECTS_WITH_TAGS" ]; then
        echo "Aucun projet avec quality.required_tags détecté."
        exit 0
    fi
    ERROR_COUNT=0
    while IFS='|' read -r PROJ TAGS; do
        [ -z "$PROJ" ] && continue
        echo "   => Calculate quality completion for $PROJ (all dates)"
        SQL="SELECT pdm_calculate_quality_completion_all_dates('${PROJ//\'/\'\'}', ARRAY[${TAGS}]);"
        if ! psql -d "$DB_URL" -v ON_ERROR_STOP=1 -c "$SQL"; then
            echo "   ❌ Erreur lors du calcul pour $PROJ"
            ERROR_COUNT=$((ERROR_COUNT + 1))
        else
            echo "   ✓ Calcul réussi pour $PROJ"
        fi
    done <<< "$PROJECTS_WITH_TAGS"
    if [ $ERROR_COUNT -gt 0 ]; then
        echo ""
        echo "⚠️  $ERROR_COUNT projet(s) ont échoué lors du calcul de complétion"
        exit 1
    else
        echo ""
        echo "✓ Tous les projets ont été traités avec succès"
    fi
    ;;
"update_global_stats")
    node db/40_global_stats_update.js
    if [ -f "/tmp/pdm/41_global_stats_update_tmp.sh" ]; then
        /tmp/pdm/41_global_stats_update_tmp.sh
    elif [ -f "./db/41_global_stats_update_tmp.sh" ]; then
        ./db/41_global_stats_update_tmp.sh
    else
        echo "ERROR: Script 41_global_stats_update_tmp.sh not found"
        exit 1
    fi
    ;;
"update_daily")
    npm run pbf:update $otherArgs
    if [ -f "/tmp/pdm/11_pbf_update_tmp.sh" ]; then
        /tmp/pdm/11_pbf_update_tmp.sh
    elif [ -f "./db/11_pbf_update_tmp.sh" ]; then
        ./db/11_pbf_update_tmp.sh
    else
        echo "ERROR: Script 11_pbf_update_tmp.sh not found"
        exit 1
    fi
    npm run features:update $otherArgs
    if [ -f "/tmp/pdm/21_features_update_tmp.sh" ]; then
        /tmp/pdm/21_features_update_tmp.sh $otherArgs
    elif [ -f "./db/21_features_update_tmp.sh" ]; then
        ./db/21_features_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 21_features_update_tmp.sh not found"
        exit 1
    fi
    # Passer les arguments (y compris --force-recalculate) directement au script Node.js
    node db/30_projects_update.js $otherArgs
    if [ -f "/tmp/pdm/31_projects_update_tmp.sh" ]; then
        /tmp/pdm/31_projects_update_tmp.sh $otherArgs
    elif [ -f "./db/31_projects_update_tmp.sh" ]; then
        ./db/31_projects_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 31_projects_update_tmp.sh not found"
        exit 1
    fi
    echo ""
    # Vérifier si l'option --with-quality est présente
    if echo "$otherArgs" | grep -q -- "--with-quality"; then
        echo "== Calculate quality completion scores"
        echo "Collecte des projets avec mesure de qualité..."
        PROJECTS_WITH_TAGS=$(node - <<'NODE'
const fs = require('fs');
const path = require('path');
const projectsDir = path.join(process.cwd(), 'projects');
const results = [];
fs.readdirSync(projectsDir).forEach((proj) => {
  const infoPath = path.join(projectsDir, proj, 'info.json');
  try {
    const data = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const tags = data.quality && Array.isArray(data.quality.required_tags) ? data.quality.required_tags : [];
    if (tags.length > 0) {
      const tagList = tags.map(t => "'" + String(t).replace(/'/g, "''") + "'").join(',');
      results.push(proj + "|" + tagList);
    }
  } catch (e) {
    // ignore invalid json or missing files
  }
});
results.forEach(r => console.log(r));
NODE
)
        if [ -z "$PROJECTS_WITH_TAGS" ]; then
            echo "   ⏭️  Aucun projet avec quality.required_tags détecté."
        else
            ERROR_COUNT=0
            while IFS='|' read -r PROJ TAGS; do
                [ -z "$PROJ" ] && continue
                echo "   => Calculate quality completion for $PROJ (all dates)"
                SQL="SELECT pdm_calculate_quality_completion_all_dates('${PROJ//\'/\'\'}', ARRAY[${TAGS}]);"
                if ! psql -d "$DB_URL" -v ON_ERROR_STOP=1 -c "$SQL"; then
                    echo "   ❌ Erreur lors du calcul pour $PROJ"
                    ERROR_COUNT=$((ERROR_COUNT + 1))
                else
                    echo "   ✓ Calcul réussi pour $PROJ"
                fi
            done <<< "$PROJECTS_WITH_TAGS"
            if [ $ERROR_COUNT -gt 0 ]; then
                echo ""
                echo "⚠️  $ERROR_COUNT projet(s) ont échoué lors du calcul de complétion"
            else
                echo ""
                echo "✓ Tous les projets ont été traités avec succès"
            fi
        fi
    else
        echo "== Calculate quality completion scores (SKIPPED)"
        echo "   ⏭️  Quality completion calculation skipped (use --with-quality to enable)"
    fi
    echo ""
    echo "== Update global statistics"
    node db/40_global_stats_update.js
    if [ -f "/tmp/pdm/41_global_stats_update_tmp.sh" ]; then
        /tmp/pdm/41_global_stats_update_tmp.sh
    elif [ -f "./db/41_global_stats_update_tmp.sh" ]; then
        ./db/41_global_stats_update_tmp.sh
    else
        echo "ERROR: Script 41_global_stats_update_tmp.sh not found"
        exit 1
    fi
    ;;
"uninstall")
    npm run features:update $otherArgs

    psql -d $DB_URL -f ./db/91_project_uninstall_tmp.sql
    psql -d $DB_URL -f ./db/90_uninstall.sql
    ;;
"count_objects")
    PROJECT_ID=${otherArgs:-"2025-01_ask_angela"}
    echo "Counting objects for project: $PROJECT_ID"
    echo ""
    
    # Get project info
    PROJECT_INFO=$(node -e "
    const projects = require('./website/projects');
    const project = projects['$PROJECT_ID'];
    if (!project) {
        console.error('ERROR: Project $PROJECT_ID not found');
        process.exit(1);
    }
    const tagFilter = project.database && project.database.osmium_tag_filter ? project.database.osmium_tag_filter : '';
    console.log(JSON.stringify({ tagFilter: tagFilter }));
    " 2>&1)
    
    if [ $? -ne 0 ]; then
        echo "$PROJECT_INFO"
        exit 1
    fi
    
    TAG_FILTER=$(echo "$PROJECT_INFO" | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(d.tagFilter);')
    
    if [ -z "$TAG_FILTER" ]; then
        echo "ERROR: No osmium_tag_filter found for project $PROJECT_ID"
        exit 1
    fi
    
    echo "Tag filter: $TAG_FILTER"
    echo ""
    
    # Get OSH file path from config
    OSH_FILE=$(node -e "
    const CONFIG = require('./config.json');
    const oshUrl = CONFIG.OSH_PBF_URL;
    const oshFilename = oshUrl.split('/').pop().replace('.osh.pbf', '.latest.osh.pbf');
    console.log(CONFIG.WORK_DIR + '/' + oshFilename);
    ")
    
    if [ ! -f "$OSH_FILE" ]; then
        echo "ERROR: OSH file not found: $OSH_FILE"
        echo "Please run 'update_pbf' first to download the OSH file."
        exit 1
    fi
    
    echo "OSH file: $OSH_FILE"
    echo ""
    
    # Create temporary files
    TMP_DIR=$(node -e "const CONFIG = require('./config.json'); console.log(CONFIG.WORK_DIR);")
    TMP_FILTERED="${TMP_DIR}/count_filtered_${PROJECT_ID}.osh.pbf"
    TMP_OSM="${TMP_DIR}/count_osm_${PROJECT_ID}.osm.pbf"
    
    # Clean up temporary files on exit
    trap "rm -f '$TMP_FILTERED' '$TMP_OSM'" EXIT
    
    echo "Step 1: Filtering OSH file with tag filter..."
    if ! osmium tags-filter "$OSH_FILE" -R $TAG_FILTER -O -o "$TMP_FILTERED" 2>&1; then
        echo "ERROR: Failed to filter OSH file"
        exit 1
    fi
    
    if [ ! -f "$TMP_FILTERED" ] || [ ! -s "$TMP_FILTERED" ]; then
        echo "WARNING: Filtered file is empty or missing"
        echo "Count from OSH: 0"
    else
        echo "Step 2: Converting to OSM (latest version)..."
        future_date=$(date -u -d "+10 years" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-12-31T23:59:59Z")
        if ! osmium time-filter "$TMP_FILTERED" "$future_date" -O -o "$TMP_OSM" -f osm.pbf 2>&1; then
            echo "ERROR: Failed to convert OSH to OSM"
            exit 1
        fi
        
        if [ ! -f "$TMP_OSM" ] || [ ! -s "$TMP_OSM" ]; then
            echo "WARNING: OSM file is empty or missing"
            echo "Count from OSH: 0"
        else
            echo "Step 3: Counting objects..."
            # Extract the tag filter part (e.g., "n/harassment_prevention=ask_angela" -> "harassment_prevention=ask_angela")
            TAG_PART=$(echo "$TAG_FILTER" | sed -E 's/^[nwr]\///')
            COUNT=$(osmium tags-count "$TMP_OSM" --no-progress -F osm.pbf "$TAG_PART" 2>/dev/null | cut -d$'\t' -f 1 | paste -sd+ | bc 2>/dev/null || echo "0")
            
            if [ -z "$COUNT" ] || [ "$COUNT" = "" ]; then
                COUNT="0"
            fi
            
            echo ""
            echo "=========================================="
            echo "Count from OSH file (latest version): $COUNT"
            echo "=========================================="
        fi
    fi
    
    echo ""
    echo "Step 4: Getting count from database..."
    DB_COUNT=$(psql -d "$DB_URL" -qtAc "SELECT COUNT(*) FROM pdm_features WHERE project = '$PROJECT_ID' AND end_ts IS NULL" 2>/dev/null || echo "ERROR")
    
    if [ "$DB_COUNT" = "ERROR" ]; then
        echo "WARNING: Could not query database"
    else
        echo ""
        echo "=========================================="
        echo "Count from database (current features): $DB_COUNT"
        echo "=========================================="
    fi
    
    echo ""
    if [ -n "$COUNT" ] && [ -n "$DB_COUNT" ] && [ "$COUNT" != "0" ] && [ "$DB_COUNT" != "ERROR" ]; then
        DIFF=$((COUNT - DB_COUNT))
        if [ $DIFF -gt 0 ]; then
            echo "⚠️  Database has $DIFF fewer objects than OSH file"
        elif [ $DIFF -lt 0 ]; then
            echo "⚠️  Database has $((-$DIFF)) more objects than OSH file"
        else
            echo "✓ Counts match!"
        fi
    fi
    ;;
"latest_stats")
    echo "== Mesure la plus récente par projet"
    echo ""
    psql -d "$DB_URL" -t -A -F "|" -c "
    SELECT 
        p.project,
        to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
        to_char(p.end_date, 'YYYY-MM-DD') AS end_date,
        to_char(p.lastupdate_date, 'YYYY-MM-DD HH24:MI:SS') AS lastupdate_date,
        COALESCE(
            to_char((SELECT ts FROM pdm_feature_counts 
             WHERE project = p.project 
             ORDER BY ts DESC LIMIT 1), 'YYYY-MM-DD HH24:MI:SS'),
            'Aucune'
        ) AS latest_measurement_date,
        COALESCE(
            (SELECT amount FROM pdm_feature_counts 
             WHERE project = p.project 
             ORDER BY ts DESC LIMIT 1)::text,
            '0'
        ) AS latest_measurement_count,
        (SELECT COUNT(*)::text FROM pdm_feature_counts WHERE project = p.project) AS total_measurements
    FROM pdm_projects p
    ORDER BY p.project;
    " 2>/dev/null | while IFS='|' read -r project start_date end_date lastupdate_date latest_measurement_date latest_measurement_count total_measurements; do
        if [ -n "$project" ]; then
            printf "%-30s | Dernière mesure: %-19s | Nombre: %10s | Total mesures: %s\n" \
                "$project" \
                "$latest_measurement_date" \
                "$latest_measurement_count" \
                "$total_measurements"
        fi
    done || {
        echo "ERROR: Failed to query database"
        exit 1
    }
    echo ""
    ;;
*)
    echo "Command $command unknown"
    exit 2
    ;;
esac
