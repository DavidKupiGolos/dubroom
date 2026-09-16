"use client";
/* eslint-disable jsx-a11y/media-has-caption */

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Heart,
  LoaderCircle,
  Menu,
  MessageCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Settings,
  Square,
  Phone,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Cue = {
  id: string;
  serverId?: string;
  start: number;
  end: number;
  text: string;
  character?: string;
  referenceUrl?: string;
};

type MediaPlayer = HTMLElement & {
  currentTime: number;
  duration: number;
  muted: boolean;
  paused: boolean;
  src: string;
  play: () => Promise<void>;
  pause: () => void;
};

type Take = {
  blob: Blob;
  url: string;
  score?: number;
};

type RecordingPhase = "idle" | "preparing" | "recording" | "finishing";
type TimelineMode = "idle" | "full" | "original" | "recording" | "take";

type ServerRenderJob = {
  id: string;
  signature: string;
  preparation: Promise<void>;
  takeUploads: Map<string, Promise<void>>;
};

type WaveformData = {
  duration: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
  rms: number[];
};

type LocalProjectSession = {
  id: string;
  token: string;
};

type LocalProjectState = {
  id: string;
  state: string;
  progress: number;
  error: string | null;
};

type LocalManifest = {
  projectId: string;
  revision: number;
  title: string;
  duration: number;
  cues: Array<{ id: string; start: number; end: number; text: string }>;
  videoUrl: string;
  instrumentalUrl: string | null;
  vocalsUrl: string | null;
  takeUrls: Record<string, string>;
  resultUrl: string | null;
};

type Recommendation = {
  id: string;
  title: string;
  duration: number;
  videoUrl: string;
  posterUrl: string | null;
  shareUrl: string;
  categoryId: string | null;
};

type RecommendationCategory = {
  id: string;
  name: string;
};

const demoCues: Cue[] = [
  { id: "01", start: 12.84, end: 17.42, text: "Мы не должны были заходить так далеко." },
  { id: "02", start: 18.22, end: 24.51, text: "Поздно. Сигнал уже поймал нас." },
  { id: "03", start: 24.51, end: 28.86, text: "Тогда держись ближе к свету." },
];

const scoreApi = process.env.NEXT_PUBLIC_SCORE_API ?? "http://127.0.0.1:5179";
const renderApi = process.env.NEXT_PUBLIC_RENDER_API ?? scoreApi;
const projectApi = (process.env.NEXT_PUBLIC_PROJECT_API ?? "").replace(/\/$/, "");
const preparationSeconds = 1;
const liveWaveformBucketCount = 720;

function formatTime(value: number, detailed = false) {
  if (!Number.isFinite(value)) return detailed ? "00:00.000" : "00:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const milliseconds = Math.floor((value % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${detailed ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
}

function localProjectErrorMessage(value: string) {
  const messages: Record<string, string> = {
    youtube_auth_required: "YouTube запросил подтверждение входа. Подключите cookies YouTube в локальных настройках.",
    youtube_video_not_public: "Видео недоступно публично или требует входа.",
    elevenlabs_api_key_missing: "Не найден ключ ElevenLabs в локальном .env.",
    elevenlabs_paid_plan_required: "Разделение дорожек ElevenLabs недоступно на бесплатном тарифе. Подключите платный тариф ElevenLabs.",
    elevenlabs_stems_failed: "ElevenLabs не смог разделить исходную аудиодорожку.",
    elevenlabs_transcript_failed: "ElevenLabs не смог получить субтитры и тайминги.",
    source_duration_limit_exceeded: "Видео длиннее разрешённого лимита. Проверьте лимит длительности в админ-панели.",
    source_size_limit_exceeded: "Исходное видео превышает допустимый размер.",
    project_rate_limited: "Создано слишком много проектов за минуту. Подождите и повторите попытку.",
    project_limit_reached: "На сервере достигнут лимит проектов.",
    storage_limit_reached: "На сервере закончилось доступное место для проектов.",
    recommendation_not_found: "Рекомендация больше недоступна.",
  };
  return messages[value] ?? value;
}

function analyzeAudioBuffer(buffer: AudioBuffer, startSeconds = 0, endSeconds = buffer.duration): WaveformData {
  const startSample = Math.max(0, Math.min(buffer.length, Math.floor(startSeconds * buffer.sampleRate)));
  const endSample = Math.max(startSample + 1, Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate)));
  const segmentDuration = Math.max(0.001, (endSample - startSample) / buffer.sampleRate);
  const bucketCount = Math.min(900, Math.max(360, Math.ceil(segmentDuration * 180)));
  const peaks = new Array<number>(bucketCount).fill(0);
  const rms = new Array<number>(bucketCount).fill(0);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = startSample + Math.floor((bucket / bucketCount) * (endSample - startSample));
    const end = Math.max(start + 1, startSample + Math.floor(((bucket + 1) / bucketCount) * (endSample - startSample)));
    let peak = 0;
    let squareSum = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample += 1) {
        const value = channel[sample] ?? 0;
        peak = Math.max(peak, Math.abs(value));
        squareSum += value * value;
        sampleCount += 1;
      }
    }
    peaks[bucket] = peak;
    rms[bucket] = sampleCount ? Math.sqrt(squareSum / sampleCount) : 0;
  }

  return { duration: segmentDuration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, peaks, rms };
}

