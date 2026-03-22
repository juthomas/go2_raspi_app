import * as THREE from "three";

/**
 * ROS sensor_msgs / REP-103 (x avant, y gauche, z haut) → Three.js Y-up
 * (plan horizontal LiDAR = xy ROS → plan sol xz Three). Sans ça, le balayage
 * 360° apparaît "debout" et le centre visuel ne correspond pas au capteur.
 */
function rosPointCloudToThree(x, y, z) {
  return [x, z, y];
}

/** Coordonnées dans la scène Three (ROS→Three puis haut/bas inversés sur Y Three). */
function toLayerCoords(rosX, rosY, rosZ) {
  const [tx, ty, tz] = rosPointCloudToThree(rosX, rosY, rosZ);
  // ty = hauteur (ROS z → Three Y) : inverser pour corriger haut/bas à l’écran
  return [tx, -ty, tz];
}

/**
 * Nuage 3D LiDAR (données via événement go2-pointcloud depuis go2_lidar_bridge_client.js).
 */
export class Go2LidarLayer {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.maxPoints = options.maxPoints ?? 25000;
    this.pointSize = options.pointSize ?? 0.12;
    this.color = options.color ?? 0x00ff99;
    /**
     * "sensor" : pas de translation — le repère du nuage est supposé être le capteur
     * (axe de rotation à l'origine). Évite le faux décalage d'un LiDAR rotatif quand
     * le centre AABB change à chaque frame (sous-échantillonnage, sol, asymétrie).
     * "bbox" : centre sur la boîte englobante, avec lissage pour réduire le jitter.
     */
    this.centering = options.centering ?? "sensor";
    /** @type {{ x: number; y: number; z: number } | null} */
    this._centerSmoothed = null;
    /**
     * Échelle fixe entre les frames : soit `options.scale` (nombre > 0),
     * soit verrouillage sur la 1ère frame (`target / extent`). Pas de lissage.
     * @type {number | null}
     */
    this._scaleLocked = null;
    /** Si défini (>0), utilisé à la place du verrouillage auto. */
    this.fixedScale = typeof options.scale === "number" && options.scale > 0 ? options.scale : null;

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
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.scene.add(this.mesh);

    /** Persistance des scans précédents pour voir la forme 3D (autre couleur). */
    this.historyEnabled = options.historyEnabled !== false;
    this.historyRetentionMs = options.historyRetentionMs ?? 2500;
    this.historyMaxPoints = options.historyMaxPoints ?? 150000;
    this.historyColor = options.historyColor ?? 0xff8844;
    this.historyOpacity = options.historyOpacity ?? 0.45;
    this.historyPointSize =
      typeof options.historyPointSize === "number" ? options.historyPointSize : this.pointSize * 0.85;
    /** @type {{ t: number; count: number; data: Float32Array }[]} */
    this._historyBatches = [];
    this._historyPosBuffer = new Float32Array(this.historyMaxPoints * 3);

    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute("position", new THREE.BufferAttribute(this._historyPosBuffer, 3));
    hGeo.setDrawRange(0, 0);
    const hMat = new THREE.PointsMaterial({
      color: this.historyColor,
      size: this.historyPointSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: this.historyOpacity,
      depthWrite: false,
    });
    this.historyMesh = new THREE.Points(hGeo, hMat);
    this.historyMesh.frustumCulled = false;
    this.historyMesh.name = "go2_lidar_history";
    this.historyMesh.renderOrder = 0;
    this.historyMesh.visible = false;
    this.scene.add(this.historyMesh);
  }

  disconnect() {
    this.mesh.visible = false;
    const pos = this.mesh.geometry.attributes.position;
    this.mesh.geometry.setDrawRange(0, 0);
    pos.needsUpdate = true;
    this._centerSmoothed = null;
    this._scaleLocked = null;
    this._historyBatches.length = 0;
    if (this.historyMesh) {
      this.historyMesh.visible = false;
      this.historyMesh.geometry.setDrawRange(0, 0);
      this.historyMesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  /**
   * Met à jour le nuage d’historique : garde les scans récents + fusion dans le buffer.
   */
  _pushHistoryFrame(now, n, arr) {
    if (!this.historyEnabled || n <= 0) return;
    const copy = new Float32Array(n * 3);
    copy.set(arr.subarray(0, n * 3));
    this._historyBatches.push({ t: now, count: n, data: copy });

    const ret = this.historyRetentionMs;
    while (this._historyBatches.length && now - this._historyBatches[0].t > ret) {
      this._historyBatches.shift();
    }

    let total = 0;
    for (const b of this._historyBatches) total += b.count;
    while (total > this.historyMaxPoints && this._historyBatches.length) {
      total -= this._historyBatches[0].count;
      this._historyBatches.shift();
    }

    let off = 0;
    for (const b of this._historyBatches) {
      this._historyPosBuffer.set(b.data, off);
      off += b.data.length;
    }
    const hAttr = this.historyMesh.geometry.attributes.position;
    hAttr.needsUpdate = true;
    this.historyMesh.geometry.setDrawRange(0, off / 3);
    this.historyMesh.visible = off > 0;
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
      const [x, y, z] = toLayerCoords(p[0], p[1], p[2]);
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

    const rawCx = (minX + maxX) * 0.5;
    const rawCy = (minY + maxY) * 0.5;
    const rawCz = (minZ + maxZ) * 0.5;
    const ex = Math.max(maxX - minX, 1e-3);
    const ey = Math.max(maxY - minY, 1e-3);
    const ez = Math.max(maxZ - minZ, 1e-3);
    const extent = Math.max(ex, ey, ez);
    const target = 25;
    const sInstant = target / extent;

    let s;
    if (this.fixedScale != null) {
      s = this.fixedScale;
    } else if (this._scaleLocked != null) {
      s = this._scaleLocked;
    } else {
      this._scaleLocked = sInstant;
      s = this._scaleLocked;
    }

    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (this.centering === "bbox") {
      const a = 0.12;
      if (!this._centerSmoothed) {
        this._centerSmoothed = { x: rawCx, y: rawCy, z: rawCz };
      } else {
        this._centerSmoothed.x += a * (rawCx - this._centerSmoothed.x);
        this._centerSmoothed.y += a * (rawCy - this._centerSmoothed.y);
        this._centerSmoothed.z += a * (rawCz - this._centerSmoothed.z);
      }
      cx = this._centerSmoothed.x;
      cy = this._centerSmoothed.y;
      cz = this._centerSmoothed.z;
    }

    const arr = this.mesh.geometry.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!p || p.length < 3) continue;
      const [tx, ty, tz] = toLayerCoords(p[0], p[1], p[2]);
      arr[i * 3] = (tx - cx) * s;
      arr[i * 3 + 1] = (ty - cy) * s;
      arr[i * 3 + 2] = (tz - cz) * s;
    }
    this.mesh.geometry.setDrawRange(0, n);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.visible = true;

    this._pushHistoryFrame(performance.now(), n, arr);
  }
}
