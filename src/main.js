import maplibregl from "maplibre-gl";
import Hls from "hls.js";
import "./styles.css";

const els = {
  providerStatus: document.querySelector("#provider-status"),
  cameraCount: document.querySelector("#camera-count"),
  coverageStatus: document.querySelector("#coverage-status"),
  windyKeyInput: document.querySelector("#windy-key-input"),
  windyKeySave: document.querySelector("#windy-key-save"),
  windyKeyClear: document.querySelector("#windy-key-clear"),
  mapMessage: document.querySelector("#map-message"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  resetView: document.querySelector("#reset-view"),
  refreshView: document.querySelector("#refresh-view"),
  emptyPanel: document.querySelector("#empty-panel"),
  detail: document.querySelector("#camera-detail"),
  closeDetail: document.querySelector("#close-detail"),
  detailProvider: document.querySelector("#detail-provider"),
  detailAvailability: document.querySelector("#detail-availability"),
  detailTitle: document.querySelector("#detail-title"),
  detailPlace: document.querySelector("#detail-place"),
  detailId: document.querySelector("#detail-id"),
  detailCoordinates: document.querySelector("#detail-coordinates"),
  detailDirection: document.querySelector("#detail-direction"),
  detailUpdated: document.querySelector("#detail-updated"),
  detailCapture: document.querySelector("#detail-capture"),
  detailNote: document.querySelector("#detail-note"),
  image: document.querySelector("#camera-image"),
  video: document.querySelector("#camera-video"),
  player: document.querySelector("#camera-player"),
  mediaLoading: document.querySelector("#media-loading"),
  showStill: document.querySelector("#show-still"),
  showStream: document.querySelector("#show-stream"),
  refreshCamera: document.querySelector("#refresh-camera"),
  providerLink: document.querySelector("#provider-link"),
  sourceLink: document.querySelector("#source-link"),
  windyAttribution: document.querySelector("#windy-attribution")
};

const WINDY_KEY_STORAGE = "worldwideCams.windyWebcamsAPIKey";

function storedWindyKey() {
  return String(localStorage.getItem(WINDY_KEY_STORAGE) || "").trim();
}

function setStoredWindyKey(value) {
  const key = String(value || "").trim();
  if (key) localStorage.setItem(WINDY_KEY_STORAGE, key);
  else localStorage.removeItem(WINDY_KEY_STORAGE);
  renderWindyKeyState();
}

function renderWindyKeyState() {
  const configured = Boolean(storedWindyKey());
  els.windyKeyInput.value = "";
  els.windyKeyInput.placeholder = configured
    ? "Windy key saved in this browser"
    : "Windy Webcams API key";
  els.windyKeySave.textContent = configured ? "Replace Windy Key" : "Save Windy Key";
  els.windyKeyClear.hidden = !configured;
}

function windyHeaders() {
  const key = storedWindyKey();
  return key ? { "X-Windy-API-Key": key } : {};
}

const cameras = new Map();
let providerStatus = null;
let selectedCamera = null;
let hls = null;
let windyAbort = null;
let windyRefreshSerial = 0;

const map = new maplibregl.Map({
  container: "map",
  center: [-18, 23],
  zoom: 1.35,
  minZoom: 0.7,
  maxZoom: 18,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors"
      }
    },
    layers: [
      {
        id: "osm",
        type: "raster",
        source: "osm",
        paint: {
          "raster-saturation": -0.56,
          "raster-brightness-min": 0.11,
          "raster-brightness-max": 0.62,
          "raster-contrast": 0.2
        }
      }
    ]
  }
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

function setMessage(text) {
  els.mapMessage.textContent = text || "";
  els.mapMessage.hidden = !text;
}

function formatTimestamp(value) {
  if (!value) return "Unknown / not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function cameraFeature(camera) {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [camera.longitude, camera.latitude]
    },
    properties: {
      id: camera.id,
      title: camera.title,
      provider: camera.provider,
      provider_kind: camera.provider_kind,
      availability: camera.availability || "unknown"
    }
  };
}

