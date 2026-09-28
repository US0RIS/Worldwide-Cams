# Worldwide Cams

A globe for inspecting the same **cataloged public-camera sources** used by Jarvis World Armor.

The point of this project is verification, not inference: if Jarvis says a public camera exists, this app gives you an independent map surface where you can select that exact camera, see its provider/coordinates/source metadata, and view the publisher's current still or supported player/stream.

## Camera sources

### Caltrans CWWP2
- Mirrors Jarvis's 12-district Caltrans CCTV catalog adapter.
- Only in-service records with publisher-supplied HTTPS media on the same allowlisted Caltrans hosts are shown.
- The map displays every currently returned catalog camera.
- A published still/stream does **not** prove a capture time or that the view is currently live.

### Windy Webcams API v3
- Paste your Windy key directly into the **Windy Webcams API key** field in the website header.
- The key is stored only in that browser's local storage and sent to the local Worldwide-Cams server only on API requests that may need Windy. The server does not persist or echo it.
- `JARVIS_WINDY_WEBCAMS_API_KEY` remains an optional server-side fallback for unattended/local-server use.
- At globe/continent scale the UI uses Windy's map-cluster endpoint; zooming in resolves individual webcams in the visible bounding box.
- Free/professional API listing limits are surfaced honestly. The app does not claim a complete worldwide individual-camera inventory when the provider/API tier cannot supply one.
- Windy images link back to the provider and include the required attribution.

### YouTube Live
- Paste a Google API key with **YouTube Data API v3** enabled into the **YouTube Data API key** field in the website header.
- The key is stored only in that browser's local storage and sent to the local Worldwide-Cams server on YouTube-capable requests. It is not written into the candidate registry or echoed in API responses.
- Discovery uses the official YouTube Data API with currently-live video filtering plus embeddability/syndication and geographic search constraints.
- Newly discovered broadcasts enter a **REVIEW queue**, not the production globe. Metadata and thumbnails alone never make a YouTube result a production camera.
- The review UI uses the normal supported YouTube embed/watch experience. A reviewer must explicitly confirm location, actual live visual content, and temporal fixed-view behavior before ACCEPT can place a YouTube camera on the production globe.
- Stored public YouTube metadata expires before 30 days unless refreshed.
- `WORLDWIDE_CAMS_YOUTUBE_API_KEY` is an optional server-side credential fallback. Browser entry is the normal interactive setup.
- `WORLDWIDE_CAMS_YOUTUBE_DERIVED_METRICS_APPROVED=1` records that the operator has the applicable YouTube derived-metrics approval; it does not bypass the production visual/temporal gate.
- The current YouTube provider is **not release-complete** under `criteria.md`: official YouTube interfaces do not expose arbitrary live video frames for an automated vision pipeline, so the implementation does not pretend thumbnails satisfy that requirement.

### Optional exact public sources
For public direct cameras you manually enrolled elsewhere, set `WORLDWIDE_CAMS_CUSTOM_JSON` to a JSON array of camera records. This app does not read Jarvis's private SQLite ledger or expose its bearer token.

Example:

```json
[
  {
    "id": "harbor-demo",
    "title": "Harbor public camera",
    "latitude": 33.74,
    "longitude": -118.27,
    "image_url": "https://publisher.example/camera.jpg",
    "source_url": "https://publisher.example/cameras"
  }
]
```

Only public HTTP/HTTPS URLs should be placed there. Do not put passwords, signed private URLs, or private-network camera addresses into this repository or environment variable.

## Run locally

Requires Node.js 20+.

```bash
npm install

npm run dev
```

Open the Vite URL shown in the terminal (normally http://localhost:5173).

For a production build:

```bash
npm run build
npm start
```

The Express server serves `dist/` and the API on port `8787` by default.

## What the map proves

A marker proves only that a camera record was returned by a configured provider (or explicitly supplied as a custom public source). Selecting one shows the evidence needed to audit the claim:

- stable camera/provider ID;
- publisher-reported coordinates;
- provider/source URL;
- provider update/service metadata when available;
- current publisher still, official Windy player, or Caltrans stream when the browser can render it;
- explicit freshness/coverage limitations.

The app does **not** infer people, vehicles, license plates, incidents, camera field of view, or physical event time.

## OpenStreetMap

The globe uses OpenStreetMap raster tiles through MapLibre GL JS and preserves OSM attribution. The public OSM tile service is appropriate for light personal/development use; a production/high-traffic deployment should use an OSM-compatible commercial/self-hosted tile service consistent with the tile usage policy.

## Acceptance

`criteria.md` is the release acceptance constitution. In particular, YouTube REVIEW candidates are intentionally excluded from the normal globe until the production invariant is satisfied.

## Tests

```bash
npm test
npm run build
```

CI runs provider-parser/API tests plus a production frontend build on every push.
