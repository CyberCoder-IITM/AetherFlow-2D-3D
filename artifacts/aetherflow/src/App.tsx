import {
  useEffect,
  useRef,
  useState,
  useCallback,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import { motion, AnimatePresence } from "framer-motion";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const WS_URL = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BASE}/swarm-api/ws`;
})();
const API = `${BASE}/swarm-api`;

// ── Types ─────────────────────────────────────────────────────────────────────
interface DroneData {
  id: string;
  x: number;
  y: number;
  battery: number;
  status: string;
  target: [number, number];
  path: [number, number][];
}
interface Stats {
  fleet_efficiency: number;
  avg_battery: number;
  active_drones: number;
  total_drones: number;
  collisions_avoided: number;
}
interface SimState {
  drones: DroneData[];
  hubs: [number, number][];
  obstacles: [number, number][];
  no_fly_zones: [number, number][];
  weather_cells: [number, number][];
  stats: Stats;
  log: string[];
}

const STATUS_COLOR: Record<string, string> = {
  delivering: "#00f5ff",
  routing: "#f59e0b",
  charging: "#22d3ee",
  blocked: "#ef4444",
  idle: "#6b7280",
  dead: "#374151",
};
const GRID = 20;
const CELL = 1;

// ─────────────────────────────────────────────────────────────────────────────
// 3D RENDERER
// ─────────────────────────────────────────────────────────────────────────────

function toWorld(gx: number, gy: number): [number, number, number] {
  return [gx * CELL - GRID / 2 + 0.5, 0.5, gy * CELL - GRID / 2 + 0.5];
}

function GridFloor3D() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[GRID, GRID]} />
        <meshStandardMaterial color="#0a0a0f" roughness={1} metalness={0} />
      </mesh>
      <gridHelper args={[GRID, GRID, "#1a2a3a", "#0f1f2f"]} position={[0, 0.01, 0]} />
    </group>
  );
}

function Hub3D({ pos, idx }: { pos: [number, number]; idx: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.9;
  });
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <group position={[wx, 0, wz]}>
      <mesh ref={ref}>
        <boxGeometry args={[0.6, 0.6, 0.6]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.7} />
      </mesh>
      <pointLight color="#f59e0b" intensity={2.5} distance={3.5} />
    </group>
  );
}

function Obstacle3D({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh position={[wx, 0.5, wz]}>
      <boxGeometry args={[0.85, 1.0, 0.85]} />
      <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.45} transparent opacity={0.85} />
    </mesh>
  );
}

function NoFlyZone3D({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh position={[wx, 0.3, wz]}>
      <cylinderGeometry args={[0.45, 0.45, 0.6, 8]} />
      <meshStandardMaterial color="#dc2626" transparent opacity={0.35} emissive="#dc2626" emissiveIntensity={0.2} />
    </mesh>
  );
}

function WeatherCell3D({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx, 0.02, wz]}>
      <planeGeometry args={[0.95, 0.95]} />
      <meshStandardMaterial color="#7c3aed" transparent opacity={0.28} />
    </mesh>
  );
}

function DroneTrail3D({ drone }: { drone: DroneData }) {
  if (!drone.path || drone.path.length < 2) return null;
  const points = drone.path.map(([gx, gy]) => {
    const [wx, , wz] = toWorld(gx, gy);
    return new THREE.Vector3(wx, 0.6, wz);
  });
  if (points.length < 2) return null;
  return (
    <Line
      points={points}
      color={STATUS_COLOR[drone.status] || "#00f5ff"}
      lineWidth={1.2}
      transparent
      opacity={0.28}
    />
  );
}

function Drone3D({ drone }: { drone: DroneData }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const posRef = useRef(new THREE.Vector3(...toWorld(drone.x, drone.y)));
  const idNum = parseInt(drone.id.replace("Drone-", ""), 10) || 0;

  useFrame((_, dt) => {
    if (!meshRef.current) return;
    const [tx, , tz] = toWorld(drone.x, drone.y);
    posRef.current.lerp(new THREE.Vector3(tx, 0.5, tz), Math.min(1, dt * 14));
    const bobY = 0.5 + Math.sin(Date.now() * 0.003 + idNum * 1.2) * 0.12;
    meshRef.current.position.set(posRef.current.x, bobY, posRef.current.z);
    meshRef.current.rotation.y += dt * 1.8;
    if (lightRef.current) {
      lightRef.current.position.copy(meshRef.current.position);
      lightRef.current.intensity = 1.8 + Math.sin(Date.now() * 0.005) * 0.5;
    }
  });

  const color = STATUS_COLOR[drone.status] || "#00f5ff";
  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.28, 14, 14]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={drone.battery < 30 ? 0.25 : 0.85}
          metalness={0.35}
          roughness={0.2}
        />
      </mesh>
      <pointLight ref={lightRef} color={color} intensity={1.8} distance={2.8} />
    </group>
  );
}

function ClickPlane3D({ onCellClick }: { onCellClick: (x: number, y: number) => void }) {
  const planeRef = useRef<THREE.Mesh>(null);
  return (
    <mesh
      ref={planeRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.001, 0]}
      onClick={(e) => {
        e.stopPropagation();
        const x = Math.floor(e.point.x + GRID / 2);
        const z = Math.floor(e.point.z + GRID / 2);
        if (x >= 0 && x < GRID && z >= 0 && z < GRID) onCellClick(x, z);
      }}
    >
      <planeGeometry args={[GRID, GRID]} />
      <meshBasicMaterial transparent opacity={0} />
    </mesh>
  );
}

function Scene3D({ state, onCellClick }: { state: SimState | null; onCellClick: (x: number, y: number) => void }) {
  if (!state) return null;
  return (
    <>
      <ambientLight intensity={0.15} color="#0a1a2a" />
      <directionalLight position={[10, 20, 10]} intensity={0.4} />
      <fog attach="fog" args={["#05070d", 22, 58]} />
      <GridFloor3D />
      {state.hubs.map((h, i) => <Hub3D key={i} pos={h} idx={i} />)}
      {state.weather_cells.map((w, i) => <WeatherCell3D key={i} pos={w} />)}
      {state.obstacles.map((o, i) => <Obstacle3D key={i} pos={o} />)}
      {state.no_fly_zones.map((z, i) => <NoFlyZone3D key={i} pos={z} />)}
      {state.drones.map((d) => <DroneTrail3D key={d.id + "-trail"} drone={d} />)}
      {state.drones.map((d) => <Drone3D key={d.id} drone={d} />)}
      <ClickPlane3D onCellClick={onCellClick} />
      <OrbitControls enablePan enableZoom enableRotate makeDefault minDistance={5} maxDistance={40} />
    </>
  );
}

// ── WebGL Error Boundary ──────────────────────────────────────────────────────
class WebGLErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onError: () => void }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(_: Error, __: ErrorInfo) {
    this.props.onError();
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-[#05070d]">
          <div className="text-center space-y-3 p-6">
            <div className="text-amber-400 text-sm font-mono">WebGL not available in this environment</div>
            <div className="text-gray-500 text-xs">Switch to 2D mode to view the simulation</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D CANVAS RENDERER
// ─────────────────────────────────────────────────────────────────────────────

function SimCanvas2D({
  state,
  onCellClick,
}: {
  state: SimState | null;
  onCellClick: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SimState | null>(null);
  const frameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const droneAnimRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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
      ox() + gx * cs() + cs() / 2,
      oy() + gy * cs() + cs() / 2,
    ];

    function draw(ts: number) {
      const dt = Math.min((ts - timeRef.current) / 1000, 0.1);
      timeRef.current = ts;
      const s = stateRef.current;
      const C = cs(), OX = ox(), OY = oy();
      const W = canvas!.width, H = canvas!.height;

      ctx.fillStyle = "#05070d";
      ctx.fillRect(0, 0, W, H);

      // Grid
      ctx.strokeStyle = "#0f1f2f";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= GRID; i++) {
        ctx.beginPath(); ctx.moveTo(OX + i * C, OY); ctx.lineTo(OX + i * C, OY + GRID * C); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(OX, OY + i * C); ctx.lineTo(OX + GRID * C, OY + i * C); ctx.stroke();
      }
      ctx.strokeStyle = "#1a2a3a";
      ctx.lineWidth = 1;
      ctx.strokeRect(OX, OY, GRID * C, GRID * C);

      if (!s) {
        ctx.fillStyle = "#00f5ff44";
        ctx.font = `${C * 0.7}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText("Connecting to swarm...", W / 2, H / 2);
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Weather
      for (const [wx, wy] of s.weather_cells) {
        ctx.fillStyle = "rgba(124,58,237,0.18)";
        ctx.fillRect(OX + wx * C, OY + wy * C, C, C);
      }
      // No-fly
      for (const [zx, zy] of s.no_fly_zones) {
        ctx.fillStyle = "rgba(220,38,38,0.18)";
        ctx.fillRect(OX + zx * C, OY + zy * C, C, C);
        ctx.strokeStyle = "rgba(220,38,38,0.45)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(OX + zx * C + 1, OY + zy * C + 1, C - 2, C - 2);
      }
      // Obstacles
      for (const [ax, ay] of s.obstacles) {
        ctx.save();
        ctx.shadowColor = "#ef4444";
        ctx.shadowBlur = 8;
        ctx.fillStyle = "rgba(239,68,68,0.75)";
        ctx.fillRect(OX + ax * C + C * 0.1, OY + ay * C + C * 0.1, C * 0.8, C * 0.8);
        ctx.restore();
      }
      // Paths
      for (const d of s.drones) {
        if (!d.path || d.path.length < 2) continue;
        const col = STATUS_COLOR[d.status] || "#00f5ff";
        ctx.save();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.22; ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        const [sx, sy] = toPx(d.x, d.y);
        ctx.moveTo(sx, sy);
        for (const [px, py] of d.path) { const [ppx, ppy] = toPx(px, py); ctx.lineTo(ppx, ppy); }
        ctx.stroke();
        ctx.restore();
      }
      // Hubs
      const t = ts / 1000;
      for (let i = 0; i < s.hubs.length; i++) {
        const [hx, hy] = s.hubs[i];
        const [px, py] = toPx(hx, hy);
        const pulse = 0.7 + 0.3 * Math.sin(t * 2 + i * 0.8);
        const sz = C * 0.38 * pulse;
        ctx.save();
        ctx.shadowColor = "#f59e0b"; ctx.shadowBlur = 14 * pulse;
        ctx.translate(px, py); ctx.rotate(t * 0.5 + i);
        ctx.fillStyle = `rgba(245,158,11,${0.85 * pulse})`;
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }
      // Drones
      for (const drone of s.drones) {
        const col = STATUS_COLOR[drone.status] || "#00f5ff";
        const [tx, ty] = toPx(drone.x, drone.y);
        const prev = droneAnimRef.current.get(drone.id);
        let ax = tx, ay = ty;
        if (prev) {
          const ls = 1 - Math.pow(0.01, dt * 8);
          ax = prev.x + (tx - prev.x) * ls;
          ay = prev.y + (ty - prev.y) * ls;
        }
        droneAnimRef.current.set(drone.id, { x: ax, y: ay });
        const r = C * 0.22;
        const bob = Math.sin(t * 3 + parseInt(drone.id.split("-")[1] || "0") * 1.2) * C * 0.06;
        // glow
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 5;
        ctx.fillStyle = col; ctx.globalAlpha = 0.14;
        ctx.beginPath(); ctx.arc(ax, ay + bob, r * 2.2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        // core
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 3;
        ctx.fillStyle = col; ctx.globalAlpha = drone.status === "dead" ? 0.2 : 0.95;
        ctx.beginPath(); ctx.arc(ax, ay + bob, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(ax - r * 0.28, ay + bob - r * 0.28, r * 0.35, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // label
        ctx.save(); ctx.font = `bold ${C * 0.26}px monospace`; ctx.textAlign = "center";
        ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.shadowColor = col; ctx.shadowBlur = 4;
        ctx.fillText(drone.id.replace("Drone-", "D"), ax, ay + bob + r + C * 0.24); ctx.restore();
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
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const C = Math.min(canvas.width, canvas.height) / (GRID + 2);
    const OX = (canvas.width - C * GRID) / 2;
    const OY = (canvas.height - C * GRID) / 2;
    const gx = Math.floor(((e.clientX - rect.left) * scaleX - OX) / C);
    const gy = Math.floor(((e.clientY - rect.top) * scaleY - OY) / C);
    if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) onCellClick(gx, gy);
  }, [onCellClick]);

  return <canvas ref={canvasRef} className="w-full h-full cursor-crosshair" onClick={handleClick} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function BatteryBar({ pct }: { pct: number }) {
  const color = pct > 60 ? "#00f5ff" : pct > 30 ? "#f59e0b" : "#ef4444";
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
      <div style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.5s" }} className="h-full rounded-full" />
    </div>
  );
}

