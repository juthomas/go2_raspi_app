import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class SceneManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.moveSpeed = 1.0;
        this.keys = { w: false, a: false, s: false, d: false, e: false, zoomIn: false, zoomOut: false };
        
        // Renderer
        try {
            this.renderer = new THREE.WebGLRenderer({ 
                canvas, 
                antialias: false, // Disabled for performance
                alpha: false,
                powerPreference: "high-performance",
                depth: true,
                stencil: false
            });
            this.renderer.shadowMap.enabled = false; // Disable shadows
        } catch (e) {
            console.warn("High-perf WebGL failed, falling back to safe mode", e);
            try {
                this.renderer = new THREE.WebGLRenderer({ 
                    canvas, 
                    antialias: false,
                    powerPreference: "default"
                });
            } catch (e2) {
                console.error("WebGL completely failed", e2);
                // Suppress hard crash to allow UI to function even without 3D
            }
        }

        if (this.renderer) {
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            // Limit pixel ratio to 1.5 to reduce GPU load on high-res screens preventing white-screen crashes
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        }

        // Context Loss Handling
        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            console.warn('WebGL Context Lost!');
            // Could attempt to pause app here
        }, false);

        canvas.addEventListener('webglcontextrestored', () => {
            console.log('WebGL Context Restored');
            // Re-init logic would go here, but simple refresh is often safer
        }, false);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x111111);
        this.scene.fog = new THREE.FogExp2(0x111111, 0.0001);

        // Low Poly Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(10, 20, 10);
        this.scene.add(dirLight);

        const pointLight = new THREE.PointLight(0x00ccff, 0.5);
        pointLight.position.set(0, 20, 0);
        this.scene.add(pointLight);

        // Camera
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20000);
        this.camera.position.set(0, 20, 40); // Closer for the dense cluster

        // Controls
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        // Lock vertical angle range to keep camera somewhat level
        this.controls.maxPolarAngle = Math.PI / 1.8; 
        this.controls.minPolarAngle = Math.PI / 4;
        
        // Stop auto-rotate/focus when user manually interacts
        this.controls.addEventListener('start', () => {
            this.stopFocus();
        });

        // Interaction
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        
        this.lastFollowZ = 0;
        this.focusTarget = null;
        this.controls.autoRotate = false;
        this.controls.autoRotateSpeed = 2.0;

        window.addEventListener('resize', this.onResize.bind(this));
        window.addEventListener('keydown', (e) => this.onKey(e, true));
        window.addEventListener('keyup', (e) => this.onKey(e, false));
    }

    onKey(e, active) {
        switch(e.code) {
            // AZERTY Mapping
            // 'W' Label (Rotate) -> KeyZ physical
            case 'KeyZ': this.keys.w = active; break; 
            // 'A' Label (Up) -> KeyQ physical
            case 'KeyQ': this.keys.a = active; break;
            // 'E' Label (Down) -> KeyE physical
            case 'KeyE': this.keys.e = active; break;
            // 'Z' Label (Zoom In) -> KeyW physical (AZERTY Z is KeyW)
            case 'KeyW': this.keys.zoomIn = active; break;
            // 'S' Label (Zoom Out) -> KeyS physical (AZERTY S is KeyS)
            case 'KeyS': this.keys.zoomOut = active; break;
        }
    }

    focusOn(position) {
        this.focusTarget = position.clone();
        this.controls.autoRotate = true; 
    }

    stopFocus() {
        this.focusTarget = null;
        this.controls.autoRotate = false;
    }

    updateControls() {
        if (!this.controls) return;

        // Smoothly pan camera to focus point
        if (this.focusTarget) {
            this.controls.target.lerp(this.focusTarget, 0.05);
        }

        let moved = false;

        // A = Up, E = Down (Elevator)
        if (this.keys.a) {
            this.camera.position.y += this.moveSpeed;
            this.controls.target.y += this.moveSpeed;
            moved = true;
        }
        if (this.keys.e) {
            this.camera.position.y -= this.moveSpeed;
            this.controls.target.y -= this.moveSpeed;
            moved = true;
        }

        // W = Rotate around central axis (Orbit)
        if (this.keys.w) {
            const rotateSpeed = 0.02;
            const x = this.camera.position.x - this.controls.target.x;
            const z = this.camera.position.z - this.controls.target.z;
            
            const s = Math.sin(rotateSpeed);
            const c = Math.cos(rotateSpeed);
            
            const nx = x * c - z * s;
            const nz = x * s + z * c;
            
            this.camera.position.x = nx + this.controls.target.x;
            this.camera.position.z = nz + this.controls.target.z;
            
            this.camera.lookAt(this.controls.target);
            moved = true;
        }

        // Zoom (Z / S)
        if (this.keys.zoomIn) {
            this.dolly(1.0);
            moved = true;
        }
        if (this.keys.zoomOut) {
            this.dolly(-1.0);
            moved = true;
        }

        if (moved) {
            this.stopFocus();
        }
        
        this.controls.update();
    }

    dolly(dir) {
        const speed = this.moveSpeed * 0.5;
        const target = this.controls.target;
        const pos = this.camera.position;
        const dist = pos.distanceTo(target);

        // Limit zoom in
        if (dir > 0 && dist < 2.0) return;

        // Move towards target
        const v = new THREE.Vector3().subVectors(target, pos).normalize();
        pos.addScaledVector(v, dir * speed);
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        if (this.renderer) this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateFollow(targetZ) {
        const delta = targetZ - this.lastFollowZ;
        this.camera.position.z += delta;
        this.controls.target.z += delta;
        this.controls.update(); 
        this.lastFollowZ = targetZ;
    }
    
    resetFollow() {
        this.lastFollowZ = 0;
    }

    render() {
        this.updateControls();
        if (this.renderer) this.renderer.render(this.scene, this.camera);
    }
    
    getClickedObject(event, objects) {
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersects = this.raycaster.intersectObjects(objects, true);
        return intersects.length > 0 ? intersects[0] : null;
    }
}

