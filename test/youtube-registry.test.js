import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("YouTube production registry refuses metadata-only acceptance", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "worldwide-cams-youtube-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const previous = process.env.WORLDWIDE_CAMS_DATA_DIR;
  process.env.WORLDWIDE_CAMS_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.WORLDWIDE_CAMS_DATA_DIR;
    else process.env.WORLDWIDE_CAMS_DATA_DIR = previous;
  });

  const url = pathToFileURL(path.resolve("server/youtube-registry.js"));
  url.searchParams.set("test", String(Date.now()));
  const registry = await import(url.href);

  const candidate = {
    id: "youtube-abcdefghijk",
    provider: "YouTube Live",
    provider_kind: "youtube",
    provider_camera_id: "abcdefghijk",
    title: "LIVE webcam",
    latitude: 34.05,
    longitude: -118.25,
    candidate_state: "REVIEW",
    production_eligible: false,
    currently_live: true,
    embeddable: true,
    player_url: "https://www.youtube-nocookie.com/embed/abcdefghijk",
    provider_detail_url: "https://www.youtube.com/watch?v=abcdefghijk",
    discovered_at: new Date().toISOString(),
    last_checked: new Date().toISOString(),
    metadata_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    verification: {
      live_status: "PASS",
      visual: "REQUIRED",
      temporal: "REQUIRED",
      decision: "REVIEW"
    }
  };

  await registry.upsertYouTubeCandidates([candidate]);

  await assert.rejects(
    registry.reviewYouTubeCandidate(candidate.id, {
      decision: "ACCEPT",
      locationConfirmed: true,
      visualConfirmed: false,
      temporalConfirmed: true
    }),
    /requires explicit location, visual, and temporal confirmation/
  );

  const stillReview = await registry.getYouTubeCandidate(candidate.id);
  assert.equal(stillReview.candidate_state, "REVIEW");
  assert.equal(stillReview.production_eligible, false);

  const accepted = await registry.reviewYouTubeCandidate(candidate.id, {
    decision: "ACCEPT",
    sceneType: "urban_street",
    locationConfirmed: true,
    visualConfirmed: true,
    temporalConfirmed: true,
    notes: "Observed in supported YouTube player."
  });
  assert.equal(accepted.candidate_state, "ACCEPT");
  assert.equal(accepted.production_eligible, true);
  assert.equal(accepted.verification.visual, "PASS_MANUAL");
  assert.equal(accepted.verification.temporal, "PASS_MANUAL");
});
