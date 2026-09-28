import test from "node:test";
import assert from "node:assert/strict";

import { parseCaltrans, safeCaltransMediaUrl } from "../server/providers/caltrans.js";
import { normalizeWindy, listWindyByBbox } from "../server/providers/windy.js";
import { discoverYouTubeLive, normalizeYouTubeCandidate } from "../server/providers/youtube.js";
import { customCamerasFromEnv } from "../server/providers/custom.js";
import { app, parseBbox } from "../server/index.js";
import { classifyCameraImage } from "../server/camera-health.js";
import sharp from "sharp";

test("Caltrans parser mirrors Jarvis allowlisted in-service behavior", () => {
  const payload = {
    data: [
      {
        cctv: {
          index: "196",
          inService: "true",
          location: {
            locationName: "I-5 Test",
            nearbyPlace: "Los Angeles",
            latitude: "34.05",
            longitude: "-118.25",
            direction: "N"
          },
          imageData: {
            static: {
              currentImageURL: "https://cwwp2.dot.ca.gov/data/d7/cctv/image.jpg"
            },
            streamingVideoURL: "https://wzmedia.dot.ca.gov/test/playlist.m3u8"
          }
        }
      },
      {
        cctv: {
          index: "bad-host",
          inService: "true",
          location: {
            locationName: "Bad",
            latitude: "34",
            longitude: "-118"
          },
          imageData: {
            static: {
              currentImageURL: "https://example.com/not-jarvis-camera.jpg"
            }
          }
        }
      },
      {
        cctv: {
          index: "offline",
          inService: "false",
          location: {
            locationName: "Offline",
            latitude: "34",
            longitude: "-118"
          },
          imageData: {
            static: {
              currentImageURL: "https://cwwp2.dot.ca.gov/offline.jpg"
            }
          }
        }
      }
    ]
  };

  const cameras = parseCaltrans(payload, 7);
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, "caltrans-d7-196");
  assert.equal(cameras[0].provider_kind, "caltrans");
  assert.equal(cameras[0].stream_url, "https://wzmedia.dot.ca.gov/test/playlist.m3u8");
});

test("Caltrans media URL rejects non-government or credentialed URLs", () => {
  assert.equal(safeCaltransMediaUrl("https://example.com/cam.jpg"), "");
  assert.equal(safeCaltransMediaUrl("http://cwwp2.dot.ca.gov/cam.jpg"), "");
  assert.equal(safeCaltransMediaUrl("https://user:pass@cwwp2.dot.ca.gov/cam.jpg"), "");
  assert.match(safeCaltransMediaUrl("https://cwwp2.dot.ca.gov/cam.jpg"), /^https:/);
});

test("Windy normalizer exposes provider image/player without inventing stream URL", () => {
  const camera = normalizeWindy({
    webcamId: 12345,
    status: "active",
    title: "Mountain Camera",
    lastUpdatedOn: "2026-09-26T20:00:00.000Z",
    location: {
      latitude: 46.5,
      longitude: 7.9,
      city: "Example",
      country: "CH"
    },
    images: {
      current: {
        preview: "https://images.windy.com/example.jpg"
      }
    },
    player: {
      live: {
        available: true,
        embed: "https://webcams.windy.com/webcams/public/embed/player/12345"
      }
    },
    urls: {
      detail: "https://www.windy.com/webcams/12345"
    }
  });

  assert.ok(camera);
  assert.equal(camera.id, "windy-12345");
  assert.equal(camera.stream_url, "");
  assert.match(camera.image_url, /^https:/);
  assert.match(camera.player_url, /^https:/);
  assert.equal(camera.capture_time, null);
});

test("custom public cameras require coordinates and public HTTP(S) media", () => {
  const cameras = customCamerasFromEnv(JSON.stringify([
    {
      id: "demo",
      title: "Demo",
      latitude: 1,
      longitude: 2,
      image_url: "https://example.org/cam.jpg"
    },
    {
      id: "no-media",
      latitude: 1,
      longitude: 2
    }
  ]));
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, "custom-demo");
});

test("Caltrans-style unavailable placeholder is detected conservatively", async () => {
  const placeholder = await sharp({
    create: {
      width: 640,
      height: 400,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="640" height="400"><text x="85" y="190" font-size="64" font-family="Arial" font-weight="700" fill="rgb(0,20,140)">Temporarily</text><text x="95" y="270" font-size="64" font-family="Arial" font-weight="700" fill="rgb(0,20,140)">Unavailable</text></svg>'
        ),
        top: 0,
        left: 0
      }
    ])
    .jpeg()
    .toBuffer();

  const result = await classifyCameraImage(placeholder);
  assert.equal(result.placeholder_likely, true);
  assert.ok(result.white_fraction > 0.72);
});

