import * as THREE from 'three';

export class CursorSystem {
    constructor(scene) {
        this.scene = scene;
        this.secondaryCursors = [];
        this.init();
    }

    init() {
        // Main Cursor
        const cursorGeo = new THREE.IcosahedronGeometry(2.0, 0); 
        const cursorMat = new THREE.MeshBasicMaterial({ 
            color: 0xffffff, 
            wireframe: true, 
            transparent: true,
            opacity: 0.2
        });
        this.highlightMesh = new THREE.Mesh(cursorGeo, cursorMat);
        this.highlightMesh.visible = false;
        this.scene.add(this.highlightMesh);

        // Active Pyramid
        const activeGeo = new THREE.TetrahedronGeometry(0.5, 0); 
        // Optimized to Basic Material
        const activeMat = new THREE.MeshBasicMaterial({
            color: 0xffffff
        });
        this.activePyramid = new THREE.Mesh(activeGeo, activeMat);
        this.highlightMesh.add(this.activePyramid);

        // Secondary Cursors (Swarm)
        this.secondaryCursorGroup = new THREE.Group();
        this.scene.add(this.secondaryCursorGroup);
        
        const secGeo = new THREE.IcosahedronGeometry(1.5, 0);
        const secMat = new THREE.MeshBasicMaterial({ 
            color: 0x00ffff, 
            wireframe: true,
            transparent: true,
            opacity: 0.4
        });
        const secCoreGeo = new THREE.TetrahedronGeometry(0.4, 0);
        const secCoreMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });

        for(let i=0; i<16; i++) {
            const group = new THREE.Group();
            const mesh = new THREE.Mesh(secGeo, secMat);
            const core = new THREE.Mesh(secCoreGeo, secCoreMat);
            group.add(mesh);
            group.add(core);
            group.visible = false;
            this.secondaryCursorGroup.add(group);
            this.secondaryCursors.push(group);
        }
    }

    setCursor(index, frames, spatialMapper) {
        if (index === null || index === undefined || index < 0 || index >= frames.length) {
            this.highlightMesh.visible = false;
            return null;
        }

        const f = frames[index];
        const vec = spatialMapper(index, f);

        this.highlightMesh.position.copy(vec);
        this.highlightMesh.visible = true;
        
        this.highlightMesh.rotation.x += 0.05;
        this.highlightMesh.rotation.y += 0.05;

        const s = (f.pitch > 0) ? Math.max(0.6, f.volume * 12) : 0;
        const activeScale = s * 1.2; 
        
        this.activePyramid.scale.set(activeScale, activeScale, activeScale);
        
        if (f.pitch > 0) {
            const midi = 69 + 12 * Math.log2(f.pitch / 440);
            const hue = THREE.MathUtils.clamp((midi - 36) / 60, 0, 1);
            this.activePyramid.material.color.setHSL(hue, 1.0, 0.6);
        }

        return vec;
    }

    setSecondaryCursors(indices, frames, spatialMapper) {
        this.secondaryCursors.forEach(c => c.visible = false);

        if (!indices || indices.length === 0) return;

        indices.forEach((index, i) => {
            if (i >= this.secondaryCursors.length) return;
            if (index < 0 || index >= frames.length) return;

            const f = frames[index];
            const vec = spatialMapper(index, f);
            
            const cursor = this.secondaryCursors[i];
            cursor.position.copy(vec);
            cursor.visible = true;
            
            cursor.rotation.z -= 0.1 + (i * 0.01);
            cursor.rotation.y += 0.02;
        });
    }
}