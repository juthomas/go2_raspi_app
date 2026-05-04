/**
 * Client WebSocket pour go2_control_ws_bridge.py (port 8766).
 * Gère : connexion/reconnexion, claim_pilot, twist loop, REC/PLAY commandes, clavier flèches.
 */

export class Go2ControlClient {
    constructor({ onStatus = null, onPilot = null, onSeqUpdate = null } = {}) {
        this._ws              = null;
        this._url             = '';
        this._shouldReconnect = false;
        this._reconnectTimer  = null;
        this._reconnectCount  = 0;

        this.connected = false;
        this.pilot     = false;

        // Vitesses courantes
        this._vx   = 0;
        this._vy   = 0;
        this._vyaw = 0;

        // Boucle twist 80 ms
        this._twistTimer = null;

        // Enregistrement / lecture
        this.isRecording = false;
        this.isPlaying   = false;
        this._recBuf     = null;   // { entries: [], lastTs: number }
        this._sequence   = [];     // [{ dt, vx, vy, vyaw }]
        this._playIds    = [];     // setTimeout IDs pour annuler la lecture

        // Clavier (flèches) — activé via toggleKeyboard()
        this._kbActive   = false;
        this._pressed    = { up: false, down: false, left: false, right: false };
        this._onKeyDown  = this._handleKeyDown.bind(this);
        this._onKeyUp    = this._handleKeyUp.bind(this);
        this._onBlur     = this._handleBlur.bind(this);

        // Callbacks
        this.onStatus    = onStatus;    // (text, ok) => void
        this.onPilot     = onPilot;     // (isPilot) => void
        this.onSeqUpdate = onSeqUpdate; // (sequence) => void
    }

    // ── Connexion ─────────────────────────────────────────────────────────────

    connect(url) {
        this._url             = url.trim();
        this._shouldReconnect = true;
        this._reconnectCount  = 0;
        this._clearReconnect();
        this._openSocket();
    }

    disconnect() {
        this._shouldReconnect = false;
        this._clearReconnect();
        this._closeSocket();
        this._stopTwistLoop();
        this._stopPlay();
        this.connected = false;
        this.pilot     = false;
        this._setStatus('OFF', false);
        this.onPilot?.(false);
    }

