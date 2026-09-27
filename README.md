# CollabMap

A collaborative map for partitioning a city into responsibility areas.

Each area gets a shareable link. Anyone with the link records routes they have
walked in that area — either by **clicking waypoints** on the map or by
**freehand-drawing** along streets. In both cases the app snaps the input onto
the walking street network (via a self-hosted OSRM instance) and stores the
resulting walking path. Area boundary polygons are likewise snapped to walking
routes between their vertices.

- **Frontend:** React + MapLibre GL (OpenFreeMap vector tiles)
- **Backend:** Node.js + Express + SQLite (better-sqlite3)
- **Routing:** self-hosted OSRM, foot profile, provisioned through a Nix flake
- **Auth:** none — area pages are open via URL
- **Cities:** multiple; seeded with **Copenhagen** (Geofabrik Denmark extract)

## Quick start

Prerequisites: [Nix](https://nixos.org) with flakes enabled.

```sh
# one command runs everything on the default port 4321:
nix run .#dev
```

This will:

1. Install server + web dependencies (`npm install`),
2. Provision city OSRM datasets on first run (downloads the region PBF and
   builds a **foot** routing graph, served with the **CH** algorithm — needs
   network and can take a while),
3. start `osrm-routed` on :5000 (waits until it can actually route),
4. start the Express backend on **:4321**,
5. start the Vite dev server on :5173 (proxying `/api` and `/a` to the backend).

Then open:

- **Admin / builder:** `http://localhost:5173/admin/<adminToken>` — pick a city,
  draw area polygons, and run campaigns. The admin requires a token: the backend
  generates one on first run and prints the admin link at startup (and `nix run
  .#dev` prints it too). Set `ADMIN_TOKEN=…` to use a fixed one.
- **Public area page:** a link of the form
  `http://localhost:5173/area/<areaToken>/<campaignToken>` (created via a campaign,
  see below). The page title is **`<area name> - <campaign name>`**.

The root (`/`) shows a small landing page (no admin there).

## Usage

### Admin
- Press **Draw new area**, then click vertices on the map to sketch a polygon.
  Every clicked point **snaps to the nearest road**. Click the **first vertex
  again to close** the polygon, enter a name, and press **Save area**. The
  boundary is the **direct shortest segment** between each pair of waypoints
  (it may cross roads anywhere), so it never takes convoluted detours.
- Each area shows a name **label on the map** with two icons (there is no area
  list on the left):
  - **✎ (pencil)** — edit the area's waypoints.
  - **⚙ (cog)** — open the **area options** modal: change **name & colour**,
    **Divide**, **Delete**, or **Merge** with another area (they must share a
    boundary). Merging dissolves the shared boundary and moves both areas'
    routes to the merged area.
- **Campaigns:** type a name and press **Start** to begin a campaign. Select a
  campaign to see the routes drawn for it on the map. **Links** opens a modal with
  the per-area links for that campaign (copy any of them). **Del** deletes a
  campaign and **all routes drawn in it** (areas are kept).
- **Edit** an area (**✎**): drag waypoints to reshape (each snaps to the nearest
  road), click to add, and remove waypoints from the list. Adding a waypoint on an
  edge **shared with a neighbouring area also adds it to that area**, so shared
  boundaries stay in sync. The camera does not move when editing.
- **Divide** an area into two (via **⚙ → Divide**): draw a polyline across the
  area (points snap to roads), name both halves, and press **Divide**. The original
  is replaced by the two new areas; the camera does not move.
- Areas are **auto-coloured** so that no area shares a colour with a neighbour.
- Recorded **routes are overlaid on the admin map** as thicker lines in their
  area's colour (read-only there; edit them on the area's link).
- Boundaries are re-derived from waypoints on startup, so existing areas pick up
  algorithm changes (e.g. the switch to direct segments) automatically.

### Shared waypoints
Areas are defined by shared, globally-identified waypoints (stored per city):

- **Create** snaps to existing waypoints — clicking near a waypoint that belongs
  to another area reuses it, so neighbouring areas automatically share a boundary.
- **Divide** turns the dividing line's points into waypoints **shared by both**
  new areas.
- **Edit** a waypoint and **every area that shares it** is re-snapped and updated
  (moving a shared corner reshapes all adjacent areas).
- **Neighbours** (areas sharing a waypoint) always get distinct colours.

