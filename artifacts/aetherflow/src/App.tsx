import {
  useEffect, useRef, useState, useCallback, useMemo,
  Component, type ReactNode, type ErrorInfo,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import { motion, AnimatePresence } from "framer-motion";
import { THEMES, type ThemeKey, type Theme } from "./themes";

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const WS_URL = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BASE}/swarm-api/ws`;
})();
const API = `${BASE}/swarm-api`;
const GRID = 20;

// ── Types ─────────────────────────────────────────────────────────────────────
interface DroneData {
  id: string; x: number; y: number; battery: number; status: string;
  target: [number, number]; path: [number, number][];
  deliveries: number; priority: boolean; collisions_avoided: number;
}
interface Stats {
  fleet_efficiency: number; avg_battery: number; active_drones: number;
  total_drones: number; collisions_avoided: number; total_deliveries: number;
  uptime: number; paused: boolean; speed_mult: number; fleet_size: number;
}
interface SimState {
  drones: DroneData[]; hubs: [number, number][]; obstacles: [number, number][];
  no_fly_zones: [number, number][]; weather_cells: [number, number][];
  stats: Stats; log: string[];
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

function useSound(enabled: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  const getCtx = useCallback(() => {
    if (!ctx.current) ctx.current = new AudioContext();
    return ctx.current;
  }, []);
  const beep = useCallback((freq: number, dur: number, vol = 0.07, type: OscillatorType = "sine") => {
    if (!enabled) return;
    try {
      const ac = getCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      osc.connect(gain); gain.connect(ac.destination);
      osc.start(); osc.stop(ac.currentTime + dur);
    } catch (_) {}
  }, [enabled, getCtx]);
  return { beep };
}

function useFullscreen() {
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const h = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  const toggle = useCallback(() => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }, []);
  return { isFs, toggle };
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-8 w-full opacity-30 bg-gray-800 rounded" />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0), range = max - min || 1;
  const W = 200, H = 32;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * (H - 2) - 1}`
  ).join(" ");
  const fill = data.map((v, i) =>
    `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * (H - 2) - 1}`
  ).concat([`${W},${H}`, `0,${H}`]).join(" ");
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={fill} fill={color} fillOpacity={0.08} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Shortcuts Modal ───────────────────────────────────────────────────────────
function ShortcutsModal({ theme, onClose }: { theme: Theme; onClose: () => void }) {
  const shortcuts = [
    ["Space", "Pause / Resume"], ["R", "Reset simulation"], ["W", "Inject weather"],
    ["N", "Inject no-fly zone"], ["E", "EMP pulse"], ["F", "Fullscreen"],
    ["S", "Toggle sound"], ["T", "Cycle theme"], ["C", "Clear obstacles"],
    ["?", "This help screen"], ["2 / 3", "Switch 2D / 3D"],
  ];
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.75)" }} onClick={onClose}>
      <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-xl border p-6 w-72 max-w-[90vw] shadow-2xl"
        style={{ backgroundColor: theme.panelBg, borderColor: theme.panelBorder }}>
        <div className="text-xs font-bold tracking-widest mb-4" style={{ color: theme.primary }}>KEYBOARD SHORTCUTS</div>
        <div className="space-y-2">
          {shortcuts.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <kbd className="text-[10px] px-2 py-0.5 rounded font-mono border" style={{ color: theme.primary, borderColor: theme.panelBorder, backgroundColor: "rgba(255,255,255,0.04)" }}>{k}</kbd>
              <span className="text-xs" style={{ color: theme.muted }}>{v}</span>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="mt-5 w-full text-xs py-1.5 rounded border transition-opacity hover:opacity-70"
          style={{ borderColor: theme.panelBorder, color: theme.muted }}>Close</button>
      </motion.div>
    </motion.div>
  );
}

// ── 2D Canvas Renderer ────────────────────────────────────────────────────────
interface Particle { x: number; y: number; age: number; maxAge: number; color: string; r: number; }

