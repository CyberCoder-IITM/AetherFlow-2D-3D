import { useEffect, useRef, useState, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, Sphere, Box } from "@react-three/drei";
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

// ── Color helpers ─────────────────────────────────────────────────────────────
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

function toWorld(gx: number, gy: number): [number, number, number] {
  return [gx * CELL - (GRID / 2) + 0.5, 0.5, gy * CELL - (GRID / 2) + 0.5];
}

// ── Grid Floor ────────────────────────────────────────────────────────────────
function GridFloor() {
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

// ── Hub ───────────────────────────────────────────────────────────────────────
function Hub({ pos }: { pos: [number, number] }) {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (meshRef.current) meshRef.current.rotation.y += delta * 0.8;
  });
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <group position={[wx, 0, wz]}>
      <mesh ref={meshRef}>
        <boxGeometry args={[0.6, 0.6, 0.6]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.6} />
      </mesh>
      <pointLight color="#f59e0b" intensity={2} distance={3} />
    </group>
  );
}

// ── Obstacle ──────────────────────────────────────────────────────────────────
function ObstacleMesh({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh position={[wx, 0.5, wz]}>
      <boxGeometry args={[0.85, 1, 0.85]} />
      <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} transparent opacity={0.85} />
    </mesh>
  );
}

// ── No-Fly Zone ───────────────────────────────────────────────────────────────
function NoFlyZone({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh position={[wx, 0.3, wz]}>
      <cylinderGeometry args={[0.45, 0.45, 0.6, 8]} />
      <meshStandardMaterial color="#dc2626" transparent opacity={0.35} emissive="#dc2626" emissiveIntensity={0.2} />
    </mesh>
  );
}

// ── Weather Cell ──────────────────────────────────────────────────────────────
function WeatherCell({ pos }: { pos: [number, number] }) {
  const [wx, , wz] = toWorld(pos[0], pos[1]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx, 0.02, wz]}>
      <planeGeometry args={[0.95, 0.95]} />
      <meshStandardMaterial color="#7c3aed" transparent opacity={0.25} />
    </mesh>
  );
}

// ── Drone path trail ──────────────────────────────────────────────────────────
function DroneTrail({ drone }: { drone: DroneData }) {
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
      lineWidth={1}
      transparent
      opacity={0.3}
    />
  );
}

// ── Drone Mesh ────────────────────────────────────────────────────────────────
function DroneMesh({ drone }: { drone: DroneData }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.PointLight>(null);
  const posRef = useRef(new THREE.Vector3(...toWorld(drone.x, drone.y)));

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const target = new THREE.Vector3(...toWorld(drone.x, drone.y));
    posRef.current.lerp(target, Math.min(1, delta * 15));
    meshRef.current.position.copy(posRef.current);
    meshRef.current.position.y = 0.5 + Math.sin(Date.now() * 0.003 + parseFloat(drone.id.split("-")[1]) * 1.2) * 0.12;
    meshRef.current.rotation.y += delta * 2;
    if (glowRef.current) {
      glowRef.current.position.copy(meshRef.current.position);
      glowRef.current.intensity = 1.5 + Math.sin(Date.now() * 0.005) * 0.5;
    }
  });

  const color = STATUS_COLOR[drone.status] || "#00f5ff";
  const batteryLow = drone.battery < 30;

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.28, 12, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={batteryLow ? 0.2 : 0.8}
          metalness={0.4}
          roughness={0.2}
        />
      </mesh>
      <pointLight ref={glowRef} color={color} intensity={1.5} distance={2.5} />
    </group>
  );
}

// ── Click Plane (obstacle placement) ─────────────────────────────────────────
function ClickPlane({ onCellClick }: { onCellClick: (x: number, y: number) => void }) {
  const { camera, gl } = useThree();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  const handleClick = useCallback(
    (event: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const target = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, target);
      if (target) {
        const gx = Math.floor(target.x + GRID / 2);
        const gy = Math.floor(target.z + GRID / 2);
        if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) {
          onCellClick(gx, gy);
        }
      }
    },
    [camera, gl, onCellClick]
  );

  useEffect(() => {
    gl.domElement.addEventListener("click", handleClick);
    return () => gl.domElement.removeEventListener("click", handleClick);
  }, [handleClick, gl]);

  return null;
}