function StatCard({ label, value, unit, accent }: { label: string; value: string | number; unit?: string; accent?: string }) {
  return (
    <div className="bg-gray-900/80 border border-cyan-900/40 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">{label}</div>
      <div className="text-xl font-mono font-bold" style={{ color: accent || "#00f5ff" }}>
        {value}<span className="text-xs text-gray-500 ml-1">{unit}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<SimState | null>(null);
  const [connected, setConnected] = useState(false);
  const [chaosLoading, setChaosLoading] = useState(false);
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [webglFailed, setWebglFailed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => { try { setState(JSON.parse(e.data)); } catch (_) {} };
    }
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state?.log?.length]);

  const handleCellClick = useCallback((x: number, y: number) => {
    wsRef.current?.send(JSON.stringify({ type: "obstacle", x, y }));
  }, []);

  const injectChaos = async (type: string, intensity = 0.6) => {
    setChaosLoading(true);
    try {
      await fetch(`${API}/chaos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, intensity }) });
    } finally { setTimeout(() => setChaosLoading(false), 500); }
  };

  const stats = state?.stats;

  const handleToggle3D = () => {
    if (webglFailed) return;
    setMode(m => m === "2d" ? "3d" : "2d");
  };

  return (
    <div className="h-screen w-screen bg-[#05070d] text-white overflow-hidden flex flex-col font-mono select-none">
      {/* ── HUD Bar ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-cyan-900/30 bg-black/70 backdrop-blur z-10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <motion.div animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1.5, repeat: Infinity }} className="w-2 h-2 rounded-full bg-cyan-400" />
          <span className="text-cyan-400 font-bold tracking-[0.2em] text-sm">AETHERFLOW</span>
          <span className="text-gray-600 text-xs hidden sm:block">AUTONOMOUS LOGISTICS DIGITAL TWIN</span>
        </div>
        <div className="flex items-center gap-3">
          {/* 2D / 3D Toggle */}
          <div className="flex items-center gap-1 bg-gray-900/80 border border-cyan-900/40 rounded-md p-0.5">
            <button
              onClick={() => setMode("2d")}
              className={`text-[10px] px-2.5 py-1 rounded font-bold tracking-widest transition-all ${mode === "2d" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40" : "text-gray-600 hover:text-gray-400"}`}
            >
              2D
            </button>
            <button
              onClick={handleToggle3D}
              disabled={webglFailed}
              title={webglFailed ? "WebGL not available in this environment" : "Switch to 3D view"}
              className={`text-[10px] px-2.5 py-1 rounded font-bold tracking-widest transition-all ${
                mode === "3d" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40"
                : webglFailed ? "text-gray-700 cursor-not-allowed"
                : "text-gray-600 hover:text-gray-400"
              }`}
            >
              3D {webglFailed ? "(unavailable)" : ""}
            </button>
          </div>
          <span className="text-[10px] text-gray-600 hidden md:block">CLICK GRID TO DROP OBSTACLES</span>
          <div className="flex items-center gap-2">
            <motion.div animate={connected ? { opacity: [1, 0.5, 1] } : { opacity: 1 }} transition={{ duration: 1, repeat: Infinity }} className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-500"}`} />
            <span className={`text-xs font-mono ${connected ? "text-green-400" : "text-red-400"}`}>{connected ? "SWARM ONLINE" : "RECONNECTING..."}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* ── Simulation View ───────────────────────────────────────────────── */}
        <div className="flex-1 relative min-w-0 overflow-hidden">
          <AnimatePresence mode="wait">
            {mode === "3d" ? (
              <motion.div key="3d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full h-full">
                <WebGLErrorBoundary onError={() => { setWebglFailed(true); setMode("2d"); }}>
                  <Canvas
                    camera={{ position: [12, 14, 12], fov: 50, near: 0.1, far: 200 }}
                    gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, failIfMajorPerformanceCaveat: false }}
                    onCreated={({ gl }) => {
                      if (!gl.getContext()) { setWebglFailed(true); setMode("2d"); }
                    }}
                  >
                    <Scene3D state={state} onCellClick={handleCellClick} />
                  </Canvas>
                </WebGLErrorBoundary>
              </motion.div>
            ) : (
              <motion.div key="2d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full h-full">
                <SimCanvas2D state={state} onCellClick={handleCellClick} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="absolute bottom-3 left-3 text-[10px] text-gray-700 pointer-events-none">
            <span className="bg-black/40 px-2 py-1 rounded">
              {state ? `${state.drones.length} DRONES · ${state.obstacles.length} OBSTACLES · ${state.no_fly_zones.length} NFZ` : "INITIALIZING..."}
            </span>
          </div>
          {mode === "3d" && (
            <div className="absolute top-3 right-3 text-[10px] text-gray-600 pointer-events-none">
              <span className="bg-black/40 px-2 py-1 rounded">DRAG to orbit · SCROLL to zoom</span>
            </div>
          )}
        </div>

        {/* ── Right Panel ───────────────────────────────────────────────────── */}
        <div className="w-64 flex flex-col bg-black/80 border-l border-cyan-900/30 overflow-hidden flex-shrink-0">
          {/* Fleet Stats */}
          <div className="p-3 border-b border-cyan-900/20 flex-shrink-0">
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">Fleet Stats</div>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Efficiency" value={stats ? `${stats.fleet_efficiency}` : "--"} unit="%" />
              <StatCard label="Avg Battery" value={stats ? `${stats.avg_battery}` : "--"} unit="%" accent="#22d3ee" />
              <StatCard label="Active" value={stats ? `${stats.active_drones}/${stats.total_drones}` : "--"} accent="#00f5ff" />
              <StatCard label="Avoided" value={stats?.collisions_avoided ?? "--"} accent="#f59e0b" />
            </div>
          </div>

          {/* Drone Fleet */}
          <div className="flex-1 overflow-y-auto p-3 border-b border-cyan-900/20 min-h-0">
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">Drone Fleet</div>
            <div className="space-y-1.5">
              <AnimatePresence initial={false}>
                {(state?.drones ?? Array(8).fill(null)).map((d, i) => (
                  <motion.div key={d?.id ?? i} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-gray-900/60 rounded p-2 border border-gray-800/40">
                    {d ? (
                      <>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold" style={{ color: STATUS_COLOR[d.status] || "#9ca3af" }}>{d.id}</span>
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ color: STATUS_COLOR[d.status] || "#9ca3af", backgroundColor: (STATUS_COLOR[d.status] || "#9ca3af") + "22" }}>{d.status}</span>
                        </div>
                        <BatteryBar pct={d.battery} />
                        <div className="text-[9px] text-gray-600 mt-0.5">{d.battery.toFixed(1)}%</div>
                      </>
                    ) : (
                      <div className="h-8 bg-gray-800/40 rounded animate-pulse" />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>

          {/* Chaos Engine */}
          <div className="p-3 border-b border-cyan-900/20 flex-shrink-0">
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">Chaos Engine</div>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { label: "Weather", type: "weather", cls: "bg-purple-950/70 border-purple-700/40 text-purple-300 hover:bg-purple-900/70" },
                { label: "No-Fly Zone", type: "nofly", cls: "bg-red-950/60 border-red-800/40 text-red-300 hover:bg-red-900/60" },
                { label: "Clear Events", type: "clear", cls: "bg-gray-800/60 border-gray-700/30 text-gray-400 hover:bg-gray-700/60" },
              ].map(({ label, type, cls }) => (
                <button key={type} onClick={() => injectChaos(type)} disabled={chaosLoading} className={`text-[10px] py-1.5 px-2 rounded border transition-all disabled:opacity-40 ${cls}`}>{label}</button>
              ))}
              <button onClick={() => fetch(`${API}/obstacles`, { method: "DELETE" })} className="text-[10px] py-1.5 px-2 rounded bg-gray-800/60 border border-gray-700/30 text-gray-400 hover:bg-gray-700/60 transition-all">Clear Obstacles</button>
            </div>
          </div>

          {/* Live Log */}
          <div className="flex flex-col p-3 min-h-0" style={{ height: "180px" }}>
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-1.5 font-bold flex-shrink-0">Live Decision Log</div>
            <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
              {(state?.log ?? []).map((entry, i) => {
                const isChaos = entry.includes("[CHAOS]");
                const isGC = entry.includes("[GC]");
                const isError = entry.includes("BLOCKED");
                const isDone = entry.includes("Delivered");
                const color = isChaos ? "text-purple-400" : isGC ? "text-amber-400" : isError ? "text-red-400" : isDone ? "text-green-400" : "text-cyan-300/60";
                return <div key={i} className={`text-[9px] leading-snug font-mono ${color}`}>{entry}</div>;
              })}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Legend ──────────────────────────────────────────────────────────── */}
      <div className="px-4 py-1.5 border-t border-cyan-900/20 bg-black/70 flex items-center gap-4 text-[9px] text-gray-600 flex-shrink-0 flex-wrap">
        {[
          { color: "#00f5ff", label: "Delivering" },
          { color: "#f59e0b", label: "Re-routing" },
          { color: "#22d3ee", label: "Charging" },
          { color: "#ef4444", label: "Blocked" },
          { color: "#f59e0b", label: "Hub" },
          { color: "#7c3aed", label: "Weather Zone" },
          { color: "#dc2626", label: "No-Fly Zone" },
          { color: "#ef4444", label: "Obstacle (click)" },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
