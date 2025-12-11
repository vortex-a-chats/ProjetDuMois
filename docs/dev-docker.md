# développer avec docker

- avoir les prérequis de dépendances: docker compose.
- remplir le fichier de config.json
- lancer docker compose pour récupérer le fichier OSH internal et faire les mesures sur tous les projets:
 make 
 # ou bien docker-compose exec pdm ./docker-entrypoint.sh update_projects
 - voir le site web sur http://localhost:3000