function SimCanvas2D({
  state, theme, onCellClick, selectedDrone, onSelectDrone,
}: {
  state: SimState | null; theme: Theme; onCellClick: (x: number, y: number) => void;
  selectedDrone: string | null; onSelectDrone: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SimState | null>(null);
  const themeRef = useRef(theme);
  const frameRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);
  const heatmapRef = useRef<number[][]>(Array.from({ length: GRID }, () => new Array(GRID).fill(0)));
  const mousePosRef = useRef<{ cx: number; cy: number } | null>(null);
  const dashOffRef = useRef(0);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { selectedRef.current = selectedDrone; }, [selectedDrone]);

  // Update heatmap from state
  useEffect(() => {
    if (!state) return;
    for (const d of state.drones) {
      if (d.status === "routing" || d.status === "blocked") {
        const x = Math.round(d.x), y = Math.round(d.y);
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) {
          heatmapRef.current[x][y] = Math.min(heatmapRef.current[x][y] + 0.8, 20);
        }
      }
    }
    // Decay
    for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) {
      heatmapRef.current[x][y] *= 0.995;
    }
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let prevDrones: Record<string, { x: number; y: number }> = {};

    function resize() {
      const p = canvas!.parentElement;
      if (!p) return;
      canvas!.width = p.clientWidth;
      canvas!.height = p.clientHeight;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    const cs = () => Math.min(canvas!.width, canvas!.height) / (GRID + 2);
    const ox = () => (canvas!.width - cs() * GRID) / 2;
    const oy = () => (canvas!.height - cs() * GRID) / 2;
    const toPx = (gx: number, gy: number): [number, number] => [
      ox() + gx * cs() + cs() / 2, oy() + gy * cs() + cs() / 2,
    ];

    function draw(ts: number) {
      const s = stateRef.current;
      const t = themeRef.current;
      const C = cs(), OX = ox(), OY = oy();
      const W = canvas!.width, H = canvas!.height;
      const time = ts / 1000;
      dashOffRef.current = (dashOffRef.current + 0.4) % 100;

      ctx.fillStyle = t.bg;
      ctx.fillRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = t.gridLine;
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= GRID; i++) {
        ctx.beginPath(); ctx.moveTo(OX + i * C, OY); ctx.lineTo(OX + i * C, OY + GRID * C); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(OX, OY + i * C); ctx.lineTo(OX + GRID * C, OY + i * C); ctx.stroke();
      }
      ctx.strokeStyle = t.gridBorder; ctx.lineWidth = 1;
      ctx.strokeRect(OX, OY, GRID * C, GRID * C);

      if (!s) {
        ctx.fillStyle = t.primary + "55";
        ctx.font = `${C * 0.65}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText("Connecting to swarm...", W / 2, H / 2);
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Heatmap overlay
      const hmap = heatmapRef.current;
      const maxHeat = Math.max(...hmap.flat(), 1);
      for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) {
        const h = hmap[x][y];
        if (h < 0.2) continue;
        const alpha = (h / maxHeat) * 0.35;
        ctx.fillStyle = `rgba(239,68,68,${alpha})`;
        ctx.fillRect(OX + x * C, OY + y * C, C, C);
      }

      // Weather cells
      for (const [wx, wy] of s.weather_cells) {
        ctx.fillStyle = "rgba(124,58,237,0.2)";
        ctx.fillRect(OX + wx * C, OY + wy * C, C, C);
        ctx.strokeStyle = "rgba(124,58,237,0.3)"; ctx.lineWidth = 0.5;
        ctx.strokeRect(OX + wx * C + 0.5, OY + wy * C + 0.5, C - 1, C - 1);
      }
      // No-fly zones
      for (const [zx, zy] of s.no_fly_zones) {
        ctx.fillStyle = "rgba(220,38,38,0.15)";
        ctx.fillRect(OX + zx * C, OY + zy * C, C, C);
        ctx.strokeStyle = "rgba(220,38,38,0.4)"; ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(OX + zx * C + 1, OY + zy * C + 1, C - 2, C - 2);
        ctx.setLineDash([]);
      }
      // Obstacles
      for (const [ax, ay] of s.obstacles) {
        ctx.save();
        ctx.shadowColor = t.danger; ctx.shadowBlur = 10;
        ctx.fillStyle = t.danger + "c0";
        ctx.fillRect(OX + ax * C + C * 0.1, OY + ay * C + C * 0.1, C * 0.8, C * 0.8);
        ctx.restore();
      }

      // Particles
      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        p.age++;
        if (p.age > p.maxAge) continue;
        alive.push(p);
        const frac = 1 - p.age / p.maxAge;
        ctx.save();
        ctx.globalAlpha = frac * 0.55;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color; ctx.shadowBlur = p.r * 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * frac, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      particlesRef.current = alive;

      // Drone paths (animated dashes)
      for (const d of s.drones) {
        if (!d.path || d.path.length < 2) continue;
        const col = (t.statusColors[d.status] || t.primary);
        const isSelected = selectedRef.current === d.id;
        ctx.save();
        ctx.strokeStyle = col;
        ctx.globalAlpha = isSelected ? 0.55 : 0.22;
        ctx.lineWidth = isSelected ? 2 : 1.2;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = -dashOffRef.current;
        ctx.beginPath();
        const [sx, sy] = toPx(d.x, d.y);
        ctx.moveTo(sx, sy);
        for (const [px, py] of d.path) {
          const [ppx, ppy] = toPx(px, py);
          ctx.lineTo(ppx, ppy);
        }
        ctx.stroke(); ctx.restore();
      }

      // Hubs
      for (let i = 0; i < s.hubs.length; i++) {
        const [hx, hy] = s.hubs[i];
        const [px, py] = toPx(hx, hy);
        const pulse = 0.7 + 0.3 * Math.sin(time * 2 + i * 0.8);
        const sz = C * 0.36 * pulse;
        ctx.save();
        ctx.shadowColor = t.hubColor; ctx.shadowBlur = 16 * pulse;
        ctx.translate(px, py); ctx.rotate(time * 0.5 + i);
        ctx.fillStyle = t.hubColor + Math.round(pulse * 220).toString(16).padStart(2, "0");
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
        ctx.fillStyle = t.hubColor + "55";
        ctx.font = `bold ${C * 0.22}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText(`H${i + 1}`, px, py + sz + C * 0.25);
      }

      // Drones
      let tooltipDrone: DroneData | null = null;
      let tooltipPx = 0, tooltipPy = 0;

      for (const drone of s.drones) {
        const col = t.statusColors[drone.status] || t.primary;
        const [tx, ty] = toPx(drone.x, drone.y);
        const prev = prevDrones[drone.id];
        let ax = tx, ay = ty;
        if (prev) {
          ax = prev.x + (tx - prev.x) * 0.18;
          ay = prev.y + (ty - prev.y) * 0.18;
        }
        prevDrones[drone.id] = { x: ax, y: ay };

        // Spawn particle
        if (drone.status !== "dead" && Math.random() < 0.5) {
          particlesRef.current.push({
            x: ax + (Math.random() - 0.5) * C * 0.2,
            y: ay + (Math.random() - 0.5) * C * 0.2,
            age: 0, maxAge: 18 + Math.random() * 12,
            color: col, r: C * 0.07,
          });
        }

        const r = C * 0.2;
        const bob = Math.sin(time * 3 + parseInt(drone.id.replace("Drone-", "")) * 1.2) * C * 0.06;
        const isSelected = selectedRef.current === drone.id;
        const isDead = drone.status === "dead";

        // Check hover
        const mp = mousePosRef.current;
        if (mp) {
          const dist = Math.hypot(mp.cx - ax, mp.cy - (ay + bob));
          if (dist < r * 3.5) { tooltipDrone = drone; tooltipPx = ax; tooltipPy = ay + bob; }
        }

        // Selected ring
        if (isSelected) {
          ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.7 + Math.sin(time * 6) * 0.3;
          ctx.beginPath(); ctx.arc(ax, ay + bob, r * 2.2, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
        // Priority crown
        if (drone.priority) {
          ctx.save(); ctx.fillStyle = t.secondary; ctx.globalAlpha = 0.85;
          ctx.font = `${r * 1.2}px sans-serif`; ctx.textAlign = "center";
          ctx.fillText("★", ax, ay + bob - r * 1.8); ctx.restore();
        }
        // Outer glow
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 5;
        ctx.fillStyle = col; ctx.globalAlpha = isDead ? 0.05 : 0.12;
        ctx.beginPath(); ctx.arc(ax, ay + bob, r * 2.2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        // Drone body
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 3;
        ctx.fillStyle = col; ctx.globalAlpha = isDead ? 0.2 : 0.95;
        ctx.beginPath(); ctx.arc(ax, ay + bob, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.globalAlpha = isDead ? 0 : 0.45;
        ctx.beginPath(); ctx.arc(ax - r * 0.3, ay + bob - r * 0.3, r * 0.32, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // Battery ring
        if (!isDead) {
          const bAngle = (drone.battery / 100) * Math.PI * 2;
          const bColor = drone.battery > 60 ? t.accent : drone.battery > 30 ? t.secondary : t.danger;
          ctx.save(); ctx.strokeStyle = bColor; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7;
          ctx.beginPath(); ctx.arc(ax, ay + bob, r + 2, -Math.PI / 2, -Math.PI / 2 + bAngle); ctx.stroke(); ctx.restore();
        }
        // Label
        ctx.save(); ctx.font = `bold ${C * 0.22}px monospace`; ctx.textAlign = "center";
        ctx.fillStyle = col; ctx.globalAlpha = 0.8; ctx.shadowColor = col; ctx.shadowBlur = 4;
        ctx.fillText(drone.id.replace("Drone-", "D"), ax, ay + bob + r + C * 0.22); ctx.restore();
      }

      // Tooltip
      if (tooltipDrone) {
        const d = tooltipDrone;
        const tw = C * 3.5, th = C * 2.8;
        let bx = tooltipPx + C * 0.5, by = tooltipPy - th - C * 0.3;
        if (bx + tw > OX + GRID * C) bx = tooltipPx - tw - C * 0.5;
        if (by < OY) by = tooltipPy + C * 0.6;
        ctx.save();
        ctx.fillStyle = "rgba(5,7,13,0.92)"; ctx.strokeStyle = t.panelBorder;
        ctx.lineWidth = 1; ctx.beginPath();
        ctx.roundRect(bx, by, tw, th, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = t.statusColors[d.status] || t.primary;
        ctx.font = `bold ${C * 0.24}px monospace`; ctx.textAlign = "left";
        ctx.fillText(d.id, bx + 6, by + C * 0.42);
        ctx.fillStyle = t.muted; ctx.font = `${C * 0.2}px monospace`;
        const lines = [
          `Status: ${d.status.toUpperCase()}`,
          `Battery: ${d.battery.toFixed(1)}%`,
          `Deliveries: ${d.deliveries}`,
          `Avoided: ${d.collisions_avoided}`,
        ];
        lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + C * 0.42 + (i + 1) * C * 0.55));
        ctx.restore();
      }

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frameRef.current); ro.disconnect(); };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const C = Math.min(canvas.width, canvas.height) / (GRID + 2);
    const OX = (canvas.width - C * GRID) / 2, OY = (canvas.height - C * GRID) / 2;
    const cx = (e.clientX - rect.left) * scaleX, cy = (e.clientY - rect.top) * scaleY;

    // Check if clicked on a drone
    const s = stateRef.current;
    if (s) {
      for (const drone of s.drones) {
        const [dx, dy] = [OX + drone.x * C + C / 2, OY + drone.y * C + C / 2];
        if (Math.hypot(cx - dx, cy - dy) < C * 0.35) {
          onSelectDrone(selectedRef.current === drone.id ? null : drone.id);
          return;
        }
      }
    }
    onSelectDrone(null);
    const gx = Math.floor((cx - OX) / C), gy = Math.floor((cy - OY) / C);
    if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) onCellClick(gx, gy);
  }, [onCellClick, onSelectDrone]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mousePosRef.current = {
      cx: (e.clientX - rect.left) * (canvas.width / rect.width),
      cy: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const handleMouseLeave = useCallback(() => { mousePosRef.current = null; }, []);

  return (
    <canvas ref={canvasRef} className="w-full h-full cursor-crosshair"
      onClick={handleClick} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} />
  );
}

