# Vérification des Items Osmose

## Items existants (vérifiés dans les projets)

| Item | Projet | Description |
|------|--------|-------------|
| 8031 | Écoles | École à ajouter |
| 8032 | Écoles | École à compléter |
| 8040 | Arrêts de bus | Arrêt de bus |
| 8180 | Toilettes | Toilettes |
| 8190 | Gendarmeries | Gendarmerie à ajouter |
| 8191 | Gendarmeries | Gendarmerie à compléter |
| 8280 | Postes électriques | Poste électrique |
| 8350 | Laboratoires | Laboratoire à ajouter |
| 8351 | Laboratoires | Laboratoire à compléter |
| 8370 | Défibrillateurs | Défibrillateur |
| 8410 | Bornes de recharge | Borne à importer |
| 8411 | Bornes de recharge | Borne à compléter |

## Items ajoutés (à vérifier)

### Bornes incendie (2025-02_fire_hydrant)
- **8420** : Borne incendie à ajouter
- **8421** : Borne incendie à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8420&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8421&country=france*

### Lampadaires (2024-12_streetlamps)
- **8430** : Lampadaire à ajouter
- **8431** : Lampadaire à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8430&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8431&country=france*

### Fontaines à eau (2025-02_drinking_water)
- **8440** : Fontaine à ajouter
- **8441** : Fontaine à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8440&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8441&country=france*

### Restaurants (2024-12_restaurants)
- **8450** : Restaurant à ajouter
- **8451** : Restaurant à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8450&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8451&country=france*

### Lieux de santé - Pharmacies (2025-02_healthcare)
- **8460** (class: pharmacy) : Pharmacie à ajouter
- **8461** (class: pharmacy) : Pharmacie à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8460&class=pharmacy&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8461&class=pharmacy&country=france*

### Lieux de santé - Hôpitaux (2025-02_healthcare)
- **8470** (class: hospital) : Hôpital à ajouter
- **8471** (class: hospital) : Hôpital à compléter

**URL de test :**
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8470&class=hospital&country=france*
- https://osmose.openstreetmap.fr/fr/issues/graph.json?item=8471&class=hospital&country=france*

## Comment vérifier

1. **Via l'API Graph** : Utilisez les URLs de test ci-dessus. Si l'item existe, vous obtiendrez un JSON avec des données. Si l'item n'existe pas, vous obtiendrez une erreur ou un JSON vide.

2. **Via le site web** : Visitez https://osmose.openstreetmap.fr/fr/errors et cherchez les items par numéro dans l'interface.

3. **Via l'API Issues** : 
   ```
   https://osmose.openstreetmap.fr/api/0.3/issues?item=8420&country=france*&limit=1
   ```

## Notes

- Les items pairs (X0) sont généralement pour "à ajouter/importer"
- Les items impairs (X1) sont généralement pour "à compléter"
- Certains items peuvent nécessiter le paramètre `class` pour filtrer par type (ex: pharmacy, hospital)
- Les IDs utilisés sont des estimations basées sur les patterns observés dans les projets existants
