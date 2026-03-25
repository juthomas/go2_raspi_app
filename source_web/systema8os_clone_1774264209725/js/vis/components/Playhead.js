import * as THREE from 'three';

export class Playhead {
    constructor(scene, boxSize, timeScale) {
        this.scene = scene;
        this.boxSize = boxSize;
        this.timeScale = timeScale;
        
        // Ring
        this.mesh = new THREE.Mesh(
            new THREE.RingGeometry(4, 4.05, 64),
            new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide })
        );
        this.mesh.rotation.x = -Math.PI / 2;
        this.scene.add(this.mesh);

        // Particles
        this.particleCount = 400;
        this.initParticles();
    }

    initParticles() {
        this.pPos = new Float32Array(this.particleCount * 3);
        this.pLife = new Float32Array(this.particleCount);
        this.pVel = [];
        
        for(let i=0; i<this.particleCount; i++) {
            this.pVel.push(new THREE.Vector3());
            this.pLife[i] = 0;
            this.pPos[i*3] = 0;
            this.pPos[i*3+1] = 0;
            this.pPos[i*3+2] = 0;
        }
        
        const pGeo = new THREE.BufferGeometry();
        pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
        
        const pMat = new THREE.PointsMaterial({
            color: 0x00ffff,
            size: 1.2,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        
        this.particleSystem = new THREE.Points(pGeo, pMat);
        this.particleSystem.frustumCulled = false;
        this.scene.add(this.particleSystem);
    }

    update(time, volume) {
        const halfZ = this.boxSize / 2;
        const rawZ = time * this.timeScale;
        const z = (rawZ % this.boxSize) - halfZ;

        this.mesh.position.set(0, 0, z);
        
        const scale = 1 + (volume * 4.0); 
        this.mesh.scale.set(scale, scale, scale);
        
        if(this.mesh.material) {
             const t = Math.min(1, volume * 3);
             this.mesh.material.color.setHSL(0 + t*0.5, 1, 0.5 + t*0.5); 
        }

        if (volume > 0.05) {
             const count = Math.floor(volume * 10);
             this.emitParticles(this.mesh.position, count, volume);
        }

        this.updateParticles();
    }

    emitParticles(pos, count, intensity) {
        let spawned = 0;
        for(let i=0; i<this.particleCount; i++) {
            if (this.pLife[i] <= 0) {
                this.pLife[i] = 1.0;
                const angle = Math.random() * Math.PI * 2;
                const r = 2 + Math.random() * 3;
                
                this.pPos[i*3] = pos.x + Math.cos(angle) * r;
                this.pPos[i*3+1] = pos.y + Math.sin(angle) * r;
                this.pPos[i*3+2] = pos.z;
                
                this.pVel[i].set(
                    Math.cos(angle) * intensity * 0.5,
                    Math.sin(angle) * intensity * 0.5 + 0.2,
                    (Math.random() - 0.5) * 0.2
                );
                
                spawned++;
                if (spawned >= count) break;
            }
        }
    }

    updateParticles() {
        const positions = this.particleSystem.geometry.attributes.position.array;
        let active = false;
        
        for(let i=0; i<this.particleCount; i++) {
            if (this.pLife[i] > 0) {
                active = true;
                this.pLife[i] -= 0.02; 
                
                this.pVel[i].x *= 0.95; 
                this.pVel[i].y *= 0.95;
                
                positions[i*3] += this.pVel[i].x;
                positions[i*3+1] += this.pVel[i].y;
                positions[i*3+2] += this.pVel[i].z;
            } else {
                positions[i*3] = 0; 
                positions[i*3+1] = -1000;
                positions[i*3+2] = 0;
            }
        }
        
        if (active) {
            this.particleSystem.geometry.attributes.position.needsUpdate = true;
            this.particleSystem.material.opacity = 0.8; 
        }
    }

    reset() {
        this.mesh.position.z = 0;
    }

    setVisible(visible) {
        this.mesh.visible = visible;
        this.particleSystem.visible = visible;
    }
}