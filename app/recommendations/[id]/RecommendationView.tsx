"use client";
/* eslint-disable jsx-a11y/media-has-caption */

import { ArrowLeft, Film, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type Recommendation = {
  id: string;
  title: string;
  duration: number;
  videoUrl: string;
  posterUrl: string | null;
};

export default function RecommendationView({ id }: { id: string }) {
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/v1/recommendations/${encodeURIComponent(id)}`, { cache: "no-store" });
        const payload = await response.json() as { recommendation?: Recommendation };
        if (!cancelled && response.ok && payload.recommendation) setRecommendation(payload.recommendation);
      } catch {
        if (!cancelled) setRecommendation(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [id]);

  return (
    <main className="recommendation-public-page">
      <header className="topbar">
        <a className="brand" href="https://kupigolos.ru/" aria-label="КупиГолос, основной сайт"><img className="brand-logo" src="/kupigolos-logo.svg" alt="КупиГолос" width="109" height="51" /></a>
        <div className="project-chip"><span className="signal-dot" />РЕКОМЕНДАЦИЯ</div>
        <div className="top-actions"><Link className="quiet-button" href="/"><ArrowLeft size={14} /> В СТУДИЮ</Link></div>
      </header>
      <section className="recommendation-public-view" aria-live="polite">
        {loading ? (
          <div className="recommendation-public-status"><LoaderCircle className="spin" size={22} /> ЗАГРУЖАЮ ВИДЕО</div>
        ) : recommendation ? (
          <>
            <p className="eyebrow">РЕКОМЕНДУЕМ</p>
            <h1>{recommendation.title}</h1>
            <video src={recommendation.videoUrl} poster={recommendation.posterUrl || undefined} controls preload="metadata" playsInline aria-label={recommendation.title} />
            <div className="recommendation-public-actions"><Link className="recommendation-select-button" href={`/?recommendation=${encodeURIComponent(recommendation.id)}`}><Film size={16} /> ОЗВУЧИТЬ ЭТО ВИДЕО</Link></div>
          </>
        ) : (
          <div className="recommendation-public-status">ВИДЕО НЕДОСТУПНО</div>
        )}
      </section>
    </main>
  );
}
