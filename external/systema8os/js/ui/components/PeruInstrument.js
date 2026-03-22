import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class PeruInstrument {
    constructor(audio, store) {
        this.audio = audio;
        this.store = store;
        // Percussive defaults: Instant attack, punchy decay
        this.adsr = { a: 0.001, d: 0.15, s: 0.4, r: 0.15 };
        
        this.onFocus = null;
        this.onSpawn = null;

        // Floating Window Container
        this.container = document.createElement('div');
        this.container.className = 'peru-instrument hidden';
        
        // Randomize start pos to prevent perfect overlap
        const offX = 100 + Math.random() * 200;
        const offY = 100 + Math.random() * 200;

        // Inline styles for window behavior
        this.container.style.position = 'absolute';
        // Ensure within viewport bounds for standalone safety
        const safeX = Math.min(offX, window.innerWidth - 320);
        const safeY = Math.min(offY, window.innerHeight - 250);
        this.container.style.top = `${safeY}px`;
        this.container.style.left = `${safeX}px`;
        this.container.style.width = '600px';
        this.container.style.height = '450px';
        this.container.style.minWidth = '300px';
        this.container.style.minHeight = '200px';
        this.container.style.backgroundColor = '#050000';
        this.container.style.border = '1px solid #660000';
        this.container.style.zIndex = '2000'; 
        this.container.style.resize = 'both';
        this.container.style.overflow = 'hidden';
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.container.style.boxShadow = '0 0 30px rgba(0,0,0,0.8)';
        
        document.body.appendChild(this.container);

        // Header (Draggable)
        this.header = document.createElement('div');
        this.header.className = 'video-window-header'; // Reusing style
        this.header.style.background = '#220000';
        this.header.style.borderBottom = '1px solid #660000';
        this.header.style.justifyContent = 'space-between';
        
        const title = document.createElement('span');
        title.innerText = 'PERU: NEURAL NETWORK COLLIDER';
        title.style.color = '#00ffff';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '12px';
        
        const headerControls = document.createElement('div');
        headerControls.style.display = 'flex';
        headerControls.style.gap = '10px';

        const btnSpawn = document.createElement('div');
        btnSpawn.innerText = '+';
        btnSpawn.style.cursor = 'pointer';
        btnSpawn.style.fontWeight = 'bold';
        btnSpawn.style.color = '#0f0';
        btnSpawn.title = "Open New Peru";
        btnSpawn.onclick = (e) => {
            e.stopPropagation();
            if(this.onSpawn) this.onSpawn();
        };

        const btnMin = document.createElement('div');
        btnMin.innerText = '_';
        btnMin.style.cursor = 'pointer';
        btnMin.style.fontWeight = 'bold';
        btnMin.style.marginRight = '8px';
        btnMin.title = "Minimize";
        btnMin.onclick = (e) => {
            e.stopPropagation();
            this.toggleWindow(false);
        };

        const btnClose = document.createElement('div');
        btnClose.innerText = 'X';
        btnClose.style.cursor = 'pointer';
        btnClose.style.fontWeight = 'bold';
        btnClose.title = "Destroy";
        btnClose.onclick = (e) => {
            e.stopPropagation();
            this.dispose();
        };

        headerControls.appendChild(btnSpawn);
        headerControls.appendChild(btnMin);
        headerControls.appendChild(btnClose);

        this.header.appendChild(title);
        this.header.appendChild(headerControls);

        this.container.addEventListener('mousedown', () => {
             if(this.onFocus) this.onFocus();
        });
        this.container.appendChild(this.header);

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'peru-toolbar';
        
        const btnClear = document.createElement('button');
        btnClear.innerText = "CLEAR";
        btnClear.onclick = () => { this.clearBalls(); };
        btnClear.style.background = '#660000';
        btnClear.style.color = '#fff';
        btnClear.style.border = '1px solid #ff4444';
        btnClear.style.marginRight = '5px';

        const btnPoly = document.createElement('button');
        btnPoly.innerText = "POLY: ON";
        btnPoly.style.background = '#004400';
        btnPoly.style.color = '#fff';
        btnPoly.style.border = '1px solid #00ff00';
        btnPoly.style.marginRight = '5px';
        btnPoly.style.fontSize = '9px';
        btnPoly.onclick = () => {
            this.polyMode = !this.polyMode;
            btnPoly.innerText = this.polyMode ? "POLY: ON" : "POLY: OFF";
            btnPoly.style.background = this.polyMode ? '#004400' : '#220000';
            btnPoly.style.border = this.polyMode ? '1px solid #00ff00' : '1px solid #660000';
        };

        const btnAuto = document.createElement('button');
        btnAuto.innerText = "AUTO RND";
        btnAuto.style.background = '#330000';
        btnAuto.style.color = '#ff8888';
        btnAuto.style.border = '1px solid #660000';
        btnAuto.style.marginRight = '15px';
        btnAuto.style.fontSize = '9px';
        btnAuto.onclick = () => {
            this.autoRandom = !this.autoRandom;
            btnAuto.style.background = this.autoRandom ? '#ff0000' : '#330000';
            btnAuto.style.color = this.autoRandom ? '#ffffff' : '#ff8888';
        };
        
        // Controls
        const controls = document.createElement('div');
        controls.className = 'peru-controls';
        
        const lblSpeed = document.createElement('label');
        lblSpeed.innerText = "SPEED";
        const rngSpeed = document.createElement('input');
        rngSpeed.type = 'range';
        rngSpeed.min = '0';
        rngSpeed.max = '100';
        rngSpeed.value = '20';
        rngSpeed.oninput = (e) => {
            this.manualSpeed = parseInt(e.target.value) / 2;
            if (!this.seqState || !this.seqState.active) this.speedMult = this.manualSpeed;
        };
        this.rngSpeed = rngSpeed;
        
        const lblGravity = document.createElement('label');
        lblGravity.innerText = "GRAVITY";
        const rngGravity = document.createElement('input');
        rngGravity.type = 'range';
        rngGravity.min = '0';
        rngGravity.max = '100';
        rngGravity.value = '50';
        rngGravity.oninput = (e) => {
            const val = parseInt(e.target.value) / 100;
            // Map 0..1 to -0.1 (Lift/Apesanteur) .. 0.8 (Heavy)
            this.gravity = -0.1 + (val * 0.9);
        };
        this.rngGravity = rngGravity;

        const lblVol = document.createElement('label');
        lblVol.innerText = "VOL";
        const rngVol = document.createElement('input');
        rngVol.type = 'range';
        rngVol.min = '0';
        rngVol.max = '100';
        rngVol.value = '100';
        rngVol.oninput = (e) => this.volume = parseInt(e.target.value) / 100;

        controls.appendChild(lblSpeed);
        controls.appendChild(rngSpeed);
        controls.appendChild(lblGravity);
        controls.appendChild(rngGravity);
        controls.appendChild(lblVol);
        controls.appendChild(rngVol);

        const lblMode = document.createElement('label');
        lblMode.innerText = "SPATIAL";
        lblMode.style.marginLeft = "5px";
        
        const selMode = document.createElement('select');
        selMode.style.background = "#300";
        selMode.style.color = "#f88";
        selMode.style.border = "1px solid #600";
        selMode.style.fontSize = "10px";
        
        const optAmbi = document.createElement('option');
        optAmbi.value = "binaural";
        optAmbi.innerText = "AMBISONIC";
        const optStereo = document.createElement('option');
        optStereo.value = "stereo";
        optStereo.innerText = "STEREO";
        
        selMode.appendChild(optAmbi);
        selMode.appendChild(optStereo);
        selMode.onchange = (e) => this.spatialMode = e.target.value;
        selMode.value = "stereo";

        controls.appendChild(lblMode);
        controls.appendChild(selMode);

        toolbar.appendChild(btnClear);
        toolbar.appendChild(btnPoly);
        toolbar.appendChild(btnAuto);
        toolbar.appendChild(controls);
        
        this.container.appendChild(toolbar);

        this.buildAdsrUI();

        // 3D Canvas Wrapper
        this.wrap = document.createElement('div');
        this.wrap.className = 'peru-canvas-wrap';
        this.wrap.style.flex = '1';
        this.wrap.style.position = 'relative';
        this.wrap.style.background = '#000';
        this.container.appendChild(this.wrap);
        
        this.balls = [];
        this.active = false;
        this.polyMode = true; // Default ON for polyphony
        this.speedMult = 10.0;
        this.manualSpeed = 10.0;
        this.gravity = 0.35; // Default mid-range
        this.volume = 1.0;
        this.boxSize = 200; // Physics box size
        this.spatialMode = 'stereo';
        
        // Gravity Sequencer State
        this.gravState = {
            active: true,
            steps: 16,
            current: 0,
            values: new Array(16).fill(0.5), // Mid gravity default
            lastTick: 0
        };
        
        this.onClose = null;
        this.autoRandom = false;

        this.initThree();
        this.setupDrag();

        // Sequencer UI (Speed)
        this.buildSequencerUI();
        
        // Gravity Steps UI
        this.buildGravityUI();

        // Resize observer
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.wrap);
    }

    buildAdsrUI() {
        const panel = document.createElement('div');
        panel.style.background = '#220000';
        panel.style.borderBottom = '1px solid #660000';
        panel.style.display = 'flex';
        panel.style.alignItems = 'center';
        panel.style.padding = '2px 10px';
        panel.style.gap = '15px';
        panel.style.height = '36px';
        panel.style.flexShrink = '0';
        
        const title = document.createElement('span');
        title.innerText = 'ADSR';
        title.style.color = '#ff4444';
        title.style.fontSize = '10px';
        title.style.fontWeight = 'bold';
        title.style.marginRight = '5px';
        panel.appendChild(title);

        const createSlider = (label, param, min, max, initial, scale) => {
            const cont = document.createElement('div');
            cont.style.display = 'flex';
            cont.style.alignItems = 'center';
            cont.style.gap = '5px';
            
            const lbl = document.createElement('label');
            lbl.innerText = label;
            lbl.style.color = '#aaa';
            lbl.style.fontSize = '9px';
            
            const range = document.createElement('input');
            range.type = 'range';
            range.min = min;
            range.max = max;
            range.value = initial;
            range.style.width = '60px';
            range.style.cursor = 'pointer';
            
            range.oninput = (e) => {
                this.adsr[param] = parseInt(e.target.value) * scale;
            };
            
            cont.appendChild(lbl);
            cont.appendChild(range);
            return cont;
        };
        
        // Attack: 0-100 -> 0-1s
        panel.appendChild(createSlider('A', 'a', 0, 100, this.adsr.a / 0.01, 0.01));
        // Decay: 0-100 -> 0-1s
        panel.appendChild(createSlider('D', 'd', 0, 100, this.adsr.d / 0.01, 0.01));
        // Sustain: 0-100 -> 0-1
        panel.appendChild(createSlider('S', 's', 0, 100, this.adsr.s / 0.01, 0.01));
        // Release: 0-100 -> 0-2s
        panel.appendChild(createSlider('R', 'r', 0, 100, this.adsr.r / 0.02, 0.02));

        this.container.appendChild(panel);
    }

    buildSequencerUI() {
        this.seqState = {
            active: true,
            bpm: 120,
            steps: 16,
            current: 0,
            values: new Array(164).fill(0.2), // Default to speed ~1.0
            lastTick: 0
        };

        const seqPanel = document.createElement('div');
        seqPanel.style.height = '140px';
        seqPanel.style.background = '#110000';
        seqPanel.style.borderTop = '1px solid #660000';
        seqPanel.style.display = 'flex';
        seqPanel.style.flexDirection = 'column';
        seqPanel.style.padding = '5px';
        
        // Controls Row
        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.gap = '8px';
        controls.style.alignItems = 'center';
        controls.style.marginBottom = '5px';
        controls.style.fontSize = '10px';
        controls.style.color = '#ff8888';
        controls.style.flexWrap = 'wrap';

        // Toggle
        const btnToggle = document.createElement('button');
        btnToggle.innerText = this.seqState.active ? 'SEQ: ON' : 'SEQ: OFF';
        btnToggle.style.fontSize = '9px';
        btnToggle.style.padding = '2px 5px';
        btnToggle.style.background = this.seqState.active ? '#600' : '#300';
        btnToggle.style.color = this.seqState.active ? '#fff' : '#f88';
        btnToggle.style.border = '1px solid #600';
        btnToggle.style.cursor = 'pointer';
        btnToggle.onclick = () => {
            this.seqState.active = !this.seqState.active;
            btnToggle.innerText = this.seqState.active ? 'SEQ: ON' : 'SEQ: OFF';
            btnToggle.style.background = this.seqState.active ? '#600' : '#300';
            btnToggle.style.color = this.seqState.active ? '#fff' : '#f88';
        };

        // BPM
        const lblBpm = document.createElement('label');
        lblBpm.innerText = 'BPM';
        const inpBpm = document.createElement('input');
        inpBpm.type = 'number';
        inpBpm.value = 120;
        inpBpm.min = 30;
        inpBpm.max = 500;
        inpBpm.style.width = '40px';
        inpBpm.style.background = '#000';
        inpBpm.style.border = '1px solid #600';
        inpBpm.style.color = '#fff';
        inpBpm.style.fontSize = '10px';
        inpBpm.oninput = (e) => this.seqState.bpm = parseInt(e.target.value);

        // Length
        const lblLen = document.createElement('label');
        lblLen.innerText = 'STEPS';
        const inpLen = document.createElement('input');
        inpLen.type = 'number';
        inpLen.value = 16;
        inpLen.min = 2;
        inpLen.max = 164;
        inpLen.style.width = '40px';
        inpLen.style.background = '#000';
        inpLen.style.border = '1px solid #600';
        inpLen.style.color = '#fff';
        inpLen.style.fontSize = '10px';
        
        const sliderLen = document.createElement('input');
        sliderLen.type = 'range';
        sliderLen.min = 2;
        sliderLen.max = 164;
        sliderLen.value = 16;
        sliderLen.style.width = '80px';
        sliderLen.style.cursor = 'pointer';

        const updateSteps = (val, skipInputUpdate = false) => {
            let v = parseInt(val);
            if(isNaN(v)) return;
            if(v < 2) v = 2; if(v > 164) v = 164;
            this.seqState.steps = v;
            if (!skipInputUpdate) inpLen.value = v;
            sliderLen.value = v;
            this.drawSequencer();
        };

        inpLen.oninput = (e) => updateSteps(e.target.value, true);
        sliderLen.oninput = (e) => updateSteps(e.target.value);

        controls.appendChild(btnToggle);
        controls.appendChild(lblBpm);
        controls.appendChild(inpBpm);
        controls.appendChild(lblLen);
        controls.appendChild(inpLen);
        controls.appendChild(sliderLen);
        
        seqPanel.appendChild(controls);

        // Canvas for steps (The "Sliders")
        const canvasContainer = document.createElement('div');
        canvasContainer.style.flex = '1';
        canvasContainer.style.position = 'relative';
        canvasContainer.style.background = '#050000';
        canvasContainer.style.border = '1px solid #440000';
        canvasContainer.style.cursor = 'crosshair';

        this.seqCanvas = document.createElement('canvas');
        this.seqCanvas.width = 800;
        this.seqCanvas.height = 100;
        this.seqCanvas.style.width = '100%';
        this.seqCanvas.style.height = '100%';
        this.seqCanvas.style.display = 'block';
        
        this.seqCtx = this.seqCanvas.getContext('2d');

        // Mouse interaction for drawing steps
        let drawing = false;
        const updateVal = (e) => {
            const rect = this.seqCanvas.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            
            // Normalize
            let nx = Math.max(0, Math.min(1, x / rect.width));
            let ny = Math.max(0, Math.min(1, y / rect.height));
            
            const stepIdx = Math.floor(nx * this.seqState.steps);
            
            if (stepIdx >= 0 && stepIdx < this.seqState.steps) {
                this.seqState.values[stepIdx] = 1.0 - ny;
                this.drawSequencer();
            }
        };

        this.seqCanvas.addEventListener('mousedown', (e) => { drawing = true; updateVal(e); });
        window.addEventListener('mousemove', (e) => { if(drawing) updateVal(e); });
        window.addEventListener('mouseup', () => drawing = false);
        window.addEventListener('mouseleave', () => drawing = false);

        canvasContainer.appendChild(this.seqCanvas);
        seqPanel.appendChild(canvasContainer);
        
        this.container.appendChild(seqPanel);
        
        // Initial draw
        requestAnimationFrame(() => this.drawSequencer());
    }

    buildGravityUI() {
        const panel = document.createElement('div');
        panel.style.height = '120px';
        panel.style.background = '#050505';
        panel.style.borderTop = '1px solid #440044';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.padding = '5px';
        
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '5px';
        
        const title = document.createElement('div');
        title.innerText = "GRAVITY STEPS";
        title.style.color = "#d0f";
        title.style.fontSize = "10px";
        title.style.fontWeight = "bold";

        const btnToggle = document.createElement('button');
        btnToggle.innerText = "GRAV: ON";
        btnToggle.style.fontSize = "9px";
        btnToggle.style.background = "#303";
        btnToggle.style.color = "#d0f";
        btnToggle.onclick = () => {
            this.gravState.active = !this.gravState.active;
            btnToggle.innerText = this.gravState.active ? "GRAV: ON" : "GRAV: OFF";
            btnToggle.style.color = this.gravState.active ? "#d0f" : "#666";
        };
        
        header.appendChild(title);
        header.appendChild(btnToggle);
        panel.appendChild(header);

        // Canvas
        const cvsWrap = document.createElement('div');
        cvsWrap.style.flex = '1';
        cvsWrap.style.position = 'relative';
        cvsWrap.style.background = '#101';
        cvsWrap.style.border = '1px solid #404';
        
        this.gravCanvas = document.createElement('canvas');
        this.gravCanvas.width = 600;
        this.gravCanvas.height = 100;
        this.gravCanvas.style.width = '100%';
        this.gravCanvas.style.height = '100%';
        
        this.gravCtx = this.gravCanvas.getContext('2d');
        cvsWrap.appendChild(this.gravCanvas);
        panel.appendChild(cvsWrap);
        
        this.container.appendChild(panel);

        // Interaction
        let drawing = false;
        const updateVal = (e) => {
            const rect = this.gravCanvas.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            
            let nx = Math.max(0, Math.min(1, x / rect.width));
            let ny = Math.max(0, Math.min(1, y / rect.height));
            
            const stepIdx = Math.floor(nx * this.gravState.steps);
            if (stepIdx >= 0 && stepIdx < this.gravState.steps) {
                this.gravState.values[stepIdx] = 1.0 - ny; // 0 (bottom) to 1 (top)
                this.drawGravity();
            }
        };

        this.gravCanvas.addEventListener('mousedown', (e) => { drawing = true; updateVal(e); });
        window.addEventListener('mousemove', (e) => { if(drawing) updateVal(e); });
        window.addEventListener('mouseup', () => drawing = false);
        window.addEventListener('mouseleave', () => drawing = false);

        setTimeout(() => this.drawGravity(), 100);
    }

    drawGravity() {
        if (!this.gravCtx) return;
        const ctx = this.gravCtx;
        const w = this.gravCanvas.width;
        const h = this.gravCanvas.height;
        const count = this.gravState.steps;
        const stepW = w / count;

        ctx.clearRect(0, 0, w, h);
        
        for (let i = 0; i < count; i++) {
            const val = this.gravState.values[i];
            const barH = val * h;
            
            // Color ramp purple
            const intensity = 40 + (val * 60);
            ctx.fillStyle = `hsl(280, 100%, ${intensity}%)`;
            
            if (this.gravState.active && i === this.gravState.current) {
                ctx.fillStyle = '#fff';
            }

            ctx.fillRect(i * stepW, h - barH, stepW - 1, barH);
        }
    }

    drawSequencer() {
        if (!this.seqCtx) return;
        const ctx = this.seqCtx;
        const w = this.seqCanvas.width;
        const h = this.seqCanvas.height;
        const count = this.seqState.steps;
        const stepW = w / count;

        ctx.clearRect(0, 0, w, h);
        
        // Grid lines
        ctx.strokeStyle = '#220000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for(let i=0; i<count; i+=4) {
            ctx.moveTo(i * stepW, 0);
            ctx.lineTo(i * stepW, h);
        }
        ctx.stroke();

        for (let i = 0; i < count; i++) {
            const val = this.seqState.values[i];
            const barH = val * h;
            
            // Color based on value
            const hue = val * 60; // Red (0) to Yellow (60)
            ctx.fillStyle = `hsl(${hue}, 80%, 40%)`;
            
            // Highlight current
            if (this.seqState.active && i === this.seqState.current) {
                ctx.fillStyle = '#ffaaaa';
            }

            ctx.fillRect(i * stepW, h - barH, stepW - 0.5, barH);
        }
    }

    initThree() {
        // Scene - Fluo Aesthetic
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a1a); 
        this.scene.fog = new THREE.FogExp2(0x0a0a1a, 0.0015);

        // Camera
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
        this.camera.position.set(0, 0, 400);

        // Renderer
        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        } catch (e) {
            console.warn("Peru WebGL failed, retrying simple");
            try {
                this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
            } catch (e2) {
                console.error("Peru WebGL failed");
                this.container.innerHTML = "<div style='color:red; padding:20px; font-family:monospace;'>ERROR: GPU CONTEXT LIMIT REACHED.<br>CLOSE OTHER WINDOWS.</div>";
                return;
            }
        }

        this.renderer.setSize(400, 300); 
        this.renderer.setPixelRatio(1.0); 
        this.wrap.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 0.5;
        this.controls.enablePan = false;

        // Lights - Bright & Neon
        const ambient = new THREE.AmbientLight(0x888888);
        this.scene.add(ambient);
        
        const point = new THREE.PointLight(0x00ffff, 2.0, 1000);
        point.position.set(50, 100, 100);
        this.scene.add(point);
        
        const point2 = new THREE.PointLight(0xff00ff, 1.5, 800);
        point2.position.set(-50, -50, 50);
        this.scene.add(point2);

        // Box Helper - Digital Cage (Neon)
        const geometry = new THREE.BoxGeometry(this.boxSize, this.boxSize, this.boxSize);
        const edges = new THREE.EdgesGeometry(geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ 
            color: 0x00ffcc, 
            transparent: true, 
            opacity: 0.8 
        }));
        this.scene.add(line);
        
        // Data Grid Floor
        const grid = new THREE.GridHelper(this.boxSize, 10, 0x00ffff, 0x004444);
        grid.position.y = -this.boxSize / 2;
        this.scene.add(grid);

        // Connections (Files) - Bright Lime Data Links
        const connectionGeo = new THREE.BufferGeometry();
        const maxConnections = 10000; 
        const positions = new Float32Array(maxConnections * 6); 
        connectionGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const connectionMat = new THREE.LineBasicMaterial({ 
            color: 0xccff00, 
            transparent: true, 
            opacity: 0.8, 
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        this.connections = new THREE.LineSegments(connectionGeo, connectionMat);
        this.connections.frustumCulled = false;
        this.scene.add(this.connections);

        this.ballGroup = new THREE.Group();
        this.scene.add(this.ballGroup);
    }

    setupDrag() {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        this.header.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const style = window.getComputedStyle(this.container);
            initialLeft = parseInt(style.left, 10) || 0;
            initialTop = parseInt(style.top, 10) || 0;
            
            this.header.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            this.container.style.left = `${initialLeft + dx}px`;
            this.container.style.top = `${initialTop + dy}px`;
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                this.header.style.cursor = 'grab';
            }
        });
    }

    setActive(isActive) {
        this.container.style.borderColor = isActive ? '#00ffff' : '#660000';
        this.header.style.background = isActive ? '#004444' : '#220000';
        this.container.style.zIndex = isActive ? '2001' : '2000';
    }

    resize() {
        const rect = this.wrap.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && this.renderer) {
            this.camera.aspect = rect.width / rect.height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(rect.width, rect.height);
        }
    }

    show(frames) {
        this.container.classList.remove('hidden');
        this.resize();
        this.initBalls(frames);
        
        if (!this.active) {
            this.active = true;
            this.animate();
        }
    }

    animate() {
        if (!this.active || !this.renderer) return;
        this.animationFrameId = requestAnimationFrame(() => this.animate());
        
        if (this.autoRandom) {
            if (this.seqState && this.seqState.values) {
                for(let i=0; i<this.seqState.steps; i++) {
                    this.seqState.values[i] += (Math.random() - 0.5) * 0.05;
                    this.seqState.values[i] = Math.max(0, Math.min(1, this.seqState.values[i]));
                }
                this.drawSequencer();
            }
        }

        if (this.seqState && this.seqState.active) {
            const now = Date.now();
            const msPerStep = 15000 / this.seqState.bpm;
            
            if (this.seqState.lastTick === 0) this.seqState.lastTick = now;
            
            if (now - this.seqState.lastTick > msPerStep) {
                this.seqState.lastTick = now;
                this.seqState.current = (this.seqState.current + 1) % this.seqState.steps;
                const val = this.seqState.values[this.seqState.current];
                this.speedMult = Math.pow(val, 2) * 50.0; 
                this.drawSequencer();
            }
        } else {
            this.speedMult = this.manualSpeed;
        }
        
        this.controls.update();

        const limit = this.boxSize / 2;
        const maxSpeedPerStep = 2.0; 
        const steps = Math.ceil(this.speedMult / maxSpeedPerStep);
        const stepSpeed = this.speedMult / steps;

        const gScale = 1.0 + (this.speedMult * 0.15); 
        const gravVec = new THREE.Vector3(0, -this.gravity * gScale, 0);
        
        if (this.connections && this.connections.geometry) {
            const positions = this.connections.geometry.attributes.position.array;
            let connIdx = 0;
            const distThresholdSq = 90 * 90; 

            for(let s = 0; s < steps; s++) {
                for (let i = 0; i < this.balls.length; i++) {
                    const b = this.balls[i];
                    
                    b.vx += gravVec.x;
                    b.vy += gravVec.y;
                    b.vz += gravVec.z;

                    b.x += b.vx * stepSpeed;
                    b.y += b.vy * stepSpeed;
                    b.z += b.vz * stepSpeed;
                    
                    let collided = false;
                    let impactVel = 0;
                    
                    if (b.x < -limit + b.radius) { impactVel = Math.abs(b.vx); b.x = -limit + b.radius; b.vx *= -1; collided = true; } 
                    else if (b.x > limit - b.radius) { impactVel = Math.abs(b.vx); b.x = limit - b.radius; b.vx *= -1; collided = true; }
                    
                    if (b.y < -limit + b.radius) { impactVel = Math.abs(b.vy); b.y = -limit + b.radius; b.vy *= -0.8; collided = true; } 
                    else if (b.y > limit - b.radius) { impactVel = Math.abs(b.vy); b.y = limit - b.radius; b.vy *= -1; collided = true; }
                    
                    if (b.z < -limit + b.radius) { impactVel = Math.abs(b.vz); b.z = -limit + b.radius; b.vz *= -1; collided = true; } 
                    else if (b.z > limit - b.radius) { impactVel = Math.abs(b.vz); b.z = limit - b.radius; b.vz *= -1; collided = true; }
                    
                    if (collided) this.play(b, impactVel);

                    for (let j = i + 1; j < this.balls.length; j++) {
                        const b2 = this.balls[j];
                        const dx = b2.x - b.x;
                        const dy = b2.y - b.y;
                        const dz = b2.z - b.z;
                        const distSq = dx*dx + dy*dy + dz*dz;
                        const minDist = b.radius + b2.radius;
                        
                        if (distSq < minDist * minDist) {
                            const dist = Math.sqrt(distSq);
                            const nx = dx / dist;
                            const ny = dy / dist;
                            const nz = dz / dist;
                            
                            const overlap = (minDist - dist) * 0.5;
                            b.x -= nx * overlap;
                            b.y -= ny * overlap;
                            b.z -= nz * overlap;
                            b2.x += nx * overlap;
                            b2.y += ny * overlap;
                            b2.z += nz * overlap;
                            
                            const rvx = b.vx - b2.vx;
                            const rvy = b.vy - b2.vy;
                            const rvz = b.vz - b2.vz;
                            const impact = Math.sqrt(rvx*rvx + rvy*rvy + rvz*rvz) * 0.5;

                            const tempVx = b.vx; const tempVy = b.vy; const tempVz = b.vz;
                            b.vx = b2.vx; b.vy = b2.vy; b.vz = b2.vz;
                            b2.vx = tempVx; b2.vy = tempVy; b2.vz = tempVz;

                            this.play(b, impact);
                            this.play(b2, impact);
                        }
                    }
                }
            }

            for (let i = 0; i < this.balls.length; i++) {
                const b = this.balls[i];

                if (b.tracker) {
                    b.tracker.rotation.z += 0.05; 
                    b.tracker.lookAt(this.camera.position); 
                }

                for (let j = i + 1; j < this.balls.length; j++) {
                    const b2 = this.balls[j];
                    const dx = b2.x - b.x;
                    const dy = b2.y - b.y;
                    const dz = b2.z - b.z;
                    const distSq = dx*dx + dy*dy + dz*dz;
                    
                    if (distSq < distThresholdSq) {
                        if (connIdx < positions.length - 6) {
                            positions[connIdx++] = b.x;
                            positions[connIdx++] = b.y;
                            positions[connIdx++] = b.z;
                            positions[connIdx++] = b2.x;
                            positions[connIdx++] = b2.y;
                            positions[connIdx++] = b2.z;
                        }
                    }
                }
                
                b.mesh.position.set(b.x, b.y, b.z);
                
                if (b.trail) {
                    const arr = b.trail.geometry.attributes.position.array;
                    for (let k = arr.length - 1; k >= 3; k--) {
                        arr[k] = arr[k - 3];
                    }
                    arr[0] = b.x;
                    arr[1] = b.y;
                    arr[2] = b.z;
                    b.trail.geometry.attributes.position.needsUpdate = true;
                }

                if (b.hit > 0) {
                    b.hit -= 1;
                    const s = 1.0 + (b.hit / 5.0);
                    b.mesh.scale.set(s, s, s);
                    if (b.mesh.material) b.mesh.material.color.setHex(0xffffff);
                    if (b.tracker && b.tracker.material) b.tracker.material.color.setHex(0xffffff);
                } else {
                    b.mesh.scale.set(1, 1, 1);
                    if (b.mesh.material) b.mesh.material.color.setHex(0x00ff66);
                    if (b.tracker && b.tracker.material) b.tracker.material.color.setHex(0x00ffff);
                }
            }

            this.connections.geometry.setDrawRange(0, connIdx / 3);
            this.connections.geometry.attributes.position.needsUpdate = true;
            this.renderer.render(this.scene, this.camera);
        }
    }

    toggleWindow(show) {
        if (show) {
            this.container.classList.remove('hidden');
            this.active = true;
            this.animate();
        } else {
            this.container.classList.add('hidden');
            this.active = false; // Pause rendering loop to save perf
        }
    }

    // Legacy hide alias
    hide() {
        this.toggleWindow(false);
    }
    
    clearBalls() {
        this.balls.forEach(b => {
            if (b.trail) {
                this.scene.remove(b.trail);
                if (b.trail.geometry) b.trail.geometry.dispose();
                if (b.trail.material) b.trail.material.dispose();
            }
            if (b.mesh) {
                if (b.mesh.geometry) b.mesh.geometry.dispose();
                if (b.mesh.material) b.mesh.material.dispose();
                
                // Tracker
                if (b.tracker) {
                    if (b.tracker.geometry) b.tracker.geometry.dispose();
                    if (b.tracker.material) b.tracker.material.dispose();
                }
            }
        });
        
        // Safety clear of group
        while(this.ballGroup.children.length > 0){ 
            const obj = this.ballGroup.children[0];
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
            this.ballGroup.remove(obj); 
        }
        this.balls = [];
    }

    dispose() {
        this.active = false;
        
        // Stop Loop
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

        // Clear content
        this.clearBalls();

        // Dispose Static Scene Elements
        if (this.connections) {
            if (this.connections.geometry) this.connections.geometry.dispose();
            if (this.connections.material) this.connections.material.dispose();
        }
        
        // Dispose Renderer
        if (this.renderer) {
            try {
                this.renderer.dispose();
                if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
                if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                    this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
                }
            } catch(e) { console.warn("Renderer dispose error", e); }
            this.renderer = null;
        }

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        this.container.remove();
    }

    initBalls(frames) {
        const half = this.boxSize / 2 - 10;
        
        frames.forEach(f => {
            const r = 2 + (f.volume * 8); 
            
            const b = {
                x: (Math.random() - 0.5) * 2 * half,
                y: (Math.random() - 0.5) * 2 * half,
                z: (Math.random() - 0.5) * 2 * half,
                vx: (Math.random() - 0.5) * 4,
                vy: (Math.random() - 0.5) * 4,
                vz: (Math.random() - 0.5) * 4,
                radius: r * 2.5,
                visualRadius: r,
                frame: f,
                cooldown: 0,
                hit: 0
            };
            
            // 1. Core Mesh - Bright Neon Wireframe
            const geo = new THREE.IcosahedronGeometry(r, 0); 
            const mat = new THREE.MeshBasicMaterial({
                color: 0x00ff66, 
                wireframe: true,
                transparent: true,
                opacity: 1.0
            });
            
            b.mesh = new THREE.Mesh(geo, mat);
            b.mesh.position.set(b.x, b.y, b.z);

            // 2. Tracker (Rotating Bracket HUD)
            const trackGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(r * 2.5, r * 2.5, r * 0.1));
            const trackMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.8 });
            b.tracker = new THREE.LineSegments(trackGeo, trackMat);
            b.mesh.add(b.tracker);

            // 3. Trail (Movement History)
            const trailLen = 25;
            b.trailPositions = new Float32Array(trailLen * 3);
            const trailGeo = new THREE.BufferGeometry();
            trailGeo.setAttribute('position', new THREE.BufferAttribute(b.trailPositions, 3));
            
            b.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
                color: 0x00ff00,
                transparent: true,
                opacity: 0.6
            }));
            // Init trail at start pos
            for(let i=0; i<trailLen*3; i+=3) {
                b.trailPositions[i] = b.x;
                b.trailPositions[i+1] = b.y;
                b.trailPositions[i+2] = b.z;
            }
            this.scene.add(b.trail); // Add to scene so it trails properly in world space

            this.ballGroup.add(b.mesh);
            this.balls.push(b);
        });
    }

    play(ball, impact = 1.0) {
        const now = Date.now();
        // Dynamic debounce based on impact velocity (faster rolls allowed for high energy)
        const debounce = impact > 5.0 ? 30 : 60;
        if (now - ball.cooldown < debounce) return; 

        // Ignore micro-collisions
        if (impact < 0.2) return;

        ball.cooldown = now;
        ball.hit = 10;
        
        // Use ball 3D position for spatialization
        const limit = this.boxSize / 2;
        // Ball Local Pos
        let nx = THREE.MathUtils.clamp(ball.x / limit, -1, 1);
        let ny = THREE.MathUtils.clamp(ball.y / limit, -1, 1);
        let nz = THREE.MathUtils.clamp(ball.z / limit, -1, 1);

        const spat = {
            mode: this.spatialMode,
            x: nx,
            y: ny, 
            z: nz,
            width: 1,
            jitter: 0.05
        };

        // Map Volume to Impact Physics
        // Boosted sensitivity (impact/4.0) and volume (*1.8) for punchier sound
        const velocityVol = Math.min(1.0, Math.pow(impact / 4.0, 0.6));
        const vol = Math.min(2.0, velocityVol * this.volume * 1.8);
        
        // Duration snappy for hard hits
        const dur = 0.1 + (Math.random() * 0.15);

        this.audio.playGrain(
            ball.frame.time,
            dur, 
            vol, 
            0, 
            this.adsr, 
            spat,
            { bitmap: ball.frame.bitmap, sourceId: ball.frame.sourceVidId, frame: ball.frame }
        );

        if (this.polyMode && this.store) {
            // Polyphonic Chord Generation (Major/Minor approx based on brightness)
            const rootPitch = ball.frame.pitch;
            if (rootPitch > 50) {
                // Intervals: 5th (1.5) and 3rd (1.2 for dark/minor, 1.25 for bright/major)
                const isBright = ball.frame.centroid > 0.4;
                const thirdRatio = isBright ? 1.2599 : 1.1892; // Major vs Minor 3rd approx
                
                const intervals = [1.5, thirdRatio];
                
                intervals.forEach((ratio, idx) => {
                    const targetP = rootPitch * ratio;
                    // Find a grain in the library that matches this pitch and timbre
                    const match = this.store.findClosestFrame(targetP, ball.frame.centroid);
                    
                    if (match && match !== ball.frame) {
                        // Slight decorrelation
                        const delay = 5 + Math.random() * 25;
                        
                        // Spatial spread for the chord
                        const chordSpat = { ...spat };
                        chordSpat.x += (Math.random() - 0.5) * 0.1;
                        
                        setTimeout(() => {
                            this.audio.playGrain(
                                match.time,
                                dur,
                                vol * 0.6, // Harmonies quieter
                                0, // Pan handled by spat params
                                this.adsr,
                                chordSpat,
                                { bitmap: match.bitmap, sourceId: match.sourceVidId, frame: match }
                            );
                        }, delay);
                    }
                });
            }
        }
    }

    animate() {
        if (this.container.offsetParent === null) {
            this.active = false;
        }

        if (!this.active || !this.renderer) return;
        this.animationFrameId = requestAnimationFrame(() => this.animate());
        const now = Date.now();

        if (this.autoRandom) {
            // Randomize Sequencer Step Sliders
            if (this.seqState && this.seqState.values) {
                for(let i=0; i<this.seqState.steps; i++) {
                    this.seqState.values[i] += (Math.random() - 0.5) * 0.05;
                    this.seqState.values[i] = Math.max(0, Math.min(1, this.seqState.values[i]));
                }
                this.drawSequencer();
            }
            if (this.gravState && this.gravState.values) {
                for(let i=0; i<this.gravState.steps; i++) {
                    this.gravState.values[i] += (Math.random() - 0.5) * 0.05;
                    this.gravState.values[i] = Math.max(0, Math.min(1, this.gravState.values[i]));
                }
                this.drawGravity();
            }
        }

        // Speed Sequencer Logic
        if (this.seqState && this.seqState.active) {
            const msPerStep = 15000 / this.seqState.bpm; 
            if (this.seqState.lastTick === 0) this.seqState.lastTick = now;
            
            if (now - this.seqState.lastTick > msPerStep) {
                this.seqState.lastTick = now;
                this.seqState.current = (this.seqState.current + 1) % this.seqState.steps;
                const val = this.seqState.values[this.seqState.current];
                this.speedMult = Math.pow(val, 2) * 50.0; 
                this.drawSequencer();
            }
        } else {
            this.speedMult = this.manualSpeed;
        }

        // Gravity Sequencer Logic
        if (this.gravState && this.gravState.active) {
            const bpm = this.seqState ? this.seqState.bpm : 120;
            const msPerStep = 15000 / bpm;
            
            if (this.gravState.lastTick === 0) this.gravState.lastTick = now;
            
            if (now - this.gravState.lastTick > msPerStep) {
                this.gravState.lastTick = now;
                this.gravState.current = (this.gravState.current + 1) % this.gravState.steps;
                this.drawGravity();
            }
            
            const gVal = this.gravState.values[this.gravState.current];
            // Mapping: 0.0 (Bottom) = Gravity, 1.0 (Top) = Zero G (Apesanteur)
            // Range: 0.5 down to 0.0
            this.gravity = 0.5 * (1.0 - gVal); 
        }
        
        this.controls.update();

        const limit = this.boxSize / 2;

        // Sub-stepping for stability at high speeds
        const maxSpeedPerStep = 2.0; 
        const steps = Math.ceil(this.speedMult / maxSpeedPerStep);
        const stepSpeed = this.speedMult / steps;

        // Relation Speed/Gravity: Boost gravity at high speeds to counter collision damping energy loss
        const gScale = 1.0 + (this.speedMult * 0.15); 
        const gravVec = new THREE.Vector3(0, -this.gravity * gScale, 0);
        
        // Physics & Network Connections
        const positions = this.connections.geometry.attributes.position.array;
        let connIdx = 0;
        const distThresholdSq = 90 * 90; 

        // Physics Sub-Loop
        for(let s = 0; s < steps; s++) {
            for (let i = 0; i < this.balls.length; i++) {
                const b = this.balls[i];
                
                // Gravity
                b.vx += gravVec.x;
                b.vy += gravVec.y;
                b.vz += gravVec.z;

                // Move
                b.x += b.vx * stepSpeed;
                b.y += b.vy * stepSpeed;
                b.z += b.vz * stepSpeed;
                
                // Wall Collisions
                let collided = false;
                let impactVel = 0;
                
                if (b.x < -limit + b.radius) { 
                    impactVel = Math.abs(b.vx); b.x = -limit + b.radius; b.vx *= -1; collided = true; 
                } else if (b.x > limit - b.radius) { 
                    impactVel = Math.abs(b.vx); b.x = limit - b.radius; b.vx *= -1; collided = true; 
                }
                
                if (b.y < -limit + b.radius) { 
                    impactVel = Math.abs(b.vy); b.y = -limit + b.radius; 
                    b.vy *= -0.95; // High bounce
                    collided = true; 
                } else if (b.y > limit - b.radius) { 
                    impactVel = Math.abs(b.vy); b.y = limit - b.radius; b.vy *= -0.9; collided = true; 
                }
                
                if (b.z < -limit + b.radius) { 
                    impactVel = Math.abs(b.vz); b.z = -limit + b.radius; b.vz *= -1; collided = true; 
                } else if (b.z > limit - b.radius) { 
                    impactVel = Math.abs(b.vz); b.z = limit - b.radius; b.vz *= -1; collided = true; 
                }
                
                if (collided) this.play(b, impactVel);

                // Ball Collisions
                for (let j = i + 1; j < this.balls.length; j++) {
                    const b2 = this.balls[j];
                    const dx = b2.x - b.x;
                    const dy = b2.y - b.y;
                    const dz = b2.z - b.z;
                    const distSq = dx*dx + dy*dy + dz*dz;
                    const minDist = b.radius + b2.radius;
                    
                    if (distSq < minDist * minDist) {
                        const dist = Math.sqrt(distSq);
                        const nx = dx / dist;
                        const ny = dy / dist;
                        const nz = dz / dist;
                        
                        const overlap = (minDist - dist) * 0.5;
                        b.x -= nx * overlap;
                        b.y -= ny * overlap;
                        b.z -= nz * overlap;
                        b2.x += nx * overlap;
                        b2.y += ny * overlap;
                        b2.z += nz * overlap;
                        
                        // Relative velocity impact
                        const rvx = b.vx - b2.vx;
                        const rvy = b.vy - b2.vy;
                        const rvz = b.vz - b2.vz;
                        const impact = Math.sqrt(rvx*rvx + rvy*rvy + rvz*rvz) * 0.5;

                        // Elastic collision exchange
                        const tempVx = b.vx; const tempVy = b.vy; const tempVz = b.vz;
                        b.vx = b2.vx; b.vy = b2.vy; b.vz = b2.vz;
                        b2.vx = tempVx; b2.vy = tempVy; b2.vz = tempVz;

                        this.play(b, impact);
                        this.play(b2, impact);
                    }
                }
            }
        }

        // Update Visuals (Once per frame)
        for (let i = 0; i < this.balls.length; i++) {
            const b = this.balls[i];

            // Rotate shell/tracker
            if (b.tracker) {
                b.tracker.rotation.z += 0.05; 
                b.tracker.lookAt(this.camera.position); 
            }

            // Connection Lines
            for (let j = i + 1; j < this.balls.length; j++) {
                const b2 = this.balls[j];
                const dx = b2.x - b.x;
                const dy = b2.y - b.y;
                const dz = b2.z - b.z;
                const distSq = dx*dx + dy*dy + dz*dz;
                
                if (distSq < distThresholdSq) {
                    if (connIdx < positions.length - 6) {
                        positions[connIdx++] = b.x;
                        positions[connIdx++] = b.y;
                        positions[connIdx++] = b.z;
                        positions[connIdx++] = b2.x;
                        positions[connIdx++] = b2.y;
                        positions[connIdx++] = b2.z;
                    }
                }
            }
            
            // Mesh Pos
            b.mesh.position.set(b.x, b.y, b.z);
            
            // Trail
            if (b.trail) {
                const arr = b.trail.geometry.attributes.position.array;
                for (let k = arr.length - 1; k >= 3; k--) {
                    arr[k] = arr[k - 3];
                }
                arr[0] = b.x;
                arr[1] = b.y;
                arr[2] = b.z;
                b.trail.geometry.attributes.position.needsUpdate = true;
            }

            // Pulse
            if (b.hit > 0) {
                b.hit -= 1;
                const s = 1.0 + (b.hit / 5.0);
                b.mesh.scale.set(s, s, s);
                if (b.mesh.material) b.mesh.material.color.setHex(0xffffff);
                if (b.tracker && b.tracker.material) b.tracker.material.color.setHex(0xffffff);
            } else {
                b.mesh.scale.set(1, 1, 1);
                if (b.mesh.material) b.mesh.material.color.setHex(0x00ff66);
                if (b.tracker && b.tracker.material) b.tracker.material.color.setHex(0x00ffff);
            }
        }

        // Update Connections Buffer
        this.connections.geometry.setDrawRange(0, connIdx / 3);
        this.connections.geometry.attributes.position.needsUpdate = true;
        
        this.renderer.render(this.scene, this.camera);
    }
}