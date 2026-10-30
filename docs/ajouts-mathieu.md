# Ajouts de Mathieu

Ce qui a été ajouté au jeu le 30 octobre 2026, pour la partie d'Halloween.

## Nouvelles règles

### Sortie de zone
- Un joueur qui sort de la zone voit un compte à rebours (avec un tic sonore chaque seconde).
- Si un **hider** reste dehors plus de 30 s, sa position est envoyée **en direct** aux hunters
  (fantôme rouge « hors zone, en direct ») jusqu'à ce qu'il revienne. Les hunters reçoivent une alerte.
- Réglable par l'hôte : révélé après 30 s, après 1 min, ou simple alerte sans révélation.
- Un hunter hors zone est seulement prévenu.
- Marge pour l'imprécision du GPS en bord de zone : la précision annoncée par le téléphone, plafonnée à 40 m
  et au quart du rayon, pour éviter les fausses alertes.

### Taille de la zone
- Rayon de **50 m à 25 km** (avant : 200 m minimum), pour jouer aussi dans un parc ou un pâté de maisons.
- Curseur progressif : par pas de 10 m pour les petites zones, plus rapide pour les grandes.
- Pas en dessous de 50 m : la précision du GPS d'un téléphone (5 à 20 m dehors, souvent pire entre les immeubles)
  ferait sortir les joueurs de la zone sans qu'ils bougent.

### Équipes
- **Répartition des rôles** au choix :
  - *Inversés* : les hunters deviennent hiders à la manche suivante. Avec un nombre de hunters fixe,
    chacun passe hunter à son tour (ceux qui ont le moins chassé d'abord).
  - *Au hasard* : nouveau tirage à chaque manche.
  - *À la main* : l'hôte place chaque joueur ; ceux qu'il ne place pas sont tirés au sort.
- **Nombre de hunters** : moitié, 1, 2 ou 3.

### Hôte
- Le bouton « ⋯ » sur un joueur permet de **lui passer le rôle d'hôte** ou de **l'exclure** (avec confirmation).
- Un joueur exclu ne peut pas reprendre sa session ; un hider exclu en pleine manche compte comme un abandon.

### Chat d'équipe
- Les hiders parlent entre eux, les hunters entre eux. Un bouton permet d'écrire à tout le monde.
- Messages rapides selon le rôle (« Hunter en vue ! », « Je prends le nord »…).
- À la fin de la manche, les messages des deux équipes sont révélés à tout le monde.
- Le serveur vérifie qui a le droit de lire quoi : ce n'est pas seulement caché dans l'interface.

### Scores sur toute la soirée
- Hider : **10 pts par minute en fuite**, **+50** s'il est encore libre quand le temps est écoulé.
- Hunter : **100 pts par capture**, **+50** chacun si toute l'équipe adverse est attrapée.
- Un hider qui se déclare attrapé indique **qui l'a eu**, pour que ce hunter marque les points
  (s'il ne sait pas, les points sont partagés entre les hunters).
- Classement cumulé en fin de manche et dans le salon, puis **podium final** ; l'hôte peut relancer une partie à zéro.

### Parties sauvegardées
- Les salons sont enregistrés dans `data/rooms.json` toutes les 5 s (chemin modifiable avec `DATA_FILE`).
- Si le serveur plante ou redémarre, la partie reprend là où elle en était quand les téléphones se reconnectent.

### GPS et écran verrouillé
- Un navigateur arrête d'envoyer la position quand l'écran se verrouille : il faut garder l'appli ouverte.
- Les hunters voient « GPS figé » sur un fantôme dont la position n'est plus à jour.
- Un hider qui revient dans l'appli après plus de 20 s en arrière-plan est prévenu.

## Nouveau design
- Thème Halloween : nuit violette, citrouille pour les hunters, vert spectral pour les hiders, lune pour soi.
- Accueil illustré (forêt de sapins sous une lune dans un viseur).
- Carte en mode nuit, zone en pointillés lumineux, extérieur de la zone assombri.
- Les hiders sont des fantômes sur la carte ; une tombe apparaît là où quelqu'un s'est fait attraper.
- Annonce animée au lancement (« Tu es HUNTER / HIDER ») et quand les hunters sont lâchés :
  viseur qui se verrouille ou fantôme qui monte, lettres qui tombent une à une, onde de choc, titre qui grésille.
- Sons synthétisés (sonar des pings, lâcher des hunters, capture, alarme hors zone, message) avec un bouton pour couper le son.
- Fenêtres de confirmation intégrées au jeu à la place des fenêtres du navigateur.
- Tout le texte de l'appli tutoie.
- Nouvelle icône d'appli (`npm run icons`).

## Côté code
- `game.js` : toutes les nouvelles règles (zone, rôles, chat, scores, podium, sauvegarde), sans entrée/sortie.
- `server.js` : nouveaux messages `role`, `host`, `kick`, `chat`, `final`, `reset`, et la sauvegarde sur disque.
- `public/` : interface refaite (`index.html`, `style.css`, `app.js`).
- `test/game.test.js` : 13 tests en plus, 33 au total (`npm test`).
- `npm test` marche de nouveau sous Node 24.

## Jouer ce soir
Le GPS ne marche qu'en HTTPS. Le plus rapide : lancer le serveur sur un PC et l'exposer avec un tunnel Cloudflare.

```bash
npm install
npm start
npx cloudflared tunnel --url http://localhost:3000
```

Le tunnel affiche une adresse en `https://…trycloudflare.com` à partager. Le PC doit rester allumé et connecté
pendant toute la partie, et l'adresse change à chaque redémarrage du tunnel.
