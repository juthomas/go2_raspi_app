function rosPointCloudToThree(x, y, z) {
  return [x, z, y];
}

function toLayerCoords(rosX, rosY, rosZ) {
  const [tx, ty, tz] = rosPointCloudToThree(rosX, rosY, rosZ);
  return [tx, -ty, tz];
}

/**
 * Projette les grains audio dans l’espace à partir du dernier nuage LiDAR (GO2).
 * Aligné sur la même conversion que Go2LidarLayer (repère ROS → Three Y-up).
 */
export class LidarSoundMapper {
  constructor(options = {}) {
    this.boxSize = options.boxSize ?? 60;
    this.half = this.boxSize / 2;
    this.enabled = false;
    this.isConnected = false;
    /** @type {Float32Array} */
    this._coords = new Float32Array(0);
    this._count = 0;
    this.blendFactor = 0.5;
    this.attractionForce = 0.3;
    this.densityRadius = 3.0;
    this.minDistance = 0;
    this.maxDistance = 1.0;
    this.smoothFactor = 0.5;
    this.pointBudget = 20000;
  }

  disconnect() {
    this.isConnected = false;
    this._coords = new Float32Array(0);
    this._count = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  setBlendFactor(t) {
    this.blendFactor = t;
  }

  setAttractionForce(t) {
    this.attractionForce = t;
  }

  setDensityRadius(r) {
    this.densityRadius = r;
  }

  setMinDistance(t) {
    this.minDistance = t;
  }

  setMaxDistance(t) {
    this.maxDistance = t;
  }

  setSmoothFactor(t) {
    this.smoothFactor = t;
  }

  setPointBudget(n) {
    this.pointBudget = n;
  }

  updateFromPayload(payload) {
    if (!payload || payload.type !== "go2_pointcloud" || !Array.isArray(payload.points)) return;
    const pts = payload.points;
    const n = Math.min(pts.length, this.pointBudget);
    if (n === 0) {
      this._coords = new Float32Array(0);
      this._count = 0;
      return;
    }

    const arr = new Float32Array(n * 3);
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let valid = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!p || p.length < 3) continue;
      const [x, y, z] = toLayerCoords(p[0], p[1], p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      arr[valid * 3] = x;
      arr[valid * 3 + 1] = y;
      arr[valid * 3 + 2] = z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      valid++;
    }
    if (valid === 0) {
      this._coords = new Float32Array(0);
      this._count = 0;
      return;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const ex = Math.max(maxX - minX, 1e-3);
    const ey = Math.max(maxY - minY, 1e-3);
    const ez = Math.max(maxZ - minZ, 1e-3);
    const extent = Math.max(ex, ey, ez);
    const target = this.half * 0.85;
    const s = target / extent;
    for (let i = 0; i < valid; i++) {
      arr[i * 3] = (arr[i * 3] - cx) * s;
      arr[i * 3 + 1] = (arr[i * 3 + 1] - cy) * s;
      arr[i * 3 + 2] = (arr[i * 3 + 2] - cz) * s;
    }

    this._coords = arr.slice(0, valid * 3);
    this._count = valid;
    this.isConnected = true;
  }

  /**
   * @param {THREE.Vector3} vec position grain (espace nuage audio)
   * @returns {{ x: number; y: number; z: number; scaleMod: number }}
   */
  mapFrameToLidar(vec, frame, frameIdx) {
    const out = { x: vec.x, y: vec.y, z: vec.z, scaleMod: 1.0 };
    if (!this.enabled || !this.isConnected || this._count < 1) return out;

    const bx = vec.x;
    const by = vec.y;
    const bz = vec.z;
    const r2 = this.densityRadius * this.densityRadius;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let wsum = 0;
    let bestD2 = Infinity;
    const c = this._coords;
    const cnt = this._count;
    const step = Math.max(1, Math.floor(cnt / 8000));

    for (let i = 0; i < cnt; i += step) {
      const lx = c[i * 3];
      const ly = c[i * 3 + 1];
      const lz = c[i * 3 + 2];
      const dx = lx - bx;
      const dy = ly - by;
      const dz = lz - bz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) bestD2 = d2;
      if (d2 < r2) {
        const w = 1 / (1 + d2);
        sumX += lx * w;
        sumY += ly * w;
        sumZ += lz * w;
        wsum += w;
      }
    }

    const minD = this.minDistance * this.half;
    const maxD = this.maxDistance * this.half;
    const dist = Math.sqrt(bestD2);
    const influence =
      dist < minD ? 1 : dist > maxD ? 0 : 1 - (dist - minD) / (maxD - minD + 1e-6);

    if (wsum > 0) {
      sumX /= wsum;
      sumY /= wsum;
      sumZ /= wsum;
      const af = this.attractionForce * influence;
      const ax = bx + (sumX - bx) * af;
      const ay = by + (sumY - by) * af;
      const az = bz + (sumZ - bz) * af;
      const bl = this.blendFactor;
      out.x = bx * (1 - bl) + ax * bl;
      out.y = by * (1 - bl) + ay * bl;
      out.z = bz * (1 - bl) + az * bl;
    }

    const density = wsum / (cnt / step + 1);
    out.scaleMod = 1 + 0.5 * Math.tanh(density * 0.1) * this.smoothFactor;

    return out;
  }
}
