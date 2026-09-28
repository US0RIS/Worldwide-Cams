import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_DIR = path.resolve(process.env.WORLDWIDE_CAMS_DATA_DIR || "data/runtime");
const STORE_PATH = path.join(STORE_DIR, "youtube-candidates.json");
const MAX_RECORDS = 20_000;
const MAX_HEALTH = 24;
let writeChain = Promise.resolve();

function emptyStore() {
  return {
    schema_version: 1,
    updated_at: null,
    candidates: {}
  };
}

async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== 1 || typeof parsed.candidates !== "object") {
      return emptyStore();
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store) {
  await mkdir(STORE_DIR, { recursive: true });
  store.updated_at = new Date().toISOString();
  const tmp = STORE_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, STORE_PATH);
}

function queueWrite(mutator) {
  const task = writeChain.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  writeChain = task.catch(() => {});
  return task;
}

function expired(record, now = Date.now()) {
  const value = Date.parse(record?.metadata_expires_at || "");
  return Number.isFinite(value) && value <= now;
}

function publicCandidate(record) {
  if (!record) return null;
  // The API key is never part of a record. Keep this projection explicit so
  // future secret-bearing fields cannot leak accidentally.
  const {
    description,
    ...safe
  } = record;
  return {
    ...safe,
    description: String(description || "").slice(0, 5000)
  };
}

function trimStore(store) {
  const entries = Object.entries(store.candidates || {});
  if (entries.length <= MAX_RECORDS) return;
  entries.sort(([, a], [, b]) =>
    Date.parse(b.last_checked || b.discovered_at || 0) -
    Date.parse(a.last_checked || a.discovered_at || 0)
  );
  store.candidates = Object.fromEntries(entries.slice(0, MAX_RECORDS));
}

export async function upsertYouTubeCandidates(candidates) {
  return queueWrite(async (store) => {
    let inserted = 0;
    let updated = 0;
    for (const candidate of candidates || []) {
      if (!candidate?.id?.startsWith("youtube-")) continue;
      const previous = store.candidates[candidate.id];
      store.candidates[candidate.id] = {
        ...previous,
        ...candidate,
        discovered_at: previous?.discovered_at || candidate.discovered_at,
        manual_review: previous?.manual_review || null,
        candidate_state: previous?.candidate_state === "ACCEPT" ? "ACCEPT" : candidate.candidate_state,
        production_eligible: previous?.production_eligible === true,
        verification: {
          ...(candidate.verification || {}),
          ...(previous?.verification || {})
        },
        health_history: Array.isArray(previous?.health_history)
          ? previous.health_history.slice(-MAX_HEALTH)
          : []
      };
      if (previous) updated += 1;
      else inserted += 1;
    }
    trimStore(store);
    return { inserted, updated, total: Object.keys(store.candidates).length };
  });
}

export async function listYouTubeCandidates({ state = "", limit = 250 } = {}) {
  const store = await readStore();
  const now = Date.now();
  const rows = Object.values(store.candidates || {})
    .filter((record) => !expired(record, now))
    .filter((record) => !state || record.candidate_state === state)
    .sort((a, b) =>
      Date.parse(b.last_checked || b.discovered_at || 0) -
      Date.parse(a.last_checked || a.discovered_at || 0)
    )
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 250)))
    .map(publicCandidate);
  return rows;
}

export async function getYouTubeCandidate(id) {
  const store = await readStore();
  const record = store.candidates?.[String(id || "")];
  if (!record || expired(record)) return null;
  return publicCandidate(record);
}

export async function replaceYouTubeCandidate(record) {
  if (!record?.id?.startsWith("youtube-")) throw new Error("Invalid YouTube candidate");
  return queueWrite(async (store) => {
    const previous = store.candidates[record.id] || {};
    store.candidates[record.id] = {
      ...previous,
      ...record,
      health_history: Array.isArray(record.health_history)
        ? record.health_history.slice(-MAX_HEALTH)
        : Array.isArray(previous.health_history)
          ? previous.health_history.slice(-MAX_HEALTH)
          : []
    };
    return publicCandidate(store.candidates[record.id]);
  });
}

