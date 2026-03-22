import * as THREE from 'three';
import { GridEnvironment } from './components/GridEnvironment.js';
import { PointCloud } from './components/PointCloud.js';
import { ImageCloud } from './components/ImageCloud.js';
import { Playhead } from './components/Playhead.js';
import { CursorSystem } from './components/CursorSystem.js';

export class Visualizer {
    constructor(scene, store) {
        this.scene = scene;
        this.store = store;
        
        this.highlightedIndex = null;
        
        // Config
        this.maxPoints = 30000; // Cap to 30k for performance stability
        this.timeScale = 5.0; 
        this.boxSize = 60;
        
        // Components
        this.gridEnv = new GridEnvironment(this.scene, this.boxSize);
        this.pointCloud = new PointCloud(this.scene, this.maxPoints, this.boxSize);
        this.imageCloud = new ImageCloud(this.scene);
        this.playhead = new Playhead(this.scene, this.boxSize, this.timeScale);
        this.cursors = new CursorSystem(this.scene);
        
        // Segments container (Kept here for now)
        this.segmentsGroup = new THREE.Group();
        this.scene.add(this.segmentsGroup);
        
        // Expose instanced mesh for raycasting
        this.instancedMesh = this.pointCloud.instancedMesh; 
    }

    reset() {
        this.pointCloud.reset();
        this.imageCloud.reset();
        this.playhead.reset();
        
        while(this.segmentsGroup.children.length > 0){ 
            this.segmentsGroup.remove(this.segmentsGroup.children[0]); 
        }
    }

    // Helper: Calculate 3D position from audio features
    getSpatialPos(pitch, time, centroid, targetVec) {
        const halfX = this.boxSize / 2;
        const halfY = this.boxSize;
        const halfZ = this.boxSize / 2;

        const rawZ = time * this.timeScale;
        const z = (rawZ % this.boxSize) - halfZ;

        if (!pitch || pitch <= 0) {
            targetVec.set(0, -halfY, z);
            return { x: 0, y: -halfY, z };
        }

        const midi = 69 + 12 * Math.log2(pitch / 440);
        let y = (midi - 40) * 1.5; 
        
        let x = (centroid - 0.5) * this.boxSize; 

        x = Math.max(-halfX, Math.min(halfX, x));
        y = Math.max(-halfY, Math.min(halfY, y));

        targetVec.set(x, y, z);
        return { x, y, z };
    }

    // Wrapper to include noise logic for consistent cursor positioning
    calculateFullPos(index, frame) {
        const vec = new THREE.Vector3();
        this.getSpatialPos(frame.pitch, frame.time, frame.centroid, vec);
        
        const jitterScale = 6.0;
        const noiseX = (Math.sin(index * 132.5) + Math.cos(index * 12.1)) * jitterScale * frame.volume;
        const noiseY = (Math.cos(index * 312.7) + Math.sin(index * 44.4)) * jitterScale * frame.volume;
        const noiseZ = (Math.sin(index * 55.1) + Math.cos(index * 88.8)) * jitterScale * 2.0 * frame.volume;
        
        vec.x += noiseX;
        vec.y += noiseY;
        vec.z += noiseZ;

        const hx = this.boxSize/2, hy = this.boxSize, hz = this.boxSize/2;
        vec.x = Math.max(-hx, Math.min(hx, vec.x));
        vec.y = Math.max(-hy, Math.min(hy, vec.y));
        vec.z = Math.max(-hz, Math.min(hz, vec.z));
        
        return vec;
    }

    updatePoints(cameraPosition) {
        // Pass the raw spatial calculator to PointCloud
        // PointCloud handles the noise internally to avoid passing 100k vectors
        // Note: The noise logic must match calculateFullPos exactly.
        this.pointCloud.update(this.store.frames, (p, t, c, v) => this.getSpatialPos(p, t, c, v));
        this.imageCloud.update(this.store.frames, (p, t, c, v) => this.getSpatialPos(p, t, c, v), cameraPosition);
    }

    renderSegments() {
        // removed - Moved logic inside update? No, retained here.
        while(this.segmentsGroup.children.length > 0){ 
            this.segmentsGroup.remove(this.segmentsGroup.children[0]); 
        }

        const vec = new THREE.Vector3();

        this.store.segments.forEach(seg => {
            const duration = seg.endTime - seg.startTime;
            const midTime = seg.startTime + (duration / 2);
            const avgCentroid = seg.avgCentroid || 0.3; 

            this.getSpatialPos(seg.avgPitch, midTime, avgCentroid, vec);

            const zLen = Math.max(0.1, duration * this.timeScale);
            const geometry = new THREE.BoxGeometry(2.0, 0.5, zLen);
            
            const midi = 69 + 12 * Math.log2(seg.avgPitch / 440);
            const hue = THREE.MathUtils.clamp((midi - 36) / 60, 0, 1);
            const color = new THREE.Color().setHSL(hue, 0.8, 0.5);

            const material = new THREE.MeshStandardMaterial({ 
                color: color, 
                roughness: 0.1,
                metalness: 0.3,
                transparent: true,
                opacity: 0.6,
                emissive: color,
                emissiveIntensity: 0.2
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.copy(vec);
            this.segmentsGroup.add(mesh);
        });
    }

    updatePlayhead(time, volume = 0) {
        this.playhead.update(time, volume);
    }

    setPlayheadVisible(visible) {
        this.playhead.setVisible(visible);
    }

    setCursor(index) {
        this.highlightedIndex = index;
        return this.cursors.setCursor(index, this.store.frames, (i, f) => this.calculateFullPos(i, f));
    }

    setSecondaryCursors(indices) {
        this.cursors.setSecondaryCursors(indices, this.store.frames, (i, f) => this.calculateFullPos(i, f));
    }

    addFace(frame) {
        this.imageCloud.addFace(frame);
    }

    removeFace(frame) {
        this.imageCloud.removeFace(frame);
    }
}