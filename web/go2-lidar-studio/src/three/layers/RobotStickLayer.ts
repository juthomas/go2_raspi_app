import * as THREE from "three";
import type { Go2RobotState } from "../../types/go2";

const LEG_BASE_OFFSETS = {
  fl: new THREE.Vector3(0.22, 0, 0.14),
  fr: new THREE.Vector3(0.22, 0, -0.14),
  rl: new THREE.Vector3(-0.2, 0, 0.14),
  rr: new THREE.Vector3(-0.2, 0, -0.14),
};

// Mapping tuned for this bridge/setup: FL, FR, RL, RR (3 joints each).
// If firmware/topic order differs, this table is the single place to adjust.
const LEG_JOINT_INDEX: Record<keyof typeof LEG_BASE_OFFSETS, [number, number, number]> = {
  fl: [0, 1, 2],
  fr: [3, 4, 5],
  rl: [6, 7, 8],
  rr: [9, 10, 11],
};

function rosToThreePosition(pos: number[]): THREE.Vector3 {
  const [x = 0, y = 0, z = 0] = pos;
  return new THREE.Vector3(x, z, y);
}

export class RobotStickLayer {
  readonly root: THREE.Group;
  private readonly line: THREE.LineSegments;
  private readonly positionTrail: THREE.Line;
  private readonly trailPoints: THREE.Vector3[] = [];
  private readonly trailGeometry = new THREE.BufferGeometry();
  private scale = 1;

  constructor(scene: THREE.Scene) {
    this.root = new THREE.Group();
    this.root.name = "robot-stick";

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(48 * 3), 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: "#6ec6ff" });
    this.line = new THREE.LineSegments(lineGeometry, lineMaterial);
    this.root.add(this.line);

    const trailMat = new THREE.LineBasicMaterial({ color: "#ffbb55", transparent: true, opacity: 0.8 });
    this.positionTrail = new THREE.Line(this.trailGeometry, trailMat);
    this.positionTrail.name = "robot-position-trail";
    scene.add(this.positionTrail);

    scene.add(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.positionTrail.visible = visible;
  }

  setScale(scale: number): void {
    this.scale = Math.max(0.2, Math.min(3, scale));
    this.root.scale.setScalar(this.scale);
  }

  setTrailVisible(visible: boolean): void {
    this.positionTrail.visible = visible;
  }

  resetTrail(): void {
    this.trailPoints.length = 0;
    this.trailGeometry.setFromPoints([]);
  }

  update(robotState?: Go2RobotState): void {
    if (!robotState) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const worldPos = rosToThreePosition((robotState.position as number[]) ?? [0, 0, 0]);
    this.root.position.copy(worldPos);
    this.pushTrailPoint(worldPos);

    const rpy = (robotState.rpy as number[]) ?? [0, 0, 0];
    const roll = Number(rpy[0] ?? 0);
    const pitch = Number(rpy[1] ?? 0);
    const yaw = Number(rpy[2] ?? 0);
    // Sign fix on pitch: positive nose-up in robot frame should lift stick front visually.
    this.root.rotation.set(roll, yaw, -pitch);

    const points = this.computeStickPoints(robotState.joint_q);
    const arr = this.line.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < points.length; i++) {
      arr[i * 3] = points[i].x;
      arr[i * 3 + 1] = points[i].y;
      arr[i * 3 + 2] = points[i].z;
    }
    this.line.geometry.setDrawRange(0, points.length);
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  private pushTrailPoint(pos: THREE.Vector3): void {
    const last = this.trailPoints[this.trailPoints.length - 1];
    if (last && last.distanceToSquared(pos) < 0.0005) return;
    this.trailPoints.push(pos.clone());
    if (this.trailPoints.length > 200) this.trailPoints.shift();
    this.trailGeometry.setFromPoints(this.trailPoints);
  }

  private computeStickPoints(jointQ?: number[]): THREE.Vector3[] {
    const bodyTopFront = new THREE.Vector3(0.26, 0.24, 0);
    const bodyTopBack = new THREE.Vector3(-0.24, 0.24, 0);
    const bodyBottomFront = new THREE.Vector3(0.26, 0.08, 0);
    const bodyBottomBack = new THREE.Vector3(-0.24, 0.08, 0);
    const neckTop = new THREE.Vector3(0.34, 0.3, 0);
    const neckFront = new THREE.Vector3(0.42, 0.2, 0);

    const segments: THREE.Vector3[] = [
      bodyTopFront,
      bodyTopBack,
      bodyTopFront,
      bodyBottomFront,
      bodyTopBack,
      bodyBottomBack,
      bodyBottomFront,
      bodyBottomBack,
      bodyTopFront,
      neckTop,
      neckTop,
      neckFront,
    ];

    segments.push(...this.buildLeg("fl", jointQ));
    segments.push(...this.buildLeg("fr", jointQ));
    segments.push(...this.buildLeg("rl", jointQ));
    segments.push(...this.buildLeg("rr", jointQ));
    return segments;
  }

  private buildLeg(leg: keyof typeof LEG_BASE_OFFSETS, jointQ?: number[]): THREE.Vector3[] {
    const hip = LEG_BASE_OFFSETS[leg].clone().setY(0.14);
    const [i0, i1, i2] = LEG_JOINT_INDEX[leg];
    const qHip = Number(jointQ?.[i0] ?? 0);
    const qThigh = Number(jointQ?.[i1] ?? 0.8);
    const qCalf = Number(jointQ?.[i2] ?? -1.4);

    // Mirror abduction/adduction direction for right side legs.
    const latSign = leg === "fr" || leg === "rr" ? -1 : 1;

    const upperLen = 0.2;
    const lowerLen = 0.2;

    // Simple 3D stick-leg IK-like approximation:
    // - thigh/calf drive sagittal motion (x,y)
    // - hip roll drives lateral displacement (z)
    const knee = hip.clone().add(
      new THREE.Vector3(
        -upperLen * Math.sin(qThigh),
        -upperLen * Math.cos(qThigh),
        latSign * upperLen * Math.sin(qHip),
      ),
    );
    const foot = knee.clone().add(
      new THREE.Vector3(
        -lowerLen * Math.sin(qThigh + qCalf),
        -lowerLen * Math.cos(qThigh + qCalf),
        latSign * lowerLen * Math.sin(qHip) * 0.55,
      ),
    );

    return [hip, knee, knee, foot];
  }
}
