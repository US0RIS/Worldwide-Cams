import { getAllCaltrans } from "./providers/caltrans.js";
import { customCamerasFromEnv } from "./providers/custom.js";
import { getWindyCamera } from "./providers/windy.js";
import { getYouTubeCandidate, listYouTubeCandidates } from "./youtube-registry.js";

export const providerDescriptors = Object.freeze([
  {
    kind: "caltrans",
    name: "Caltrans CCTV",
    scope: "public_agency",
    capabilities: ["list", "still", "health_probe"]
  },
  {
    kind: "windy",
    name: "Windy Webcams",
    scope: "aggregator",
    capabilities: ["bbox", "clusters", "still", "player", "health_probe"]
  },
  {
    kind: "youtube",
    name: "YouTube Live",
    scope: "public_live_platform",
    capabilities: ["discovery", "review_queue", "supported_embed", "live_status"]
  },
  {
    kind: "custom",
    name: "Custom public sources",
    scope: "operator_configured",
    capabilities: ["list", "still", "stream", "health_probe"]
  }
]);

export function normalizedCameraRecord(camera) {
  if (!camera || typeof camera !== "object") return null;
  const latitude = Number(camera.latitude);
  const longitude = Number(camera.longitude);
  if (!camera.id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    ...camera,
    id: String(camera.id),
    provider: String(camera.provider || "Public camera"),
    provider_kind: String(camera.provider_kind || "unknown"),
    title: String(camera.title || camera.id),
    latitude,
    longitude,
    nearby_place: String(camera.nearby_place || camera.location_name || ""),
    camera_type: String(camera.camera_type || "fixed_camera"),
    status: String(camera.status || (camera.currently_live ? "LIVE" : "unknown"))
  };
}

export async function getCameraById(
  id,
  { windyApiKey = "", includeReview = false } = {}
) {
  const cameraId = String(id || "");

  if (cameraId.startsWith("windy-")) {
    return normalizedCameraRecord(await getWindyCamera(cameraId, { apiKey: windyApiKey }));
  }

  if (cameraId.startsWith("youtube-")) {
    const candidate = await getYouTubeCandidate(cameraId);
    if (!candidate) return null;
    if (!includeReview && (candidate.candidate_state !== "ACCEPT" || !candidate.production_eligible)) {
      return null;
    }
    return normalizedCameraRecord(candidate);
  }

  if (cameraId.startsWith("caltrans-")) {
    const all = await getAllCaltrans();
    return normalizedCameraRecord(all.cameras.find((item) => item.id === cameraId) || null);
  }

  if (cameraId.startsWith("custom-")) {
    return normalizedCameraRecord(
      customCamerasFromEnv().find((item) => item.id === cameraId) || null
    );
  }

  return null;
}

export async function listAcceptedYouTubeCameras({ limit = 1000 } = {}) {
  const candidates = await listYouTubeCandidates({ state: "ACCEPT", limit });
  return candidates
    .filter((item) => item.production_eligible && item.currently_live)
    .map(normalizedCameraRecord)
    .filter(Boolean);
}
