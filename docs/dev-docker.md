# développer avec docker

## Prérequis

- Docker et Docker Compose installés
- Fichier `config.json` configuré avec les identifiants OSM et l'URL du fichier OSH

## Configuration du port PostgreSQL

Par défaut, le port PostgreSQL est configuré sur **5433** pour éviter les conflits avec une installation PostgreSQL existante sur le port 5432.

**Important** : Docker Compose lit automatiquement les variables d'environnement depuis un fichier `.env` à la racine du projet. Les variables d'environnement shell (`export`) ne sont pas toujours lues par docker-compose.

### Méthode recommandée : fichier `.env`

Créez un fichier `.env` à la racine du projet (à côté de `docker-compose.yml`) :

```bash
# Fichier .env
POSTGRES_PORT=5433
```

Si vous souhaitez utiliser un autre port (par exemple 5434), modifiez le fichier `.env` :

```bash
# Fichier .env
POSTGRES_PORT=5434
```

Si vous n'avez pas de PostgreSQL installé sur votre machine et souhaitez utiliser le port standard 5432 :

```bash
# Fichier .env
POSTGRES_PORT=5432
```

### Alternative : variable d'environnement shell

Si vous préférez utiliser une variable d'environnement shell, vous devez la passer explicitement à docker-compose :

```bash
POSTGRES_PORT=5434 docker-compose up -d
```

**Note** : Le fichier `.env` est la méthode la plus fiable et recommandée.

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
4. Met à jour les statistiques globales (notes France, routes de randonnée)

**Options disponibles :**

- `--force-recalculate` : Recalcule toutes les dates depuis le début du projet (au lieu de calculer uniquement les dates manquantes)
- `--with-quality` : Calcule également les scores de complétion de qualité pour les projets qui ont cette fonctionnalité activée

Exemples :

```bash
# Mise à jour quotidienne normale
docker-compose exec pdm ./docker-entrypoint.sh update_daily

# Avec recalcul complet de toutes les dates
docker-compose exec pdm ./docker-entrypoint.sh update_daily --force-recalculate

# Avec calcul de complétion de qualité
docker-compose exec pdm ./docker-entrypoint.sh update_daily --with-quality

# Avec les deux options
docker-compose exec pdm ./docker-entrypoint.sh update_daily --force-recalculate --with-quality
```

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

- **Calcul des scores de complétion de qualité** :
  ```bash
  docker-compose exec pdm ./docker-entrypoint.sh update_quality
  ```
  Cette commande calcule les scores de complétion de qualité pour tous les projets qui ont cette fonctionnalité activée (définie dans `info.json` avec `quality.required_tags`).

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