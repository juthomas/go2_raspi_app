import * as THREE from 'three';

export class PointCloud {
    constructor(scene, maxPoints, boxSize) {
        this.scene = scene;
        this.maxPoints = maxPoints;
        this.boxSize = boxSize;
        this.renderedCount = 0;
        
        // --- LiDAR Sound Mapper reference ---
        this.lidarMapper = null;  // Set via setLidarMapper()

        this.dummy = new THREE.Object3D();
        this.init();
    }

    init() {
        // Material - Optimized to Basic for performance
        this.pointMaterial = new THREE.MeshBasicMaterial({ 
            color: 0xffffff,
            transparent: false, // Opaque is faster
            depthWrite: true
        });
        
        // Instanced Mesh
        const geometry = new THREE.TetrahedronGeometry(0.5, 0);
        this.instancedMesh = new THREE.InstancedMesh(geometry, this.pointMaterial, this.maxPoints);
        this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.instancedMesh.count = 0;
        this.instancedMesh.frustumCulled = false; 
        this.scene.add(this.instancedMesh);

        // Dynamic Line
        this.linePositions = new Float32Array(this.maxPoints * 3);
        this.lineColors = new Float32Array(this.maxPoints * 3);

        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
        lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));
        
        const lineMat = new THREE.LineBasicMaterial({ 
            vertexColors: true,
            linewidth: 3, 
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending
        });
        this.dynamicLine = new THREE.Line(lineGeo, lineMat);
        this.dynamicLine.frustumCulled = false;
        this.scene.add(this.dynamicLine);
    }

    /**
     * Connecte le LidarSoundMapper au nuage de points.
     * @param {LidarSoundMapper} mapper
     */
    setLidarMapper(mapper) {
        this.lidarMapper = mapper;
    }

    update(frames, getSpatialPos) {
        // Rate limit updates to ~20fps (50ms) to save CPU/GPU bus
        const now = Date.now();
        if (this.lastUpdate && now - this.lastUpdate < 50) return;
        this.lastUpdate = now;

        let activeCount = frames.length;
        let startIdx = 0;
        
        // Sliding window if exceeds maxPoints
        if (activeCount > this.maxPoints) {
            startIdx = activeCount - this.maxPoints;
            activeCount = this.maxPoints;
        }

        // Only full update if count changed or forced
        // Also force update if LiDAR mapper is active (positions may change)
        const lidarActive = this.lidarMapper && this.lidarMapper.enabled && this.lidarMapper.isConnected;
        if (frames.length === this.renderedTotal && !this.forceUpdate && !lidarActive) return;

        this.instancedMesh.count = activeCount;
        const vec = new THREE.Vector3();
        const color = new THREE.Color();

        // If shifting (FIFO), we must update all indices because index 0 in mesh is now a different frame
        const isShifting = frames.length > this.maxPoints;
        // Optimization: If appending, start from last rendered count. If shifting or LiDAR active, redraw all.
        const loopStart = (isShifting || lidarActive) ? 0 : this.renderedCount;
        
        for (let i = loopStart; i < activeCount; i++) {
            const frameIdx = startIdx + i;
            const f = frames[frameIdx];
            
            getSpatialPos(f.pitch, f.time, f.centroid, vec);
            
            // Noise Logic
            const jitterScale = 6.0;
            const noiseX = (Math.sin(frameIdx * 132.5) + Math.cos(frameIdx * 12.1)) * jitterScale * f.volume;
            const noiseY = (Math.cos(frameIdx * 312.7) + Math.sin(frameIdx * 44.4)) * jitterScale * f.volume;
            const noiseZ = (Math.sin(frameIdx * 55.1) + Math.cos(frameIdx * 88.8)) * jitterScale * 2.0 * f.volume;
            
            vec.x += noiseX;
            vec.y += noiseY;
            vec.z += noiseZ;

            // ========================================================
            // LIDAR MAPPING — Modulation spatiale par les données LiDAR
            // ========================================================
            let lidarScaleMod = 1.0;
            if (lidarActive) {
                const mapped = this.lidarMapper.mapFrameToLidar(vec, f, frameIdx);
                vec.x = mapped.x;
                vec.y = mapped.y;
                vec.z = mapped.z;
                lidarScaleMod = mapped.scaleMod;
            }

            // Clamp
            const hx = this.boxSize/2, hy = this.boxSize, hz = this.boxSize/2;
            vec.x = Math.max(-hx, Math.min(hx, vec.x));
            vec.y = Math.max(-hy, Math.min(hy, vec.y));
            vec.z = Math.max(-hz, Math.min(hz, vec.z));

            // Update Line (only if within range)
            if (i < this.maxPoints) {
                this.linePositions[i * 3] = vec.x;
                this.linePositions[i * 3 + 1] = vec.y;
                this.linePositions[i * 3 + 2] = vec.z;
            }

            // Scale & Transform
            // Static calculation based on capture data, modulated by LiDAR density
            let s = (f.pitch > 0) ? Math.max(0.6, f.volume * 12) : 0;
            s *= lidarScaleMod; // Apply LiDAR density scaling

            this.dummy.position.copy(vec);
            this.dummy.rotation.set(frameIdx * 0.1, frameIdx * 0.5, frameIdx * 0.3);
            this.dummy.scale.set(s, s, s);
            this.dummy.updateMatrix();
            this.instancedMesh.setMatrixAt(i, this.dummy.matrix);

            // Color — with LiDAR influence on saturation
            if (f.pitch > 0) {
                const midi = 69 + 12 * Math.log2(f.pitch / 440);
                const hue = THREE.MathUtils.clamp((midi - 36) / 60, 0, 1);
                // LiDAR influence: boost lightness in dense LiDAR zones
                const lidarLightBoost = lidarActive ? (lidarScaleMod - 1.0) * 0.3 : 0;
                const light = Math.min(0.8, 0.5 + lidarLightBoost);
                color.setHSL(hue, 0.9, light);
            } else {
                color.setHex(0x333333);
            }
            this.instancedMesh.setColorAt(i, color);
        }

        this.renderedCount = activeCount;
        this.renderedTotal = frames.length; 
        
        // Batch Updates
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true;

        this.updateTrail(activeCount);
    }

    updateTrail(count) {
        if (!this.dynamicLine) return;
        
        const trailLength = 150; 
        const start = Math.max(0, count - trailLength);
        const drawCount = count - start;
        
        this.dynamicLine.geometry.setDrawRange(start, drawCount);
        const colors = this.dynamicLine.geometry.attributes.color.array;
        
        for (let j = start; j < count; j++) {
            const age = (j - start) / drawCount;
            const flicker = Math.random() * 0.3 + 0.7;
            
            colors[j*3] = 0.0; 
            colors[j*3+1] = (0.5 + 0.5 * age) * flicker; 
            colors[j*3+2] = (1.0) * flicker; 
        }

        this.dynamicLine.geometry.attributes.position.needsUpdate = true;
        this.dynamicLine.geometry.attributes.color.needsUpdate = true;
    }

    reset() {
        this.renderedCount = 0;
        this.renderedTotal = 0;
        this.instancedMesh.count = 0;
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        if (this.dynamicLine) {
            this.dynamicLine.geometry.setDrawRange(0, 0);
        }
    }
}