# go2-raspi-cli

CLI Python pour Raspberry Pi afin de piloter un Unitree GO2 en DDS.

## Ce que fait cette premiere version

- `stand`: leve le robot (`SportClient.StandUp`)
- `lie`: couche le robot (`SportClient.StandDown`)
- `tui`: mode ncurses de pilotage temps reel (teleop + infos robot)
  - V5: enregistrement/relecture de sequences custom (macros)
  - V6: vrai mode Teach (capture manuelle articulations + replay low-level)
- force le mode `normal` avant commande (par defaut)
- architecture extensible par transport:
  - `dds` (implante)
  - `udp` (stub)
  - `webrtc` (stub)

## Prerequis

- Raspberry Pi avec Python `>=3.10`
- liaison Ethernet directe vers le GO2
- service motion/sport actif sur le robot
- outils systeme: `cmake`, `python3-dev`, `build-essential`, `cyclonedds-dev`
- dependances Python:
  - `cyclonedds==0.10.2`
  - `unitree_sdk2py` (installe en editable depuis le repo officiel)

## Installation

### 1) installer les prerequis systeme (Debian/Raspberry Pi OS)

```bash
sudo apt-get update
sudo apt-get install -y cmake cyclonedds-dev python3-dev build-essential
```

### 2) preparer un prefix CycloneDDS compatible avec pip

`cyclonedds-python` cherche une arborescence `include/bin/lib`.
Sur Debian, les libs sont dans `/usr/lib/aarch64-linux-gnu`, donc on cree un prefix.

```bash
mkdir -p "$HOME/cyclonedds-prefix"
ln -sfn /usr/include "$HOME/cyclonedds-prefix/include"
ln -sfn /usr/bin "$HOME/cyclonedds-prefix/bin"
ln -sfn /usr/lib/aarch64-linux-gnu "$HOME/cyclonedds-prefix/lib"
```

### 3) installer ce projet + CycloneDDS dans le venv

```bash
cd /home/pigeons/Documents/unitree/go2_raspi_app
python3 -m venv .venv
source .venv/bin/activate
export CYCLONEDDS_HOME="$HOME/cyclonedds-prefix"

# workaround Python 3.13 pour cyclonedds==0.10.2
export CFLAGS="-D_Py_IsFinalizing=Py_IsFinalizing"

pip install --upgrade pip
pip install -e ".[dds]"
```

### 4) installer `unitree_sdk2py` en editable (evite un bug packaging upstream)

```bash
cd /home/pigeons/Documents/unitree
git clone https://github.com/unitreerobotics/unitree_sdk2_python.git
cd /home/pigeons/Documents/unitree/go2_raspi_app
source .venv/bin/activate
export CYCLONEDDS_HOME="$HOME/cyclonedds-prefix"
export CFLAGS="-D_Py_IsFinalizing=Py_IsFinalizing"
pip install -e /home/pigeons/Documents/unitree/unitree_sdk2_python
```

## Utilisation

### Configuration reseau GO2 (important)

Sur Raspberry Pi OS avec NetworkManager, configure une IP statique sur `eth0`
avant d'utiliser la CLI DDS:

```bash
sudo nmcli connection add type ethernet ifname eth0 con-name go2-eth0 \
  ipv4.method manual ipv4.addresses 192.168.123.99/24 \
  ipv4.never-default yes ipv6.method ignore connection.autoconnect yes
sudo nmcli connection up go2-eth0
```

Verification:

```bash
ip -br a
ip route
ping -c 3 192.168.123.161
```

Exemples:

```bash
# leve le robot
go2ctl --transport dds --iface eth0 stand

# couche le robot
go2ctl --transport dds --iface eth0 lie

# force uniquement le mode normal
go2ctl --transport dds --iface eth0 normal-mode

# mode ncurses (teleop clavier)
go2ctl --transport dds --iface eth0 --yes tui
```

### Pont LiDAR → WebSocket (processus séparé sur le Pi)

Deux programmes **indépendants** : le TUI (`go2ctl` ou `go2ctl_cpp`) d’un côté, et le pont LiDAR de l’autre. Le pont souscrit au topic DDS `sensor_msgs/PointCloud2` (LiDAR intégré Go2) et diffuse chaque frame en **JSON** sur **WebSocket** (idéal pour une autre app qui enregistre le son en parallèle et aligne sur `stamp` / `recv_mono`).

Installation des deps pont (en plus de `unitree_sdk2py` + CycloneDDS) :

```bash
source .venv/bin/activate
pip install websockets
# ou : pip install -e ".[lidar-ws]"
```

