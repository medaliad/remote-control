export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  quality: number;
}

export const DEFAULT_VIDEO: VideoConfig = {
  width: 1280,
  height: 720,
  fps: 15,
  quality: 6,
};
