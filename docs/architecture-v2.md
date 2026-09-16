# Dubroom server architecture v2

## Product decisions

- The first release accepts only a public YouTube video owned by the user.
- Direct file upload is deferred until the public-URL pipeline passes end-to-end testing.
- A watermark is not applied.
- All speech is presented as one chronological cue list. Speaker roles and diarization are not used.
- The original source is retained for 72 hours.
- Working assets and the finished MP4 are retained for one hour after the session is completed or abandoned.
- Active recording sessions extend the expiry of their working assets.
- The final MP4 replaces only the audio stream whenever the prepared video codec supports MP4 stream copy.

## System boundary

The browser captures microphone input and plays protected previews. All media analysis, storage,
normalization, scoring, mixing, and final output preparation run on the server.

The browser never receives ElevenLabs credentials or unrestricted object-storage credentials.
It receives only project-scoped API credentials and short-lived signed media URLs.

## Local-first runtime

The first working version runs on one local Windows PC:

- the existing web interface runs on the local development server;
- the v2 HTTP API and background worker run as local Node.js processes;
- project metadata is persisted locally;
- source media, stems, takes, and results are stored in a local data directory;
- the local worker invokes yt-dlp, FFmpeg, and FFprobe directly;
- only YouTube and ElevenLabs require outbound network access.

The current v2 backend and interface run together on one test server. Cloud services remain a
separate migration phase after the single-host flow and expected load have been validated.

The local storage, repository, and queue implementations use the same interfaces as the future
cloud implementations. This keeps the media pipeline unchanged when hosting moves to Yandex Cloud.

## Future Yandex Cloud components

- HTTP API: Yandex Serverless Containers or a small stateless Compute Cloud service.
- Media workers: Docker containers on Compute Cloud.
- Persistent metadata: Managed PostgreSQL.
- Media assets: private Object Storage buckets.
- Work dispatch: Message Queue with a dead-letter queue.
- Secrets: Lockbox.
- Logs and metrics: Cloud Logging and Monitoring.

GPU instances are not required while stem separation and transcription use ElevenLabs.

## Project state machine

```text
CREATED
  -> INGESTING
  -> EXTRACTING_AUDIO
  -> ANALYZING
  -> BUILDING_CUES
  -> READY_TO_DUB
  -> RECORDING
  -> FINALIZING
  -> READY

Any processing state may transition to FAILED.
FAILED jobs can be retried from the last idempotent completed stage.
```

`ANALYZING` contains two independent branches:

- `stems_status`: pending, running, ready, failed
- `transcript_status`: pending, running, ready, failed

The project enters `BUILDING_CUES` only when both branches are ready.

## Ingestion pipeline

1. Validate the source URL against the supported YouTube host allowlist.
2. Create the project and return a project-scoped secret token.
3. Download the source into a temporary worker directory and stream it into Object Storage.
4. Inspect streams with FFprobe and reject invalid duration, dimensions, or missing audio.
5. Prefer an H.264 video stream that can later be copied into MP4 without re-encoding.
6. If the source is not compatible, normalize it once during ingestion and cache the MP4.
7. Extract one lossless, fixed-rate audio master for all downstream timing operations.
8. Start ElevenLabs stem separation and speech-to-text concurrently.

YouTube ingestion is an isolated adapter behind a feature flag. The downloader must verify that
the video is publicly accessible before media processing starts. Direct upload will later use the
same pipeline after step 2 without changing downstream jobs or the recording interface.

## ElevenLabs integration

### Stem separation

- Endpoint: `POST /v1/music/stem-separation`
- Variation: `two_stems_v1`
- Required output: vocals and instrumental
- Prefer lossless PCM output when the subscription supports it.
- Validate the returned stem duration against the audio master, then pad or trim to the exact
  master duration without shifting time zero.

### Speech-to-text

- Endpoint: `POST /v1/speech-to-text`
- Model: `scribe_v2`
- Timestamp granularity: `word`
- Diarization: disabled
- Audio event tagging: disabled for cue construction
- Use the asynchronous webhook mode and correlate callbacks by internal project ID.

The mixed audio master is transcribed in parallel with stem separation. If transcript confidence
is below the configured threshold, the vocals stem is transcribed once as a fallback.

## Cue construction

Words are converted into a single chronological list. A new cue is created when any condition is
met:

- a sentence-ending punctuation mark is followed by a meaningful pause;
- the silence between words exceeds the configured threshold, initially 600 ms;
- the cue reaches 7 seconds;
- the display text would exceed two readable subtitle lines.

Very short neighboring cues are merged when the merged cue stays within those limits. Cue IDs are
stable UUIDs; the visible number is derived from chronological order. Editing text does not change
timings, and editing timing creates a new manifest revision.

