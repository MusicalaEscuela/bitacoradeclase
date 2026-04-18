import { CONFIG } from "../config.js";
import { escapeHtml } from "../utils/shared.js";

const LIBRARIES = Object.freeze([
  {
    id: "guitarra",
    title: "Biblioteca de Guitarra",
    description:
      "Accede al repertorio, materiales y recursos de apoyo para el proceso de guitarra.",
    href: "https://musicalaescuela.github.io/bibliotecaguitarra/",
    status: "Disponible",
  },
  {
    id: "piano",
    title: "Biblioteca de Piano",
    description:
      "Espacio reservado para partituras, ejercicios y materiales del proceso de piano.",
    href: "",
    status: "Proximamente",
  },
  {
    id: "canto",
    title: "Biblioteca de Canto",
    description:
      "Espacio reservado para guias vocales, repertorio y recursos del proceso de canto.",
    href: "",
    status: "Proximamente",
  },
  {
    id: "baile",
    title: "Biblioteca de Baile",
    description:
      "Espacio reservado para secuencias, recursos audiovisuales y materiales del proceso de baile.",
    href: "",
    status: "Proximamente",
  },
  {
    id: "artes-plasticas",
    title: "Biblioteca de Artes Plasticas",
    description:
      "Espacio reservado para referentes, tecnicas, guias y recursos del proceso de artes plasticas.",
    href: "",
    status: "Proximamente",
  },
]);

export async function render({ root, config } = {}) {
  if (!root) return;

  const safeConfig = config || CONFIG;
  root.innerHTML = buildMarkup(safeConfig);
}

function buildMarkup(config) {
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitacoras de Clase";

  return `
    <section class="view-shell view-shell--libraries">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Bibliotecas Artisticas</h1>
          <p class="view-description">
            Reune en un solo lugar las bibliotecas de cada arte para entrar
            rapido al material que docentes y estudiantes necesitan.
          </p>
        </div>
      </header>

      <section class="settings-grid">
        ${LIBRARIES.map(renderLibraryCard).join("")}
      </section>
    </section>
  `;
}

function renderLibraryCard(library) {
  const isAvailable = Boolean(library?.href);

  return `
    <article class="card settings-panel">
      <header class="panel-header">
        <div class="panel-header__content">
          <p class="panel-header__eyebrow">Biblioteca</p>
          <h2 class="panel-header__title">${escapeHtml(library?.title || "Biblioteca")}</h2>
        </div>
      </header>

      <p class="view-description">${escapeHtml(library?.description || "")}</p>
      <p class="field__hint">Estado: ${escapeHtml(library?.status || "Proximamente")}</p>

      <div class="settings-form-actions">
        ${
          isAvailable
            ? `
              <a
                class="btn btn--primary"
                href="${escapeHtml(library.href)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir biblioteca
              </a>
            `
            : `
              <button
                type="button"
                class="btn btn--ghost"
                disabled
              >
                Proximamente
              </button>
            `
        }
      </div>
    </article>
  `;
}
