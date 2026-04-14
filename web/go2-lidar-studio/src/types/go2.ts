export type Go2HelloMessage = {
  type: "hello";
  topic: string;
  sport_topic?: string;
  low_topic?: string;
  iface?: string;
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

export type Go2WsMessage = Go2HelloMessage | Go2ErrorMessage | Go2PointCloudMessage;

export const isGo2PointCloudMessage = (value: unknown): value is Go2PointCloudMessage => {
  if (!value || typeof value !== "object") return false;
  const casted = value as Partial<Go2PointCloudMessage>;
  return casted.type === "go2_pointcloud" && Array.isArray(casted.points);
};
