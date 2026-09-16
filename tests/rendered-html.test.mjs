import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function fetchWorker(request) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    request,
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render(pathname = "/") {
  return fetchWorker(new Request(`http://localhost${pathname}`, {
    headers: { accept: "text/html" },
  }));
}

test("server-renders the Russian DUBROOM workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ru">/i);
  assert.match(html, /<title>DUBROOM \| студия озвучки<\/title>/i);
  assert.match(html, /Озвучить видео с YouTube/);
  assert.match(html, /Рекомендуем/);
  assert.match(html, /РЕКОМЕНДАЦИИ ПОЯВЯТСЯ ЗДЕСЬ/);
  assert.doesNotMatch(html, /Я владею этим видео или имею право использовать его для озвучки/);
  assert.doesNotMatch(html, /СВОЙ АРХИВ|ВИДЕОКАТАЛОГ|\.rar|\.zip/i);
  assert.match(html, /Озвучь эту сцену/);
  assert.doesNotMatch(html, /СТУДИЯ \/ ДУБЛЬ/);
  assert.doesNotMatch(html, /class="scene-indicator"/);
  assert.match(html, /class="screen-placeholder-logo"/);
  assert.match(html, /СРАВНЕНИЕ ДОРОЖЕК/);
  assert.match(html, /ПРОСМОТРЕТЬ ОРИГИНАЛЬНЫЙ ФРАГМЕНТ/);
  assert.match(html, /ЗАПИСАТЬ ДУБЛЬ/);
  assert.match(html, /СЛЕДУЮЩИЙ ФРАГМЕНТ/);
  assert.match(html, /href="https:\/\/kupigolos\.ru\/"/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("uses the final fragment button as the MP4 action", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sideRackStart = page.indexOf("<aside className={`side-rack");
  const sideRack = page.slice(sideRackStart, page.indexOf("</aside>", sideRackStart));

  assert.ok(sideRackStart >= 0);
  assert.doesNotMatch(sideRack, /className="render-button/);
  assert.match(sideRack, /isLastCue \? "СКАЧАТЬ ВИДЕО" : "СЛЕДУЮЩИЙ ФРАГМЕНТ"/);
  assert.match(sideRack, /else if \(isLastCue\)/);
  assert.match(sideRack, /void renderVideo\(\)/);
  assert.match(sideRack, /renderUrl \? "ОТКРЫТЬ ПРЕДПРОСМОТР"/);
  assert.doesNotMatch(page, /className="render-result-heading"/);
  assert.doesNotMatch(page, /<h2[^>]*>Проверьте результат<\/h2>/);
  assert.doesNotMatch(page, /renderResultTab|render-result-tabs|ПЕРЕЙТИ К СКАЧИВАНИЮ/);
  assert.match(page, /className="render-download-button"[^>]+download=\{renderFileName\}/);
});

test("keeps player subtitles compact", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const subtitleRule = css.match(/\.subtitle-line span \{[^}]+\}/)?.[0] ?? "";

  assert.match(subtitleRule, /font-size: clamp\(11px, 1\.45vw, 17px\)/);
  assert.match(subtitleRule, /line-height: 1\.25/);
});

test("uses the red Kupigolos mark in the waveform header", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /className="waveform-brand-logo" role="img" aria-label="КупиГолос"/);
  assert.doesNotMatch(page, /activeCueWindow\.duration\.toFixed\(1\).*РЕПЛИКА/);
  assert.match(css, /\.waveform-brand-logo \{[^}]*background: var\(--red\);/);
  assert.match(css, /mask: url\("\/kupigolos-logo\.svg"\)/);
});

test("uses the Kupigolos navigation header", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /className="topbar-nav"/);
  assert.match(page, />Услуги<\/a>/);
  assert.match(page, />Дикторы<\/a>/);
  assert.match(page, /ИИ сервисы<\/a>/);
  assert.match(page, />Инфопортал<\/a>/);
  assert.match(page, />Статьи<\/a>/);
  assert.doesNotMatch(page, /href="\/admin"/);
});

