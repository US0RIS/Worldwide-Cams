import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAllCaltrans } from "./providers/caltrans.js";
import {
  getWindyCamera,
  listWindyByBbox,
  listWindyClusters,
  windyConfigured
} from "./providers/windy.js";
import { customCamerasFromEnv } from "./providers/custom.js";
import {
  discoverYouTubeLive,
  refreshYouTubeCandidate,
  youtubeConfigured,
  youtubeDerivedMetricsApproved,
  youtubeQueryFamilies
} from "./providers/youtube.js";
import {
  runYouTubeGlobalDiscoveryBatch,
  youtubeGlobalDiscoveryStatus
} from "./youtube-discovery.js";
import {
  getYouTubeCandidate,
  listYouTubeCandidates,
  pruneExpiredYouTubeData,
  recordYouTubeHealth,
  replaceYouTubeCandidate,
  reviewYouTubeCandidate,
  upsertYouTubeCandidates,
  youtubeRegistryDiagnostics
} from "./youtube-registry.js";
import { probeCamera, probeMany } from "./camera-health.js";
import {
  getCameraById,
  listAcceptedYouTubeCameras,
  providerDescriptors
} from "./camera-registry.js";

const app = express();
app.use(express.json({ limit: "64kb" }));
const port = Number(process.env.PORT || 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "frame-src https://*.windy.com https://windy.com https://www.youtube.com https://www.youtube-nocookie.com",
      "connect-src 'self' https:",
      "font-src 'self' data:",
      "worker-src 'self' blob:"
    ].join("; ")
  );
  next();
});

function finiteNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(name + " must be finite");
  return value;
}

function parseBbox(raw) {
  const parts = String(raw || "").split(",");
  if (parts.length !== 4) throw new Error("bbox must be north,east,south,west");
  const labels = ["north", "east", "south", "west"];
  const values = parts.map((value, index) => finiteNumber(value, labels[index]));
  const [north, east, south, west] = values;
  if (north <= south || north > 90 || south < -90 ||
      east <= west || east > 180 || west < -180) {
    throw new Error("Invalid non-wrapping bbox");
  }
  return values;
}

function sendError(res, error, status = 400) {
  res.status(status).json({
    status: "error",
    error: error?.message || String(error)
  });
}

function requestWindyKey(req) {
  const value = String(req.get("X-Windy-API-Key") || "").trim();
  return value.slice(0, 1000);
}

function requestYouTubeKey(req) {
  const value = String(req.get("X-YouTube-API-Key") || "").trim();
  return value.slice(0, 1000);
}

app.get("/api/status", async (req, res) => {
  let customCount = 0;
  let customError = null;
  try {
    customCount = customCamerasFromEnv().length;
  } catch (error) {
    customError = error?.message || String(error);
  }
  res.json({
    status: "ok",
    providers: {
      caltrans: {
        configured: true,
        mode: "full_state_catalog",
        note: "Official California highway camera catalog"
      },
      windy: {
        configured: windyConfigured(requestWindyKey(req)),
        mode: "map_clusters_plus_viewport_records",
        note: windyConfigured(requestWindyKey(req))
          ? "Windy key available for this browser request"
          : "Enter a Windy Webcams API key in the site or configure JARVIS_WINDY_WEBCAMS_API_KEY"
      },
      youtube: {
        configured: youtubeConfigured(requestYouTubeKey(req)),
        mode: "official_live_discovery_review_gate",
        production_mode: "manual_visual_verification_required",
        derived_metrics_approved: youtubeDerivedMetricsApproved(),
        note: youtubeConfigured(requestYouTubeKey(req))
          ? "Official YouTube Data API discovery available; production admission remains verification-gated"
          : "Enter a YouTube Data API key to enable live candidate discovery"
      },
      custom: {
        configured: customCount > 0,
        count: customCount,
        error: customError
      }
    }
  });
});

app.get("/api/cameras/caltrans", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json(await getAllCaltrans());
  } catch (error) {
    sendError(res, error, 502);
  }
});