test("ordinary colorful camera-like image is not classified as placeholder", async () => {
  const image = await sharp({
    create: {
      width: 640,
      height: 400,
      channels: 3,
      background: { r: 90, g: 130, b: 150 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="640" height="400"><rect y="220" width="640" height="180" fill="rgb(70,70,70)"/><rect y="280" width="640" height="6" fill="rgb(245,210,80)"/><circle cx="200" cy="270" r="30" fill="rgb(210,40,30)"/><circle cx="450" cy="315" r="25" fill="rgb(30,60,200)"/></svg>'
        ),
        top: 0,
        left: 0
      }
    ])
    .jpeg()
    .toBuffer();

  const result = await classifyCameraImage(image);
  assert.equal(result.placeholder_likely, false);
});

test("bbox parser rejects wrapping or inverted bounds", () => {
  assert.deepEqual(parseBbox("40,-70,30,-80"), [40, -70, 30, -80]);
  assert.throws(() => parseBbox("30,-70,40,-80"));
  assert.throws(() => parseBbox("40,-170,30,170"));
});

test("request-scoped Windy key is sent to Windy but not persisted", async () => {
  let observedKey = "";
  const fetchImpl = async (_url, options) => {
    observedKey = options.headers["X-Windy-API-Key"];
    return new Response(JSON.stringify({ webcams: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await listWindyByBbox(
    [40, -70, 30, -80],
    { max: 1, fetchImpl, apiKey: "browser-secret-test-key" }
  );
  assert.equal(result.status, "ok");
  assert.equal(observedKey, "browser-secret-test-key");
  assert.equal(JSON.stringify(result).includes("browser-secret-test-key"), false);
});

test("status API reports browser Windy key without echoing it", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/status", {
    headers: { "X-Windy-API-Key": "browser-secret-test-key" }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.providers.windy.configured, true);
  assert.equal(JSON.stringify(payload).includes("browser-secret-test-key"), false);
});

test("YouTube candidate normalization never admits metadata-only discovery to production", () => {
  const candidate = normalizeYouTubeCandidate({
    id: "abcdefghijk",
    snippet: {
      title: "LIVE city webcam",
      description: "A public live view",
      channelId: "UCtest",
      channelTitle: "City",
      categoryId: "19",
      liveBroadcastContent: "live",
      thumbnails: {
        high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }
      }
    },
    status: {
      privacyStatus: "public",
      embeddable: true
    },
    liveStreamingDetails: {
      actualStartTime: "2026-09-28T00:00:00Z"
    },
    recordingDetails: {
      location: { latitude: 35.68, longitude: 139.76 }
    }
  });

  assert.ok(candidate);
  assert.equal(candidate.id, "youtube-abcdefghijk");
  assert.equal(candidate.candidate_state, "REVIEW");
  assert.equal(candidate.production_eligible, false);
  assert.equal(candidate.verification.visual, "REQUIRED");
  assert.equal(candidate.verification.temporal, "REQUIRED");
  assert.match(candidate.player_url, /^https:\/\/www\.youtube\.com\/embed\//);
});

test("YouTube discovery uses official live geographic filters and keeps key out of result", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    seen.push(target);
    if (target.pathname.endsWith("/search")) {
      return new Response(JSON.stringify({
        items: [{ id: { videoId: "abcdefghijk" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.pathname.endsWith("/videos")) {
      return new Response(JSON.stringify({
        items: [{
          id: "abcdefghijk",
          snippet: {
            title: "LIVE harbor webcam",
            description: "Harbor",
            channelId: "UCtest",
            channelTitle: "Harbor Authority",
            categoryId: "19",
            liveBroadcastContent: "live",
            thumbnails: {
              high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }
            }
          },
          status: { privacyStatus: "public", embeddable: true },
          liveStreamingDetails: { actualStartTime: "2026-09-28T00:00:00Z" },
          recordingDetails: { location: { latitude: 34.0, longitude: -118.2 } }
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };

  const result = await discoverYouTubeLive({
    query: "harbor live cam",
    latitude: 34,
    longitude: -118.2,
    radiusKm: 50,
    maxResults: 10,
    apiKey: "youtube-secret-test-key",
    fetchImpl
  });

  assert.equal(result.status, "ok");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.production_admitted, 0);
  assert.equal(JSON.stringify(result).includes("youtube-secret-test-key"), false);

  const search = seen.find((url) => url.pathname.endsWith("/search"));
  assert.ok(search);
  assert.equal(search.searchParams.get("eventType"), "live");
  assert.equal(search.searchParams.get("type"), "video");
  assert.equal(search.searchParams.get("videoEmbeddable"), "true");
  assert.equal(search.searchParams.get("videoSyndicated"), "true");
  assert.equal(search.searchParams.get("location"), "34,-118.2");
  assert.equal(search.searchParams.get("key"), "youtube-secret-test-key");
});

test("status API accepts request-scoped YouTube key without echoing it", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/status", {
    headers: { "X-YouTube-API-Key": "youtube-secret-test-key" }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.providers.youtube.configured, true);
  assert.equal(JSON.stringify(payload).includes("youtube-secret-test-key"), false);
});

test("status API reports provider configuration without exposing secrets", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/status");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.providers.caltrans.configured, true);
  assert.equal(typeof payload.providers.windy.configured, "boolean");
  assert.equal(JSON.stringify(payload).includes("X-Windy-API-Key"), false);
});