test("keeps recommendations in one scrollable row with arrow controls", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /aria-label="Предыдущие рекомендации"/);
  assert.match(page, /aria-label="Следующие рекомендации"/);
  assert.match(page, /scrollBy\(\{ left:/);
  assert.match(css, /\.recommendations-grid \{[^}]*grid-auto-flow: column;/);
  assert.match(css, /\.recommendations-grid \{[^}]*overflow-x: auto;/);
  assert.doesNotMatch(css, /\.recommendations-grid \{[^}]*grid-template-columns:/);
});

test("uses the trusted public origin for social metadata", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:image" content="https:\/\/dubroom\.186-246-46-242\.sslip\.io\/og\.png"/i);
  assert.doesNotMatch(html, /property="og:image" content="http:\/\/localhost/i);
});

test("server-renders the protected admin entry route", async () => {
  const response = await render("/admin");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /АДМИН-ПАНЕЛЬ|ПРОВЕРЯЮ ДОСТУП/);
  assert.doesNotMatch(html, /Your site is taking shape/i);
});

test("protects server project administration before proxying API requests", async () => {
  const [listRoute, deleteRoute, retryRoute, jobsRoute, jobRetryRoute, settingsRoute, cacheRoute, cacheDeleteRoute, recommendationsRoute, recommendationDeleteRoute, recommendationPosterRoute] = await Promise.all([
    readFile(new URL("../app/api/admin/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/projects/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/projects/[id]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/jobs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/jobs/[id]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/cache/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/cache/[videoId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/recommendations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/recommendations/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/recommendations/[id]/poster/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [listRoute, deleteRoute, retryRoute, jobsRoute, jobRetryRoute, settingsRoute, cacheRoute, cacheDeleteRoute, recommendationsRoute, recommendationDeleteRoute, recommendationPosterRoute]) {
    const authCheck = source.indexOf("if (!isAdminRequest(request)) return adminUnauthorized()");
    const proxyCall = source.indexOf("await fetch(");
    assert.ok(authCheck >= 0 && proxyCall > authCheck);
    assert.match(source, /X-Dubroom-Admin-Token/);
  }
  assert.match(listRoute, /export async function GET/);
  assert.match(deleteRoute, /export async function DELETE/);
  assert.match(retryRoute, /export async function POST/);
  assert.match(jobsRoute, /export async function GET/);
  assert.match(jobRetryRoute, /export async function POST/);
  assert.match(settingsRoute, /export function PUT/);
  assert.match(cacheRoute, /export function DELETE/);
  assert.match(recommendationsRoute, /export async function POST/);
  assert.match(recommendationDeleteRoute, /export async function DELETE/);
  assert.match(recommendationPosterRoute, /export async function PUT/);
  const [page, admin] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
  ]);
  const [recommendationPage, recommendationView, layout] = await Promise.all([
    readFile(new URL("../app/recommendations/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/recommendations/[id]/RecommendationView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /\/v1\/recommendations/);
  assert.match(admin, /ПОСТОЯННЫЙ КАТАЛОГ/);
  assert.match(admin, /accept="video\/mp4,\.mp4"/);
  assert.match(admin, /recommendationSourceMode === "youtube"/);
  assert.match(admin, /https:\/\/www\.youtube\.com\/watch\?v=/);
  assert.match(admin, /copyRecommendationLink/);
  assert.doesNotMatch(page, /href=\{recommendation\.shareUrl\}/);
  assert.match(admin, /href=\{recommendation\.shareUrl\}/);
  assert.match(admin, /Скопировать ссылку для озвучки/);
  assert.match(admin, /createRecommendationCategory/);
  assert.match(admin, /assignRecommendationCategory/);
  assert.match(admin, /uploadRecommendationPoster/);
  assert.match(admin, /image\/jpeg,image\/png,image\/webp/);
  assert.match(admin, /Новая категория/);
  assert.match(page, /activeRecommendationCategoryId/);
  assert.match(page, /recommendation-category-filters/);
  assert.match(page, /visibleRecommendationCategories/);
  assert.match(page, /selectRecommendation/);
  assert.match(page, /recommendationId: recommendation\.id/);
  assert.match(recommendationPage, /RecommendationView/);
  assert.match(recommendationView, /\/v1\/recommendations\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(recommendationView, /ОЗВУЧИТЬ ЭТО ВИДЕО/);
  assert.match(layout, /https:\/\/dubroom\.186-246-46-242\.sslip\.io/);
});

test("keeps waveform signals and playhead on the same fragment timeline", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /timestamp - previousUpdate >= 16/);
  assert.match(page, /const signalStartX = \(offset \/ cueWindow\.duration\) \* width/);
  assert.match(page, /const signalEndX = \(\(offset \+ signalDuration\) \/ cueWindow\.duration\) \* width/);
  assert.match(page, /const \[fragmentPosition, setFragmentPosition\]/);
  assert.match(page, /fragmentElapsed = Math\.min\(activeCueWindow\.duration, Math\.max\(0, fragmentPosition\)\)/);
  assert.match(page, /takeAudio\.currentTime \/ audioDuration/);
  assert.match(page, /performance\.now\(\) - originalStartedAt/);
  assert.match(page, /timelineModeRef\.current === "full"/);
  assert.match(page, /timelineModeRef\.current = "original"/);
  assert.match(page, /timelineModeRef\.current = "recording"/);
  assert.match(page, /timelineModeRef\.current = "take"/);
  assert.match(page, /Math\.max\(fullPlaybackPositionRef\.current \?\? rawPosition, rawPosition\)/);
  assert.match(page, /else if \(timelineModeRef\.current !== "full"\)/);
  assert.doesNotMatch(page, /className="prep-start"/);
  assert.doesNotMatch(page, /className="prep-end"/);
  assert.doesNotMatch(page, /<span>ФРАГМЕНТ \{activeCue\?\.id/);
  assert.doesNotMatch(page, /className="notice-strip"/);
  const playheadRule = css.match(/\.waveform-playhead \{[^}]+\}/)?.[0] ?? "";
  assert.ok(playheadRule);
  assert.doesNotMatch(playheadRule, /transition\s*:/);
});

test("draws the microphone waveform live during the recorded cue", async () => {
  const [page, worklet] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/audio-capture-worklet.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /context\.createMediaStreamSource\(stream\)/);
  assert.match(page, /context\.createAnalyser\(\)/);
  assert.match(page, /phase === "recording"\) captureLiveWaveform/);
  assert.match(page, /const phaseLimit = phase === "preparing" \? cueWindow\.leadIn : cueWindow\.duration/);
  assert.match(page, /recorder\.onstart = \(\) =>/);
  assert.match(page, /recordingWindowStartedAtRef\.current = performance\.now\(\) - cueWindow\.leadIn \* 1000/);
  assert.match(page, /drawPeaks\(liveWaveformPeaksRef\.current/);
  assert.match(page, /context\.fillStyle = fillColor/);
  assert.match(page, /rgba\(238, 91, 184, \.16\)/);
  assert.match(page, /rgba\(92, 225, 230, \.18\)/);
  assert.match(page, /stopMicVisualization\(true\)/);
  assert.match(page, /audioWorklet\.addModule\("\/audio-capture-worklet\.js"\)/);
  assert.match(page, /frames: Math\.round\(cueWindow\.cueDuration/);
  assert.match(page, /encodeMonoWav/);
  assert.match(worklet, /this\.remainingFrames/);
  assert.match(worklet, /registerProcessor\("dubroom-pcm-recorder"/);
});

test("preserves an active project until a replacement is created", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /localStorage\.getItem\("dubroom-local-project"\) \|\| sessionStorage\.getItem/);
  assert.match(page, /const previousSession = localProjectSession/);
  assert.match(page, /if \(previousSession && previousSession\.id !== session\.id\)/);
  const startFunction = page.slice(page.indexOf("async function startServerProject"), page.indexOf("async function startYoutubeProject"));
  assert.doesNotMatch(startFunction, /leaveLocalProject\(\)/);
  assert.match(startFunction, /Текущий проект сохранён/);
});

test("uses the same public origin for the project API by default", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const projectApi = \(process\.env\.NEXT_PUBLIC_PROJECT_API \?\? ""\)\.replace/);
  assert.match(page, /projectApi \|\| \(typeof window !== "undefined" \? window\.location\.origin : "http:\/\/localhost"\)/);
  assert.doesNotMatch(page, /NEXT_PUBLIC_PROJECT_API \?\? "http:\/\/127\.0\.0\.1:5180"/);
});
