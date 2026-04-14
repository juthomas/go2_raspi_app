import * as THREE from "three";
import type { Go2PointCloudMessage } from "../../types/go2";

export type LidarLayerOptions = {
  maxPoints?: number;
  pointSize?: number;
  historyMaxPoints?: number;
  historyRetentionMs?: number;
  currentColor?: string;
  historyColor?: string;
  centering?: "sensor" | "bbox";
  yawCorrectionRad?: number;
};

type HistoryBatch = {
  timestampMs: number;
  count: number;
  data: Float32Array;
};

function rosPointCloudToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, y];
}

function toLayerCoords(rosX: number, rosY: number, rosZ: number): [number, number, number] {
  const [tx, ty, tz] = rosPointCloudToThree(rosX, rosY, rosZ);
  // Match systema8os behavior for vertical orientation.
  return [tx, -ty, tz];
}

export class LidarPointCloudLayer {
  readonly currentMesh: THREE.Points;
  readonly historyMesh: THREE.Points;
  maxPoints: number;
  pointSize: number;
  historyRetentionMs: number;
  private historyMaxPoints: number;
  private historyEnabled = true;
  private readonly historyBatches: HistoryBatch[] = [];
  private readonly historyBuffer: Float32Array;
  private scaleLocked: number | null = null;
  private readonly centering: "sensor" | "bbox";
  private centerSmoothed: { x: number; y: number; z: number } | null = null;