### Public area page
A link is **per area _and_ campaign**: `/area/<areaToken>/<campaignToken>` (open a
campaign's **Links** modal in the admin to copy any of them). The page title is
`<area name> - <campaign name>`. Opening the link shows **only that area**:

- The area has **no fill colour**; instead everything **outside** it is darkened,
  so the area stands out against the normal basemap.
- Add a route with **Click points** (click waypoints — each **snaps to the nearest
  road** → **Save route**; the server routes a walking path between them) or with
  **Draw line** (hold and drag along streets; the trace is map-matched). Routes are
  recorded **for the campaign** in the link.
- Saved routes are drawn in the **area's colour** and listed with their length.
- **Edit** a route (or delete it) from the saved-routes list: the waypoint editor
  works like the area editor — drag waypoints (they snap to roads), click to add,
  delete waypoints, then **Save route** to re-route it.
- The page reflects edits made to the area (it refetches when it regains focus).

## NixOS module

The flake exposes a NixOS module, so another flake can use it as an input:

```nix
{
  inputs.collabmap.url = "github:you/collabmap";

  outputs = { self, nixpkgs, collabmap, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        collabmap.nixosModules.default
        {
          services.collabmap = {
            enable = true;
            settings = {
              port = 4321;               # web app
              osrmPort = 5000;           # local OSRM
              adminToken = "change-me";  # fixed admin token
              cities = [
                {
                  slug = "copenhagen";
                  name = "Copenhagen";
                  pbfUrl = "https://download.geofabrik.de/europe/denmark-latest.osm.pbf";
                  bbox = [ 12.40 55.60 12.75 55.77 ];
                  initialCenter = [ 12.568 55.676 ];
                  initialZoom = 12;
                }
              ];
            };
          };
        }
      ];
    };
  };
}
```

This defines three systemd services:

- **`collabmap-provision`** (oneshot, if `settings.autoProvision`) — downloads the
  region PBFs and builds each city's OSRM foot dataset into `settings.dataDir`
  (needs network on first start).
- **`collabmap-osrm`** — runs `osrm-routed` (CH) on the first city's dataset.
- **`collabmap`** — the Express backend, which also **serves the built web app**
  (`WEB_DIST`), so everything is on one port (`settings.port`).

Useful options: `services.collabmap.package` (defaults to the flake's `collabmap`
package), and `settings.dataDir` (defaults to `/var/lib/collabmap`). The admin UI
is at `http://<host>:<port>/admin/<adminToken>`; `adminToken = null` (default)
makes the server generate and persist one in the data dir (printed at startup).

Individual packages are also exposed: `collabmap.packages.<system>.{collabmap,server,web,provision}`.

## Development commands

| Command | Purpose |
| --- | --- |
| `nix run .#dev` | Start the whole stack (default port 4321) |
| `nix run .#provision` | Re-provision OSRM datasets for all cities |
| `nix develop` | Enter a dev shell (node, npm, osrm, osmium, jq, curl) |
| `bash scripts/test-api.sh` | Smoke-test the backend API (boots OSRM itself) |
| `bash scripts/test-edit-divide.sh` | Test area edit + divide |
| `bash scripts/test-shared-waypoints.sh` | Test shared waypoints across areas |
| `bash scripts/test-area-admin.sh` | Test road snapping, colours, rename, delete |
| `node server/geo.test.mjs` | Unit-test boundary splitting (`splitRing`) |
| `bash scripts/seed-perf.sh` | Seed a perf dataset (Voronoi areas + campaign + routes) |
| `bash scripts/e2e.sh` | Boot `nix run .#dev` and probe all services |

## Adding a city

1. Add an entry to `server/cities.json`:
   ```json
   {
     "slug": "paris",
     "name": "Paris",
     "pbf_url": "https://download.geofabrik.de/europe/france-latest.osm.pbf",
     "bbox": [2.22, 48.81, 2.49, 48.92],
     "initial_center": [2.35, 48.86],
     "initial_zoom": 12
   }
   ```
2. Run `nix run .#provision` (downloads the region PBF, clips it to the
   bounding box, and builds the OSRM foot graph).
3. `nix run .#dev` — the new city appears in the admin dropdown.

> Note: `bbox` should be `[min_lon, min_lat, max_lon, max_lat]` and must fully
> contain the area you want to partition.

Note: `nix run .#dev` currently serves the OSRM dataset for the **first** city
in `server/cities.json` only.

## Layout

```
flake.nix            # flake: devShell + apps.dev / apps.provision
provisioning/        # 01-download, 02-clip, 03-osrm-build, build-all
scripts/             # dev.sh, test-api.sh, e2e.sh
server/              # Express + SQLite (index.js, db.js, osrm.js, cities.json)
web/                 # React + MapLibre app (Vite)
data/                # gitignored: sqlite DB, PBF files, OSRM datasets
```