## Recording clock

The one-second preparation areas are visual-only and are not saved in the take.

1. The browser obtains and warms the microphone stream before the countdown.
2. The preparation cursor runs for exactly one second using a monotonic clock.
3. At the cue boundary, the video fragment and retained audio capture start from the same clock
   transition.
4. Audio capture stops at the cue end.
5. The cursor continues through the one-second visual tail without recording.
6. The browser uploads the take with its cue ID, manifest revision, sample rate, measured duration,
   and clock diagnostics.

AudioWorklet PCM capture is the preferred implementation for deterministic timing and live waveform
drawing. MediaRecorder remains a fallback for browsers without the required Web Audio support.
The server trims or pads a take to the cue duration but never moves its cue start timestamp.

## Final audio assembly

For every cue, the server:

1. validates that the take belongs to the current manifest revision;
2. converts it to the project sample rate;
3. applies conservative loudness normalization and limiting;
4. trims or pads it to the cue duration;
5. places it at the cue start timestamp.

All takes are mixed with the instrumental stem. The final command maps the prepared video stream
with `-c:v copy`, encodes the new audio as AAC, and produces an MP4 with fast-start metadata.

Overlapping cues are mixed at their original timestamps. The output duration is locked to the
prepared source duration.

## Public API draft

```text
POST   /v1/projects
GET    /v1/projects/:projectId
DELETE /v1/projects/:projectId
GET    /v1/projects/:projectId/events

POST   /v1/projects/:projectId/source-upload
GET    /v1/projects/:projectId/manifest
PATCH  /v1/projects/:projectId/manifest

POST   /v1/projects/:projectId/takes/:cueId/upload
POST   /v1/projects/:projectId/takes/:cueId/complete
DELETE /v1/projects/:projectId/takes/:cueId

POST   /v1/projects/:projectId/finalize
GET    /v1/projects/:projectId/result
POST   /v1/projects/:projectId/heartbeat

POST   /v1/webhooks/elevenlabs/transcript
```

Large media bodies do not pass through the API service. Upload and download operations use
short-lived signed Object Storage URLs.

## Data model

- `projects`: source, state, retention, active manifest revision, timestamps, failure details.
- `assets`: object key, kind, content type, size, checksum, expiry, processing revision.
- `cues`: project, revision, order, start, end, text.
- `takes`: cue, revision, object key, duration, score, upload state.
- `jobs`: type, idempotency key, attempt count, queue state, progress, error.
- `job_events`: append-only user-visible progress history.

## Security and abuse controls

- No visible user login is required for the first version.
- Each project has a high-entropy scoped token that cannot access other projects.
- Project creation is rate-limited by IP and protected by an abuse challenge when thresholds are hit.
- URL redirects are revalidated and private network destinations are rejected.
- Workers run as non-root containers with CPU, memory, file-size, and execution-time limits.
- ElevenLabs and cloud credentials remain in Lockbox.
- Admin access uses a server-side session and an environment secret, never a password embedded in frontend code.

The single-host release implements the IP creation rate limit, protected admin session, scoped project
tokens, restart recovery, cache eviction, and configurable storage quotas. An abuse challenge and
Lockbox-backed secrets are deferred until public traffic justifies the cloud migration.

## Retention

- Reusable preparation cache (source and prepared video, separated background/voice, transcript,
  and cue timings): retain for 72 hours by default in storage separate from user projects.
- A complete user project, including takes and final MP4, expires one hour after its last heartbeat
  by default. Active processing jobs are not removed mid-stage.
- Retention, file-size, project-count, disk-volume, cache-volume, and worker-concurrency limits are
  persisted server settings managed through the protected admin panel.
- Final MP4: delete one hour after it becomes ready.
- Expired signed URLs cannot extend storage lifetime.
- Metadata retained for diagnostics must not include transcript text, source URLs, or media payloads.

## Migration order

1. Introduce the new API contracts and provider interfaces while the current local backend remains active.
2. Add persistent local storage, repository, and queue adapters.
3. Implement local ingestion, FFprobe validation, audio extraction, and idempotent jobs.
4. Add the ElevenLabs providers. Use synchronous transcription for the first local end-to-end test.
5. Add cue generation and manifest revisioning.
6. Replace the former local import flow with server projects while preserving the recording interface.
7. Replace MediaRecorder timing with the synchronized AudioWorklet engine and keep a fallback.
8. Implement server finalization and MP4 delivery.
9. Run local end-to-end tests with public YouTube videos.
10. Add direct file upload only after the local URL pipeline passes those tests.
11. Add Yandex Cloud adapters and deployment infrastructure as a separate later phase.