    send(payload) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
        try { this._ws.send(JSON.stringify(payload)); return true; } catch (_) { return false; }
    }

    _openSocket() {
        this._closeSocket();
        if (!this._url) { this._setStatus('URL vide', false); return; }
        let ws;
        try { ws = new WebSocket(this._url); } catch (e) { this._setStatus(String(e), false); return; }
        this._ws = ws;

        ws.onopen = () => {
            this._reconnectCount = 0;
            this.connected = true;
            this._setStatus('WS connecté — claim pilot…', true);
            this.send({ type: 'claim_pilot' });
            this._startTwistLoop();
        };
        ws.onclose = () => {
            this.connected = false;
            this.pilot     = false;
            this._ws       = null;
            this._stopTwistLoop();
            this._setStatus('WS fermé', false);
            this.onPilot?.(false);
            if (this._shouldReconnect) this._scheduleReconnect();
        };
        ws.onerror = () => this._setStatus('Erreur WS', false);
        ws.onmessage = (ev) => this._onMessage(ev.data);
    }

    _closeSocket() {
        if (!this._ws) return;
        try { this._ws.close(); } catch (_) {}
        this._ws = null;
    }

    _scheduleReconnect() {
        this._clearReconnect();
        this._reconnectCount++;
        const delay = Math.min(5000, 500 * Math.pow(2, Math.min(this._reconnectCount - 1, 4)));
        this._setStatus(`Reconnexion dans ${(delay / 1000).toFixed(1)}s…`, null);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._shouldReconnect) this._openSocket();
        }, delay);
    }

    _clearReconnect() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    }

    // ── Messages entrants ─────────────────────────────────────────────────────

    _onMessage(raw) {
        let data;
        try { data = JSON.parse(raw); } catch (_) { return; }
        if (data.type === 'hello') {
            this._setStatus(`Pont: ${data.bridge ?? 'control'} (iface ${data.iface ?? '?'})`, true);
        } else if (data.type === 'ack') {
            if (data.cmd === 'claim_pilot') {
                this.pilot = Boolean(data.ok);
                this.onPilot?.(this.pilot);
                this._setStatus(this.pilot ? 'Pilot accordé ✓' : `Pilot refusé: ${data.msg ?? ''}`, this.pilot);
            }
        } else if (data.type === 'status') {
            this.pilot = Boolean(data.pilot);
            this.onPilot?.(this.pilot);
        } else if (data.type === 'error') {
            this._setStatus(`Erreur: ${data.msg ?? '?'}`, false);
        }
    }

    _setStatus(text, ok) {
        this.onStatus?.(text, ok);
    }

    // ── Boucle twist ──────────────────────────────────────────────────────────

    _startTwistLoop() {
        this._stopTwistLoop();
        this._twistTimer = setInterval(() => {
            if (!this.connected || !this.pilot || this.isPlaying) return;
            this.send({ type: 'twist', vx: this._vx, vy: this._vy, vyaw: this._vyaw });

            if (this.isRecording && this._recBuf) {
                const now = performance.now();
                const dt  = now - this._recBuf.lastTs;
                this._recBuf.lastTs = now;
                this._recBuf.entries.push({ dt, vx: this._vx, vy: this._vy, vyaw: this._vyaw });
            }
        }, 80);
    }

    _stopTwistLoop() {
        if (this._twistTimer) { clearInterval(this._twistTimer); this._twistTimer = null; }
    }

    // ── Cible de vitesse ──────────────────────────────────────────────────────

    setTarget(vx, vy, vyaw) {
        this._vx = vx; this._vy = vy; this._vyaw = vyaw;
    }

    stop() {
        this.setTarget(0, 0, 0);
        this.send({ type: 'stop' });
    }

    // ── REC / PLAY ────────────────────────────────────────────────────────────

    startRec() {
        this._sequence   = [];
        this.isRecording = true;
        this._recBuf     = { entries: [], lastTs: performance.now() };
        this.onSeqUpdate?.(this._sequence);
    }

    stopRec() {
        this.isRecording = false;
        if (this._recBuf) { this._sequence = this._recBuf.entries; this._recBuf = null; }
        this.stop();
        this.onSeqUpdate?.(this._sequence);
        return this._sequence;
    }

    startPlay() {
        if (!this._sequence.length || this.isPlaying) return false;
        this.isPlaying = true;
        let elapsed    = 0;
        const ids      = [];
        for (const entry of this._sequence) {
            elapsed += entry.dt;
            const id = setTimeout(() => {
                this.send({ type: 'twist', vx: entry.vx, vy: entry.vy, vyaw: entry.vyaw });
            }, elapsed);
            ids.push(id);
        }
        const endId = setTimeout(() => {
            this.stop();
            this.isPlaying = false;
            this._playIds  = [];
            this.onSeqUpdate?.(this._sequence);
        }, elapsed + 200);
        ids.push(endId);
        this._playIds = ids;
        this.onSeqUpdate?.(this._sequence);
        return true;
    }

    _stopPlay() {
        for (const id of this._playIds) clearTimeout(id);
        this._playIds  = [];
        this.isPlaying = false;
    }

    stopPlay() {
        this._stopPlay();
        this.stop();
        this.onSeqUpdate?.(this._sequence);
    }

    get sequenceDurationMs() {
        return this._sequence.reduce((s, e) => s + e.dt, 0);
    }

    get sequenceLength() { return this._sequence.length; }

    // ── Clavier flèches ───────────────────────────────────────────────────────

    toggleKeyboard(active, speedVx, speedVyaw) {
        this._kbActive = active;
        if (active) {
            window.addEventListener('keydown', this._onKeyDown);
            window.addEventListener('keyup',   this._onKeyUp);
            window.addEventListener('blur',    this._onBlur);
        } else {
            window.removeEventListener('keydown', this._onKeyDown);
            window.removeEventListener('keyup',   this._onKeyUp);
            window.removeEventListener('blur',    this._onBlur);
            this._pressed = { up: false, down: false, left: false, right: false };
            this._updateTargetFromKeys(speedVx ?? 0.25, speedVyaw ?? 0.7);
        }
    }

    _handleKeyDown(e) {
        if (this.isPlaying) return;
        const tag = e.target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        let changed = false;
        if (e.key === 'ArrowUp')    { e.preventDefault(); this._pressed.up    = true;  changed = true; }
        if (e.key === 'ArrowDown')  { e.preventDefault(); this._pressed.down  = true;  changed = true; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); this._pressed.left  = true;  changed = true; }
        if (e.key === 'ArrowRight') { e.preventDefault(); this._pressed.right = true;  changed = true; }
        if ((e.key === ' ' || e.key === 'x' || e.key === 'X') && !tag) {
            e.preventDefault();
            this._pressed = { up: false, down: false, left: false, right: false };
            this.stop();
            changed = false;
        }
        if (changed) this._updateTargetFromKeys(this._speedVx, this._speedVyaw);
    }

    _handleKeyUp(e) {
        let changed = false;
        if (e.key === 'ArrowUp')    { this._pressed.up    = false; changed = true; }
        if (e.key === 'ArrowDown')  { this._pressed.down  = false; changed = true; }
        if (e.key === 'ArrowLeft')  { this._pressed.left  = false; changed = true; }
        if (e.key === 'ArrowRight') { this._pressed.right = false; changed = true; }
        if (changed) this._updateTargetFromKeys(this._speedVx, this._speedVyaw);
    }

    _handleBlur() {
        this._pressed = { up: false, down: false, left: false, right: false };
        this.setTarget(0, 0, 0);
    }

    _updateTargetFromKeys(speedVx, speedVyaw) {
        this._speedVx   = speedVx;
        this._speedVyaw = speedVyaw;
        const vx   = (this._pressed.up   ? 1 : 0) * speedVx - (this._pressed.down  ? 1 : 0) * speedVx;
        const vyaw = (this._pressed.left ? 1 : 0) * speedVyaw - (this._pressed.right ? 1 : 0) * speedVyaw;
        this.setTarget(vx, 0, vyaw);
    }
}
