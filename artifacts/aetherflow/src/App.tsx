import { useEffect, useRef, useState, useCallback } from "react";
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

// ── 2D Canvas Renderer ────────────────────────────────────────────────────────
function SimCanvas({
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

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      canvas!.width = parent.clientWidth;
      canvas!.height = parent.clientHeight;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    function cellSize() {
      return Math.min(canvas!.width, canvas!.height) / (GRID + 2);
    }
    function offsetX() {
      return (canvas!.width - cellSize() * GRID) / 2;
    }
    function offsetY() {
      return (canvas!.height - cellSize() * GRID) / 2;
    }
    function toPixel(gx: number, gy: number): [number, number] {
      const cs = cellSize();
      return [offsetX() + gx * cs + cs / 2, offsetY() + gy * cs + cs / 2];
    }

    function drawGlow(
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      r: number,
      color: string,
      alpha = 0.4
    ) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      grad.addColorStop(0, color.replace(")", `, ${alpha})`).replace("rgb", "rgba").replace("#", "rgba(") + "");
      grad.addColorStop(1, "transparent");
      // Use simpler approach
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = r * 4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function hexToRgb(hex: string) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `${r},${g},${b}`;
    }

    function draw(ts: number) {
      const dt = Math.min((ts - timeRef.current) / 1000, 0.1);
      timeRef.current = ts;
      const s = stateRef.current;
      const cs = cellSize();
      const ox = offsetX();
      const oy = offsetY();
      const W = canvas!.width;
      const H = canvas!.height;

      // Background
      ctx.fillStyle = "#05070d";
      ctx.fillRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = "#0f1f2f";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= GRID; i++) {
        ctx.beginPath();
        ctx.moveTo(ox + i * cs, oy);
        ctx.lineTo(ox + i * cs, oy + GRID * cs);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ox, oy + i * cs);
        ctx.lineTo(ox + GRID * cs, oy + i * cs);
        ctx.stroke();
      }

      // Grid border
      ctx.strokeStyle = "#1a2a3a";
      ctx.lineWidth = 1;
      ctx.strokeRect(ox, oy, GRID * cs, GRID * cs);

      if (!s) {
        // Loading state
        ctx.fillStyle = "#00f5ff44";
        ctx.font = `${cs * 0.8}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText("Connecting to swarm...", W / 2, H / 2);
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Weather cells
      for (const [wx, wy] of s.weather_cells) {
        const [px, py] = toPixel(wx - 0.5, wy - 0.5);
        ctx.fillStyle = "rgba(124,58,237,0.18)";
        ctx.fillRect(ox + wx * cs, oy + wy * cs, cs, cs);
      }

      // No-fly zones
      for (const [zx, zy] of s.no_fly_zones) {
        ctx.fillStyle = "rgba(220,38,38,0.2)";
        ctx.fillRect(ox + zx * cs, oy + zy * cs, cs, cs);
        ctx.strokeStyle = "rgba(220,38,38,0.5)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(ox + zx * cs + 1, oy + zy * cs + 1, cs - 2, cs - 2);
      }

      // Obstacles
      for (const [ax, ay] of s.obstacles) {
        const px = ox + ax * cs + cs * 0.1;
        const py = oy + ay * cs + cs * 0.1;
        const sz = cs * 0.8;
        ctx.save();
        ctx.shadowColor = "#ef4444";
        ctx.shadowBlur = 8;
        ctx.fillStyle = "rgba(239,68,68,0.7)";
        ctx.fillRect(px, py, sz, sz);
        ctx.restore();
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, sz, sz);
      }

      // Drone paths
      for (const drone of s.drones) {
        if (!drone.path || drone.path.length < 2) continue;
        const color = STATUS_COLOR[drone.status] || "#00f5ff";
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        const [startX, startY] = toPixel(drone.x, drone.y);
        ctx.moveTo(startX, startY);
        for (const [px, py] of drone.path) {
          const [ppx, ppy] = toPixel(px, py);
          ctx.lineTo(ppx, ppy);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Hubs
      const t = ts / 1000;
      for (let i = 0; i < s.hubs.length; i++) {
        const [hx, hy] = s.hubs[i];
        const [px, py] = toPixel(hx, hy);
        const pulse = 0.7 + 0.3 * Math.sin(t * 2 + i * 0.8);
        const sz = cs * 0.4 * pulse;

        ctx.save();
        ctx.shadowColor = "#f59e0b";
        ctx.shadowBlur = 12 * pulse;
        ctx.fillStyle = `rgba(245,158,11,${0.8 * pulse})`;
        ctx.translate(px, py);
        ctx.rotate(t * 0.5 + i);
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1;
        ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }

      // Drones — lerp positions
      for (const drone of s.drones) {
        const color = STATUS_COLOR[drone.status] || "#00f5ff";
        const [tx, ty] = toPixel(drone.x, drone.y);

        // Smooth interpolation
        const prev = droneAnimRef.current.get(drone.id);
        let ax = tx, ay = ty;
        if (prev) {
          const lerpSpeed = 1 - Math.pow(0.01, dt * 8);
          ax = prev.x + (tx - prev.x) * lerpSpeed;
          ay = prev.y + (ty - prev.y) * lerpSpeed;
        }
        droneAnimRef.current.set(drone.id, { x: ax, y: ay });

        const r = cs * 0.22;
        const bob = Math.sin(t * 3 + parseInt(drone.id.split("-")[1] || "0") * 1.2) * cs * 0.06;

        if (drone.status === "dead") {
          ctx.globalAlpha = 0.3;
        }

        // Outer glow
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = r * 5;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.15;
        ctx.beginPath();
        ctx.arc(ax, ay + bob, r * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Core
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = r * 3;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(ax, ay + bob, r, 0, Math.PI * 2);
        ctx.fill();
        // Bright center highlight
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(ax - r * 0.25, ay + bob - r * 0.25, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Label
        ctx.save();
        ctx.font = `bold ${cs * 0.28}px monospace`;
        ctx.textAlign = "center";
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.fillText(drone.id.replace("Drone-", "D"), ax, ay + bob + r + cs * 0.25);
        ctx.restore();
      }

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
    };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cs = Math.min(canvas.width, canvas.height) / (GRID + 2);
      const ox = (canvas.width - cs * GRID) / 2;
      const oy = (canvas.height - cs * GRID) / 2;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Scale for devicePixelRatio
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const gx = Math.floor((cx * scaleX - ox) / cs);
      const gy = Math.floor((cy * scaleY - oy) / cs);
      if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) {
        onCellClick(gx, gy);
      }
    },
    [onCellClick]
  );

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-crosshair"
      onClick={handleClick}
    />
  );
}

// ── Battery Bar ───────────────────────────────────────────────────────────────
function BatteryBar({ pct }: { pct: number }) {
  const color = pct > 60 ? "#00f5ff" : pct > 30 ? "#f59e0b" : "#ef4444";
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
      <div
        style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.5s" }}
        className="h-full rounded-full"
      />
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent?: string;
}) {
  return (
    <div className="bg-gray-900/80 border border-cyan-900/40 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">{label}</div>
      <div className="text-xl font-mono font-bold" style={{ color: accent || "#00f5ff" }}>
        {value}
        <span className="text-xs text-gray-500 ml-1">{unit}</span>
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
          setState(JSON.parse(e.data) as SimState);
        } catch (_) {}
      };
    }
    connect();
    return () => {
      clearTimeout(retryTimeout);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.log?.length]);

  const handleCellClick = useCallback(
    (x: number, y: number) => {
      wsRef.current?.send(JSON.stringify({ type: "obstacle", x, y }));
    },
    []
  );

  const injectChaos = async (type: string, intensity = 0.6) => {
    setChaosLoading(true);
    try {
      await fetch(`${API}/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, intensity }),
      });
    } finally {
      setTimeout(() => setChaosLoading(false), 500);
    }
  };

  const clearObstacles = () => fetch(`${API}/obstacles`, { method: "DELETE" });
  const stats = state?.stats;

  return (
    <div className="h-screen w-screen bg-[#05070d] text-white overflow-hidden flex flex-col font-mono select-none">
      {/* ── Top HUD ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-cyan-900/30 bg-black/70 backdrop-blur z-10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <motion.div
            animate={{ opacity: [1, 0.4, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-2 h-2 rounded-full bg-cyan-400"
          />
          <span className="text-cyan-400 font-bold tracking-[0.2em] text-sm">AETHERFLOW</span>
          <span className="text-gray-600 text-xs hidden sm:block">AUTONOMOUS LOGISTICS DIGITAL TWIN</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-gray-600 hidden md:block">CLICK GRID TO DROP OBSTACLES</span>
          <div className="flex items-center gap-2">
            <motion.div
              animate={connected ? { opacity: [1, 0.5, 1] } : { opacity: 1 }}
              transition={{ duration: 1, repeat: Infinity }}
              className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-500"}`}
            />
            <span className={`text-xs font-mono ${connected ? "text-green-400" : "text-red-400"}`}>
              {connected ? "SWARM ONLINE" : "RECONNECTING..."}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* ── Simulation Canvas ─────────────────────────────────────────────── */}
        <div className="flex-1 relative min-w-0 overflow-hidden">
          <SimCanvas state={state} onCellClick={handleCellClick} />

          {/* Coordinate guide overlay */}
          <div className="absolute bottom-3 left-3 text-[10px] text-gray-700 pointer-events-none">
            <span className="bg-black/40 px-2 py-1 rounded">
              {state
                ? `${state.drones.length} DRONES · ${state.obstacles.length} OBSTACLES · ${state.no_fly_zones.length} NFZ`
                : "INITIALIZING..."}
            </span>
          </div>
        </div>

        {/* ── Right Panel ───────────────────────────────────────────────────── */}
        <div className="w-64 flex flex-col bg-black/80 border-l border-cyan-900/30 overflow-hidden flex-shrink-0">
          {/* Fleet Stats */}
          <div className="p-3 border-b border-cyan-900/20 flex-shrink-0">
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">Fleet Stats</div>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Efficiency" value={stats ? `${stats.fleet_efficiency}` : "--"} unit="%" />
              <StatCard
                label="Avg Battery"
                value={stats ? `${stats.avg_battery}` : "--"}
                unit="%"
                accent="#22d3ee"
              />
              <StatCard
                label="Active"
                value={stats ? `${stats.active_drones}/${stats.total_drones}` : "--"}
                accent="#00f5ff"
              />
              <StatCard
                label="Avoided"
                value={stats?.collisions_avoided ?? "--"}
                accent="#f59e0b"
              />
            </div>
          </div>

          {/* Drone Fleet */}
          <div className="flex-1 overflow-y-auto p-3 border-b border-cyan-900/20 min-h-0">
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">Drone Fleet</div>
            <div className="space-y-1.5">
              <AnimatePresence initial={false}>
                {(state?.drones ?? Array(8).fill(null)).map((d, i) => (
                  <motion.div
                    key={d?.id ?? i}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="bg-gray-900/60 rounded p-2 border border-gray-800/40"
                  >
                    {d ? (
                      <>
                        <div className="flex items-center justify-between mb-1">
                          <span
                            className="text-xs font-bold"
                            style={{ color: STATUS_COLOR[d.status] || "#9ca3af" }}
                          >
                            {d.id}
                          </span>
                          <span
                            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{
                              color: STATUS_COLOR[d.status] || "#9ca3af",
                              backgroundColor: (STATUS_COLOR[d.status] || "#9ca3af") + "22",
                            }}
                          >
                            {d.status}
                          </span>
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
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-2 font-bold">
              Chaos Engine
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { label: "Weather", type: "weather", cls: "bg-purple-950/70 border-purple-700/40 text-purple-300 hover:bg-purple-900/70" },
                { label: "No-Fly Zone", type: "nofly", cls: "bg-red-950/60 border-red-800/40 text-red-300 hover:bg-red-900/60" },
                { label: "Clear Events", type: "clear", cls: "bg-gray-800/60 border-gray-700/30 text-gray-400 hover:bg-gray-700/60" },
              ].map(({ label, type, cls }) => (
                <button
                  key={type}
                  onClick={() => injectChaos(type)}
                  disabled={chaosLoading}
                  className={`text-[10px] py-1.5 px-2 rounded border transition-all disabled:opacity-40 ${cls}`}
                >
                  {label}
                </button>
              ))}
              <button
                onClick={clearObstacles}
                className="text-[10px] py-1.5 px-2 rounded bg-gray-800/60 border border-gray-700/30 text-gray-400 hover:bg-gray-700/60 transition-all"
              >
                Clear Obstacles
              </button>
            </div>
          </div>

          {/* Live Log */}
          <div className="flex flex-col p-3 min-h-0" style={{ height: "180px" }}>
            <div className="text-[10px] text-cyan-900 uppercase tracking-widest mb-1.5 font-bold flex-shrink-0">
              Live Decision Log
            </div>
            <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
              {(state?.log ?? []).map((entry, i) => {
                const isChaos = entry.includes("[CHAOS]");
                const isGC = entry.includes("[GC]");
                const isError = entry.includes("BLOCKED");
                const isDeliver = entry.includes("Delivered");
                const color = isChaos
                  ? "text-purple-400"
                  : isGC
                  ? "text-amber-400"
                  : isError
                  ? "text-red-400"
                  : isDeliver
                  ? "text-green-400"
                  : "text-cyan-300/60";
                return (
                  <div key={i} className={`text-[9px] leading-snug font-mono ${color}`}>
                    {entry}
                  </div>
                );
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
          { color: "#f59e0b", label: "Hub (amber cube)" },
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