function updateCameraSource() {
  const source = map.getSource("cameras");
  if (!source) return;
  source.setData({
    type: "FeatureCollection",
    features: [...cameras.values()].map(cameraFeature)
  });
  els.cameraCount.textContent = `${cameras.size.toLocaleString()} loaded cameras`;
}

function updateWindyOverview(rows) {
  const source = map.getSource("windy-overview");
  if (!source) return;
  source.setData({
    type: "FeatureCollection",
    features: rows.map((camera) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [camera.longitude, camera.latitude]
      },
      properties: {
        id: camera.id,
        title: camera.title,
        count: Math.max(1, Number(camera.cluster_size || 1))
      }
    }))
  });
}

function clearWindyCameras() {
  for (const [id, camera] of cameras.entries()) {
    if (camera.provider_kind === "windy") cameras.delete(id);
  }
  updateWindyOverview([]);
  updateCameraSource();
  if (selectedCamera?.provider_kind === "windy") closeDetail();
}

function addCameras(rows) {
  for (const camera of rows || []) {
    if (!camera?.id || !Number.isFinite(camera.latitude) || !Number.isFinite(camera.longitude)) continue;
    const previous = cameras.get(camera.id);
    cameras.set(camera.id, {
      ...camera,
      availability: camera.availability || previous?.availability || "unknown",
      availability_probe: camera.availability_probe || previous?.availability_probe || null
    });
  }
  updateCameraSource();
}

function apiJson(url, signal) {
  return fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      ...windyHeaders()
    }
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  });
}

function apiPostJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...windyHeaders()
    },
    body: JSON.stringify(body)
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  });
}

function applyProbe(probe) {
  const camera = probe?.id ? cameras.get(probe.id) : null;
  if (!camera) return;
  camera.availability = probe.status || "unknown";
  camera.availability_probe = probe;
  cameras.set(camera.id, camera);
  updateCameraSource();

  if (selectedCamera?.id === camera.id) {
    selectedCamera = camera;
    renderAvailability(camera);
  }
}

function renderAvailability(camera) {
  const probe = camera?.availability_probe;
  const status = camera?.availability || "unknown";
  els.detailAvailability.className = "availability " + status;

  if (status === "working") {
    els.detailAvailability.textContent = "Working now";
    return;
  }
  if (status === "unavailable") {
    els.detailAvailability.textContent =
      probe?.reason === "provider_placeholder" ? "Unavailable placeholder" : "Unavailable now";
    return;
  }
  if (status === "checking") {
    els.detailAvailability.textContent = "Checking…";
    return;
  }
  els.detailAvailability.textContent = "Unverified";
}

function normalizedLng(value) {
  let lng = Number(value);
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return lng;
}

function viewBboxes() {
  const bounds = map.getBounds();
  const north = Math.min(89.9, bounds.getNorth());
  const south = Math.max(-89.9, bounds.getSouth());
  const span = bounds.getEast() - bounds.getWest();
  if (span >= 359) return [[north, 179.999, south, -179.999]];

  const west = normalizedLng(bounds.getWest());
  const east = normalizedLng(bounds.getEast());
  if (east > west) return [[north, east, south, west]];
  return [
    [north, 179.999, south, west],
    [north, east, south, -179.999]
  ].filter((box) => box[1] > box[3]);
}

function bboxParam(box) {
  return box.map((value) => Number(value).toFixed(5)).join(",");
}

async function loadStaticProviders() {
  const [statusResult, caltransResult, customResult] = await Promise.allSettled([
    apiJson("/api/status"),
    apiJson("/api/cameras/caltrans"),
    apiJson("/api/cameras/custom")
  ]);

  if (statusResult.status === "fulfilled") {
    providerStatus = statusResult.value;
    const windy = providerStatus.providers?.windy?.configured;
    els.providerStatus.textContent = windy
      ? "Caltrans + Windy enabled"
      : "Caltrans enabled · Windy key absent";
  } else {
    els.providerStatus.textContent = "Provider status unavailable";
  }

  if (caltransResult.status === "fulfilled") {
    addCameras(caltransResult.value.cameras);
    if (caltransResult.value.status === "partial") {
      setMessage(`Caltrans partially loaded: ${caltransResult.value.errors?.length || 0} district error(s).`);
    }
  } else {
    setMessage(`Caltrans unavailable: ${caltransResult.reason?.message || caltransResult.reason}`);
  }

  if (customResult.status === "fulfilled") {
    addCameras(customResult.value.cameras);
  }

  updateCoverageLabel();
}

