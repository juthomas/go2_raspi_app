export type Go2HelloMessage = {
  type: "hello";
  topic: string;
  sport_topic?: string;
  low_topic?: string;
  iface?: string;
  voxel_enabled?: boolean;
  voxel_topic?: string;
  voxel_map_source?: string;
  height_map_topic?: string;
  cloud_frames?: number;
  map_frames?: number;
  height_map_frames?: number;
  compressed_map_frames?: number;
};

export type Go2ErrorMessage = {
  type: "error";
  msg: string;
};

export type Go2RobotState = {
  mode?: number;
  gait_type?: number;
  position?: [number, number, number] | number[];
  velocity?: [number, number, number] | number[];
  yaw_speed?: number;
  rpy?: [number, number, number] | number[];
  battery_soc?: number;
  power_v?: number;
  power_a?: number;
  foot_force?: number[];
  joint_q?: number[];
  joint_dq?: number[];
  sport_age_s?: number;
  low_age_s?: number;
};

export type Go2PointCloudMessage = {
  type: "go2_pointcloud";
  stamp?: { sec: number; nanosec: number };
  frame_id?: string;
  width?: number;
  height?: number;
  point_step?: number;
  is_dense?: boolean;
  points: [number, number, number][] | number[][];
  decode_note?: string | null;
  recv_mono?: number;
  robot_state?: Go2RobotState;
};

export type Go2VoxelMapMessage = {
  type: "go2_voxel_map";
  stamp?: number;
  frame_id?: string;
  resolution?: number;
  origin?: [number, number, number] | number[];
  width?: [number, number, number] | number[];
  src_size?: number;
  compressed_size?: number;
  data_b64?: string;
  decode_note?: string | null;
  occupied_points?: [number, number, number][] | number[][];
  map_source?: string;
  height_map_topic?: string;
  recv_mono?: number;
  robot_state?: Go2RobotState;
};

export type Go2WsMessage =
  | Go2HelloMessage
  | Go2ErrorMessage
  | Go2PointCloudMessage
  | Go2VoxelMapMessage;

export const isGo2PointCloudMessage = (value: unknown): value is Go2PointCloudMessage => {
  if (!value || typeof value !== "object") return false;
  const casted = value as Partial<Go2PointCloudMessage>;
  return casted.type === "go2_pointcloud" && Array.isArray(casted.points);
};

export const isGo2VoxelMapMessage = (value: unknown): value is Go2VoxelMapMessage => {
  if (!value || typeof value !== "object") return false;
  return (value as Partial<Go2VoxelMapMessage>).type === "go2_voxel_map";
};
