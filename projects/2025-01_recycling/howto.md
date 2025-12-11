# Points d'apport volontaire

## Qu'est-ce qu'un point d'apport volontaire ?

Un point d'apport volontaire (PAV) est un lieu où les citoyens peuvent déposer leurs déchets pour le recyclage. Ces points sont généralement situés dans des espaces publics accessibles et permettent de trier différents types de matériaux (verre, papier, emballages, etc.).

## Comment cartographier ?

### Tags principaux

- `amenity=recycling` : Tag principal pour identifier un point d'apport volontaire

### Tags de qualité

- `recycling_type=*` : Type de matériaux acceptés (obligatoire pour la qualité)
  - Exemples : `glass`, `paper`, `plastic`, `metal`, `clothes`, `batteries`, etc.
  - Peut être une liste séparée par des points-virgules : `glass;paper;plastic`

### Autres tags utiles

- `name=*` : Nom du point d'apport volontaire si disponible
- `operator=*` : Nom de l'opérateur (commune, entreprise, etc.)
- `location=*` : Emplacement (ex: `underground`, `surface`, `container`)
- `opening_hours=*` : Heures d'ouverture si applicable
- `access=*` : Conditions d'accès (ex: `public`, `private`, `permissive`)

## Ressources

- [Wiki OSM - amenity=recycling](https://wiki.openstreetmap.org/wiki/FR:Tag:amenity%3Drecycling)
- [Wiki OSM - recycling_type](https://wiki.openstreetmap.org/wiki/FR:Key:recycling_type)

