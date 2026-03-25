export class InputHandler {
    constructor(app) {
        this.app = app;
    }

    setupGamepad() {
        this.gamepadState = { 
            buttons: [],
            cursor: { x: 0.5, y: 0.5 }
        };
        
        const loop = () => {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            const gp = gamepads[0];
            
            if (gp) {
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
                const ltPressed = (typeof gp.buttons[6] === 'number') ? gp.buttons[6] > 0.5 : gp.buttons[6].pressed;
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

                // Right Stick (Axes 2, 3) -> 2D Plan (ScatterPad)
                let rx = gp.axes[2];
                let ry = gp.axes[3];
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
                        // Relative Cursor Movement (Mouse-like)
                        const speed = 0.015;
                        this.gamepadState.cursor.x += rx * speed;
                        this.gamepadState.cursor.y -= ry * speed; // Stick Up (-1) -> Canvas Up (+1)

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