export async function reviewYouTubeCandidate(
  id,
  {
    decision,
    sceneType = "",
    locationConfirmed = false,
    visualConfirmed = false,
    temporalConfirmed = false,
    notes = ""
  } = {}
) {
  const normalizedDecision = String(decision || "").toUpperCase();
  if (!["ACCEPT", "REJECT", "REVIEW"].includes(normalizedDecision)) {
    throw new Error("decision must be ACCEPT, REVIEW, or REJECT");
  }

  return queueWrite(async (store) => {
    const record = store.candidates?.[String(id || "")];
    if (!record || expired(record)) throw new Error("YouTube candidate not found or stale");

    if (normalizedDecision === "ACCEPT") {
      if (!record.currently_live) throw new Error("Cannot accept a broadcast that is not currently live");
      if (!record.embeddable && !record.provider_detail_url) {
        throw new Error("Cannot accept a broadcast without supported playback");
      }
      if (!locationConfirmed || !visualConfirmed || !temporalConfirmed) {
        throw new Error("ACCEPT requires explicit location, visual, and temporal confirmation");
      }
    }

    const reviewedAt = new Date().toISOString();
    record.candidate_state = normalizedDecision;
    record.production_eligible = normalizedDecision === "ACCEPT";
    record.camera_type = normalizedDecision === "ACCEPT" ? "fixed_camera" : "unverified_candidate";
    record.scene_type = String(sceneType || record.scene_type || "unverified").slice(0, 80);
    record.manual_review = {
      decision: normalizedDecision,
      reviewed_at: reviewedAt,
      location_confirmed: Boolean(locationConfirmed),
      visual_confirmed: Boolean(visualConfirmed),
      temporal_confirmed: Boolean(temporalConfirmed),
      notes: String(notes || "").slice(0, 1000)
    };
    record.verification = {
      ...(record.verification || {}),
      geolocation: locationConfirmed ? "PASS" : record.verification?.geolocation || "REVIEW",
      visual: visualConfirmed ? "PASS_MANUAL" : "REQUIRED",
      temporal: temporalConfirmed ? "PASS_MANUAL" : "REQUIRED",
      decision: normalizedDecision
    };
    if (normalizedDecision === "REJECT" && !record.failure_reason) {
      record.failure_reason = "MANUAL_REJECT";
    }
    return publicCandidate(record);
  });
}

export async function recordYouTubeHealth(id, health) {
  return queueWrite(async (store) => {
    const record = store.candidates?.[String(id || "")];
    if (!record) return null;
    const entry = {
      checked_at: new Date().toISOString(),
      status: String(health?.status || "unknown"),
      reason: String(health?.reason || "")
    };
    record.health_history = [...(record.health_history || []), entry].slice(-MAX_HEALTH);
    record.last_checked = entry.checked_at;
    if (health?.currently_live === false) {
      record.currently_live = false;
      record.production_eligible = false;
      if (record.candidate_state === "ACCEPT") record.candidate_state = "REVIEW";
    }
    return publicCandidate(record);
  });
}

export async function youtubeRegistryDiagnostics() {
  const store = await readStore();
  const now = Date.now();
  const active = Object.values(store.candidates || {}).filter((record) => !expired(record, now));
  const counts = { ACCEPT: 0, REVIEW: 0, REJECT: 0 };
  let live = 0;
  let unavailable = 0;
  for (const record of active) {
    counts[record.candidate_state] = (counts[record.candidate_state] || 0) + 1;
    if (record.currently_live) live += 1;
    else unavailable += 1;
  }
  return {
    stored_candidates: active.length,
    accepted: counts.ACCEPT || 0,
    review: counts.REVIEW || 0,
    rejected: counts.REJECT || 0,
    currently_live: live,
    unavailable,
    store_updated_at: store.updated_at
  };
}

export async function pruneExpiredYouTubeData() {
  return queueWrite(async (store) => {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of Object.entries(store.candidates || {})) {
      if (expired(record, now)) {
        delete store.candidates[id];
        removed += 1;
      }
    }
    return { removed, remaining: Object.keys(store.candidates).length };
  });
}
