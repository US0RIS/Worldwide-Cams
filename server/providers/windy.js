const API = "https://api.windy.com/webcams/api/v3";
const MAX_BYTES = 2_500_000;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function resolvedKey(requestKey = "") {
  const direct = String(requestKey || "").trim();
  if (direct) return direct;
  return String(process.env.JARVIS_WINDY_WEBCAMS_API_KEY || "").trim();
}

export function windyConfigured(requestKey = "") {
  return Boolean(resolvedKey(requestKey));
}

async function fetchJsonBounded(url, fetchImpl = fetch, requestKey = "") {
  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const response = await fetchImpl(url, {
    headers: {
      "X-Windy-API-Key": resolvedKey(requestKey),
      Accept: "application/json"
    },
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Windy HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error("Windy response exceeded byte budget");
  const value = JSON.parse(new TextDecoder().decode(body));
  cache.set(cacheKey, { at: now, value });
  return value;
}

function httpsUrl(raw) {
  if (typeof raw !== "string" || !raw.startsWith("https://")) return "";
  try {
    const url = new URL(raw);
    return url.username || url.password ? "" : url.toString();
  } catch {
    return "";
  }
}

function windyDetailUrl(raw) {
  const urls = raw?.urls || raw?.url || {};
  const candidates = [
    urls.detail,
    urls.current?.desktop,
    urls.current?.mobile
  ];
  const candidate = candidates.map(httpsUrl).find((value) => value.includes("windy.com/webcams/"));
  return candidate || "https://www.windy.com/webcams";
}

export function normalizeWindy(raw) {
  if (!raw || typeof raw !== "object" || raw.status !== "active") return null;

  const id = Number(raw.webcamId);
  const latitude = Number(raw.location?.latitude);
  const longitude = Number(raw.location?.longitude);
  if (!Number.isSafeInteger(id) || id < 1 ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }

  const current = raw.images?.current || {};
  const imageUrl = ["preview", "icon", "thumbnail", "small", "medium", "large", "full"]
    .map((name) => httpsUrl(current[name]))
    .find(Boolean) || "";

  const live = raw.player?.live || {};
  const playerUrl = live.available ? httpsUrl(live.embed) : "";

  return {
    id: `windy-${id}`,
    provider: "Windy Webcams v3",
    provider_kind: "windy",
    title: String(raw.title || "Public webcam").slice(0, 150),
    nearby_place: [
      raw.location?.city,
      raw.location?.region,
      raw.location?.country
    ].filter(Boolean).join(", ").slice(0, 160),
    latitude,
    longitude,
    direction: "",
    image_url: imageUrl,
    stream_url: "",
    player_url: playerUrl,
    provider_detail_url: windyDetailUrl(raw),
    source_url: "https://api.windy.com/webcams/docs",
    source_note: "Windy provider-reported webcam location/current preview. Image URLs are short-lived; capture time, continuity and viewing footprint are not asserted.",
    in_service_reported: true,
    updated_at: typeof raw.lastUpdatedOn === "string" ? raw.lastUpdatedOn : null,
    capture_time: null,
    cluster_size: Math.max(1, Number(raw.clusterSize || raw.map?.clustersize || 1) || 1)
  };
}

function validateBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("bbox requires north,east,south,west");
  const values = bbox.map(Number);
  if (!values.every(Number.isFinite)) throw new Error("bbox must be finite");
  const [north, east, south, west] = values;
  if (north > 90 || north < -90 || south > 90 || south < -90 || north <= south ||
      east > 180 || east < -180 || west > 180 || west < -180 || east <= west) {
    throw new Error("Invalid non-wrapping bbox");
  }
  return values;
}

export async function listWindyByBbox(
  bbox,
  { max = 500, fetchImpl = fetch, apiKey = "" } = {}
) {
  if (!windyConfigured(apiKey)) {
    return {
      status: "not_configured",
      provider: "Windy Webcams v3",
      cameras: [],
      total: null,
      truncated: false
    };
  }

  const [north, east, south, west] = validateBbox(bbox);
  const boundedMax = Math.max(1, Math.min(1000, Number(max) || 500));
  const cameras = [];
  let total = null;
  let offset = 0;

  while (cameras.length < boundedMax && offset <= 1000) {
    const url = new URL(`${API}/webcams`);
    url.searchParams.set("bbox", `${north},${east},${south},${west}`);
    url.searchParams.set("include", "images,location,urls,player");
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sortKey", "popularity");
    url.searchParams.set("sortDirection", "desc");

    const payload = await fetchJsonBounded(url, fetchImpl, apiKey);
    const rows = Array.isArray(payload?.webcams) ? payload.webcams : [];
    if (Number.isInteger(payload?.total)) total = payload.total;
    for (const row of rows) {
      const normalized = normalizeWindy(row);
      if (normalized) cameras.push(normalized);
      if (cameras.length >= boundedMax) break;
    }
    if (rows.length < 50 || (total !== null && offset + rows.length >= total)) break;
    offset += 50;
  }

  return {
    status: "ok",
    provider: "Windy Webcams v3",
    cameras,
    total,
    truncated: total !== null ? total > cameras.length : cameras.length >= boundedMax,
    max_returned: boundedMax,
    source_url: "https://api.windy.com/webcams/docs",
    attribution: "Webcams provided by Windy.com",
    checked_at: new Date().toISOString()
  };
}

export async function listWindyClusters(
  bounds,
  zoom,
  { fetchImpl = fetch, apiKey = "" } = {}
) {
  if (!windyConfigured(apiKey)) {
    return {
      status: "not_configured",
      provider: "Windy Webcams v3",
      clusters: []
    };
  }
  const [north, east, south, west] = validateBbox(bounds);
  const z = Math.max(0, Math.min(4, Math.round(Number(zoom) || 0)));
  const url = new URL(`${API}/map/clusters`);
  url.searchParams.set("northLat", String(north));
  url.searchParams.set("eastLon", String(east));
  url.searchParams.set("southLat", String(south));
  url.searchParams.set("westLon", String(west));
  url.searchParams.set("zoom", String(z));
  url.searchParams.set("include", "images,location,urls,player");

  const payload = await fetchJsonBounded(url, fetchImpl, apiKey);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.webcams) ? payload.webcams : [];
  return {
    status: "ok",
    provider: "Windy Webcams v3",
    clusters: rows.map(normalizeWindy).filter(Boolean),
    source_url: "https://api.windy.com/webcams/docs",
    attribution: "Webcams provided by Windy.com",
    checked_at: new Date().toISOString()
  };
}

export async function getWindyCamera(id, { fetchImpl = fetch, apiKey = "" } = {}) {
  const match = /^windy-([1-9][0-9]{0,19})$/.exec(String(id || ""));
  if (!match) throw new Error("Invalid Windy camera ID");
  if (!windyConfigured(apiKey)) throw new Error("Windy Webcams API key is not configured");

  const url = new URL(`${API}/webcams/${match[1]}`);
  url.searchParams.set("include", "images,location,urls,player");
  const payload = await fetchJsonBounded(url, fetchImpl, apiKey);
  const normalized = normalizeWindy(payload);
  if (!normalized || normalized.id !== id) throw new Error("Windy camera unavailable");
  return normalized;
}

export function clearWindyCache() {
  cache.clear();
}