// ── Main Scene ────────────────────────────────────────────────────────────────
function Scene({ state, onCellClick }: { state: SimState | null; onCellClick: (x: number, y: number) => void }) {
  if (!state) return null;
  return (
    <>
      <ambientLight intensity={0.15} color="#0a1a2a" />
      <directionalLight position={[10, 20, 10]} intensity={0.4} color="#ffffff" />
      <GridFloor />
      {state.hubs.map((h, i) => <Hub key={i} pos={h} />)}
      {state.weather_cells.map((w, i) => <WeatherCell key={i} pos={w} />)}
      {state.obstacles.map((o, i) => <ObstacleMesh key={i} pos={o} />)}
      {state.no_fly_zones.map((z, i) => <NoFlyZone key={i} pos={z} />)}
      {state.drones.map(d => <DroneTrail key={d.id + "-trail"} drone={d} />)}
      {state.drones.map(d => <DroneMesh key={d.id} drone={d} />)}
      <ClickPlane onCellClick={onCellClick} />
      <OrbitControls enablePan enableZoom enableRotate makeDefault minDistance={5} maxDistance={40} />
    </>
  );
}

// ── Battery Bar ───────────────────────────────────────────────────────────────
function BatteryBar({ pct }: { pct: number }) {
  const color = pct > 60 ? "#00f5ff" : pct > 30 ? "#f59e0b" : "#ef4444";
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
      <div style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.3s" }} className="h-full rounded-full" />
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, unit, accent }: { label: string; value: string | number; unit?: string; accent?: string }) {
  return (
    <div className="bg-gray-900/80 border border-cyan-900/40 rounded-lg p-3">
      <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">{label}</div>
      <div className="text-xl font-mono font-bold" style={{ color: accent || "#00f5ff" }}>
        {value}<span className="text-xs text-gray-500 ml-1">{unit}</span>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<SimState | null>(null);
  const [connected, setConnected] = useState(false);
  const [chaosLoading, setChaosLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ws: WebSocket;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        retryTimeout = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const data: SimState = JSON.parse(e.data);
          setState(data);
        } catch (_) {}
      };
    }
    connect();
    return () => {
      clearTimeout(retryTimeout);
      ws.close();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.log]);

  const handleCellClick = useCallback((x: number, y: number) => {
    wsRef.current?.send(JSON.stringify({ type: "obstacle", x, y }));
  }, []);

  const injectChaos = async (type: string, intensity = 0.6) => {
    setChaosLoading(true);
    try {
      await fetch(`${API}/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, intensity }),
      });
    } finally {
      setChaosLoading(false);
    }
  };

  const clearObstacles = () => fetch(`${API}/obstacles`, { method: "DELETE" });

  const stats = state?.stats;

  return (
    <div className="h-screen w-screen bg-[#05070d] text-white overflow-hidden flex flex-col font-mono select-none">
      {/* ── Top HUD bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-cyan-900/30 bg-black/60 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-cyan-400 font-bold tracking-widest text-sm">AETHERFLOW</span>
          <span className="text-gray-600 text-xs">AUTONOMOUS LOGISTICS DIGITAL TWIN</span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
          <span className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
            {connected ? "SWARM CONNECTED" : "RECONNECTING..."}
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── 3D Canvas ─────────────────────────────────────────────────────── */}
        <div className="flex-1 relative">
          <Canvas
            camera={{ position: [12, 14, 12], fov: 50, near: 0.1, far: 200 }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
            shadows
          >
            <fog attach="fog" args={["#05070d", 20, 60]} />
            <Scene state={state} onCellClick={handleCellClick} />
          </Canvas>

          {/* Click hint */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-gray-600 bg-black/40 px-3 py-1 rounded-full pointer-events-none">
            Click map to place / remove obstacles
          </div>
        </div>

        {/* ── Right Panel ───────────────────────────────────────────────────── */}
        <div className="w-72 flex flex-col bg-black/70 border-l border-cyan-900/30 overflow-hidden">
          {/* Stats */}
          <div className="p-3 border-b border-cyan-900/20">
            <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Fleet Status</div>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Efficiency" value={stats ? `${stats.fleet_efficiency}` : "--"} unit="%" />
              <StatCard label="Avg Battery" value={stats ? `${stats.avg_battery}` : "--"} unit="%" accent="#22d3ee" />
              <StatCard label="Active" value={stats ? `${stats.active_drones}/${stats.total_drones}` : "--"} accent="#00f5ff" />
              <StatCard label="Avoided" value={stats?.collisions_avoided ?? "--"} accent="#f59e0b" />
            </div>
          </div>

          {/* Drone list */}
          <div className="flex-1 overflow-y-auto p-3 border-b border-cyan-900/20">
            <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Drone Fleet</div>
            <div className="space-y-2">
              {(state?.drones ?? []).map(d => (
                <motion.div
                  key={d.id}
                  layout
                  className="bg-gray-900/60 rounded-md p-2 border border-gray-800/50"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold" style={{ color: STATUS_COLOR[d.status] || "#9ca3af" }}>
                      {d.id}
                    </span>
                    <span className="text-[10px] text-gray-500 uppercase">{d.status}</span>
                  </div>
                  <BatteryBar pct={d.battery} />
                  <div className="text-[10px] text-gray-600 mt-1">{d.battery.toFixed(1)}% battery</div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Chaos Engine */}
          <div className="p-3 border-b border-cyan-900/20">
            <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Chaos Engine</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => injectChaos("weather")}
                disabled={chaosLoading}
                className="text-[11px] py-1.5 px-2 rounded bg-purple-900/60 border border-purple-700/50 text-purple-300 hover:bg-purple-800/60 transition disabled:opacity-50"
              >
                Weather Event
              </button>
              <button
                onClick={() => injectChaos("nofly")}
                disabled={chaosLoading}
                className="text-[11px] py-1.5 px-2 rounded bg-red-900/50 border border-red-700/40 text-red-300 hover:bg-red-800/50 transition disabled:opacity-50"
              >
                No-Fly Zone
              </button>
              <button
                onClick={() => injectChaos("clear")}
                disabled={chaosLoading}
                className="text-[11px] py-1.5 px-2 rounded bg-gray-800/60 border border-gray-700/40 text-gray-300 hover:bg-gray-700/60 transition disabled:opacity-50"
              >
                Clear Events
              </button>
              <button
                onClick={clearObstacles}
                className="text-[11px] py-1.5 px-2 rounded bg-gray-800/60 border border-gray-700/40 text-gray-300 hover:bg-gray-700/60 transition"
              >
                Clear Obstacles
              </button>
            </div>
          </div>

          {/* Live Log */}
          <div className="flex flex-col h-48 p-3">
            <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Live Decision Log</div>
            <div className="flex-1 overflow-y-auto space-y-0.5 text-[10px] leading-relaxed">
              <AnimatePresence initial={false}>
                {(state?.log ?? []).slice(-40).map((entry, i) => {
                  const isChaos = entry.includes("[CHAOS]");
                  const isGC = entry.includes("[GC]");
                  const isError = entry.includes("BLOCKED");
                  const color = isChaos ? "text-purple-400" : isGC ? "text-amber-400" : isError ? "text-red-400" : "text-cyan-300/70";
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={`${color} font-mono`}
                    >
                      {entry}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-1.5 border-t border-cyan-900/20 bg-black/60 flex items-center gap-5 text-[10px] text-gray-500">
        {[
          { color: "#00f5ff", label: "Delivering" },
          { color: "#f59e0b", label: "Re-routing" },
          { color: "#22d3ee", label: "Charging" },
          { color: "#ef4444", label: "Blocked" },
          { color: "#f59e0b", label: "Hub" },
          { color: "#7c3aed", label: "Weather Zone" },
          { color: "#dc2626", label: "No-Fly Zone" },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