Lancement (autre terminal que le TUI) :

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765
```

Connexion depuis la même machine : `ws://127.0.0.1:8765`  
Depuis un autre appareil sur le LAN : `ws://<IP-du-Pi>:8765`

Options utiles :

- `--topic rt/utlidar/cloud` (défaut) — si aucune donnée, vérifier le nom exact dans la doc Unitree pour ton firmware.
- `--max-points 4000` / `--stride 2` — réduire la charge réseau (perte de frames acceptable).
- `--rate-hz 15` — limite l’envoi côté WebSocket.
- `--include-raw-b64` — inclut le buffer `PointCloud2` brut (plus lourd).
- `--voxel` — diffuse `go2_voxel_map` sur le **même** WebSocket (port 8765). Source par défaut : **`height_map`** (`rt/utlidar/height_map_array`, mapping app Unitree).
- `--voxel-map-source height_map|compressed|both` — `height_map` (défaut), `compressed` (`voxel_map_compressed` + LZ4), ou les deux.
- `--height-map-topic rt/utlidar/height_map_array` — topic HeightMap (SDK officiel).
- `--voxel-decompress` — pour source `compressed` : décompresse LZ4 et inclut `occupied_points` (pip install lz4).
- `--voxel-rate-hz 1` — limite l’envoi de la carte (défaut 1 Hz).
- `--voxel-topic rt/utlidar/voxel_map_compressed` — topic VoxelMapCompressed (certains firmwares EDU).

Exemple avec carte (visualisation dans go2-lidar-studio, mapping app Unitree) :

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel --include-joints
```

Prérequis : LiDAR actif + **enregistrement mapping** dans l’app Unitree Go (Function → 3D LiDAR Mapping → play). Sans mapping actif, aucun `go2_voxel_map`.

### Dépannage carte (voxel / height_map)

Sur la plupart des GO2 avec l’app Unitree, la carte est publiée sur **`rt/utlidar/height_map_array`** (~15 Hz), pas sur `voxel_map_compressed`.

**Créer une map ≠ démarrer le mapping.** Dans l’app Unitree Go :

1. Function → **3D LiDAR Mapping** → ouvrir ou créer une map
2. **Démarrer l’enregistrement** (play) — pas seulement nommer la map
3. **Bouger le robot** 10–20 s ; la carte 3D doit se remplir dans l’app

**Probe rapide** :

```bash
source .venv/bin/activate
./scripts/go2_voxel_probe.sh
# attendu: height_map probe: N frame(s) avec N > 0
SKIP_MAPPING_CMD=1 ./scripts/go2_voxel_probe.sh   # si mapping déjà actif dans l'app
MAP_SOURCE=compressed ./scripts/go2_voxel_probe.sh   # tester voxel_map_compressed
```

**Bridge** :

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel --include-joints
```

Succès : `map DDS (height_map): +N / 5s`. LiDAR Studio : **Show voxel map** → `Voxel: N pts`.

**Firmware EDU / voxel compressé** :

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel \
  --voxel-map-source compressed --voxel-decompress --include-joints
