import * as THREE from 'three';

export class GridEnvironment {
    constructor(scene, boxSize) {
        this.scene = scene;
        this.boxSize = boxSize;
        this.group = new THREE.Group();
        this.init();
    }

    init() {
        // 1. Wireframe Cube
        const boxGeo = new THREE.BoxGeometry(this.boxSize, this.boxSize * 2, this.boxSize);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const boxMesh = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x666666, opacity: 0.5, transparent: true }));
        this.group.add(boxMesh);

        // 2. Floor Grid (Time axis Z, Timbre axis X)
        const gridFloor = new THREE.GridHelper(this.boxSize, 20, 0x999999, 0x444444);
        gridFloor.position.y = -this.boxSize;
        this.group.add(gridFloor);

        // 3. Axis Indicators
        // Y Axis: Pitch (Vertical)
        const pitchAxisGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -this.boxSize, 0), 
            new THREE.Vector3(0, this.boxSize, 0)
        ]);
        const pitchAxis = new THREE.Line(pitchAxisGeo, new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 }));
        this.group.add(pitchAxis);

        // X Axis: Timbre
        const timbreAxisGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-this.boxSize/2, -this.boxSize, 0), 
            new THREE.Vector3(this.boxSize/2, -this.boxSize, 0)
        ]);
        const timbreAxis = new THREE.Line(timbreAxisGeo, new THREE.LineBasicMaterial({ color: 0x0088ff, linewidth: 2 }));
        this.group.add(timbreAxis);

        this.scene.add(this.group);
    }
}