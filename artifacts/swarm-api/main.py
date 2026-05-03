import asyncio
import heapq
import json
import math
import os
import random
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


@asynccontextmanager
async def lifespan(app_):
    asyncio.create_task(simulation_loop())
    yield


app = FastAPI(title="AetherFlow Swarm Controller", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GRID_W = 20
GRID_H = 20
MAX_DRONES = 16
MIN_DRONES = 2

HUBS = [
    (1, 1), (1, 18), (18, 1), (18, 18),
    (9, 1), (1, 9), (18, 9), (9, 18),
]

# ── Simulation State ──────────────────────────────────────────────────────────
obstacles: set[tuple[int, int]] = set()
no_fly_zones: set[tuple[int, int]] = set()
weather_cells: set[tuple[int, int]] = set()
event_log: list[str] = []
drones: list[dict] = []
collision_avoided = 0
total_deliveries = 0
state_subscribers: list[WebSocket] = []
paused = False
speed_mult = 1.0
target_fleet_size = 8
sim_start_time = time.time()
tick_count = 0


def log_event(msg: str):
    ts = time.strftime("%H:%M:%S")
    entry = f"[{ts}] {msg}"
    event_log.append(entry)
    if len(event_log) > 300:
        event_log.pop(0)


def blocked(x: int, y: int) -> bool:
    return (x, y) in obstacles or (x, y) in no_fly_zones


def heuristic(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def astar(start, goal, reserved=None):
    if blocked(*goal):
        return []
    reserved = reserved or set()
    open_heap = []
    heapq.heappush(open_heap, (0, start))
    came_from = {start: None}
    g = defaultdict(lambda: float("inf"))
    g[start] = 0

    while open_heap:
        _, current = heapq.heappop(open_heap)
        if current == goal:
            path = []
            while current is not None:
                path.append(current)
                current = came_from[current]
            path.reverse()
            return path
        cx, cy = current
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if not (0 <= nx < GRID_W and 0 <= ny < GRID_H):
                continue
            neighbor = (nx, ny)
            if blocked(*neighbor) and neighbor != goal:
                continue
            if neighbor in reserved:
                continue
            weight = 1.8 if neighbor in weather_cells else 1.0
            tentative_g = g[current] + weight
            if tentative_g < g[neighbor]:
                g[neighbor] = tentative_g
                f = tentative_g + heuristic(neighbor, goal)
                heapq.heappush(open_heap, (f, neighbor))
                came_from[neighbor] = current
    return []


def make_drone(i: int) -> dict:
    hub = HUBS[i % len(HUBS)]
    target_hub = HUBS[(i + 4) % len(HUBS)]
    return {
        "id": f"Drone-{i+1:02d}",
        "x": float(hub[0]),
        "y": float(hub[1]),
        "battery": round(random.uniform(70, 100), 1),
        "status": "idle",
        "path": [],
        "path_index": 0,
        "target": target_hub,
        "collisions_avoided": 0,
        "deliveries": 0,
        "speed": 1.0,
        "priority": False,
        "emp_recovery": 0.0,
    }


def init_drones():
    global drones, collision_avoided, total_deliveries
    drones = [make_drone(i) for i in range(target_fleet_size)]
    collision_avoided = 0
    total_deliveries = 0
    log_event(f"Swarm Controller initialized — {target_fleet_size} drones online")


init_drones()


def replan_drone(drone: dict, reason: str = "obstacle"):
    start = (round(drone["x"]), round(drone["y"]))
    goal = drone["target"]
    reserved = {(round(o["x"]), round(o["y"])) for o in drones if o["id"] != drone["id"]}
    new_path = astar(start, goal, reserved)
    if new_path:
        drone["path"] = new_path
        drone["path_index"] = 0
        drone["status"] = "routing"
        log_event(f"[{drone['id']}] Re-routing: {reason}")
    else:
        drone["status"] = "blocked"
        log_event(f"[{drone['id']}] BLOCKED — no path to {goal}")


async def tick():
    global collision_avoided, total_deliveries, tick_count
    tick_count += 1

    # Adjust fleet size dynamically
    while len(drones) < target_fleet_size:
        new_idx = len(drones)
        d = make_drone(new_idx)
        drones.append(d)
        log_event(f"[FLEET] {d['id']} deployed")
    while len(drones) > target_fleet_size:
        removed = drones.pop()
        log_event(f"[FLEET] {removed['id']} recalled")

    # ── Pre-pass: build collision yield set ─────────────────────────────────
    # Snapshot current grid positions and intended next cells for every drone.
    snap_cell: dict[str, tuple[int, int]] = {
        d["id"]: (round(d["x"]), round(d["y"])) for d in drones
    }
    snap_next: dict[str, tuple[int, int]] = {}
    for d in drones:
        if d["path"] and d["path_index"] < len(d["path"]):
            snap_next[d["id"]] = d["path"][d["path_index"]]

    def drone_num(did: str) -> int:
        return int(did.split("-")[1])

    # yield_set: IDs that must skip movement this tick
    yield_set: set[str] = set()

    # 1. Swap / head-on detection:
    #    Drone A at cell X wants cell Y, Drone B at cell Y wants cell X
    #    → they would ghost through each other.  Higher drone number yields.
    for i, da in enumerate(drones):
        if da["id"] in yield_set:
            continue
        nc_a = snap_next.get(da["id"])
        if nc_a is None:
            continue
        for db in drones[i + 1:]:
            if db["id"] in yield_set:
                continue
            nc_b = snap_next.get(db["id"])
            if nc_b is None:
                continue
            # Swap condition
            if snap_cell[da["id"]] == nc_b and snap_cell[db["id"]] == nc_a:
                loser = db["id"] if drone_num(da["id"]) < drone_num(db["id"]) else da["id"]
                yield_set.add(loser)

    # 2. Physical proximity guard (catches fractional mid-cell phasethrough):
    #    If two drones are already within 0.75 cells of each other, the
    #    higher-numbered one must stop until they separate.
    MIN_SEP_SQ = 0.5625  # 0.75 ** 2
    for i, da in enumerate(drones):
        if da["id"] in yield_set:
            continue
        for db in drones[i + 1:]:
            if db["id"] in yield_set:
                continue
            ddx = da["x"] - db["x"]
            ddy = da["y"] - db["y"]
            if ddx * ddx + ddy * ddy < MIN_SEP_SQ:
                loser = db["id"] if drone_num(da["id"]) < drone_num(db["id"]) else da["id"]
                yield_set.add(loser)

    # ── Pre-populate reserved_next with immovable drones ────────────────────
    reserved_next: dict[tuple[int, int], str] = {
        snap_cell[d["id"]]: d["id"]
        for d in drones
        if d["battery"] <= 0 or d.get("emp_recovery", 0) > 0
    }

    for drone in drones:
        # EMP recovery
        if drone.get("emp_recovery", 0) > 0:
            drone["emp_recovery"] = max(0.0, drone["emp_recovery"] - 0.1)
            drone["status"] = "emp"
            continue

        if drone["battery"] <= 0:
            drone["status"] = "dead"
            continue

        if drone["status"] in ("delivering", "routing", "emp"):
            drain = 0.035 * speed_mult
            if snap_cell[drone["id"]] in weather_cells:
                drain *= 2.2
            drone["battery"] = max(0, round(drone["battery"] - drain, 2))

        if not drone["path"] or drone["path_index"] >= len(drone["path"]):
            start = snap_cell[drone["id"]]
            drone["path"] = astar(start, drone["target"])
            drone["path_index"] = 0
            if drone["path"]:
                drone["status"] = "delivering"
                pri = " [PRIORITY]" if drone["priority"] else ""
                log_event(f"[{drone['id']}]{pri} New route → Hub {drone['target']}")
            else:
                drone["status"] = "idle"
            continue

        pi = drone["path_index"]
        next_cell = drone["path"][pi]

        if blocked(*next_cell):
            drone["collisions_avoided"] += 1
            collision_avoided += 1
            replan_drone(drone, f"Obstacle at {chr(65+next_cell[0])}{next_cell[1]}")
            continue

        # Yield if flagged by pre-pass (swap or proximity)
        if drone["id"] in yield_set:
            drone["collisions_avoided"] += 1
            collision_avoided += 1
            log_event(f"[{drone['id']}] Yielding at {chr(65+snap_cell[drone['id']][0])}{snap_cell[drone['id']][1]}")
            continue

        # Block if another drone already claimed this cell this tick
        occupant = reserved_next.get(next_cell)
        if occupant and occupant != drone["id"]:
            drone["collisions_avoided"] += 1
            collision_avoided += 1
            log_event(f"[{drone['id']}] Yielding at {chr(65+snap_cell[drone['id']][0])}{snap_cell[drone['id']][1]}")
            continue

        # Claim next cell, release current cell
        curr_cell = snap_cell[drone["id"]]
        reserved_next.pop(curr_cell, None)
        reserved_next[next_cell] = drone["id"]

        tx, ty = next_cell
        cx, cy = drone["x"], drone["y"]
        base_speed = 0.12 * drone["speed"] * speed_mult
        if (tx, ty) in weather_cells:
            base_speed *= 0.45

        dx, dy = tx - cx, ty - cy
        dist = math.sqrt(dx * dx + dy * dy)

        if dist <= base_speed:
            drone["x"] = float(tx)
            drone["y"] = float(ty)
            drone["path_index"] = pi + 1

            if (round(drone["x"]), round(drone["y"])) == drone["target"]:
                old_target = drone["target"]
                options = [h for h in HUBS if h != old_target]
                drone["target"] = random.choice(options)
                drone["path"] = []
                drone["path_index"] = 0
                charge = random.uniform(10, 22)
                drone["battery"] = min(100, drone["battery"] + charge)
                drone["status"] = "charging"
                drone["deliveries"] = drone.get("deliveries", 0) + 1
                total_deliveries += 1
                pri = " [PRIORITY]" if drone["priority"] else ""
                log_event(f"[{drone['id']}]{pri} Delivered → Hub {old_target} ✓ (#{drone['deliveries']})")
                drone["priority"] = False
        else:
            drone["x"] = round(cx + dx / dist * base_speed, 4)
            drone["y"] = round(cy + dy / dist * base_speed, 4)
            drone["status"] = "delivering"


def build_state():
    total = max(len(drones), 1)
    active = sum(1 for d in drones if d["status"] in ("delivering", "routing"))
    batteries = [d["battery"] for d in drones]
    avg_battery = round(sum(batteries) / total, 1)
    efficiency = round(active / total * 100, 1)
    uptime = round(time.time() - sim_start_time)

    return {
        "drones": [
            {
                "id": d["id"],
                "x": d["x"],
                "y": d["y"],
                "battery": d["battery"],
                "status": d["status"],
                "target": list(d["target"]),
                "path": [list(p) for p in d["path"][d["path_index"]:d["path_index"]+8]],
                "deliveries": d.get("deliveries", 0),
                "priority": d.get("priority", False),
                "collisions_avoided": d.get("collisions_avoided", 0),
            }
            for d in drones
        ],
        "hubs": [list(h) for h in HUBS],
        "obstacles": [list(o) for o in obstacles],
        "no_fly_zones": [list(z) for z in no_fly_zones],
        "weather_cells": [list(w) for w in weather_cells],
        "stats": {
            "fleet_efficiency": efficiency,
            "avg_battery": avg_battery,
            "active_drones": active,
            "total_drones": total,
            "collisions_avoided": collision_avoided,
            "total_deliveries": total_deliveries,
            "uptime": uptime,
            "paused": paused,
            "speed_mult": speed_mult,
            "fleet_size": len(drones),
        },
        "log": event_log[-40:],
    }


# ── Simulation Loop ───────────────────────────────────────────────────────────

async def simulation_loop():
    while True:
        if not paused:
            await tick()
        if state_subscribers:
            payload = json.dumps(build_state())
            dead = []
            for ws in state_subscribers:
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                if ws in state_subscribers:
                    state_subscribers.remove(ws)
        await asyncio.sleep(0.1)


BASE = os.environ.get("BASE_PATH", "").rstrip("/")


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket(f"{BASE}/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    state_subscribers.append(websocket)
    log_event("Ground Control connected")
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "obstacle":
                x, y = int(msg["x"]), int(msg["y"])
                if (x, y) in obstacles:
                    obstacles.discard((x, y))
                    log_event(f"[GC] Obstacle cleared at {chr(65+x)}{y}")
                else:
                    obstacles.add((x, y))
                    log_event(f"[GC] Obstacle at {chr(65+x)}{y}")
                    for d in drones:
                        pi = d["path_index"]
                        if any(p[0] == x and p[1] == y for p in d["path"][pi:]):
                            replan_drone(d, f"Obstacle at {chr(65+x)}{y}")
            elif msg.get("type") == "priority":
                drone_id = msg.get("id")
                for d in drones:
                    if d["id"] == drone_id:
                        d["priority"] = not d.get("priority", False)
                        log_event(f"[GC] {drone_id} priority {'ON' if d['priority'] else 'OFF'}")
    except WebSocketDisconnect:
        if websocket in state_subscribers:
            state_subscribers.remove(websocket)
        log_event("Ground Control disconnected")


# ── REST Endpoints ────────────────────────────────────────────────────────────

class ChaosEvent(BaseModel):
    type: str
    intensity: float = 0.5


@app.post(f"{BASE}/chaos")
async def inject_chaos(event: ChaosEvent):
    global paused
    if event.type == "weather":
        weather_cells.clear()
        count = int(14 * event.intensity)
        candidates = [(x, y) for x in range(GRID_W) for y in range(GRID_H) if not blocked(x, y)]
        chosen = random.sample(candidates, min(count, len(candidates)))
        for c in chosen:
            weather_cells.add(c)
        log_event(f"[CHAOS] Weather front — {len(chosen)} cells (intensity {event.intensity:.0%})")
        for d in drones:
            pi = d["path_index"]
            if any((p[0], p[1]) in weather_cells for p in d["path"][pi:]):
                replan_drone(d, "Weather avoidance")
    elif event.type == "nofly":
        no_fly_zones.clear()
        count = int(10 * event.intensity)
        candidates = [(x, y) for x in range(GRID_W) for y in range(GRID_H)
                      if not blocked(x, y) and (x, y) not in HUBS]
        chosen = random.sample(candidates, min(count, len(candidates)))
        for c in chosen:
            no_fly_zones.add(c)
        log_event(f"[CHAOS] No-Fly Zones activated — {len(chosen)} cells")
        for d in drones:
            pi = d["path_index"]
            if any((p[0], p[1]) in no_fly_zones for p in d["path"][pi:]):
                replan_drone(d, "No-fly avoidance")
    elif event.type == "emp":
        count = max(1, int(len(drones) * event.intensity * 0.5))
        eligible = [d for d in drones if d["status"] not in ("dead", "emp")]
        targets = random.sample(eligible, min(count, len(eligible)))
        for d in targets:
            d["status"] = "emp"
            d["path"] = []
            d["path_index"] = 0
            d["emp_recovery"] = 4.0 + random.uniform(0, 3.0)
        log_event(f"[CHAOS] EMP Pulse — {len(targets)} drone(s) offline")
    elif event.type == "clear":
        weather_cells.clear()
        no_fly_zones.clear()
        for d in drones:
            d["emp_recovery"] = 0.0
        log_event("[CHAOS] All events cleared")
    return {"ok": True, "type": event.type}


@app.post(f"{BASE}/pause")
async def pause_sim():
    global paused
    paused = True
    log_event("[SIM] Simulation paused")
    return {"paused": True}


@app.post(f"{BASE}/resume")
async def resume_sim():
    global paused
    paused = False
    log_event("[SIM] Simulation resumed")
    return {"paused": False}


class SpeedBody(BaseModel):
    value: float


@app.post(f"{BASE}/speed")
async def set_speed(body: SpeedBody):
    global speed_mult
    speed_mult = max(0.25, min(5.0, body.value))
    log_event(f"[SIM] Speed set to {speed_mult:.1f}x")
    return {"speed_mult": speed_mult}


class FleetBody(BaseModel):
    value: int


@app.post(f"{BASE}/fleet-size")
async def set_fleet_size(body: FleetBody):
    global target_fleet_size
    target_fleet_size = max(MIN_DRONES, min(MAX_DRONES, body.value))
    log_event(f"[FLEET] Fleet size → {target_fleet_size} drones")
    return {"fleet_size": target_fleet_size}


@app.post(f"{BASE}/reset")
async def reset_sim():
    global paused, speed_mult, target_fleet_size, sim_start_time
    obstacles.clear()
    no_fly_zones.clear()
    weather_cells.clear()
    paused = False
    speed_mult = 1.0
    target_fleet_size = 8
    sim_start_time = time.time()
    init_drones()
    log_event("[SIM] Full simulation reset")
    return {"ok": True}


@app.delete(f"{BASE}/obstacles")
async def clear_obstacles():
    obstacles.clear()
    log_event("[GC] All obstacles cleared")
    return {"ok": True}


@app.get(f"{BASE}/state")
async def get_state():
    return build_state()


@app.get(f"{BASE}/healthz")
async def healthz():
    return {"status": "ok", "uptime": round(time.time() - sim_start_time)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
