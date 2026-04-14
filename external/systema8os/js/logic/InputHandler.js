/** Logs console si ?gpdebug=1 ou localStorage go2_gpdebug=1 */
function gamepadDebugEnabled() {
    try {
        if (new URLSearchParams(location.search).get("gpdebug") === "1") return true;
        if (localStorage.getItem("go2_gpdebug") === "1") return true;
    } catch (_) {}
    return false;
}

export class InputHandler {
    constructor(app) {
        this.app = app;
        /** Index préféré après gamepadconnected ; sinon première entrée non nulle. */
        this._gamepadPreferredIndex = null;
        this._gpDebug = gamepadDebugEnabled();
        this._gpFrame = 0;
        this._gpNoPadLogged = false;
        this._gpHadPad = false;
    }

    /**
     * getGamepads()[0] est souvent null alors qu’une manette (ex. Xbox) est en [1] ou plus
     * — le testeur OS peut lister la manette mais le site ne réagissait pas.
     */
    _pickGamepad(gamepads) {
        if (!gamepads) return null;
        const pref = this._gamepadPreferredIndex;
        if (pref != null && gamepads[pref]) return gamepads[pref];
        // GamepadList : length peut être 0 sur certains navigateurs tant qu’aucun slot n’est utilisé
        const n = Math.max(gamepads.length || 0, 8);
        for (let i = 0; i < n; i++) {
            if (gamepads[i]) return gamepads[i];
        }
        return null;
    }

