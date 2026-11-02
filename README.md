# Mini Kart 3D — Grand Prix multijoueur

New Kart Migné‑Auxances (sens inverse), avec le dévers à 20 % du virage 4, les boudins mobiles et la ligne de course, jouable à plusieurs dans le navigateur.

- Un petit serveur Node.js sert le jeu, relaie la position de chaque kart 20 fois par seconde (WebSocket `/ws`) et dirige les sessions.
- Tout est sur le port **9595** : la page, three.js (servi localement, pas de CDN) et le WebSocket.
- Les records (meilleur tour de chaque pilote, top 20) sont gardés dans le volume `minikart-data`.

## Déroulé d'une session (25 min)

| Phase | Durée | Règles |
|---|---|---|
| Essais libres | 5 min | Pas de dégâts ni d'usure. Pneus au choix au stand. |
| Qualifications | 3 min | Pneus neufs pour tous. Le meilleur tour fixe la place sur la grille. Au drapeau, on termine son tour (60 s au plus). |
| Mise en grille | 20 s | Chacun est placé sur sa case. On choisit ses pneus de départ : **1** tendres, **2** durs, **3** pluie. |
| Tour de formation | ~45 s | La safety car mène un tour à 45 km/h (limiteur), les pneus sont neufs et froids : zigzaguer les chauffe. La safety car rentre au stand, chacun regagne sa case. |
| Départ | ~7 s | 5 feux rouges s'allument un par un, puis s'éteignent : GO. Un pilote qui n'est pas sur sa case est remis en place et **traîne une barre chocolatée pendant le 1er tour (−5 km/h)**. |
| Grand Prix | 10 min | Au bout des 10 min, drapeau à damier au passage du leader ; les autres terminent leur tour. |
| Résultats | jusqu'à la fin des 25 min | Classement (tours, écarts, meilleur tour, arrêts, pénalités). Roulage libre en attendant la session suivante. |

Le premier pilote qui se connecte sur un serveur vide relance une session depuis les essais libres. Un pilote qui arrive après la mise en grille suit le Grand Prix en spectateur : son kart et ceux de la course se voient en fantômes, sans collision.

## Pneus

- **Tendres** : les plus rapides. L'usure s'accélère avec les dérives ; l'adhérence chute nettement vers le 14e tour.
- **Durs** : un peu moins d'adhérence, usure environ deux fois plus lente (environ 40 % au 14e tour).
- **Pluie** : sur piste mouillée, tenue de route normale mais **15 % de vitesse de pointe en moins**. Sur le sec, ils surchauffent et s'usent vite.
- **Température** : des pneus froids accrochent jusqu'à 22 % de moins ; trop chauds, ils perdent aussi de l'adhérence et s'usent plus vite. La fenêtre idéale dépend de la gomme.
- L'affichage sous le compteur montre la gomme, l'usure et la température.

## Météo

Elle est tirée au sort à chaque session : sec (60 %), ou pluie (40 %) sur toute la session, en averse, ou au début puis piste qui sèche. Le bandeau annonce la pluie 2 min 30 à l'avance. La piste met 40 s à se mouiller et 90 s à sécher.

Sur piste mouillée, des **slicks partent en glissade en virage au-delà de 25-30 km/h**. Il faut passer au stand pour mettre des pneus pluie.

## Stand

