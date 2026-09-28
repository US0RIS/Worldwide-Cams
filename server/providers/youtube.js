const API = "https://www.googleapis.com/youtube/v3";
const MAX_BYTES = 3_000_000;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

const QUERY_FAMILIES = [
  "live webcam",
  "live cam",
  "live camera",
  "street live",
  "traffic live",
  "beach live cam",
  "harbor live cam",
  "marina live cam",
  "airport live cam",
  "ski live cam",
  "mountain live cam",
  "wildlife live cam",
  "volcano live cam",
  "weather live cam",
  "town square live",
  "downtown live",
  "pier live",
  "boardwalk live",
  "skyline live"
];

function resolvedKey(requestKey = "") {
  const direct = String(requestKey || "").trim();
  if (direct) return direct;
  return String(process.env.WORLDWIDE_CAMS_YOUTUBE_API_KEY || "").trim();
}

export function youtubeConfigured(requestKey = "") {
  return Boolean(resolvedKey(requestKey));
}

export function youtubeDerivedMetricsApproved() {
  return /^(1|true|yes)$/i.test(
    String(process.env.WORLDWIDE_CAMS_YOUTUBE_DERIVED_METRICS_APPROVED || "").trim()
  );
}

export function youtubeQueryFamilies() {
  return [...QUERY_FAMILIES];
}

async function fetchJson(url, { apiKey = "", fetchImpl = fetch, cacheMs = CACHE_TTL_MS } = {}) {
  const key = resolvedKey(apiKey);
  if (!key) throw new Error("YouTube Data API key is not configured");

  const target = new URL(url);
  target.searchParams.set("key", key);

  // Never put the credential into a cache key or response.
  const cacheKey = target.origin + target.pathname + "?" +
    [...target.searchParams.entries()]
      .filter(([name]) => name !== "key")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => encodeURIComponent(name) + "=" + encodeURIComponent(value))
      .join("&");

  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < cacheMs) return cached.value;

  const response = await fetchImpl(target, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Worldwide-Cams/0.2 YouTube-public-live-discovery"
    },
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });

  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error("YouTube response exceeded byte budget");
  let payload = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("YouTube returned invalid JSON");
  }

  if (!response.ok) {
    const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.message || "unknown_error";
    const error = new Error("YouTube HTTP " + response.status + ": " + reason);
    error.status = response.status;
    error.reason = reason;
    throw error;
  }

  cache.set(cacheKey, { at: now, value: payload });
  return payload;
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function bestThumbnail(snippet) {
  const thumbnails = snippet?.thumbnails || {};
  for (const name of ["uhd", "qhd", "fhd", "maxres", "standard", "high", "medium", "default"]) {
    const value = String(thumbnails?.[name]?.url || "");
    if (value.startsWith("https://")) return value;
  }
  return "";
}

function explicitLocation(video) {
  const raw = video?.recordingDetails?.location;
  const latitude = finiteCoordinate(raw?.latitude, -90, 90);
  const longitude = finiteCoordinate(raw?.longitude, -180, 180);
  if (latitude === null || longitude === null) return null;
  return {
    latitude,
    longitude,
    location_name: String(video?.recordingDetails?.locationDescription || "").slice(0, 180),
    location_precision: "exact",
    geolocation_method: "youtube_recording_details",
    geolocation_confidence: 0.98
  };
}

function searchAreaLocation(searchContext) {
  const latitude = finiteCoordinate(searchContext?.latitude, -90, 90);
  const longitude = finiteCoordinate(searchContext?.longitude, -180, 180);
  const radiusKm = Number(searchContext?.radius_km);
  if (latitude === null || longitude === null || !Number.isFinite(radiusKm)) return null;

  // search.list location filtering only returns videos associated with a location
  // inside the requested radius. The exact point is not exposed, so the search
  // center is explicitly approximate and never represented as an exact camera point.
  const confidence = radiusKm <= 10 ? 0.72 : radiusKm <= 50 ? 0.62 : radiusKm <= 150 ? 0.52 : 0.42;
  return {
    latitude,
    longitude,
    location_name: String(searchContext?.location_name || "YouTube location-filter area").slice(0, 180),
    location_precision: radiusKm <= 25 ? "city" : "regional",
    geolocation_method: "youtube_location_filter_center",
    geolocation_confidence: confidence,
    location_radius_km: radiusKm
  };
}

