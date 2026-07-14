import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Go2PointCloudMessage, Go2RobotState, Go2VoxelMapMessage } from "../types/go2";
import type { UiSettings } from "../state/useGo2Store";
import { LidarPointCloudLayer } from "./layers/LidarPointCloudLayer";
import { RobotStickLayer } from "./layers/RobotStickLayer";
import { VoxelMapLayer } from "./layers/VoxelMapLayer";

type Props = {
  payload: Go2PointCloudMessage | null;
  voxelPayload: Go2VoxelMapMessage | null;
  robotState: Go2RobotState | null;
  settings: UiSettings;
};

type SceneRefs = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  lidar: LidarPointCloudLayer;
  voxel: VoxelMapLayer;
  robot: RobotStickLayer;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
};

export function SceneCanvas({ payload, voxelPayload, robotState, settings }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneRefs | null>(null);

  const mapRobotPosToScene = (rosPos: number[]) => {
    const [x = 0, y = 0, z = 0] = rosPos;
    return new THREE.Vector3(
      x * settings.envScale + settings.envOffsetX,
      z * settings.envScale + settings.envOffsetY,
      y * settings.envScale + settings.envOffsetZ,
    );
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05070a");

    const camera = new THREE.PerspectiveCamera(65, mount.clientWidth / mount.clientHeight, 0.01, 3000);
    camera.position.set(2.8, 2.2, 2.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.4, 0);
    controls.update();

    const hemi = new THREE.HemisphereLight("#7ec8ff", "#101010", 0.8);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight("#ffffff", 0.7);
    dir.position.set(5, 8, 4);
    scene.add(dir);

    const grid = new THREE.GridHelper(30, 30, "#226688", "#1f2d3a");
    scene.add(grid);
    const axes = new THREE.AxesHelper(0.7);
    scene.add(axes);

    const lidar = new LidarPointCloudLayer(scene, {
      maxPoints: settings.maxPoints,
      pointSize: settings.pointSize,
      historyRetentionMs: settings.historyRetentionSec * 1000,
      currentColor: settings.currentColor,
      historyColor: settings.historyColor,
    });
    const voxel = new VoxelMapLayer(scene, {
      color: settings.voxelColor,
      maxPoints: settings.voxelMaxPoints,
    });
    const robot = new RobotStickLayer(scene);
    robot.setScale(settings.robotScale);
    robot.setEnvTransform(settings.envScale, settings.envOffsetX, settings.envOffsetY, settings.envOffsetZ);
    robot.setVisible(settings.showRobot);
    robot.setTrailVisible(settings.showTrail);
    voxel.setEnvTransform(settings.envScale, settings.envOffsetX, settings.envOffsetY, settings.envOffsetZ);
    voxel.setVisible(settings.showVoxel);

    sceneRef.current = { camera, controls, lidar, voxel, robot, grid, axes };

    let raf = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs || !payload) return;
    refs.lidar.updateFromPayload(payload);
  }, [payload]);

  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    refs.voxel.updateFromPayload(voxelPayload);
  }, [voxelPayload, settings.envScale, settings.envOffsetX, settings.envOffsetY, settings.envOffsetZ]);

  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    refs.robot.update(robotState ?? undefined);
    if (settings.followRobot && robotState?.position && Array.isArray(robotState.position)) {
      const p = mapRobotPosToScene(robotState.position as number[]);
      refs.controls.target.set(p.x, p.y, p.z);
    }
  }, [
    robotState,
    settings.followRobot,
    settings.envScale,
    settings.envOffsetX,
    settings.envOffsetY,
    settings.envOffsetZ,
  ]);

  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    refs.lidar.setPointSize(settings.pointSize);
    refs.lidar.maxPoints = settings.maxPoints;
    refs.lidar.setCurrentColor(settings.currentColor);
    refs.lidar.setHistoryColor(settings.historyColor);
    refs.lidar.setHistoryRetentionMs(settings.historyRetentionSec * 1000);
    refs.lidar.setHistoryEnabled(settings.showHistory);
    refs.voxel.setColor(settings.voxelColor);
    refs.voxel.setMaxPoints(settings.voxelMaxPoints);
    refs.voxel.setVisible(settings.showVoxel);
    refs.voxel.setEnvTransform(
      settings.envScale,
      settings.envOffsetX,
      settings.envOffsetY,
      settings.envOffsetZ,
    );
    refs.robot.setVisible(settings.showRobot);
    refs.robot.setScale(settings.robotScale);
    refs.robot.setEnvTransform(
      settings.envScale,
      settings.envOffsetX,
      settings.envOffsetY,
      settings.envOffsetZ,
    );
    refs.robot.setTrailVisible(settings.showTrail);
    refs.grid.visible = settings.showGrid;
    refs.axes.visible = settings.showAxes;
  }, [settings]);

  return <div className="scene-canvas" ref={mountRef} />;
}