function updateCoverageLabel(extra = "") {
  const windyConfigured = Boolean(providerStatus?.providers?.windy?.configured);
  const zoom = map.getZoom();
  let value;
  if (!windyConfigured) {
    value = "Worldwide Windy directory disabled";
  } else if (zoom < 4.5) {
    value = "Windy overview clusters · zoom in for exact dots";
  } else {
    value = "Windy exact records loaded for viewed areas";
  }
  els.coverageStatus.textContent = extra ? `${value} · ${extra}` : value;
}

async function loadWindyForView({ force = false } = {}) {
  if (!providerStatus?.providers?.windy?.configured) {
    updateWindyOverview([]);
    updateCoverageLabel();
    return;
  }

  if (windyAbort) windyAbort.abort();
  windyAbort = new AbortController();
  const signal = windyAbort.signal;
  const serial = ++windyRefreshSerial;
  const zoom = map.getZoom();
  const boxes = viewBboxes();

  els.refreshView.disabled = true;
  setMessage(zoom < 4.5 ? "Loading Windy globe coverage…" : "Loading exact Windy webcams in this view…");

  try {
    if (zoom < 4.5) {
      const providerZoom = Math.max(0, Math.min(4, Math.floor(zoom)));
      const results = await Promise.all(
        boxes.map((box) =>
          apiJson(
            `/api/cameras/windy/clusters?bbox=${encodeURIComponent(bboxParam(box))}&zoom=${providerZoom}`,
            signal
          )
        )
      );
      if (serial !== windyRefreshSerial) return;
      const rows = results.flatMap((item) => item.clusters || []);
      updateWindyOverview(rows);
      const represented = rows.reduce((sum, item) => sum + Math.max(1, Number(item.cluster_size || 1)), 0);
      updateCoverageLabel(`${represented.toLocaleString()} camera records represented by ${rows.length.toLocaleString()} provider markers`);
      setMessage("Windy overview markers are provider clusters at this scale. Zoom in until individual webcams resolve.");
    } else {
      updateWindyOverview([]);
      const results = await Promise.all(
        boxes.map((box) =>
          apiJson(
            `/api/cameras/windy?bbox=${encodeURIComponent(bboxParam(box))}&max=1000`,
            signal
          )
        )
      );
      if (serial !== windyRefreshSerial) return;
      const newRows = results.flatMap((item) => item.cameras || []);
      addCameras(newRows);
      const truncated = results.some((item) => item.truncated);
      updateCoverageLabel(
        `${newRows.length.toLocaleString()} exact Windy records in view${truncated ? " · provider result truncated" : ""}`
      );
      setMessage(
        truncated
          ? "This view contains more webcams than the current Windy listing budget returned. Zoom in for complete local detail."
          : "Exact Windy webcam records loaded for this view. Click any dot to inspect its provider evidence."
      );
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    updateWindyOverview([]);
    setMessage(
      `Windy map query unavailable here: ${error?.message || error}. Zoom in and refresh; Caltrans/custom cameras remain independent.`
    );
  } finally {
    if (serial === windyRefreshSerial) els.refreshView.disabled = false;
  }
}

function destroyMedia() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
  els.player.removeAttribute("src");
  els.image.removeAttribute("src");
  els.image.hidden = true;
  els.video.hidden = true;
  els.player.hidden = true;
  els.mediaLoading.hidden = false;
}

function mediaUnavailable(text) {
  destroyMedia();
  els.mediaLoading.textContent = text;
  els.mediaLoading.hidden = false;
}

