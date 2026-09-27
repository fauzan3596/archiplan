# Archiplan

Turn a 2D floor-plan image into an editable vector plan, a walkable 3D model, an Indonesian renovation cost estimate (RAB) and a sun-light study. Everything runs in the browser on [Puter](https://puter.com) (auth, storage, KV, AI); there is no custom backend besides one Puter worker.

**Try it without an account:** open `/visualizer/demo` (the "Coba Demo 3D" button on the home page). The demo loads a built-in sample house, needs no login or AI credit, and keeps edits in memory only.

## Features

| Tab | What it does |
|---|---|
| **Render** | Photorealistic AI render of the uploaded plan (Gemini via `puter.ai.txt2img`) with a before/after slider. |
| **Denah 2D** | A vision model reads walls, doors, windows, room names and dimension labels into JSON; the geometry is snapped, noded and polygonised into rooms. An SVG editor over the original image lets you fix it: drag corners with snapping, draw/split/delete walls, add openings, rename rooms, calibrate the scale (two points or total width), undo/redo, and one-click fixes for detected problems. |
| **Walkthrough 3D** | React Three Fiber scene built from the plan: extruded walls with real door/window cut-outs, per-room floors with procedurally generated textures, orbit view and first-person WASD walk with wall collision (drag-look + joystick on touch), `.glb` export. |
| **Simulasi matahari** | suncalc-driven sun for any date, time and Indonesian city: moving shadows, sun path arc, compass, and estimated hours of direct sun per room. |
| **RAB** | Quantity take-off from the corrected geometry (floor, wall faces net of openings, plint, ceiling, doors, windows, electrical points) priced with sourced 2025–2026 Indonesian unit prices, grade (Ekonomis/Standar/Premium), regional IKK multipliers, contractor fee, optional PPN 11 %, rekapitulasi with terbilang, and CSV export. Export is locked until the plan scale is confirmed. |

### How it fits together

- One persisted object, `DesignItem.plan` (`FloorPlan` in `type.d.ts`), feeds every tab. Geometry is in metres, x right / y down like the image; the 3D scene maps plan `(x, y)` to world `(x, 0, z = y)`. `northOffsetDeg` is the compass bearing of the image's "up".
- Plan edits autosave (debounced) through the worker's `POST /api/projects/plan`, which merges by `plan.editedAt` so a stale save can never overwrite newer edits.
- Pure logic lives in `lib/plan` (geometry, editor reducer, extraction), `lib/rab` and `lib/sun`, all unit-tested; `three` is only loaded on the 3D tab.

## AI extraction and credits

Floor-plan extraction calls a vision model through `puter.ai.chat` (default `claude-sonnet-5`) and is billed to the signed-in user's Puter credit (about 3 US cents per attempt). Without credit you can still use **Coba denah contoh** (sample plan) or **Gambar manual** (start from a rectangle).

- Mock mode for development: add `?mock=1` to the URL or set `VITE_EXTRACT_MOCK=1` in `.env`; extraction then returns the sample plan without calling Puter.
- To compare models on a real plan once you have credit: `node scripts/probe-vision.mjs path/to/plan.png [modelId...]` (writes `scratch/probe-<model>.json`). Switch the default in `lib/plan/extract.ts` (`DEFAULT_EXTRACTION_MODEL_ID`) based on the result.

## Tests

```bash
npm test
```

## Getting Started

### Installation

Install the dependencies:

```bash
npm install
```

### Development

Start the development server with HMR:

```bash
npm run dev
```

Your application will be available at `http://localhost:5173`. The built-in demo is at `http://localhost:5173/visualizer/demo`.

## Building for Production

Create a production build:

```bash
npm run build
```

## Deployment

### Puter Deployment

The app runs in SPA mode (`ssr: false`) and is hosted on Puter together with its worker.

1. Set `VITE_PUTER_WORKER_URL` and `PUTER_SITE_SUBDOMAIN` in `.env` (see `.env.example`).
2. Log in once: `npm run deploy:login` (or set `PUTER_AUTH_TOKEN`).
3. Deploy:

```bash
npm run deploy          # build, then deploy worker + site
npm run deploy:site     # build, then deploy the site only
npm run deploy:worker   # deploy lib/puter.worker.js only
```

The site is served at `https://<PUTER_SITE_SUBDOMAIN>.puter.site`.

> The Docker and DIY options below need the server build, which requires `ssr: true` in `react-router.config.ts`.

### Docker Deployment

To build and run using Docker:

```bash
docker build -t my-app .

# Run the container
docker run -p 3000:3000 my-app
```

The containerized application can be deployed to any platform that supports Docker, including:

- AWS ECS
- Google Cloud Run
- Azure Container Apps
- Digital Ocean App Platform
- Fly.io
- Railway

### DIY Deployment

If you're familiar with deploying Node applications, the built-in app server is production-ready.

Make sure to deploy the output of `npm run build`

```
├── package.json
├── package-lock.json (or pnpm-lock.yaml, or bun.lockb)
├── build/
│   ├── client/    # Static assets
│   └── server/    # Server-side code
```

## Styling

This template comes with [Tailwind CSS](https://tailwindcss.com/) already configured for a simple default starting experience. You can use whatever CSS framework you prefer.

---

Built with ❤️ using React Router.