La voie des stands est à droite de la ligne droite : entrée juste après la ligne d'arrivée, limiteur à 30 km/h. S'arrêter dans la **zone jaune « STAND »** : les mécaniciens reptiliens changent les pneus en 3,8 s (et réparent l'aileron en 2,5 s de plus). Le train monté est celui choisi avec 1, 2 ou 3 (par défaut, pneus pluie si la piste est mouillée).

## Boudins et dégâts

- Un mur continu de piles de 3 pneus borde la piste. Une pile percutée recule et amortit le choc ; sur un choc assez fort, les pneus du haut tombent et restent au sol. Les commissaires remettent les piles en place 40 s après le dernier choc.
- Hors essais libres, un choc frontal à plus de 25 km/h casse l'aileron avant : −10 % de vitesse de pointe jusqu'à réparation (au stand, ou **R** en essais libres et pendant la pause).

## Commandes

Clavier : **Z/↑** accélérer · **S/↓** freiner · **Q D/← →** braquer · **Espace** frein à main · **1 2 3** pneus · **R** retour en piste · **C** caméra · **L** ligne de course. Manette : stick ou croix, gâchettes, croix haut pour changer de pneus.

## Déployer sur Portainer

### Méthode A : depuis un dépôt Git (recommandée)

1. Poussez ce dossier dans un dépôt Git (GitHub, Gitea, GitLab…).
2. Portainer → **Stacks** → **Add stack** → **Repository**.
3. Renseignez l'URL du dépôt, la branche, et `docker-compose.yml` comme *Compose path*.
4. **Deploy the stack**. Portainer construit l'image puis lance le conteneur.

Pour mettre à jour : poussez vos changements, puis **Pull and redeploy** sur la stack.

### Méthode B : tout depuis l'interface Portainer, sans Git

1. Portainer → **Images** → **Build a new image** → onglet **Upload**.
2. Nom de l'image : `minikart-multi:2.0`. Envoyez l'archive `minikart-multi-portainer-build.tar`, puis **Build the image**.
3. **Stacks** → **Add stack** → **Web editor**, collez le contenu de `portainer-stack.yml`, puis **Deploy the stack**.

### Méthode C : en ligne de commande sur l'hôte

```bash
cd minikart-multi
docker compose up -d --build
```

Le jeu est ensuite sur `http://IP-DU-SERVEUR:9595` (port 9595 ouvert dans le pare-feu de l'hôte).

## Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `9595` | Port d'écoute dans le conteneur |
| `MAX_PLAYERS` | `12` | Pilotes simultanés (16 au plus sur la grille) |
| `SESSION_MIN` | `25` | Durée d'une session |
| `FP_MIN` | `5` | Essais libres |
| `QUALI_MIN` | `3` | Qualifications |
| `GP_MIN` | `10` | Grand Prix |
| `WEATHER` | `auto` | `auto` (tirage au sort), `sec` ou `pluie` |
| `RAIN_CHANCE` | `0.4` | Probabilité de pluie par session en mode `auto` |
| `MIN_LAP_MS` | `20000` | Un tour plus court est ignoré pour les records |
| `RESTORE_MS` | `40000` | Délai avant que les commissaires remettent une pile en place |
| `DATA_DIR` | `/data` | Dossier du fichier `records.json` |

Si vous changez `PORT`, changez aussi le mapping `ports:` du compose. Si les durées dépassent `SESSION_MIN`, la session s'allonge d'elle-même.

## HTTPS / reverse proxy

Le jeu fonctionne derrière un reverse proxy (Nginx Proxy Manager, Traefik, Caddy…), à condition que le **WebSocket** soit autorisé. Avec Nginx Proxy Manager, cochez *Websockets Support* sur l'hôte. La page choisit automatiquement `wss://` en HTTPS.

## Limites à connaître

- Chaque navigateur calcule la physique de son propre kart, ses pneus et son arrêt au stand ; le serveur fait confiance à ce qu'il reçoit. Un joueur qui modifierait le code de sa page pourrait tricher. Le serveur borne les valeurs, ignore les tours trop courts, vérifie qu'un tour de qualification a commencé pendant la séance et recalcule le temps de course avec sa propre horloge si celui du client est incohérent.
- Les autres karts sont affichés avec environ 110 ms de retard pour un mouvement fluide. Avec une forte latence, les chocs entre karts deviennent approximatifs.
- Le 1er tour du Grand Prix part de la grille, placée sur la ligne droite après la ligne d'arrivée : il est un peu plus court et ne compte pas pour les records.
- La police du jeu vient de Google Fonts. Sans accès Internet, le navigateur utilise une police de remplacement.

## Fichiers

- `server.js` : serveur HTTP + WebSocket et directeur de course (dépendance : `ws`).
- `public/index.html` : le jeu (client).
- `Dockerfile`, `docker-compose.yml` : image Node 24 Alpine, utilisateur non-root, healthcheck sur `/health`.
- `portainer-stack.yml` : variante sans `build`, pour la méthode B.
