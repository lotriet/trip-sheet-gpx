# Trip sheet to GPX

A phone-friendly page that turns a Wake County (WCPSS) **Driver Directions by Route** sheet into a GPX track for [OsmAnd](https://osmand.net/).

The track follows the printed streets **in order**, with the printed turn directions. It does not shorten the run or skip a street. You can stack several runs into one day, then download either one combined track or a zip of separate tracks.

Photos and sheet text stay in the browser. Nothing is uploaded or stored on a server. The day list is kept in this phone’s browser storage (IndexedDB).

## On the phone

1. Open the page in Safari or Chrome. Add it to the home screen if you want it one tap away.
2. Tap **Add a run**. The area starts as Wake County, North Carolina. Change it if the sheet is somewhere else.
3. Take one or more photos of the sheet, or paste the text. Several pages are fine — add every photo before you build the route.
4. Check the stop list. Fix any street the reader got wrong, then tap **Build the route**.
5. The map shows the line and numbered stops. Orange dots are turnarounds the app had to guess (the end of a court, a loop, a school driveway). Tap **Move**, then tap the map if the bus turns around somewhere else. **Add a via point** forces the line through a spot you tap.
6. Tap **Add to today’s list**. Repeat for the other runs you drive that day. Use **Up** and **Down** so the list matches the order you drive them.

### One GPX for the whole day

OsmAnd follows one track at a time. **One GPX for the day** joins the runs, in list order, into a single track.

Between the end of one run and the start of the next, the app drives the ordinary streets (a deadhead). That piece is **not** from a trip sheet. A waypoint named `DEADHEAD to run 2` marks where it starts. If the map cannot connect the two ends, the file uses a straight line and the waypoint says so — do not follow that straight line.

Waypoints look like `Run 2 3:25 PM School: Oak Academy`.

In OsmAnd: tap the GPX file, choose **Open in OsmAnd**, then **Navigation → Follow track**, and tap **Apply** on **Attach to the roads**.

### A zip of separate tracks

**Zip of separate GPX** gives one file per run, named so they sort in order in OsmAnd’s Tracks folder:

`01_SAMPLE_OakAcademy_0315PM.gpx`

Unzip it (Files on iPhone, or the zip app on Android), then import each track. Follow them one at a time, in name order: tap the GPX, **Open in OsmAnd**, **Navigation → Follow track**, **Apply** for **Attach to the roads**.

Clear the list with **Remove** when the day is done. The list survives a reload. It does not sync to another phone.

## What the route will and will not do

- It stays on the named street for each line of the sheet. A “Proceed” on the street you are already on does not add a turn.
- A turnaround is a guess. School driveways and the bulb at the end of a court are the usual spots. Move the orange dot if the guess is wrong.
- Divided roads sometimes sit a few yards off the other carriageway in the map tiles. The line is still that street.
- Bus-only restrictions are not in the map. The trip sheet wins.

## Run it locally

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:43123/trip-sheet-gpx/ . `npm run dev` listens on port 43123, and the page is under `/trip-sheet-gpx/` so it matches the public URL.

`npm test` checks the sheet parser and the day-file names. It does not include a real trip sheet.

On the edit screen, **Load a fake example** fills in a made-up run on public streets in downtown Raleigh. It is not a real trip.

## Map data and fair use

Street geometry comes from [OpenFreeMap](https://openfreemap.org/) vector tiles (OpenStreetMap, © OSM contributors). Place names for the map area come from the public [Photon](https://photon.komoot.io/) geocoder. The preview map uses the standard [OpenStreetMap](https://tile.openstreetmap.org/) raster tiles. The map shows “© OpenStreetMap contributors”, which is the attribution their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) requires. The browser requests only the tiles on screen, sends its normal Referer, and caches them. There is no API key.

That policy is for light, interactive viewing. One driver building a handful of runs a day fits. A whole depot, a shared kiosk, or a script that pans the map does not — host your own tiles before you do that. OpenFreeMap, which this app already uses for the street lines, allows heavier use of its public vector tiles.

The first time you read a photo, the OCR engine (Tesseract) may download its language data from jsDelivr. The photo itself never leaves the phone. The worker script is served from this app. If OCR fails, paste the sheet text; that path needs no OCR download.

## Static build

```bash
npm install
npm run build
```

`npm run build` runs `next build`. The site is fully static: that command writes HTML, JavaScript, and CSS into the **`out/`** folder. There is no Node server to run afterward. Those files must be served at `/trip-sheet-gpx/` on the host, not at the bare domain root.

## Put it on a free public URL

Publishing needs your GitHub or Cloudflare login. After it is public, open that URL on the phone. The day list still lives only on that phone.

The built files expect to be served from `/trip-sheet-gpx/` (`basePath` and `assetPrefix` in `next.config.ts`). That matches a GitHub project site. `public/.nojekyll` is copied into `out/` so a host that runs Jekyll does not hide the `_next` folder.

**GitHub Pages** for `github.com/lotriet/trip-sheet-gpx` (https://lotriet.github.io/trip-sheet-gpx/):

1. Push this history to that repository. It does not contain a real trip sheet.
2. In the repository, go to **Settings → Pages → Build and deployment**, and set **Source** to **GitHub Actions**.
3. Push to `main`. `.github/workflows/pages.yml` runs `npm ci`, then `npm run build`, and publishes the `out` folder.
4. Open https://lotriet.github.io/trip-sheet-gpx/ when the action finishes.

**Cloudflare Pages**

The same prefix applies. Publish a folder whose root contains `trip-sheet-gpx/`, not the `out` folder itself.

1. In Cloudflare, create a Pages project and connect the Git repository.
2. Framework preset: **None**.
3. Build command: `npm run build && mkdir -p site/trip-sheet-gpx && cp -a out/. site/trip-sheet-gpx/`
4. Build output directory: `site`.
5. Deploy. No environment variables are required. The page is at `https://<project>.pages.dev/trip-sheet-gpx/`.
