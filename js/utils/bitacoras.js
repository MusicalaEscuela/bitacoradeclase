import { normalizeTags, toStringSafe } from "./shared.js";

function collectWorkValues(bitacora = {}) {
  const values = [
    bitacora.componenteObras,
    bitacora.worksComponent,
    bitacora.songs,
    bitacora.canciones,
    bitacora.obras,
  ];

  const content = toStringSafe(bitacora.content || bitacora.contenido);
  const match = content.match(/COMPONENTE DE OBRAS:\s*([\s\S]*?)(?:\n\s*\n[A-ZÁÉÍÓÚÑ /]+:|$)/i);
  if (match?.[1]) values.push(match[1]);

  return normalizeTags(values.flatMap((value) => value || []));
}

export function applyAutomaticCategoriesFromWorks(bitacora = {}) {
  const workValues = collectWorkValues(bitacora);
  if (!workValues.length) return { ...bitacora };

  const tags = normalizeTags(bitacora.tags || bitacora.etiquetas || bitacora.categorias);
  const hasSuzuki = workValues.some((value) => /suzuki/i.test(toStringSafe(value)));
  const hasNonSuzuki = workValues.some((value) => value && !/suzuki/i.test(toStringSafe(value)));
  const nextTags = [...tags];
  const hasTag = (label) =>
    nextTags.some((tag) => toStringSafe(tag).toLowerCase() === label.toLowerCase());

  if (hasSuzuki && !hasTag("Método")) nextTags.push("Método");
  if (hasNonSuzuki && !hasTag("Canciones/Obras")) nextTags.push("Canciones/Obras");

  return {
    ...bitacora,
    tags: nextTags,
    etiquetas: nextTags,
  };
}
