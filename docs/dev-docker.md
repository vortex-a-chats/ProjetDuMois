# développer avec docker

## Prérequis

- Docker et Docker Compose installés
- Fichier `config.json` configuré avec les identifiants OSM et l'URL du fichier OSH

## Commandes principales

### Mise à jour complète (daily)

Pour mettre à jour tous les projets et les statistiques globales :

```bash
docker-compose exec pdm ./docker-entrypoint.sh update_daily
```

Cette commande :
1. Met à jour le fichier OSH PBF (vérifie qu'il fait au moins 8 Go)
2. Met à jour les features OSM dans la base de données
3. Met à jour les statistiques de tous les projets
4. Calcule les scores de complétion de qualité
5. Met à jour les statistiques globales (notes France, routes de randonnée)

### Commandes individuelles

- **Mise à jour du fichier OSH** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh update_pbf
  ```

- **Mise à jour des features OSM** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh update_features
  ```

- **Mise à jour des projets** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh update_projects
  # ou pour un projet spécifique :
  docker-compose exec pdm ./docker-entrypoint.sh update_projects 2025-01_ask_angela
  ```

- **Mise à jour des statistiques globales** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh update_global_stats
  ```

- **Compter les objets dans le fichier OSH** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh count_objects 2025-01_ask_angela
  ```

## Vérifications automatiques

Le système vérifie automatiquement que :
- Le fichier OSH fait au moins 8 Go avant de réaliser les mesures
- Les fichiers de configuration sont valides
- Les identifiants OSM sont corrects

## Accès au site web

Une fois les services démarrés, le site web est accessible sur http://localhost:3000