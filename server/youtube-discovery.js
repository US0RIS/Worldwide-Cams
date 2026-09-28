import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { discoverYouTubeLive, youtubeQueryFamilies } from "./providers/youtube.js";
import { upsertYouTubeCandidates } from "./youtube-registry.js";

const STORE_DIR = path.resolve(process.env.WORLDWIDE_CAMS_DATA_DIR || "data/runtime");
const STATE_PATH = path.join(STORE_DIR, "youtube-discovery-state.json");
const CELL_COUNT = 72;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function pacificDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function cells() {
  const rows = [];
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const y = 1 - 2 * ((i + 0.5) / CELL_COUNT);
    const latitude = Math.asin(y) * 180 / Math.PI;
    let longitude = (i * GOLDEN_ANGLE * 180 / Math.PI + 180) % 360 - 180;
    if (longitude < -180) longitude += 360;
    rows.push({
      index: i,
      latitude: Number(latitude.toFixed(5)),
      longitude: Number(longitude.toFixed(5)),
      radius_km: 850
    });
  }
  return rows;
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return {
      cursor: Number(parsed.cursor || 0) % CELL_COUNT,
      quota_day: String(parsed.quota_day || ""),
      search_calls_today: Number(parsed.search_calls_today || 0),
      total_search_calls: Number(parsed.total_search_calls || 0),
      total_candidates_seen: Number(parsed.total_candidates_seen || 0),
      last_run_at: parsed.last_run_at || null,
      last_error: parsed.last_error || null
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      cursor: 0,
      quota_day: pacificDay(),
      search_calls_today: 0,
      total_search_calls: 0,
      total_candidates_seen: 0,
      last_run_at: null,
      last_error: null
    };
  }
}

async function writeState(state) {
  await mkdir(STORE_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, STATE_PATH);
}

function resetQuotaDay(state) {
  const day = pacificDay();
  if (state.quota_day !== day) {
    state.quota_day = day;
    state.search_calls_today = 0;
  }
}

export async function youtubeGlobalDiscoveryStatus() {
  const state = await readState();
  resetQuotaDay(state);
  return {
    ...state,
    cell_count: CELL_COUNT,
    cells_remaining_in_cycle: CELL_COUNT - state.cursor,
    local_search_call_budget: Math.max(
      1,
      Math.min(100, Number(process.env.WORLDWIDE_CAMS_YOUTUBE_SEARCH_BUDGET || 80))
    )
  };
}

export async function runYouTubeGlobalDiscoveryBatch({
  apiKey,
  cellBatch = 4,
  queriesPerCell = 4,
  maxResults = 25
} = {}) {
  const state = await readState();
  resetQuotaDay(state);

  const budget = Math.max(
    1,
    Math.min(100, Number(process.env.WORLDWIDE_CAMS_YOUTUBE_SEARCH_BUDGET || 80))
  );
  const cellLimit = Math.max(1, Math.min(8, Math.floor(Number(cellBatch) || 4)));
  const queryLimit = Math.max(1, Math.min(6, Math.floor(Number(queriesPerCell) || 4)));
  const plannedCalls = cellLimit * queryLimit;

  if (state.search_calls_today + plannedCalls > budget) {
    await writeState(state);
    return {
      status: "quota_guard",
      planned_search_calls: plannedCalls,
      search_calls_today: state.search_calls_today,
      local_search_call_budget: budget,
      next_reset: "midnight Pacific Time",
      state
    };
  }

  const grid = cells();
  const families = youtubeQueryFamilies();
  const all = new Map();
  const runs = [];
  let actualCalls = 0;

  try {
    for (let cellOffset = 0; cellOffset < cellLimit; cellOffset += 1) {
      const cellIndex = (state.cursor + cellOffset) % grid.length;
      const cell = grid[cellIndex];
      for (let queryOffset = 0; queryOffset < queryLimit; queryOffset += 1) {
        const queryIndex = (cellIndex * queryLimit + queryOffset) % families.length;
        const query = families[queryIndex];
        const run = await discoverYouTubeLive({
          query,
          latitude: cell.latitude,
          longitude: cell.longitude,
          radiusKm: cell.radius_km,
          maxResults,
          apiKey,
          locationName: "Global discovery cell " + cell.index
        });
        actualCalls += Number(run.search_calls || 0);
        runs.push({
          cell: cell.index,
          query,
          discovered: Number(run.discovered || 0)
        });
        for (const candidate of run.candidates || []) all.set(candidate.id, candidate);
      }
    }

    const candidates = [...all.values()];
    const persisted = await upsertYouTubeCandidates(candidates);
    state.cursor = (state.cursor + cellLimit) % grid.length;
    state.search_calls_today += actualCalls;
    state.total_search_calls += actualCalls;
    state.total_candidates_seen += candidates.length;
    state.last_run_at = new Date().toISOString();
    state.last_error = null;
    await writeState(state);

    return {
      status: "ok",
      cells_processed: cellLimit,
      queries_per_cell: queryLimit,
      search_calls: actualCalls,
      unique_candidates: candidates.length,
      production_admitted: 0,
      persisted,
      runs,
      state,
      note:
        "Global discovery is resumable and quota-bounded. Every result remains REVIEW until the production verification gate is satisfied."
    };
  } catch (error) {
    state.search_calls_today += actualCalls;
    state.total_search_calls += actualCalls;
    state.last_run_at = new Date().toISOString();
    state.last_error = String(error?.message || error);
    await writeState(state);
    throw error;
  }
}
