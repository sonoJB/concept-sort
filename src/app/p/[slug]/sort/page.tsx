import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { SortBoard } from "@/components/SortBoard";

export default async function SortPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: { orderBy: { order: "asc" } } },
  });

  if (!project) notFound();

  return (
    <main className="flex-1">
      <SortBoard
        slug={project.slug}
        title={project.title}
        prompt={project.prompt}
        statements={project.statements.map((s) => ({ id: s.id, text: s.text }))}
      />
    </main>
  );
}