app.get("/api/cameras/custom", (_req, res) => {
  try {
    const cameras = customCamerasFromEnv();
    res.json({
      status: "ok",
      provider: "Custom public source",
      camera_count: cameras.length,
      cameras
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/cameras/windy", async (req, res) => {
  try {
    const bbox = parseBbox(req.query.bbox);
    const max = Math.max(1, Math.min(1000, Math.floor(finiteNumber(req.query.max ?? 500, "max"))));
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(await listWindyByBbox(bbox, { max, apiKey: requestWindyKey(req) }));
  } catch (error) {
    sendError(res, error, windyConfigured(requestWindyKey(req)) ? 400 : 503);
  }
});

app.get("/api/cameras/windy/clusters", async (req, res) => {
  try {
    const bbox = parseBbox(req.query.bbox);
    const zoom = Math.max(0, Math.min(4, Math.round(finiteNumber(req.query.zoom ?? 1, "zoom"))));
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(await listWindyClusters(bbox, zoom, { apiKey: requestWindyKey(req) }));
  } catch (error) {
    sendError(res, error, windyConfigured(requestWindyKey(req)) ? 400 : 503);
  }
});

async function findCameraById(id, windyApiKey = "", _youtubeApiKey = "") {
  return getCameraById(id, { windyApiKey });
}

app.get("/api/youtube/status", async (req, res) => {
  try {
    const diagnostics = await youtubeRegistryDiagnostics();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      configured: youtubeConfigured(requestYouTubeKey(req)),
      derived_metrics_approved: youtubeDerivedMetricsApproved(),
      production_gate: "visual_and_temporal_verification_required",
      query_families: youtubeQueryFamilies(),
      diagnostics,
      policy_note:
        "Worldwide Cams does not infer YouTube content type or admit discovered broadcasts to production from metadata alone."
    });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.post("/api/youtube/discover", async (req, res) => {
  try {
    const apiKey = requestYouTubeKey(req);
    if (!youtubeConfigured(apiKey)) {
      return sendError(res, new Error("YouTube Data API key is not configured"), 503);
    }
    const latitude = finiteNumber(req.body?.latitude, "latitude");
    const longitude = finiteNumber(req.body?.longitude, "longitude");
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error("Invalid latitude/longitude");
    }
    const radiusKm = Math.max(1, Math.min(1000, finiteNumber(req.body?.radius_km ?? 100, "radius_km")));
    const maxResults = Math.max(1, Math.min(50, Math.floor(finiteNumber(req.body?.max_results ?? 25, "max_results"))));
    const requested = Array.isArray(req.body?.queries)
      ? req.body.queries.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const queries = requested.length ? requested : youtubeQueryFamilies().slice(0, 4);

    const runs = [];
    for (const query of queries) {
      runs.push(await discoverYouTubeLive({
        query,
        latitude,
        longitude,
        radiusKm,
        maxResults,
        apiKey,
        locationName: String(req.body?.location_name || "")
      }));
    }

    const byId = new Map();
    for (const run of runs) {
      for (const candidate of run.candidates || []) byId.set(candidate.id, candidate);
    }
    const candidates = [...byId.values()];
    const persisted = await upsertYouTubeCandidates(candidates);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      discovered: candidates.length,
      queries_run: runs.length,
      search_calls: runs.reduce((sum, run) => sum + Number(run.search_calls || 0), 0),
      video_detail_calls: runs.reduce((sum, run) => sum + Number(run.video_detail_calls || 0), 0),
      persisted,
      production_admitted: 0,
      candidates,
      note:
        "All newly discovered YouTube broadcasts are REVIEW candidates. Metadata discovery never admits a stream to the production globe."
    });
  } catch (error) {
    const status = error?.status === 403 ? 403 : error?.status === 400 ? 400 : 502;
    sendError(res, error, status);
  }
});

app.get("/api/youtube/global/status", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", discovery: await youtubeGlobalDiscoveryStatus() });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.post("/api/youtube/global/run", async (req, res) => {
  try {
    const apiKey = requestYouTubeKey(req);
    if (!youtubeConfigured(apiKey)) {
      return sendError(res, new Error("YouTube Data API key is not configured"), 503);
    }
    const result = await runYouTubeGlobalDiscoveryBatch({
      apiKey,
      cellBatch: req.body?.cell_batch ?? 4,
      queriesPerCell: req.body?.queries_per_cell ?? 4,
      maxResults: req.body?.max_results ?? 25
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    sendError(res, error, error?.status === 403 ? 403 : 502);
  }
});

app.get("/api/youtube/candidates", async (req, res) => {
  try {
    await pruneExpiredYouTubeData();
    const state = String(req.query.state || "").toUpperCase();
    if (state && !["ACCEPT", "REVIEW", "REJECT"].includes(state)) {
      throw new Error("state must be ACCEPT, REVIEW, or REJECT");
    }
    const candidates = await listYouTubeCandidates({
      state,
      limit: req.query.limit ?? 250
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", candidates });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/cameras/youtube", async (_req, res) => {
  try {
    const cameras = await listAcceptedYouTubeCameras({ limit: 1000 });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      provider: "YouTube Live",
      camera_count: cameras.length,
      cameras,
      source_note: "Only manually visual/temporal-verified, currently-live YouTube cameras enter this production feed."
    });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.post("/api/youtube/candidate/:id/refresh", async (req, res) => {
  try {
    const apiKey = requestYouTubeKey(req);
    if (!youtubeConfigured(apiKey)) {
      return sendError(res, new Error("YouTube Data API key is not configured"), 503);
    }
    const id = String(req.params.id || "");
    const candidate = await getYouTubeCandidate(id);
    if (!candidate) return sendError(res, new Error("YouTube candidate not found"), 404);
    const refreshed = await refreshYouTubeCandidate(candidate, { apiKey });
    await replaceYouTubeCandidate(refreshed);
    await recordYouTubeHealth(id, {
      status: refreshed.currently_live ? "live" : "unavailable",
      reason: refreshed.failure_reason || "youtube_api_recheck",
      currently_live: refreshed.currently_live
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", candidate: await getYouTubeCandidate(id) });
  } catch (error) {
    sendError(res, error, error?.status === 403 ? 403 : 502);
  }
});

app.post("/api/youtube/candidate/:id/review", async (req, res) => {
  try {
    const candidate = await reviewYouTubeCandidate(String(req.params.id || ""), {
      decision: req.body?.decision,
      sceneType: req.body?.scene_type,
      locationConfirmed: req.body?.location_confirmed === true,
      visualConfirmed: req.body?.visual_confirmed === true,
      temporalConfirmed: req.body?.temporal_confirmed === true,
      notes: req.body?.notes
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", candidate });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/youtube/diagnostics", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      ...(await youtubeRegistryDiagnostics()),
      global_discovery: await youtubeGlobalDiscoveryStatus(),
      derived_metrics_approved: youtubeDerivedMetricsApproved()
    });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.post("/api/cameras/probe", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length || ids.length > 50) {
      return sendError(res, new Error("ids must contain 1–50 camera IDs"));
    }
    const cameras = [];
    for (const raw of ids) {
      const id = String(raw || "");
      if (!id || id.length > 120) continue;
      const camera = await findCameraById(id, requestWindyKey(req), requestYouTubeKey(req));
      if (camera) cameras.push(camera);
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      probes: await probeMany(cameras)
    });
  } catch (error) {
    sendError(res, error, 502);
  }
});

app.get("/api/camera/:id/probe", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const camera = await findCameraById(id, requestWindyKey(req), requestYouTubeKey(req));
    if (!camera) return sendError(res, new Error("Camera not found"), 404);
    if (id.startsWith("youtube-")) {
      const apiKey = requestYouTubeKey(req);
      if (!youtubeConfigured(apiKey)) {
        return res.json({
          status: "ok",
          probe: {
            id,
            status: "unknown",
            operational: null,
            reason: "youtube_key_required_for_live_recheck",
            checked_at: new Date().toISOString()
          }
        });
      }
      const refreshed = await refreshYouTubeCandidate(camera, { apiKey });
      await replaceYouTubeCandidate(refreshed);
      await recordYouTubeHealth(id, {
        status: refreshed.currently_live ? "live" : "unavailable",
        reason: refreshed.failure_reason || "youtube_api_recheck",
        currently_live: refreshed.currently_live
      });
      return res.json({
        status: "ok",
        probe: {
          id,
          status: refreshed.currently_live ? "working" : "unavailable",
          operational: refreshed.currently_live,
          reason: refreshed.currently_live ? "youtube_currently_live" : refreshed.failure_reason || "not_live",
          checked_at: new Date().toISOString()
        }
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      probe: await probeCamera(camera, { force: req.query.force === "1" })
    });
  } catch (error) {
    sendError(res, error, 502);
  }
});

app.get("/api/camera/:id", async (req, res) => {
  const id = String(req.params.id || "");
  try {
    const camera = await findCameraById(id, requestWindyKey(req), requestYouTubeKey(req));
    if (!camera) return sendError(res, new Error("Camera not found"), 404);
    if (id.startsWith("windy-")) res.setHeader("Cache-Control", "no-store");
    return res.json({ status: "ok", camera });
  } catch (error) {
    sendError(res, error, 502);
  }
});

const dist = path.join(root, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist, {
    maxAge: "1h",
    index: false
  }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  app.listen(port, "0.0.0.0", () => {
    console.log("Worldwide Cams listening on http://localhost:" + port);
  });
}

export { app, parseBbox };