export function normalizeYouTubeCandidate(video, searchContext = {}) {
  if (!video || typeof video !== "object") return null;
  const id = String(video.id || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;

  const snippet = video.snippet || {};
  const status = video.status || {};
  const live = video.liveStreamingDetails || {};
  const currentlyLive =
    snippet.liveBroadcastContent === "live" &&
    Boolean(live.actualStartTime) &&
    !live.actualEndTime;

  if (!currentlyLive || status.privacyStatus !== "public") return null;

  const location = explicitLocation(video) || searchAreaLocation(searchContext);
  if (!location) return null;

  const embeddable = status.embeddable === true;
  const thumbnail = bestThumbnail(snippet);
  const now = new Date().toISOString();

  return {
    id: "youtube-" + id,
    provider: "YouTube Live",
    provider_kind: "youtube",
    provider_camera_id: id,
    title: String(snippet.title || "YouTube Live broadcast").slice(0, 200),
    description: String(snippet.description || "").slice(0, 5000),
    channel_id: String(snippet.channelId || ""),
    channel_title: String(snippet.channelTitle || "").slice(0, 180),
    youtube_category_id: String(snippet.categoryId || ""),
    latitude: location.latitude,
    longitude: location.longitude,
    nearby_place: location.location_name,
    location_name: location.location_name,
    location_precision: location.location_precision,
    geolocation_method: location.geolocation_method,
    geolocation_confidence: location.geolocation_confidence,
    location_radius_km: location.location_radius_km ?? null,
    image_url: thumbnail,
    stream_url: "",
    player_url: embeddable ? "https://www.youtube.com/embed/" + id + "?playsinline=1" : "",
    provider_detail_url: "https://www.youtube.com/watch?v=" + id,
    source_url: "https://developers.google.com/youtube/v3/docs",
    source_note:
      "YouTube Data API currently-live public broadcast. Production webcam status is not asserted until visual/temporal verification is complete.",
    in_service_reported: true,
    updated_at: now,
    capture_time: null,
    cluster_size: 1,
    camera_type: "unverified_candidate",
    scene_type: "unverified",
    candidate_state: "REVIEW",
    production_eligible: false,
    playback: embeddable ? "youtube_embed" : "youtube_watch",
    embeddable,
    currently_live: true,
    actual_start_time: live.actualStartTime || null,
    discovered_at: now,
    last_checked: now,
    metadata_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
    verification: {
      live_status: "PASS",
      playback: embeddable ? "PASS" : "WATCH_PAGE_ONLY",
      metadata: "UNASSESSED",
      geolocation: location.geolocation_confidence >= 0.6 ? "PASS" : "REVIEW",
      visual: "REQUIRED",
      temporal: "REQUIRED",
      decision: "REVIEW"
    }
  };
}

export async function getYouTubeVideos(ids, { apiKey = "", fetchImpl = fetch } = {}) {
  const unique = [...new Set((ids || []).map((value) => String(value || "").trim()))]
    .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id))
    .slice(0, 50);
  if (!unique.length) return [];

  const url = new URL(API + "/videos");
  url.searchParams.set("part", "snippet,status,liveStreamingDetails,recordingDetails,contentDetails");
  url.searchParams.set("id", unique.join(","));
  const payload = await fetchJson(url, { apiKey, fetchImpl, cacheMs: 30_000 });
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function discoverYouTubeLive({
  query = "live webcam",
  latitude,
  longitude,
  radiusKm = 100,
  maxResults = 25,
  apiKey = "",
  fetchImpl = fetch,
  locationName = ""
} = {}) {
  if (!youtubeConfigured(apiKey)) {
    return {
      status: "not_configured",
      provider: "YouTube Live",
      candidates: [],
      query_count: 0
    };
  }

  const lat = finiteCoordinate(latitude, -90, 90);
  const lon = finiteCoordinate(longitude, -180, 180);
  if (lat === null || lon === null) throw new Error("latitude/longitude are required for defensible discovery");
  const radius = Math.max(1, Math.min(1000, Number(radiusKm) || 100));
  const boundedMax = Math.max(1, Math.min(50, Math.floor(Number(maxResults) || 25)));
  const q = String(query || "live webcam").trim().slice(0, 120);

  const searchUrl = new URL(API + "/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("eventType", "live");
  searchUrl.searchParams.set("videoEmbeddable", "true");
  searchUrl.searchParams.set("videoSyndicated", "true");
  searchUrl.searchParams.set("safeSearch", "strict");
  searchUrl.searchParams.set("maxResults", String(boundedMax));
  searchUrl.searchParams.set("q", q);
  searchUrl.searchParams.set("location", lat + "," + lon);
  searchUrl.searchParams.set("locationRadius", radius + "km");

  const searchPayload = await fetchJson(searchUrl, { apiKey, fetchImpl, cacheMs: 30_000 });
  const ids = (searchPayload?.items || [])
    .map((item) => item?.id?.videoId)
    .filter(Boolean);

  const videos = await getYouTubeVideos(ids, { apiKey, fetchImpl });
  const context = {
    latitude: lat,
    longitude: lon,
    radius_km: radius,
    location_name: locationName
  };
  const candidates = videos
    .map((video) => normalizeYouTubeCandidate(video, context))
    .filter(Boolean);

  return {
    status: "ok",
    provider: "YouTube Live",
    candidates,
    discovered: candidates.length,
    query: q,
    query_count: 1,
    search_calls: 1,
    video_detail_calls: ids.length ? 1 : 0,
    checked_at: new Date().toISOString(),
    production_admitted: 0,
    note:
      "Discovery uses official YouTube Data API live + embeddable + syndicated + geographic filters. Candidates remain REVIEW until visual and temporal verification."
  };
}

export async function refreshYouTubeCandidate(candidate, { apiKey = "", fetchImpl = fetch } = {}) {
  const id = String(candidate?.provider_camera_id || "").trim();
  const videos = await getYouTubeVideos([id], { apiKey, fetchImpl });
  const video = videos[0];
  if (!video) {
    return {
      ...candidate,
      currently_live: false,
      candidate_state: "REVIEW",
      production_eligible: false,
      last_checked: new Date().toISOString(),
      failure_reason: "REMOVED_OR_UNAVAILABLE"
    };
  }

  const refreshed = normalizeYouTubeCandidate(video, {
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    radius_km: candidate.location_radius_km || 1,
    location_name: candidate.location_name
  });
  if (!refreshed) {
    return {
      ...candidate,
      currently_live: false,
      candidate_state: "REVIEW",
      production_eligible: false,
      last_checked: new Date().toISOString(),
      failure_reason: "NOT_LIVE_OR_NOT_PUBLIC"
    };
  }

  return {
    ...candidate,
    ...refreshed,
    discovered_at: candidate.discovered_at || refreshed.discovered_at,
    verification: {
      ...(candidate.verification || {}),
      ...refreshed.verification,
      visual: candidate.verification?.visual || "REQUIRED",
      temporal: candidate.verification?.temporal || "REQUIRED",
      decision: candidate.verification?.decision || "REVIEW"
    }
  };
}

export function clearYouTubeCache() {
  cache.clear();
}
