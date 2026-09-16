"use client";

import { Activity, ArrowLeft, Check, CirclePlay, Clapperboard, Copy, Database, Eraser, ExternalLink, Gauge, ImageUp, Link2, LoaderCircle, LockKeyhole, LogOut, Pencil, Plus, RefreshCw, RotateCcw, Save, SlidersHorizontal, Tag, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type ServerProject = {
  id: string;
  sourceUrl: string;
  state: string;
  stemsStatus: string;
  transcriptStatus: string;
  progress: number;
  recordedCueIds: string[];
  title: string;
  duration: number;
  createdAt: number;
  updatedAt: number;
  sourceExpiresAt: number;
  workingExpiresAt: number;
  error: string | null;
};

type ServerSettings = {
  projectRetentionMinutes: number;
  cacheRetentionHours: number;
  maxVideoDurationMinutes: number;
  maxSourceFileMb: number;
  maxTakeFileMb: number;
  maxProjects: number;
  maxTotalStorageGb: number;
  maxCacheStorageGb: number;
  minFreeStorageGb: number;
  pipelineConcurrency: number;
  maxAutomaticJobAttempts: number;
  retryBaseDelaySeconds: number;
  maxProjectCreationsPerMinute: number;
};

type SettingLimits = Record<keyof ServerSettings, { minimum: number; maximum: number }>;

type StorageStats = {
  projectCount: number;
  cacheCount: number;
  recommendationCount: number;
  projectBytes: number;
  cacheBytes: number;
  recommendationBytes: number;
  totalBytes: number;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
};

type RuntimeStats = {
  status: string;
  pipelineMode: string;
  uptimeSeconds: number;
  queue: { concurrency: number; running: number; pending: number };
  jobs: { total: number; pending: number; running: number; retryWaiting: number; succeeded: number; failed: number; deadLetter: number; oldestPendingAgeSeconds: number; oldestRunningAgeSeconds: number; lastFailureAt: number | null };
  activeProjects: number;
  activeSources: number;
  failedProjects: number;
  failedRecommendations: number;
};

type DeadLetterJob = {
  id: string;
  ownerType: "project" | "recommendation";
  ownerId: string;
  ownerTitle: string;
  ownerState: string;
  stage: string;
  attempts: number;
  failedAt: number;
  error: string | null;
};

type CacheEntry = {
  videoId: string;
  sourceUrl: string;
  title: string;
  duration: number;
  createdAt: number;
  lastUsedAt: number;
  bytes: number;
};

type Recommendation = {
  id: string;
  title: string;
  state: "PROCESSING" | "READY" | "FAILED";
  progress: number;
  duration: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  sourceType: "upload" | "youtube";
  sourceUrl: string | null;
  shareUrl: string;
  videoUrl: string | null;
  posterUrl: string | null;
  categoryId: string | null;
};

type RecommendationCategory = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const settingFields: Array<{ key: keyof ServerSettings; label: string; unit: string; step?: number }> = [
  { key: "projectRetentionMinutes", label: "Хранение проекта", unit: "мин" },
  { key: "cacheRetentionHours", label: "Хранение общего кэша", unit: "ч" },
  { key: "maxVideoDurationMinutes", label: "Длительность видео", unit: "мин" },
  { key: "maxSourceFileMb", label: "Размер исходника", unit: "МБ" },
  { key: "maxTakeFileMb", label: "Размер одного дубля", unit: "МБ" },
  { key: "maxProjects", label: "Проектов на сервере", unit: "шт" },
  { key: "maxTotalStorageGb", label: "Общее хранилище", unit: "ГБ", step: 0.5 },
  { key: "maxCacheStorageGb", label: "Хранилище кэша", unit: "ГБ", step: 0.5 },
  { key: "minFreeStorageGb", label: "Свободный резерв диска", unit: "ГБ", step: 0.1 },
  { key: "pipelineConcurrency", label: "Параллельные обработки", unit: "шт" },
  { key: "maxAutomaticJobAttempts", label: "Попыток локальной задачи", unit: "шт" },
  { key: "retryBaseDelaySeconds", label: "Начальная задержка повтора", unit: "сек" },
  { key: "maxProjectCreationsPerMinute", label: "Новых проектов с одного IP", unit: "в мин" },
];

const stageLabels: Record<string, string> = {
  youtube_download: "Загрузка YouTube",
  prepare_video: "Подготовка видео",
  extract_master: "Извлечение аудио",
  elevenlabs_stems: "Разделение дорожек ElevenLabs",
  elevenlabs_transcript: "Субтитры ElevenLabs",
  final_render: "Сборка итогового MP4",
};

const stateLabels: Record<string, string> = {
  CREATED: "В очереди",
  INGESTING: "Загрузка видео",
  EXTRACTING_AUDIO: "Извлечение звука",
  ANALYZING: "Анализ дорожек",
  BUILDING_CUES: "Подготовка реплик",
  READY_TO_DUB: "Готов к озвучке",
  RECORDING: "Запись дублей",
  FINALIZING: "Сборка MP4",
  READY: "Готов",
  FAILED: "Ошибка",
};

function formatDate(value: number) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function projectCount(count: number) {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? "ПРОЕКТОВ" : last === 1 ? "ПРОЕКТ" : last >= 2 && last <= 4 ? "ПРОЕКТА" : "ПРОЕКТОВ";
  return `${String(count).padStart(2, "0")} ${word}`;
}

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

export default function AdminPage() {
  const [authState, setAuthState] = useState<"checking" | "locked" | "authenticated">("checking");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [projects, setProjects] = useState<ServerProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([]);
  const [deletingCacheId, setDeletingCacheId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationCategories, setRecommendationCategories] = useState<RecommendationCategory[]>([]);
  const [recommendationCategoryId, setRecommendationCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [savingCategoryId, setSavingCategoryId] = useState<string | null>(null);
  const [assigningRecommendationId, setAssigningRecommendationId] = useState<string | null>(null);
  const [recommendationTitle, setRecommendationTitle] = useState("");
  const [recommendationFile, setRecommendationFile] = useState<File | null>(null);
  const [recommendationSourceMode, setRecommendationSourceMode] = useState<"upload" | "youtube">("upload");
  const [recommendationSourceUrl, setRecommendationSourceUrl] = useState("");
  const [uploadingRecommendation, setUploadingRecommendation] = useState(false);
  const [deletingRecommendationId, setDeletingRecommendationId] = useState<string | null>(null);
  const [uploadingPosterId, setUploadingPosterId] = useState<string | null>(null);
  const [copiedRecommendationId, setCopiedRecommendationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [limits, setLimits] = useState<SettingLimits | null>(null);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStats | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetterJob[]>([]);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [notice, setNotice] = useState("Список автоматически обновляется каждые три секунды.");

  async function refreshProjects(silent = false) {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/admin/projects", { cache: "no-store" });
      const data = await response.json() as { projects?: ServerProject[]; error?: string };
      if (response.status === 401) {
        setAuthState("locked");
        return;
      }
      if (!response.ok) throw new Error(data.error || "Не удалось загрузить проекты.");
      setProjects(data.projects ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Сервер проектов недоступен.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function refreshSettings(preserveForm = false) {
    const response = await fetch("/api/admin/settings", { cache: "no-store" });
    const data = await response.json() as { settings?: ServerSettings; limits?: SettingLimits; storage?: StorageStats; runtime?: RuntimeStats; error?: string };
    if (!response.ok || !data.settings || !data.limits || !data.storage || !data.runtime) throw new Error(data.error || "Не удалось загрузить настройки.");
    if (!preserveForm) {
      setSettings(data.settings);
      setLimits(data.limits);
    }
    setStorage(data.storage);
    setRuntime(data.runtime);
  }

  async function refreshCache() {
    const response = await fetch("/api/admin/cache", { cache: "no-store" });
    const data = await response.json() as { entries?: CacheEntry[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить кеш.");
    setCacheEntries(data.entries ?? []);
  }

  async function refreshRecommendations() {
    const response = await fetch("/api/admin/recommendations", { cache: "no-store" });
    const data = await response.json() as { recommendations?: Recommendation[]; categories?: RecommendationCategory[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить рекомендации.");
    setRecommendations(data.recommendations ?? []);
    setRecommendationCategories(data.categories ?? []);
  }

  async function refreshDeadLetters() {
    const response = await fetch("/api/admin/jobs", { cache: "no-store" });
    const data = await response.json() as { jobs?: DeadLetterJob[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить аварийные задания.");
    setDeadLetters(data.jobs ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { authenticated?: boolean };
        if (cancelled) return;
        if (!data.authenticated) {
          setAuthState("locked");
          return;
        }
        setAuthState("authenticated");
        const results = await Promise.allSettled([refreshProjects(), refreshSettings(), refreshCache(), refreshRecommendations(), refreshDeadLetters()]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") setNotice(failed.reason instanceof Error ? failed.reason.message : "Часть данных сервера недоступна.");
      })
      .catch(() => { if (!cancelled) setNotice("Не удалось проверить состояние сервера."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const projectTimer = window.setInterval(() => void Promise.all([refreshProjects(true), refreshRecommendations(), refreshDeadLetters()]), 5000);
    const storageTimer = window.setInterval(() => {
      void Promise.all([refreshSettings(true), refreshCache()]).catch((error) => {
        setNotice(error instanceof Error ? error.message : "Не удалось обновить состояние сервера.");
      });
    }, 30_000);
    return () => {
      window.clearInterval(projectTimer);
      window.clearInterval(storageTimer);
    };
  }, [authState]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json() as { authenticated?: boolean; error?: string };
    if (!response.ok || !data.authenticated) {
      setLoginError(data.error || "Не удалось войти.");
      return;
    }
    setPassword("");
    setAuthState("authenticated");
    await Promise.all([refreshProjects(), refreshSettings(), refreshCache(), refreshRecommendations(), refreshDeadLetters()]);
  }

  async function logout() {
    await fetch("/api/admin/session", { method: "DELETE" });
    setProjects([]);
    setRecommendations([]);
    setRecommendationCategories([]);
    setDeadLetters([]);
    setAuthState("locked");
  }

  async function retryDeadLetter(job: DeadLetterJob) {
    setRetryingJobId(job.id);
    try {
      const response = await fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      const data = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !data.jobId) throw new Error(data.error || "Не удалось повторить задачу.");
      setDeadLetters((current) => current.filter((item) => item.id !== job.id));
      setNotice(`«${job.ownerTitle}»: задача снова поставлена в обработку.`);
      await Promise.all([refreshProjects(true), refreshRecommendations(), refreshSettings(true)]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось повторить задачу.");
    } finally {
      setRetryingJobId(null);
    }
  }

  async function deleteProject(project: ServerProject) {
    if (!window.confirm(`Удалить проект «${project.title}» и все его файлы?`)) return;
    setDeletingId(project.id);
    try {
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Не удалось удалить проект.");
      setProjects((current) => current.filter((item) => item.id !== project.id));
      await refreshSettings();
      setNotice(`Проект «${project.title}» удалён с сервера.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить проект.");
    } finally {
      setDeletingId(null);
    }
  }

  async function retryProject(project: ServerProject) {
    setRetryingId(project.id);
    try {
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(project.id)}/retry`, { method: "POST" });
      const data = await response.json() as { project?: ServerProject; error?: string };
      if (!response.ok || !data.project) throw new Error(data.error || "Не удалось повторить обработку.");
      setProjects((current) => current.map((item) => item.id === project.id ? data.project! : item));
      setNotice(`Проект «${project.title}» снова поставлен в обработку.`);
      await refreshSettings();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось повторить обработку.");
    } finally {
      setRetryingId(null);
    }
  }

  async function deleteCache(entry: CacheEntry) {
    if (!window.confirm(`Удалить подготовленные данные «${entry.title}» из кеша?`)) return;
    setDeletingCacheId(entry.videoId);
    try {
      const response = await fetch(`/api/admin/cache/${encodeURIComponent(entry.videoId)}`, { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Не удалось удалить кеш.");
      setCacheEntries((current) => current.filter((item) => item.videoId !== entry.videoId));
      await refreshSettings();
      setNotice(`Кеш «${entry.title}» удалён.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить кеш.");
    } finally {
      setDeletingCacheId(null);
    }
  }

  async function clearCache() {
    if (!cacheEntries.length || !window.confirm("Очистить весь подготовленный кеш? Пользовательские проекты останутся на месте.")) return;
    setDeletingCacheId("*");
    try {
      const response = await fetch("/api/admin/cache", { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Не удалось очистить кеш.");
      setCacheEntries([]);
      await refreshSettings();
      setNotice("Подготовленный кеш полностью очищен.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось очистить кеш.");
    } finally {
      setDeletingCacheId(null);
    }
  }

  async function uploadRecommendation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fromYouTube = recommendationSourceMode === "youtube";
    if (fromYouTube ? !recommendationSourceUrl.trim() : !recommendationFile || !recommendationTitle.trim()) return;
    const form = event.currentTarget;
    setUploadingRecommendation(true);
    try {
      let response: Response;
      if (fromYouTube) {
        response = await fetch("/api/admin/recommendations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: recommendationTitle.trim(), sourceUrl: recommendationSourceUrl.trim(), categoryId: recommendationCategoryId || null }),
        });
      } else {
        const target = new URL("/api/admin/recommendations", window.location.origin);
        target.searchParams.set("title", recommendationTitle.trim());
        target.searchParams.set("fileName", recommendationFile!.name);
        if (recommendationCategoryId) target.searchParams.set("categoryId", recommendationCategoryId);
        response = await fetch(target, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: recommendationFile });
      }
      const data = await response.json() as { recommendation?: Recommendation; error?: string };
      if (!response.ok || !data.recommendation) throw new Error(data.error || "Не удалось добавить рекомендацию.");
      setRecommendations((current) => [data.recommendation!, ...current.filter((item) => item.id !== data.recommendation!.id)]);
      setRecommendationTitle("");
      setRecommendationFile(null);
      setRecommendationSourceUrl("");
      form.reset();
      setNotice(`Видео «${data.recommendation.title}» поставлено на загрузку и конвертацию.`);
      await refreshSettings(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить рекомендацию.");
    } finally {
      setUploadingRecommendation(false);
    }
  }

  async function createRecommendationCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    setSavingCategoryId("new");
    try {
      const response = await fetch("/api/admin/recommendation-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json() as { category?: RecommendationCategory; error?: string };
      if (!response.ok || !data.category) throw new Error(data.error === "recommendation_category_name_conflict" ? "Категория с таким названием уже существует." : data.error || "Не удалось создать категорию.");
      setRecommendationCategories((current) => [...current, data.category!]);
      setNewCategoryName("");
      setNotice(`Категория «${data.category.name}» создана.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось создать категорию.");
    } finally {
      setSavingCategoryId(null);
    }
  }

  async function saveRecommendationCategory(category: RecommendationCategory) {
    const name = editingCategoryName.trim();
    if (!name) return;
    setSavingCategoryId(category.id);
    try {
      const response = await fetch(`/api/admin/recommendation-categories/${encodeURIComponent(category.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json() as { category?: RecommendationCategory; error?: string };
      if (!response.ok || !data.category) throw new Error(data.error === "recommendation_category_name_conflict" ? "Категория с таким названием уже существует." : data.error || "Не удалось переименовать категорию.");
      setRecommendationCategories((current) => current.map((item) => item.id === category.id ? data.category! : item));
      setEditingCategoryId(null);
      setEditingCategoryName("");
      setNotice(`Категория переименована в «${data.category.name}».`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось переименовать категорию.");
    } finally {
      setSavingCategoryId(null);
    }
  }

  async function deleteRecommendationCategory(category: RecommendationCategory) {
    const count = recommendations.filter((item) => item.categoryId === category.id).length;
    if (!window.confirm(`Удалить категорию «${category.name}»? ${count ? `${count} видео останутся в каталоге без категории.` : ""}`)) return;
    setSavingCategoryId(category.id);
    try {
      const response = await fetch(`/api/admin/recommendation-categories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Не удалось удалить категорию.");
      setRecommendationCategories((current) => current.filter((item) => item.id !== category.id));
      setRecommendations((current) => current.map((item) => item.categoryId === category.id ? { ...item, categoryId: null } : item));
      if (recommendationCategoryId === category.id) setRecommendationCategoryId("");
      setNotice(`Категория «${category.name}» удалена. Видео сохранены.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить категорию.");
    } finally {
      setSavingCategoryId(null);
    }
  }

  async function assignRecommendationCategory(recommendation: Recommendation, categoryId: string) {
    setAssigningRecommendationId(recommendation.id);
    try {
      const response = await fetch(`/api/admin/recommendations/${encodeURIComponent(recommendation.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: categoryId || null }),
      });
      const data = await response.json() as { recommendation?: Recommendation; error?: string };
      if (!response.ok || !data.recommendation) throw new Error(data.error || "Не удалось назначить категорию.");
      setRecommendations((current) => current.map((item) => item.id === recommendation.id ? data.recommendation! : item));
      const category = recommendationCategories.find((item) => item.id === categoryId);
      setNotice(category ? `Видео «${recommendation.title}» перенесено в «${category.name}».` : `Категория видео «${recommendation.title}» сброшена.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось назначить категорию.");
    } finally {
      setAssigningRecommendationId(null);
    }
  }

  async function deleteRecommendation(recommendation: Recommendation) {
    if (!window.confirm(`Удалить рекомендацию «${recommendation.title}» без возможности восстановления?`)) return;
    setDeletingRecommendationId(recommendation.id);
    try {
      const response = await fetch(`/api/admin/recommendations/${encodeURIComponent(recommendation.id)}`, { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Не удалось удалить рекомендацию.");
      setRecommendations((current) => current.filter((item) => item.id !== recommendation.id));
      setNotice(`Рекомендация «${recommendation.title}» удалена.`);
      await refreshSettings(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить рекомендацию.");
    } finally {
      setDeletingRecommendationId(null);
    }
  }

  async function uploadRecommendationPoster(recommendation: Recommendation, file: File) {
    setUploadingPosterId(recommendation.id);
    try {
      const target = new URL(`/api/admin/recommendations/${encodeURIComponent(recommendation.id)}/poster`, window.location.origin);
      target.searchParams.set("fileName", file.name);
      const response = await fetch(target, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await response.json() as { recommendation?: Recommendation; error?: string };
      if (!response.ok || !data.recommendation) throw new Error(data.error || "Не удалось обновить превью.");
      setRecommendations((current) => current.map((item) => item.id === recommendation.id ? data.recommendation! : item));
      setNotice(`Превью видео «${recommendation.title}» обновлено.`);
      await refreshSettings(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось обновить превью.");
    } finally {
      setUploadingPosterId(null);
    }
  }

  async function copyRecommendationLink(recommendation: Recommendation) {
    const publicUrl = new URL(recommendation.shareUrl, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopiedRecommendationId(recommendation.id);
      setNotice(`Ссылка для озвучки «${recommendation.title}» скопирована.`);
      window.setTimeout(() => setCopiedRecommendationId((current) => current === recommendation.id ? null : current), 1800);
    } catch {
      setNotice(`Не удалось скопировать автоматически: ${publicUrl}`);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await response.json() as { settings?: ServerSettings; limits?: SettingLimits; storage?: StorageStats; runtime?: RuntimeStats; error?: string };
      if (!response.ok || !data.settings || !data.limits || !data.storage || !data.runtime) throw new Error(data.error || "Не удалось сохранить настройки.");
      setSettings(data.settings);
      setLimits(data.limits);
      setStorage(data.storage);
      setRuntime(data.runtime);
      setNotice("Лимиты сохранены и уже применяются сервером.");
      await refreshProjects(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить настройки.");
    } finally {
      setSavingSettings(false);
    }
  }

  if (authState === "checking") {
    return <main className="admin-shell"><div className="admin-login-shell"><div className="admin-login-status"><LoaderCircle className="spin" size={20} /> ПРОВЕРЯЮ ДОСТУП</div></div></main>;
  }

  if (authState === "locked") {
    return (
      <main className="admin-shell">
        <header className="topbar">
          <a className="brand" href="https://kupigolos.ru/" aria-label="КупиГолос, основной сайт"><img className="brand-logo" src="/kupigolos-logo.svg" alt="КупиГолос" width="109" height="51" /></a>
          <div className="project-chip"><span className="signal-dot" />АДМИН / ЗАЩИЩЁННЫЙ ВХОД</div>
          <Link className="quiet-button" href="/"><ArrowLeft size={14} /> В СТУДИЮ</Link>
        </header>
        <div className="admin-login-shell">
          <form className="admin-login" onSubmit={login}>
            <LockKeyhole size={28} />
            <p className="eyebrow">АДМИН-ПАНЕЛЬ</p>
            <h1>Введите пароль</h1>
            <label>ПАРОЛЬ<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
            {loginError && <p className="admin-login-error">{loginError}</p>}
            <button className="admin-upload-button" type="submit" disabled={!password.trim()}><LockKeyhole size={15} /> ВОЙТИ</button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="topbar">
        <a className="brand" href="https://kupigolos.ru/" aria-label="КупиГолос, основной сайт"><img className="brand-logo" src="/kupigolos-logo.svg" alt="КупиГолос" width="109" height="51" /></a>
        <div className="project-chip"><span className="signal-dot" />АДМИН / СЕРВЕР</div>
        <div className="top-actions"><Link className="quiet-button" href="/"><ArrowLeft size={14} /> В СТУДИЮ</Link><button className="quiet-button" type="button" onClick={() => void logout()}><LogOut size={14} /> ВЫЙТИ</button></div>
      </header>

      <div className="admin-workspace">
        <div className="admin-heading"><p className="eyebrow">УПРАВЛЕНИЕ СЕРВЕРОМ</p><h1>Хранилище и проекты</h1></div>
        <section className="server-settings-panel">
          <div className="admin-panel-heading">
            <div><p className="eyebrow">ПРАВИЛА СЕРВЕРА</p><h2>Лимиты и хранение</h2></div>
            <SlidersHorizontal size={22} />
          </div>
          {settings && limits && storage ? (
            <form className="server-settings-form" onSubmit={saveSettings}>
              <div className="storage-summary">
                <Database size={24} />
                <div><strong>{formatBytes(storage.totalBytes)} из {settings.maxTotalStorageGb} ГБ</strong><span>ПРОЕКТЫ {formatBytes(storage.projectBytes)} · КЭШ {formatBytes(storage.cacheBytes)} · РЕКОМЕНДАЦИИ {formatBytes(storage.recommendationBytes || 0)}{storage.diskFreeBytes !== null ? ` · СВОБОДНО ${formatBytes(storage.diskFreeBytes)}` : ""}</span></div>
                <div className="storage-progress"><i style={{ width: `${Math.min(100, storage.totalBytes / (settings.maxTotalStorageGb * 1024 ** 3) * 100)}%` }} /></div>
              </div>
              {runtime && <div className="runtime-grid">
                <div><Activity size={17} /><span>API</span><strong>{runtime.status === "ready" ? "РАБОТАЕТ" : "ТРЕБУЕТ ВНИМАНИЯ"}</strong></div>
                <div><Gauge size={17} /><span>ОЧЕРЕДЬ</span><strong>{runtime.queue.running} В РАБОТЕ · {runtime.queue.pending} ЖДУТ</strong></div>
                <div><TriangleAlert size={17} /><span>ЗАДАНИЯ</span><strong>{runtime.jobs.deadLetter} ОШИБОК · {runtime.jobs.retryWaiting} ПОВТОРОВ</strong></div>
                <div><Database size={17} /><span>РЕЖИМ</span><strong>{runtime.pipelineMode === "real" ? "БОЕВОЙ" : "ТЕСТОВЫЙ"}</strong></div>
                <div><RotateCcw size={17} /><span>UPTIME</span><strong>{formatUptime(runtime.uptimeSeconds)}</strong></div>
              </div>}
              <div className="settings-grid">
                {settingFields.map((field) => (
                  <label className="setting-control" key={field.key}>
                    <span>{field.label}</span>
                    <span className="setting-input"><input type="number" value={settings[field.key]} min={limits[field.key].minimum} max={limits[field.key].maximum} step={field.step ?? 1} onChange={(event) => setSettings((current) => current ? { ...current, [field.key]: Number(event.target.value) } : current)} /><b>{field.unit}</b></span>
                  </label>
                ))}
              </div>
              <button className="admin-save-settings" type="submit" disabled={savingSettings}>{savingSettings ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} {savingSettings ? "СОХРАНЯЮ" : "СОХРАНИТЬ ЛИМИТЫ"}</button>
            </form>
          ) : <div className="admin-empty"><LoaderCircle className="spin" size={18} /> ЗАГРУЖАЮ НАСТРОЙКИ</div>}
        </section>
        <section className="server-projects-panel failed-jobs-panel">
          <div className="admin-panel-heading">
            <div><p className="eyebrow">КОНТРОЛЬ ОБРАБОТКИ</p><h2>Требуют внимания</h2></div>
            <div className="admin-project-tools"><span>{deadLetters.length} ЗАДАЧ</span><TriangleAlert size={21} /></div>
          </div>
          <div className="admin-project-list">
            {deadLetters.length ? deadLetters.map((job) => (
              <article className="admin-project-row failed-job-row" key={job.id}>
                <div className="server-project-main">
                  <div className="server-project-title"><strong>{job.ownerTitle}</strong></div>
                  <span className="server-project-state state-failed">{job.ownerType === "project" ? "ПРОЕКТ" : "РЕКОМЕНДАЦИЯ"}</span>
                  <div className="server-project-meta"><span>{stageLabels[job.stage] || job.stage}</span><span>ПОПЫТОК {job.attempts}</span><span>{formatDate(job.failedAt)}</span></div>
                  {job.error && <p className="server-project-error">{job.error}</p>}
                </div>
                <div className="server-project-actions">
                  <button className="server-project-retry" type="button" disabled={retryingJobId === job.id} onClick={() => void retryDeadLetter(job)} aria-label={`Повторить задачу ${job.ownerTitle}`} title="Повторить с сохранённых файлов">{retryingJobId === job.id ? <LoaderCircle className="spin" size={18} /> : <RotateCcw size={18} />}</button>
                </div>
              </article>
            )) : <div className="admin-empty">ЗАДАЧ, ТРЕБУЮЩИХ ВНИМАНИЯ, НЕТ</div>}
          </div>
        </section>
        <section className="server-projects-panel recommendations-admin-panel">
          <div className="admin-panel-heading">
            <div><p className="eyebrow">ПОСТОЯННЫЙ КАТАЛОГ</p><h2>Рекомендации</h2></div>
            <div className="admin-project-tools"><span>{recommendations.length} ВИДЕО</span><Clapperboard size={21} /></div>
          </div>
          <div className="recommendation-category-manager">
            <form className="recommendation-category-create" onSubmit={createRecommendationCategory}>
              <Tag size={17} />
              <input type="text" maxLength={48} placeholder="Новая категория" aria-label="Название новой категории" value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} />
              <button type="submit" disabled={!newCategoryName.trim() || savingCategoryId === "new"} aria-label="Добавить категорию" title="Добавить категорию">{savingCategoryId === "new" ? <LoaderCircle className="spin" size={16} /> : <Plus size={17} />}</button>
            </form>
            <div className="recommendation-category-admin-list">
              {recommendationCategories.map((category) => (
                <div className="recommendation-category-admin-item" key={category.id}>
                  {editingCategoryId === category.id ? (
                    <input type="text" maxLength={48} aria-label={`Новое название категории ${category.name}`} value={editingCategoryName} onChange={(event) => setEditingCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveRecommendationCategory(category); } }} />
                  ) : <span><Tag size={13} /> {category.name}<b>{recommendations.filter((item) => item.categoryId === category.id).length}</b></span>}
                  {editingCategoryId === category.id ? (
                    <>
                      <button type="button" disabled={!editingCategoryName.trim() || savingCategoryId === category.id} onClick={() => void saveRecommendationCategory(category)} aria-label={`Сохранить категорию ${category.name}`} title="Сохранить"><Check size={15} /></button>
                      <button type="button" onClick={() => { setEditingCategoryId(null); setEditingCategoryName(""); }} aria-label="Отменить переименование" title="Отменить"><X size={15} /></button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => { setEditingCategoryId(category.id); setEditingCategoryName(category.name); }} aria-label={`Переименовать категорию ${category.name}`} title="Переименовать"><Pencil size={14} /></button>
                      <button type="button" disabled={savingCategoryId === category.id} onClick={() => void deleteRecommendationCategory(category)} aria-label={`Удалить категорию ${category.name}`} title="Удалить категорию">{savingCategoryId === category.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
          <form className="recommendation-upload-form" onSubmit={uploadRecommendation}>
            <div className="recommendation-source-mode" role="tablist" aria-label="Источник рекомендации">
              <button type="button" className={recommendationSourceMode === "upload" ? "active" : ""} onClick={() => setRecommendationSourceMode("upload")}><Upload size={15} /> MP4</button>
              <button type="button" className={recommendationSourceMode === "youtube" ? "active" : ""} onClick={() => setRecommendationSourceMode("youtube")}><CirclePlay size={16} /> YOUTUBE</button>
            </div>
            {recommendationSourceMode === "upload" ? (
              <label className="recommendation-file-picker">
                <input type="file" accept="video/mp4,.mp4" onChange={(event) => setRecommendationFile(event.target.files?.[0] ?? null)} />
                <Upload size={18} />
                <span>{recommendationFile?.name || "ВЫБРАТЬ MP4"}</span>
              </label>
            ) : (
              <label className="recommendation-url-field"><Link2 size={17} /><input type="url" placeholder="https://www.youtube.com/watch?v=..." value={recommendationSourceUrl} onChange={(event) => setRecommendationSourceUrl(event.target.value)} /></label>
            )}
            <label className="recommendation-title-field"><span>НАЗВАНИЕ {recommendationSourceMode === "youtube" && "(НЕОБЯЗАТЕЛЬНО)"}</span><input type="text" maxLength={160} placeholder={recommendationSourceMode === "youtube" ? "Автоматически из YouTube" : "Название видео"} value={recommendationTitle} onChange={(event) => setRecommendationTitle(event.target.value)} /></label>
            <label className="recommendation-title-field"><span>КАТЕГОРИЯ</span><select value={recommendationCategoryId} onChange={(event) => setRecommendationCategoryId(event.target.value)}><option value="">Без категории</option>{recommendationCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <button className="admin-upload-button" type="submit" disabled={uploadingRecommendation || (recommendationSourceMode === "youtube" ? !recommendationSourceUrl.trim() : !recommendationFile || !recommendationTitle.trim())}>{uploadingRecommendation ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />} {uploadingRecommendation ? "ЗАГРУЖАЮ" : "ДОБАВИТЬ"}</button>
          </form>
          <p className="recommendation-storage-note">Загрузите MP4 или добавьте ссылку на публичное YouTube-видео. Сервер один раз подготовит видео, фоновую дорожку, субтитры и фрагменты. Все данные рекомендации хранятся постоянно и не удаляются по TTL.</p>
          <div className="recommendation-admin-list">
            {recommendations.length ? recommendations.map((recommendation) => (
              <article className="recommendation-admin-row" key={recommendation.id}>
                <div className="recommendation-admin-preview">{recommendation.posterUrl ? <img src={recommendation.posterUrl} alt="" /> : <Clapperboard size={24} />}</div>
                <div className="recommendation-admin-main">
                  <div><strong>{recommendation.title}</strong><span className={`server-project-state state-${recommendation.state.toLowerCase()}`}>{recommendation.state === "READY" ? "ГОТОВО" : recommendation.state === "FAILED" ? "ОШИБКА" : `КОНВЕРТАЦИЯ ${recommendation.progress}%`}</span></div>
                  <span>{recommendation.sourceType === "youtube" ? "YOUTUBE" : "MP4"} · {recommendation.state === "READY" ? `${formatDuration(recommendation.duration)} · ${formatBytes(recommendation.bytes)}` : `ДОБАВЛЕНО ${formatDate(recommendation.createdAt)}`}</span>
                  <label className="recommendation-row-category"><Tag size={13} /><select disabled={assigningRecommendationId === recommendation.id} value={recommendation.categoryId || ""} onChange={(event) => void assignRecommendationCategory(recommendation, event.target.value)} aria-label={`Категория видео ${recommendation.title}`}><option value="">Без категории</option>{recommendationCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{assigningRecommendationId === recommendation.id && <LoaderCircle className="spin" size={13} />}</label>
                  {recommendation.error && <p>{recommendation.error}</p>}
                </div>
                <div className="server-project-actions">
                  {recommendation.sourceUrl && <a className="server-project-retry" href={recommendation.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Открыть источник ${recommendation.title}`} title="Открыть YouTube"><CirclePlay size={17} /></a>}
                  <a className="server-project-retry" href={recommendation.shareUrl} target="_blank" rel="noreferrer" aria-label={`Открыть для озвучки ${recommendation.title}`} title="Открыть для озвучки"><ExternalLink size={17} /></a>
                  <button className="server-project-retry" type="button" onClick={() => void copyRecommendationLink(recommendation)} aria-label={`Скопировать ссылку для озвучки ${recommendation.title}`} title="Скопировать ссылку для озвучки">{copiedRecommendationId === recommendation.id ? <Check size={17} /> : <Copy size={17} />}</button>
                  {recommendation.state === "READY" && <label className={`server-project-retry recommendation-poster-upload${uploadingPosterId === recommendation.id ? " is-disabled" : ""}`} aria-label={`Загрузить или заменить превью ${recommendation.title}`} title="Загрузить или заменить превью"><input className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={uploadingPosterId === recommendation.id} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadRecommendationPoster(recommendation, file); }} />{uploadingPosterId === recommendation.id ? <LoaderCircle className="spin" size={17} /> : <ImageUp size={17} />}</label>}
                  <button className="server-project-delete" type="button" disabled={deletingRecommendationId === recommendation.id} onClick={() => void deleteRecommendation(recommendation)} aria-label={`Удалить ${recommendation.title}`} title="Удалить рекомендацию">{deletingRecommendationId === recommendation.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}</button>
                </div>
              </article>
            )) : <div className="admin-empty">РЕКОМЕНДАЦИИ ЕЩЁ НЕ ДОБАВЛЕНЫ</div>}
          </div>
        </section>
        <section className="server-projects-panel">
          <div className="admin-panel-heading">
            <div><p className="eyebrow">ТЕКУЩЕЕ ХРАНИЛИЩЕ</p><h2>Загруженные проекты</h2></div>
            <div className="admin-project-tools"><span>{projectCount(projects.length)}</span><button type="button" onClick={() => void refreshProjects()} aria-label="Обновить список" title="Обновить список"><RefreshCw className={loading ? "spin" : ""} size={17} /></button></div>
          </div>

          <div className="admin-project-list">
            {loading && !projects.length ? (
              <div className="admin-empty"><LoaderCircle className="spin" size={18} /> ЗАГРУЖАЮ ПРОЕКТЫ</div>
            ) : projects.length ? projects.map((project) => (
              <article className="admin-project-row server-project-row" key={project.id}>
                <div className="server-project-main">
                  <div className="server-project-title"><strong>{project.title || "Без названия"}</strong><a href={project.sourceUrl} target="_blank" rel="noreferrer" aria-label="Открыть исходное видео" title="Открыть исходное видео"><ExternalLink size={14} /></a></div>
                  <span className={`server-project-state state-${project.state.toLowerCase()}`}>{stateLabels[project.state] ?? project.state}</span>
                  <div className="server-project-progress" aria-label={`Прогресс ${project.progress}%`}><i style={{ width: `${Math.max(0, Math.min(100, project.progress || 0))}%` }} /></div>
                  <div className="server-project-meta"><span>СОЗДАН {formatDate(project.createdAt)}</span><span>ХРАНИТСЯ ДО {formatDate(project.workingExpiresAt)}</span><span>{formatDuration(project.duration)}</span><span>ДУБЛЕЙ {project.recordedCueIds.length}</span></div>
                  {project.error && <p className="server-project-error">{project.error}</p>}
                </div>
                <div className="server-project-actions">
                  {project.state === "FAILED" && <button className="server-project-retry" type="button" disabled={retryingId === project.id} onClick={() => void retryProject(project)} aria-label={`Повторить обработку ${project.title}`} title="Повторить обработку">{retryingId === project.id ? <LoaderCircle className="spin" size={18} /> : <RotateCcw size={18} />}</button>}
                  <button className="server-project-delete" type="button" disabled={deletingId === project.id} onClick={() => void deleteProject(project)} aria-label={`Удалить ${project.title}`} title="Удалить проект и файлы">{deletingId === project.id ? <LoaderCircle className="spin" size={18} /> : <Trash2 size={18} />}</button>
                </div>
              </article>
            )) : (
              <div className="admin-empty">НА СЕРВЕРЕ НЕТ ПРОЕКТОВ</div>
            )}
          </div>
          <div className="admin-notice"><span className="signal-dot" />{notice}</div>
        </section>
        <section className="server-projects-panel cache-panel">
          <div className="admin-panel-heading">
            <div><p className="eyebrow">ПОВТОРНОЕ ИСПОЛЬЗОВАНИЕ</p><h2>Подготовленный кеш</h2></div>
            <div className="admin-project-tools"><span>{cacheEntries.length} ОБЪЕКТОВ</span><button type="button" disabled={!cacheEntries.length || deletingCacheId === "*"} onClick={() => void clearCache()} aria-label="Очистить весь кеш" title="Очистить весь кеш"><Eraser size={17} /></button></div>
          </div>
          <div className="admin-cache-list">
            {cacheEntries.length ? cacheEntries.map((entry) => (
              <article className="admin-cache-row" key={entry.videoId}>
                <div><strong>{entry.title || "Без названия"}</strong><span>{formatDuration(entry.duration)} · {formatBytes(entry.bytes)} · ИСПОЛЬЗОВАН {formatDate(entry.lastUsedAt)}</span></div>
                <a href={entry.sourceUrl} target="_blank" rel="noreferrer" aria-label="Открыть исходное видео" title="Открыть исходное видео"><ExternalLink size={16} /></a>
                <button type="button" disabled={deletingCacheId === entry.videoId} onClick={() => void deleteCache(entry)} aria-label={`Удалить кеш ${entry.title}`} title="Удалить кеш">{deletingCacheId === entry.videoId ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}</button>
              </article>
            )) : <div className="admin-empty">ПОДГОТОВЛЕННЫЙ КЕШ ПУСТ</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