```

Chaque message JSON contient notamment `stamp.sec` / `stamp.nanosec` (horodatage ROS du nuage), `points: [[x,y,z], ...]`, et `recv_mono` (temps monotonic côté Pi à la réception) pour corrélation avec l’audio enregistré dans ton app. Les messages voxel (`type: "go2_voxel_map"`) arrivent séparément du nuage LiDAR.

### Autostart au boot (systemd) — LiDAR + contrôle + vidéo

Démarrage automatique côté **Raspberry Pi** (pas dans le firmware du robot) :

1. Attente réseau + ping du robot (`192.168.123.161` par défaut)
2. Mode normal DDS + `rt/utlidar/switch ON` + tentatives `rt/utlidar/mapping_cmd` (best-effort)
3. Pont **contrôle** WebSocket `:8766` + pont **vidéo WebRTC** `:8081` (fps 15) + pont **LiDAR** `:8765` (`--voxel --include-joints`, source height_map par défaut)

**Prérequis** : robot allumé et debout (~2 min après boot), connexion `go2-eth0` autoconnect, venv avec deps :

```bash
source .venv/bin/activate
pip install -e ".[lidar-ws,control-ws]"
pip install -e /path/to/unitree_sdk2_python
```

**Test manuel** (sans systemd) :

```bash
./scripts/go2_stack_startup.sh
# ou préparation seule :
.venv/bin/python scripts/go2_prepare_robot.py --iface eth0
# health check :
./scripts/go2_stack_health_check.sh
```

**Installation systemd** :

```bash
sudo cp deploy/systemd/go2-stack.service /etc/systemd/system/
sudo cp deploy/go2-stack.env.example /etc/default/go2-stack
# éditer /etc/default/go2-stack si besoin (IFACE, chemins, ports)
sudo systemctl daemon-reload
sudo systemctl enable --now go2-stack
sudo journalctl -u go2-stack -f
```

Variables utiles dans `/etc/default/go2-stack` (voir `deploy/go2-stack.env.example`) : `IFACE`, `ROBOT_IP`, `MAPPING_CMDS`, `LIDAR_WS_PORT`, `CONTROL_WS_PORT`, `VIDEO_ENABLED`, `VIDEO_HTTP_PORT`, `VIDEO_FPS`.

**Extinction Pi depuis l’UI** (`ShutdownPi` / `{type:"shutdown_pi"}`) : le bridge exécute `sudo /sbin/shutdown -h now`. L’utilisateur du service (`pigeons`) doit pouvoir le faire sans mot de passe, par ex. dans `/etc/sudoers.d/go2-shutdown` :

```text
pigeons ALL=(root) NOPASSWD: /sbin/shutdown
```

**Limitation carte** : le nuage LiDAR démarre de façon fiable ; `go2_voxel_map` dépend du mapping Unitree (app → `height_map_array` par défaut). Active **3D LiDAR Mapping** + enregistrement dans l’app — le stack utilise `--voxel-map-source height_map` par défaut.

**Fichiers** : `scripts/go2_prepare_robot.py`, `scripts/go2_stack_startup.sh`, `scripts/go2_stack_health_check.sh`, `deploy/systemd/go2-stack.service`.

### systema8os.xt (UI audio 3D + LiDAR GO2)

Le clone **systema8os** est dans `external/systema8os/`. Il inclut une section **GO2 LIDAR** branchée sur le pont WebSocket (`go2_lidar_ws_bridge.py`). Voir `external/systema8os/README.md`.

### Application web mobile (sur le Pi)

Projet **Vite** dans `mobile_companion/` : interface téléphone pour WebSocket LiDAR + enregistrement micro + export JSON. Voir `mobile_companion/README.md`.

```bash
cd mobile_companion && npm install && npm run dev -- --host 0.0.0.0
```

Puis ouvre `http://<IP-du-Pi>:5173` sur le téléphone (même réseau).

### Options `go2ctl` (générales)

- `--yes`: evite la confirmation interactive avant mouvement
- `--timeout 15`: timeout RPC en secondes
- `--no-ensure-normal-mode`: n'impose pas le mode normal
- `--strict-normal-mode`: rend bloquant l'echec du mode normal

### Mode `tui` (ncurses)

Commande:

```bash
go2ctl --transport dds --iface eth0 --yes tui
```

Controles:

- Interface stylee UTF-8 avec panneaux (`Robot State`, `Teleop`, `Controls`, `Modes`, `Events`) + jauges alignees
- Barres de progression colorees (vert/jaune/rouge + bleu pour progression active)
- V4: acceleration progressive + freinage doux + anti-overflow de queue
- V5: sequence recorder/player (actions teleop + modes)
- V6: teach mode (manipulation manuelle en `Damp` puis replay articulations)
  - optimisations: prep teach acceleree + blend court + replay speed factor
- `t`: bascule le mode de conduite
  - `STEP`: chaque appui envoie une **impulsion** (distance/angle)
  - `HOLD`: maintien de touche via key-repeat (auto-stop si relache)
- Presets V3:
  - `[` / `]`: profil precedent/suivant
  - `F1/F2/F3`: `safe` / `indoor` / `outdoor`
- Mouvement (corrige gauche/droite):
  - `W/S`: avance/recule
  - `A/D`: gauche/droite
  - `Fleches Gauche/Droite`: yaw gauche/droite
  - `Fleches Haut/Bas`: pitch +/-
- `1..9`: modes standards (stand/recovery/damp/trot/free walk...)
- `m`: tenter `normal-mode`
- `M`: rearm manuel high-level (sport service + normal mode)
- `x` ou `Espace`: stop d'urgence + vide la queue
- `r`: reset queue (STEP) ou etat hold (HOLD)
- Sequences custom:
  - `0`: choisir la cible macro active (`SEQ` ou `TEACH`)
  - `f`: demarrer/arreter REC de la cible active
  - `y`: PLAY de la cible active
  - `g`: SAVE de la cible active
  - `l`: LOAD de la cible active
  - aliases fonctionnels: `R/P/K/L` et `F5/F6/F7/F8`
