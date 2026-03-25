export class SpatialPanel {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.elements = {
            mode: document.getElementById('spat-mode'),
            width: document.getElementById('spat-width'),
            height: document.getElementById('spat-height'),
            move: document.getElementById('spat-move'),
            jitter: document.getElementById('spat-jitter'),
            canvas: document.getElementById('spatial-canvas')
        };
        
        // Source Position (Normalized -1 to 1)
        this.pos = { x: 0, z: 0, y: 0 }; 
        this.headPos = { x: 0, z: 0 }; // Listener
        
        this.isDragging = false;
        this.dragTarget = 'source'; 
        this.autoSpeed = 0;

        // Automation / Recording
        this.recordingState = {
            active: false,
            startTime: 0,
            path: []
        };
        this.automation = null;
        
        this.ctx = this.elements.canvas ? this.elements.canvas.getContext('2d') : null;
        
        this.init();
        this.animate();
    }

    init() {
        const { mode, width, height, move, jitter, canvas } = this.elements;

        if (mode) mode.addEventListener('change', () => this.updateParams());
        if (width) width.addEventListener('input', () => this.updateParams());
        if (height) height.addEventListener('input', () => this.updateParams());
        if (move) move.addEventListener('input', (e) => {
            this.autoSpeed = parseInt(e.target.value) / 100;
        });
        if (jitter) jitter.addEventListener('input', () => this.updateParams());
        
        if (canvas) {
            canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
            window.addEventListener('mousemove', (e) => this.onMouseMove(e));
            window.addEventListener('mouseup', () => this.onMouseUp());
            this.draw();
        }

        // Init default
        this.updateParams();
    }

    onMouseDown(e) {
        this.isDragging = true;
        
        const rect = this.elements.canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) / rect.width * 2 - 1;
        const my = (e.clientY - rect.top) / rect.height * 2 - 1;

        const distHead = Math.sqrt(Math.pow(mx - this.headPos.x, 2) + Math.pow(my - this.headPos.z, 2));
        
        // Prefer head if close (0.2 radius approx)
        if (distHead < 0.2) {
            this.dragTarget = 'head';
        } else {
            this.dragTarget = 'source';
        }

        this.updatePosFromMouse(e);
    }

    onMouseMove(e) {
        if (!this.isDragging) return;
        this.updatePosFromMouse(e);
        this.recordPoint();
    }

    onMouseUp() {
        this.isDragging = false;
    }

    updatePosFromMouse(e) {
        const rect = this.elements.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const nx = (x / rect.width) * 2 - 1;
        const nz = (y / rect.height) * 2 - 1;
        
        if (this.dragTarget === 'head') {
            this.headPos.x = Math.max(-1, Math.min(1, nx));
            this.headPos.z = Math.max(-1, Math.min(1, nz));
        } else {
            this.pos.x = Math.max(-1, Math.min(1, nx));
            this.pos.z = Math.max(-1, Math.min(1, nz));
        }
        
        this.draw();
        this.updateParams();
    }

    recordPoint() {
        if (this.recordingState.active && this.dragTarget === 'source') {
            const t = Date.now() - this.recordingState.startTime;
            this.recordingState.path.push({ x: this.pos.x, z: this.pos.z, t });
        }
    }

    toggleRecord() {
        if (this.recordingState.active) {
            // Stop Recording
            this.recordingState.active = false;
            if (this.recordingState.path.length > 1) {
                const duration = Date.now() - this.recordingState.startTime;
                this.automation = {
                    path: [...this.recordingState.path],
                    duration: duration,
                    startTime: Date.now()
                };
                return "SPATIAL LOOP RECORDED";
            }
            return "SPATIAL REC TOO SHORT";
        } else {
            // Start Recording
            this.recordingState.active = true;
            this.recordingState.startTime = Date.now();
            this.recordingState.path = [];
            this.automation = null;
            return "REC SPATIAL MOVEMENT...";
        }
    }

    clearRecord() {
        this.recordingState.active = false;
        this.automation = null;
        return "SPATIAL CLEARED";
    }

    draw() {
        if (!this.ctx) return;
        const w = this.elements.canvas.width;
        const h = this.elements.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        // Calc Head Canvas Pos
        const hx = (this.headPos.x + 1) * 0.5 * w;
        const hy = (this.headPos.z + 1) * 0.5 * h;

        // Draw Head
        ctx.strokeStyle = '#0f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy, 20, 0, Math.PI * 2);
        ctx.stroke();

        // Nose (Pointing Up / Front / -Z)
        ctx.beginPath();
        ctx.moveTo(hx - 5, hy - 18);
        ctx.lineTo(hx, hy - 28);
        ctx.lineTo(hx + 5, hy - 18);
        ctx.stroke();
        
        // Ears
        ctx.beginPath();
        ctx.arc(hx - 22, hy, 5, 0.5 * Math.PI, 1.5 * Math.PI); // Left
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx + 22, hy, 5, 1.5 * Math.PI, 0.5 * Math.PI); // Right
        ctx.stroke();

        // Draw Source
        // Map -1..1 to canvas coords
        const sx = (this.pos.x + 1) * 0.5 * w;
        const sy = (this.pos.z + 1) * 0.5 * h;

        // Spread Visual (Width)
        const spread = (parseInt(this.elements.width.value) / 100) * (w / 4);
        ctx.fillStyle = 'rgba(0, 255, 255, 0.1)';
        ctx.beginPath();
        ctx.arc(sx, sy, spread + 5, 0, Math.PI * 2);
        ctx.fill();

        // Point
        ctx.fillStyle = '#0ff';
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
        
        // Labels
        const cx = w / 2;
        const cy = h / 2;

        ctx.fillStyle = '#444';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText("FRONT", cx, 10);
        ctx.fillText("BACK", cx, h - 5);
        ctx.textAlign = 'left';
        ctx.fillText("L", 5, cy);
        ctx.textAlign = 'right';
        ctx.fillText("R", w - 5, cy);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        if (this.isDragging) return;

        // Automation Playback
        if (!this.recordingState.active && this.automation) {
            const now = Date.now();
            const t = (now - this.automation.startTime) % this.automation.duration;
            
            const path = this.automation.path;
            if (path.length > 0) {
                let p0 = path[0];
                let p1 = path[0];
                
                for (let i = 0; i < path.length - 1; i++) {
                    if (t >= path[i].t && t < path[i+1].t) {
                        p0 = path[i];
                        p1 = path[i+1];
                        break;
                    }
                }
                
                if (p1.t > p0.t) {
                    const alpha = (t - p0.t) / (p1.t - p0.t);
                    this.pos.x = p0.x + (p1.x - p0.x) * alpha;
                    this.pos.z = p0.z + (p1.z - p0.z) * alpha;
                } else {
                    this.pos.x = p0.x;
                    this.pos.z = p0.z;
                }

                this.draw();
                this.updateParams();
            }
            return;
        }

        // Auto LFO (Circular)
        if (this.autoSpeed > 0 && !this.recordingState.active) {
            const time = Date.now() * 0.001;
            const speed = this.autoSpeed * 2.0;
            const radius = 0.8;
            
            this.pos.x = Math.sin(time * speed) * radius;
            this.pos.z = Math.cos(time * speed) * radius;
            
            this.draw();
            this.updateParams();
        }
    }

    setExternalPos(x, z) {
        if (!this.recordingState.active && this.automation) return;

        if (!this.isDragging) this.dragTarget = 'source';

        // x, z are -1..1
        this.pos.x = Math.max(-1, Math.min(1, x));
        this.pos.z = Math.max(-1, Math.min(1, z));
        this.draw();
        this.updateParams();
        this.recordPoint();
    }

    updateParams() {
        if (!this.callbacks.onSpatialParams) return;
        
        // Redraw if triggered by sliders
        if (!this.isDragging && this.autoSpeed === 0) this.draw();

        // Calculate elevation from slider (0..100 -> -1..1)
        const rawH = parseInt(this.elements.height.value);
        const y = (rawH / 50) - 1.0; 

        const params = {
            mode: this.elements.mode.value,
            width: parseInt(this.elements.width.value) / 100,
            jitter: parseInt(this.elements.jitter.value) / 100,
            x: this.pos.x,
            y: y,
            z: this.pos.z,
            lx: this.headPos.x,
            lz: this.headPos.z
        };

        this.callbacks.onSpatialParams(params);
    }
}