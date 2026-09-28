const YOUTUBE_KEY_STORAGE = "worldwideCams.youtubeDataAPIKey";

export function storedYouTubeKey() {
  return String(localStorage.getItem(YOUTUBE_KEY_STORAGE) || "").trim();
}

export function youtubeRequestHeaders(url) {
  const value = String(url || "");
  const needsKey =
    value === "/api/status" ||
    value.startsWith("/api/youtube") ||
    value.startsWith("/api/cameras/youtube") ||
    value.startsWith("/api/camera/youtube-") ||
    value === "/api/cameras/probe";
  const key = storedYouTubeKey();
  return needsKey && key ? { "X-YouTube-API-Key": key } : {};
}

function setStoredYouTubeKey(value) {
  const key = String(value || "").trim();
  if (key) localStorage.setItem(YOUTUBE_KEY_STORAGE, key);
  else localStorage.removeItem(YOUTUBE_KEY_STORAGE);
}

function apiHeaders(url, json = false) {
  return {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...youtubeRequestHeaders(url)
  };
}

async function apiJson(url) {
  const response = await fetch(url, { headers: apiHeaders(url) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  return payload;
}

async function apiPostJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: apiHeaders(url, true),
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  return payload;
}

export function initYouTubeUI({
  map,
  addCameras,
  setMessage,
  normalizedLng,
  reloadProviders
}) {
  const els = {
    keyInput: document.querySelector("#youtube-key-input"),
    keySave: document.querySelector("#youtube-key-save"),
    keyClear: document.querySelector("#youtube-key-clear"),
    discover: document.querySelector("#youtube-discover"),
    review: document.querySelector("#youtube-review"),
    reviewCount: document.querySelector("#youtube-review-count"),
    dialog: document.querySelector("#youtube-review-dialog"),
    close: document.querySelector("#youtube-review-close"),
    list: document.querySelector("#youtube-review-list"),
    empty: document.querySelector("#youtube-review-empty"),
    active: document.querySelector("#youtube-review-active"),
    title: document.querySelector("#youtube-review-title"),
    meta: document.querySelector("#youtube-review-meta"),
    player: document.querySelector("#youtube-review-player"),
    watch: document.querySelector("#youtube-review-watch"),
    location: document.querySelector("#review-location"),
    visual: document.querySelector("#review-visual"),
    temporal: document.querySelector("#review-temporal"),
    scene: document.querySelector("#review-scene"),
    notes: document.querySelector("#review-notes"),
    reject: document.querySelector("#review-reject"),
    keep: document.querySelector("#review-keep"),
    accept: document.querySelector("#review-accept")
  };

  let candidates = [];
  let selected = null;

  function renderKeyState() {
    const configured = Boolean(storedYouTubeKey());
    els.keyInput.value = "";
    els.keyInput.placeholder = configured
      ? "YouTube key saved in this browser"
      : "YouTube Data API key";
    els.keySave.textContent = configured ? "Replace YouTube Key" : "Save YouTube Key";
    els.keyClear.hidden = !configured;
    els.discover.disabled = !configured;
  }

  async function updateReviewCount() {
    try {
      const payload = await apiJson("/api/youtube/diagnostics");
      els.reviewCount.textContent = String(payload.review || 0);
    } catch {
      els.reviewCount.textContent = "?";
    }
  }

  function discoveryRadiusKm() {
    const bounds = map.getBounds();
    const center = map.getCenter();
    const latSpanKm = Math.abs(bounds.getNorth() - bounds.getSouth()) * 111;
    const lonSpanKm = Math.abs(bounds.getEast() - bounds.getWest()) *
      111 * Math.max(0.15, Math.cos(center.lat * Math.PI / 180));
    return Math.max(5, Math.min(1000, Math.ceil(Math.hypot(latSpanKm, lonSpanKm) / 2)));
  }

  async function discoverHere() {
    if (!storedYouTubeKey()) {
      setMessage("Add a YouTube Data API key first.");
      return;
    }
    const center = map.getCenter();
    const old = els.discover.textContent;
    els.discover.disabled = true;
    els.discover.textContent = "Discovering…";
    setMessage("Searching the official YouTube Data API for currently-live, embeddable broadcasts near this map view…");
    try {
      const payload = await apiPostJson("/api/youtube/discover", {
        latitude: center.lat,
        longitude: normalizedLng(center.lng),
        radius_km: discoveryRadiusKm(),
        max_results: 25
      });
      await updateReviewCount();
      setMessage(
        "YouTube discovery found " + Number(payload.discovered || 0).toLocaleString() +
        " unique live candidate(s). They are in REVIEW and remain off the production globe until visual/temporal verification."
      );
    } catch (error) {
      setMessage("YouTube discovery failed: " + (error?.message || error));
    } finally {
      els.discover.textContent = old;
      els.discover.disabled = !storedYouTubeKey();
    }
  }

  function renderList() {
    els.list.replaceChildren();
    if (!candidates.length) {
      const empty = document.createElement("p");
      empty.className = "detail-place";
      empty.textContent = "No YouTube candidates are waiting for review.";
      els.list.append(empty);
      return;
    }

    for (const candidate of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "review-candidate";
      if (selected?.id === candidate.id) button.classList.add("selected");

      const title = document.createElement("strong");
      title.textContent = candidate.title || candidate.id;
      const meta = document.createElement("span");
      meta.textContent = [
        candidate.channel_title,
        candidate.location_precision,
        candidate.currently_live ? "LIVE" : "not live"
      ].filter(Boolean).join(" · ");

      button.append(title, meta);
      button.addEventListener("click", () => selectCandidate(candidate));
      els.list.append(button);
    }
  }

  function selectCandidate(candidate) {
    selected = candidate;
    renderList();
    els.empty.hidden = true;
    els.active.hidden = false;
    els.title.textContent = candidate.title || candidate.id;
    els.meta.textContent = [
      candidate.channel_title,
      candidate.location_name || candidate.nearby_place,
      candidate.location_precision ? "location: " + candidate.location_precision : "",
      candidate.geolocation_method
    ].filter(Boolean).join(" · ");

    if (candidate.player_url) {
      els.player.hidden = false;
      els.player.src = candidate.player_url;
    } else {
      els.player.hidden = true;
      els.player.removeAttribute("src");
    }
    els.watch.href = candidate.provider_detail_url || "https://www.youtube.com/";
    els.location.checked = false;
    els.visual.checked = false;
    els.temporal.checked = false;
    els.notes.value = "";
  }

  async function loadQueue() {
    const payload = await apiJson("/api/youtube/candidates?state=REVIEW&limit=250");
    candidates = payload.candidates || [];
    selected = null;
    els.active.hidden = true;
    els.empty.hidden = false;
    renderList();
    els.reviewCount.textContent = String(candidates.length);
  }

  async function openReview() {
    try {
      await loadQueue();
      els.dialog.showModal();
    } catch (error) {
      setMessage("Could not load YouTube review queue: " + (error?.message || error));
    }
  }

  async function submitReview(decision) {
    if (!selected) return;
    const id = selected.id;
    for (const button of [els.reject, els.keep, els.accept]) button.disabled = true;
    try {
      if (storedYouTubeKey()) {
        const refreshed = await apiPostJson(
          "/api/youtube/candidate/" + encodeURIComponent(id) + "/refresh",
          {}
        );
        selected = refreshed.candidate;
      }

      const payload = await apiPostJson(
        "/api/youtube/candidate/" + encodeURIComponent(id) + "/review",
        {
          decision,
          scene_type: els.scene.value,
          location_confirmed: els.location.checked,
          visual_confirmed: els.visual.checked,
          temporal_confirmed: els.temporal.checked,
          notes: els.notes.value
        }
      );

      if (payload.candidate?.candidate_state === "ACCEPT") {
        addCameras([payload.candidate]);
        setMessage("Verified YouTube camera admitted to the production globe.");
      }
      await loadQueue();
    } catch (error) {
      setMessage("YouTube review update failed: " + (error?.message || error));
    } finally {
      for (const button of [els.reject, els.keep, els.accept]) button.disabled = false;
    }
  }

  els.keySave.addEventListener("click", async () => {
    const key = els.keyInput.value.trim();
    if (!key) {
      setMessage("Paste a YouTube Data API key first.");
      return;
    }
    setStoredYouTubeKey(key);
    renderKeyState();
    setMessage("YouTube key saved in this browser. Testing provider status…");
    await reloadProviders();
    await updateReviewCount();
  });

  els.keyClear.addEventListener("click", async () => {
    setStoredYouTubeKey("");
    renderKeyState();
    setMessage("Browser YouTube key cleared. Existing verified records remain local; live rechecks require the key.");
    await reloadProviders();
  });

  els.keyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      els.keySave.click();
    }
  });

  els.discover.addEventListener("click", discoverHere);
  els.review.addEventListener("click", openReview);
  els.close.addEventListener("click", () => {
    els.player.removeAttribute("src");
    els.dialog.close();
  });
  els.dialog.addEventListener("close", () => {
    els.player.removeAttribute("src");
  });
  els.reject.addEventListener("click", () => submitReview("REJECT"));
  els.keep.addEventListener("click", () => submitReview("REVIEW"));
  els.accept.addEventListener("click", () => submitReview("ACCEPT"));

  renderKeyState();
  updateReviewCount();

  return {
    updateReviewCount,
    storedYouTubeKey
  };
}
