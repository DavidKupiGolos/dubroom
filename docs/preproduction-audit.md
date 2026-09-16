# Dubroom: pre-production audit

## Current architecture

The current release is a single-host application with two Node.js processes:

- the web process renders the studio and proxies protected administrator requests;
- the media API owns project metadata, local files, the processing queue, FFmpeg, yt-dlp, and ElevenLabs calls;
- project, cache, and recommendation manifests are persisted as atomic JSON files;
- reusable YouTube preparation is cached separately from one-hour user projects;
- recommendations are permanent and are prepared once when an administrator adds them.

This shape is suitable for a one-server pre-production environment with one or two concurrent users. It is not yet suitable for multiple API replicas or a distributed worker pool.

## Completed hardening

- Startup verifies the pipeline mode, executable availability, writable storage, and required real-mode secrets before recovering jobs.
- Liveness and readiness are separate: `/v1/health/live` checks the process, while `/v1/health/ready` returns `503` when dependencies are unavailable.
- Existing `/v1/health` remains compatible with monitoring and returns sanitized diagnostics.
- Shutdown stops accepting queue work and waits for accepted work until the service manager's hard timeout.
- Malformed JSON is a `400` response, untrusted origins are rejected, and rate-limit memory is pruned.
- Unexpected HTTP failures return `server_error` plus a request ID instead of exposing internal details.
- Pipeline failures expose stable public codes and keep technical details in server-side diagnostics.
- Pipeline stages have persistent job records. Restart recovery reuses valid download, prepared video, master audio, stems, transcript, and final render files instead of restarting the whole pipeline.
- Stems and transcription persist independently, so one completed ElevenLabs branch is not repeated when the other branch fails or the API restarts.
- Project media, recorded takes, and final MP4 files use path-scoped, expiring HMAC URLs. The project secret is no longer accepted or emitted as a query parameter.
- Media responses and the web document use a no-referrer policy to reduce signed URL exposure.
- Admin authentication fails closed when the password or persistent session token is missing.
- The production environment template no longer contains a password-like default.
- Nginx applies small defaults plus route-specific request limits, upload timeouts, connection limits, project-creation throttling, and byte-range forwarding for media.
- The server exposes total and free filesystem capacity, reserves a configurable amount of free disk, rejects new writes with `507` when the reserve is reached, and marks readiness as degraded.
- A daily systemd timer archives permanent recommendations, categories, posters, prepared media, and server settings. Each archive has a checksum and is extracted into a temporary directory for restore and JSON validation.
- API, web, and backup services use baseline systemd hardening and restrictive file creation permissions.
- Safe local and YouTube stages use bounded exponential retry configured from the administrator settings. ElevenLabs stages are never retried automatically, avoiding an uncontrolled duplicate provider charge.
- Exhausted jobs persist as dead letters, survive restart, appear in the administrator dashboard with their stage and diagnostic, and can be resumed from already persisted outputs.
- A loopback metrics endpoint exposes queue age, job states, failures, storage, disk capacity, and uptime. Nginx blocks public access, while a systemd timer checks readiness and dead letters every minute.
- Large recommendation MP4 uploads already stream through the web proxy and media API to disk instead of being materialized in Node.js memory.
- Server tests, lint errors, and production compilation are clean.

## Required before public pre-production

1. Copy verified backups to storage outside the application server and connect systemd/metrics failures to an external notification channel. A local archive and journal entry do not protect against loss of the host or guarantee that somebody sees an alert.
2. Add end-to-end deployment tests against a Linux host with real Nginx and systemd units.
3. Provider-level exactly-once billing cannot be guaranteed if the process dies after a provider accepts a request but before the response is persisted. Add provider idempotency keys if ElevenLabs exposes them for these endpoints.

## Next architectural phase

- Split the current large project service into project orchestration, recommendation orchestration, retention, and media asset services.
- Move recursive storage accounting and cleanup out of request handlers into a periodic storage index.
- Centralize duplicated admin API proxy code and response validation in the web process.
- Add end-to-end tests against Nginx and the production process definitions, including restart during every pipeline stage.

PostgreSQL, object storage, and a distributed queue are not required for the first single-server pre-production release. They become necessary when the application needs multiple workers, horizontal scaling, or stronger durability guarantees.
