import * as THREE from "three";

/**
 * Nuage 3D LiDAR (données via événement go2-pointcloud depuis go2_lidar_bridge_client.js).
 */
export class Go2LidarLayer {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.maxPoints = options.maxPoints ?? 25000;
    this.pointSize = options.pointSize ?? 0.12;
    this.color = options.color ?? 0x00ff99;

    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(this.maxPoints * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      color: this.color,
      size: this.pointSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.mesh = new THREE.Points(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = "go2_lidar_cloud";
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  disconnect() {
    this.mesh.visible = false;
    const pos = this.mesh.geometry.attributes.position;
    this.mesh.geometry.setDrawRange(0, 0);
    pos.needsUpdate = true;
  }

  updateFromPayload(payload) {
    if (!payload || payload.type !== "go2_pointcloud" || !Array.isArray(payload.points)) {
      return;
    }
    const pts = payload.points;
    const n = Math.min(pts.length, this.maxPoints);
    if (n === 0) {
      this.mesh.visible = false;
      return;
    }

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    const sample = Math.min(n, 5000);
    for (let i = 0; i < sample; i++) {
      const p = pts[i];
      if (!p || p.length < 3) continue;
      const x = p[0],
        y = p[1],
        z = p[2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) {
      this.mesh.visible = false;
      return;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const ex = Math.max(maxX - minX, 1e-3);
    const ey = Math.max(maxY - minY, 1e-3);
    const ez = Math.max(maxZ - minZ, 1e-3);
    const extent = Math.max(ex, ey, ez);
    const target = 25;
    const s = target / extent;

    const arr = this.mesh.geometry.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!p || p.length < 3) continue;
      arr[i * 3] = (p[0] - cx) * s;
      arr[i * 3 + 1] = (p[1] - cy) * s;
      arr[i * 3 + 2] = (p[2] - cz) * s;
    }
    this.mesh.geometry.setDrawRange(0, n);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.visible = true;
  }
}
