'use client';
import { useMemo } from 'react';
import { findProjectTag, projectTagCatalog } from '../domain/tags';
import { useAllProjects } from '../state/hooks';
import { Icons } from './icons';
import { Kw } from './ui';

/**
 * Görev etiketi rozetinin TEK gösterim yolu.
 *
 * Etiketin görsel kimliği (renk ve simge) proje etiket kataloğunda yaşar, görev
 * kaydında değil: görev yalnızca anahtar sözcüğü taşır. Rozet doğrudan
 * `task.color` ile çizilseydi, Proje Yapısı sayfasında seçilen renk ve simge
 * yalnızca açılır listede görünür, Görevler / Kanban / Takvim / görev panelinde
 * hiçbir etkisi olmazdı. Katalog bu yüzden çizim anında `(projectId, keyword)`
 * ile çözülür.
 *
 * Katalogda karşılığı olmayan (eski ya da katalog dışı) bir anahtar sözcük
 * projenin rengiyle çizilmeye devam eder.
 */
export function TaskKeyword({ task }) {
  const projects = useAllProjects();
  const tag = useMemo(() => {
    if (!task?.keyword) return null;
    const project = projects.find((item) => item.id === task.projectId) || null;
    return project ? findProjectTag(projectTagCatalog(project), task.keyword) : null;
  }, [projects, task?.projectId, task?.keyword]);

  if (!task?.keyword) return null;
  const TagIcon = tag ? (Icons[tag.icon] || Icons.Flag) : null;
  return (
    <Kw color={tag?.color || task.color}>
      {TagIcon && <TagIcon size={11} />}
      {task.keyword}
    </Kw>
  );
}