function showStill() {
  if (!selectedCamera) return;
  destroyMedia();
  const url = selectedCamera.image_url;
  if (!url) {
    mediaUnavailable("This provider record does not expose a current still image.");
    return;
  }

  els.mediaLoading.textContent = "Loading current publisher image…";
  els.image.alt = `${selectedCamera.title} public camera image`;
  els.image.onload = () => {
    els.mediaLoading.hidden = true;
    els.image.hidden = false;
  };
  els.image.onerror = () => {
    mediaUnavailable("The publisher image could not be loaded. Refresh the camera record or open the provider page.");
  };
  els.image.src = url;
}

function showStream() {
  if (!selectedCamera) return;
  destroyMedia();

  if (selectedCamera.player_url) {
    els.mediaLoading.hidden = true;
    els.player.hidden = false;
    els.player.src = selectedCamera.player_url;
    return;
  }

  const url = selectedCamera.stream_url;
  if (!url) {
    mediaUnavailable("No browser-viewable live/player URL is published for this camera. The current still remains available when supplied.");
    return;
  }

  els.mediaLoading.textContent = "Opening publisher stream…";
  els.video.hidden = false;
  els.mediaLoading.hidden = true;

  if (/\.m3u8(?:$|\?)/i.test(url) && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 20
    });
    hls.loadSource(url);
    hls.attachMedia(els.video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      els.video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) mediaUnavailable("The published HLS stream could not be rendered in this browser. Use the provider link instead.");
    });
    return;
  }

  els.video.src = url;
  els.video.play().catch(() => {});
}

function setExternalLink(element, url, fallbackText) {
  if (url) {
    element.href = url;
    element.textContent = fallbackText;
    element.hidden = false;
  } else {
    element.removeAttribute("href");
    element.hidden = true;
  }
}

function selectCamera(camera, { fly = false } = {}) {
  if (!camera) return;
  selectedCamera = camera;
  els.emptyPanel.hidden = true;
  els.detail.hidden = false;

  els.detailProvider.textContent = camera.provider || "Public camera";
  renderAvailability(camera);
  els.detailTitle.textContent = camera.title || camera.id;
  els.detailPlace.textContent = camera.nearby_place || "Provider-reported camera point";
  els.detailId.textContent = camera.id;
  els.detailCoordinates.textContent = `${camera.latitude.toFixed(5)}, ${camera.longitude.toFixed(5)}`;
  els.detailDirection.textContent = camera.direction || "Not provided";
  els.detailUpdated.textContent = formatTimestamp(camera.updated_at);
  els.detailCapture.textContent = camera.capture_time
    ? formatTimestamp(camera.capture_time)
    : "Unknown / not verified";
  els.detailNote.textContent = camera.source_note || "Provider camera record. Verify freshness at the publisher.";
  els.windyAttribution.hidden = camera.provider_kind !== "windy";

  const providerUrl = camera.provider_detail_url || camera.source_url || camera.image_url || camera.stream_url;
  setExternalLink(els.providerLink, providerUrl, camera.provider_kind === "windy" ? "Open Windy webcam page" : "Open provider page");
  setExternalLink(
    els.sourceLink,
    camera.source_url && camera.source_url !== providerUrl ? camera.source_url : "",
    "Provider documentation"
  );

  els.showStill.disabled = !camera.image_url;
  els.showStream.disabled = !(camera.stream_url || camera.player_url);
  showStill();
  probeSelectedCamera();

  if (fly) {
    map.flyTo({
      center: [camera.longitude, camera.latitude],
      zoom: Math.max(map.getZoom(), 8),
      duration: 900
    });
  }
}

async function refreshSelectedCamera() {
  if (!selectedCamera) return;
  els.refreshCamera.disabled = true;
  const oldText = els.refreshCamera.textContent;
  els.refreshCamera.textContent = "Refreshing…";
  try {
    const payload = await apiJson(`/api/camera/${encodeURIComponent(selectedCamera.id)}`);
    const camera = payload.camera;
    cameras.set(camera.id, camera);
    updateCameraSource();
    selectCamera(camera);
  } catch (error) {
    setMessage(`Camera refresh failed: ${error?.message || error}`);
  } finally {
    els.refreshCamera.disabled = false;
    els.refreshCamera.textContent = oldText;
  }
}

function closeDetail() {
  selectedCamera = null;
  destroyMedia();
  els.detail.hidden = true;
  els.emptyPanel.hidden = false;
}

