# Documentation des routes du frontal web

Cette documentation décrit toutes les routes disponibles dans le frontal web de ProjetDuMois.

**Base URL** : `http://localhost:3000` (ou l'URL configurée via `PORT`)

## Table des matières

1. [Pages publiques](#pages-publiques)
2. [Routes de projets](#routes-de-projets)
3. [API de statistiques](#api-de-statistiques)
4. [API de contributions](#api-de-contributions)
5. [Ressources statiques](#ressources-statiques)
6. [Gestion des erreurs](#gestion-des-erreurs)

---

## Pages publiques

### `GET /`

Page d'accueil du site.

**Comportement** :
- Si un seul projet existe : redirige vers la page du projet
- Si plusieurs projets existent : affiche la liste des projets avec leurs statistiques
- Si aucun projet : redirige vers `/error/500`

**Paramètres de requête** : Aucun

**Réponse** : Page HTML (template `pages/multi_projects.pug`)

**Exemple** :
```
GET /
```

---

### `GET /about`

Page "À propos" du site.

**Paramètres de requête** : Aucun

**Réponse** : Page HTML (template `pages/about.pug`)

**Exemple** :
```
GET /about
```

---

### `GET /error/:code`

Page d'erreur HTTP.

**Paramètres d'URL** :
- `code` : Code HTTP d'erreur (ex: `404`, `500`, `400`)

**Réponse** : Page HTML (template `pages/error.pug`) avec le code HTTP correspondant

**Exemple** :
```
GET /error/404
GET /error/500
```

---

## Routes de projets

### `GET /projects/:id`

Page principale d'un projet.

**Paramètres d'URL** :
- `id` : Identifiant du projet (ex: `2024-12_streetlamps`)

**Comportement** :
- Affiche les informations du projet, son résumé, comment participer, les statistiques et les données
- Redirige vers `/error/404` si le projet n'existe pas

**Réponse** : Page HTML (template `pages/project.pug`)

**Exemple** :
```
GET /projects/2024-12_streetlamps
```

---

### `GET /projects/:id/map`

Éditeur de carte pour un projet.

**Paramètres d'URL** :
- `id` : Identifiant du projet

**Comportement** :
- Affiche une carte interactive permettant de contribuer au projet
- Charge les données du projet et les sources de données configurées

**Réponse** : Page HTML (template `pages/map.pug`)

**Exemple** :
```
GET /projects/2024-12_streetlamps/map
```

---

### `GET /projects/:id/issues`

Liste des notes/issues pour un projet.

**Paramètres d'URL** :
- `id` : Identifiant du projet

**Réponse** : Page HTML (template `pages/issues.pug`)

**Exemple** :
```
GET /projects/2024-12_streetlamps/issues
```

---

## API de statistiques

### `GET /projects/:id/stats`

Récupère les statistiques d'un projet au format JSON.

**Paramètres d'URL** :
- `id` : Identifiant du projet

**Paramètres de requête** :
- `osm_user` (optionnel) : Nom d'utilisateur OSM pour afficher le classement personnel

**Réponse JSON** : Objet contenant :
```json
{
  "chart": [
    {
      "label": "Nombre dans OSM",
      "data": [
        { "t": "2018-12-01T00:00:00Z", "y": 1000 },
        { "t": "2024-12-02T00:00:00Z", "y": 1050 }
      ],
      "fill": false,
      "borderColor": "#388E3C",
      "lineTension": 0
    }
  ],
  "added": 567,
  "count": 1234,
  "nbContributors": 42,
  "leaderboard": [
    {
      "project": "2024-12_streetlamps",
      "userid": 12345,
      "username": "utilisateur",
      "amount": 150,
      "pos": 1
    }
  ],
  "chartKeys": {
    "labels": ["height", "lamp:type", "operator"],
    "datasets": [
      {
        "label": "Nombre d'objets pour la clé",
        "data": [500, 300, 200]
      }
    ]
  },
  "chartNotes": [
    {
      "label": "Ouvertes",
      "data": [{ "t": "2018-12-01", "y": 10 }],
      "borderColor": "#c62828"
    },
    {
      "label": "Résolues",
      "data": [{ "t": "2018-12-01", "y": 5 }],
      "borderColor": "#388E3C"
    }
  ],
  "tasksSolved": 25,
  "mapStyle": { ... }
}
```

**Champs disponibles** :
- `chart` : Graphique d'évolution du nombre d'objets dans le temps
- `added` : Nombre d'objets ajoutés depuis le début du projet
- `count` : Nombre total d'objets actuellement dans OSM
- `nbContributors` : Nombre de contributeurs
- `leaderboard` : Classement des contributeurs (seulement si `osm_user` est fourni)
- `chartKeys` : Statistiques des tags les plus utilisés
- `chartNotes` : Graphique des notes ouvertes/fermées (si activé)
- `tasksSolved` : Nombre de tâches Osmose résolues (si activé)
- `mapStyle` : Style de carte pour les statistiques par zone (si activé)

**Exemple** :
```
GET /projects/2024-12_streetlamps/stats
GET /projects/2024-12_streetlamps/stats?osm_user=mon_nom
```

---

## API de contributions

### `POST /projects/:id/contribute/:userid`

Enregistre une contribution d'un utilisateur pour un projet.

**Paramètres d'URL** :
- `id` : Identifiant du projet
- `userid` : ID utilisateur OSM (nombre)

**Paramètres de requête** :
- `username` : Nom d'utilisateur OSM (requis)
- `type` : Type de contribution : `add`, `edit`, `delete`, ou `note` (requis)

**Comportement** :
- Vérifie que le projet est actif
- Met à jour le nom d'utilisateur dans la base de données
- Enregistre la contribution
- Calcule les badges obtenus
- Retourne les nouveaux badges obtenus

**Réponse JSON** :
```json
{
  "badges": [
    {
      "id": "contributed",
      "name": "A participé",
      "description": "A participé au projet du mois",
      "acquired": true,
      "progress": 100
    }
  ]
}
```

**Codes de réponse** :
- `200` : Contribution enregistrée avec succès
- `400` : Paramètres invalides ou projet non actif
- `500` : Erreur serveur

**Exemple** :
```
POST /projects/2024-12_streetlamps/contribute/12345?username=mon_nom&type=add
```

---

### `POST /projects/:id/ignore/:osmtype/:osmid`

Ajoute un objet OSM à la liste d'exclusion pour le mode comparaison.

**Paramètres d'URL** :
- `id` : Identifiant du projet
- `osmtype` : Type d'objet OSM : `node`, `way`, ou `relation`
- `osmid` : ID de l'objet OSM (nombre)

**Paramètres de requête** :
- `user_id` : ID utilisateur OSM (optionnel)

**Comportement** :
- Ajoute l'objet à la table `pdm_compare_exclusions`
- Si l'objet existe déjà, met à jour le timestamp et l'utilisateur

**Réponse** : Statut `200` sans contenu

**Codes de réponse** :
- `200` : Objet ajouté à l'exclusion
- `400` : Paramètres invalides
- `404` : Projet non trouvé
- `500` : Erreur serveur

**Exemple** :
```
POST /projects/2024-12_streetlamps/ignore/node/123456?user_id=12345
```

---

## Routes utilisateurs

### `GET /users/:name`

Page de profil d'un utilisateur.

**Paramètres d'URL** :
- `name` : Nom d'utilisateur OSM

**Comportement** :
- Recherche l'utilisateur dans la base de données
- Affiche ses badges obtenus pour tous les projets
- Redirige vers `/error/404` si l'utilisateur n'existe pas

**Réponse** : Page HTML (template `pages/user.pug`)

**Exemple** :
```
GET /users/mon_nom_osm
```

---

## Ressources statiques

### `GET /images/*`

Sert les images du site.

**Exemple** :
```
GET /images/badges/streetlamps.svg
GET /images/favicon.png
```

---

### `GET /lib/:modname/:file`

Sert les fichiers des bibliothèques JavaScript/CSS autorisées.

**Paramètres d'URL** :
- `modname` : Nom du module (ex: `bootstrap`, `chart.js`, `maplibre-gl`)
- `file` : Nom du fichier

**Bibliothèques autorisées** :
- `bootstrap` : `bootstrap.css`
- `bootstrap.native` : `bootstrap.js`
- `chart.js` : `chart.js`, `chart.css`
- `maplibre-gl` : `maplibre-gl.js`, `maplibre-gl.css`
- `mapillary-js` : `mapillary.js`, `mapillary.css`
- `osm-auth` : `osmauth.js`
- `osm-request` : `osmrequest.js`
- `pic4carto` : `pic4carto.js`
- `swiped-events` : `swiped-events.js`
- `wordcloud` : `wordcloud.js`

**Exemple** :
```
GET /lib/bootstrap/bootstrap.css
GET /lib/chart.js/chart.js
```

---

### `GET /lib/fontawesome/*`

Sert les fichiers de Font Awesome.

**Exemple** :
```
GET /lib/fontawesome/css/all.min.css
```

---

### `GET /manifest.webmanifest`

Fichier manifest pour les Progressive Web Apps.

**Réponse** : Fichier JSON avec le type MIME `application/manifest+json`

---

### `GET /README.md`, `GET /DEVELOP.md`, `GET /LICENSE.txt`

Sert les fichiers de documentation à la racine du projet.

**Exemple** :
```
GET /README.md
GET /DEVELOP.md
```

---

## Gestion des erreurs

### Mode maintenance

Si `CONFIG.MAINTENANCE_MODE === true`, toutes les routes (sauf les ressources statiques) redirigent vers la page d'accueil ou affichent la page de maintenance.

### Route 404

Toute route non trouvée redirige vers `/error/404`.

---

## Codes de réponse HTTP

- `200` : Succès
- `400` : Requête invalide (paramètres manquants ou incorrects)
- `404` : Ressource non trouvée
- `500` : Erreur serveur
- `503` : Service en maintenance

---

## Notes importantes

1. **Authentification OSM** : Certaines fonctionnalités nécessitent une authentification OSM via OAuth. L'authentification est gérée côté client via `osm-auth`.

2. **CORS** : Toutes les routes acceptent les requêtes CORS (Cross-Origin Resource Sharing).

3. **Compression** : Les réponses sont compressées avec gzip si le client le supporte.

4. **Internationalisation** : Le site supporte le français (par défaut) et l'anglais. La langue est détectée automatiquement via les en-têtes HTTP `Accept-Language`.

5. **Base de données** : La plupart des routes nécessitent une connexion à la base de données PostgreSQL. En cas d'échec de connexion, le serveur ne démarre pas.

---

## Exemples d'utilisation

### Récupérer les statistiques d'un projet

```bash
curl http://localhost:3000/projects/2024-12_streetlamps/stats
```

### Enregistrer une contribution

```bash
curl -X POST "http://localhost:3000/projects/2024-12_streetlamps/contribute/12345?username=mon_nom&type=add"
```

### Exclure un objet de la comparaison

```bash
curl -X POST "http://localhost:3000/projects/2024-12_streetlamps/ignore/node/123456?user_id=12345"
```

---

## Routes futures (à implémenter)

### `GET /api/projects/:id/boundary/:boundary_id`

Récupère les statistiques d'un projet pour une zone administrative donnée.

**Paramètres d'URL** :
- `id` : Identifiant du projet
- `boundary_id` : ID OSM de la relation administrative

**Paramètres de requête** :
- `start_date` (optionnel) : Date de début au format `YYYY-MM-DD`
- `end_date` (optionnel) : Date de fin au format `YYYY-MM-DD`

**Réponse JSON** :
```json
{
  "project": "2024-12_streetlamps",
  "boundary_id": 7444,
  "boundary_name": "Paris",
  "admin_level": 8,
  "current_count": 1234,
  "added_since_start": 567,
  "last_30_days": 89,
  "statistics": [
    {
      "date": "2018-12-01",
      "count": 1000
    }
  ]
}
```

**Note** : Cette route est documentée dans le template du projet mais n'est pas encore implémentée dans le code.