function encodeMonoWav(chunks: Float32Array[], sampleRate: number) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let outputOffset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index] ?? 0));
      view.setInt16(outputOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      outputOffset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function getCueWindow(cue: Cue) {
  // Preparation is visual-only and must not be clipped at media boundaries.
  const cueDuration = Math.max(0.1, cue.end - cue.start);
  const start = cue.start - preparationSeconds;
  const end = cue.end + preparationSeconds;
  return {
    start,
    end,
    duration: cueDuration + preparationSeconds * 2,
    leadIn: preparationSeconds,
    leadOut: preparationSeconds,
    cueDuration,
  };
}

function getFragmentPositionForMedia(cue: Cue, mediaTime: number) {
  const cueWindow = getCueWindow(cue);
  return Math.min(cueWindow.duration, Math.max(0, mediaTime - cueWindow.start));
}

function getRenderSignature(video: File, mediaDuration: number, renderCues: Cue[], backing: Blob | null) {
  const cueSignature = renderCues.map((cue) => `${cue.id}:${cue.start.toFixed(3)}:${cue.end.toFixed(3)}`).join("|");
  return `${video.name}:${video.size}:${mediaDuration.toFixed(3)}:${backing?.size ?? 0}:${cueSignature}`;
}

export default function Home() {
  const videoRef = useRef<MediaPlayer | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureModeRef = useRef<"worklet" | "media-recorder" | null>(null);
  const captureWorkletContextRef = useRef<AudioContext | null>(null);
  const captureWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const captureWorkletSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureWorkletGainRef = useRef<GainNode | null>(null);
  const captureWorkletChunksRef = useRef<Float32Array[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingCueRef = useRef<Cue | null>(null);
  const recordingPhaseRef = useRef<RecordingPhase>("idle");
  const timelineModeRef = useRef<TimelineMode>("idle");
  const recordingPhaseStartedAtRef = useRef(0);
  const recordingWindowStartedAtRef = useRef(0);
  const pendingTakeRef = useRef<{ cue: Cue; blob: Blob } | null>(null);
  const finishAudioCaptureRef = useRef<() => void>(() => undefined);
  const stopTimerRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawWaveformRef = useRef<() => void>(() => undefined);
  const micVisualizationContextRef = useRef<AudioContext | null>(null);
  const micVisualizationSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micSamplesRef = useRef<Float32Array | null>(null);
  const liveWaveformPeaksRef = useRef<number[]>([]);
  const liveWaveformLastIndexRef = useRef(-1);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const takePlaybackCueRef = useRef<Cue | null>(null);
  const originalPreviewContextRef = useRef<AudioContext | null>(null);
  const originalPreviewTimerRef = useRef<number | null>(null);
  const originalPreviewStartedAtRef = useRef<number | null>(null);
  const originalPreviewPreviousMutedRef = useRef<boolean | null>(null);
  const playbackEndRef = useRef<number | null>(null);
  const fullPlaybackPositionRef = useRef<number | null>(null);
  const renderPreviewRef = useRef<HTMLElement>(null);
  const serverRenderJobRef = useRef<ServerRenderJob | null>(null);
  const renderJobGenerationRef = useRef(0);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [backingTrack, setBackingTrack] = useState<Blob | null>(null);
  const [referenceTrack, setReferenceTrack] = useState<Blob | null>(null);
  const [referenceWaveform, setReferenceWaveform] = useState<WaveformData | null>(null);
  const [takeWaveform, setTakeWaveform] = useState<WaveformData | null>(null);
  const [subtitleName, setSubtitleName] = useState("ДЕМО-СЦЕНАРИЙ");
  const [cues, setCues] = useState<Cue[]>(demoCues);
  const [activeCueId, setActiveCueId] = useState(demoCues[1].id);
  const [takes, setTakes] = useState<Record<string, Take>>({});
  const [currentTime, setCurrentTime] = useState(0);
  const [fragmentPosition, setFragmentPosition] = useState(preparationSeconds);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [takePlaying, setTakePlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
  const [scoringCueId, setScoringCueId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [preparingProject, setPreparingProject] = useState(false);
  const [projectProgress, setProjectProgress] = useState(0);
  const [projectStage, setProjectStage] = useState("Ожидание загрузки");
  const [videoFailed, setVideoFailed] = useState(false);
  const [renderUrl, setRenderUrl] = useState("");
  const [renderFileName, setRenderFileName] = useState("dubroom-dub.mp4");
  const [renderProgress, setRenderProgress] = useState(0);
  const [, setRenderBackendStatus] = useState("ОЖИДАНИЕ ВИДЕО");
  const [, setNotice] = useState("Вставьте ссылку на публичное YouTube-видео, чтобы начать.");
  const [youtubeSourceUrl, setYoutubeSourceUrl] = useState("");
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationCategories, setRecommendationCategories] = useState<RecommendationCategory[]>([]);
  const [activeRecommendationCategoryId, setActiveRecommendationCategoryId] = useState("all");
  const [selectingRecommendationId, setSelectingRecommendationId] = useState<string | null>(null);
  const [canScrollRecommendationsLeft, setCanScrollRecommendationsLeft] = useState(false);
  const [canScrollRecommendationsRight, setCanScrollRecommendationsRight] = useState(false);
  const [localProjectSession, setLocalProjectSession] = useState<LocalProjectSession | null>(null);
  const [localManifestRevision, setLocalManifestRevision] = useState(1);
  const recommendationQueryHandledRef = useRef(false);
  const recommendationScrollerRef = useRef<HTMLDivElement | null>(null);
  const playerStateRef = useRef({
    activeCue: demoCues[1] as Cue | undefined,
    muted: false,
    playing: false,
    takePlaying: false,
    recording: false,
    rendering: false,
  });

  const activeCue = useMemo(
    () => cues.find((cue) => cue.id === activeCueId) ?? cues[0],
    [activeCueId, cues],
  );

  const visibleRecommendationCategories = useMemo(
    () => recommendationCategories.filter((category) => recommendations.some((recommendation) => recommendation.categoryId === category.id)),
    [recommendationCategories, recommendations],
  );
  const effectiveRecommendationCategoryId = activeRecommendationCategoryId === "all"
    || visibleRecommendationCategories.some((category) => category.id === activeRecommendationCategoryId)
    ? activeRecommendationCategoryId
    : "all";
  const filteredRecommendations = useMemo(
    () => effectiveRecommendationCategoryId === "all"
      ? recommendations
      : recommendations.filter((recommendation) => recommendation.categoryId === effectiveRecommendationCategoryId),
    [effectiveRecommendationCategoryId, recommendations],
  );

  function updateRecommendationScrollState() {
    const scroller = recommendationScrollerRef.current;
    if (!scroller) return;
    setCanScrollRecommendationsLeft(scroller.scrollLeft > 2);
    setCanScrollRecommendationsRight(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2);
  }

  function scrollRecommendations(direction: -1 | 1) {
    const scroller = recommendationScrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(240, scroller.clientWidth * 0.85), behavior: "smooth" });
  }

  const activeReferenceUrl = activeCue?.referenceUrl;
  const activeTakeBlob = activeCue ? takes[activeCue.id]?.blob : undefined;
  const visibleCue = useMemo(
    () => activeCue
      && currentTime >= activeCue.start
      && currentTime < activeCue.end
      && (playing || recording || takePlaying || currentTime < activeCue.end - 0.05)
      ? activeCue
      : undefined,
    [activeCue, currentTime, playing, recording, takePlaying],
  );

  useEffect(() => {
    playerStateRef.current = { activeCue, muted, playing, takePlaying, recording, rendering };
  }, [activeCue, muted, playing, recording, rendering, takePlaying]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${projectApi}/v1/recommendations`, { cache: "no-store" });
        const payload = await response.json() as { recommendations?: Recommendation[]; categories?: RecommendationCategory[] };
        if (!cancelled && response.ok) {
          setRecommendations(payload.recommendations ?? []);
          setRecommendationCategories(payload.categories ?? []);
        }
      } catch {
        if (!cancelled) {
          setRecommendations([]);
          setRecommendationCategories([]);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const scroller = recommendationScrollerRef.current;
    if (!scroller) return;
    scroller.scrollLeft = 0;
    const frame = window.requestAnimationFrame(updateRecommendationScrollState);
    window.addEventListener("resize", updateRecommendationScrollState);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateRecommendationScrollState);
    };
  }, [effectiveRecommendationCategoryId, filteredRecommendations.length]);

  useEffect(() => {
    if (recommendationQueryHandledRef.current || !recommendations.length || preparingProject) return;
    const recommendationId = new URLSearchParams(window.location.search).get("recommendation");
    if (!recommendationId) return;
    const recommendation = recommendations.find((item) => item.id === recommendationId);
    recommendationQueryHandledRef.current = true;
    if (recommendation) void selectRecommendation(recommendation);
  }, [preparingProject, recommendations]);

  useEffect(() => {
    if (localProjectSession || preparingProject || !videoFile || duration <= 0 || !cues.length) return;
    const signature = getRenderSignature(videoFile, duration, cues, backingTrack);
    if (serverRenderJobRef.current?.signature === signature) return;
    void prepareServerRender(videoFile, backingTrack, cues, duration, signature);
  }, [backingTrack, cues, duration, preparingProject, localProjectSession, videoFile]);

  useEffect(() => {
    if (!localProjectSession) return;
    const timer = window.setInterval(() => {
      void fetch(`${projectApi}/v1/projects/${encodeURIComponent(localProjectSession.id)}/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localProjectSession.token}` },
      }).catch(() => undefined);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [localProjectSession]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const rawSession = localStorage.getItem("dubroom-local-project") || sessionStorage.getItem("dubroom-local-project");
      if (!rawSession) return;
      try {
        const session = JSON.parse(rawSession) as LocalProjectSession;
        if (!session.id || !session.token) throw new Error("invalid_local_session");
        localStorage.setItem("dubroom-local-project", rawSession);
        sessionStorage.removeItem("dubroom-local-project");
        setLocalProjectSession(session);
        setPreparingProject(true);
        setProjectStage("Восстановление локального проекта");
        void watchLocalProject(session)
          .catch(() => {
            localStorage.removeItem("dubroom-local-project");
            setLocalProjectSession(null);
          })
          .finally(() => setPreparingProject(false));
      } catch {
        localStorage.removeItem("dubroom-local-project");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    previewAudioRef.current?.pause();
    if (originalPreviewTimerRef.current) window.clearTimeout(originalPreviewTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (originalPreviewContextRef.current?.state !== "closed") void originalPreviewContextRef.current?.close();
    if (micVisualizationContextRef.current?.state !== "closed") void micVisualizationContextRef.current?.close();
    captureWorkletNodeRef.current?.port.postMessage({ type: "stop" });
    if (captureWorkletContextRef.current?.state !== "closed") void captureWorkletContextRef.current?.close();
  }, []);

  useEffect(() => {
    if (!playing && !recording && !takePlaying) return;
    let animationFrame = 0;
    let previousUpdate = 0;
    const updatePosition = (timestamp: number) => {
      if (timestamp - previousUpdate >= 16) {
        previousUpdate = timestamp;
        const takeAudio = previewAudioRef.current;
        const takeCue = takePlaybackCueRef.current;
        if (takePlaying && takeAudio && takeCue) {
          const cueWindow = getCueWindow(takeCue);
          const audioDuration = Number.isFinite(takeAudio.duration) && takeAudio.duration > 0
            ? takeAudio.duration
            : cueWindow.cueDuration;
          const takeProgress = Math.min(1, Math.max(0, takeAudio.currentTime / audioDuration));
          const speechElapsed = takeProgress * cueWindow.cueDuration;
          setCurrentTime(takeCue.start + speechElapsed);
          setFragmentPosition(cueWindow.leadIn + speechElapsed);
          animationFrame = window.requestAnimationFrame(updatePosition);
          return;
        }
        const video = videoRef.current;
        if (!video) {
          animationFrame = window.requestAnimationFrame(updatePosition);
          return;
        }
        const cue = recordingCueRef.current;
        const phase = recordingPhaseRef.current;
        if (recording && cue && phase !== "idle") {
          const cueWindow = getCueWindow(cue);
          const elapsed = Math.max(0, (performance.now() - recordingWindowStartedAtRef.current) / 1000);
          const phaseLimit = phase === "preparing" ? cueWindow.leadIn : cueWindow.duration;
          const timelineElapsed = Math.min(phaseLimit, elapsed);
          const syntheticTime = cueWindow.start + timelineElapsed;
          setCurrentTime(syntheticTime);
          setFragmentPosition(timelineElapsed);
          if (phase === "recording") captureLiveWaveform(elapsed - cueWindow.leadIn, cueWindow.cueDuration);
          if (phase === "recording" && elapsed >= cueWindow.leadIn + cueWindow.cueDuration) {
            finishAudioCaptureRef.current();
          }
          animationFrame = window.requestAnimationFrame(updatePosition);
          return;
        }
        if (recording) {
          animationFrame = window.requestAnimationFrame(updatePosition);
          return;
        }
        const playbackEnd = playbackEndRef.current;
        const originalStartedAt = originalPreviewStartedAtRef.current;
        const playbackCue = playerStateRef.current.activeCue;
        if (playbackEnd !== null && originalStartedAt !== null && playbackCue) {
          const cueWindow = getCueWindow(playbackCue);
          const speechElapsed = Math.min(cueWindow.cueDuration, Math.max(0, (performance.now() - originalStartedAt) / 1000));
          setCurrentTime(playbackCue.start + speechElapsed);
          setFragmentPosition(cueWindow.leadIn + speechElapsed);
          if (speechElapsed >= cueWindow.cueDuration) {
            video.pause();
            video.currentTime = playbackCue.end;
            playbackEndRef.current = null;
            originalPreviewStartedAtRef.current = null;
            timelineModeRef.current = "idle";
            setCurrentTime(playbackCue.end);
            setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
          }
        } else if (timelineModeRef.current !== "full") {
          animationFrame = window.requestAnimationFrame(updatePosition);
          return;
        } else if (!recording && playbackEnd !== null && video.currentTime >= playbackEnd) {
          video.pause();
          video.currentTime = playbackEnd;
          playbackEndRef.current = null;
          setCurrentTime(playbackEnd);
          if (playbackCue) {
            const cueWindow = getCueWindow(playbackCue);
            setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
          }
        } else {
          setCurrentTime(video.currentTime);
          if (playbackCue) {
            const rawPosition = getFragmentPositionForMedia(playbackCue, video.currentTime);
            const nextPosition = Math.max(fullPlaybackPositionRef.current ?? rawPosition, rawPosition);
            fullPlaybackPositionRef.current = nextPosition;
            setFragmentPosition(nextPosition);
          }
        }
      }
      animationFrame = window.requestAnimationFrame(updatePosition);
    };
    animationFrame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [duration, playing, recording, takePlaying]);

  useEffect(() => {
    let cancelled = false;
    const context = new AudioContext();

    void (async () => {
      await Promise.resolve();
      if (!cancelled) {
        setReferenceWaveform(null);
        setTakeWaveform(null);
      }
      const decodeUrl = async (url: string) => analyzeAudioBuffer(await context.decodeAudioData(await fetch(url).then((response) => response.arrayBuffer())));
      const decodeBlob = async (blob: Blob) => analyzeAudioBuffer(await context.decodeAudioData(await blob.arrayBuffer()));
      const decodeReferenceTrack = async (blob: Blob, cue: Cue) => analyzeAudioBuffer(
        await context.decodeAudioData(await blob.arrayBuffer()),
        cue.start,
        cue.end,
      );
      const [reference, take] = await Promise.all([
        activeReferenceUrl
          ? decodeUrl(activeReferenceUrl).catch(() => null)
          : referenceTrack && activeCue
            ? decodeReferenceTrack(referenceTrack, activeCue).catch(() => null)
            : Promise.resolve(null),
        activeTakeBlob ? decodeBlob(activeTakeBlob).catch(() => null) : Promise.resolve(null),
      ]);
      if (!cancelled) {
        setReferenceWaveform(reference);
        setTakeWaveform(take);
      }
      if (context.state !== "closed") await context.close();
    })();

    return () => {
      cancelled = true;
      if (context.state !== "closed") void context.close();
    };
  }, [activeCue, activeReferenceUrl, activeTakeBlob, referenceTrack]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const cueWindow = activeCue ? getCueWindow(activeCue) : { start: 0, end: 1, duration: 1, leadIn: 0, leadOut: 0, cueDuration: 1 };
      const center = height / 2;
      const amplitude = Math.max(1, center - 14);
      const gridStep = cueWindow.duration > 8 ? 1 : cueWindow.duration > 4 ? 0.5 : 0.25;

      context.lineWidth = 1;
      for (let second = 0; second <= cueWindow.duration; second += gridStep) {
        const x = (second / cueWindow.duration) * width;
        const major = Math.round(second / gridStep) % 2 === 0;
        context.strokeStyle = major ? "rgba(92, 225, 230, .16)" : "rgba(92, 225, 230, .07)";
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, 0);
        context.lineTo(Math.round(x) + 0.5, height);
        context.stroke();
      }

      [0.25, 0.5, 0.75].forEach((position) => {
        const y = Math.round(height * position) + 0.5;
        context.strokeStyle = position === 0.5 ? "rgba(213, 255, 252, .18)" : "rgba(213, 255, 252, .07)";
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      });

      const speechStartX = (cueWindow.leadIn / cueWindow.duration) * width;
      const speechEndX = ((cueWindow.leadIn + cueWindow.cueDuration) / cueWindow.duration) * width;
      context.fillStyle = "rgba(241, 184, 74, .055)";
      context.fillRect(0, 0, speechStartX, height);
      context.fillRect(speechEndX, 0, Math.max(0, width - speechEndX), height);

      [speechStartX, speechEndX].forEach((x) => {
        context.save();
        context.setLineDash([5, 4]);
        context.strokeStyle = "rgba(239, 103, 87, .95)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, 0);
        context.lineTo(Math.round(x) + 0.5, height);
        context.stroke();
        context.restore();
      });

      const drawPeaks = (peaks: number[], lastIndex: number, color: string, fillColor: string, offset: number, signalDuration: number) => {
        if (!peaks.length || lastIndex < 0) return;
        const signalStartX = (offset / cueWindow.duration) * width;
        const signalEndX = ((offset + signalDuration) / cueWindow.duration) * width;
        const xForIndex = (index: number) => signalStartX + (index / Math.max(1, peaks.length - 1)) * (signalEndX - signalStartX);
        const visibleLastIndex = Math.min(lastIndex, peaks.length - 1);
        const yForIndex = (index: number, direction: -1 | 1) => {
          const value = peaks[index] ?? 0;
          return center + direction * Math.min(1, Math.pow(value, 0.72) * 1.35) * amplitude;
        };

        context.beginPath();
        for (let index = 0; index <= visibleLastIndex; index += 1) {
          const x = xForIndex(index);
          const y = yForIndex(index, -1);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        for (let index = visibleLastIndex; index >= 0; index -= 1) {
          context.lineTo(xForIndex(index), yForIndex(index, 1));
        }
        context.closePath();
        context.fillStyle = fillColor;
        context.fill();

        for (const direction of [-1, 1] as const) {
          context.beginPath();
          for (let index = 0; index <= visibleLastIndex; index += 1) {
            const x = xForIndex(index);
            const y = yForIndex(index, direction);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.strokeStyle = color;
          context.lineWidth = 1;
          context.stroke();
        }
      };
      const drawSignal = (data: WaveformData | null, color: string, fillColor: string, offset: number, signalDuration: number) => {
        if (!data) return;
        drawPeaks(data.peaks, data.peaks.length - 1, color, fillColor, offset, signalDuration);
      };
      drawSignal(referenceWaveform, "rgba(238, 91, 184, .96)", "rgba(238, 91, 184, .16)", cueWindow.leadIn, cueWindow.cueDuration);
      if (recording) {
        drawPeaks(liveWaveformPeaksRef.current, liveWaveformLastIndexRef.current, "rgba(92, 225, 230, .98)", "rgba(92, 225, 230, .18)", cueWindow.leadIn, cueWindow.cueDuration);
      } else {
        drawSignal(takeWaveform, "rgba(92, 225, 230, .98)", "rgba(92, 225, 230, .18)", cueWindow.leadIn, cueWindow.cueDuration);
      }
    };

    drawWaveformRef.current = draw;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (drawWaveformRef.current === draw) drawWaveformRef.current = () => undefined;
    };
  }, [activeCue, duration, recording, referenceWaveform, takeWaveform]);


  function clearRenderResult() {
    setRenderUrl((current) => {
      if (current.startsWith("blob:")) URL.revokeObjectURL(current);
      return "";
    });
  }

  async function prepareServerRender(sourceVideo: File, backing: Blob | null, renderCues: Cue[], mediaDuration: number, signature: string) {
    const generation = ++renderJobGenerationRef.current;
    const previousJob = serverRenderJobRef.current;
    serverRenderJobRef.current = null;
    if (previousJob) {
      void fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(previousJob.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    setRenderBackendStatus("ФОНОВАЯ ПОДГОТОВКА");
    try {
      const startResponse = await fetch(`${renderApi}/api/render/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoName: sourceVideo.name,
          duration: mediaDuration,
          cues: renderCues.map((cue) => ({ id: cue.id, start: cue.start, end: cue.end })),
        }),
      });
      if (!startResponse.ok) throw new Error("render_job_start_failed");
      const started = await startResponse.json() as { jobId: string };
      if (generation !== renderJobGenerationRef.current) {
        void fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(started.jobId)}`, { method: "DELETE" }).catch(() => undefined);
        return null;
      }

      const job: ServerRenderJob = {
        id: started.jobId,
        signature,
        preparation: Promise.resolve(),
        takeUploads: new Map(),
      };
      job.preparation = Promise.all([
        fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/video`, {
          method: "PUT",
          headers: { "Content-Type": sourceVideo.type || "application/octet-stream", "X-File-Name": encodeURIComponent(sourceVideo.name) },
          body: sourceVideo,
        }).then((response) => { if (!response.ok) throw new Error("video_upload_failed"); }),
        backing ? fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/backing`, {
          method: "PUT",
          headers: { "Content-Type": backing.type || "application/octet-stream" },
          body: backing,
        }).then((response) => { if (!response.ok) throw new Error("backing_upload_failed"); }) : Promise.resolve(),
      ]).then(() => undefined);
      serverRenderJobRef.current = job;
      await job.preparation;
      if (generation === renderJobGenerationRef.current) setRenderBackendStatus("MP4 ПОДГОТОВЛЕН В ФОНЕ");
      return job;
    } catch {
      if (generation === renderJobGenerationRef.current) {
        serverRenderJobRef.current = null;
        setRenderBackendStatus("СЕРВЕР НЕ ЗАПУЩЕН");
      }
      return null;
    }
  }

  function queueTakeUpload(job: ServerRenderJob, cue: Cue, blob: Blob) {
    const previousUpload = job.takeUploads.get(cue.id) ?? job.preparation;
    const upload = previousUpload.then(async () => {
      const response = await fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/takes/${encodeURIComponent(cue.id)}`, {
        method: "PUT",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!response.ok) throw new Error("take_upload_failed");
    });
    job.takeUploads.set(cue.id, upload);
    return upload;
  }

  function uploadTakeInBackground(cue: Cue, blob: Blob) {
    const job = serverRenderJobRef.current;
    if (!job) return;
    void queueTakeUpload(job, cue, blob).catch(() => setRenderBackendStatus("СЕРВЕР НЕ ЗАПУЩЕН"));
  }

  async function renderVideoOnServer(sourceVideo: File, recordedTakes: Record<string, Take>) {
    const signature = getRenderSignature(sourceVideo, duration, cues, backingTrack);
    let job = serverRenderJobRef.current?.signature === signature ? serverRenderJobRef.current : null;
    if (!job) job = await prepareServerRender(sourceVideo, backingTrack, cues, duration, signature);
    if (!job) return false;

    setRendering(true);
    clearRenderResult();
    setRenderProgress(1);
    setNotice("Завершаю быструю сборку MP4.");
    try {
      await job.preparation;
      await Promise.all(cues.map((cue) => queueTakeUpload(job, cue, recordedTakes[cue.id].blob)));
      const completeResponse = await fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/complete`, { method: "POST" });
      if (!completeResponse.ok) throw new Error("render_start_failed");

      let outputName = `${sourceVideo.name.replace(/\.[^.]+$/, "")}-dub.mp4`;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        const statusResponse = await fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/status`, { cache: "no-store" });
        if (!statusResponse.ok) throw new Error("render_status_failed");
        const status = await statusResponse.json() as { status: string; progress: number; error?: string; outputName?: string | null };
        setRenderProgress(status.progress ?? 0);
        setNotice(`Сборка MP4: ${status.progress ?? 0}%.`);
        if (status.status === "failed") throw new Error(status.error || "ffmpeg_failed");
        if (status.status !== "ready") continue;
        if (status.outputName) outputName = status.outputName;
        break;
      }
      if (renderProgress < 100 && Date.now() >= deadline) throw new Error("render_timeout");

      const outputResponse = await fetch(`${renderApi}/api/render/jobs/${encodeURIComponent(job.id)}/output`);
      if (!outputResponse.ok) throw new Error("render_download_failed");
      const outputBlob = await outputResponse.blob();
      const url = URL.createObjectURL(new Blob([outputBlob], { type: "video/mp4" }));
      setRenderUrl((current) => {
        if (current.startsWith("blob:")) URL.revokeObjectURL(current);
        return url;
      });
      setRenderFileName(outputName);
      setRenderProgress(100);
      setRendering(false);
      setRenderBackendStatus("MP4 ГОТОВ");
      setNotice("MP4 готов. Проверьте видео перед скачиванием.");
      window.setTimeout(() => renderPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return true;
    } catch {
      setRendering(false);
      setRenderProgress(0);
      setRenderBackendStatus("ПЕРЕХОД В РЕЗЕРВНЫЙ РЕЖИМ");
      return false;
    }
  }

  function selectCue(cue: Cue) {
    stopPreviewPlayback();
    setActiveCueId(cue.id);
    const video = videoRef.current;
    if (video && videoFile) {
      video.pause();
      video.currentTime = cue.start;
      setCurrentTime(cue.start);
    }
    setFragmentPosition(getCueWindow(cue).leadIn);
  }

  function loadVideo(file: File) {
    if (!file.type.startsWith("video/")) {
      setNotice("Сервер не вернул поддерживаемый видеофайл.");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(file);
    setVideoFile(file);
    setReferenceTrack(null);
    setVideoUrl(url);
    clearRenderResult();
    setRenderProgress(0);
    setRenderFileName(`${file.name.replace(/\.[^.]+$/, "")}-dub.mp4`);
    setCurrentTime(0);
    setVideoFailed(false);
    setNotice(`Видео подключено: ${file.name}`);
  }

  function absoluteProjectUrl(value: string) {
    const baseUrl = projectApi || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return new URL(value, baseUrl).toString();
  }

  async function loadLocalManifest(session: LocalProjectSession) {
    const response = await fetch(`${projectApi}/v1/projects/${encodeURIComponent(session.id)}/manifest`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    });
    const payload = await response.json() as { manifest?: LocalManifest; error?: string };
    if (!response.ok || !payload.manifest) throw new Error(payload.error || "manifest_load_failed");
    const manifest = payload.manifest;
    setProjectStage("Загрузка подготовленного видео");
    setProjectProgress(96);
    const [videoResponse, instrumentalResponse, vocalsResponse] = await Promise.all([
      fetch(absoluteProjectUrl(manifest.videoUrl)),
      manifest.instrumentalUrl ? fetch(absoluteProjectUrl(manifest.instrumentalUrl)) : Promise.resolve(null),
      manifest.vocalsUrl ? fetch(absoluteProjectUrl(manifest.vocalsUrl)) : Promise.resolve(null),
    ]);
    if (!videoResponse.ok) throw new Error("prepared_video_load_failed");
    if (instrumentalResponse && !instrumentalResponse.ok) throw new Error("instrumental_load_failed");
    if (vocalsResponse && !vocalsResponse.ok) throw new Error("vocals_load_failed");
    const videoBlob = await videoResponse.blob();
    const instrumental = instrumentalResponse ? await instrumentalResponse.blob() : null;
    const vocals = vocalsResponse ? await vocalsResponse.blob() : null;
    const restoredTakeEntries = await Promise.all(Object.entries(manifest.takeUrls || {}).map(async ([cueId, takeUrl]) => {
      const takeResponse = await fetch(absoluteProjectUrl(takeUrl));
      if (!takeResponse.ok) throw new Error(`take_restore_failed:${cueId}`);
      return [cueId, await takeResponse.blob()] as const;
    }));
    const safeTitle = manifest.title.replace(/[<>:"/\\|?*]+/g, "-").trim() || "youtube-video";
    loadVideo(new File([videoBlob], `${safeTitle}.mp4`, { type: "video/mp4" }));
    setBackingTrack(instrumental);
    setReferenceTrack(vocals);
    setLocalManifestRevision(manifest.revision || 1);
    Object.values(takes).forEach((take) => URL.revokeObjectURL(take.url));
    const nextCues = manifest.cues.map((cue, index) => ({
      ...cue,
      serverId: cue.id,
      id: String(index + 1).padStart(2, "0"),
    }));
    const visibleCueIds = new Map(nextCues.map((cue) => [cue.serverId, cue.id]));
    setTakes(Object.fromEntries(restoredTakeEntries.map(([serverCueId, blob]) => {
      const visibleId = visibleCueIds.get(serverCueId) ?? serverCueId;
      return [visibleId, { blob, url: URL.createObjectURL(blob) }];
    })));
    setCues(nextCues);
    setActiveCueId(nextCues[0]?.id ?? "");
    setSubtitleName(manifest.title.toUpperCase());
    setProjectProgress(100);
    setProjectStage("Проект готов к озвучке");
    setRenderBackendStatus("ЛОКАЛЬНЫЙ ПРОЕКТ ГОТОВ");
    if (manifest.resultUrl) {
      setRenderUrl(absoluteProjectUrl(manifest.resultUrl));
      setRenderFileName(`${safeTitle}-dub.mp4`);
      setRenderProgress(100);
    }
    setNotice(`Видео подготовлено: ${manifest.title}, ${nextCues.length} реплик.`);
  }

  async function watchLocalProject(session: LocalProjectSession) {
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const statusResponse = await fetch(`${projectApi}/v1/projects/${encodeURIComponent(session.id)}`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: "no-store",
      });
      const statusPayload = await statusResponse.json() as { project?: LocalProjectState; error?: string };
      if (!statusResponse.ok || !statusPayload.project) throw new Error(statusPayload.error || "project_status_failed");
      const project = statusPayload.project;
      setProjectProgress(project.progress ?? 0);
      const stageNames: Record<string, string> = {
        CREATED: "Проект поставлен в очередь",
        INGESTING: "Загрузка публичного видео",
        EXTRACTING_AUDIO: "Извлечение аудиодорожки",
        ANALYZING: "Разделение звука и распознавание речи",
        BUILDING_CUES: "Формирование реплик",
        READY_TO_DUB: "Подготовка студии",
        RECORDING: "Восстановление записанных дублей",
        FINALIZING: "Сборка готового MP4",
        READY: "Готовое видео собрано",
      };
      setProjectStage(stageNames[project.state] ?? project.state);
      setNotice(`${stageNames[project.state] ?? "Подготовка проекта"}: ${project.progress ?? 0}%.`);
      if (project.state === "FAILED") throw new Error(project.error || "project_failed");
      if (["READY_TO_DUB", "RECORDING", "READY"].includes(project.state)) {
        await loadLocalManifest(session);
        return project;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    throw new Error("project_timeout");
  }

  async function startServerProject(input: Record<string, unknown>, startingNotice: string) {
    if (preparingProject) return false;
    setPreparingProject(true);
    setProjectStage("Создание локального проекта");
    setProjectProgress(1);
    setNotice(startingNotice);
    const previousSession = localProjectSession;
    try {
      const response = await fetch(`${projectApi}/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const created = await response.json() as { project?: LocalProjectState; token?: string; error?: string };
      if (!response.ok || !created.project || !created.token) throw new Error(created.error || "project_create_failed");
      const session = { id: created.project.id, token: created.token };
      if (previousSession && previousSession.id !== session.id) {
        void fetch(`${projectApi}/v1/projects/${encodeURIComponent(previousSession.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${previousSession.token}` },
        }).catch(() => undefined);
      }
      clearRenderResult();
      setLocalProjectSession(session);
      localStorage.setItem("dubroom-local-project", JSON.stringify(session));
      await watchLocalProject(session);
      return true;
    } catch (error) {
      const message = error instanceof Error ? localProjectErrorMessage(error.message) : "Не удалось подготовить видео.";
      if (previousSession) {
        setLocalProjectSession(previousSession);
        localStorage.setItem("dubroom-local-project", JSON.stringify(previousSession));
        setProjectProgress(100);
        setRenderBackendStatus("ПРЕЖНИЙ ПРОЕКТ СОХРАНЁН");
        setNotice(`Новое видео не подготовлено: ${message} Текущий проект сохранён.`);
      } else {
        setLocalProjectSession(null);
        setProjectProgress(0);
        setRenderBackendStatus("ЛОКАЛЬНЫЙ API НЕДОСТУПЕН");
        setNotice(`Не удалось подготовить видео: ${message}`);
      }
      return false;
    } finally {
      setPreparingProject(false);
    }
  }

  async function startYoutubeProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!youtubeSourceUrl.trim()) return;
    await startServerProject(
      { sourceUrl: youtubeSourceUrl.trim(), rightsAccepted: true },
      "Создаю проект и проверяю публичное видео...",
    );
  }

  async function selectRecommendation(recommendation: Recommendation) {
    if (preparingProject) return;
    setSelectingRecommendationId(recommendation.id);
    const selected = await startServerProject(
      { recommendationId: recommendation.id },
      `Подготавливаю рекомендацию «${recommendation.title}»...`,
    );
    setSelectingRecommendationId(null);
    if (selected) {
      window.history.replaceState({}, "", window.location.pathname);
      document.querySelector(".workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!videoFile || !video) {
      setNotice("Сначала подготовьте YouTube-видео.");
      return;
    }
    stopPreviewPlayback();
    if (video.paused) {
      if (duration > 0 && video.currentTime >= duration - 0.05) {
        video.currentTime = 0;
        setCurrentTime(0);
      }
      playbackEndRef.current = null;
      const rawPosition = activeCue ? getFragmentPositionForMedia(activeCue, video.currentTime) : 0;
      const startPosition = rawPosition;
      fullPlaybackPositionRef.current = startPosition;
      setFragmentPosition(startPosition);
      timelineModeRef.current = "full";
      setNotice("Воспроизведение полного видео.");
      void video.play().catch(() => {
        timelineModeRef.current = "idle";
        setNotice("Браузер не разрешил запустить видео.");
      });
    }
    else {
      playbackEndRef.current = null;
      timelineModeRef.current = "idle";
      fullPlaybackPositionRef.current = null;
      video.pause();
    }
  }

  function stopPreviewPlayback() {
    if (timelineModeRef.current === "original" || timelineModeRef.current === "take") {
      videoRef.current?.pause();
    }
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    takePlaybackCueRef.current = null;
    setTakePlaying(false);
    if (originalPreviewTimerRef.current) window.clearTimeout(originalPreviewTimerRef.current);
    originalPreviewTimerRef.current = null;
    originalPreviewStartedAtRef.current = null;
    const context = originalPreviewContextRef.current;
    originalPreviewContextRef.current = null;
    if (context?.state !== "closed") void context?.close();
    restoreMasterMute();
    playbackEndRef.current = null;
    timelineModeRef.current = "idle";
    fullPlaybackPositionRef.current = null;
  }

  function restoreMasterMute() {
    const previousMuted = originalPreviewPreviousMutedRef.current;
    if (previousMuted === null) return;
    originalPreviewPreviousMutedRef.current = null;
    const video = videoRef.current;
    if (video) video.muted = previousMuted;
    setMuted(previousMuted);
  }

  async function playOriginalFragment() {
    const video = videoRef.current;
    if (!videoFile || !video || !activeCue) {
      setNotice("Сначала подготовьте YouTube-видео.");
      return;
    }
    stopPreviewPlayback();
    video.pause();
    video.currentTime = activeCue.start;
    setCurrentTime(activeCue.start);
    const cueWindow = getCueWindow(activeCue);
    setFragmentPosition(cueWindow.leadIn);
    timelineModeRef.current = "original";
    originalPreviewStartedAtRef.current = Number.POSITIVE_INFINITY;
    playbackEndRef.current = activeCue.end;
    setNotice(`Готовлю оригинальный фрагмент реплики ${activeCue.id}...`);

    if (localProjectSession) {
      try {
        originalPreviewPreviousMutedRef.current = video.muted;
        video.muted = false;
        setMuted(false);
        await video.play();
        originalPreviewStartedAtRef.current = performance.now();
        setNotice(`Оригинальный фрагмент реплики ${activeCue.id}.`);
        originalPreviewTimerRef.current = window.setTimeout(() => {
          video.pause();
          video.currentTime = activeCue.end;
          playbackEndRef.current = null;
          originalPreviewStartedAtRef.current = null;
          timelineModeRef.current = "idle";
          setCurrentTime(activeCue.end);
          setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
          restoreMasterMute();
          originalPreviewTimerRef.current = null;
        }, cueWindow.cueDuration * 1000 + 100);
      } catch {
        restoreMasterMute();
        playbackEndRef.current = null;
        timelineModeRef.current = "idle";
        setNotice("Браузер не разрешил запустить оригинальный фрагмент.");
      }
      return;
    }

    const context = new AudioContext();
    originalPreviewContextRef.current = context;
    try {
      await context.resume();
      const backingPromise = backingTrack
        ? backingTrack.arrayBuffer().then((data) => context.decodeAudioData(data)).catch(() => null)
        : Promise.resolve(null);
      const referencePromise = activeCue.referenceUrl
        ? fetch(activeCue.referenceUrl).then((response) => response.arrayBuffer()).then((data) => context.decodeAudioData(data)).catch(() => null)
        : Promise.resolve(null);
      const [backingBuffer, referenceBuffer] = await Promise.all([backingPromise, referencePromise]);
      if (originalPreviewContextRef.current !== context) {
        if (context.state !== "closed") await context.close();
        return;
      }

      const fragmentDuration = cueWindow.cueDuration;
      const sources: AudioBufferSourceNode[] = [];
      if (backingBuffer && activeCue.start < backingBuffer.duration) {
        const source = context.createBufferSource();
        source.buffer = backingBuffer;
        source.connect(context.destination);
        sources.push(source);
      }
      if (referenceBuffer) {
        const source = context.createBufferSource();
        source.buffer = referenceBuffer;
        source.connect(context.destination);
        sources.push(source);
      }

      const hasMixedAudio = sources.length > 0;
      if (hasMixedAudio) {
        originalPreviewPreviousMutedRef.current = video.muted;
        video.muted = true;
        setMuted(true);
      }
      await video.play();
      originalPreviewStartedAtRef.current = performance.now();
      const startAt = context.currentTime;
      let sourceIndex = 0;
      if (backingBuffer && activeCue.start < backingBuffer.duration) {
        sources[sourceIndex].start(startAt, activeCue.start, Math.min(fragmentDuration, backingBuffer.duration - activeCue.start));
        sourceIndex += 1;
      }
      if (referenceBuffer) {
        sources[sourceIndex].start(startAt, 0, Math.min(fragmentDuration, referenceBuffer.duration));
      }
      setNotice(`Оригинальный фрагмент реплики ${activeCue.id}.`);
      originalPreviewTimerRef.current = window.setTimeout(() => {
        if (originalPreviewContextRef.current === context) {
          originalPreviewContextRef.current = null;
          if (context.state !== "closed") void context.close();
        }
        originalPreviewStartedAtRef.current = null;
        timelineModeRef.current = "idle";
        const currentVideo = videoRef.current;
        if (currentVideo && playbackEndRef.current === activeCue.end) {
          currentVideo.pause();
          currentVideo.currentTime = activeCue.end;
          playbackEndRef.current = null;
          setCurrentTime(activeCue.end);
          setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
        }
        restoreMasterMute();
        originalPreviewTimerRef.current = null;
      }, fragmentDuration * 1000 + 100);
    } catch {
      if (originalPreviewContextRef.current === context) originalPreviewContextRef.current = null;
      originalPreviewStartedAtRef.current = null;
      timelineModeRef.current = "idle";
      if (context.state !== "closed") void context.close();
      restoreMasterMute();
      playbackEndRef.current = null;
      setNotice("Браузер не разрешил запустить оригинальный фрагмент.");
    }
  }

  async function playTake(cue: Cue) {
    const take = takes[cue.id];
    if (!take) return;
    stopPreviewPlayback();
    const video = videoRef.current;
    video?.pause();
    if (video) video.currentTime = cue.start;
    setCurrentTime(cue.start);
    const cueWindow = getCueWindow(cue);
    setFragmentPosition(cueWindow.leadIn);
    timelineModeRef.current = "take";
    const audio = new Audio(take.url);
    previewAudioRef.current = audio;
    takePlaybackCueRef.current = cue;
    audio.onended = () => {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        takePlaybackCueRef.current = null;
        timelineModeRef.current = "idle";
        setTakePlaying(false);
        setCurrentTime(cue.end);
        setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
      }
    };
    setNotice(`Прослушивание дубля ${cue.id}.`);
    try {
      await audio.play();
      setTakePlaying(true);
    } catch {
      if (previewAudioRef.current === audio) previewAudioRef.current = null;
      takePlaybackCueRef.current = null;
      timelineModeRef.current = "idle";
      setTakePlaying(false);
      setNotice("Не удалось воспроизвести записанный дубль.");
    }
  }

  function moveCue(direction: -1 | 1) {
    if (direction === 1 && activeCue && !takes[activeCue.id]) {
      setNotice("Сначала запишите текущую реплику.");
      return;
    }
    const index = Math.max(0, cues.findIndex((cue) => cue.id === activeCueId));
    const targetCue = cues[Math.min(cues.length - 1, Math.max(0, index + direction))];
    selectCue(targetCue);
    setNotice(`Фрагмент ${targetCue.id} выбран.`);
  }

  async function scoreTake(cue: Cue, blob: Blob) {
    setScoringCueId(cue.id);
    const form = new FormData();
    form.append("audio", blob, `take-${cue.id}.webm`);
    form.append("cue_id", cue.id);
    form.append("text", cue.text);
    try {
      const response = await fetch(`${scoreApi}/api/score`, { method: "POST", body: form });
      if (!response.ok) throw new Error("Score service unavailable");
      const result = await response.json() as { score: number };
      setTakes((current) => ({ ...current, [cue.id]: { ...current[cue.id], score: result.score } }));
      setNotice(`Дубль ${cue.id} оценён: ${result.score} из 100.`);
    } catch {
      setTakes((current) => ({ ...current, [cue.id]: { ...current[cue.id], score: 100 } }));
      setNotice("Локальный оценщик не отвечает. Показана демо-оценка 100.");
    } finally {
      setScoringCueId(null);
    }
  }

  async function saveTake(cue: Cue, blob: Blob) {
    const url = URL.createObjectURL(blob);
    setTakes((current) => {
      if (current[cue.id]) URL.revokeObjectURL(current[cue.id].url);
      return { ...current, [cue.id]: { blob, url } };
    });
    if (localProjectSession) {
      try {
        const response = await fetch(`${projectApi}/v1/projects/${encodeURIComponent(localProjectSession.id)}/takes/${encodeURIComponent(cue.serverId ?? cue.id)}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${localProjectSession.token}`,
            "Content-Type": blob.type || "audio/webm",
            "X-Take-Duration": String(Math.max(0.1, cue.end - cue.start)),
            "X-Manifest-Revision": String(localManifestRevision),
          },
          body: blob,
        });
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) throw new Error(payload?.error || "take_upload_failed");
      } catch (error) {
        setNotice(error instanceof Error ? `Дубль сохранён в браузере, но не отправлен: ${error.message}` : "Не удалось отправить дубль.");
        return;
      }
    } else {
      uploadTakeInBackground(cue, blob);
    }
    await scoreTake(cue, blob);
    const cueIndex = cues.findIndex((item) => item.id === cue.id);
    const isLastCue = cueIndex === cues.length - 1;
    setNotice(isLastCue
      ? `Дубль ${cue.id} сохранён. Можно прослушать его или собрать готовое видео.`
      : `Дубль ${cue.id} сохранён. Текущий фрагмент остаётся активным.`);
  }

  function stopMicVisualization(clearWaveform = false) {
    micVisualizationSourceRef.current?.disconnect();
    micVisualizationSourceRef.current = null;
    micAnalyserRef.current = null;
    micSamplesRef.current = null;
    const context = micVisualizationContextRef.current;
    micVisualizationContextRef.current = null;
    if (context?.state !== "closed") void context?.close();
    if (clearWaveform) {
      liveWaveformPeaksRef.current = [];
      liveWaveformLastIndexRef.current = -1;
      drawWaveformRef.current();
    }
  }

  function startMicVisualization(stream: MediaStream) {
    stopMicVisualization(true);
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;
    source.connect(analyser);
    micVisualizationContextRef.current = context;
    micVisualizationSourceRef.current = source;
    micAnalyserRef.current = analyser;
    micSamplesRef.current = new Float32Array(analyser.fftSize);
    liveWaveformPeaksRef.current = Array.from({ length: liveWaveformBucketCount }, () => 0);
    liveWaveformLastIndexRef.current = -1;
    void context.resume();
  }

  function captureLiveWaveform(speechElapsed: number, cueDuration: number) {
    if (speechElapsed < 0 || cueDuration <= 0) return;
    const analyser = micAnalyserRef.current;
    const samples = micSamplesRef.current;
    const peaks = liveWaveformPeaksRef.current;
    if (!analyser || !samples || !peaks.length) return;
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    const bucket = Math.min(peaks.length - 1, Math.floor((Math.min(cueDuration, speechElapsed) / cueDuration) * (peaks.length - 1)));
    const previousBucket = liveWaveformLastIndexRef.current;
    if (bucket > previousBucket) {
      for (let index = previousBucket + 1; index <= bucket; index += 1) peaks[index] = peak;
      liveWaveformLastIndexRef.current = bucket;
    } else {
      peaks[bucket] = Math.max(peaks[bucket] ?? 0, peak);
    }
    drawWaveformRef.current();
  }

  function setRecordingStage(phase: RecordingPhase) {
    recordingPhaseRef.current = phase;
    recordingPhaseStartedAtRef.current = performance.now();
    setRecordingPhase(phase);
  }

  function cleanupCaptureWorklet() {
    const node = captureWorkletNodeRef.current;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    captureWorkletSourceRef.current?.disconnect();
    captureWorkletGainRef.current?.disconnect();
    captureWorkletNodeRef.current = null;
    captureWorkletSourceRef.current = null;
    captureWorkletGainRef.current = null;
    captureWorkletChunksRef.current = [];
    const context = captureWorkletContextRef.current;
    captureWorkletContextRef.current = null;
    if (context?.state !== "closed") void context?.close();
  }

  function completeAudioBlob(cue: Cue, blob: Blob) {
    pendingTakeRef.current = { cue, blob };
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    cleanupCaptureWorklet();
    captureModeRef.current = null;
    const elapsed = performance.now() - recordingPhaseStartedAtRef.current;
    const remaining = Math.max(0, preparationSeconds * 1000 - elapsed);
    stopTimerRef.current = window.setTimeout(() => finishPostRoll(cue, blob), remaining);
  }

  async function prepareWorkletCapture(stream: MediaStream, cue: Cue) {
    if (typeof AudioWorkletNode === "undefined") return false;
    const context = new AudioContext();
    try {
      await context.audioWorklet.addModule("/audio-capture-worklet.js");
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "dubroom-pcm-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(node).connect(silentGain).connect(context.destination);
      captureWorkletContextRef.current = context;
      captureWorkletSourceRef.current = source;
      captureWorkletNodeRef.current = node;
      captureWorkletGainRef.current = silentGain;
      captureWorkletChunksRef.current = [];
      node.port.onmessage = (event) => {
        if (event.data?.type === "chunk" && event.data.samples instanceof Float32Array) {
          captureWorkletChunksRef.current.push(event.data.samples);
          return;
        }
        if (event.data?.type !== "stopped") return;
        if (recordingPhaseRef.current === "recording") finishAudioCaptureRef.current();
        const blob = encodeMonoWav(captureWorkletChunksRef.current, Number(event.data.sampleRate) || context.sampleRate);
        completeAudioBlob(cue, blob);
      };
      await context.resume();
      captureModeRef.current = "worklet";
      return true;
    } catch {
      if (context.state !== "closed") await context.close();
      cleanupCaptureWorklet();
      return false;
    }
  }

  function finishPostRoll(cue: Cue, blob: Blob) {
    if (recordingPhaseRef.current !== "finishing") return;
    const video = videoRef.current;
    if (video) video.currentTime = cue.start;
    setCurrentTime(cue.start);
    setFragmentPosition(getCueWindow(cue).leadIn);
    stopTimerRef.current = null;
    pendingTakeRef.current = null;
    recordingCueRef.current = null;
    recorderRef.current = null;
    setRecordingStage("idle");
    setRecording(false);
    timelineModeRef.current = "idle";
    void saveTake(cue, blob);
  }

  function finishAudioCapture() {
    if (recordingPhaseRef.current !== "recording") return;
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    const cue = recordingCueRef.current;
    const video = videoRef.current;
    if (cue) captureLiveWaveform(cue.end - cue.start, cue.end - cue.start);
    stopMicVisualization();
    if (cue && video) {
      const cueWindow = getCueWindow(cue);
      recordingWindowStartedAtRef.current = performance.now() - (cueWindow.leadIn + cueWindow.cueDuration) * 1000;
      video.pause();
      video.currentTime = cue.end;
      setCurrentTime(cue.end);
      setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
    }
    setRecordingStage("finishing");
    setNotice(`Реплика ${cue?.id ?? ""} записана. Завершающая секунда...`);
    if (captureModeRef.current === "worklet") {
      captureWorkletNodeRef.current?.port.postMessage({ type: "stop" });
    } else {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  finishAudioCaptureRef.current = finishAudioCapture;

  function stopRecording() {
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    if (recordingPhaseRef.current === "recording") {
      finishAudioCapture();
      return;
    }
    if (recordingPhaseRef.current === "finishing") return;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopMicVisualization(true);
    const cancelledRecorder = recorderRef.current;
    if (cancelledRecorder) {
      cancelledRecorder.ondataavailable = null;
      cancelledRecorder.onstart = null;
      cancelledRecorder.onstop = null;
      if (cancelledRecorder.state === "recording") cancelledRecorder.stop();
    }
    if (captureModeRef.current === "worklet") captureWorkletNodeRef.current?.port.postMessage({ type: "stop" });
    cleanupCaptureWorklet();
    captureModeRef.current = null;
    const cancelledCue = recordingCueRef.current;
    const video = videoRef.current;
    video?.pause();
    if (cancelledCue) {
      if (video) video.currentTime = cancelledCue.start;
      setCurrentTime(cancelledCue.start);
      setFragmentPosition(getCueWindow(cancelledCue).leadIn);
    }
    recorderRef.current = null;
    recordingCueRef.current = null;
    pendingTakeRef.current = null;
    setRecordingStage("idle");
    setRecording(false);
    timelineModeRef.current = "idle";
    setNotice("Подготовка к записи отменена.");
  }

  async function startRecording() {
    const cue = activeCue;
    const video = videoRef.current;
    if (!videoFile || !video) {
      setNotice("Сначала подготовьте YouTube-видео.");
      return;
    }
    if (!cue) return;
    try {
      stopPreviewPlayback();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      recordingCueRef.current = cue;
      timelineModeRef.current = "recording";
      startMicVisualization(stream);
      const cueWindow = getCueWindow(cue);
      const usesWorklet = await prepareWorkletCapture(stream, cue);
      let recorder: MediaRecorder | null = null;
      if (!usesWorklet) {
        recorder = new MediaRecorder(stream);
        const chunks: BlobPart[] = [];
        captureModeRef.current = "media-recorder";
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstart = () => {
          if (recordingPhaseRef.current !== "preparing" || recordingCueRef.current?.id !== cue.id) return;
          recordingWindowStartedAtRef.current = performance.now() - cueWindow.leadIn * 1000;
          setRecordingStage("recording");
          setCurrentTime(cue.start);
          setFragmentPosition(cueWindow.leadIn);
          setNotice(`Запись реплики ${cue.id}. Говорите сейчас.`);
          stopTimerRef.current = window.setTimeout(finishAudioCapture, Math.max(300, cueWindow.cueDuration * 1000));
          if (!videoFailed) void video.play().catch(() => setNotice(`Запись реплики ${cue.id} идёт по кадру. Говорите сейчас.`));
        };
        recorder.onstop = () => {
          const type = recorder?.mimeType || "audio/webm";
          completeAudioBlob(cue, new Blob(chunks, { type }));
        };
      }
      const beginWorkletCapture = () => {
        if (recordingPhaseRef.current !== "preparing" || recordingCueRef.current?.id !== cue.id) return;
        recordingWindowStartedAtRef.current = performance.now() - cueWindow.leadIn * 1000;
        setRecordingStage("recording");
        setCurrentTime(cue.start);
        setFragmentPosition(cueWindow.leadIn);
        setNotice(`Запись реплики ${cue.id}. Говорите сейчас.`);
        captureWorkletNodeRef.current?.port.postMessage({
          type: "start",
          frames: Math.round(cueWindow.cueDuration * (captureWorkletContextRef.current?.sampleRate || 48000)),
        });
        if (!videoFailed) {
          void video.play().catch(() => {
            setNotice(`Запись реплики ${cue.id} идёт по кадру. Говорите сейчас.`);
          });
        }
      };
      playbackEndRef.current = null;
      video.pause();
      video.currentTime = cue.start;
      video.muted = true;
      setMuted(true);
      setRecording(true);
      setRecordingStage("preparing");
      recordingWindowStartedAtRef.current = performance.now();
      setCurrentTime(cue.start - cueWindow.leadIn);
      setFragmentPosition(0);
      setNotice(`Подготовка к реплике ${cue.id}. Запись начнётся через секунду.`);
      stopTimerRef.current = window.setTimeout(() => {
        if (recordingPhaseRef.current !== "preparing" || recordingCueRef.current?.id !== cue.id) return;
        video.currentTime = cue.start;
        try {
          if (usesWorklet) beginWorkletCapture();
          else recorder?.start(50);
        } catch {
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          stopMicVisualization(true);
          recorderRef.current = null;
          cleanupCaptureWorklet();
          captureModeRef.current = null;
          recordingCueRef.current = null;
          timelineModeRef.current = "idle";
          setRecordingStage("idle");
          setRecording(false);
          setCurrentTime(cue.start);
          setFragmentPosition(cueWindow.leadIn);
          setNotice("Не удалось начать запись. Попробуйте ещё раз.");
        }
      }, preparationSeconds * 1000);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      stopMicVisualization(true);
      recorderRef.current = null;
      cleanupCaptureWorklet();
      captureModeRef.current = null;
      recordingCueRef.current = null;
      setRecordingStage("idle");
      setRecording(false);
      timelineModeRef.current = "idle";
      setNotice("Не удалось открыть микрофон. Проверьте разрешение браузера.");
    }
  }

  function updateVideoTime() {
    const video = videoRef.current;
    if (!video) return;
    const state = playerStateRef.current;
    const followsVideoClock = timelineModeRef.current === "full";
    if (followsVideoClock) {
      setCurrentTime(video.currentTime);
      if (state.activeCue) {
        const rawPosition = getFragmentPositionForMedia(state.activeCue, video.currentTime);
        const nextPosition = Math.max(fullPlaybackPositionRef.current ?? rawPosition, rawPosition);
        fullPlaybackPositionRef.current = nextPosition;
        setFragmentPosition(nextPosition);
      }
    }
    const playbackEnd = playbackEndRef.current;
    if (followsVideoClock && !state.rendering && state.playing && playbackEnd !== null && video.currentTime >= playbackEnd) {
      video.pause();
      video.currentTime = playbackEnd;
      playbackEndRef.current = null;
      setCurrentTime(playbackEnd);
      if (state.activeCue) {
        const cueWindow = getCueWindow(state.activeCue);
        setFragmentPosition(cueWindow.leadIn + cueWindow.cueDuration);
      }
    }
  }

  async function renderLocalProject() {
    if (!localProjectSession) return false;
    setRendering(true);
    clearRenderResult();
    setRenderProgress(1);
    setNotice("Запускаю локальную сборку MP4.");
    try {
      const startResponse = await fetch(`${projectApi}/v1/projects/${encodeURIComponent(localProjectSession.id)}/finalize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localProjectSession.token}` },
      });
      const startPayload = await startResponse.json() as { project?: LocalProjectState; error?: string };
      if (!startResponse.ok) throw new Error(startPayload.error || "finalize_failed");
      const deadline = Date.now() + 2 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const response = await fetch(`${projectApi}/v1/projects/${encodeURIComponent(localProjectSession.id)}/result`, {
          headers: { Authorization: `Bearer ${localProjectSession.token}` },
          cache: "no-store",
        });
        const payload = await response.json() as { project?: LocalProjectState; resultUrl?: string | null; error?: string };
        if (!response.ok || !payload.project) throw new Error(payload.error || "result_status_failed");
        setRenderProgress(payload.project.progress ?? 0);
        if (payload.project.state === "FAILED") throw new Error(payload.project.error || "render_failed");
        if (payload.project.state !== "READY" || !payload.resultUrl) continue;
        setRenderUrl(absoluteProjectUrl(payload.resultUrl));
        setRenderFileName(`${subtitleName.toLowerCase().replace(/[^a-zа-яё0-9_-]+/gi, "-") || "dubroom"}-dub.mp4`);
        setRenderProgress(100);
        setRenderBackendStatus("ЛОКАЛЬНЫЙ MP4 ГОТОВ");
        setNotice("MP4 готов. Проверьте результат перед скачиванием.");
        window.setTimeout(() => renderPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
        return true;
      }
      throw new Error("render_timeout");
    } catch (error) {
      setRenderProgress(0);
      setRenderBackendStatus("ОШИБКА ЛОКАЛЬНОЙ СБОРКИ");
      setNotice(error instanceof Error ? `Не удалось собрать MP4: ${error.message}` : "Не удалось собрать MP4.");
      return true;
    } finally {
      setRendering(false);
    }
  }

  async function renderVideo() {
    const video = videoRef.current;
    const recordedTakes = Object.entries(takes);
    if (!videoFile || !video) {
      setNotice("Сначала подготовьте YouTube-видео.");
      return;
    }
    if (!cues.length || cues.some((cue) => !takes[cue.id])) {
      setNotice("Сначала запишите все реплики.");
      return;
    }
    if (await renderLocalProject()) return;
    if (await renderVideoOnServer(videoFile, takes)) return;

    const captureTarget = video;
    const capture = (captureTarget as MediaPlayer & { captureStream?: (frameRate?: number) => MediaStream }).captureStream?.(30);
    if (!capture || typeof MediaRecorder === "undefined") {
      setNotice("Этот браузер не поддерживает локальную сборку. Откройте студию в Chrome или Edge.");
      return;
    }
    setRendering(true);
    clearRenderResult();
    setRenderProgress(1);
    setNotice("Локальный MP4-сервер недоступен. Идёт резервная сборка WebM в реальном времени.");
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const output = new MediaStream([...capture.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    const recorder = new MediaRecorder(output, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const completed = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const url = URL.createObjectURL(blob);
        setRenderUrl((current) => {
          if (current.startsWith("blob:")) URL.revokeObjectURL(current);
          return url;
        });
        setRenderFileName(`${videoFile.name.replace(/\.[^.]+$/, "")}-dub.webm`);
        setRenderProgress(100);
        setRendering(false);
        setNotice("Резервная сборка WebM готова. Проверьте видео перед скачиванием.");
        window.setTimeout(() => renderPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
        resolve();
      };
    });
    const scheduledSources: Array<{ source: AudioBufferSourceNode; offset: number }> = [];
    if (backingTrack) {
      try {
        const buffer = await context.decodeAudioData(await backingTrack.arrayBuffer());
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        scheduledSources.push({ source, offset: 0 });
      } catch {
        setNotice("Фоновая дорожка не декодировалась. Сборка продолжится с дублями.");
      }
    }
    for (const [cueId, take] of recordedTakes) {
      const cue = cues.find((item) => item.id === cueId);
      if (!cue) continue;
      try {
        const buffer = await context.decodeAudioData(await take.blob.arrayBuffer());
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        scheduledSources.push({ source, offset: cue.start });
      } catch {
        setNotice(`Не удалось декодировать дубль ${cueId}. Остальные реплики будут собраны.`);
      }
    }
    video.pause();
    video.currentTime = 0;
    video.muted = true;
    setMuted(true);
    const startAt = context.currentTime + 0.18;
    scheduledSources.forEach(({ source, offset }) => source.start(startAt + offset));
    recorder.start(250);
    window.setTimeout(() => void video.play(), 180);
    const finish = () => {
      if (recorder.state === "recording") recorder.stop();
      video.removeEventListener("ended", finish);
    };
    video.addEventListener("ended", finish);
    await completed;
    await context.close();
  }

  const progress = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
  const activeCueWindow = activeCue ? getCueWindow(activeCue) : { start: 0, end: 1, duration: 1, leadIn: 0, leadOut: 0, cueDuration: 1 };
  const fragmentElapsed = Math.min(activeCueWindow.duration, Math.max(0, fragmentPosition));
  const waveformProgress = (fragmentElapsed / activeCueWindow.duration) * 100;
  const speechStartPercent = (activeCueWindow.leadIn / activeCueWindow.duration) * 100;
  const speechEndPercent = ((activeCueWindow.leadIn + activeCueWindow.cueDuration) / activeCueWindow.duration) * 100;
  const activeIndex = Math.max(0, cues.findIndex((cue) => cue.id === activeCueId));
  const allCuesRecorded = cues.length > 0 && cues.every((cue) => Boolean(takes[cue.id]));
  const isLastCue = Boolean(activeCue) && activeIndex === cues.length - 1;
  const isRenderAction = isLastCue || rendering || Boolean(renderUrl);
  const recordingStatus = recordingPhase === "preparing"
    ? "ПОДГОТОВЬТЕСЬ"
    : recordingPhase === "recording"
      ? "ИДЁТ ЗАПИСЬ"
      : recordingPhase === "finishing"
        ? "СОХРАНЕНИЕ"
        : videoFile ? "ГОТОВО К ЗАПИСИ" : "ИСТОЧНИК НЕ ВЫБРАН";

  return (
    <main className="app-shell">
      <header className="topbar">
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image triggers a duplicate React runtime in vinext dev. */}
        <a className="brand" href="https://kupigolos.ru/" aria-label="КупиГолос, основной сайт"><img className="brand-logo" src="/kupigolos-logo.svg" alt="КупиГолос" width="109" height="51" /></a>
        <nav className="topbar-nav" aria-label="Разделы КупиГолос">
          <a href="https://kupigolos.ru/ozvuchka-video">Услуги</a>
          <a href="https://kupigolos.ru/diktory">Дикторы</a>
          <a className="active" href="https://kupigolos.ru/ai"><span aria-hidden="true">▮▮</span> ИИ сервисы</a>
          <a href="https://info.kupigolos.ru/">Инфопортал</a>
          <a href="https://kupigolos.ru/articles">Статьи</a>
        </nav>
        <div className="top-actions" aria-label="Быстрые действия">
          <a className="topbar-icon-link topbar-action-optional" href="tel:88002004551" aria-label="Позвонить 8 800 200-45-51" title="Позвонить"><Phone size={17} /></a>
          <a className="topbar-icon-link topbar-action-optional" href="https://telegram.dog/kupigolos_channel" aria-label="Канал КупиГолос в Telegram" title="Telegram"><MessageCircle size={17} /></a>
          <a className="topbar-icon-link topbar-action-optional" href="https://kupigolos.ru/favourites" aria-label="Избранные дикторы" title="Избранное"><Heart size={17} /></a>
          <a className="topbar-icon-link" href="/admin" aria-label="Админ-панель" title="Админ-панель"><Settings size={17} /></a>
          <a className="topbar-menu-link" href="https://kupigolos.ru/" aria-label="Открыть основной сайт КупиГолос" title="Основной сайт"><Menu size={32} /></a>
        </div>
      </header>

      <section className="youtube-source-band" aria-labelledby="youtube-source-title">
        <div className="youtube-source-heading">
          <h2 id="youtube-source-title">Озвучить видео с YouTube</h2>
          <span>ТОЛЬКО ПУБЛИЧНЫЕ ВИДЕО</span>
        </div>
        <form className="youtube-source-form" onSubmit={startYoutubeProject}>
          <label className="youtube-url-field">
            <span>ССЫЛКА НА ВАШЕ ВИДЕО</span>
            <span className="youtube-url-input">
              <Play size={17} fill="currentColor" />
              <input type="url" inputMode="url" placeholder="https://www.youtube.com/watch?v=..." value={youtubeSourceUrl} disabled={preparingProject} required onChange={(event) => setYoutubeSourceUrl(event.target.value)} />
            </span>
          </label>
          <button className="youtube-source-submit" type="submit" disabled={preparingProject || !youtubeSourceUrl.trim()}>
            {preparingProject ? <LoaderCircle className="spin" size={18} /> : <Film size={18} />}
            {preparingProject ? `${projectStage} ${Math.round(projectProgress)}%` : "ОЗВУЧИТЬ"}
          </button>
        </form>
        {preparingProject && (
          <div className="youtube-source-progress" role="progressbar" aria-label={projectStage} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(projectProgress)}>
            <i style={{ width: `${Math.max(2, projectProgress)}%` }} />
          </div>
        )}
      </section>

      <section className="recommendations-band" aria-labelledby="recommendations-title">
        <div className="recommendations-heading">
          <h2 id="recommendations-title">Рекомендуем</h2>
          <div className="recommendations-heading-controls">
            <span>{String(filteredRecommendations.length).padStart(2, "0")} ВИДЕО</span>
            <button type="button" disabled={!canScrollRecommendationsLeft} onClick={() => scrollRecommendations(-1)} aria-label="Предыдущие рекомендации" title="Предыдущие рекомендации"><ChevronLeft size={17} /></button>
            <button type="button" disabled={!canScrollRecommendationsRight} onClick={() => scrollRecommendations(1)} aria-label="Следующие рекомендации" title="Следующие рекомендации"><ChevronRight size={17} /></button>
          </div>
        </div>
        {visibleRecommendationCategories.length > 0 && (
          <div className="recommendation-category-filters" aria-label="Категории рекомендаций">
            <button type="button" className={effectiveRecommendationCategoryId === "all" ? "active" : ""} aria-pressed={effectiveRecommendationCategoryId === "all"} onClick={() => setActiveRecommendationCategoryId("all")}>Все</button>
            {visibleRecommendationCategories.map((category) => <button type="button" key={category.id} className={effectiveRecommendationCategoryId === category.id ? "active" : ""} aria-pressed={effectiveRecommendationCategoryId === category.id} onClick={() => setActiveRecommendationCategoryId(category.id)}>{category.name}</button>)}
          </div>
        )}
        {recommendations.length ? (
          <div className="recommendations-grid" ref={recommendationScrollerRef} onScroll={updateRecommendationScrollState}>
            {filteredRecommendations.map((recommendation) => (
              <article className="recommendation-card" key={recommendation.id}>
                <video src={recommendation.videoUrl} poster={recommendation.posterUrl || undefined} controls preload="metadata" playsInline aria-label={recommendation.title} />
                <div><strong>{recommendation.title}</strong><span>{formatTime(recommendation.duration)}</span></div>
                <button className="recommendation-select-button" type="button" disabled={preparingProject} onClick={() => void selectRecommendation(recommendation)}>{selectingRecommendationId === recommendation.id ? <LoaderCircle className="spin" size={15} /> : <Film size={15} />} {selectingRecommendationId === recommendation.id ? "ПОДГОТАВЛИВАЮ" : "ВЫБРАТЬ"}</button>
              </article>
            ))}
          </div>
        ) : <div className="recommendations-empty">РЕКОМЕНДАЦИИ ПОЯВЯТСЯ ЗДЕСЬ</div>}
      </section>

      <section className="workspace">
        <div className="stage-column">
          <div className="section-heading">
            <h1>Озвучь эту сцену</h1>
            <div className={`status-readout ${recordingPhase === "recording" ? "recording" : ""}`}><span>●</span>{recordingStatus}</div>
          </div>

          <section className="machine-frame" aria-label="Видеоплеер">
            <div className="machine-labels"><span>ОСНОВНОЙ ПРОСМОТР</span><span>{videoFile?.name ?? "КАНАЛ 01 / НЕТ СИГНАЛА"}</span></div>
            <div className="screen-bezel">
              <div className="video-screen">
                {videoUrl ? (
                  <video
                    ref={(element) => { videoRef.current = element; }}
                    src={videoUrl}
                    preload="metadata"
                    playsInline
                    onLoadedMetadata={(event) => {
                      setDuration(event.currentTarget.duration);
                      if (activeCue) {
                        event.currentTarget.currentTime = activeCue.start;
                        setCurrentTime(activeCue.start);
                        setFragmentPosition(getCueWindow(activeCue).leadIn);
                      }
                    }}
                    onLoadedData={() => setVideoFailed(false)}
                    onError={() => { setVideoFailed(true); setNotice("Браузер не смог воспроизвести видео."); }}
                    onTimeUpdate={updateVideoTime}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => { timelineModeRef.current = "idle"; fullPlaybackPositionRef.current = null; setPlaying(false); }}
                  />
                ) : (
                  <div className="screen-placeholder">
                    <a className="screen-placeholder-brand" href="https://kupigolos.ru/" aria-label="КупиГолос, основной сайт">
                      {/* eslint-disable-next-line @next/next/no-img-element -- next/image triggers a duplicate React runtime in vinext dev. */}
                      <img className="screen-placeholder-logo" src="/kupigolos-logo.svg" alt="КупиГолос" width="218" height="102" />
                    </a>
                    <strong>ПОДГОТОВЬТЕ YOUTUBE-ВИДЕО</strong>
                  </div>
                )}
                {preparingProject && (
                  <div className="project-loading-overlay" role="status" aria-live="polite">
                    <LoaderCircle className="spin" size={28} />
                    <strong>{projectStage}</strong>
                    <span>Обработка выполняется на сервере</span>
                    <div className="project-progress" role="progressbar" aria-label="Подготовка проекта" aria-valuemin={0} aria-valuemax={100} aria-valuenow={projectProgress}>
                      <i style={{ width: `${projectProgress}%` }} />
                    </div>
                    <b>{projectProgress}%</b>
                  </div>
                )}
                {videoFailed && <div className="video-error">ОШИБКА ДЕКОДИРОВАНИЯ ВИДЕО</div>}
                <div className="scanlines" />
                {visibleCue && <div className="subtitle-line"><span>{visibleCue.text}</span></div>}
                <div className="timecode">{formatTime(currentTime, true)}</div>
                {recordingPhase === "recording" && <div className="rec-badge"><span /> ЗАПИСЬ</div>}
              </div>
            </div>
            <div className="transport">
              <button className="transport-button" type="button" onClick={() => moveCue(-1)} aria-label="Предыдущая реплика" title="Предыдущая реплика"><SkipBack size={16} /></button>
              <button className="play-button" type="button" onClick={togglePlayback} aria-label={playing ? "Пауза" : "Воспроизвести"} title={playing ? "Пауза" : "Воспроизвести"}>{playing ? <Pause size={19} /> : <Play size={19} fill="currentColor" />}</button>
              <button className="transport-button" type="button" disabled={!activeCue || !takes[activeCue.id]} onClick={() => moveCue(1)} aria-label="Следующая реплика" title={activeCue && takes[activeCue.id] ? "Следующая реплика" : "Сначала запишите реплику"}><SkipForward size={16} /></button>
              <input className="scrubber" type="range" min="0" max={duration || 100} step="0.01" value={duration ? currentTime : 0} onChange={(event) => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value); setCurrentTime(Number(event.target.value)); }} aria-label="Позиция видео" style={{ "--progress": `${progress}%` } as React.CSSProperties} />
              <span className="duration">{formatTime(currentTime)} / {formatTime(duration)}</span>
              <button className="transport-button" type="button" onClick={() => { const next = !muted; setMuted(next); if (videoRef.current) videoRef.current.muted = next; }} aria-label={muted ? "Включить звук" : "Выключить звук"} title={muted ? "Включить звук" : "Выключить звук"}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
            </div>
          </section>

          <section className="timeline-panel">
            <div className="panel-title-row">
              <span>СРАВНЕНИЕ ДОРОЖЕК</span>
              <span className="waveform-legend"><i className="original-swatch" /> ОРИГИНАЛ <i className="take-swatch" /> ВАШ ДУБЛЬ</span>
              <span className="waveform-brand-logo" role="img" aria-label="КупиГолос" />
            </div>
            <div className={`waveform ${referenceWaveform || takeWaveform ? "waveform-loaded" : ""}`} data-position={fragmentElapsed.toFixed(3)} data-duration={activeCueWindow.duration.toFixed(3)}>
              <canvas ref={waveformCanvasRef} role="img" aria-label="Сравнение оригинальной реплики и записанного дубля" />
              {!referenceWaveform && !takeWaveform && <span className="waveform-empty">СИГНАЛ ФРАГМЕНТА НЕ ЗАГРУЖЕН</span>}
              <span className="waveform-playhead" style={{ left: `${waveformProgress}%` }} aria-hidden="true" />
            </div>
            <div className="fragment-scale">
              <span className="speech-start" style={{ left: `${speechStartPercent}%` }}>0.0</span>
              <span className="speech-end" style={{ left: `${speechEndPercent}%` }}>{activeCueWindow.cueDuration.toFixed(1)} С</span>
            </div>
            <div className="fragment-clock"><span><i />{formatTime(fragmentElapsed, true)}</span></div>
          </section>
        </div>

        <aside className={`side-rack ${videoFile ? "" : "no-scene"}`}>
          {videoFile && (
            <div className="scene-indicator" aria-label={activeCue ? `Сцена ${activeCue.id} из ${cues.length}` : "Сцена не выбрана"}>
              <strong>{activeCue?.id ?? "--"}</strong>
              <span>/ {String(cues.length).padStart(2, "0")}</span>
            </div>
          )}

          <div className="record-module">
            <button className="preview-original-button" type="button" disabled={recording} onClick={() => void playOriginalFragment()}><Play size={15} fill="currentColor" /> ПРОСМОТРЕТЬ ОРИГИНАЛЬНЫЙ ФРАГМЕНТ</button>
            <button className={`record-button ${recording ? "stop" : ""}`} type="button" disabled={recordingPhase === "finishing"} onClick={recording ? stopRecording : () => void startRecording()}>{recordingPhase === "finishing" ? <LoaderCircle className="spin" size={16} /> : recording ? <Square size={15} fill="currentColor" /> : takes[activeCue?.id] ? <RotateCcw size={16} /> : <Mic size={16} />} {recordingPhase === "preparing" ? "ОТМЕНИТЬ" : recordingPhase === "recording" ? "ОСТАНОВИТЬ" : recordingPhase === "finishing" ? "СОХРАНЯЮ ДУБЛЬ" : takes[activeCue?.id] ? "ПЕРЕЗАПИСАТЬ ДУБЛЬ" : "ЗАПИСАТЬ ДУБЛЬ"}</button>
            <button className="listen-take-button" type="button" disabled={recording || !activeCue || !takes[activeCue.id]} onClick={() => activeCue && void playTake(activeCue)}><Volume2 size={15} /> ПРОСЛУШАТЬ ДУБЛЬ</button>
            <button
              className={`next-fragment-button ${isRenderAction ? "render-action" : ""} ${renderUrl ? "render-ready" : ""}`}
              type="button"
              disabled={recording || Boolean(scoringCueId) || !activeCue || rendering || (!renderUrl && (!takes[activeCue.id] || (isLastCue && !allCuesRecorded)))}
              title={renderUrl ? "Открыть готовое видео" : isLastCue ? (allCuesRecorded ? "Собрать готовое видео" : "Сначала запишите все фрагменты") : "Перейти к следующему фрагменту"}
              onClick={() => {
                if (renderUrl) {
                  renderPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                } else if (isLastCue) {
                  void renderVideo();
                } else {
                  moveCue(1);
                }
              }}
            >
              {renderUrl ? <Play size={15} fill="currentColor" /> : rendering ? <LoaderCircle className="spin" size={15} /> : isLastCue ? <Film size={15} /> : <SkipForward size={15} />}
              {renderUrl ? "ОТКРЫТЬ ПРЕДПРОСМОТР" : rendering ? `СБОРКА MP4 ${renderProgress}%` : isLastCue ? "СКАЧАТЬ ВИДЕО" : "СЛЕДУЮЩИЙ ФРАГМЕНТ"}
            </button>
          </div>
        </aside>
      </section>

      {renderUrl && (
        <section ref={renderPreviewRef} className="render-result" aria-label="Готовое видео">
          <div className="render-preview-pane">
            <video src={renderUrl} controls preload="metadata" playsInline />
            <a className="render-download-button" href={renderUrl} download={renderFileName}><Download size={16} /> СКАЧАТЬ ВИДЕО</a>
          </div>
        </section>
      )}
    </main>
  );
}
