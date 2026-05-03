import asyncio
import heapq
import json
import math
import os
import random
import time
from collections import defaultdict
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="AetherFlow Swarm Controller")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GRID_W = 20
GRID_H = 20
NUM_DRONES = 8

HUBS = [
    (1, 1), (1, 18), (18, 1), (18, 18),
    (9, 1), (1, 9), (18, 9), (9, 18),
]

# ── State ────────────────────────────────────────────────────────────────────

obstacles: set[tuple[int, int]] = set()
no_fly_zones: set[tuple[int, int]] = set()
weather_cells: set[tuple[int, int]] = set()
event_log: list[str] = []

drones: list[dict] = []
collision_avoided = 0
log_subscribers: list[WebSocket] = []
state_subscribers: list[WebSocket] = []


def log_event(msg: str):
    ts = time.strftime("%H:%M:%S")
    entry = f"[{ts}] {msg}"
    event_log.append(entry)
    if len(event_log) > 200:
        event_log.pop(0)


def blocked(x: int, y: int) -> bool:
    return (x, y) in obstacles or (x, y) in no_fly_zones


def heuristic(a: tuple[int, int], b: tuple[int, int]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def astar(start: tuple[int, int], goal: tuple[int, int], reserved: set[tuple[int, int]] = None) -> list[tuple[int, int]]:
    if blocked(*goal):
        return []
    reserved = reserved or set()
    open_heap: list[tuple[float, tuple[int, int]]] = []
    heapq.heappush(open_heap, (0, start))
    came_from: dict[tuple[int, int], Optional[tuple[int, int]]] = {start: None}
    g: dict[tuple[int, int], float] = defaultdict(lambda: float("inf"))
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
            weight = 1.5 if neighbor in weather_cells else 1.0
            tentative_g = g[current] + weight
            if tentative_g < g[neighbor]:
                g[neighbor] = tentative_g
                f = tentative_g + heuristic(neighbor, goal)
                heapq.heappush(open_heap, (f, neighbor))
                came_from[neighbor] = current

    return []


def init_drones():
    global drones
    drones = []
    for i in range(NUM_DRONES):
        hub = HUBS[i % len(HUBS)]
        target_hub = HUBS[(i + 4) % len(HUBS)]
        drones.append({
            "id": f"Drone-{i+1:02d}",
            "x": float(hub[0]),
            "y": float(hub[1]),
            "battery": round(random.uniform(65, 100), 1),
            "status": "idle",
            "path": [],
            "path_index": 0,
            "target": target_hub,
            "collisions_avoided": 0,
            "speed": 1.0,
        })
    log_event("Swarm Controller initialized — 8 drones online")


init_drones()


def replan_drone(drone: dict, reason: str = "obstacle"):
    start = (round(drone["x"]), round(drone["y"]))
    goal = drone["target"]
    reserved = set()
    for other in drones:
        if other["id"] != drone["id"]:
            pos = (round(other["x"]), round(other["y"]))
            reserved.add(pos)
    new_path = astar(start, goal, reserved)
    if new_path:
        drone["path"] = new_path
        drone["path_index"] = 0
        drone["status"] = "routing"
        log_event(f"[{drone['id']}] Re-routing: {reason}")
    else:
        drone["status"] = "blocked"
        log_event(f"[{drone['id']}] BLOCKED — no viable path to {goal}")


async def tick():
    global collision_avoided
    reserved_next: dict[tuple[int, int], str] = {}

    for drone in drones:
        if drone["battery"] <= 0:
            drone["status"] = "dead"
            continue

        # Drain battery
        if drone["status"] in ("routing", "delivering"):
            drain = 0.04 if drone["x"] == round(drone["x"]) else 0.02
            if (round(drone["x"]), round(drone["y"])) in weather_cells:
                drain *= 1.8
            drone["battery"] = max(0, round(drone["battery"] - drain, 2))

        # Need a path?
        if not drone["path"] or drone["path_index"] >= len(drone["path"]):
            start = (round(drone["x"]), round(drone["y"]))
            drone["path"] = astar(start, drone["target"])
            drone["path_index"] = 0
            if drone["path"]:
                drone["status"] = "delivering"
                log_event(f"[{drone['id']}] New route → Hub {drone['target']}")
            else:
                drone["status"] = "idle"
            continue

        # Check next cell
        pi = drone["path_index"]
        next_cell = drone["path"][pi]

        if blocked(*next_cell):
            drone["collisions_avoided"] += 1
            collision_avoided += 1
            replan_drone(drone, f"Obstacle detected at {chr(65+next_cell[0])}{next_cell[1]}")
            continue

        if next_cell in reserved_next:
            drone["collisions_avoided"] += 1
            collision_avoided += 1
            log_event(f"[{drone['id']}] Collision avoidance — yielding at {chr(65+round(drone['x']))}{round(drone['y'])}")
            continue

        reserved_next[next_cell] = drone["id"]

        # Move toward next cell
        tx, ty = next_cell
        cx, cy = drone["x"], drone["y"]
        speed = 0.12 * drone["speed"]
        if (tx, ty) in weather_cells:
            speed *= 0.5

        dx = tx - cx
        dy = ty - cy
        dist = math.sqrt(dx * dx + dy * dy)

        if dist <= speed:
            drone["x"] = float(tx)
            drone["y"] = float(ty)
            drone["path_index"] = pi + 1

            # Reached target hub
            if (round(drone["x"]), round(drone["y"])) == drone["target"]:
                old_target = drone["target"]
                options = [h for h in HUBS if h != old_target]
                drone["target"] = random.choice(options)
                drone["path"] = []
                drone["path_index"] = 0
                drone["battery"] = min(100, drone["battery"] + random.uniform(8, 18))
                drone["status"] = "charging"
                log_event(f"[{drone['id']}] Delivered → Hub {old_target} ✓ | Next: {drone['target']}")
        else:
            drone["x"] = round(cx + dx / dist * speed, 4)
            drone["y"] = round(cy + dy / dist * speed, 4)
            drone["status"] = "delivering"


def build_state():
    total = len(drones)
    active = sum(1 for d in drones if d["status"] in ("delivering", "routing"))
    avg_battery = round(sum(d["battery"] for d in drones) / total, 1)
    efficiency = round(active / total * 100, 1)

    return {
        "drones": [
            {
                "id": d["id"],
                "x": d["x"],
                "y": d["y"],
                "battery": d["battery"],
                "status": d["status"],
                "target": list(d["target"]),
                "path": [list(p) for p in d["path"][d["path_index"]:d["path_index"]+6]],
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
        },
        "log": event_log[-30:],
    }


# ── Background loop ───────────────────────────────────────────────────────────

async def simulation_loop():
    while True:
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
                state_subscribers.remove(ws)
        await asyncio.sleep(0.1)


from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_):
    asyncio.create_task(simulation_loop())
    yield

app.router.lifespan_context = lifespan


# ── WebSocket endpoint ────────────────────────────────────────────────────────

BASE = os.environ.get("BASE_PATH", "").rstrip("/")


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
                    log_event(f"[GC] Obstacle placed at {chr(65+x)}{y}")
                    for d in drones:
                        pi = d["path_index"]
                        remaining = d["path"][pi:]
                        if any(p[0] == x and p[1] == y for p in remaining):
                            replan_drone(d, f"Obstacle placed at {chr(65+x)}{y}")
    except WebSocketDisconnect:
        state_subscribers.discard(websocket) if hasattr(state_subscribers, "discard") else None
        if websocket in state_subscribers:
            state_subscribers.remove(websocket)
        log_event("Ground Control disconnected")


# ── REST Chaos Engine ─────────────────────────────────────────────────────────

class ChaosEvent(BaseModel):
    type: str
    intensity: float = 0.5


@app.post(f"{BASE}/chaos")
async def inject_chaos(event: ChaosEvent):
    if event.type == "weather":
        weather_cells.clear()
        count = int(12 * event.intensity)
        candidates = [(x, y) for x in range(GRID_W) for y in range(GRID_H) if not blocked(x, y)]
        chosen = random.sample(candidates, min(count, len(candidates)))
        for c in chosen:
            weather_cells.add(c)
        log_event(f"[CHAOS] Weather event — {len(chosen)} cells affected (intensity {event.intensity:.0%})")
        for d in drones:
            if d["path"]:
                pi = d["path_index"]
                if any((p[0], p[1]) in weather_cells for p in d["path"][pi:]):
                    replan_drone(d, "Weather avoidance")
    elif event.type == "nofly":
        no_fly_zones.clear()
        count = int(8 * event.intensity)
        candidates = [(x, y) for x in range(GRID_W) for y in range(GRID_H)
                      if not blocked(x, y) and (x, y) not in HUBS]
        chosen = random.sample(candidates, min(count, len(candidates)))
        for c in chosen:
            no_fly_zones.add(c)
        log_event(f"[CHAOS] No-Fly Zone activated — {len(chosen)} cells restricted")
        for d in drones:
            pi = d["path_index"]
            if any((p[0], p[1]) in no_fly_zones for p in d["path"][pi:]):
                replan_drone(d, "No-fly zone avoidance")
    elif event.type == "clear":
        weather_cells.clear()
        no_fly_zones.clear()
        log_event("[CHAOS] All environmental events cleared")
    return {"ok": True, "type": event.type}


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
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
