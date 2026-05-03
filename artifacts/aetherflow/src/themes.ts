export type ThemeKey = "cyber" | "matrix" | "sunset" | "arctic" | "lava";

export interface Theme {
  key: ThemeKey;
  name: string;
  bg: string;
  panelBg: string;
  panelBorder: string;
  primary: string;
  secondary: string;
  danger: string;
  muted: string;
  text: string;
  subtext: string;
  gridLine: string;
  gridBorder: string;
  hubColor: string;
  accent: string;
  dot: string; // color swatch in picker
  statusColors: Record<string, string>;
}

export const THEMES: Record<ThemeKey, Theme> = {
  cyber: {
    key: "cyber",
    name: "CYBER",
    bg: "#05070d",
    panelBg: "rgba(0,0,0,0.82)",
    panelBorder: "rgba(0,245,255,0.14)",
    primary: "#00f5ff",
    secondary: "#f59e0b",
    danger: "#ef4444",
    muted: "#6b7280",
    text: "#00f5ff",
    subtext: "#4b5563",
    gridLine: "#0f1f2f",
    gridBorder: "#1a2a3a",
    hubColor: "#f59e0b",
    accent: "#22d3ee",
    dot: "#00f5ff",
    statusColors: {
      delivering: "#00f5ff",
      routing: "#f59e0b",
      charging: "#22d3ee",
      blocked: "#ef4444",
      idle: "#6b7280",
      dead: "#374151",
      emp: "#a855f7",
    },
  },
  matrix: {
    key: "matrix",
    name: "MATRIX",
    bg: "#000a00",
    panelBg: "rgba(0,6,0,0.88)",
    panelBorder: "rgba(0,255,65,0.16)",
    primary: "#00ff41",
    secondary: "#39ff14",
    danger: "#ff3333",
    muted: "#1a4d1a",
    text: "#00ff41",
    subtext: "#1a4020",
    gridLine: "#051205",
    gridBorder: "#0a1f0a",
    hubColor: "#39ff14",
    accent: "#00cc33",
    dot: "#00ff41",
    statusColors: {
      delivering: "#00ff41",
      routing: "#39ff14",
      charging: "#00cc33",
      blocked: "#ff3333",
      idle: "#1a4020",
      dead: "#0a1a0a",
      emp: "#cc00ff",
    },
  },
  sunset: {
    key: "sunset",
    name: "SUNSET",
    bg: "#0d0510",
    panelBg: "rgba(13,5,16,0.88)",
    panelBorder: "rgba(255,107,53,0.18)",
    primary: "#ff6b35",
    secondary: "#ffd700",
    danger: "#ff2d55",
    muted: "#6b3a5a",
    text: "#ff6b35",
    subtext: "#4a2040",
    gridLine: "#1a0a1a",
    gridBorder: "#2a1030",
    hubColor: "#ffd700",
    accent: "#ff9f43",
    dot: "#ff6b35",
    statusColors: {
      delivering: "#ff6b35",
      routing: "#ffd700",
      charging: "#ff9f43",
      blocked: "#ff2d55",
      idle: "#6b3a5a",
      dead: "#2a1030",
      emp: "#cc44ff",
    },
  },
  arctic: {
    key: "arctic",
    name: "ARCTIC",
    bg: "#020d1a",
    panelBg: "rgba(2,13,26,0.9)",
    panelBorder: "rgba(125,249,255,0.14)",
    primary: "#7df9ff",
    secondary: "#b0e0ff",
    danger: "#ff6b6b",
    muted: "#2a4a5a",
    text: "#7df9ff",
    subtext: "#2a4a5a",
    gridLine: "#071525",
    gridBorder: "#0e2035",
    hubColor: "#b0e0ff",
    accent: "#40c4ff",
    dot: "#7df9ff",
    statusColors: {
      delivering: "#7df9ff",
      routing: "#b0e0ff",
      charging: "#40c4ff",
      blocked: "#ff6b6b",
      idle: "#2a4a5a",
      dead: "#0e2035",
      emp: "#bf5fff",
    },
  },
  lava: {
    key: "lava",
    name: "LAVA",
    bg: "#0d0200",
    panelBg: "rgba(13,2,0,0.9)",
    panelBorder: "rgba(255,69,0,0.2)",
    primary: "#ff4500",
    secondary: "#ff8c00",
    danger: "#dc143c",
    muted: "#6b2200",
    text: "#ff4500",
    subtext: "#4a1500",
    gridLine: "#1a0500",
    gridBorder: "#2a0a00",
    hubColor: "#ff8c00",
    accent: "#ff6600",
    dot: "#ff4500",
    statusColors: {
      delivering: "#ff4500",
      routing: "#ff8c00",
      charging: "#ff6600",
      blocked: "#dc143c",
      idle: "#6b2200",
      dead: "#2a0a00",
      emp: "#cc44ff",
    },
  },
};
