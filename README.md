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

Options utiles:

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
- `x` ou `Espace`: stop d'urgence + vide la queue
- `r`: reset queue (STEP) ou etat hold (HOLD)
- Sequences custom:
  - `R` ou `f`: demarrer/arreter l'enregistrement
  - `P` ou `y`: jouer la sequence en memoire/chargee
  - `K` ou `g`: sauvegarder la sequence en JSON
  - `L` ou `l`: charger la sequence depuis le JSON
- Teach custom (vrai "teach by hand"):
  - `c`: demarrer/arreter la capture Teach
  - `z`: jouer la capture Teach (replay low-level)
  - `e`: sauvegarder le Teach en JSON
  - `.`: charger le Teach depuis JSON
  - (fallback) `F9/F10/F11/F12` ou `C/V/B/N` si necessaire
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
  --teach-file ./go2_teach.json
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