// ── 3D Renderer ───────────────────────────────────────────────────────────────
function toWorld(gx: number, gy: number): [number, number, number] {
  return [gx - GRID / 2 + 0.5, 0.5, gy - GRID / 2 + 0.5];
}
function Hub3D({ pos, theme }: { pos: [number, number]; theme: Theme }) {
  const r = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => { if (r.current) r.current.rotation.y += dt * 0.9; });
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  const col = theme.hubColor;
  return (
    <group position={[wx, 0, wz]}>
      <mesh ref={r}><boxGeometry args={[0.6, 0.6, 0.6]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.8} /></mesh>
      <pointLight color={col} intensity={2.5} distance={3.5} />
    </group>
  );
}
function Drone3D({ drone, theme, selected }: { drone: DroneData; theme: Theme; selected: boolean }) {
  const m = useRef<THREE.Mesh>(null);
  const l = useRef<THREE.PointLight>(null);
  const pos = useRef(new THREE.Vector3(...toWorld(drone.x, drone.y)));
  const idNum = parseInt(drone.id.replace("Drone-", ""), 10) || 0;
  const col = theme.statusColors[drone.status] || theme.primary;
  useFrame((_, dt) => {
    if (!m.current) return;
    const [tx, , tz] = toWorld(drone.x, drone.y);
    pos.current.lerp(new THREE.Vector3(tx, 0.5, tz), Math.min(1, dt * 14));
    const bob = 0.5 + Math.sin(Date.now() * 0.003 + idNum * 1.2) * 0.12;
    m.current.position.set(pos.current.x, bob, pos.current.z);
    m.current.rotation.y += dt * 1.8;
    if (l.current) { l.current.position.copy(m.current.position); l.current.intensity = 1.8 + Math.sin(Date.now() * 0.005) * 0.5; }
  });
  return (
    <group>
      <mesh ref={m}>
        <sphereGeometry args={[selected ? 0.34 : 0.26, 14, 14]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={drone.battery < 30 ? 0.25 : 0.85} metalness={0.35} roughness={0.2} />
      </mesh>
      <pointLight ref={l} color={col} intensity={selected ? 3 : 1.8} distance={3} />
    </group>
  );
}
function Scene3D({ state, theme, onCellClick, selectedDrone }: { state: SimState | null; theme: Theme; onCellClick: (x: number, y: number) => void; selectedDrone: string | null }) {
  if (!state) return null;
  return (
    <>
      <ambientLight intensity={0.15} />
      <directionalLight position={[10, 20, 10]} intensity={0.4} />
      <fog attach="fog" args={[theme.bg, 22, 58]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[GRID, GRID]} />
        <meshStandardMaterial color={theme.bg} roughness={1} />
      </mesh>
      <gridHelper args={[GRID, GRID, theme.gridLine, theme.gridLine]} position={[0, 0.01, 0]} />
      {state.hubs.map((h, i) => <Hub3D key={i} pos={h} theme={theme} />)}
      {state.obstacles.map((o, i) => {
        const [wx, , wz] = toWorld(o[0], o[1]);
        return <mesh key={i} position={[wx, 0.5, wz]}><boxGeometry args={[0.85, 1, 0.85]} /><meshStandardMaterial color={theme.danger} emissive={theme.danger} emissiveIntensity={0.45} transparent opacity={0.85} /></mesh>;
      })}
      {state.weather_cells.map((w, i) => {
        const [wx, , wz] = toWorld(w[0], w[1]);
        return <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[wx, 0.02, wz]}><planeGeometry args={[0.95, 0.95]} /><meshStandardMaterial color="#7c3aed" transparent opacity={0.28} /></mesh>;
      })}
      {state.no_fly_zones.map((z, i) => {
        const [wx, , wz] = toWorld(z[0], z[1]);
        return <mesh key={i} position={[wx, 0.3, wz]}><cylinderGeometry args={[0.45, 0.45, 0.6, 8]} /><meshStandardMaterial color={theme.danger} transparent opacity={0.3} /></mesh>;
      })}
      {state.drones.map((d) => {
        if (!d.path || d.path.length < 2) return null;
        const pts = d.path.map(([gx, gy]) => { const [wx, , wz] = toWorld(gx, gy); return new THREE.Vector3(wx, 0.6, wz); });
        if (pts.length < 2) return null;
        return <Line key={d.id + "-t"} points={pts} color={theme.statusColors[d.status] || theme.primary} lineWidth={1.2} transparent opacity={0.25} />;
      })}
      {state.drones.map((d) => <Drone3D key={d.id} drone={d} theme={theme} selected={selectedDrone === d.id} />)}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}
        onClick={(e) => { e.stopPropagation(); const x = Math.floor(e.point.x + GRID / 2), z = Math.floor(e.point.z + GRID / 2); if (x >= 0 && x < GRID && z >= 0 && z < GRID) onCellClick(x, z); }}>
        <planeGeometry args={[GRID, GRID]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
      <OrbitControls enablePan enableZoom enableRotate makeDefault minDistance={5} maxDistance={40} />
    </>
  );
}
class WebGLErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { hasError: boolean }> {
  constructor(p: { children: ReactNode; onError: () => void }) { super(p); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(_: Error, __: ErrorInfo) { this.props.onError(); }
  render() {
    if (this.state.hasError) return (
      <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: "#05070d" }}>
        <div className="text-center space-y-2 p-6"><div className="text-sm font-mono" style={{ color: "#f59e0b" }}>WebGL unavailable — switch to 2D</div></div>
      </div>
    );
    return this.props.children;
  }
}

