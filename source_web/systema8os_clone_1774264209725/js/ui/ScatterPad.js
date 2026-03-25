export class ScatterPad {
    constructor(store, audioEngine, onHover) {
        this.store = store;
        this.audio = audioEngine;
        this.onHover = onHover; // Callback
        this.canvas = document.getElementById('scatter-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Initial resize
        setTimeout(() => this.resize(), 0);
        window.addEventListener('resize', () => this.resize());
        
        this.playThrottle = 40; // ms - Faster for granular clouds
        this.mouseState = { lastPlayTime: 0 };

        // Automation
        this.automations = []; 
        this.isRecording = false;
        this.recStartTime = 0;
        this.recPath = [];

        // View Transform
        this.panX = 0;
        this.panY = 0;
        this.scale = 1;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.externalCursor = null; // {x, y} normalized

        this.params = {
            duration: 0.35,
            radius: 0.035, 
            random: 0.0,
            volume: 0.8,
            lfoOffset: 0.0
        };

        this.adsr = { a: 0.2, d: 0.2, s: 1.0, r: 0.2 }; // Ratios
        
        this.isSpatialMode = false;

        this.setupInteraction();
        this.initSpatial();
        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    setParams(p) {
        Object.assign(this.params, p);
    }

    setAdsr(a) {
        Object.assign(this.adsr, a);
    }

    toggleSpatialMode() {
        this.isSpatialMode = !this.isSpatialMode;
        return this.isSpatialMode ? "SCATTER: SPATIAL CTRL" : "SCATTER: TIMBRE/PITCH";
    }

    updateSpatialFromStick(dx, dy) {
        // dx, dy are deltas
        // Z is Y on canvas. Stick Up is negative Y. 
        // Spatial Z: -1 is Front (Top), 1 is Back (Bottom)
        // Stick Up (-1) -> dy is negative. We want Z to decrease (move to Front/Top).
        // So Z += dy is correct.
        
        this.spatialState.x = Math.max(-1, Math.min(1, this.spatialState.x + dx));
        this.spatialState.z = Math.max(-1, Math.min(1, this.spatialState.z + dy));
        this.drawSpatial(); // Update mini canvas
    }

    setExternalCursor(nx, ny, isDown) {
        // nx, ny are 0..1 normalized data coords
        if (!this.prevExtCursor) this.prevExtCursor = { x: nx, y: ny };
        if (!this.extState) this.extState = { lastPlayTime: 0 };

        this.externalCursor = { x: nx, y: ny };

        const dNx = nx - this.prevExtCursor.x;
        const dNy = ny - this.prevExtCursor.y;
        
        // Handle Pan (Click/RT + Move) - Mimic Mouse Drag
        if (isDown) {
             // Scale delta roughly to screen pixels for pan
             this.panX += dNx * (this.width * this.scale);
             this.panY -= dNy * (this.height * this.scale); 
        }

        // Record path if recording
        if (this.isRecording) {
             const t = Date.now() - this.recStartTime;
             this.recPath.push({ x: nx - this.params.lfoOffset, y: ny, t: t });
        }

        // Always scan/play if moved or held
        const result = this.scanAt(nx, ny, this.extState); 
        this.hoverPoint = result ? result.closest : null;

        this.prevExtCursor = { x: nx, y: ny };
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Sync internal resolution with display size for precise mouse tracking
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.width = rect.width;
        this.height = rect.height;
    }

    toggleRecordLFO() {
        if (this.isRecording) {
            this.isRecording = false;
            if (this.recPath.length > 5) {
                const dur = Date.now() - this.recStartTime;
                this.automations.push({
                    type: 'path',
                    path: [...this.recPath],
                    duration: dur,
                    startTime: Date.now(), // base for looping
                    state: { lastPlayTime: 0 },
                    color: '#ff00ff'
                });
                return "LFO RECORDED";
            }
            return "LFO DISCARDED (TOO SHORT)";
        } else {
            this.isRecording = true;
            this.recStartTime = Date.now();
            this.recPath = [];
            return "RECORDING LFO...";
        }
    }


    addRandomLFO() {
        this.automations.push({
            type: 'sine',
            state: { lastPlayTime: 0 },
            startTime: Date.now(),
            freqX: 0.0002 + Math.random() * 0.0005,
            freqY: 0.0003 + Math.random() * 0.0006,
            phaseX: Math.random() * Math.PI * 2,
            phaseY: Math.random() * Math.PI * 2,
            color: '#00ffff'
        });
        return "ADDED SINE LFO";
    }

    clearLFOs() {
        this.automations = [];
        this.isRecording = false;
        return "LFOS CLEARED";
    }

    initSpatial() {
        this.spatCanvas = document.getElementById('scatter-spat-canvas');
        this.spatWidthSlider = document.getElementById('scatter-spat-width');
        
        this.spatialState = {
            mode: 'binaural', // Force binaural for this view
            width: 1.0,
            x: 0,
            z: -0.5,
            y: 0,
            jitter: 0
        };

        if(this.spatWidthSlider) {
             this.spatWidthSlider.addEventListener('input', (e) => {
                 this.spatialState.width = parseInt(e.target.value) / 100;
                 this.drawSpatial();
             });
        }

        if(this.spatCanvas) {
            this.spatCtx = this.spatCanvas.getContext('2d');
            let isDragging = false;
            
            const updatePos = (e) => {
                const rect = this.spatCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                this.spatialState.x = Math.max(-1, Math.min(1, (x / rect.width) * 2 - 1));
                this.spatialState.z = Math.max(-1, Math.min(1, (y / rect.height) * 2 - 1));
                this.drawSpatial();
            };

            this.spatCanvas.addEventListener('mousedown', (e) => {
                isDragging = true;
                updatePos(e);
            });
            
            window.addEventListener('mousemove', (e) => {
                if(isDragging) updatePos(e);
            });
            
            window.addEventListener('mouseup', () => {
                isDragging = false;
            });
            
            this.drawSpatial();
        }
    }

    drawSpatial() {
        if(!this.spatCtx) return;
        const ctx = this.spatCtx;
        const w = this.spatCanvas.width;
        const h = this.spatCanvas.height;
        const cx = w/2;
        const cy = h/2;

        ctx.clearRect(0, 0, w, h);
        
        // Head
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.stroke();
        
        // Nose
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 9);
        ctx.lineTo(cx, cy - 14);
        ctx.lineTo(cx + 3, cy - 9);
        ctx.stroke();
        
        // Ears
        ctx.beginPath();
        ctx.arc(cx - 12, cy, 3, 0.5 * Math.PI, 1.5 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + 12, cy, 3, 1.5 * Math.PI, 0.5 * Math.PI);
        ctx.stroke();
        
        // Source
        const sx = (this.spatialState.x + 1) * 0.5 * w;
        const sy = (this.spatialState.z + 1) * 0.5 * h;
        
        const spread = this.spatialState.width * (w/4);
        
        ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
        ctx.beginPath();
        ctx.arc(sx, sy, spread + 3, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = '#FFA500';
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    setupInteraction() {
        // Zoom
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSpeed = 0.1;
            const delta = e.deltaY > 0 ? (1 - zoomSpeed) : (1 + zoomSpeed);
            
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const newScale = Math.max(0.01, Math.min(50, this.scale * delta));
            
            // Adjust pan to zoom towards mouse
            const worldX = (mx - this.panX) / this.scale;
            const worldY = (my - this.panY) / this.scale;
            
            this.panX = mx - worldX * newScale;
            this.panY = my - worldY * newScale;
            this.scale = newScale;
        });

        // Pan Start
        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        });

        // Pan End
        window.addEventListener('mouseup', () => {
            this.isDragging = false;
        });

        // Move / Drag
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            if (this.isDragging) {
                const dx = e.clientX - this.lastMouseX;
                const dy = e.clientY - this.lastMouseY;
                this.panX += dx;
                this.panY += dy;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            }

            // Recording logic
            if (this.isRecording) {
                const nx = (mx - this.panX) / (this.width * this.scale);
                const ny = 1 - ((my - this.panY) / (this.height * this.scale));
                const t = Date.now() - this.recStartTime;
                this.recPath.push({ x: nx - this.params.lfoOffset, y: ny, t: t });
            }

            if (this.store.frames.length > 0) {
                this.handleHover(mx, my);
            }
        });
        
        this.canvas.addEventListener('mouseleave', () => {
            this.hoverPoint = null;
            this.isDragging = false;
            if (this.onHover) this.onHover(null); // Clear 3D cursor
        });
    }

    handleHover(mx, my) {
        const nx = (mx - this.panX) / (this.width * this.scale);
        const ny = 1 - ((my - this.panY) / (this.height * this.scale));
        
        // Use the generic scanner
        const result = this.scanAt(nx, ny, this.mouseState);
        
        this.hoverPoint = result ? result.closest : null;
        if (this.onHover) this.onHover(this.hoverPoint ? this.hoverPoint.index : null);
    }

    scanAt(nx, ny, state, overridePan = null) {
        const searchRadius = this.params.radius; 
        const candidates = [];
        const stride = this.store.frames.length > 10000 ? 5 : 1;
        
        for (let i = 0; i < this.store.frames.length; i += stride) {
            const f = this.store.frames[i];
            if (f.volume < 0.005 || f.pitch <= 0) continue; 

            const logPitch = Math.log2(f.pitch);
            const py = (logPitch - 5) / 6; 
            const px = f.centroid; 

            const dx = nx - px;
            const dy = ny - py;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < searchRadius) {
                candidates.push({ frame: f, x: px, y: py, index: i, dist: dist });
            }
        }

        if (candidates.length === 0) return null;

        // Selection Logic
        candidates.sort((a,b) => a.dist - b.dist);
        const density = 1 + Math.floor(this.params.radius * 40);
        let selection = [];

        if (this.params.random > 0.01) {
            for(let i=0; i<density; i++) {
                if (candidates.length === 0) break;
                const idx = Math.floor(Math.random() * Math.min(candidates.length, 50)); 
                selection.push(candidates[idx]);
            }
        } else {
            selection = candidates.slice(0, density);
        }

        if (selection.length > 0) {
            this.tryPlay(selection, state, overridePan);
            return { closest: selection[0] };
        }
        return null;
    }

    tryPlay(selection, state, overridePan = null) {
        const now = Date.now();
        if (now - state.lastPlayTime > this.playThrottle) {
            const count = selection.length;
            const volScale = Math.min(1.0, 1.2 / Math.sqrt(count));
            
            selection.forEach((item, i) => {
                const frame = item.frame;
                let pan = (frame.centroid - 0.5) * 2;
                if (overridePan !== null) pan = overridePan;

                // Reduced jitter for tighter video sync
                const jitter = Math.random() * 5; 
                
                setTimeout(() => {
                    this.audio.playGrain(
                        frame.time, 
                        this.params.duration, 
                        this.params.volume * volScale, 
                        pan,
                        this.adsr,
                        this.spatialState,
                        { bitmap: frame.bitmap, sourceId: frame.sourceVidId, frame: frame } // Pass context with ID and Frame
                    );
                }, jitter);
            });

            state.lastPlayTime = now;
        }
    }

    loop() {
        requestAnimationFrame(this.loop);
        
        const now = Date.now();

        // Process LFOs
        if (this.automations.length > 0 && this.store.frames.length > 0) {
            this.automations.forEach(lfo => {
                let nx = 0.5, ny = 0.5;
                
                if (lfo.type === 'path') {
                    const t = (now - lfo.startTime) % lfo.duration;
                    let pt = lfo.path[0];
                    for(let i=1; i<lfo.path.length; i++) {
                        if (lfo.path[i].t > t) {
                            const p0 = lfo.path[i-1];
                            const p1 = lfo.path[i];
                            const ratio = (t - p0.t) / (p1.t - p0.t);
                            pt = {
                                x: p0.x + (p1.x - p0.x) * ratio,
                                y: p0.y + (p1.y - p0.y) * ratio
                            };
                            break;
                        }
                    }
                    if (!pt && lfo.path.length > 0) pt = lfo.path[lfo.path.length-1];
                    nx = pt.x;
                    ny = pt.y;
                } else if (lfo.type === 'sine') {
                    nx = 0.5 + Math.sin((now - lfo.startTime) * lfo.freqX + lfo.phaseX) * 0.4;
                    ny = 0.5 + Math.cos((now - lfo.startTime) * lfo.freqY + lfo.phaseY) * 0.4;
                }
                
                // Apply Offset
                nx += this.params.lfoOffset;

                const res = this.scanAt(nx, ny, lfo.state);
                lfo.currentPos = { x: nx, y: ny, hit: !!res };
            });
        }

        this.render();
    }

    render() {
        if (this.isSpatialMode) {
            this.renderSpatialFull();
        } else {
            this.renderScatter();
        }
    }

    renderSpatialFull() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        const cx = w/2;
        const cy = h/2;

        ctx.fillStyle = '#001100';
        ctx.fillRect(0, 0, w, h);

        // Draw Head (Large)
        ctx.strokeStyle = '#0f0';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, 40, 0, Math.PI * 2);
        ctx.stroke();
        
        // Nose
        ctx.beginPath();
        ctx.moveTo(cx - 10, cy - 36);
        ctx.lineTo(cx, cy - 56);
        ctx.lineTo(cx + 10, cy - 36);
        ctx.stroke();
        
        // Ears
        ctx.beginPath();
        ctx.arc(cx - 44, cy, 10, 0.5 * Math.PI, 1.5 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + 44, cy, 10, 1.5 * Math.PI, 0.5 * Math.PI);
        ctx.stroke();
        
        // Source
        const sx = (this.spatialState.x + 1) * 0.5 * w;
        const sy = (this.spatialState.z + 1) * 0.5 * h;
        const spread = this.spatialState.width * (w/4);
        
        // Spread
        ctx.fillStyle = 'rgba(0, 255, 0, 0.1)';
        ctx.beginPath();
        ctx.arc(sx, sy, spread + 10, 0, Math.PI * 2);
        ctx.fill();
        
        // Center
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.fill();

        // Labels
        ctx.fillStyle = '#0f0';
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText("SPATIAL MODE (RIGHT STICK)", cx, h - 20);
        ctx.fillText("FRONT", cx, 20);
    }

    renderScatter() {
        // Clear
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Grid
        this.ctx.strokeStyle = '#222';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        for(let i=0; i<10; i++) {
            this.ctx.moveTo(i * this.width/10, 0);
            this.ctx.lineTo(i * this.width/10, this.height);
            this.ctx.moveTo(0, i * this.height/10);
            this.ctx.lineTo(this.width, i * this.height/10);
        }
        this.ctx.stroke();

        // Points
        const frames = this.store.frames;
        if (frames.length === 0) {
            this.ctx.fillStyle = '#444';
            this.ctx.font = '20px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.fillText("NO DATA", this.width/2, this.height/2);
            return;
        }

        // Draw batch
        const stride = frames.length > 5000 ? Math.ceil(frames.length / 5000) : 1;

        for (let i = 0; i < frames.length; i += stride) {
            const f = frames[i];
            if (f.volume < 0.02 || f.pitch <= 0) continue;

            const logPitch = Math.log2(f.pitch);
            const py = (logPitch - 5) / 6; 
            const px = f.centroid;

            const cx = (px * this.width * this.scale) + this.panX;
            const cy = ((1 - py) * this.height * this.scale) + this.panY;
            
            if (cx < -10 || cx > this.width + 10 || cy < -10 || cy > this.height + 10) continue;

            if (this.hoverPoint && this.hoverPoint.frame === f) {
                this.ctx.fillStyle = '#fff';
                this.ctx.beginPath();
                this.ctx.arc(cx, cy, 4, 0, Math.PI*2);
                this.ctx.fill();
            } else {
                const hue = ((logPitch * 12) % 12) / 12 * 360;
                this.ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
                const size = Math.min(10, Math.max(2, this.scale * 1.5));
                this.ctx.fillRect(cx - size/2, cy - size/2, size, size);
            }
        }

        // Crosshair for hover
        if (this.hoverPoint) {
            const cx = (this.hoverPoint.x * this.width * this.scale) + this.panX;
            const cy = ((1 - this.hoverPoint.y) * this.height * this.scale) + this.panY;
            
            this.ctx.strokeStyle = '#fff';
            this.ctx.beginPath();
            this.ctx.moveTo(0, cy);
            this.ctx.lineTo(this.width, cy);
            this.ctx.moveTo(cx, 0);
            this.ctx.lineTo(cx, this.height);
            this.ctx.stroke();

            this.ctx.fillStyle = '#fff';
            this.ctx.font = '10px monospace';
            this.ctx.textAlign = 'left';
            this.ctx.fillText(`${Math.round(this.hoverPoint.frame.pitch)}Hz`, 5, 15);
            this.ctx.fillText(`${this.hoverPoint.frame.note}`, 5, 25);
        }

        // Draw External Cursor (Joystick)
        if (this.externalCursor) {
            const cx = (this.externalCursor.x * this.width * this.scale) + this.panX;
            const cy = ((1 - this.externalCursor.y) * this.height * this.scale) + this.panY;
            
            this.ctx.strokeStyle = '#00ffff';
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, 15, 0, Math.PI * 2);
            this.ctx.moveTo(cx - 5, cy);
            this.ctx.lineTo(cx + 5, cy);
            this.ctx.moveTo(cx, cy - 5);
            this.ctx.lineTo(cx, cy + 5);
            this.ctx.stroke();
        }

        // Draw Automations
        this.automations.forEach(lfo => {
            if (lfo.currentPos) {
                const cx = (lfo.currentPos.x * this.width * this.scale) + this.panX;
                const cy = ((1 - lfo.currentPos.y) * this.height * this.scale) + this.panY;
                
                this.ctx.strokeStyle = lfo.color;
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.arc(cx, cy, 10, 0, Math.PI*2);
                this.ctx.stroke();

                if (lfo.currentPos.hit) {
                    this.ctx.fillStyle = lfo.color;
                    this.ctx.beginPath();
                    this.ctx.arc(cx, cy, 5, 0, Math.PI*2);
                    this.ctx.fill();
                }
            }
        });

        if (this.isRecording) {
            this.ctx.fillStyle = '#ff0000';
            this.ctx.beginPath();
            this.ctx.arc(20, 20, 8, 0, Math.PI*2);
            this.ctx.fill();
            this.ctx.fillStyle = '#fff';
            this.ctx.fillText("REC LFO", 35, 24);
        }
    }
}