  constructor(scene: THREE.Scene, options: LidarLayerOptions = {}) {
    this.maxPoints = options.maxPoints ?? 25_000;
    this.pointSize = options.pointSize ?? 0.08;
    this.historyMaxPoints = options.historyMaxPoints ?? 150_000;
    this.historyRetentionMs = options.historyRetentionMs ?? 2_500;
    this.centering = options.centering ?? "sensor";

    const currentGeo = new THREE.BufferGeometry();
    const currentPos = new Float32Array(this.maxPoints * 3);
    currentGeo.setAttribute("position", new THREE.BufferAttribute(currentPos, 3));
    currentGeo.setDrawRange(0, 0);

    const currentMat = new THREE.PointsMaterial({
      color: options.currentColor ?? "#00ff99",
      size: this.pointSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.currentMesh = new THREE.Points(currentGeo, currentMat);
    this.currentMesh.name = "lidar-current";
    this.currentMesh.frustumCulled = false;
    this.currentMesh.renderOrder = 1;
    this.currentMesh.rotation.y = options.yawCorrectionRad ?? Math.PI / 4;
    scene.add(this.currentMesh);

    const historyGeo = new THREE.BufferGeometry();
    this.historyBuffer = new Float32Array(this.historyMaxPoints * 3);
    historyGeo.setAttribute("position", new THREE.BufferAttribute(this.historyBuffer, 3));
    historyGeo.setDrawRange(0, 0);
    const historyMat = new THREE.PointsMaterial({
      color: options.historyColor ?? "#ff8844",
      size: this.pointSize * 0.85,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    this.historyMesh = new THREE.Points(historyGeo, historyMat);
    this.historyMesh.name = "lidar-history";
    this.historyMesh.frustumCulled = false;
    this.historyMesh.renderOrder = 0;
    this.historyMesh.rotation.y = options.yawCorrectionRad ?? Math.PI / 4;
    scene.add(this.historyMesh);
  }

  setCurrentColor(color: string): void {
    this.currentMesh.material.color.set(color);
  }

  setHistoryColor(color: string): void {
    this.historyMesh.material.color.set(color);
  }

  setPointSize(size: number): void {
    this.pointSize = Math.max(0.01, size);
    this.currentMesh.material.size = this.pointSize;
    this.historyMesh.material.size = this.pointSize * 0.85;
  }

  setHistoryRetentionMs(ms: number): void {
    this.historyRetentionMs = Math.max(100, Math.min(120_000, Math.round(ms)));
    this.pruneHistory(performance.now());
    this.rebuildHistoryBuffer();
  }

  setHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled;
    this.historyMesh.visible = enabled && this.historyMesh.geometry.drawRange.count > 0;
  }

  reset(): void {
    this.scaleLocked = null;
    this.centerSmoothed = null;
    this.currentMesh.geometry.setDrawRange(0, 0);
    this.currentMesh.geometry.attributes.position.needsUpdate = true;
    this.historyBatches.length = 0;
    this.historyMesh.geometry.setDrawRange(0, 0);
    this.historyMesh.geometry.attributes.position.needsUpdate = true;
  }

  updateFromPayload(payload: Go2PointCloudMessage): void {
    const points = payload.points;
    if (!Array.isArray(points) || points.length === 0) {
      this.currentMesh.visible = false;
      return;
    }

    const n = Math.min(points.length, this.maxPoints);
    const pos = this.currentMesh.geometry.attributes.position.array as Float32Array;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (!Array.isArray(p) || p.length < 3) continue;
      const [x, y, z] = toLayerCoords(Number(p[0]), Number(p[1]), Number(p[2]));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) {
      this.currentMesh.visible = false;
      return;
    }

    const rawCenterX = (minX + maxX) * 0.5;
    const rawCenterY = (minY + maxY) * 0.5;
    const rawCenterZ = (minZ + maxZ) * 0.5;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    if (this.scaleLocked == null) this.scaleLocked = 25 / extent;
    const scale = this.scaleLocked;

    let centerX = 0;
    let centerY = 0;
    let centerZ = 0;
    if (this.centering === "bbox") {
      const alpha = 0.12;
      if (!this.centerSmoothed) {
        this.centerSmoothed = { x: rawCenterX, y: rawCenterY, z: rawCenterZ };
      } else {
        this.centerSmoothed.x += alpha * (rawCenterX - this.centerSmoothed.x);
        this.centerSmoothed.y += alpha * (rawCenterY - this.centerSmoothed.y);
        this.centerSmoothed.z += alpha * (rawCenterZ - this.centerSmoothed.z);
      }
      centerX = this.centerSmoothed.x;
      centerY = this.centerSmoothed.y;
      centerZ = this.centerSmoothed.z;
    }

    let validCount = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (!Array.isArray(p) || p.length < 3) continue;
      const [x, y, z] = toLayerCoords(Number(p[0]), Number(p[1]), Number(p[2]));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      pos[validCount * 3] = (x - centerX) * scale;
      pos[validCount * 3 + 1] = (y - centerY) * scale;
      pos[validCount * 3 + 2] = (z - centerZ) * scale;
      validCount += 1;
    }

    this.currentMesh.geometry.setDrawRange(0, validCount);
    this.currentMesh.geometry.attributes.position.needsUpdate = true;
    this.currentMesh.visible = validCount > 0;

    this.pushHistory(performance.now(), validCount, pos);
  }

  private pushHistory(timestampMs: number, count: number, src: Float32Array): void {
    if (!this.historyEnabled || count <= 0) return;
    const copy = new Float32Array(count * 3);
    copy.set(src.subarray(0, count * 3));
    this.historyBatches.push({ timestampMs, count, data: copy });
    this.pruneHistory(timestampMs);
    this.rebuildHistoryBuffer();
  }

  private pruneHistory(nowMs: number): void {
    while (
      this.historyBatches.length > 0 &&
      nowMs - this.historyBatches[0].timestampMs > this.historyRetentionMs
    ) {
      this.historyBatches.shift();
    }

    let totalPoints = this.historyBatches.reduce((acc, batch) => acc + batch.count, 0);
    while (totalPoints > this.historyMaxPoints && this.historyBatches.length > 0) {
      totalPoints -= this.historyBatches[0].count;
      this.historyBatches.shift();
    }
  }

  private rebuildHistoryBuffer(): void {
    let offset = 0;
    for (const batch of this.historyBatches) {
      this.historyBuffer.set(batch.data, offset);
      offset += batch.data.length;
    }
    this.historyMesh.geometry.setDrawRange(0, offset / 3);
    this.historyMesh.geometry.attributes.position.needsUpdate = true;
    this.historyMesh.visible = this.historyEnabled && offset > 0;
  }
}