// ── Battery Bar ───────────────────────────────────────────────────────────────
function BatteryBar({ pct, theme }: { pct: number; theme: Theme }) {
  const color = pct > 60 ? theme.accent : pct > 30 ? theme.secondary : theme.danger;
  return (
    <div className="h-1 w-full rounded-full overflow-hidden" style={{ backgroundColor: theme.panelBorder }}>
      <div style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.6s" }} className="h-full rounded-full" />
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, unit, color, theme }: { label: string; value: string | number; unit?: string; color?: string; theme: Theme }) {
  return (
    <div className="rounded-lg p-2.5 border" style={{ backgroundColor: "rgba(255,255,255,0.02)", borderColor: theme.panelBorder }}>
      <div className="text-[9px] uppercase tracking-widest mb-1" style={{ color: theme.subtext }}>{label}</div>
      <div className="text-lg font-mono font-bold leading-none" style={{ color: color || theme.primary }}>
        {value}<span className="text-[10px] ml-0.5" style={{ color: theme.subtext }}>{unit}</span>
      </div>
    </div>
  );
}

// ── Uptime ────────────────────────────────────────────────────────────────────
function Uptime({ seconds, color }: { seconds: number; color: string }) {
  const total = Math.floor(Math.max(0, isNaN(seconds) ? 0 : seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const fmt = (n: number) => String(n).padStart(2, "0");
  return <span style={{ color }} className="font-mono text-sm tabular-nums">{fmt(h)}:{fmt(m)}:{fmt(s)}</span>;
}

// ── Right Panel ───────────────────────────────────────────────────────────────
function RightPanel({
  state, theme, selectedDrone, onSelectDrone, onChaos, onClearObs, onPauseResume,
  speedMult, onSpeedChange, fleetSize, onFleetChange, chaosIntensity, onChaosIntensityChange,
  effHistory, logEndRef, isMobile, onClose, panelWidth,
}: {
  state: SimState | null; theme: Theme; selectedDrone: string | null;
  onSelectDrone: (id: string | null) => void; onChaos: (t: string) => void;
  onClearObs: () => void; onPauseResume: () => void;
  speedMult: number; onSpeedChange: (v: number) => void;
  fleetSize: number; onFleetChange: (v: number) => void;
  chaosIntensity: number; onChaosIntensityChange: (v: number) => void;
  effHistory: number[]; logEndRef: React.RefObject<HTMLDivElement | null>;
  isMobile: boolean; onClose?: () => void; panelWidth?: number;
}) {
  const stats = state?.stats;
  const sortedDrones = useMemo(() =>
    [...(state?.drones ?? [])].sort((a, b) => b.deliveries - a.deliveries),
    [state?.drones]
  );

  const SectionHead = ({ children }: { children: string }) => (
    <div className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: theme.subtext }}>{children}</div>
  );

  return (
    <div className="flex flex-col overflow-hidden" style={{
      backgroundColor: theme.panelBg,
      borderLeftWidth: isMobile ? 0 : 1, borderTopWidth: isMobile ? 1 : 0,
      borderStyle: "solid", borderColor: theme.panelBorder,
      width: isMobile ? "100%" : (panelWidth ?? 272),
      maxHeight: isMobile ? "72vh" : "100%",
    }}>
      {/* Fixed mobile header */}
      {isMobile && (
        <div className="flex items-center justify-between px-4 py-2 flex-shrink-0 border-b"
          style={{ borderColor: theme.panelBorder }}>
          <span className="text-[10px] font-bold tracking-widest" style={{ color: theme.primary }}>MISSION CONTROL</span>
          <button onClick={onClose} className="text-xs px-2 py-0.5 rounded border"
            style={{ color: theme.muted, borderColor: theme.panelBorder }}>✕</button>
        </div>
      )}

      {/* Single scrollable body */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin", scrollbarColor: `${theme.panelBorder} transparent` }}>

        {/* Fleet Stats */}
        <div className="p-3 border-b" style={{ borderColor: theme.panelBorder }}>
          <SectionHead>Fleet Stats</SectionHead>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <StatCard label="Efficiency" value={stats?.fleet_efficiency ?? "--"} unit="%" theme={theme} />
            <StatCard label="Avg Battery" value={stats?.avg_battery ?? "--"} unit="%" color={theme.accent} theme={theme} />
            <StatCard label="Active" value={stats ? `${stats.active_drones}/${stats.total_drones}` : "--"} theme={theme} />
            <StatCard label="Deliveries" value={stats?.total_deliveries ?? "--"} color={theme.secondary} theme={theme} />
          </div>
          <div className="rounded p-2 border mb-2" style={{ backgroundColor: "rgba(255,255,255,0.02)", borderColor: theme.panelBorder }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[9px] uppercase tracking-widest" style={{ color: theme.subtext }}>Efficiency (60s)</span>
              <span className="text-[9px]" style={{ color: theme.muted }}>{stats?.fleet_efficiency ?? 0}%</span>
            </div>
            <Sparkline data={effHistory} color={theme.primary} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-widest" style={{ color: theme.subtext }}>Uptime</span>
            <Uptime seconds={stats?.uptime ?? 0} color={theme.muted} />
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] uppercase tracking-widest" style={{ color: theme.subtext }}>Avoided</span>
            <span className="text-sm font-mono font-bold" style={{ color: theme.danger }}>{stats?.collisions_avoided ?? 0}</span>
          </div>
        </div>

        {/* Sim Controls */}
        <div className="p-3 border-b" style={{ borderColor: theme.panelBorder }}>
          <SectionHead>Simulation Controls</SectionHead>
          <div className="space-y-3">
            {[
              { label: "Speed", value: `${speedMult.toFixed(1)}×`, min: 0.25, max: 3, step: 0.25, val: speedMult, onChange: onSpeedChange, color: theme.primary },
              { label: "Fleet Size", value: `${fleetSize} drones`, min: 2, max: 16, step: 1, val: fleetSize, onChange: onFleetChange, color: theme.secondary },
            ].map(({ label, value, min, max, step, val, onChange, color }) => (
              <div key={label}>
                <div className="flex justify-between mb-1">
                  <span className="text-[9px]" style={{ color: theme.muted }}>{label}</span>
                  <span className="text-[9px] font-mono" style={{ color }}>{value}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={val}
                  onChange={(e) => onChange(parseFloat(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                  style={{ accentColor: color }} />
              </div>
            ))}
          </div>
        </div>

        {/* Drone Fleet */}
        <div className="p-3 border-b" style={{ borderColor: theme.panelBorder }}>
          <SectionHead>Drone Fleet{selectedDrone ? ` · ${selectedDrone}` : ""}</SectionHead>
          <div className="space-y-1.5">
            {(state?.drones ?? Array(8).fill(null)).map((d, i) => {
              if (!d) return <div key={i} className="h-10 rounded animate-pulse" style={{ backgroundColor: "rgba(255,255,255,0.04)" }} />;
              const col = theme.statusColors[d.status] || theme.muted;
              const isSel = selectedDrone === d.id;
              return (
                <button key={d.id} onClick={() => onSelectDrone(isSel ? null : d.id)}
                  className="w-full rounded p-2 border text-left transition-all"
                  style={{ backgroundColor: isSel ? col + "18" : "rgba(255,255,255,0.015)", borderColor: isSel ? col + "80" : theme.panelBorder }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold" style={{ color: col }}>{d.id}</span>
                    <div className="flex items-center gap-1">
                      {d.priority && <span style={{ color: theme.secondary }}>★</span>}
                      <span className="text-[8px] px-1 rounded" style={{ color: col, backgroundColor: col + "22" }}>{d.status}</span>
                    </div>
                  </div>
                  <BatteryBar pct={d.battery} theme={theme} />
                  <div className="flex justify-between mt-0.5">
                    <span className="text-[8px]" style={{ color: theme.subtext }}>{d.battery.toFixed(1)}%</span>
                    <span className="text-[8px]" style={{ color: theme.subtext }}>✓ {d.deliveries}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Chaos Engine */}
        <div className="p-3 border-b" style={{ borderColor: theme.panelBorder }}>
          <SectionHead>Chaos Engine</SectionHead>
          <div className="mb-3">
            <div className="flex justify-between mb-1">
              <span className="text-[9px]" style={{ color: theme.muted }}>Intensity</span>
              <span className="text-[9px] font-mono" style={{ color: theme.danger }}>{Math.round(chaosIntensity * 100)}%</span>
            </div>
            <input type="range" min={0.1} max={1} step={0.05} value={chaosIntensity}
              onChange={(e) => onChaosIntensityChange(parseFloat(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
              style={{ accentColor: theme.danger }} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: "🌩 Weather", type: "weather", bg: "rgba(124,58,237,0.22)", border: "rgba(124,58,237,0.45)", text: "#c084fc" },
              { label: "🚫 No-Fly", type: "nofly", bg: "rgba(220,38,38,0.18)", border: "rgba(220,38,38,0.45)", text: "#f87171" },
              { label: "⚡ EMP", type: "emp", bg: "rgba(168,85,247,0.18)", border: "rgba(168,85,247,0.45)", text: "#a855f7" },
              { label: "✓ Clear All", type: "clear", bg: "rgba(255,255,255,0.03)", border: theme.panelBorder, text: theme.muted },
            ].map(({ label, type, bg, border, text }) => (
              <button key={type} onClick={() => onChaos(type)}
                className="text-[9px] py-2 px-1 rounded border text-center transition-all active:scale-95"
                style={{ backgroundColor: bg, borderColor: border, color: text }}>{label}</button>
            ))}
            <button onClick={onClearObs}
              className="col-span-2 text-[9px] py-2 rounded border transition-all active:scale-95"
              style={{ backgroundColor: "rgba(255,255,255,0.02)", borderColor: theme.panelBorder, color: theme.muted }}>
              🧹 Clear Obstacles
            </button>
          </div>
        </div>

        {/* Live Log */}
        <div className="p-3">
          <SectionHead>Live Log</SectionHead>
          <div className="space-y-0.5" style={{ maxHeight: 180, overflowY: "auto" }}>
            {(state?.log ?? []).map((entry, i) => {
              const c = entry.includes("[CHAOS]") ? "#c084fc"
                : entry.includes("[GC]") ? theme.secondary
                : entry.includes("BLOCKED") ? theme.danger
                : entry.includes("Delivered") ? "#4ade80"
                : entry.includes("EMP") ? "#a855f7"
                : entry.includes("[FLEET]") ? theme.accent
                : theme.primary + "70";
              return <div key={i} className="text-[8px] leading-snug font-mono" style={{ color: c }}>{entry}</div>;
            })}
            <div ref={logEndRef} />
          </div>
        </div>

      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<SimState | null>(null);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [webglFailed, setWebglFailed] = useState(false);
  const [selectedDrone, setSelectedDrone] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [chaosIntensity, setChaosIntensity] = useState(0.55);
  const [speedMult, setSpeedMult] = useState(1.0);
  const [fleetSize, setFleetSize] = useState(8);
  const [effHistory, setEffHistory] = useState<number[]>([]);
  const [themeKey, setThemeKey] = useState<ThemeKey>(() => (localStorage.getItem("af-theme") as ThemeKey) || "cyber");
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem("af-panel-w");
    return saved ? Math.max(200, Math.min(540, parseInt(saved))) : 272;
  });
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const prevDeliveriesRef = useRef(0);
  const speedDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fleetDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingPanel = useRef(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(272);
  const isMobile = useIsMobile();
  const { beep } = useSound(soundEnabled);
  const { isFs, toggle: toggleFs } = useFullscreen();
  const theme = THEMES[themeKey];

  // Apply CSS variables for theme
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty("--af-bg", theme.bg);
    r.style.setProperty("--af-primary", theme.primary);
    r.style.setProperty("--af-secondary", theme.secondary);
    localStorage.setItem("af-theme", themeKey);
  }, [theme, themeKey]);

  // WebSocket
  useEffect(() => {
    let ws: WebSocket, retry: ReturnType<typeof setTimeout>;
    function connect() {
      ws = new WebSocket(WS_URL); wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try { setState(JSON.parse(e.data)); } catch (_) {}
      };
    }
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  // Efficiency history + sounds
  useEffect(() => {
    if (!state) return;
    setEffHistory((h) => [...h.slice(-119), state.stats.fleet_efficiency]);
    const newDel = state.stats.total_deliveries;
    if (newDel > prevDeliveriesRef.current) {
      beep(880, 0.12, 0.06);
      setTimeout(() => beep(1100, 0.1, 0.05), 80);
    }
    prevDeliveriesRef.current = newDel;
  }, [state, beep]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state?.log?.length]);

  // API helpers
  const apiPost = useCallback((path: string, body?: object) =>
    fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), []);

  const handleCellClick = useCallback((x: number, y: number) => {
    wsRef.current?.send(JSON.stringify({ type: "obstacle", x, y }));
    beep(440, 0.08, 0.05, "square");
  }, [beep]);

  const handleChaos = useCallback((type: string) => {
    apiPost("/chaos", { type, intensity: chaosIntensity });
    beep(220, 0.3, 0.08, "sawtooth");
  }, [apiPost, chaosIntensity, beep]);

  const handlePauseResume = useCallback(() => {
    const isPaused = state?.stats.paused;
    apiPost(isPaused ? "/resume" : "/pause");
    beep(isPaused ? 660 : 330, 0.15, 0.06);
  }, [state?.stats.paused, apiPost, beep]);

  const handleSpeedChange = useCallback((v: number) => {
    setSpeedMult(v);
    if (speedDebounce.current) clearTimeout(speedDebounce.current);
    speedDebounce.current = setTimeout(() => apiPost("/speed", { value: v }), 300);
  }, [apiPost]);

  const handleFleetChange = useCallback((v: number) => {
    setFleetSize(v);
    if (fleetDebounce.current) clearTimeout(fleetDebounce.current);
    fleetDebounce.current = setTimeout(() => apiPost("/fleet-size", { value: v }), 400);
  }, [apiPost]);

  const handleReset = useCallback(() => {
    apiPost("/reset");
    setEffHistory([]);
    prevDeliveriesRef.current = 0;
    beep(200, 0.4, 0.08, "sawtooth");
  }, [apiPost, beep]);

  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = `aetherflow-${Date.now()}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }, []);

  const cycleTheme = useCallback(() => {
    const keys = Object.keys(THEMES) as ThemeKey[];
    const idx = keys.indexOf(themeKey);
    setThemeKey(keys[(idx + 1) % keys.length]);
  }, [themeKey]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.key.toLowerCase()) {
        case " ": e.preventDefault(); handlePauseResume(); break;
        case "r": handleReset(); break;
        case "w": handleChaos("weather"); break;
        case "n": handleChaos("nofly"); break;
        case "e": handleChaos("emp"); break;
        case "c": fetch(`${API}/obstacles`, { method: "DELETE" }); break;
        case "f": toggleFs(); break;
        case "s": setSoundEnabled((v) => !v); break;
        case "t": cycleTheme(); break;
        case "?": setShowShortcuts((v) => !v); break;
        case "2": setMode("2d"); break;
        case "3": if (!webglFailed) setMode("3d"); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handlePauseResume, handleReset, handleChaos, toggleFs, cycleTheme, webglFailed]);

  const isPaused = state?.stats.paused ?? false;

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col font-mono select-none"
      style={{ backgroundColor: theme.bg, color: theme.text }}>

      {/* ── HUD ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 flex-shrink-0 z-10"
        style={{ backgroundColor: theme.panelBg, borderBottomColor: theme.panelBorder, borderBottomWidth: 1 }}>
        {/* Left: logo */}
        <div className="flex items-center gap-2.5 min-w-0">
          <motion.div animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1.5, repeat: Infinity }}
            className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: theme.primary }} />
          <span className="font-bold tracking-[0.2em] text-sm" style={{ color: theme.primary }}>AETHERFLOW</span>
          {!isMobile && <span className="text-[9px] hidden lg:block" style={{ color: theme.subtext }}>AUTONOMOUS LOGISTICS DIGITAL TWIN</span>}
        </div>

        {/* Right: controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Theme Picker */}
          <div className="flex items-center gap-1 p-1 rounded border" style={{ borderColor: theme.panelBorder }}>
            {(Object.values(THEMES) as Theme[]).map((t) => (
              <button key={t.key} onClick={() => setThemeKey(t.key)}
                title={t.name}
                className="w-3.5 h-3.5 rounded-full transition-all"
                style={{
                  backgroundColor: t.dot,
                  boxShadow: themeKey === t.key ? `0 0 0 2px ${t.dot}44` : "none",
                  opacity: themeKey === t.key ? 1 : 0.45,
                  transform: themeKey === t.key ? "scale(1.3)" : "scale(1)",
                }} />
            ))}
          </div>

          {/* 2D/3D Toggle */}
          <div className="flex items-center gap-0.5 p-0.5 rounded border" style={{ borderColor: theme.panelBorder }}>
            {(["2d", "3d"] as const).map((m) => (
              <button key={m} onClick={() => { if (m === "3d" && webglFailed) return; setMode(m); }}
                disabled={m === "3d" && webglFailed}
                className="text-[9px] px-2 py-0.5 rounded font-bold tracking-widest transition-all"
                style={{
                  backgroundColor: mode === m ? theme.primary + "25" : "transparent",
                  color: mode === m ? theme.primary : m === "3d" && webglFailed ? theme.subtext : theme.muted,
                  borderColor: mode === m ? theme.primary + "60" : "transparent",
                  borderWidth: 1,
                }}>{m.toUpperCase()}</button>
            ))}
          </div>

          {/* Pause/Resume */}
          <button onClick={handlePauseResume}
            className="text-[9px] px-2.5 py-1 rounded border font-bold tracking-widest transition-all hover:brightness-125"
            style={{ backgroundColor: isPaused ? theme.secondary + "22" : theme.panelBorder, borderColor: isPaused ? theme.secondary : theme.panelBorder, color: isPaused ? theme.secondary : theme.muted }}>
            {isPaused ? "▶ RUN" : "⏸ PAUSE"}
          </button>

          {/* Icon buttons */}
          {[
            { icon: soundEnabled ? "🔊" : "🔇", action: () => setSoundEnabled((v) => !v), title: "Toggle sound (S)" },
            { icon: isFs ? "⛶" : "⛶", action: toggleFs, title: "Fullscreen (F)" },
            { icon: "📸", action: handleScreenshot, title: "Screenshot" },
            { icon: "↺", action: handleReset, title: "Reset simulation (R)" },
            { icon: "?", action: () => setShowShortcuts(true), title: "Keyboard shortcuts (?)" },
          ].map(({ icon, action, title }) => (
            <button key={title} onClick={action} title={title}
              className="text-[11px] w-7 h-7 rounded border flex items-center justify-center transition-all hover:brightness-150"
              style={{ borderColor: theme.panelBorder, backgroundColor: "rgba(255,255,255,0.02)", color: theme.muted }}>
              {icon}
            </button>
          ))}

          {/* Connection */}
          <div className="flex items-center gap-1.5 ml-1">
            <motion.div animate={connected ? { opacity: [1, 0.4, 1] } : { opacity: 1 }} transition={{ duration: 1, repeat: Infinity }}
              className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: connected ? "#4ade80" : theme.danger }} />
            {!isMobile && <span className="text-[9px]" style={{ color: connected ? "#4ade80" : theme.danger }}>{connected ? "ONLINE" : "RECONNECTING"}</span>}
          </div>

          {isMobile && (
            <button onClick={() => setShowPanel(true)}
              className="text-[9px] px-2 py-1 rounded border ml-1"
              style={{ borderColor: theme.panelBorder, color: theme.primary, backgroundColor: theme.primary + "15" }}>
              STATS
            </button>
          )}
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Canvas */}
        <div className="flex-1 relative min-w-0 overflow-hidden">
          <AnimatePresence mode="wait">
            {mode === "3d" ? (
              <motion.div key="3d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full h-full">
                <WebGLErrorBoundary onError={() => { setWebglFailed(true); setMode("2d"); }}>
                  <Canvas camera={{ position: [12, 14, 12], fov: 50 }}
                    gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, failIfMajorPerformanceCaveat: false }}>
                    <Scene3D state={state} theme={theme} onCellClick={handleCellClick} selectedDrone={selectedDrone} />
                  </Canvas>
                </WebGLErrorBoundary>
              </motion.div>
            ) : (
              <motion.div key="2d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full h-full">
                <SimCanvas2D state={state} theme={theme} onCellClick={handleCellClick}
                  selectedDrone={selectedDrone} onSelectDrone={setSelectedDrone} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Overlay info */}
          <div className="absolute bottom-2 left-2 pointer-events-none">
            <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(0,0,0,0.6)", color: theme.subtext }}>
              {state ? `${state.drones.length} DRONES · ${state.obstacles.length} OBS · ${state.no_fly_zones.length} NFZ · ${state.weather_cells.length} WX` : "INITIALIZING..."}
            </span>
          </div>
          {mode === "3d" && (
            <div className="absolute top-2 right-2 pointer-events-none">
              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(0,0,0,0.5)", color: theme.subtext }}>DRAG orbit · SCROLL zoom</span>
            </div>
          )}
          {isPaused && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.5, repeat: Infinity }}
                className="text-2xl font-bold tracking-[0.3em] px-6 py-3 rounded-xl border"
                style={{ color: theme.secondary, borderColor: theme.secondary + "60", backgroundColor: "rgba(0,0,0,0.7)" }}>
                ⏸ PAUSED
              </motion.div>
            </div>
          )}
          {!isMobile && (
            <div className="absolute bottom-2 right-2 pointer-events-none">
              <span className="text-[8px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(0,0,0,0.5)", color: theme.subtext }}>CLICK grid · obstacles · select drones</span>
            </div>
          )}
        </div>

        {/* Desktop Panel — resizable */}
        {!isMobile && (
          <div className="relative flex-shrink-0 flex" style={{ width: panelWidth }}>
            {/* Drag handle on left edge */}
            <div
              className="absolute left-0 top-0 h-full z-20 flex items-center"
              style={{ width: 10, cursor: "col-resize" }}
              onPointerDown={(e) => {
                isDraggingPanel.current = true;
                dragStartX.current = e.clientX;
                dragStartW.current = panelWidth;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              onPointerMove={(e) => {
                if (!isDraggingPanel.current) return;
                const delta = dragStartX.current - e.clientX;
                const newW = Math.max(200, Math.min(540, dragStartW.current + delta));
                setPanelWidth(newW);
                localStorage.setItem("af-panel-w", String(newW));
              }}
              onPointerUp={() => {
                isDraggingPanel.current = false;
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
              }}
            >
              {/* Visual indicator */}
              <div
                className="h-full transition-opacity opacity-0 hover:opacity-100 active:opacity-100"
                style={{ width: 3, marginLeft: 3, backgroundColor: theme.primary + "60",
                  boxShadow: `0 0 6px ${theme.primary}60` }}
              />
            </div>
            <RightPanel state={state} theme={theme} selectedDrone={selectedDrone} onSelectDrone={setSelectedDrone}
              onChaos={handleChaos} onClearObs={() => fetch(`${API}/obstacles`, { method: "DELETE" })}
              onPauseResume={handlePauseResume} speedMult={speedMult} onSpeedChange={handleSpeedChange}
              fleetSize={fleetSize} onFleetChange={handleFleetChange} chaosIntensity={chaosIntensity}
              onChaosIntensityChange={setChaosIntensity} effHistory={effHistory} logEndRef={logEndRef}
              isMobile={false} panelWidth={panelWidth} />
          </div>
        )}
      </div>

      {/* ── Mobile bottom stats bar ──────────────────────────────────────── */}
      {isMobile && (
        <div className="flex items-center justify-around px-3 py-2 flex-shrink-0 border-t"
          style={{ backgroundColor: theme.panelBg, borderColor: theme.panelBorder }}>
          {[
            { label: "EFF", value: `${state?.stats.fleet_efficiency ?? "--"}%`, color: theme.primary },
            { label: "BATT", value: `${state?.stats.avg_battery ?? "--"}%`, color: theme.accent },
            { label: "DEL", value: state?.stats.total_deliveries ?? "--", color: theme.secondary },
            { label: "AVO", value: state?.stats.collisions_avoided ?? "--", color: theme.danger },
          ].map(({ label, value, color }) => (
            <div key={label} className="text-center">
              <div className="text-[7px] uppercase tracking-widest" style={{ color: theme.subtext }}>{label}</div>
              <div className="text-xs font-mono font-bold" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Mobile Panel (bottom sheet) ──────────────────────────────────── */}
      <AnimatePresence>
        {isMobile && showPanel && (
          <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-40 rounded-t-2xl overflow-hidden shadow-2xl"
            style={{ backgroundColor: theme.panelBg, borderTopColor: theme.panelBorder, borderTopWidth: 1 }}>
            <RightPanel state={state} theme={theme} selectedDrone={selectedDrone} onSelectDrone={setSelectedDrone}
              onChaos={handleChaos} onClearObs={() => fetch(`${API}/obstacles`, { method: "DELETE" })}
              onPauseResume={handlePauseResume} speedMult={speedMult} onSpeedChange={handleSpeedChange}
              fleetSize={fleetSize} onFleetChange={handleFleetChange} chaosIntensity={chaosIntensity}
              onChaosIntensityChange={setChaosIntensity} effHistory={effHistory} logEndRef={logEndRef}
              isMobile={true} onClose={() => setShowPanel(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Keyboard Shortcuts Modal ─────────────────────────────────────── */}
      <AnimatePresence>
        {showShortcuts && <ShortcutsModal theme={theme} onClose={() => setShowShortcuts(false)} />}
      </AnimatePresence>

      {/* ── Legend ───────────────────────────────────────────────────────── */}
      {!isMobile && (
        <div className="px-4 py-1 border-t flex items-center gap-4 flex-shrink-0 flex-wrap"
          style={{ backgroundColor: theme.panelBg, borderColor: theme.panelBorder }}>
          {[
            { color: theme.primary, label: "Delivering" },
            { color: theme.secondary, label: "Re-routing" },
            { color: theme.accent, label: "Charging" },
            { color: theme.danger, label: "Blocked" },
            { color: theme.hubColor, label: "Hub" },
            { color: "#7c3aed", label: "Weather" },
            { color: "#dc2626", label: "No-Fly" },
            { color: "#a855f7", label: "EMP" },
            { color: theme.danger, label: "Obstacle (click)" },
          ].map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="text-[8px]" style={{ color: theme.subtext }}>{label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
