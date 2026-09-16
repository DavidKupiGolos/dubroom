# Dubroom preproduction handoff

This package contains source code only. It does not contain Git history, runtime data, build output, credentials, API keys, session tokens, passwords, or browser cookies.

## Secrets to provision

Create the runtime environment outside the application directory. Use `deploy/server.env.example` as the list of variables and provide these values through the preproduction secret store:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_WEBHOOK_ID`, when webhooks are enabled
- `DUBROOM_ADMIN_API_TOKEN`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_TOKEN`

Generate independent random values for preproduction. Do not reuse production credentials.

YouTube cookies are optional and must be provisioned separately as a Netscape-format file outside the repository. Point `DUBROOM_YOUTUBE_COOKIES_FILE` to that mounted file. Do not commit or add the cookie file to an application archive.

Recommended permissions on Linux:

```bash
chown root:dubroom /etc/dubroom/dubroom.env /etc/dubroom/youtube-cookies.txt
chmod 0640 /etc/dubroom/dubroom.env /etc/dubroom/youtube-cookies.txt
```

## Verification

```bash
npm ci
npm run build
node --test
```

After starting the services, verify:

```bash
curl --fail http://127.0.0.1:5180/v1/health/ready
```

The public reverse proxy must return `404` for `/v1/metrics`. Deployment templates and systemd units are in `deploy/`.

## Excluded content

- `.git/` and repository history
- `.env` and all private runtime configuration
- `private/` and YouTube cookies
- `node_modules/`, build output, caches, and coverage
- `work/`, `outputs/`, projects, recommendations, recordings, and rendered video
- local Windows executables and bundled media tools