    setupGamepad() {
        this.gamepadState = { 
            buttons: [],
            cursor: { x: 0.5, y: 0.5 }
        };

        window.addEventListener('gamepadconnected', (e) => {
            this._gamepadPreferredIndex = e.gamepad.index;
            const st = document.getElementById('status');
            if (st) st.innerText = `MANETTE: ${e.gamepad.id.slice(0, 48)}`;
            const g = e.gamepad;
            console.info("[Gamepad] gamepadconnected", {
                id: g.id?.slice?.(0, 80) ?? g.id,
                index: g.index,
                mapping: g.mapping,
                axes: g.axes?.length,
                buttons: g.buttons?.length,
            });
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            console.info("[Gamepad] gamepaddisconnected", e.gamepad?.id, "index", e.gamepad?.index);
            if (e.gamepad.index === this._gamepadPreferredIndex) {
                this._gamepadPreferredIndex = null;
            }
        });

        console.info("[Gamepad] init", {
            getGamepads: typeof navigator.getGamepads,
            secureContext: window.isSecureContext,
            href: location.href,
            hint: "Ouvre avec ?gpdebug=1 pour des logs détaillés. Manette souvent invisible jusqu'à un bouton appuyé.",
        });

        window.dumpGamepads = () => {
            const list = navigator.getGamepads ? navigator.getGamepads() : null;
            const rows = [];
            const n = Math.max(list?.length || 0, 8);
            for (let i = 0; i < n; i++) {
                const g = list?.[i];
                rows.push({
                    slot: i,
                    connected: !!g,
                    id: g ? (g.id?.slice?.(0, 60) ?? String(g.id)) : "—",
                    mapping: g?.mapping ?? "—",
                });
            }
            console.table(rows);
            return rows;
        };

        // Aide Chrome/Android : premier tap/clavier “réveille” parfois getGamepads()
        const prime = () => {
            try {
                if (navigator.getGamepads) navigator.getGamepads();
            } catch (_) {}
        };
        window.addEventListener("pointerdown", prime, { once: true, passive: true });
        window.addEventListener("keydown", prime, { once: true });
        
        const loop = () => {
            this._gpFrame++;
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            const gp = this._pickGamepad(gamepads);

            if (this._gpDebug && this._gpFrame % 120 === 1) {
                const snap = [];
                const n = Math.max(gamepads?.length || 0, 8);
                for (let i = 0; i < n; i++) {
                    const gi = gamepads[i];
                    snap.push(gi ? `[${i}] ${gi.id?.slice?.(0, 40) ?? ""}` : `[${i}] null`);
                }
                console.log("[Gamepad] getGamepads snapshot", snap.join(" | "));
            }

            if (!gp && !this._gpNoPadLogged && this._gpFrame > 300) {
                this._gpNoPadLogged = true;
                console.warn(
                    "[Gamepad] Aucune manette vue par la page après ~5s. Causes fréquentes: 1) appuyer sur un bouton sur la manette 2) fenêtre au premier plan 3) autre PC = la manette est sur le PC local, pas sur la machine qui affiche le site — brancher la manette sur le PC où tourne le navigateur."
                );
            }

            if (gp) {
                if (!this._gpHadPad) {
                    this._gpHadPad = true;
                    console.info("[Gamepad] première frame active", {
                        id: gp.id?.slice?.(0, 80),
                        index: gp.index,
                        mapping: gp.mapping,
                    });
                }
                // Button 0 (A) -> Clear
                if (gp.buttons[0] && gp.buttons[0].pressed && !this.gamepadState.buttons[0]) {
                    if (this.app.ui.btnClear) this.app.ui.btnClear.click();
                }
                this.gamepadState.buttons[0] = gp.buttons[0] ? gp.buttons[0].pressed : false;

                // Button 1 (B) -> Trans
                if (gp.buttons[1] && gp.buttons[1].pressed && !this.gamepadState.buttons[1]) {
                    if (this.app.ui.btnTrans) this.app.ui.btnTrans.click();
                }
                this.gamepadState.buttons[1] = gp.buttons[1] ? gp.buttons[1].pressed : false;

                // Button 2 (X) -> Rec/Mic
                if (gp.buttons[2] && gp.buttons[2].pressed && !this.gamepadState.buttons[2]) {
                    if (this.app.ui.btnMic) this.app.ui.btnMic.click();
                }
                this.gamepadState.buttons[2] = gp.buttons[2] ? gp.buttons[2].pressed : false;

                // Button 3 (Y) -> Clear LFOs (Scatter)
                if (gp.buttons[3] && gp.buttons[3].pressed && !this.gamepadState.buttons[3]) {
                     if (this.app.scatterPad) {
                         const msg = this.app.scatterPad.clearLFOs();
                         this.app.ui.status.innerText = msg;
                     }
                }
                this.gamepadState.buttons[3] = gp.buttons[3] ? gp.buttons[3].pressed : false;

                // Button 4 (LB) -> Toggle Rec Spatial
                if (gp.buttons[4] && gp.buttons[4].pressed && !this.gamepadState.buttons[4]) {
                     if (this.app.ui.spatialPanel) {
                         const msg = this.app.ui.spatialPanel.toggleRecord();
                         this.app.ui.status.innerText = msg;
                     }
                }
                this.gamepadState.buttons[4] = gp.buttons[4] ? gp.buttons[4].pressed : false;

                // Button 5 (RB) -> Toggle LFO Rec (Scatter)
                if (gp.buttons[5] && gp.buttons[5].pressed && !this.gamepadState.buttons[5]) {
                     if (this.app.scatterPad) {
                         const msg = this.app.scatterPad.toggleRecordLFO();
                         this.app.ui.status.innerText = msg;
                     }
                }
                this.gamepadState.buttons[5] = gp.buttons[5] ? gp.buttons[5].pressed : false;

                // Button 6 (LT) -> Clear Spatial
                const b6 = gp.buttons[6];
                const ltPressed = b6
                    ? typeof b6 === "number"
                        ? b6 > 0.5
                        : (b6.pressed || b6.value > 0.5)
                    : false;
                if (ltPressed && !this.gamepadState.buttons[6]) {
                     if (this.app.ui.spatialPanel) {
                         const msg = this.app.ui.spatialPanel.clearRecord();
                         this.app.ui.status.innerText = msg;
                     }
                }
                this.gamepadState.buttons[6] = ltPressed;

                // Button 7 (RT) -> Rec Video
                let rtVal = 0;
                if (gp.buttons[7]) {
                    rtVal = (typeof gp.buttons[7] === 'number') ? gp.buttons[7] : gp.buttons[7].value;
                }
                const isRtPressed = rtVal > 0.5;

                if (isRtPressed && !this.gamepadState.buttons[7]) {
                    const btn = document.getElementById('btn-rec-vid');
                    if (btn) btn.click();
                }
                this.gamepadState.buttons[7] = isRtPressed;

                // Button 12 (D-Pad Up) -> Toggle Library
                if (gp.buttons[12] && gp.buttons[12].pressed && !this.gamepadState.buttons[12]) {
                     if (this.app.ui.libraryPanel) this.app.ui.libraryPanel.toggle();
                }
                this.gamepadState.buttons[12] = gp.buttons[12] ? gp.buttons[12].pressed : false;

                // Button 13 (D-Pad Down) -> Key 5 (3D View)
                if (gp.buttons[13] && gp.buttons[13].pressed && !this.gamepadState.buttons[13]) {
                    this.app.toggleView('3d');
                }
                this.gamepadState.buttons[13] = gp.buttons[13] ? gp.buttons[13].pressed : false;

                // Button 14 (D-Pad Left) -> Key 4 (2D View)
                if (gp.buttons[14] && gp.buttons[14].pressed && !this.gamepadState.buttons[14]) {
                    this.app.toggleView('2d');
                }
                this.gamepadState.buttons[14] = gp.buttons[14] ? gp.buttons[14].pressed : false;

                // Button 15 (D-Pad Right) -> Toggle ScatterPad Spatial Mode
                if (gp.buttons[15] && gp.buttons[15].pressed && !this.gamepadState.buttons[15]) {
                    if (this.app.scatterPad) {
                        const msg = this.app.scatterPad.toggleSpatialMode();
                        this.app.ui.status.innerText = msg;
                    }
                }
                this.gamepadState.buttons[15] = gp.buttons[15] ? gp.buttons[15].pressed : false;

                const deadzone = 0.15;

                // Left Stick (Axes 0, 1) -> Spatial
                let lx = gp.axes[0];
                let ly = gp.axes[1];
                if (Math.abs(lx) < deadzone) lx = 0;
                if (Math.abs(ly) < deadzone) ly = 0;

                if (this.app.ui.spatialPanel) {
                    this.app.ui.spatialPanel.setExternalPos(lx, ly);
                }

                // Right Stick (axes 2–3 standard ; certains pads exposent 3–4)
                let rx = gp.axes.length > 2 ? gp.axes[2] : 0;
                let ry = gp.axes.length > 3 ? gp.axes[3] : 0;
                if (gp.axes.length > 5 && Math.abs(rx) < 1e-6 && Math.abs(ry) < 1e-6) {
                    rx = gp.axes[3];
                    ry = gp.axes[4];
                }
                if (Math.abs(rx) < deadzone) rx = 0;
                if (Math.abs(ry) < deadzone) ry = 0;

                if (this.app.scatterPad) {
                    if (this.app.scatterPad.isSpatialMode) {
                        // Spatial Mode Control
                        const speed = 0.02;
                        // Map Stick Y (Up=-1) to Canvas Y (Top=0/-1)
                        // Stick Up (-1) should move Z towards -1 (Front/Top)
                        this.app.scatterPad.updateSpatialFromStick(rx * speed, ry * speed);
                    } else {
                        // Relative Cursor Movement (Mouse-like) — rester en 0..1 pour scanAt
                        const speed = 0.015;
                        this.gamepadState.cursor.x += rx * speed;
                        this.gamepadState.cursor.y -= ry * speed; // Stick Up (-1) -> Canvas Up (+1)
                        this.gamepadState.cursor.x = Math.max(0, Math.min(1, this.gamepadState.cursor.x));
                        this.gamepadState.cursor.y = Math.max(0, Math.min(1, this.gamepadState.cursor.y));

                        this.app.scatterPad.setExternalCursor(
                            this.gamepadState.cursor.x, 
                            this.gamepadState.cursor.y, 
                            false
                        );
                    }
                }
            }
            requestAnimationFrame(loop);
        };
        loop();
    }

    setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            switch(e.code) {
                case 'Space':
                    this.app.togglePlayback();
                    break;
                case 'KeyR':
                    this.app.sceneMgr.controls.reset();
                    break;
                case 'KeyM':
                    const muted = this.app.audio.toggleMute();
                    document.getElementById('status').innerText = muted ? "MUTED" : "ACTIVE";
                    break;
                case 'KeyF':
                    if (!document.fullscreenElement) {
                        document.documentElement.requestFullscreen().catch(e => console.log(e));
                    } else {
                        if (document.exitFullscreen) document.exitFullscreen();
                    }
                    break;
                case 'KeyU':
                    document.getElementById('blackout').classList.toggle('active');
                    break;
                case 'KeyC':
                    this.app.ui.btnClear.click();
                    break;
                case 'KeyP':
                    if (this.app.exportMgr) {
                        this.app.exportMgr.exportCodeAsText();
                    }
                    break;
            }
            
            if (e.key === '+') {
                const btn = document.getElementById('btn-rec-vid');
                if (btn) btn.click();
            }
        });
    }

    setupMouse() {
        window.addEventListener('mousemove', (e) => {
            if (e.target.closest('#ui-layer')) return;
            if (this.app.isAnalyzing) return; 

            const obj = this.app.sceneMgr.getClickedObject(e, [this.app.visualizer.instancedMesh]);
            
            if (obj) {
                const instanceId = obj.instanceId;
                if (instanceId !== undefined && instanceId < this.app.store.frames.length) {
                    const frame = this.app.store.frames[instanceId];
                    this.app.visualizer.setCursor(instanceId);

                    const now = Date.now();
                    if (!this.app.lastGrainPlay || now - this.app.lastGrainPlay > 50) {
                        const pan = (frame.centroid - 0.5) * 2;
                        this.app.audio.playGrain(frame.time, 0.2, 0.8, pan, null, null, { bitmap: frame.bitmap, sourceId: frame.sourceVidId, frame: frame });
                        document.getElementById('status').innerText = `GRAIN: ${Math.round(frame.pitch)}Hz`;
                        this.app.lastGrainPlay = now;
                    }
                }
            } else {
                this.app.visualizer.setCursor(null);
                this.app.sceneMgr.stopFocus();
            }
        });
    }
}