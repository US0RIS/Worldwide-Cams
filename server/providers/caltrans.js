const CATALOG_URL = "https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_BYTES = 5_000_000;
const ALLOWED_MEDIA_HOSTS = new Set(["cwwp2.dot.ca.gov", "wzmedia.dot.ca.gov"]);

const cache = new Map();

export function caltransSourceUrl(district) {
  if (!Number.isInteger(district) || district < 1 || district > 12) {
    throw new Error("Unknown Caltrans district");
  }
  return `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, "0")}.json`;
}

export function safeCaltransMediaUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 1500) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || !ALLOWED_MEDIA_HOSTS.has(parsed.hostname.toLowerCase())) {
    return "";
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return "";
  return parsed.toString();
}

export function parseCaltrans(payload, district) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("Unexpected Caltrans CCTV catalog structure");
  }

  const cameras = [];
  for (const wrapper of payload.data) {
    const record = wrapper?.cctv;
    if (!record || typeof record !== "object") continue;
    if (String(record.inService ?? "").toLowerCase() !== "true") continue;

    const location = record.location;
    const imageData = record.imageData;
    if (!location || typeof location !== "object" || !imageData || typeof imageData !== "object") continue;

    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;

    const imageUrl = safeCaltransMediaUrl(imageData.static?.currentImageURL);
    const streamUrl = safeCaltransMediaUrl(imageData.streamingVideoURL);
    if (!imageUrl && !streamUrl) continue;

    cameras.push({
      id: `caltrans-d${district}-${String(record.index ?? "").slice(0, 30)}`,
      provider: "Caltrans CWWP2",
      provider_kind: "caltrans",
      title: String(location.locationName || "Traffic camera").slice(0, 140),
      nearby_place: String(location.nearbyPlace || "").slice(0, 90),
      latitude,
      longitude,
      direction: String(location.direction || "").slice(0, 32),
      image_url: imageUrl,
      stream_url: streamUrl,
      player_url: "",
      provider_detail_url: "",
      source_url: CATALOG_URL,
      source_note: "Official Caltrans catalog record. Published service state/media availability does not prove image capture time or field of view.",
      in_service_reported: true,
      updated_at: null,
      capture_time: null,
      cluster_size: 1
    });
  }
  return cameras;
}

async function fetchJsonBounded(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Caltrans HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error("Caltrans response exceeded byte budget");
  return JSON.parse(new TextDecoder().decode(body));
}

export async function getCaltransDistrict(district, { fetchImpl = fetch } = {}) {
  const existing = cache.get(district);
  const now = Date.now();
  if (existing && now - existing.at < CACHE_TTL_MS) return existing;

  try {
    const payload = await fetchJsonBounded(caltransSourceUrl(district), fetchImpl);
    const value = {
      cameras: parseCaltrans(payload, district),
      at: now,
      fetched_at: new Date(now).toISOString(),
      stale: false,
      error: null
    };
    cache.set(district, value);
    return value;
  } catch (error) {
    if (existing) return { ...existing, stale: true, error: error?.message || String(error) };
    return {
      cameras: [],
      at: now,
      fetched_at: null,
      stale: false,
      error: error?.message || String(error)
    };
  }
}

export async function getAllCaltrans({ fetchImpl = fetch } = {}) {
  const rows = await Promise.all(
    Array.from({ length: 12 }, (_, index) => getCaltransDistrict(index + 1, { fetchImpl }))
  );
  const cameras = rows.flatMap((row) => row.cameras);
  const errors = rows
    .map((row, index) => row.error ? `D${index + 1}: ${row.error}` : null)
    .filter(Boolean);
  return {
    status: errors.length ? (cameras.length ? "partial" : "unavailable") : "ok",
    provider: "Caltrans CWWP2",
    coverage: "California state highway camera catalog",
    source_url: CATALOG_URL,
    checked_at: new Date().toISOString(),
    camera_count: cameras.length,
    cameras,
    errors
  };
}

export function clearCaltransCache() {
  cache.clear();
}
