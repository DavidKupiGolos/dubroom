const apiOrigin = "https://api.elevenlabs.io";

function requireApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("elevenlabs_api_key_missing");
  return key;
}

async function requireOk(response, fallback) {
  if (response.ok) return response;
  const detail = await response.text().catch(() => "");
  throw new Error(`${fallback}:${response.status}:${detail.slice(0, 500)}`);
}

export class ElevenLabsClient {
  constructor({ apiKey = process.env.ELEVENLABS_API_KEY, fetchImpl = fetch } = {}) {
    this.apiKey = requireApiKey(apiKey);
    this.fetch = fetchImpl;
  }

  async getSubscription() {
    const response = await requireOk(await this.fetch(new URL("/v1/user/subscription", apiOrigin), {
      headers: { "xi-api-key": this.apiKey },
    }), "elevenlabs_subscription_failed");
    return response.json();
  }

  async separateStems({ audio, fileName = "audio.wav", outputFormat = "mp3_44100_128" }) {
    const body = new FormData();
    body.append("file", audio, fileName);
    body.append("stem_variation_id", "two_stems_v1");
    const url = new URL("/v1/music/stem-separation", apiOrigin);
    url.searchParams.set("output_format", outputFormat);
    const response = await requireOk(await this.fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body,
    }), "elevenlabs_stems_failed");
    return new Uint8Array(await response.arrayBuffer());
  }

  async transcribe({ audio, fileName = "audio.wav", projectId, webhook = true, webhookId }) {
    const body = new FormData();
    body.append("file", audio, fileName);
    body.append("model_id", "scribe_v2");
    body.append("timestamps_granularity", "word");
    body.append("diarize", "false");
    body.append("tag_audio_events", "false");
    body.append("webhook", String(webhook));
    body.append("webhook_metadata", JSON.stringify({ projectId }));
    if (webhookId) body.append("webhook_id", webhookId);
    const response = await requireOk(await this.fetch(new URL("/v1/speech-to-text", apiOrigin), {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body,
    }), "elevenlabs_transcript_failed");
    return response.json();
  }
}
