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
    "update_features: Update OSM features in database"
    "update_projects: Update project statistics and history"
    "update_quality: Calculate quality completion only"
    "update_global_stats: Update global statistics (notes France, hiking routes)"
    "update_daily: Run daily updates (PBF, features, projects, global stats)"
    "uninstall: Uninstall projects from database"
    "list: List all available commands"
    "help: Show this help message"
)

# Function to validate config.json
validate_config() {
    local config_file="./config.json"
    local errors=0
    
    if [ ! -f "$config_file" ]; then
        echo "ERROR: config.json file not found at $config_file"
        return 1
    fi
    
    echo "Validating config.json..."
    
    # Check OSM_USER
    local osm_user=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_USER || ''); } catch(e) { console.log(''); }")
    if [ -z "$osm_user" ] || [ "$osm_user" = "user" ]; then
        echo "  ❌ OSM_USER is missing or has default value 'user'"
        errors=$((errors + 1))
    else
        echo "  ✓ OSM_USER is configured"
    fi
    
    # Check OSM_PASS
    local osm_pass=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_PASS || ''); } catch(e) { console.log(''); }")
    if [ -z "$osm_pass" ] || [ "$osm_pass" = "pass" ]; then
        echo "  ❌ OSM_PASS is missing or has default value 'pass'"
        errors=$((errors + 1))
    else
        echo "  ✓ OSM_PASS is configured"
    fi
    
    # Check OSM_API_KEY (if present)
    local osm_api_key=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_KEY || ''); } catch(e) { console.log(''); }")
    if [ -n "$osm_api_key" ] && [ "$osm_api_key" = "key" ]; then
        echo "  ⚠ OSM_API_KEY has default value 'key' (optional, but should be changed if used)"
        errors=$((errors + 1))
    elif [ -n "$osm_api_key" ]; then
        echo "  ✓ OSM_API_KEY is configured"
    fi
    
    # Check OSM_API_SECRET (if present)
    local osm_api_secret=$(node -e "try { const c = require('$config_file'); console.log(c.OSM_API_SECRET || ''); } catch(e) { console.log(''); }")
    if [ -n "$osm_api_secret" ] && [ "$osm_api_secret" = "secret" ]; then
        echo "  ⚠ OSM_API_SECRET has default value 'secret' (optional, but should be changed if used)"
        errors=$((errors + 1))
    elif [ -n "$osm_api_secret" ]; then
        echo "  ✓ OSM_API_SECRET is configured"
    fi
    
    # Check MAPILLARY_API_KEY (if present)
    local mapillary_key=$(node -e "try { const c = require('$config_file'); console.log(c.MAPILLARY_API_KEY || ''); } catch(e) { console.log(''); }")
    if [ -n "$mapillary_key" ] && [ "$mapillary_key" = "yourtoken" ]; then
        echo "  ⚠ MAPILLARY_API_KEY has default value 'yourtoken' (optional, but should be changed if used)"
    elif [ -n "$mapillary_key" ]; then
        echo "  ✓ MAPILLARY_API_KEY is configured"
    fi
    
    # Check OSH_PBF_URL
    local osh_pbf_url=$(node -e "try { const c = require('$config_file'); console.log(c.OSH_PBF_URL || ''); } catch(e) { console.log(''); }")
    if [ -z "$osh_pbf_url" ]; then
        echo "  ❌ OSH_PBF_URL is missing"
        errors=$((errors + 1))
    elif echo "$osh_pbf_url" | grep -q "reunion-internal.osh.pbf"; then
        echo "  ⚠ OSH_PBF_URL appears to use example value (reunion-internal.osh.pbf)"
        echo "     Make sure this is the correct region for your project"
    else
        echo "  ✓ OSH_PBF_URL is configured: $osh_pbf_url"
    fi
    
    # Check DB_URL (from config or env)
    local db_url=$(node -e "try { const c = require('$config_file'); console.log(c.DB_URL || ''); } catch(e) { console.log(''); }")
    if [ -z "$db_url" ] && [ -z "$DB_URL" ]; then
        echo "  ❌ DB_URL is missing (neither in config.json nor in environment)"
        errors=$((errors + 1))
    elif [ -n "$DB_URL" ]; then
        # Environment variable takes precedence
        if echo "$DB_URL" | grep -q "@host:"; then
            echo "  ❌ DB_URL in environment contains placeholder 'host' - should be actual database host"
            errors=$((errors + 1))
        else
            echo "  ✓ DB_URL is configured from environment"
        fi
    elif [ -n "$db_url" ] && echo "$db_url" | grep -q "@host:"; then
        echo "  ❌ DB_URL in config.json contains placeholder 'host' - should be actual database host"
        errors=$((errors + 1))
    else
        echo "  ✓ DB_URL is configured in config.json"
    fi
    
    echo ""
    if [ $errors -gt 0 ]; then
        echo "❌ ERROR: Found $errors critical issue(s) in config.json"
        echo "Please update config.json with your actual values before running commands."
        echo "See config.example.json for reference."
        return 1
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

case $command in
"install")
    psql -d $DB_URL -f ./db/00_init.sql
    ;;
"init")
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
    npm run features:update $otherArgs
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
    npm run projects:update $otherArgs
    if [ -f "/tmp/pdm/31_projects_update_tmp.sh" ]; then
        /tmp/pdm/31_projects_update_tmp.sh $otherArgs
    elif [ -f "./db/31_projects_update_tmp.sh" ]; then
        ./db/31_projects_update_tmp.sh $otherArgs
    else
        echo "ERROR: Script 31_projects_update_tmp.sh not found"
        exit 1
    fi
    echo ""
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
    if [ -n "$PROJECTS_WITH_TAGS" ]; then
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
    else
        echo "Aucun projet avec quality.required_tags détecté."
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
*)
    echo "Command $command unknown"
    exit 2
    ;;
esac
