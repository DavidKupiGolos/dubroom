const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

function cleanVideoId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

export function parsePublicYouTubeUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("invalid_youtube_url");
  }

  if (url.protocol !== "https:" || !youtubeHosts.has(url.hostname.toLowerCase())) {
    throw new Error("invalid_youtube_url");
  }

  let videoId = null;
  if (url.hostname.toLowerCase() === "youtu.be") {
    videoId = cleanVideoId(url.pathname.split("/").filter(Boolean)[0]);
  } else if (url.pathname === "/watch") {
    videoId = cleanVideoId(url.searchParams.get("v"));
  } else {
    const [kind, id] = url.pathname.split("/").filter(Boolean);
    if (["shorts", "live", "embed"].includes(kind)) videoId = cleanVideoId(id);
  }

  if (!videoId) throw new Error("invalid_youtube_url");
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
