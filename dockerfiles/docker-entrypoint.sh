#!/bin/bash

command=${1}
otherArgs=${@: 2}

if [ -z $DB_URL ]; then
    echo "Required env variable DB_URL should be set to reach pgsql backend"
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
        /tmp/pdm/11_pbf_update_tmp.sh
    elif [ -f "./db/11_pbf_update_tmp.sh" ]; then
        ./db/11_pbf_update_tmp.sh
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
