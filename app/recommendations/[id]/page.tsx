import type { Metadata } from "next";
import RecommendationView from "./RecommendationView";

export const metadata: Metadata = {
  title: "Рекомендация | DUBROOM",
  description: "Рекомендованное видео от студии озвучки DUBROOM.",
};

export default async function RecommendationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecommendationView id={id} />;
}
