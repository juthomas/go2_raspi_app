import * as THREE from "three";
import type { Go2VoxelMapMessage } from "../../types/go2";

function rosToThreeCoords(rosX: number, rosY: number, rosZ: number): [number, number, number] {
  return [rosX, rosZ, rosY];
}

export class VoxelMapLayer {
  readonly mesh: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private envScale = 1;
  private readonly envOffset = new THREE.Vector3(0, 0, 0);
  private pointSize = 0.06;
  private maxPoints = 30_000;

  constructor(scene: THREE.Scene, options: { color?: string; pointSize?: number; maxPoints?: number } = {}) {
    this.pointSize = options.pointSize ?? 0.06;
    this.maxPoints = options.maxPoints ?? 30_000;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxPoints * 3), 3));
    geometry.setDrawRange(0, 0);

    const material = new THREE.PointsMaterial({
      color: options.color ?? "#8888ff",
      size: this.pointSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.material = material;

    this.mesh = new THREE.Points(geometry, material);
    this.mesh.name = "voxel-map";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  setColor(color: string): void {
    this.material.color.set(color);
  }

  setPointSize(size: number): void {
    this.pointSize = Math.max(0.01, size);
    this.material.size = this.pointSize;
  }

  setMaxPoints(maxPoints: number): void {
    this.maxPoints = Math.max(1000, Math.min(200_000, Math.round(maxPoints)));
    const arr = new Float32Array(this.maxPoints * 3);
    this.mesh.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    this.mesh.geometry.setDrawRange(0, 0);
  }

  setEnvTransform(scale: number, offsetX: number, offsetY: number, offsetZ: number): void {
    this.envScale = Math.max(0.01, Math.min(100, Number(scale) || 1));
    this.envOffset.set(
      Number.isFinite(offsetX) ? offsetX : 0,
      Number.isFinite(offsetY) ? offsetY : 0,
      Number.isFinite(offsetZ) ? offsetZ : 0,
    );
  }

  updateFromPayload(payload?: Go2VoxelMapMessage | null): void {
    if (!payload || !Array.isArray(payload.occupied_points) || payload.occupied_points.length === 0) {
      this.mesh.visible = false;
      return;
    }

    const points = payload.occupied_points;
    const n = Math.min(points.length, this.maxPoints);
    const arr = this.mesh.geometry.attributes.position.array as Float32Array;

    let validCount = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (!Array.isArray(p) || p.length < 3) continue;
      const [tx, ty, tz] = rosToThreeCoords(Number(p[0]), Number(p[1]), Number(p[2]));
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) continue;
      arr[validCount * 3] = tx * this.envScale + this.envOffset.x;
      arr[validCount * 3 + 1] = ty * this.envScale + this.envOffset.y;
      arr[validCount * 3 + 2] = tz * this.envScale + this.envOffset.z;
      validCount += 1;
    }

    this.mesh.geometry.setDrawRange(0, validCount);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.visible = validCount > 0;
  }
}
