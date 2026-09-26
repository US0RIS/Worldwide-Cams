import { createHash } from "node:crypto";
import sharp from "sharp";

const MAX_BYTES = 4_000_000;
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map();

function cacheKey(camera) {
  return camera?.id + "|" + (camera?.image_url || "");
}

function classifyPixels(raw, width, height) {
  const total = width * height;
  let white = 0;
  let deepBlue = 0;
  let nearBlack = 0;
  let sum = 0;

  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    sum += (r + g + b) / 3;

    if (r > 235 && g > 235 && b > 235) white += 1;
    if (b > 90 && b > r * 1.35 && b > g * 1.15 && r < 160) deepBlue += 1;
    if (r < 45 && g < 45 && b < 45) nearBlack += 1;
  }

  return {
    white_fraction: white / total,
    deep_blue_fraction: deepBlue / total,
    near_black_fraction: nearBlack / total,
    mean_brightness: sum / total
  };
}

export async function classifyCameraImage(buffer) {
  const image = sharp(buffer, { failOn: "error", limitInputPixels: 20_000_000 });
  const metadata = await image.metadata();
  const decoded = await image
    .resize(96, 60, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();

  const metrics = classifyPixels(decoded, 96, 60);

  // Caltrans' "Temporarily Unavailable" frame is overwhelmingly white with
  // large dark-blue lettering. Keep the threshold conservative to avoid
  // confusing snow/bright-sky roadway scenes with the provider placeholder.
  const placeholderLikely =
    metrics.white_fraction >= 0.72 &&
    metrics.deep_blue_fraction >= 0.02 &&
    metrics.mean_brightness >= 215;

  return {
    placeholder_likely: placeholderLikely,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    ...metrics
  };
}

async function fetchImage(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: "error",
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1",
      "User-Agent": "Worldwide-Cams/0.1 public-camera-verifier"
    },
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: "http_" + response.status,
      http_status: response.status,
      content_type: response.headers.get("content-type") || ""
    };
  }

  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("image/")) {
    return {
      ok: false,
      reason: "not_an_image",
      http_status: response.status,
      content_type: type
    };
  }

  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_BYTES) {
    return {
      ok: false,
      reason: "image_too_large",
      http_status: response.status,
      content_type: type
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_BYTES) {
    return {
      ok: false,
      reason: "image_too_large",
      http_status: response.status,
      content_type: type
    };
  }

  return {
    ok: true,
    buffer: Buffer.from(arrayBuffer),
    http_status: response.status,
    content_type: type
  };
}

export async function probeCamera(camera, { fetchImpl = fetch, force = false } = {}) {
  const checkedAt = new Date().toISOString();

  if (!camera?.id) {
    return {
      id: String(camera?.id || ""),
      status: "unavailable",
      operational: false,
      reason: "invalid_camera",
      checked_at: checkedAt
    };
  }

  // For now health classification is based on a current published still.
  // A player-only record remains "unknown" rather than being falsely marked down.
  if (!camera.image_url) {
    return {
      id: camera.id,
      status: camera.player_url || camera.stream_url ? "unknown" : "unavailable",
      operational: null,
      reason: camera.player_url || camera.stream_url ? "no_still_to_probe" : "no_media",
      checked_at: checkedAt
    };
  }

  const key = cacheKey(camera);
  const previous = cache.get(key);
  if (!force && previous && Date.now() - previous.at < CACHE_MS) {
    return previous.value;
  }

  let result;
  try {
    const fetched = await fetchImage(camera.image_url, fetchImpl);
    if (!fetched.ok) {
      result = {
        id: camera.id,
        status: "unavailable",
        operational: false,
        reason: fetched.reason,
        http_status: fetched.http_status,
        content_type: fetched.content_type,
        checked_at: checkedAt
      };
    } else {
      const digest = createHash("sha256").update(fetched.buffer).digest("hex");
      const analysis = await classifyCameraImage(fetched.buffer);
      result = {
        id: camera.id,
        status: analysis.placeholder_likely ? "unavailable" : "working",
        operational: !analysis.placeholder_likely,
        reason: analysis.placeholder_likely ? "provider_placeholder" : "usable_image",
        http_status: fetched.http_status,
        content_type: fetched.content_type,
        bytes: fetched.buffer.length,
        image_sha256: digest,
        placeholder_likely: analysis.placeholder_likely,
        white_fraction: Number(analysis.white_fraction.toFixed(4)),
        deep_blue_fraction: Number(analysis.deep_blue_fraction.toFixed(4)),
        mean_brightness: Number(analysis.mean_brightness.toFixed(2)),
        dimensions: {
          width: analysis.width,
          height: analysis.height
        },
        checked_at: checkedAt
      };
    }
  } catch (error) {
    result = {
      id: camera.id,
      status: "unavailable",
      operational: false,
      reason: error?.name === "TimeoutError" ? "timeout" : "probe_error",
      error: error?.message || String(error),
      checked_at: checkedAt
    };
  }

  cache.set(key, { at: Date.now(), value: result });
  return result;
}

export async function probeMany(cameras, { concurrency = 8, fetchImpl = fetch } = {}) {
  const list = Array.from(cameras || []).slice(0, 50);
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await probeCamera(list[index], { fetchImpl });
    }
  }

  const count = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

export function clearProbeCache() {
  cache.clear();
}