async function probeSelectedCamera({ force = false } = {}) {
  if (!selectedCamera) return;
  const id = selectedCamera.id;
  selectedCamera.availability = "checking";
  cameras.set(id, selectedCamera);
  renderAvailability(selectedCamera);
  updateCameraSource();

  try {
    const payload = await apiJson(
      `/api/camera/${encodeURIComponent(id)}/probe${force ? "?force=1" : ""}`
    );
    applyProbe(payload.probe);
  } catch (error) {
    const camera = cameras.get(id);
    if (camera) {
      camera.availability = "unknown";
      camera.availability_probe = {
        id,
        status: "unknown",
        reason: "probe_request_failed",
        error: error?.message || String(error)
      };
      cameras.set(id, camera);
      if (selectedCamera?.id === id) {
        selectedCamera = camera;
        renderAvailability(camera);
      }
      updateCameraSource();
    }
  }
}

function withinBounds(camera, bounds) {
  const lat = camera.latitude;
  const lng = camera.longitude;
  if (lat < bounds.getSouth() || lat > bounds.getNorth()) return false;
  const west = normalizedLng(bounds.getWest());
  const east = normalizedLng(bounds.getEast());
  const value = normalizedLng(lng);
  return east >= west ? value >= west && value <= east : value >= west || value <= east;
}

async function probeVisibleCaltrans() {
  if (map.getZoom() < 5.5) return;

  const bounds = map.getBounds();
  const center = map.getCenter();
  const candidates = [...cameras.values()]
    .filter((camera) =>
      camera.provider_kind === "caltrans" &&
      (camera.availability || "unknown") === "unknown" &&
      withinBounds(camera, bounds)
    )
    .sort((a, b) => {
      const da = Math.hypot(a.latitude - center.lat, normalizedLng(a.longitude - center.lng));
      const db = Math.hypot(b.latitude - center.lat, normalizedLng(b.longitude - center.lng));
      return da - db;
    })
    .slice(0, 40);

  if (!candidates.length) return;

  for (const camera of candidates) {
    camera.availability = "checking";
    cameras.set(camera.id, camera);
  }
  updateCameraSource();

  try {
    const payload = await apiPostJson("/api/cameras/probe", {
      ids: candidates.map((camera) => camera.id)
    });
    for (const probe of payload.probes || []) applyProbe(probe);
  } catch {
    for (const camera of candidates) {
      const current = cameras.get(camera.id);
      if (current && current.availability === "checking") {
        current.availability = "unknown";
        cameras.set(current.id, current);
      }
    }
    updateCameraSource();
  }
}

function findLoadedCamera(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return null;
  const exact = cameras.get(needle);
  if (exact) return exact;
  return [...cameras.values()].find((camera) =>
    camera.id.toLowerCase() === needle ||
    camera.title.toLowerCase().includes(needle) ||
    String(camera.nearby_place || "").toLowerCase().includes(needle)
  ) || null;
}

