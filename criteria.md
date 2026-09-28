# Worldwide Cams release criteria

This file is the acceptance constitution for the YouTube Live + reliability release. Passing unit tests is necessary but not sufficient. Do not reduce scope, weaken tests, hard-code showcase cameras, or replace real integrations with mocks to make this file pass.

## Production invariant

A YouTube search result is never a production Worldwide Cams camera merely because its query, title, description, channel, tags, category, or thumbnail looks plausible.

A production YouTube camera must have all of the following:
- currently-live status revalidated through an official YouTube interface;
- supported playback through the normal YouTube watch experience or supported embed;
- defensible geography with precision/method disclosed;
- actual visual verification of the live broadcast;
- temporal verification sufficient to distinguish a persistent fixed/environmental viewpoint from a static image, broadcast cuts, or a continuously moving camera;
- a final ACCEPT decision;
- fresh health state.

REVIEW candidates never appear as ordinary production camera dots.

## Provider architecture

- Existing Caltrans, Windy, and custom public providers remain working.
- YouTube implements the same normalized camera shape and enters the same production map only after acceptance.
- Provider-specific logic stays behind provider/registry APIs; Jarvis-facing APIs do not require callers to branch on provider.
- The model supports future camera types, while this release admits only trustworthy fixed/environmental YouTube cameras to the fixed-camera layer.

## YouTube discovery

- Use the official YouTube Data API.
- Discovery requests use type=video and eventType=live.
- Prefer embeddable/syndicated public results where appropriate.
- Discovery uses a systematic family of webcam/location queries rather than one hard-coded query.
- Geographic discovery uses defensible location evidence. Approximate search-area placement must be labeled approximate.
- Do not scrape YouTube HTML, extract raw/protected stream URLs, discover private/unlisted content, or bypass YouTube playback.

## Classification and verification

Target pipeline:
1. live discovery
2. cheap metadata/provider-native filtering
3. geolocation plausibility
4. actual visual verification
5. temporal consistency
6. ACCEPT / REVIEW / REJECT
7. production registry

Metadata is evidence, not proof. A single thumbnail is not sufficient visual or temporal verification.

If official provider interfaces or provider policy do not permit the required automated visual evidence, the candidate must remain REVIEW. Do not silently substitute thumbnails or metadata and call the requirement passed.

## YouTube policy compliance

- YouTube API credentials are never committed or returned in API responses.
- Public non-authorized YouTube API metadata is deleted or refreshed before 30 days.
- The app exposes its privacy disclosure, YouTube Terms link, and Google Privacy link.
- The app preserves normal YouTube playback controls and attribution.
- Any derived content categorization/metrics requiring YouTube approval remain disabled unless the operator has the required approval.
- Provider/API restrictions are blockers to acceptance, not permission to weaken the production invariant.

## Health and reliability

- Track at least live/recently verified, temporarily unavailable, stale, permanently unavailable/removed, and unknown where provider evidence supports the distinction.
- Ended/deleted broadcasts must leave the active production set.
- Keep bounded health history.
- Prefer recently verified working cameras over dead/stale cameras.
- Existing Caltrans unavailable-placeholder detection remains working.
- Provider failures are visible in diagnostics.

## Deduplication and ranking

Before this release is complete:
- detect likely duplicate physical cameras across providers using geography and available source identity;
- preserve alternate authorized provider sources;
- rank candidate views using current health, geographic relevance, freshness, provider reliability, and verification state;
- do not let a dead camera outrank a working alternative merely because it is slightly closer.

## Unified API

Before completion, expose provider-agnostic equivalents of:
- cameras.near(lat, lon, radius)
- cameras.search(place)
- cameras.bestView(lat, lon)
- camera.get(id)
- camera.health(id)

Jarvis/World Armor consumes normalized camera records rather than provider branches.

## UI

- Accepted YouTube cameras appear on the existing OSM globe, not a separate map.
- Provider filters include YouTube, Windy, DOT/public agency, and other providers.
- Camera detail shows provider, attribution, health, location precision, and supported playback.
- REVIEW candidates stay out of the normal globe and have a dedicated review/diagnostic surface.
- Search works across providers without requiring the user to know the provider.

## Observability

Diagnostics must expose, when the corresponding stages exist:
- YouTube live candidates discovered;
- provider-native/metadata rejections;
- visual rejections;
- mobile-camera rejections;
- geolocation rejections;
- REVIEW count;
- accepted YouTube webcam count;
- currently verified-live count;
- unavailable count;
- API quota/errors;
- cameras by provider and geography;
- last discovery run;
- last health run;
- meaningful rejection reasons.

## Adversarial tests

The classifier/verification corpus must include positives such as urban street, skyline, beach, harbor, airport, ski, wildlife, and weather cameras, and difficult negatives such as music/animation streams, gaming, news, podcasts, creator face-cams, walking/driving streams, static-image streams, and prerecorded-looking loops.

Do not mark this criterion complete until the real verification mechanism exists; metadata-only mocks do not count.

## Real-world acceptance

Do not declare the release complete until real external tests demonstrate:
- YouTube API authentication works;
- multiple real currently-live candidates are discovered without hard-coded video IDs;
- obvious unrelated livestreams do not enter production;
- accepted cameras have actual visual verification;
- temporal verification exists for at least some accepted cameras;
- mobile walking/driving streams do not enter the fixed-camera layer;
- accepted cameras have defensible coordinates;
- accepted YouTube cameras render on the existing globe and play through supported YouTube playback;
- ended/deleted/unavailable broadcasts are detected;
- geographically distant searches include Los Angeles, New York, London, Tokyo, Sydney or Melbourne, plus one dynamically selected location;
- existing providers still work;
- the normalized API can choose the best available camera without the caller knowing the provider;
- production map entries come from real provider data.

## Current implementation status

Implemented:
- official YouTube Data API request-scoped credential path;
- currently-live + embeddable + syndicated geographic discovery;
- persistent REVIEW candidate registry with <30-day metadata expiry;
- resumable, quota-bounded global discovery grid with persistent cursor/state;
- generic normalized provider registry for provider-agnostic camera lookup;
- production admission gate;
- manual visual/temporal review surface using supported YouTube playback;
- accepted-camera production feed and live-status recheck;
- provider filter and YouTube map rendering for accepted cameras;
- request-key secrecy tests and metadata-only anti-cheat test.

Not yet sufficient for release completion:
- compliant automated visual classifier over actual live imagery;
- automated temporal frame analysis;
- unattended scheduling of the resumable global discovery worker when a durable server credential is configured;
- deduplication/failover graph;
- provider-agnostic near/search/bestView API;
- full adversarial real-world classifier corpus and acceptance run;
- measured precision/false-positive metrics.

The project is therefore intentionally not marked complete.
