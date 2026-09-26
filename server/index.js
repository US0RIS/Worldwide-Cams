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
import { probeCamera, probeMany } from "./camera-health.js";

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
      "frame-src https://*.windy.com https://windy.com",
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

async function findCameraById(id, apiKey = "") {
  if (id.startsWith("windy-")) {
    return await getWindyCamera(id, { apiKey });
  }
  if (id.startsWith("caltrans-")) {
    const all = await getAllCaltrans();
    return all.cameras.find((item) => item.id === id) || null;
  }
  if (id.startsWith("custom-")) {
    return customCamerasFromEnv().find((item) => item.id === id) || null;
  }
  return null;
}

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
      const camera = await findCameraById(id, requestWindyKey(req));
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
    const camera = await findCameraById(id, requestWindyKey(req));
    if (!camera) return sendError(res, new Error("Camera not found"), 404);
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
    const camera = await findCameraById(id, requestWindyKey(req));
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
