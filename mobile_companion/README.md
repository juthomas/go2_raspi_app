# GO2 Mobile Companion (web / PWA)

Application **web responsive** pensée pour téléphone / tablette, à servir depuis le **Raspberry Pi** (ou tout hôte sur le même réseau que le robot).

## Rôle

- Se connecter au pont LiDAR : `go2_lidar_ws_bridge.py` (WebSocket, port **8765** par défaut).
- Afficher un aperçu 2D (projection XY) du nuage et des métadonnées (`stamp`, nombre de points).
- Enregistrer le **micro** avec export **audio** + fichier **JSON** de métadonnées (dernier frame LiDAR reçu + horodatages `performance.now()` / `Date.now()` pour alignement futur avec ton pipeline).

## Prérequis sur le Pi

- Node.js **18+** (`node -v`)
- Pont LiDAR lancé sur le même Pi (autre terminal) :

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765
```

## Installation

```bash
cd mobile_companion
npm install
```

## Développement (accès depuis le téléphone sur le LAN)

```bash
npm run dev
```

Ouvre sur le PC : `http://<IP-du-Pi>:5173`  
Sur le **téléphone** (même Wi‑Fi) : même URL.  
Dans le champ WebSocket, mets `ws://<IP-du-Pi>:8765` (le hostname auto ne suffit pas toujours si tu accèdes par IP — ajuste manuellement).

HTTPS : si tu sers en HTTPS, le WebSocket doit être en `wss:` (reverse proxy + cert) ou le navigateur bloquera la connexion vers `ws:`.

## Build statique (optionnel)

```bash
npm run build
npm run preview
```

Les fichiers générés sont dans `dist/` (servir avec nginx, ou `python3 -m http.server` dans `dist`).

## Fichiers exportés (après Stop enregistrement)

- `go2_audio_<timestamp>.webm` — audio micro
- `go2_sync_meta_<timestamp>.json` — dernier frame LiDAR connu + log de session

## Personnalisation

- UI : `src/style.css`, `src/main.js`
- Icône PWA : ajouter `public/icon-192.png` et référencer dans `manifest.webmanifest` si besoin
