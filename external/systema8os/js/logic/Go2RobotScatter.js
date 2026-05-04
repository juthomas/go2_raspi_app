/**
 * Go2RobotScatter — représente le robot GO2 dans l'espace Timbre/Pitch.
 *
 * Espace scatter :
 *   X (centroid) : 0=gauche, 1=droite
 *   Y (pitch)    : 0=bas (grave), 1=haut (aigu)
 *
 * Frame ROS du robot :
 *   x = avant, y = gauche, z = haut
 *
 * Mapping choisi (cohérent avec la vue de dessus) :
 *   robot avance (x+) → scatter monte (ny+)
 *   robot va à gauche (y+) → scatter va à gauche (nx-)
 */
export class Go2RobotScatter {
    constructor({ onSendCmd = null, scale = 0.1 } = {}) {
        this.onSendCmd = onSendCmd; // function(msg) → envoie commande WS au pont
        this.scale = scale;         // unités scatter par mètre (0.1 → 10m = largeur totale)

        this.calibOrigin = null;    // { x, y } position monde au moment du calibrage
        this.worldPos    = null;    // { x, y } position monde actuelle
        this.worldYaw    = 0;       // cap actuel (rad, ROS yaw)
        this.scatterPos  = null;    // { nx, ny } position dans l'espace scatter (0..1)

        this.isRecording  = false;
        this._recStart    = 0;
        this.recordedPath = [];     // [{ nx, ny, t }]

        this.isPlaying    = false;
        this.playbackIdx  = 0;
        this._playInterval = null;
    }

    setScale(v) {
        this.scale = Math.max(0.01, Math.min(5.0, Number(v) || 0.1));
    }

    // ── Calibrage ────────────────────────────────────────────────────────────

    calibrate() {
        if (!this.worldPos) return null;
        this.calibOrigin = { x: this.worldPos.x, y: this.worldPos.y };
        return this.calibOrigin;
    }

    // ── Conversions ──────────────────────────────────────────────────────────

    worldToScatter(wx, wy) {
        if (!this.calibOrigin) return null;
        const dx = wx - this.calibOrigin.x; // avant (m)
        const dy = wy - this.calibOrigin.y; // gauche (m)
        return {
            nx: Math.max(0, Math.min(1, 0.5 - dy * this.scale)),
            ny: Math.max(0, Math.min(1, 0.5 + dx * this.scale)),
        };
    }

    scatterToWorld(nx, ny) {
        if (!this.calibOrigin) return null;
        return {
            x: this.calibOrigin.x + (ny - 0.5) / this.scale,
            y: this.calibOrigin.y - (nx - 0.5) / this.scale,
        };
    }

    // ── Mise à jour depuis robot_state ───────────────────────────────────────

    update(robotState) {
        if (!robotState?.position) return;
        const pos = robotState.position;
        this.worldPos = { x: Number(pos[0] ?? 0), y: Number(pos[1] ?? 0) };
        const rpy = robotState.rpy;
        if (Array.isArray(rpy)) this.worldYaw = Number(rpy[2] ?? 0);

        if (this.calibOrigin) {
            this.scatterPos = this.worldToScatter(this.worldPos.x, this.worldPos.y);
            if (this.isRecording && this.scatterPos) {
                const t = Date.now() - this._recStart;
                const last = this.recordedPath[this.recordedPath.length - 1];
                // Décimation spatiale : ajouter seulement si déplacé d'au moins 0.005 unités
                if (!last || Math.hypot(this.scatterPos.nx - last.nx, this.scatterPos.ny - last.ny) > 0.005) {
                    this.recordedPath.push({ nx: this.scatterPos.nx, ny: this.scatterPos.ny, t });
                }
            }
        }
    }

    // ── Enregistrement ───────────────────────────────────────────────────────

    startRec() {
        this.isRecording  = true;
        this._recStart    = Date.now();
        this.recordedPath = [];
    }

    stopRec() {
        this.isRecording = false;
        return this.recordedPath;
    }

    // ── Lecture (playback physique) ──────────────────────────────────────────

    startPlayback() {
        if (this.recordedPath.length < 2) return false;
        this.isPlaying   = true;
        this.playbackIdx = 0;
        return true;
    }

    stopPlayback() {
        this.isPlaying = false;
        this._sendStop();
    }

    /**
     * Appelé à chaque frame d'animation.
     * Calcule la commande de vitesse vers le prochain waypoint (corps du robot).
     * Retourne l'index courant ou -1 si terminé.
     */
    tick() {
        if (!this.isPlaying || !this.worldPos || !this.calibOrigin) return -1;

        const target = this.recordedPath[this.playbackIdx];
        if (!target) {
            this.stopPlayback();
            return -1;
        }

        const targetWorld = this.scatterToWorld(target.nx, target.ny);
        if (!targetWorld) return this.playbackIdx;

        const errX = targetWorld.x - this.worldPos.x; // erreur en avant
        const errY = targetWorld.y - this.worldPos.y; // erreur en gauche
        const dist = Math.hypot(errX, errY);

        if (dist < 0.15) {
            this.playbackIdx++;
            if (this.playbackIdx >= this.recordedPath.length) {
                this.stopPlayback();
                return -1;
            }
            return this.playbackIdx;
        }

        // Rotater l'erreur du repère monde vers le repère corps (yaw)
        const cy = Math.cos(this.worldYaw);
        const sy = Math.sin(this.worldYaw);
        const errXBody =  cy * errX + sy * errY;
        const errYBody = -sy * errX + cy * errY;

        const GAIN    = 1.2;
        const MAX_V   = 0.3;
        let vxRaw = errXBody * GAIN;
        let vyRaw = errYBody * GAIN;
        const norm = Math.hypot(vxRaw, vyRaw);
        if (norm > MAX_V) {
            vxRaw = (vxRaw / norm) * MAX_V;
            vyRaw = (vyRaw / norm) * MAX_V;
        }

        if (this.onSendCmd) {
            this.onSendCmd({ type: "go2_move", vx: vxRaw, vy: vyRaw, vyaw: 0 });
        }

        return this.playbackIdx;
    }

    _sendStop() {
        if (this.onSendCmd) this.onSendCmd({ type: "go2_stop" });
    }
}
