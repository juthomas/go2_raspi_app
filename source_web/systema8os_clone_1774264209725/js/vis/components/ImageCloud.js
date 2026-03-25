import * as THREE from 'three';

export class ImageCloud {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        
        this.pool = [];
        this.enabled = false;
        this.capturedFaces = [];
        
        // Base geometry/material for cloning
        this.baseGeo = new THREE.PlaneGeometry(1, 1); 
        this.baseMat = new THREE.MeshBasicMaterial({ 
            color: 0xffffff, 
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        });
        this.baseFrameGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.02, 1.02));
        this.baseFrameMat = new THREE.LineBasicMaterial({ color: 0x00ff00 });

        this.expandPool(60);
    }

    expandPool(count) {
        for(let i=0; i<count; i++) {
            const m = new THREE.Mesh(this.baseGeo, this.baseMat.clone());
            m.visible = false;
            const frameMesh = new THREE.LineSegments(this.baseFrameGeo, this.baseFrameMat);
            m.add(frameMesh);
            
            this.group.add(m);
            this.pool.push(m);
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.group.visible = enabled;
    }

    addFace(frame) {
        if (!frame || !frame.bitmap) return;
        
        // Prevent duplicates
        if (!this.capturedFaces.includes(frame)) {
            this.capturedFaces.push(frame);
            
            // Limit memory usage (max 30 faces active)
            if (this.capturedFaces.length > 30) {
                const removed = this.capturedFaces.shift();
                // Ensure bitmap is closed to free GPU memory
                if (removed && removed.bitmap && removed.bitmap.close) {
                    removed.bitmap.close();
                }
            }
        }
    }

    removeFace(frame) {
        const idx = this.capturedFaces.indexOf(frame);
        if (idx !== -1) {
            this.capturedFaces.splice(idx, 1);
        }
    }

    update(frames, getSpatialPos, cameraPosition) {
        if (!this.enabled) return;

        const subset = this.capturedFaces; 
        
        if (subset.length > this.pool.length) {
            this.expandPool(subset.length - this.pool.length + 20);
        }

        let activeCount = 0;
        
        subset.forEach((f, i) => {
            const mesh = this.pool[i];
            if (!mesh) return;

            mesh.visible = true;
            
            // Position
            const vec = new THREE.Vector3();
            getSpatialPos(f.pitch, f.time, f.centroid, vec);
            mesh.position.copy(vec);
            
            // Billboard
            if (cameraPosition) mesh.lookAt(cameraPosition);
            
            // Texture Management
            if (mesh.userData.frameId !== f.id) {
                // New image assignment
                if (mesh.material.map) mesh.material.map.dispose();
                
                try {
                    // Robust check for closed/invalid bitmaps
                    const w = f.bitmap.width;
                    const h = f.bitmap.height;
                    
                    const tex = new THREE.CanvasTexture(f.bitmap);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.minFilter = THREE.LinearFilter;

                    // Fix orientation
                    tex.repeat.set(1, -1);
                    tex.offset.set(0, 1);
                    
                    mesh.material.map = tex;
                    mesh.material.needsUpdate = true;
                    mesh.userData.frameId = f.id;
                    
                    // Aspect Ratio fix
                    const aspect = w / h;
                    const size = 6.0; // Base size in world units
                    mesh.scale.set(size * aspect, size, 1);
                    // Adjust border frame scale roughly
                    mesh.children[0].scale.set(1, 1, 1); 
                } catch(e) {
                    // Bitmap likely closed or invalid, hide mesh safely
                    mesh.userData.frameId = null;
                    mesh.visible = false;
                }
            }
            
            activeCount++;
        });

        // Hide unused
        for (let i = activeCount; i < this.pool.length; i++) {
            this.pool[i].visible = false;
        }
    }
    
    reset() {
        this.capturedFaces = [];
        this.pool.forEach(m => {
            m.visible = false;
            if (m.material.map) {
                m.material.map.dispose();
                m.material.map = null;
            }
            m.userData.frameId = null;
        });
    }
}