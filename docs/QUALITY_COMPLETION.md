# Système de décomptes de qualité de complétion

## Concept

Le système de qualité de complétion permet de mesurer le pourcentage de complétion des objets d'un projet en fonction des tags requis. Chaque tag requis compte pour une proportion égale dans le calcul de la complétion.

## Configuration dans info.json

Pour activer le système de qualité de complétion, ajoutez une section `quality` dans le fichier `info.json` du projet :

```json
{
  "id": "2024-12_streetlamps",
  "title": "Éclairages de rue",
  "quality": {
    "required_tags": [
      "height",
      "lamp:type",
      "lamp:mount",
      "operator"
    ]
  }
}
```

### Structure de la configuration

- `required_tags` : Liste des clés de tags OSM qui doivent être présentes pour qu'un objet soit considéré comme 100% complet.

## Calcul de la complétion

Pour chaque objet du projet :

1. On vérifie la présence de chaque tag requis dans les tags de l'objet OSM
2. Chaque tag présent compte pour `1 / nombre_total_de_tags_requis`
3. La complétion totale = `(nombre_de_tags_presents / nombre_total_de_tags_requis) * 100`

### Exemple

Si un projet requiert 4 tags : `height`, `lamp:type`, `lamp:mount`, `operator`

- Objet avec 4 tags présents : 100% complet (4/4)
- Objet avec 2 tags présents : 50% complet (2/4)
- Objet avec 0 tag présent : 0% complet (0/4)

## Implémentation technique

### 1. Migration de la base de données

Exécutez le script de migration pour créer les tables nécessaires :

```bash
docker-compose exec pdm psql -d $DB_URL -f db/01_quality_completion.sql
```

Ou manuellement :

```bash
psql -d $DB_URL -f db/01_quality_completion.sql
```

Ce script crée :
- `pdm_quality_completion` : Table pour stocker les scores de qualité par objet et par timestamp
- `pdm_quality_stats` : Table pour stocker les statistiques agrégées par jour
- `pdm_calculate_quality_completion()` : Fonction PostgreSQL pour calculer les scores de qualité

### 2. Calcul automatique lors de la mise à jour des projets

Le calcul des scores de qualité est automatiquement effectué lors de l'exécution de `update_projects` si le projet a une section `quality` configurée dans `info.json`.

```bash
docker-compose exec pdm ./docker-entrypoint.sh update_projects
```

Le script `db/30_projects_update.js` détecte automatiquement les projets avec `quality.required_tags` et appelle la fonction `pdm_calculate_quality_completion()` pour chaque projet.

### 3. Endpoints API

#### Récupérer les statistiques de qualité

**GET** `/projects/:id/quality`

Retourne les statistiques de qualité pour un projet donné.

**Réponse JSON :**
```json
{
  "project": "2024-12_streetlamps",
  "required_tags": ["height", "lamp:type", "lamp:mount", "operator"],
  "stats": [
    {
      "ts": "2018-12-01T23:59:59Z",
      "total_objects": 1000,
      "avg_completion": 65.5,
      "fully_complete": 300,
      "partially_complete": 400,
      "incomplete": 300
    }
  ],
  "current": {
    "avg_completion": 65.5,
    "fully_complete": 300,
    "partially_complete": 400,
    "incomplete": 300,
    "total_objects": 1000
  }
}
```

#### Statistiques incluses dans `/projects/:id/stats`

Les statistiques de qualité sont également incluses dans l'endpoint `/projects/:id/stats` sous la clé `qualityStats` si le projet a la qualité activée.

### 4. Affichage dans l'interface

La courbe de qualité est automatiquement affichée dans la section "Statistiques" de la page du projet si :
- Le projet a une section `quality` avec `required_tags` dans `info.json`
- Les statistiques de qualité ont été calculées (après `update_projects`)

La courbe affiche :
- **Complétion moyenne (%)** : Ligne verte montrant l'évolution de la complétion moyenne
- **Objets 100% complets** : Ligne vert clair
- **Objets partiellement complets (50-99%)** : Ligne jaune
- **Objets incomplets (<50%)** : Ligne rouge

Un encadré récapitulatif affiche également l'état actuel de la qualité avec les tags requis.

## Avantages

1. **Mesure objective** : Basée sur des critères clairs et définis
2. **Évolutif** : Facile d'ajouter ou retirer des tags requis
3. **Historique** : Permet de suivre l'évolution de la qualité dans le temps
4. **Actionnable** : Identifie précisément quels tags manquent sur quels objets

## Limitations et améliorations possibles

1. **Tags conditionnels** : Certains tags peuvent être requis seulement si d'autres tags sont présents (ex: `height` seulement si `lamp:type=high_mast`)
2. **Pondération** : Certains tags peuvent être plus importants que d'autres
3. **Valeurs valides** : Vérifier non seulement la présence mais aussi la validité des valeurs

