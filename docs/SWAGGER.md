# Documentation Swagger/OpenAPI

Ce fichier contient la documentation complète de l'API ProjetDuMois au format OpenAPI 3.0 (Swagger).

## Fichier

- **Fichier Swagger** : `docs/swagger.yaml`

## Utilisation

### Visualiser la documentation

Vous pouvez visualiser la documentation Swagger de plusieurs façons :

1. **Swagger UI** (recommandé) :
   ```bash
   # Installer swagger-ui-serve globalement
   npm install -g swagger-ui-serve
   
   # Lancer le serveur
   swagger-ui-serve docs/swagger.yaml
   ```
   
   Ou utiliser un service en ligne :
   - https://editor.swagger.io/ (copier-coller le contenu de `swagger.yaml`)
   - https://petstore.swagger.io/ (charger le fichier)

2. **Redoc** :
   ```bash
   npm install -g redoc-cli
   redoc-cli serve docs/swagger.yaml
   ```

3. **Intégration dans l'application** :
   Vous pouvez intégrer Swagger UI directement dans l'application Express en ajoutant :
   ```javascript
   const swaggerUi = require('swagger-ui-express');
   const swaggerDocument = require('./docs/swagger.yaml');
   app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
   ```

### Générer du code client

À partir du fichier Swagger, vous pouvez générer des clients pour différents langages :

```bash
# Installer openapi-generator
npm install -g @openapitools/openapi-generator-cli

# Générer un client JavaScript
openapi-generator-cli generate -i docs/swagger.yaml -g javascript -o ./generated-client

# Générer un client Python
openapi-generator-cli generate -i docs/swagger.yaml -g python -o ./generated-client-python
```

## Endpoints documentés

### Statistiques
- `GET /api/all-projects-progress` - Progression de tous les projets
- `GET /api/podiums` - Podiums des projets
- `GET /projects/all/stats` - Statistiques de tous les projets (optimisé)
- `GET /projects/{id}/stats` - Statistiques détaillées d'un projet
- `GET /projects/{id}/quality` - Statistiques de qualité

### Zones administratives
- `GET /projects/{id}/zones/{boundary_id}/stats` - Statistiques d'une zone
- `GET /projects/{id}/zones/{boundary_id}/objects` - Liste des objets d'une zone
- `GET /projects/{id}/zones/{boundary_id}` - Page HTML d'une zone
- `GET /projects/{id}/zones-search` - Recherche de zones
- `GET /projects/{id}/zones-podiums` - Podiums des zones d'un projet

### Contributions
- `POST /projects/{id}/contribute/{userid}` - Enregistrer une contribution
- `POST /projects/{id}/ignore/{osmtype}/{osmid}` - Exclure un objet

### Notes OSM
- `GET /api/notes-france` - Statistiques des notes OSM pour la France

### Randonnée
- `GET /api/hiking-route/{relation_id}/members` - Historique des membres d'un itinéraire
- `GET /api/hiking-route/{relation_id}/breaks` - Points de rupture d'un itinéraire

## Format des réponses

Toutes les réponses JSON suivent un format cohérent :
- **Succès (200)** : Retourne les données demandées
- **Erreur (400)** : `{ "error": "Message d'erreur" }`
- **Non trouvé (404)** : `{ "error": "Ressource non trouvée" }`
- **Maintenance (503)** : `{ "error": "Service unavailable" }`

## Authentification

Actuellement, l'API ne nécessite pas d'authentification pour la plupart des endpoints. Certains endpoints acceptent le paramètre `osm_user` pour personnaliser les résultats (ex: classement personnel).

## Exemples d'utilisation

### Récupérer les stats de tous les projets

```bash
curl http://localhost:3000/projects/all/stats
```

### Récupérer les stats détaillées d'un projet

```bash
curl http://localhost:3000/projects/2024-12_streetlamps/stats
curl "http://localhost:3000/projects/2024-12_streetlamps/stats?osm_user=mon_nom"
```

### Récupérer les stats d'une zone

```bash
curl http://localhost:3000/projects/2024-12_streetlamps/zones/7444/stats
```

### Enregistrer une contribution

```bash
curl -X POST "http://localhost:3000/projects/2024-12_streetlamps/contribute/12345?username=mon_nom&type=add"
```

## Mise à jour de la documentation

Lors de l'ajout ou modification d'un endpoint :

1. Mettre à jour `docs/swagger.yaml`
2. Vérifier la syntaxe YAML
3. Tester avec Swagger UI
4. Mettre à jour `docs/API_ROUTES.md` si nécessaire

## Validation

Pour valider le fichier Swagger :

```bash
# Installer swagger-cli
npm install -g swagger-cli

# Valider le fichier
swagger-cli validate docs/swagger.yaml
```