map.on("load", async () => {
  try {
    map.setProjection({ type: "globe" });
  } catch {
    // Older MapLibre builds still render the map; the app remains usable.
  }

  map.addSource("cameras", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });

  map.addLayer({
    id: "camera-halo",
    type: "circle",
    source: "cameras",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3.2, 6, 5.2, 12, 7.2],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 3,
      "circle-stroke-color": "rgba(4, 15, 22, .72)"
    }
  });

  map.addLayer({
    id: "camera-dots",
    type: "circle",
    source: "cameras",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.2, 6, 4.0, 12, 5.5],
      "circle-color": [
        "case",
        ["==", ["get", "availability"], "unavailable"], "#59656e",
        ["==", ["get", "availability"], "checking"], "#c8b36b",
        [
          "match",
          ["get", "provider_kind"],
          "caltrans", "#59f0bf",
          "windy", "#62d5ff",
          "custom", "#ffca66",
          "#c6d4dc"
        ]
      ],
      "circle-opacity": [
        "match",
        ["get", "availability"],
        "unavailable", 0.38,
        "checking", 0.72,
        "working", 1.0,
        0.72
      ]
    }
  });

  map.addSource("windy-overview", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });

  map.addLayer({
    id: "windy-overview-circles",
    type: "circle",
    source: "windy-overview",
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["sqrt", ["get", "count"]],
        1, 4,
        5, 7,
        20, 11,
        100, 17
      ],
      "circle-color": "#8a6de9",
      "circle-opacity": 0.62,
      "circle-stroke-color": "#d7ccff",
      "circle-stroke-width": 1
    }
  });

  map.addLayer({
    id: "windy-overview-count",
    type: "symbol",
    source: "windy-overview",
    minzoom: 1.5,
    layout: {
      "text-field": ["case", [">", ["get", "count"], 1], ["to-string", ["get", "count"]], ""],
      "text-size": 10
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#211747",
      "text-halo-width": 1
    }
  });

  map.on("click", "camera-dots", (event) => {
    const id = event.features?.[0]?.properties?.id;
    const camera = id ? cameras.get(id) : null;
    if (camera) selectCamera(camera);
  });

  map.on("click", "windy-overview-circles", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const count = Number(feature.properties?.count || 1);
    const id = feature.properties?.id;
    if (count <= 1 && id) {
      const existing = cameras.get(id);
      if (existing) {
        selectCamera(existing);
        return;
      }
      apiJson(`/api/camera/${encodeURIComponent(id)}`)
        .then((payload) => {
          addCameras([payload.camera]);
          selectCamera(payload.camera);
        })
        .catch((error) => setMessage(`Could not open this Windy camera: ${error.message}`));
      return;
    }
    const [lng, lat] = feature.geometry.coordinates;
    map.easeTo({
      center: [lng, lat],
      zoom: Math.min(8, Math.max(map.getZoom() + 2.2, 4.8)),
      duration: 700
    });
  });

  for (const layer of ["camera-dots", "windy-overview-circles"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  await loadStaticProviders();
  await loadWindyForView({ force: true });
  await probeVisibleCaltrans();
});

let moveTimer = null;
map.on("moveend", () => {
  updateCoverageLabel();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(async () => {
    await loadWindyForView();
    await probeVisibleCaltrans();
  }, 250);
});

els.windyKeySave.addEventListener("click", async () => {
  const key = els.windyKeyInput.value.trim();
  if (!key) {
    setMessage("Paste a Windy Webcams API key first.");
    return;
  }
  setStoredWindyKey(key);
  providerStatus = null;
  clearWindyCameras();
  setMessage("Windy key saved in this browser. Testing worldwide camera access…");
  await loadStaticProviders();
  await loadWindyForView({ force: true });
});

els.windyKeyClear.addEventListener("click", async () => {
  setStoredWindyKey("");
  providerStatus = null;
  clearWindyCameras();
  setMessage("Browser Windy key cleared. Caltrans and custom public sources remain available.");
  await loadStaticProviders();
});

els.windyKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.windyKeySave.click();
  }
});

renderWindyKeyState();

els.resetView.addEventListener("click", () => {
  map.flyTo({ center: [-18, 23], zoom: 1.35, bearing: 0, pitch: 0, duration: 900 });
});

els.refreshView.addEventListener("click", () => {
  loadWindyForView({ force: true });
});

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const camera = findLoadedCamera(els.searchInput.value);
  if (!camera) {
    setMessage("No matching camera is loaded yet. Zoom into the relevant area to load Windy exact records, then search again.");
    return;
  }
  selectCamera(camera, { fly: true });
});

els.closeDetail.addEventListener("click", closeDetail);
els.showStill.addEventListener("click", showStill);
els.showStream.addEventListener("click", showStream);
els.refreshCamera.addEventListener("click", async () => {
  await refreshSelectedCamera();
  await probeSelectedCamera({ force: true });
});

els.image.addEventListener("click", () => {
  if (!selectedCamera || selectedCamera.provider_kind !== "windy") return;
  const url = selectedCamera.provider_detail_url;
  if (url) window.open(url, "_blank", "noopener,noreferrer");
});
els.image.style.cursor = "pointer";

window.addEventListener("beforeunload", () => {
  if (windyAbort) windyAbort.abort();
  destroyMedia();
});
