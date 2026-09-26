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

const app = express();
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

app.get("/api/status", async (_req, res) => {
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
        configured: windyConfigured(),
        mode: "map_clusters_plus_viewport_records",
        note: windyConfigured()
          ? "Windy key configured server-side"
          : "Set JARVIS_WINDY_WEBCAMS_API_KEY to enable the worldwide directory"
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
    res.json(await listWindyByBbox(bbox, { max }));
  } catch (error) {
    sendError(res, error, windyConfigured() ? 400 : 503);
  }
});

app.get("/api/cameras/windy/clusters", async (req, res) => {
  try {
    const bbox = parseBbox(req.query.bbox);
    const zoom = Math.max(0, Math.min(4, Math.round(finiteNumber(req.query.zoom ?? 1, "zoom"))));
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(await listWindyClusters(bbox, zoom));
  } catch (error) {
    sendError(res, error, windyConfigured() ? 400 : 503);
  }
});

app.get("/api/camera/:id", async (req, res) => {
  const id = String(req.params.id || "");
  try {
    if (id.startsWith("windy-")) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ status: "ok", camera: await getWindyCamera(id) });
    }
    if (id.startsWith("caltrans-")) {
      const all = await getAllCaltrans();
      const camera = all.cameras.find((item) => item.id === id);
      if (!camera) return sendError(res, new Error("Caltrans camera not found"), 404);
      return res.json({ status: "ok", camera });
    }
    if (id.startsWith("custom-")) {
      const camera = customCamerasFromEnv().find((item) => item.id === id);
      if (!camera) return sendError(res, new Error("Custom camera not found"), 404);
      return res.json({ status: "ok", camera });
    }
    return sendError(res, new Error("Unknown camera ID"), 404);
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
