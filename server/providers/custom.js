function cleanUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function customCamerasFromEnv(raw = process.env.WORLDWIDE_CAMS_CUSTOM_JSON || "") {
  if (!String(raw).trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WORLDWIDE_CAMS_CUSTOM_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("WORLDWIDE_CAMS_CUSTOM_JSON must be a JSON array");

  const seen = new Set();
  const cameras = [];
  for (const item of parsed.slice(0, 5000)) {
    if (!item || typeof item !== "object") continue;
    const idPart = String(item.id || "").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
    if (!idPart) continue;
    const id = `custom-${idPart}`;
    if (seen.has(id)) continue;

    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;

    const imageUrl = cleanUrl(item.image_url);
    const streamUrl = cleanUrl(item.stream_url);
    const sourceUrl = cleanUrl(item.source_url);
    if (!imageUrl && !streamUrl) continue;

    seen.add(id);
    cameras.push({
      id,
      provider: "Custom public source",
      provider_kind: "custom",
      title: String(item.title || "Public camera").slice(0, 150),
      nearby_place: String(item.nearby_place || "").slice(0, 160),
      latitude,
      longitude,
      direction: String(item.direction || "").slice(0, 32),
      image_url: imageUrl,
      stream_url: streamUrl,
      player_url: "",
      provider_detail_url: sourceUrl,
      source_url: sourceUrl,
      source_note: "Operator-supplied public camera source. Geography and media availability are operator assertions, not independently verified by Worldwide Cams.",
      in_service_reported: null,
      updated_at: null,
      capture_time: null,
      cluster_size: 1
    });
  }
  return cameras;
}
