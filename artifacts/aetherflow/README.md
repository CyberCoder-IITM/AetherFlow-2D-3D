# AetherFlow

AetherFlow is a cyber-industrial logistics digital twin dashboard.

## What it does

- Live drone swarm simulation
- FastAPI backend with A* pathfinding
- WebSocket streaming updates
- 2D canvas and 3D scene views
- Theme switching
- Chaos controls like weather, no-fly zones, and EMP

## Tech Stack

- React
- Vite
- TypeScript
- FastAPI
- Three.js
- React Three Fiber

## Run

- Frontend: `pnpm --filter @workspace/aetherflow run dev`
- Backend: `PORT=8000 BASE_PATH=/swarm-api python artifacts/swarm-api/main.py`

## Preview

Open the AetherFlow app in the preview pane to watch the swarm move in real time.
