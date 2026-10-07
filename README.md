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
- **Routing:** self-hosted OSRM, foot profile (distance-weighted → the **shortest
  walking path** between waypoints). Pedestrians follow the street centreline
  even where a sidewalk is mapped separately (`foot=use_sidepath`), avoiding
  large detours; provisioned through a Nix flake
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
  so the area stands out against the normal basemap. Other areas in the city (and
  their routes for this campaign) are still visible, but **dimmed behind the
  darkened background**.
- **Add route** — click waypoints on the map (each **snaps to the nearest road**),
  then **Confirm**; **Undo** removes the last waypoint and **Cancel** aborts. The
  server routes a walking path between them; routes are recorded **for the campaign**
  in the link. (There is no freehand "draw line" mode.)
- **See routes** — opens the list of saved routes (the latest has the highest
  number, and each shows the **date it was added**). Hovering or clicking a route
  **highlights it on the map**; **Edit** opens the waypoint editor (drag waypoints,
  click to add, delete, then save to re-route) and **Del** removes the route (the
  map updates immediately, no refresh needed).
- Routes **fade linearly over 14 days** (on both the area page and the admin map)
  and are **removed automatically once fully faded**.
- The page reflects changes made elsewhere when it regains focus (and only updates
  the map if something actually changed, so it never flashes).

## NixOS module

The flake exposes a NixOS module, so another flake can use it as an input:

```nix
{
  inputs.collabmap.url = "github:hallundbaek/collabmap";

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
              osrmThreads = 2;           # cap osrm-routed threads (bounds RAM)
              adminToken = "change-me";  # fixed admin token
              region = {
                pbfUrl = "https://download.geofabrik.de/europe/denmark-latest.osm.pbf";
                # Pin the PBF by hash (nix hash file --type sha256 --sri denmark-latest.osm.pbf).
                # Geofabrik "-latest" rolls daily — prefer a dated snapshot for stability.
                pbfHash = "sha256-hOF0XUGC4TjZtCpMXKFKQboKKJJMqJms3teG/IusrRA=";
                bbox = [ 12.03 55.60 12.75 55.77 ];  # routing coverage (union)
              };
              cities = [
                { slug = "copenhagen"; name = "Copenhagen"; initialCenter = [ 12.568 55.676 ]; initialZoom = 12; }
              ];
            };
          };
        }
      ];
    };
  };
}
```

Cities are **logical groupings** (for the admin dropdown, map view, and public link
titles); **routing coverage is the `region.bbox`**, so areas for any city can be
drawn anywhere inside it.

This defines two systemd services:

- **`collabmap-osrm`** — runs `osrm-routed` (CH) on the **region dataset**, which is
  built at **Nix build time** (see below) and served straight from the Nix store.
- **`collabmap`** — the Express backend, which also **serves the built web app**
  (`WEB_DIST`), so everything is on one port (`settings.port`).

### Deploying from a powerful machine

The dataset is a build-time derivation (`nix/dataset.nix`): it fetches the PBF
(hash-pinned), clips to the union bbox, and runs `osrm-extract`/`osrm-contract`.
Because it's part of the system closure, it is **built on the machine running
`nixos-rebuild`** — the host never runs osmium/OSRM. So you can build here and push
to a resource-constrained host:

```sh
nixos-rebuild switch --flake .#myhost --target-host root@xxx.xx --use-remote-sudo
```

(Requires SSH access to the host and the same `system`; a `root@` target — or a user
in `nix.settings.trusted-users` — avoids needing to sign store paths. You can also
use a binary cache or a remote builder instead.)

Useful options: `services.collabmap.package` (defaults to the flake's `collabmap`
package), and `settings.dataDir` (defaults to `/var/lib/collabmap`, holds only the
SQLite DB — the dataset lives in the store). The admin UI is at
`http://<host>:<port>/admin/<adminToken>`; `adminToken = null` (default) makes the
server generate and persist one in the data dir (printed at startup).

Individual packages are exposed: `collabmap.packages.<system>.{collabmap,server,web}`.

## Development commands

| Command | Purpose |
| --- | --- |
| `nix run .#dev` | Start the whole stack (default port 4321) |
| `nix run .#provision` | Build the union-clip OSRM region dataset |
| `nix develop` | Enter a dev shell (node, npm, osrm, osmium, jq, curl) |
| `bash scripts/test-api.sh` | Smoke-test the backend API (boots OSRM itself) |
| `bash scripts/test-edit-divide.sh` | Test area edit + divide |
| `bash scripts/test-shared-waypoints.sh` | Test shared waypoints across areas |
| `bash scripts/test-area-admin.sh` | Test road snapping, colours, rename, delete |
| `node server/geo.test.mjs` | Unit-test boundary splitting (`splitRing`) |
| `bash scripts/seed-perf.sh` | Seed a perf dataset (Voronoi areas + campaign + routes) |
| `bash scripts/e2e.sh` | Boot `nix run .#dev` and probe all services |

## Adding a city

Cities are logical groupings; routing coverage is the **union** of all cities'
bboxes, built once as a single region dataset.

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
2. Run `nix run .#provision` (downloads the PBF, clips to the **union** bbox, and
   builds the OSRM foot graph at `data/osrm/region.osrm`).
3. `nix run .#dev` — the new city appears in the admin dropdown.

> `bbox` is `[min_lon, min_lat, max_lon, max_lat]`. It widens the routing region;
> areas for any city can be drawn anywhere inside the union.
>
> For the NixOS module, add the city to `settings.cities` and widen
> `settings.region.bbox` (and update `pbfHash` if the PBF changed).

## Layout

```
flake.nix            # flake: devShell + apps.dev / apps.provision
provisioning/        # 01-download, 02-clip, 03-osrm-build, build-all
scripts/             # dev.sh, test-api.sh, e2e.sh
server/              # Express + SQLite (index.js, db.js, osrm.js, cities.json)
web/                 # React + MapLibre app (Vite)
data/                # gitignored: sqlite DB, PBF files, OSRM datasets
```