- Teach custom (vrai "teach by hand"):
  - raccourcis directs (compat): `c/z/e/.` pour REC/PLAY/SAVE/LOAD Teach
  - `,` / `/`: ralentir / accelerer le replay Teach
  - (fallback) `F9/F10/F11/F12` ou `C/V/B/N` si necessaire
  - Chargement JSON optimise (cache par fichier + format compact)
  - Rearm high-level auto au startup + avant commandes standards si stream sport stale
  - Pendant `Teach REC`, manipuler le robot doucement a la main (mode compliant).
  - IMPORTANT: garder la zone libre, commencer avec amplitudes faibles.
- Reglages dynamiques (en live):
  - `v/b`: vitesse lineaire **moins/plus**
  - `n/h`: distance par appui +/-
  - `o/p`: vitesse yaw +/-
  - `k/j`: angle yaw par appui +/-
  - `u/i`: angle pitch par appui +/-
- `q`: quitter le TUI

Parametres de demarrage du TUI:

```bash
go2ctl --transport dds --iface eth0 --yes tui \
  --profile indoor \
  --linear-speed 0.35 \
  --yaw-speed 0.9 \
  --pitch-speed 0.8 \
  --step-distance 0.16 \
  --step-yaw-deg 12 \
  --step-pitch-deg 6 \
  --control-mode step \
  --hold-timeout 0.24 \
  --sequence-file ./go2_sequence.json \
  --teach-file ./go2_teach.json \
  --teach-speed 1.25 \
  --teach-blend 0.35
```

## Structure du projet

```text
src/go2_cli/
  main.py                 # entrypoint CLI
  cli.py                  # parse argparse
  tui.py                  # mode ncurses teleop + etat
  errors.py               # exceptions metier
  config.py               # config runtime
  transports/
    base.py               # contrat transport
    dds.py                # implementation DDS (SDK2 officiel)
    udp.py                # stub future
    webrtc.py             # stub future
```

## Notes GO2 / Unitree

- Cette CLI s'appuie sur le SDK officiel `unitree_sdk2py`.
- Les commandes posture utilisent le service `sport`.
- Le mode `normal` est tente via `motion_switcher`; si indisponible, la commande continue avec warning (sauf `--strict-normal-mode`).
- Avec Python 3.13, `cyclonedds==0.10.2` peut necessiter `CFLAGS="-D_Py_IsFinalizing=Py_IsFinalizing"` a l'installation.
- Le wheel `unitree_sdk2py` construit depuis le repo peut rater le sous-package `b2`; l'installation editable contourne ce probleme.
- En cas d'echec, verifier d'abord:
  - interface reseau (`--iface`)
  - lien Ethernet
  - services actifs cote robot (sport/motion)





```shell
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --include-joints
```

```shell
python3 scripts/go2_video_webrtc_bridge.py --iface eth0 --port 8081 --fps 15
```

```shell
python3 scripts/go2_control_ws_bridge.py --iface eth0 --host 0.0.0.0 --port 8766
```

.venv/bin/python scripts/go2_control_ws_bridge.py --iface eth0 --port 8766 --posture-guard-s 1.4 --pre-posture-delay-s 0.12



Si `go2ctl` fonctionne mais pas le bridge WS de contrôle, vérifie d'abord les dépendances du Python utilisé:

```bash
python3 -m pip install websockets
```

Et vérifie que le port n'est pas déjà occupé:

```bash
ss -ltnp | rg ':8766'
```

### Dépannage contrôle WebSocket (LiDAR Studio)

Dans l'overlay contrôle, **`send ok` / `ack twist` ne prouvent pas** que le robot bouge : ils indiquent seulement que la commande a été reçue par le bridge. Le vrai mouvement passe par `sport.Move` dans la boucle `move_loop` du bridge.

1. **Robot debout** — `StandUp` via l'overlay (bouton **ClaimPosturePilot** puis **StandUp**) ou `go2ctl stand`.
2. **Un seul processus sur `:8766`** — `ss -ltnp | rg 8766`.
3. **Pas d'app Unitree / télécommande** en parallèle (bloque le mode sport).
4. Lire **`move: OK` / `move: FAIL code=...`** dans l'overlay (pas `send ok`). Les échecs remontent aussi via `robot_error` et `status move_loop`.
5. Logs serveur : `journalctl -u go2-stack -f` ou stdout du bridge (`move_loop: code=...`). Codes fréquents : `4202` (sport non initialisé / robot couché), `7004` (motion_switcher indisponible).
6. **Multi-clients** : tout client connecté peut envoyer `twist` (last-writer-wins). Les postures (`stand_up`, etc.) exigent **ClaimPosturePilot**.
7. Déconnexions **`1011 keepalive ping timeout`** : le stack démarre avec `--ws-ping-interval 0` (`CONTROL_WS_PING_INTERVAL=0` dans `/etc/default/go2-stack`). Le client envoie un ping applicatif `{type:"ping"}` toutes les 2 s.