// js/views/profile.view.js

import { CONFIG } from "../config.js";
import { canViewStudent, resolveUserAccess } from "../authz.js";
import {
  getState,
  getSelectedStudentId,
  getSelectedStudentBitacoras,
  getAllStudents,
  getStudentGoals,
  getStudentRoute,
  setAppError,
  clearAppError,
  addBitacoraForStudent,
  setBitacorasForStudent,
  removeBitacoraForStudent,
  setBitacorasLoading,
  setProfileLoading,
  setSelectedStudent,
  setStudentGoals,
  setStudentProfile,
  setStudentRoute,
  updateStudentProfile,
} from "../state.js";
import {
  getBitacoraById,
  getBitacorasByStudentIds,
  createBitacora,
  updateBitacora,
  deleteBitacora,
} from "../api/bitacoras.api.js?v=20260713.2";
import {
  getStudentProfile,
  updateStudentTeacher,
  updateStudentRepertoire,
  listStudentWorkSuggestions,
  resolveStudentWorkSuggestion,
  updateStudentProfileFields,
  updateStudentProcesses,
  getStudentPrivateNotes,
  saveStudentPrivateNotes,
} from "../api/students.api.js?v=20260724.3";
import {
  getCatalogs,
  getEmptyCatalogs,
} from "../api/catalogs.api.js";
import {
  getStudentRouteRecord,
  saveStudentRouteProgressRecord,
  saveStudentRouteRecord,
} from "../api/student-routes.api.js";
import {
  escapeHtml,
  firstNonEmpty,
  formatDisplayDate,
  getReadableValue,
  getStudentDocument,
  getStudentAcademicRecordId,
  getStudentCondition,
  getStudentFallbackId,
  getStudentIdentity,
  getStudentLinkedIds,
  getStudentName,
  getStudentProcessesSummary,
  normalizeStudentProcesses,
  resolveStudentProcess,
  slugifyProcessKey,
  getTimestamp,
  getTodayDate,
  isPlainObject,
  normalizeLocalDateInput,
  normalizeBitacorasResponse as normalizeBitacorasResponseShared,
  normalizeMode,
  normalizeText,
  normalizeStudentIds,
  normalizeStudentRefs,
  resolveStudentAcademicRecordIdFromBitacoras,
  resolveStudentRefFromPayload,
  findStudentInCollections,
  toStringSafe,
} from "../utils/shared.js";
import { applyAutomaticCategoriesFromWorks } from "../utils/bitacoras.js";
import {
  normalizeLinkList,
  parseBitacoraSheetText,
  splitDelimitedRows,
} from "../utils/bitacoras-import.js";

let viewRoot = null;
let unsubscribeView = null;
let currentNavigateTo = null;
let currentSubscribe = null;
let currentProfileStudentKey = null;
let currentProfileProcessKey = "";
let currentProfileHistorySearchQuery = "";
let currentProfileHistoryVisibleCount = 10;
let profileHistorySearchTimer = null;
let historyExpansionState = new Map();
// Cada bitácora conserva el texto normalizado para búsqueda mientras su objeto
// exista en el estado. Así no reanalizamos contenido estructurado por letra.
let profileBitacoraSearchIndex = new WeakMap();
let cachedCatalogs = getEmptyCatalogs();
let catalogsLoadAttempted = false;
// Estado local de observaciones internas privadas (cargadas aparte por seguridad).
let internalNotesState = { studentId: "", text: "", loaded: false, loading: false };

const ROUTE_COMPONENTS = Object.freeze([
  { id: "corporal", label: "Componente corporal" },
  { id: "tecnico", label: "Componente tecnico" },
  { id: "teorico", label: "Componente teorico" },
  { id: "obras", label: "Componente de obras" },
  { id: "repertorio", label: "Componente repertorio" },
]);

const ROUTE_EXPERIENCES = Object.freeze([1, 2, 3]);
// Las tarjetas de historial son visualmente densas. Limitar el lote inicial
// mantiene el panel y su buscador ágiles, incluso con años de registros.
const PROFILE_HISTORY_RENDER_LIMIT = 10;
const PROFILE_HISTORY_SEARCH_DEBOUNCE_MS = 140;

const GUITAR_ROUTE_PRESET = Object.freeze([
  {
    id: "exp1-tecnica-gimnasia-dactilar",
    component: "tecnico",
    experience: 1,
    order: 1,
    title: "Tecnica: gimnasia dactilar (individuales, dobles, intermedios, alternados)",
    description: "Incluye ejercicios numerados 1 al 17.",
  },
  {
    id: "exp1-tecnica-spider-petrucci",
    component: "tecnico",
    experience: 1,
    order: 1,
    title: "Tecnica: Spider y Petrucci",
    description: "Petrucci: Ex 1 part 1, Ex 5 part 1, Example 9, Ex 11 Fragments, Example 17.",
  },
  {
    id: "exp1-patrones-tabla-mano-derecha",
    component: "tecnico",
    experience: 1,
    order: 1,
    title: "Patrones: tabla y mano derecha",
    description: "Tabla de patrones (1 al 30) y patrones de mano derecha (1 al 12).",
  },
  {
    id: "exp1-teoria-claves-sol-fa",
    component: "teorico",
    experience: 1,
    order: 1,
    title: "Teoria: clave de Sol y clave de Fa",
    description: "Lineas, espacios y lineas/espacios (1 al 5) en ambas claves.",
  },
  {
    id: "exp1-ritmo-inicial",
    component: "teorico",
    experience: 1,
    order: 1,
    title: "Ritmo inicial",
    description: "Ejercicios iniciales 1 al 10, motivos ritmicos 1 al 30, Studying Rhythm 1 al 10.",
  },
  {
    id: "exp2-metodo-govan",
    component: "tecnico",
    experience: 2,
    order: 2,
    title: "Metodo Govan",
    description: "Items 2.1, 2.2, 2.3, 2.7 y 2.9.",
  },
  {
    id: "exp2-escalas-mayores-menores-posicion-1",
    component: "tecnico",
    experience: 2,
    order: 2,
    title: "Escalas mayores y menores (1ra posicion)",
    description: "Mayores: C, G, D, A, E. Menores: Cm, Gm, Dm, Am, Em.",
  },
  {
    id: "exp2-mapa-y-2-octavas",
    component: "tecnico",
    experience: 2,
    order: 2,
    title: "Mapa 1ra posicion y escalas menores 2 octavas",
    description: "Mapa 1ra posicion: C, G, D, A, E. Menores 2 octavas: Cm, Gm, Dm, Am, Em.",
  },
  {
    id: "exp2-escalas-mayores-segunda-digitacion",
    component: "tecnico",
    experience: 2,
    order: 2,
    title: "Escalas mayores (2da digitacion)",
    description: "F, B, C#, F#, Ab.",
  },
  {
    id: "exp2-conceptos-musicales",
    component: "teorico",
    experience: 3,
    order: 3,
    title: "Conceptos musicales fundamentales",
    description: "Musica, notas, instrumento, digitacion, sonido, pilares, alteraciones, cifrado, partitura, claves, metricas y armadura.",
  },
  {
    id: "exp3-acordes-e-inversiones",
    component: "tecnico",
    experience: 3,
    order: 3,
    title: "Acordes, inversiones y arpegios mayores",
    description: "Mayores, menores, inversiones mayores y arpegios mayores (G, D, A, E, C).",
  },
  {
    id: "exp3-independencia-disociacion-estilos",
    component: "tecnico",
    experience: 3,
    order: 3,
    title: "Independencia y disociacion aplicada",
    description: "Acompanamientos iniciales (1 al 10), disociacion (acordes, marcha, waltz, arpegio, bajo Alberti) y estilos/metodos.",
  },
  {
    id: "exp3-estructuras-musicales",
    component: "teorico",
    experience: 3,
    order: 3,
    title: "Estructuras musicales",
    description: "Escala cromatica, triadas, escalas mayores/menores, circulo de quintas, enlace de acordes y acordes de septima.",
  },
]);

const PIANO_LEARNING_ROUTE = Object.freeze({
  instrumento: "Piano",
  componentes: [
    {
      nombre: "Técnico",
      secciones: [
        {
          nombre: "Técnica",
          items: [
            { nombre: "Gimnasia dactilar individuales", tipo: "single" },
            { nombre: "Gimnasia dactilar dobles", tipo: "single" },
            { nombre: "Gimnasia dactilar intermedios", tipo: "single" },
            { nombre: "Gimnasia dactilar alternados", tipo: "single" },
          ],
        },
        {
          nombre: "Patrones",
          items: [
            { nombre: "Tabla de patrones", tipo: "progressive", niveles: Array.from({ length: 30 }, (_, i) => i + 1) },
            { nombre: "Patrones móviles", tipo: "progressive", niveles: Array.from({ length: 10 }, (_, i) => i + 1) },
            { nombre: "Schmitt", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Hanon", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
          ],
        },
        {
          nombre: "Escalas",
          items: [
            { nombre: "Escalas mayores 1er dig", tipo: "checklist", valores: ["C", "G", "D", "A", "E"] },
            { nombre: "Escalas menores 1er dig", tipo: "checklist", valores: ["Cm", "Gm", "Dm", "Am", "Em"] },
            { nombre: "Escalas mayores 2 octavas", tipo: "checklist", valores: ["C", "G", "D", "A", "E"] },
            { nombre: "Escalas menores 2 octavas", tipo: "checklist", valores: ["Cm", "Gm", "Dm", "Am", "Em"] },
            { nombre: "Escalas mayores 2da dig", tipo: "checklist", valores: ["F", "B", "C#", "F#", "Ab"] },
          ],
        },
        {
          nombre: "Acordes",
          items: [
            { nombre: "Acordes mayores", tipo: "checklist", valores: ["G", "D", "A", "E", "C", "B", "C#", "Ab", "Eb", "Bb", "F#", "F"] },
            { nombre: "Acordes menores", tipo: "checklist", valores: ["Gm", "Dm", "Am", "Em", "Cm", "Bm", "C#m", "Abm", "Ebm", "Bbm", "F#m", "Fm"] },
            { nombre: "Inversiones mayores", tipo: "checklist", valores: ["G", "D", "A", "E", "C", "B", "C#", "Ab", "Eb", "Bb", "F#", "F"] },
            { nombre: "Arpegios mayores", tipo: "checklist", valores: ["G", "D", "A", "E", "C"] },
          ],
        },
        {
          nombre: "Independencia",
          items: [
            { nombre: "Ejercicios iniciales", tipo: "progressive", niveles: Array.from({ length: 13 }, (_, i) => i + 1) },
            { nombre: "Ejercicios de disociación", tipo: "checklist", valores: ["Acordes", "Marcha", "Waltz", "Arpegio", "Bajo Alberti"] },
            { nombre: "Rock Hanon", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Blues Hanon", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Salsa Hanon", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Czerny Colombiano", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
          ],
        },
      ],
    },
    {
      nombre: "Teórico",
      secciones: [
        {
          nombre: "Teoría",
          items: [
            { nombre: "Líneas clave sol", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Espacios clave sol", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Líneas y espacios clave sol", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Líneas clave fa", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Espacios clave fa", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Líneas y espacios clave fa", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
          ],
        },
        {
          nombre: "Ritmo",
          items: [
            { nombre: "Ejercicios iniciales", tipo: "progressive", niveles: Array.from({ length: 9 }, (_, i) => i + 1) },
            { nombre: "Motivos rítmicos", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
            { nombre: "Studying Rhythm", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
          ],
        },
        {
          nombre: "Conceptos musicales",
          items: [
            { nombre: "¿Qué es la música?", tipo: "single" },
            { nombre: "Nombre de notas musicales", tipo: "single" },
            { nombre: "Explicación del instrumento", tipo: "single" },
            { nombre: "Digitación en el instrumento", tipo: "single" },
            { nombre: "Sonido (timbre, duración, altura, intensidad)", tipo: "multi" },
            { nombre: "Pilares de la música (melodía, armonía, ritmo)", tipo: "multi" },
            { nombre: "Alteraciones (sostenidos, bemoles, becuadros)", tipo: "multi" },
            { nombre: "Cifrado", tipo: "single" },
            { nombre: "Partitura (pentagrama, sistema, compás)", tipo: "multi" },
            { nombre: "Clave (sol, fa, do)", tipo: "multi" },
            { nombre: "Métricas (4/4, 3/4, 2/4)", tipo: "multi" },
            { nombre: "Armadura", tipo: "single" },
          ],
        },
        {
          nombre: "Estructuras",
          items: [
            { nombre: "Escala cromática", tipo: "single" },
            { nombre: "Triadas mayores (4-3)", tipo: "single" },
            { nombre: "Triadas menores (3-4)", tipo: "single" },
            { nombre: "Escalas mayores", tipo: "single" },
            { nombre: "Círculo de quintas", tipo: "single" },
            { nombre: "Enlace de acordes", tipo: "single" },
            { nombre: "Escalas menores", tipo: "single" },
            { nombre: "Acordes de séptima", tipo: "single" },
            { nombre: "Armonía", tipo: "single" },
          ],
        },
      ],
    },
    {
      nombre: "Repertorio",
      secciones: [
        {
          nombre: "Canciones",
          items: [
            { nombre: "Melodía manos separadas", tipo: "single" },
            { nombre: "Melodía manos juntas", tipo: "single" },
            { nombre: "Melodía + bajo", tipo: "single" },
            { nombre: "Melodía + acordes", tipo: "single" },
            { nombre: "Acordes manos separadas", tipo: "single" },
            { nombre: "Acordes manos juntas", tipo: "single" },
            { nombre: "Bajo + acorde", tipo: "single" },
            { nombre: "Acompañamiento con acordes", tipo: "single" },
          ],
        },
        {
          nombre: "Método",
          items: [
            { nombre: "Waltz", tipo: "single" },
            { nombre: "Marcha", tipo: "single" },
            { nombre: "Swing", tipo: "single" },
            { nombre: "Suzuki I", tipo: "progressive", niveles: [1, 2, 3, 4, 5, 6, 7, 8] },
            { nombre: "Suzuki II", tipo: "progressive" },
            { nombre: "Bastien I", tipo: "progressive" },
            { nombre: "Bastien II", tipo: "progressive" },
          ],
        },
        {
          nombre: "Repertorio",
          items: [{ nombre: "Repertorio libre", tipo: "list" }],
        },
        {
          nombre: "Estudios",
          items: [
            { nombre: "Op. 70 - Berens", tipo: "progressive", niveles: Array.from({ length: 30 }, (_, i) => i + 1) },
            { nombre: "Op. 50 - Cramer", tipo: "progressive" },
            { nombre: "Op. 299 - Czerny", tipo: "progressive" },
          ],
        },
      ],
    },
  ],
});

function toLearningRouteComponentId(componentName = "") {
  const normalized = toStringSafe(componentName)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (normalized.includes("tecnico")) return "tecnico";
  if (normalized.includes("teorico")) return "teorico";
  if (normalized.includes("repertorio")) return "repertorio";
  return normalized || "general";
}

function normalizeRouteLevels(item = {}) {
  if (Array.isArray(item?.niveles) && item.niveles.length) {
    return item.niveles;
  }

  if (Array.isArray(item?.valores) && item.valores.length) {
    return item.valores;
  }

  return [1];
}

function buildGoalsFromLearningRoute(learningRoute, presetId = "route") {
  if (!learningRoute || !Array.isArray(learningRoute.componentes)) return [];

  const goals = [];

  learningRoute.componentes.forEach((component, componentIndex) => {
    const componentId = toLearningRouteComponentId(component?.nombre);
    const componentLabel = toStringSafe(component?.nombre) || "Componente";
    const experience = Math.min(componentIndex + 1, ROUTE_EXPERIENCES.length);
    let order = 1;

    (component?.secciones || []).forEach((section, sectionIndex) => {
      const sectionLabel = toStringSafe(section?.nombre) || `Sección ${sectionIndex + 1}`;

      (section?.items || []).forEach((item, itemIndex) => {
        const itemLabel = toStringSafe(item?.nombre) || `Item ${itemIndex + 1}`;
        const itemType = toStringSafe(item?.tipo).toLowerCase();

        if (itemType === "progressive" || itemType === "checklist") {
          normalizeRouteLevels(item).forEach((step) => {
            goals.push({
              id: `${presetId}-${componentId}-s${sectionIndex + 1}-i${itemIndex + 1}-${toStringSafe(step).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              component: componentId,
              componentLabel,
              section: sectionLabel,
              experience,
              order: order++,
              title: `${sectionLabel}: ${itemLabel} · ${step}`,
              description: `Progresión ${learningRoute.instrumento} · ${componentLabel}`,
            });
          });
          return;
        }

        goals.push({
          id: `${presetId}-${componentId}-s${sectionIndex + 1}-i${itemIndex + 1}`,
          component: componentId,
          componentLabel,
          section: sectionLabel,
          experience,
          order: order++,
          title: `${sectionLabel}: ${itemLabel}`,
          description: `Progresión ${learningRoute.instrumento} · ${componentLabel}`,
        });
      });
    });
  });

  return goals;
}

const PIANO_ROUTE_PRESET = Object.freeze({
  id: "piano_ruta_v1",
  routeName: "Ruta de aprendizaje - Piano",
  goals: buildGoalsFromLearningRoute(PIANO_LEARNING_ROUTE, "piano_ruta_v1"),
});

const CANTO_LEARNING_ROUTE = Object.freeze({
  instrumento: "Canto",
  componentes: [
    {
      nombre: "Técnico",
      secciones: [
        {
          nombre: "Respiración y soporte",
          items: [
            { nombre: "Respiración costo-diafragmática", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
            { nombre: "Control de flujo de aire (s/f/z)", tipo: "progressive", niveles: Array.from({ length: 10 }, (_, i) => i + 1) },
            { nombre: "Apoyo y sostén de frase", tipo: "progressive", niveles: Array.from({ length: 10 }, (_, i) => i + 1) },
          ],
        },
        {
          nombre: "Emisión y colocación",
          items: [
            { nombre: "Vocalizaciones en 5 notas", tipo: "progressive", niveles: Array.from({ length: 15 }, (_, i) => i + 1) },
            { nombre: "Resonadores (máscara y pecho)", tipo: "checklist", valores: ["Nasal frontal", "Máscara", "Pecho", "Mixto"] },
            { nombre: "Articulación y dicción", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
          ],
        },
        {
          nombre: "Afinación e intervalos",
          items: [
            { nombre: "Entonación por grados conjuntos", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
            { nombre: "Intervalos básicos cantados", tipo: "checklist", valores: ["2da", "3ra", "4ta", "5ta", "6ta", "8va"] },
            { nombre: "Escalas mayores y menores cantadas", tipo: "checklist", valores: ["Do", "Sol", "Re", "La", "Mi"] },
          ],
        },
      ],
    },
    {
      nombre: "Teórico",
      secciones: [
        {
          nombre: "Lenguaje musical vocal",
          items: [
            { nombre: "Lectura rítmica vocal", tipo: "progressive", niveles: Array.from({ length: 16 }, (_, i) => i + 1) },
            { nombre: "Lectura melódica en pentagrama", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
            { nombre: "Función armónica para cantante", tipo: "single" },
          ],
        },
        {
          nombre: "Interpretación",
          items: [
            { nombre: "Dinámicas y fraseo", tipo: "checklist", valores: ["Piano", "Mezzo forte", "Forte", "Crescendo", "Diminuendo"] },
            { nombre: "Intención textual", tipo: "progressive", niveles: Array.from({ length: 8 }, (_, i) => i + 1) },
            { nombre: "Presencia escénica básica", tipo: "progressive", niveles: Array.from({ length: 8 }, (_, i) => i + 1) },
          ],
        },
      ],
    },
    {
      nombre: "Repertorio",
      secciones: [
        {
          nombre: "Montaje vocal",
          items: [
            { nombre: "Canción 1 (estructura y memoria)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Canción 2 (afinación y estilo)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Canción 3 (interpretación completa)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
          ],
        },
        {
          nombre: "Performance",
          items: [
            { nombre: "Ensayo con pista", tipo: "single" },
            { nombre: "Ensayo con micrófono", tipo: "single" },
            { nombre: "Presentación final", tipo: "single" },
          ],
        },
      ],
    },
  ],
});

const CELLO_LEARNING_ROUTE = Object.freeze({
  instrumento: "Cello",
  componentes: [
    {
      nombre: "Técnico",
      secciones: [
        {
          nombre: "Postura y arco",
          items: [
            { nombre: "Postura base y puntos de apoyo", tipo: "progressive", niveles: Array.from({ length: 10 }, (_, i) => i + 1) },
            { nombre: "Trazos de arco (détaché)", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
            { nombre: "Control de cuerdas al aire", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
          ],
        },
        {
          nombre: "Mano izquierda",
          items: [
            { nombre: "Digitación primera posición", tipo: "progressive", niveles: Array.from({ length: 14 }, (_, i) => i + 1) },
            { nombre: "Cambios de cuerda limpios", tipo: "progressive", niveles: Array.from({ length: 12 }, (_, i) => i + 1) },
            { nombre: "Extensiones y afinación", tipo: "checklist", valores: ["Semitono", "Tono", "Extensión 1-2", "Extensión 2-3"] },
          ],
        },
        {
          nombre: "Escalas y estudios",
          items: [
            { nombre: "Escalas mayores (1 octava)", tipo: "checklist", valores: ["Do", "Sol", "Re", "Fa"] },
            { nombre: "Escalas menores (1 octava)", tipo: "checklist", valores: ["La menor", "Re menor", "Sol menor"] },
            { nombre: "Estudios progresivos", tipo: "progressive", niveles: Array.from({ length: 15 }, (_, i) => i + 1) },
          ],
        },
      ],
    },
    {
      nombre: "Teórico",
      secciones: [
        {
          nombre: "Lectura aplicada",
          items: [
            { nombre: "Lectura en clave de Fa", tipo: "progressive", niveles: Array.from({ length: 16 }, (_, i) => i + 1) },
            { nombre: "Ritmo para cuerdas frotadas", tipo: "progressive", niveles: Array.from({ length: 14 }, (_, i) => i + 1) },
            { nombre: "Signos de arco y articulación", tipo: "checklist", valores: ["Ligado", "Staccato", "Acento", "Tenuto"] },
          ],
        },
        {
          nombre: "Sonoridad",
          items: [
            { nombre: "Calidad de sonido por zona de arco", tipo: "progressive", niveles: Array.from({ length: 10 }, (_, i) => i + 1) },
            { nombre: "Dinámicas en frases", tipo: "checklist", valores: ["pp", "p", "mf", "f", "ff"] },
          ],
        },
      ],
    },
    {
      nombre: "Repertorio",
      secciones: [
        {
          nombre: "Piezas",
          items: [
            { nombre: "Pieza 1 (melodía y ritmo)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Pieza 2 (arco y afinación)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
            { nombre: "Pieza 3 (expresión musical)", tipo: "progressive", niveles: [1, 2, 3, 4, 5] },
          ],
        },
        {
          nombre: "Ensamble",
          items: [
            { nombre: "Trabajo con acompañamiento", tipo: "single" },
            { nombre: "Ajuste de tempo y entradas", tipo: "single" },
            { nombre: "Presentación final", tipo: "single" },
          ],
        },
      ],
    },
  ],
});

const CANTO_ROUTE_PRESET = Object.freeze({
  id: "canto_ruta_v1",
  routeName: "Ruta de aprendizaje - Canto",
  goals: buildGoalsFromLearningRoute(CANTO_LEARNING_ROUTE, "canto_ruta_v1"),
});

const CELLO_ROUTE_PRESET = Object.freeze({
  id: "cello_ruta_v1",
  routeName: "Ruta de aprendizaje - Cello",
  goals: buildGoalsFromLearningRoute(CELLO_LEARNING_ROUTE, "cello_ruta_v1"),
});

const ROUTE_PRESETS = Object.freeze({
  guitarra: Object.freeze({
    id: "guitarra_objetivos_v1",
    routeName: "Ruta de aprendizaje - Guitarra",
    goals: GUITAR_ROUTE_PRESET,
  }),
  piano: PIANO_ROUTE_PRESET,
  canto: CANTO_ROUTE_PRESET,
  cello: CELLO_ROUTE_PRESET,
});

const routePresetCache = new Map();
const routeExpansionState = new Map();
const routeHistoryState = new Map();
const routeEditorState = new Map();

export async function beforeEnter({ payload, navigateTo } = {}) {
  clearAppError();

  let state = getState();
  const access = resolveUserAccess(state?.auth?.user);
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const requestedProcessRef = getRequestedProcessFromPayload(payload);
  const fallbackSelectedId = getSelectedStudentId();
  const selectedStudentRef =
    requestedStudentRef || fallbackSelectedId || null;

  let student = getStudentFromState(state, selectedStudentRef);

  if (!student || !canViewStudent(state?.auth?.user, getStudentIdentity(student))) {
    setAppError("No hay estudiante seleccionado.");
    if (typeof navigateTo === "function") {
      navigateTo(CONFIG.routes.search);
    }
    return;
  }

  currentProfileStudentKey = getStudentIdentity(student);
  currentProfileProcessKey =
    resolveStudentProcess(student, requestedProcessRef)?.processKey || "";
  await ensureCatalogsLoaded();
  await ensureStudentBitacorasLoaded(student);
  await ensureLearningRouteLoaded(student);
}

async function ensureStudentLoadedForProfile(studentRef) {
  const safeStudentRef = toStringSafe(studentRef);
  if (!safeStudentRef) return null;

  try {
    const profile = await getStudentProfile(safeStudentRef);
    if (!profile) return null;

    setStudentProfile(safeStudentRef, profile);
    setSelectedStudent({
      ...profile,
      id:
        profile?.id ||
        profile?.studentId ||
        profile?.studentKey ||
        safeStudentRef,
      studentId:
        profile?.studentId ||
        profile?.studentKey ||
        safeStudentRef,
      studentKey: profile?.studentKey || safeStudentRef,
    });

    return getStudentFromState(getState(), safeStudentRef);
  } catch (error) {
    console.error("Error cargando perfil de estudiante para profile:", error);
    return null;
  }
}

export async function render({
  root,
  state,
  config,
  navigateTo,
  payload,
  subscribe,
}) {
  viewRoot = root;
  currentNavigateTo = typeof navigateTo === "function" ? navigateTo : null;
  currentSubscribe = typeof subscribe === "function" ? subscribe : null;

  const safeState = state || getState();
  const safeConfig = config || CONFIG;
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const requestedProcessRef = getRequestedProcessFromPayload(payload);
  const student = getStudentFromState(safeState, requestedStudentRef);

  if (!student || !canViewStudent(safeState?.auth?.user, getStudentIdentity(student))) {
    root.innerHTML = renderMissingStudent();
    bindMissingStateEvents();
    setupSubscription(safeConfig, requestedStudentRef);
    return;
  }

  currentProfileStudentKey = getStudentIdentity(student);
  currentProfileProcessKey =
    resolveStudentProcess(student, requestedProcessRef || currentProfileProcessKey)
      ?.processKey || "";

  await ensureCatalogsLoaded();
  root.innerHTML = buildProfileMarkup(student, safeState, safeConfig);

  bindProfileEvents(student);
  renderStudentWorkSuggestions(student).then((html) => {
    const target = viewRoot?.querySelector("#profile-work-suggestions");
    if (!target) return;
    target.innerHTML = html;
    target.addEventListener("click", async (event) => {
      const accept = event.target.closest("[data-work-suggestion-accept]");
      const dismiss = event.target.closest("[data-work-suggestion-dismiss]");
      if (!accept && !dismiss) return;
      const id = (accept || dismiss).getAttribute(accept ? "data-work-suggestion-accept" : "data-work-suggestion-dismiss");
      try {
        if (accept) {
          await saveProfileRepertoire(student, [...getStudentRepertoireItems(student), { nombre: accept.getAttribute("data-work-suggestion-name"), estado: "quiere", prioridad: "media", notas: "", fechaInicio: "", fechaLogro: "" }]);
          await resolveStudentWorkSuggestion(id, "aceptada");
        } else {
          await resolveStudentWorkSuggestion(id, "descartada");
        }
        target.innerHTML = await renderStudentWorkSuggestions(student);
      } catch (error) { setAppError(error?.message || "No se pudo revisar la sugerencia."); }
    });
  });
  applyProfileFocusLayout(student);
  renderReactiveBlocks(getState(), safeConfig, currentProfileStudentKey);
  setupSubscription(safeConfig, currentProfileStudentKey);
}

export async function afterEnter() {
  const focusTarget = viewRoot?.querySelector(".profile-card__name");
  if (focusTarget) {
    focusTarget.setAttribute("tabindex", "-1");
    focusTarget.focus();
  }
}

export function beforeLeave() {
  cleanupView();
}

export function destroy() {
  cleanupView();
}

function setupSubscription(config, preferredStudentRef = null) {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  if (typeof currentSubscribe !== "function") return;

  unsubscribeView = currentSubscribe((nextState) => {
    if (!viewRoot || !viewRoot.isConnected) return;

    const state = nextState || getState();
    const student = getStudentFromState(
      state,
      preferredStudentRef || currentProfileStudentKey
    );

    if (!student) {
      viewRoot.innerHTML = renderMissingStudent();
      bindMissingStateEvents();
      return;
    }

    currentProfileStudentKey = getStudentIdentity(student);
    renderReactiveBlocks(state, config, currentProfileStudentKey);
  });
}

async function ensureCatalogsLoaded() {
  if (catalogsLoadAttempted) return cachedCatalogs;

  catalogsLoadAttempted = true;
  try {
    cachedCatalogs = await getCatalogs();
  } catch (error) {
    console.warn("No se pudo cargar catálogo de docentes:", error);
    cachedCatalogs = getEmptyCatalogs();
  }

  return cachedCatalogs;
}

function buildProfileMarkup(student, state, config) {
  const bitacoras = getBitacorasFromState(student);
  const isAuthenticated = Boolean(state?.auth?.isAuthenticated);
  const access = resolveUserAccess(state?.auth?.user);
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitácoras de Clase";
  const processOptions = normalizeStudentProcesses(student);
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    processOptions[0] ||
    null;
  const activeProcessKey = toStringSafe(activeProcess?.processKey);
  const activeProcessLabel = toStringSafe(
    activeProcess?.label || activeProcess?.detalle || activeProcess?.arte || "Proceso"
  );

  return `
    <section class="view-shell view-shell--profile">
      <header class="profile-quick-header">
        <div class="profile-quick-header__identity">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <div class="profile-card__title-row">
            ${renderStudentStatusDot(student)}
            <h1 class="profile-card__name">${escapeHtml(getStudentName(student))}</h1>
          </div>
          <div class="profile-card__badges" id="profile-badges">
            ${renderStudentBadges(student)}
          </div>
        </div>

        <div class="profile-quick-header__tools">
          <label class="field field--compact">
            <span class="field__label">Proceso activo</span>
            <select id="profile-process-select" class="field__input">
              ${renderProcessSelectOptions(processOptions, activeProcessKey)}
            </select>
          </label>
          <p class="profile-quick-header__process">
            ${escapeHtml(activeProcessLabel)}
          </p>
          <div class="profile-quick-header__actions">
            <button type="button" class="btn btn--ghost" id="profile-back-btn">
              Volver a búsqueda
            </button>
            ${
              access.role === CONFIG.roles.admin
                ? `<button type="button" class="btn btn--secondary" id="profile-import-text-bitacoras-btn">
                    Agregar bitácoras en texto
                  </button>`
                : ""
            }
            <button type="button" class="btn btn--primary" id="profile-open-editor-btn">
              Nueva bitácora
            </button>
          </div>
        </div>
      </header>

      <section class="profile-workspace">
        <section class="profile-dashboard" aria-label="Resumen de trabajo rápido">
          <article class="card profile-last-bitacora">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Última bitácora</p>
                <h2 class="panel-header__title" id="profile-history-title">Registro más reciente</h2>
              </div>
            </header>
            <div id="profile-history-content">
              ${renderLastBitacoraPreview(student, bitacoras, config, isAuthenticated)}
            </div>
          </article>

          <article class="card profile-route-preview">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Ruta actual</p>
                <h2 class="panel-header__title">Objetivos actuales</h2>
                <p class="panel__description">
                  Proceso activo: <strong>${escapeHtml(activeProcessLabel)}</strong>
                </p>
              </div>
            </header>
            <div id="profile-route-preview-content">
              ${renderCurrentRoutePreview(student)}
            </div>
          </article>

          <article class="card profile-repertoire-card">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Proyecto final</p>
                <h2 class="panel-header__title">Repertorio del proceso</h2>
                <p class="panel__description">
                  Canciones que el estudiante quiere tocar, está sacando o ya logró.
                </p>
              </div>
            </header>
            <div id="profile-repertoire-content">
              ${renderStudentRepertoireCard(student, access)}
            </div>
          </article>
          <div id="profile-work-suggestions"></div>

          <article class="card profile-quick-actions">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Accesos rápidos</p>
                <h2 class="panel-header__title">Profundizar</h2>
              </div>
            </header>
            ${renderQuickActions(access)}
          </article>
        </section>

        <section class="profile-panels" id="profile-panels" aria-live="polite">
          <article class="card profile-panel" data-profile-panel="student-info" hidden>
            <header class="panel-header profile-panel__header">
              <div>
                <p class="panel-header__eyebrow">Información</p>
                <h2 class="panel-header__title">Información del estudiante</h2>
              </div>
              <button type="button" class="btn btn--ghost btn--sm" data-profile-panel-close>Cerrar</button>
            </header>
            <section class="profile-stats" id="profile-stats" aria-label="Estadísticas del estudiante">
              ${renderSummary(student, bitacoras)}
            </section>
            <dl class="profile-grid" id="profile-grid">
              ${renderProfileGrid(student)}
            </dl>
            <section class="processes-manager" id="profile-processes-manager" aria-label="Areas y procesos del estudiante">
              ${renderProcessesManager(student)}
            </section>
            <section class="internal-notes" id="profile-internal-notes" aria-label="Observaciones internas">
              ${renderInternalNotesBlock(student)}
            </section>
          </article>

          <article class="card profile-panel" data-profile-panel="bitacoras" hidden>
            <header class="panel-header profile-panel__header">
              <div>
                <p class="panel-header__eyebrow">Bitácoras</p>
                <h2 class="panel-header__title">Todas las bitácoras</h2>
              </div>
              <div class="panel-header__actions">
                <button type="button" class="btn btn--ghost btn--sm" id="profile-refresh-history-btn">Recargar</button>
                <button type="button" class="btn btn--ghost btn--sm" data-profile-panel-close>Cerrar</button>
              </div>
            </header>
            ${renderProfileHistorySearchControl(currentProfileHistorySearchQuery)}
            <div id="profile-all-history-content">
              ${renderAllBitacorasPanel(student, bitacoras, config, isAuthenticated)}
            </div>
          </article>

          <article class="card profile-panel route-panel" data-profile-panel="route" hidden>
            <header class="panel-header route-panel__header profile-panel__header">
              <div class="panel-header__content">
                <p class="panel-header__eyebrow">Ruta completa</p>
                <h2 class="panel-header__title">Ruta de aprendizaje</h2>
              </div>
              <div class="panel-header__actions">
                <button type="button" class="btn btn--ghost btn--sm" data-route-action="refresh-route">Recargar ruta</button>
                <button type="button" class="btn btn--ghost btn--sm" data-profile-panel-close>Cerrar</button>
              </div>
            </header>
            <div id="profile-route-content">
              ${renderLearningRoute(student)}
            </div>
          </article>
        </section>
      </section>
    </section>
  `;
}

function bindProfileEvents(student) {
  if (!viewRoot) return;

  const backBtn = viewRoot.querySelector("#profile-back-btn");
  const openEditorBtn = viewRoot.querySelector("#profile-open-editor-btn");
  const importTextBtn = viewRoot.querySelector("#profile-import-text-bitacoras-btn");
  const refreshBtn = viewRoot.querySelector("#profile-refresh-history-btn");
  const historySearchInput = viewRoot.querySelector("#profile-history-search");
  const historyContainer = viewRoot.querySelector("#profile-history-content");
  const allHistoryContainer = viewRoot.querySelector("#profile-all-history-content");
  const routeContainer = viewRoot.querySelector("#profile-route-content");
  const routePreviewContainer = viewRoot.querySelector("#profile-route-preview-content");
  const repertoireContainer = viewRoot.querySelector("#profile-repertoire-content");
  const historyTitle = viewRoot.querySelector("#profile-history-title");
  const processSelect = viewRoot.querySelector("#profile-process-select");
  const gridContainer = viewRoot.querySelector("#profile-grid");
  const processesContainer = viewRoot.querySelector("#profile-processes-manager");
  const internalNotesContainer = viewRoot.querySelector("#profile-internal-notes");

  if (processesContainer) {
    processesContainer.addEventListener("click", async (event) => {
      const addButton = event.target.closest("[data-process-add]");
      if (addButton) {
        await addProfileProcess(student);
        return;
      }

      const removeButton = event.target.closest("[data-process-remove]");
      if (removeButton) {
        await removeProfileProcess(student, removeButton.getAttribute("data-process-remove"));
      }
    });
  }

  if (internalNotesContainer) {
    internalNotesContainer.addEventListener("click", async (event) => {
      if (event.target.closest("[data-internal-notes-save]")) {
        await saveInternalNotes(student);
      }
    });
    // Carga diferida de las observaciones internas privadas.
    loadInternalNotes(student);
  }

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      goToSearch();
    });
  }

  if (openEditorBtn) {
    openEditorBtn.addEventListener("click", () => {
      goToEditor(student, { processKey: currentProfileProcessKey || "" });
    });
  }

  if (importTextBtn) {
    importTextBtn.addEventListener("click", () => {
      openTextBitacorasImportModal(student);
    });
  }

  if (processSelect) {
    processSelect.addEventListener("change", async () => {
      currentProfileProcessKey = toStringSafe(processSelect.value);
      await Promise.all([reloadHistory(student), reloadLearningRoute(student)]);
      renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
    });
  }

  if (gridContainer) {
    gridContainer.addEventListener("click", async (event) => {
      const saveFieldButton = event.target.closest("[data-profile-save-field]");
      if (saveFieldButton) {
        await saveProfileField(student, saveFieldButton.getAttribute("data-profile-save-field"));
        return;
      }

      const saveButton = event.target.closest("[data-profile-save-teacher]");
      if (!saveButton) return;
      await saveProfileTeacher(student);
    });

    gridContainer.addEventListener("keydown", async (event) => {
      const input = event.target.closest("[data-profile-field-input]");
      if (!input || event.key !== "Enter") return;
      event.preventDefault();
      await saveProfileField(student, input.getAttribute("data-profile-field-input"));
    });

    gridContainer.addEventListener("change", async (event) => {
      const select = event.target.closest("[data-profile-teacher-select]");
      if (!select) return;
      await saveProfileTeacher(student);
    });
  }

  if (repertoireContainer) {
    repertoireContainer.addEventListener("click", async (event) => {
      const addButton = event.target.closest("[data-repertoire-add]");
      if (addButton) {
        await addProfileRepertoireItem(student);
        return;
      }

      const removeButton = event.target.closest("[data-repertoire-remove]");
      if (removeButton) {
        await removeProfileRepertoireItem(
          student,
          removeButton.getAttribute("data-repertoire-remove")
        );
        return;
      }

      const quickStatusButton = event.target.closest("[data-repertoire-quick-status]");
      if (quickStatusButton) {
        await updateProfileRepertoireItem(student, quickStatusButton.getAttribute("data-repertoire-quick-status"), {
          estado: quickStatusButton.getAttribute("data-repertoire-next-status"),
        });
        return;
      }

      const saveButton = event.target.closest("[data-repertoire-save]");
      if (saveButton) {
        await updateProfileRepertoireItem(
          student,
          saveButton.getAttribute("data-repertoire-save")
        );
      }
    });

    repertoireContainer.addEventListener("keydown", async (event) => {
      const input = event.target.closest("[data-repertoire-input]");
      if (!input) return;

      if (event.key === "Enter") {
        event.preventDefault();
        await addProfileRepertoireItem(student);
      }
    });

  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await reloadHistory(student);
    });
  }

  if (historySearchInput) {
    historySearchInput.addEventListener("input", () => {
      const nextQuery = toStringSafe(historySearchInput.value);
      if (profileHistorySearchTimer) {
        clearTimeout(profileHistorySearchTimer);
      }

      // No filtramos dentro del evento input: el navegador puede pintar la
      // letra inmediatamente y luego procesar el historial cuando el usuario
      // hace una pausa corta al escribir.
      profileHistorySearchTimer = setTimeout(() => {
        currentProfileHistorySearchQuery = nextQuery;
        currentProfileHistoryVisibleCount = PROFILE_HISTORY_RENDER_LIMIT;
        renderAllBitacorasOnly(student);
        profileHistorySearchTimer = null;
      }, PROFILE_HISTORY_SEARCH_DEBOUNCE_MS);
    });
  }

  [historyContainer, allHistoryContainer].filter(Boolean).forEach((container) => {
    container.addEventListener("click", async (event) => {
      const actionButton = event.target.closest("[data-history-action]");
      if (!actionButton) return;

      const action = actionButton.dataset.historyAction;

      if (action === "open-editor") {
        goToEditor(student);
        return;
      }

      if (action === "open-full-history") {
        toggleHistoryExpanded(student, actionButton, true);
        return;
      }

      if (action === "show-more-history") {
        currentProfileHistoryVisibleCount += PROFILE_HISTORY_RENDER_LIMIT;
        renderAllBitacorasOnly(student);
        return;
      }

      if (action === "open-group-editor") {
        goToEditor(student, { mode: CONFIG.modes.group });
        return;
      }

      if (action === "toggle-full-history") {
        toggleHistoryExpanded(student, actionButton);
        return;
      }

      if (action === "delete-bitacora") {
        const bitacoraId = toStringSafe(
          actionButton.getAttribute("data-bitacora-id")
        );
        await handleDeleteBitacoraFromProfile(student, bitacoraId);
        return;
      }

      if (action === "assign-process") {
        const bitacoraId = toStringSafe(
          actionButton.getAttribute("data-bitacora-id")
        );
        const card = actionButton.closest("[data-history-card]");
        const processSelect = card?.querySelector(
          "[data-history-process-select]"
        );
        const processKey = toStringSafe(processSelect?.value);

        if (!bitacoraId) return;
        await assignProcessToBitacora(student, bitacoraId, processKey);
      }
    });
  });

  viewRoot.addEventListener("click", async (event) => {
    const panelButton = event.target.closest("[data-profile-panel-target]");
    if (panelButton) {
      const target = panelButton.getAttribute("data-profile-panel-target");
      openProfilePanel(target);
      if (target === "route-editor") {
        routeEditorState.set(getStudentIdentity(student), true);
        rerenderRoutePanel(student);
      }
      return;
    }

    if (event.target.closest("[data-profile-panel-close]")) {
      closeProfilePanels();
      return;
    }

    if (event.target.closest("[data-profile-report]")) {
      openAiReportModal(student);
      return;
    }

    const actionButton = event.target.closest("[data-route-action]");
    if (!actionButton) return;

    const action = actionButton.getAttribute("data-route-action");
  if (action === "toggle-full") {
      toggleRouteExpanded(student, actionButton);
      return;
    }

    if (action === "toggle-route-history") {
      toggleRouteHistory(student);
      return;
    }

    if (action === "toggle-route-editor") {
      toggleRouteEditor(student);
      return;
    }

    if (action === "refresh-route") {
      await reloadLearningRoute(student);
    }

    if (action === "save-manual-route") {
      await saveManualLearningRoute(student);
    }
  });

  [routeContainer, routePreviewContainer].filter(Boolean).forEach((container) => {
    container.addEventListener("click", async (event) => {
      const undoButton = event.target.closest("[data-route-goal-undo]");
      if (!undoButton) return;

      const goalId = undoButton.getAttribute("data-route-goal-undo");
      if (!goalId) return;

      await undoLearningGoal(student, goalId);
    });
  });

  [routeContainer, routePreviewContainer].filter(Boolean).forEach((container) => {
    container.addEventListener("change", async (event) => {
      const checkbox = event.target.closest("[data-route-goal-check]");
      if (!checkbox) return;

      const goalId = checkbox.getAttribute("data-route-goal-check");
      if (!goalId || !checkbox.checked) return;

      await completeLearningGoal(student, goalId);
    });
  });
}

function bindMissingStateEvents() {
  if (!viewRoot) return;

  const backBtn = viewRoot.querySelector("#profile-missing-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      goToSearch();
    });
  }
}

function renderReactiveBlocks(state, config, preferredStudentRef = null) {
  const student = getStudentFromState(
    state,
    preferredStudentRef || currentProfileStudentKey
  );

  if (!student || !viewRoot) return;

  const summaryContainer = viewRoot.querySelector("#profile-summary-content");
  const historyContainer = viewRoot.querySelector("#profile-history-content");
  const allHistoryContainer = viewRoot.querySelector("#profile-all-history-content");
  const routeContainer = viewRoot.querySelector("#profile-route-content");
  const routePreviewContainer = viewRoot.querySelector("#profile-route-preview-content");
  const repertoireContainer = viewRoot.querySelector("#profile-repertoire-content");
  const historyTitle = viewRoot.querySelector("#profile-history-title");
  const titleNode = viewRoot.querySelector(".profile-card__name");
  const gridNode = viewRoot.querySelector("#profile-grid");
  const statsNode = viewRoot.querySelector("#profile-stats");
  const badgesNode = viewRoot.querySelector("#profile-badges");

  const bitacoras = getBitacorasFromState(student);

  if (titleNode) {
    titleNode.textContent = getStudentName(student);
  }

  if (badgesNode) {
    badgesNode.innerHTML = renderStudentBadges(student);
  }

  if (gridNode) {
    gridNode.innerHTML = renderProfileGrid(student);
  }

  if (viewRoot.querySelector("#profile-processes-manager")) {
    renderProcessesManagerContainer(student);
  }

  if (summaryContainer) {
    summaryContainer.innerHTML = renderSummary(student, bitacoras);
  }

  if (statsNode) {
    statsNode.innerHTML = renderSummary(student, bitacoras);
  }

  if (routePreviewContainer) {
    routePreviewContainer.innerHTML = renderCurrentRoutePreview(student);
  }

  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }

  if (repertoireContainer) {
    repertoireContainer.innerHTML = renderStudentRepertoireCard(
      student,
      resolveUserAccess(state?.auth?.user)
    );
  }

  if (historyTitle) {
    const activeProcess =
      resolveStudentProcess(student, currentProfileProcessKey) ||
      normalizeStudentProcesses(student)[0] ||
      null;
    const activeProcessLabel = toStringSafe(
      activeProcess?.label || activeProcess?.detalle || activeProcess?.arte || "Proceso"
    );
    historyTitle.textContent = `Última bitácora (${activeProcessLabel})`;
  }

  if (historyContainer) {
    historyContainer.innerHTML = renderLastBitacoraPreview(
      student,
      bitacoras,
      config,
      Boolean(state?.auth?.isAuthenticated)
    );
  }

  if (allHistoryContainer) {
    allHistoryContainer.innerHTML = renderAllBitacorasPanel(
      student,
      bitacoras,
      config,
      Boolean(state?.auth?.isAuthenticated)
    );
  }

  applyProfileFocusLayout(student);
}

function renderStudentBadges(student) {
  return `
    ${
      student.identityResolutionStatus === "pending"
        ? renderBadge("Revisión de identidad pendiente")
        : ""
    }
    ${renderBadge(student.modalidad)}
    ${renderBadge(student.area || student.instrumento || student.programa)}
  `;
}

/**
 * Tono del punto de estado: verde (activo), ambar (en pausa),
 * gris (inactivo) o neutro (desconocido).
 */
function resolveStudentStatusTone(estado = "") {
  const normalized = normalizeText(estado);
  if (!normalized) return "neutral";
  if (normalized.includes("pausa")) return "warning";
  if (normalized.includes("inactivo")) return "muted";
  if (normalized.includes("activo")) return "active";
  return "neutral";
}

function renderStudentStatusDot(student) {
  const estado = getReadableValue(student?.estado, "Sin estado");
  const tone = resolveStudentStatusTone(student?.estado);
  return `<span class="student-summary__status student-summary__status--${tone}" title="${escapeHtml(
    estado
  )}"><span class="student-summary__status-dot" aria-hidden="true"></span><span class="sr-only">${escapeHtml(
    estado
  )}</span></span>`;
}

function renderProfileGrid(student) {
  const shouldShowAddress = isHomeModality(student?.modalidad);

  return `
    ${renderProfileItem("Estado", getReadableValue(student.estado))}
    ${renderProfileItem("Edad", getReadableValue(student.edad || student.age))}
    ${renderProfileItem("Condición", getReadableValue(getStudentCondition(student), "Sin condición registrada"))}
    ${renderProfileItem("Procesos", getReadableValue(getStudentProcessesSummary(student), "Sin procesos registrados"))}
    ${renderProfileItem("Área / instrumento", getReadableValue(student.area || student.instrumento || student.programa))}
    ${renderModalidadProfileItem(student)}
    ${renderTeacherProfileItem(student)}
    ${renderProfileItem("Acudiente", getReadableValue(student.acudiente || student.responsable))}
    ${shouldShowAddress ? renderProfileItem("Dirección", getReadableValue(student.direccion || student.address)) : ""}
    ${renderInteresesProfileItem(student)}
  `;
}

const KNOWN_MODALITIES = ["Presencial", "Virtual", "Hogar", "Domicilio", "Híbrida"];

function canEditProfileFields() {
  const access = resolveUserAccess(getState()?.auth?.user);
  return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
}

function renderModalidadProfileItem(student = {}) {
  const current = getReadableValue(student.modalidad, "");
  if (!canEditProfileFields()) {
    return renderProfileItem("Modalidad", getReadableValue(student.modalidad, "Sin modalidad"));
  }

  const datalistId = "profile-modalidad-options";
  return `
    <div class="profile-grid__item profile-grid__item--editable">
      <dt class="profile-grid__label">Modalidad</dt>
      <dd class="profile-grid__value">
        <div class="profile-inline-edit">
          <input
            type="text"
            class="profile-inline-edit__input"
            data-profile-field-input="modalidad"
            list="${datalistId}"
            value="${escapeHtml(toStringSafe(student.modalidad))}"
            placeholder="Sin modalidad"
          />
          <datalist id="${datalistId}">
            ${KNOWN_MODALITIES.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}
          </datalist>
          <button type="button" class="btn btn--ghost btn--sm" data-profile-save-field="modalidad">Guardar</button>
        </div>
        <div class="profile-inline-message" data-profile-field-message="modalidad" role="status" aria-live="polite"></div>
      </dd>
    </div>
  `;
}

function renderInteresesProfileItem(student = {}) {
  if (!canEditProfileFields()) {
    return renderProfileItem(
      "Intereses",
      getReadableValue(student.interesesMusicales || student.intereses, "Sin intereses registrados")
    );
  }

  return `
    <div class="profile-grid__item profile-grid__item--editable">
      <dt class="profile-grid__label">Intereses musicales</dt>
      <dd class="profile-grid__value">
        <div class="profile-inline-edit">
          <input
            type="text"
            class="profile-inline-edit__input"
            data-profile-field-input="interesesMusicales"
            value="${escapeHtml(toStringSafe(student.interesesMusicales || student.intereses))}"
            placeholder="Géneros, artistas, metas musicales..."
          />
          <button type="button" class="btn btn--ghost btn--sm" data-profile-save-field="interesesMusicales">Guardar</button>
        </div>
        <div class="profile-inline-message" data-profile-field-message="interesesMusicales" role="status" aria-live="polite"></div>
      </dd>
    </div>
  `;
}

function renderInternalNotesBlock(student = {}) {
  if (!canEditProfileFields()) return "";

  const studentId = getStudentIdentity(student);
  const isCurrent = internalNotesState.loaded && internalNotesState.studentId === studentId;
  const text = isCurrent ? internalNotesState.text : "";
  const legacy = toStringSafe(student.observaciones || student.notes);
  const showLegacy = Boolean(legacy) && normalizeText(legacy) !== normalizeText(text);

  return `
    <header class="internal-notes__header">
      <div>
        <p class="panel-header__eyebrow">Privado</p>
        <h3 class="internal-notes__title">Observaciones internas</h3>
      </div>
      <span class="internal-notes__badge">Solo visible para docentes y administración</span>
    </header>
    ${
      internalNotesState.loading && !isCurrent
        ? `<p class="internal-notes__loading">Cargando observaciones...</p>`
        : `
          <textarea
            class="field__textarea internal-notes__textarea"
            data-internal-notes-input
            rows="5"
            placeholder="Notas internas del equipo (no visibles para estudiantes ni acudientes)..."
          >${escapeHtml(text)}</textarea>
          <div class="internal-notes__actions">
            <button type="button" class="btn btn--secondary btn--sm" data-internal-notes-save>Guardar observaciones</button>
            <span class="profile-inline-message" data-internal-notes-message role="status" aria-live="polite"></span>
          </div>
        `
    }
    ${
      showLegacy
        ? `<div class="internal-notes__legacy">
            <p class="internal-notes__legacy-label">Observación anterior (solo lectura)</p>
            <p class="internal-notes__legacy-text">${escapeHtml(legacy)}</p>
          </div>`
        : ""
    }
  `;
}

function renderInternalNotesContainer(student) {
  const container = viewRoot?.querySelector("#profile-internal-notes");
  if (!container) return;
  container.innerHTML = renderInternalNotesBlock(student);
}

async function loadInternalNotes(student) {
  if (!canEditProfileFields()) return;
  const studentId = getStudentIdentity(student);
  if (!studentId) return;
  if (internalNotesState.loaded && internalNotesState.studentId === studentId) return;
  if (internalNotesState.loading && internalNotesState.studentId === studentId) return;

  internalNotesState = { studentId, text: "", loaded: false, loading: true };
  renderInternalNotesContainer(student);

  try {
    const notes = await getStudentPrivateNotes(studentId);
    internalNotesState = {
      studentId,
      text: toStringSafe(notes.observacionesInternas),
      loaded: true,
      loading: false,
    };
  } catch (error) {
    console.error("No se pudieron cargar las observaciones internas:", error);
    internalNotesState = { studentId, text: "", loaded: true, loading: false };
  }

  renderInternalNotesContainer(student);
}

async function saveInternalNotes(student) {
  if (!canEditProfileFields()) {
    setAppError("No tienes permisos para editar observaciones internas.");
    return;
  }

  const studentId = getStudentIdentity(student);
  const input = viewRoot?.querySelector("[data-internal-notes-input]");
  const button = viewRoot?.querySelector("[data-internal-notes-save]");
  const message = viewRoot?.querySelector("[data-internal-notes-message]");
  if (!studentId) {
    setAppError("No hay estudiante seleccionado.");
    return;
  }

  const text = toStringSafe(input?.value);

  try {
    clearAppError();
    if (button) button.disabled = true;
    clearProfileTeacherMessage(message);

    const updatedBy = toStringSafe(getState()?.auth?.user?.email) || "profile_internal_notes";
    await saveStudentPrivateNotes(studentId, text, { updatedBy });
    internalNotesState = { studentId, text, loaded: true, loading: false };

    showProfileTeacherMessage(
      viewRoot?.querySelector("[data-internal-notes-message]") || message,
      "Observaciones internas guardadas.",
      "success"
    );
  } catch (error) {
    console.error("No se pudieron guardar las observaciones internas:", error);
    showProfileTeacherMessage(message, error?.message || "No se pudo guardar.", "error");
    setAppError(error?.message || "No se pudieron guardar las observaciones internas.");
  } finally {
    if (button) button.disabled = false;
  }
}

function isHomeModality(value = "") {
  const modality = normalizeText(value);
  return modality.includes("hogar") || modality.includes("domicilio");
}

function canManageProcesses() {
  // Las reglas de Firestore solo permiten escribir `students` a administradores,
  // por eso el gestor de areas se limita a admin (un docente recibiria
  // permission-denied al guardar).
  return resolveUserAccess(getState()?.auth?.user).role === CONFIG.roles.admin;
}

function renderProcessesManager(student = {}) {
  if (!canManageProcesses()) return "";

  const processes = normalizeStudentProcesses(student);
  const teacherOptions = getTeacherCatalogOptions("");

  const teacherSelectOptions = (selected = "") => `
    <option value="">Sin docente</option>
    ${teacherOptions
      .map(
        (name) =>
          `<option value="${escapeHtml(name)}" ${
            normalizeText(name) === normalizeText(selected) ? "selected" : ""
          }>${escapeHtml(name)}</option>`
      )
      .join("")}
  `;

  const items = processes
    .map(
      (process) => `
        <li class="processes-manager__item" data-process-item="${escapeHtml(process.processKey)}">
          <div class="processes-manager__item-info">
            <span class="processes-manager__item-label">${escapeHtml(process.label || "Proceso")}</span>
            <span class="processes-manager__item-meta">${escapeHtml(
              getReadableValue(process.docente, "Sin docente")
            )}</span>
          </div>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-process-remove="${escapeHtml(process.processKey)}"
          >Quitar</button>
        </li>
      `
    )
    .join("");

  return `
    <header class="processes-manager__header">
      <div>
        <p class="panel-header__eyebrow">Configuracion</p>
        <h3 class="processes-manager__title">Areas y procesos</h3>
      </div>
    </header>
    <ul class="processes-manager__list">
      ${items || `<li class="processes-manager__empty">Sin procesos registrados.</li>`}
    </ul>
    <div class="processes-manager__form">
      <label class="field field--compact">
        <span class="field__label">Area</span>
        <input type="text" class="field__input" data-process-new="arte" placeholder="Ej: Musica" />
      </label>
      <label class="field field--compact">
        <span class="field__label">Instrumento / detalle</span>
        <input type="text" class="field__input" data-process-new="detalle" placeholder="Ej: Piano" />
      </label>
      <label class="field field--compact">
        <span class="field__label">Docente</span>
        <select class="field__input" data-process-new="docente">
          ${teacherSelectOptions("")}
        </select>
      </label>
      <button type="button" class="btn btn--secondary btn--sm" data-process-add>Agregar area</button>
    </div>
    <div class="profile-inline-message" data-process-message role="status" aria-live="polite"></div>
  `;
}

function renderProcessesManagerContainer(student) {
  const container = viewRoot?.querySelector("#profile-processes-manager");
  if (!container) return;
  container.innerHTML = renderProcessesManager(student);
}

function mergePedagogicalUpdate(student, updated = {}) {
  const canonicalStudentId = getStudentIdentity(student);
  return {
    ...student,
    ...updated,
    id: canonicalStudentId,
    studentId: canonicalStudentId,
    studentKey: canonicalStudentId,
    canonicalStudentId,
    academicRecordId: getStudentAcademicRecordId(student),
    linkedStudentIds: getStudentLinkedIds(student),
  };
}

async function persistStudentProcesses(student, nextProcesses, successMessage) {
  const studentId = getStudentAcademicRecordId(student);
  const message = viewRoot?.querySelector("[data-process-message]");
  if (!studentId) {
    setAppError("No hay estudiante seleccionado.");
    return;
  }

  try {
    clearAppError();
    const updatedBy = toStringSafe(getState()?.auth?.user?.email) || "profile_processes";
    const updated = await updateStudentProcesses(studentId, nextProcesses, { updatedBy });
    const refreshedProfile = await getStudentProfile(
      getStudentIdentity(student),
      { refresh: true }
    ).catch(() => null);
    const nextStudent = mergePedagogicalUpdate(student, {
      ...updated,
      ...(refreshedProfile || {}),
    });
    updateStudentProfile(nextStudent);
    setSelectedStudent(nextStudent);
    renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
    showProfileTeacherMessage(
      viewRoot?.querySelector("[data-process-message]") || message,
      successMessage,
      "success"
    );
  } catch (error) {
    console.error("No se pudieron guardar las areas:", error);
    showProfileTeacherMessage(message, error?.message || "No se pudo guardar.", "error");
    setAppError(error?.message || "No se pudieron guardar las areas.");
  }
}

async function addProfileProcess(student) {
  if (!canManageProcesses()) {
    setAppError("Solo un administrador puede editar las areas.");
    return;
  }

  // Usa siempre el estudiante mas reciente del estado. El `student` capturado en
  // el listener queda obsoleto tras cada guardado, y usarlo hacia que un nuevo
  // proceso se agregara sobre la lista original, borrando el ultimo agregado.
  const currentStudent =
    getStudentFromState(getState(), currentProfileStudentKey) || student;

  const container = viewRoot?.querySelector("#profile-processes-manager");
  const arteInput = container?.querySelector('[data-process-new="arte"]');
  const detalleInput = container?.querySelector('[data-process-new="detalle"]');
  const docenteInput = container?.querySelector('[data-process-new="docente"]');

  const arte = toStringSafe(arteInput?.value);
  const detalle = toStringSafe(detalleInput?.value);
  const docente = toStringSafe(docenteInput?.value);

  if (!arte && !detalle) {
    showProfileTeacherMessage(
      viewRoot?.querySelector("[data-process-message]"),
      "Indica al menos un area o instrumento.",
      "error"
    );
    return;
  }

  const existing = getPersistedStudentProcesses(currentStudent);
  const nextProcesses = [...existing, { arte, detalle, docente }];

  await persistStudentProcesses(currentStudent, nextProcesses, "Area agregada.");
}

async function removeProfileProcess(student, processKey) {
  if (!canManageProcesses()) {
    setAppError("Solo un administrador puede editar las areas.");
    return;
  }

  const currentStudent =
    getStudentFromState(getState(), currentProfileStudentKey) || student;

  const safeKey = toStringSafe(processKey);
  const nextProcesses = getPersistedStudentProcesses(currentStudent)
    .filter((process) => toStringSafe(process.processKey) !== safeKey);

  await persistStudentProcesses(currentStudent, nextProcesses, "Area eliminada.");
}

function getPersistedStudentProcesses(student = {}) {
  const persisted = (Array.isArray(student?.processes) ? student.processes : [])
    .map((process, index) => {
      if (!process || typeof process !== "object") return null;
      const arte = toStringSafe(process.arte || process.area);
      const detalle = toStringSafe(process.detalle || process.instrumento);
      const docente = firstNonEmpty(
        process.docente,
        process.teacher,
        process.profesor,
        process.docenteNombre
      );
      const label =
        toStringSafe(process.label) ||
        [arte, detalle].filter(Boolean).join(" - ") ||
        `Proceso ${index + 1}`;
      const processKey =
        toStringSafe(process.processKey) ||
        `${slugifyProcessKey(arte || label)}_${slugifyProcessKey(detalle || label)}_${index + 1}`;

      if (!arte && !detalle) return null;
      return { processKey, arte, detalle, docente, label };
    })
    .filter(Boolean);

  if (persisted.length) return persisted;

  return normalizeStudentProcesses(student)
    .filter((process) => process.arte || process.detalle)
    .map((process) => ({
      processKey: toStringSafe(process.processKey),
      arte: toStringSafe(process.arte),
      detalle: toStringSafe(process.detalle),
      docente: firstNonEmpty(process.docente),
      label:
        toStringSafe(process.label) ||
        [process.arte, process.detalle].filter(Boolean).join(" - "),
    }));
}

function renderTeacherProfileItem(student = {}) {
  const currentTeacher = getReadableValue(student.docente || student.teacher, "");
  const teacherOptions = getTeacherCatalogOptions(currentTeacher);
  const access = resolveUserAccess(getState()?.auth?.user);
  const canEditTeacher = access.role === CONFIG.roles.admin;

  if (!canEditTeacher) {
    return renderProfileItem(
      "Docente",
      getReadableValue(currentTeacher, "Sin docente asignado")
    );
  }

  return `
    <div class="profile-grid__item profile-grid__item--editable">
      <dt class="profile-grid__label">Docente</dt>
      <dd class="profile-grid__value">
        <div class="profile-inline-edit">
          <select
            class="profile-inline-edit__input"
            data-profile-teacher-select
          >
            <option value="">Sin docente asignado</option>
            ${teacherOptions
              .map(
                (teacherName) => `
                  <option value="${escapeHtml(teacherName)}" ${
                    normalizeText(teacherName) === normalizeText(currentTeacher)
                      ? "selected"
                      : ""
                  }>
                    ${escapeHtml(teacherName)}
                  </option>
                `
              )
              .join("")}
          </select>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-profile-save-teacher
          >
            Guardar
          </button>
        </div>
        <div
          class="profile-inline-message"
          data-profile-teacher-message
          role="status"
          aria-live="polite"
        ></div>
      </dd>
    </div>
  `;
}

function getTeacherCatalogOptions(currentTeacher = "") {
  const teachers = Array.isArray(cachedCatalogs?.docentes)
    ? cachedCatalogs.docentes
    : [];
  const values = [
    currentTeacher,
    ...teachers.map((teacher) =>
      firstNonEmpty(teacher?.nombre, teacher?.alias, teacher?.name)
    ),
  ];
  const seen = new Set();

  return values
    .map((value) => toStringSafe(value))
    .filter(Boolean)
    .filter((value) => {
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function saveProfileTeacher(student) {
  const access = resolveUserAccess(getState()?.auth?.user);
  if (access.role !== CONFIG.roles.admin) {
    setAppError("Solo un administrador puede modificar el docente asignado.");
    return;
  }

  const input = viewRoot?.querySelector("[data-profile-teacher-select]");
  const button = viewRoot?.querySelector("[data-profile-save-teacher]");
  const message = viewRoot?.querySelector("[data-profile-teacher-message]");
  const studentId = getStudentAcademicRecordId(student);
  const docente = toStringSafe(input?.value);

  if (!studentId) {
    setAppError("No hay estudiante seleccionado para asignar docente.");
    return;
  }

  try {
    clearAppError();
    if (button) button.disabled = true;
    clearProfileTeacherMessage(message);

    const updated = await updateStudentTeacher(studentId, docente);
    updateStudentProfile(mergePedagogicalUpdate(student, {
      ...updated,
      docente,
      teacher: docente,
    }));
    showProfileTeacherMessage(
      viewRoot?.querySelector("[data-profile-teacher-message]") || message,
      "Docente guardado correctamente.",
      "success"
    );
  } catch (error) {
    console.error("No se pudo asignar docente:", error);
    showProfileTeacherMessage(
      message,
      error?.message || "No se pudo guardar el docente.",
      "error"
    );
    setAppError(error?.message || "No se pudo guardar el docente.");
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveProfileField(student, field) {
  if (!canEditProfileFields()) {
    setAppError("No tienes permisos para editar este campo.");
    return;
  }

  const safeField = toStringSafe(field);
  const input = viewRoot?.querySelector(`[data-profile-field-input="${safeField}"]`);
  const button = viewRoot?.querySelector(`[data-profile-save-field="${safeField}"]`);
  const message = viewRoot?.querySelector(`[data-profile-field-message="${safeField}"]`);
  const studentId = getStudentAcademicRecordId(student);
  const value = toStringSafe(input?.value);

  if (!studentId) {
    setAppError("No hay estudiante seleccionado.");
    return;
  }

  try {
    clearAppError();
    if (button) button.disabled = true;
    clearProfileTeacherMessage(message);

    const updatedBy = toStringSafe(getState()?.auth?.user?.email) || "profile_fields";
    const updated = await updateStudentProfileFields(
      studentId,
      { [safeField]: value },
      { updatedBy }
    );

    // Confirmar con una lectura nueva evita mostrar un éxito local si una
    // sincronización de identidad acabara de reemplazar el dato en Firestore.
    const refreshedProfile = await getStudentProfile(getStudentIdentity(student), {
      refresh: true,
    });
    const persistedValue = toStringSafe(
      safeField === "interesesMusicales"
        ? refreshedProfile?.interesesMusicales || refreshedProfile?.intereses
        : refreshedProfile?.modalidad || refreshedProfile?.modality
    );
    if (persistedValue !== value) {
      throw new Error("Firebase no confirmó el valor guardado. Inténtalo de nuevo.");
    }

    const nextStudent = mergePedagogicalUpdate(student, {
      ...updated,
      ...(refreshedProfile || {}),
    });
    updateStudentProfile(nextStudent);
    setSelectedStudent(nextStudent);
    showProfileTeacherMessage(
      viewRoot?.querySelector(`[data-profile-field-message="${safeField}"]`) || message,
      "Cambios guardados.",
      "success"
    );
  } catch (error) {
    console.error("No se pudo guardar el campo del perfil:", error);
    showProfileTeacherMessage(message, error?.message || "No se pudo guardar.", "error");
    setAppError(error?.message || "No se pudo guardar el campo.");
  } finally {
    if (button) button.disabled = false;
  }
}

function showProfileTeacherMessage(target, text = "", type = "success") {
  if (!target) return;

  target.textContent = text;
  target.dataset.type = type;
  target.classList.add("is-visible");
}

function clearProfileTeacherMessage(target) {
  if (!target) return;

  target.textContent = "";
  target.removeAttribute("data-type");
  target.classList.remove("is-visible");
}

function renderLastBitacoraPreview(student, bitacoras = [], config, isAuthenticated = true) {
  if (!isAuthenticated) {
    return renderHistoryPreview(student, [], config, false);
  }

  const latest = sortBitacorasByDate(bitacoras)[0] || null;
  if (!latest) {
    return renderHistoryPreview(student, [], config, true);
  }

  const processOptions = normalizeStudentProcesses(student);

  return `
    <div class="profile-latest-card">
      <div class="teaching-history-list">
        ${renderTeachingHistoryCard(latest, student, processOptions)}
      </div>
      <div class="profile-panel-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-profile-panel-target="bitacoras">
          Ver todas las bitácoras
        </button>
        <button type="button" class="btn btn--primary btn--sm" data-history-action="open-editor">
          Nueva bitácora
        </button>
      </div>
    </div>
  `;
}

function renderCurrentRoutePreview(student) {
  const access = resolveUserAccess(getState()?.auth?.user);
  const studentId = getStudentIdentity(student);
  const route = buildDefaultRouteState(student, getStudentRoute(studentId));
  const preset = resolveRoutePreset(student, route);
  const components = getRouteComponentsForPreset(preset);

  return `
    <div class="profile-route-summary">
      ${renderCurrentRouteGoals(route, preset, components, {
        canUpdateRouteProgress: access.canUpdateRouteProgress,
      })}
      <div class="profile-panel-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-profile-panel-target="route">
          Ver ruta completa
        </button>
        ${
          access.canEditRouteStructure
            ? `<button type="button" class="btn btn--primary btn--sm" data-profile-panel-target="route-editor">
                Editar ruta
              </button>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderQuickActions(access = {}) {
  return `
    <div class="profile-actions-grid">
      <button type="button" class="btn btn--ghost" data-profile-panel-target="student-info">
        Ver información del estudiante
      </button>
      ${
        access.role === CONFIG.roles.admin
          ? `<button type="button" class="btn btn--ghost" data-profile-report>
              Descargar informe para IA
            </button>`
          : ""
      }
      <button type="button" class="btn btn--ghost" data-profile-panel-target="bitacoras">
        Ver todas las bitácoras
      </button>
      <button type="button" class="btn btn--ghost" data-profile-panel-target="route">
        Ver ruta completa
      </button>
      ${
        access.canEditRouteStructure
          ? `<button type="button" class="btn btn--primary" data-profile-panel-target="route-editor">
              Editar ruta
            </button>`
          : ""
      }
    </div>
  `;
}

// --- Informe para IA -------------------------------------------------------
// Compila toda la información visible del estudiante (perfil, repertorio,
// ruta y bitácoras) en un .md pensado para pegarse en cualquier IA.
// Excluye deliberadamente datos privados: observaciones internas, notas
// legadas, acudiente, dirección y documento.

function buildAiReportSection(title, lines = []) {
  const safeLines = lines.filter(Boolean);
  if (!safeLines.length) return "";
  return `## ${title}\n\n${safeLines.join("\n")}\n`;
}

function formatAiReportList(label, items = []) {
  const safeItems = normalizeTags(items);
  if (!safeItems.length) return "";
  return `- **${label}:** ${safeItems.join("; ")}`;
}

function buildAiReportBitacoraBlock(item, student) {
  const structured = parseStructuredContent(item.contenido || item.content || "");
  const override = getCurrentStudentOverride(item, student);
  const mode = normalizeMode(item.mode) === CONFIG.modes.group ? "Grupal" : "Individual";
  const teacher = firstNonEmpty(structured.docente, getHistoryTeacherName(item));
  const date = formatDisplayDate(item.fechaClase || item.createdAt) || "Sin fecha";
  const title = toStringSafe(item.titulo || item.title);
  const tags = normalizeTags(item.etiquetas || item.tags || []);

  const lines = [
    `### ${date}${title ? ` — ${title}` : ""}`,
    `- **Tipo de clase:** ${mode}`,
    teacher ? `- **Docente:** ${teacher}` : "",
    formatAiReportList("Etiquetas", tags),
  ];

  const tareas = toStringSafe(structured.tareas);
  if (tareas) lines.push(`- **Tareas / observaciones:** ${tareas}`);
  lines.push(
    formatAiReportList("Componente corporal", structured.componenteCorporal),
    formatAiReportList("Componente técnico", structured.componenteTecnico),
    formatAiReportList("Componente teórico", structured.componenteTeorico),
    formatAiReportList("Componente de obras", structured.componenteObras)
  );

  if (!tareas && !hasStructuredHistoryContent(structured)) {
    const rawContent = toStringSafe(item.contenido || item.content);
    if (rawContent) lines.push(`- **Contenido:** ${rawContent}`);
  }

  if (override && hasStudentOverrideContent(override)) {
    lines.push("- **Ajustes específicos para este estudiante:**");
    const overrideTareas = toStringSafe(override.tareas);
    if (overrideTareas) lines.push(`  - Tareas / observaciones: ${overrideTareas}`);
    [
      ["Componente corporal", override.componenteCorporal],
      ["Componente técnico", override.componenteTecnico],
      ["Componente teórico", override.componenteTeorico],
      ["Componente de obras", override.componenteObras],
      ["Etiquetas", override.etiquetas],
    ].forEach(([label, items]) => {
      const safeItems = normalizeTags(items);
      if (safeItems.length) lines.push(`  - ${label}: ${safeItems.join("; ")}`);
    });
  }

  return lines.filter(Boolean).join("\n");
}

// Instrucciones de tono/lenguaje para la IA según el público del informe.
const AI_REPORT_TONES = Object.freeze({
  tecnico: {
    label: "Lenguaje técnico",
    instruction:
      "Redacta el informe con lenguaje técnico y preciso, propio del arte trabajado. El lector es un estudiante adulto o un acudiente que conoce los conceptos del instrumento o disciplina, así que usa la terminología especializada (nombres de técnicas, ejercicios, teoría musical, repertorio) sin necesidad de explicarla. Sé riguroso y específico sobre lo trabajado y el nivel alcanzado.",
  },
  sencillo: {
    label: "Lenguaje sencillo",
    instruction:
      "Redacta el informe con lenguaje sencillo, claro y cercano, pensado para un acudiente que no tiene conocimientos musicales o artísticos (por ejemplo, la familia de un niño pequeño). Cuando aparezca un término técnico, explícalo con palabras cotidianas y da contexto de por qué es importante y por qué puede ser difícil. Describe en qué consisten los procesos y da recomendaciones concretas de cómo acompañar al estudiante en casa. Evita las metáforas rebuscadas y el lenguaje florido: sé concreto y explicativo, como si le explicaras a alguien que empieza desde cero.",
  },
});

function buildStudentAiReport(student, range = {}, tone = "tecnico") {
  const studentId = getStudentIdentity(student);
  const bitacoras = getBitacorasFromState(student);
  // Rango opcional (inclusivo). Vacío = todo el tiempo.
  const fromTs = range?.from ? getTimestamp(range.from) : null;
  const toTs = range?.to ? getTimestamp(range.to) + 24 * 60 * 60 * 1000 - 1 : null;
  const rangeLabel = toStringSafe(range?.label);
  const filteredBitacoras = bitacoras.filter((item) => {
    if (fromTs === null && toTs === null) return true;
    const ts = getTimestamp(item.fechaClase || item.createdAt);
    if (!ts) return false;
    if (fromTs !== null && ts < fromTs) return false;
    if (toTs !== null && ts > toTs) return false;
    return true;
  });
  const sortedBitacoras = [...filteredBitacoras].sort(
    (a, b) =>
      getTimestamp(a.fechaClase || a.createdAt) -
      getTimestamp(b.fechaClase || b.createdAt)
  );
  const repertoire = getStudentRepertoireItems(student);
  const route = buildDefaultRouteState(student, getStudentRoute(studentId));
  const preset = resolveRoutePreset(student, route);
  const completedIds = new Set(
    Array.isArray(route?.completedGoalIds) ? route.completedGoalIds : []
  );
  const completedGoals = (preset?.goals || []).filter((goal) =>
    completedIds.has(goal.id)
  );
  const pendingGoals = (preset?.goals || []).filter(
    (goal) => !completedIds.has(goal.id)
  );
  const totalGoals = preset?.goals?.length || 0;
  const firstBitacora = getFirstBitacora(sortedBitacoras);
  const generatedAt = formatDisplayDate(getTodayDate()) || getTodayDate();

  const periodDescription = rangeLabel
    ? ` correspondiente a: ${rangeLabel}`
    : " de todo su proceso";
  const toneConfig = AI_REPORT_TONES[tone] || AI_REPORT_TONES.tecnico;

  const parts = [
    `# Informe de proceso musical — ${getStudentName(student)}`,
    "",
    `> **Instrucción para la IA:** Con la información de este documento, redacta un informe pedagógico claro y bien escrito sobre el proceso musical del estudiante${periodDescription}. Resume qué se ha trabajado clase a clase (sin listar cada clase una por una), destaca los avances y logros, el repertorio trabajado, y sugiere posibles siguientes pasos. ${toneConfig.instruction}`,
    "",
    buildAiReportSection("Datos generales", [
      `- **Nombre:** ${getStudentName(student)}`,
      rangeLabel ? `- **Período del informe:** ${rangeLabel}` : "- **Período del informe:** Todo el proceso",
      student.edad || student.age ? `- **Edad:** ${getReadableValue(student.edad || student.age)}` : "",
      `- **Área / instrumento:** ${getReadableValue(student.area || student.instrumento || student.programa, "Sin registrar")}`,
      `- **Modalidad:** ${getReadableValue(student.modalidad, "Sin registrar")}`,
      `- **Estado:** ${getReadableValue(student.estado, "Sin registrar")}`,
      `- **Docente asignado:** ${getReadableValue(student.docente || student.teacher, "Sin registrar")}`,
      `- **Procesos:** ${getReadableValue(getStudentProcessesSummary(student), "Sin registrar")}`,
      toStringSafe(student.interesesMusicales || student.intereses)
        ? `- **Intereses musicales:** ${toStringSafe(student.interesesMusicales || student.intereses)}`
        : "",
      firstBitacora
        ? `- **Primera clase registrada:** ${formatDisplayDate(firstBitacora.fechaClase || firstBitacora.createdAt)}`
        : "",
      `- **Total de bitácoras:** ${sortedBitacoras.length}`,
      `- **Informe generado el:** ${generatedAt}`,
    ]),
    buildAiReportSection("Repertorio del proceso", [
      repertoire.length
        ? formatRepertoireForAiReport(repertoire)
        : "- Aún no hay repertorio registrado.",
    ]),
    buildAiReportSection("Ruta de aprendizaje", [
      preset?.routeName ? `- **Ruta:** ${preset.routeName}` : "",
      totalGoals
        ? `- **Avance:** ${completedGoals.length}/${totalGoals} objetivos (${Math.round((completedGoals.length / totalGoals) * 100)}%)`
        : "",
      completedGoals.length
        ? `\n### Objetivos completados\n${completedGoals.map((goal) => `- ${goal.title}`).join("\n")}`
        : "",
      pendingGoals.length && pendingGoals.length <= 40
        ? `\n### Objetivos pendientes\n${pendingGoals.map((goal) => `- ${goal.title}`).join("\n")}`
        : "",
    ]),
    buildAiReportSection(
      `Bitácoras de clase (${sortedBitacoras.length})`,
      sortedBitacoras.length
        ? sortedBitacoras.map((item) => buildAiReportBitacoraBlock(item, student) + "\n")
        : [
            rangeLabel
              ? "No hay bitácoras registradas en el período seleccionado."
              : "No hay bitácoras registradas.",
          ]
    ),
  ];

  return parts.filter(Boolean).join("\n");
}

function slugifyForFilename(value = "", fallback = "estudiante") {
  return (
    toStringSafe(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function downloadStudentAiReport(student, range = {}, tone = "tecnico") {
  try {
    const content = buildStudentAiReport(student, range, tone);
    const safeName = slugifyForFilename(getStudentName(student), "estudiante");
    const periodSuffix = range?.slug ? `-${slugifyForFilename(range.slug, "periodo")}` : "";
    const toneSuffix = tone === "sencillo" ? "-sencillo" : "-tecnico";
    const safeSuffix = `${periodSuffix}${toneSuffix}`;
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `informe-${safeName}${safeSuffix}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("No se pudo generar el informe del estudiante:", error);
    setAppError("No se pudo generar el informe del estudiante.");
  }
}

// Devuelve una fecha YYYY-MM-DD desplazada n meses hacia atrás desde hoy.
function getDateMonthsAgo(months = 0) {
  const now = new Date();
  now.setMonth(now.getMonth() - months);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveAiReportRange(preset, customFrom = "", customTo = "") {
  const today = getTodayDate();
  if (preset === "last-month") {
    return {
      from: getDateMonthsAgo(1),
      to: today,
      label: "el último mes",
      slug: "ultimo-mes",
    };
  }
  if (preset === "last-3-months") {
    return {
      from: getDateMonthsAgo(3),
      to: today,
      label: "los últimos 3 meses",
      slug: "ultimos-3-meses",
    };
  }
  if (preset === "last-6-months") {
    return {
      from: getDateMonthsAgo(6),
      to: today,
      label: "los últimos 6 meses",
      slug: "ultimos-6-meses",
    };
  }
  if (preset === "custom") {
    const from = normalizeLocalDateInput(customFrom);
    const to = normalizeLocalDateInput(customTo);
    if (!from && !to) return null;
    const parts = [];
    if (from) parts.push(`desde ${formatDisplayDate(from)}`);
    if (to) parts.push(`hasta ${formatDisplayDate(to)}`);
    return {
      from,
      to,
      label: `el período ${parts.join(" ")}`.trim(),
      slug: [from, to].filter(Boolean).join("_a_") || "personalizado",
    };
  }
  return {}; // Todo el tiempo
}

function openAiReportModal(student) {
  if (!isAdminUser(getState()?.auth?.user)) {
    setAppError("Solo un administrador puede generar el informe para IA.");
    return;
  }

  const existing = document.querySelector("[data-ai-report-modal]");
  if (existing) existing.remove();

  const modalRoot = document.createElement("div");
  modalRoot.className = "text-bitacoras-modal-root";
  modalRoot.setAttribute("data-ai-report-modal", "true");
  modalRoot.innerHTML = renderAiReportModal();
  document.body.appendChild(modalRoot);

  const close = () => modalRoot.remove();
  const customFields = modalRoot.querySelector("[data-ai-report-custom]");
  const fromInput = modalRoot.querySelector("#ai-report-from");
  const toInput = modalRoot.querySelector("#ai-report-to");
  const status = modalRoot.querySelector("[data-ai-report-status]");

  const getSelectedPreset = () =>
    toStringSafe(
      modalRoot.querySelector('input[name="ai-report-period"]:checked')?.value
    ) || "all";

  const getSelectedTone = () =>
    toStringSafe(
      modalRoot.querySelector('input[name="ai-report-tone"]:checked')?.value
    ) || "tecnico";

  const syncCustomVisibility = () => {
    if (customFields) customFields.hidden = getSelectedPreset() !== "custom";
  };

  modalRoot.querySelectorAll('input[name="ai-report-period"]').forEach((input) => {
    input.addEventListener("change", syncCustomVisibility);
  });
  syncCustomVisibility();

  modalRoot.querySelectorAll("[data-ai-report-cancel]").forEach((button) => {
    button.addEventListener("click", close);
  });
  modalRoot.addEventListener("click", (event) => {
    if (event.target === modalRoot.querySelector(".text-bitacoras-modal-backdrop")) {
      close();
    }
  });

  modalRoot.querySelector("[data-ai-report-download]")?.addEventListener("click", () => {
    const preset = getSelectedPreset();
    const range = resolveAiReportRange(preset, fromInput?.value, toInput?.value);
    if (range === null) {
      if (status) {
        status.textContent = "Elige al menos una fecha para el período personalizado.";
        status.dataset.type = "warning";
      }
      return;
    }
    downloadStudentAiReport(student, range, getSelectedTone());
    close();
  });
}

function renderAiReportModal() {
  const periods = [
    { value: "all", label: "Todo el proceso", hint: "Desde la primera bitácora hasta hoy." },
    { value: "last-month", label: "Último mes", hint: "Las clases de los últimos 30 días." },
    { value: "last-3-months", label: "Últimos 3 meses", hint: "" },
    { value: "last-6-months", label: "Últimos 6 meses", hint: "" },
    { value: "custom", label: "Período personalizado", hint: "Elige las fechas exactas." },
  ];

  const tones = [
    {
      value: "tecnico",
      label: "Lenguaje técnico",
      hint: "Para estudiantes adultos o acudientes que conocen los conceptos del arte.",
    },
    {
      value: "sencillo",
      label: "Lenguaje sencillo",
      hint: "Explica los conceptos desde cero. Ideal para acudientes de niños pequeños.",
    },
  ];

  return `
    <div class="text-bitacoras-modal-backdrop"></div>
    <section class="text-bitacoras-modal ai-report-modal" role="dialog" aria-modal="true" aria-labelledby="ai-report-title">
      <header class="text-bitacoras-modal__header">
        <div>
          <p class="panel-header__eyebrow">Informe para IA</p>
          <h2 class="panel-header__title" id="ai-report-title">Configura el informe</h2>
          <p class="section-text">Elige el período y el lenguaje. Se descargará un .md listo para pegar en cualquier IA.</p>
        </div>
        <button type="button" class="btn btn--ghost btn--sm" data-ai-report-cancel>Cancelar</button>
      </header>

      <div class="ai-report-modal__periods" role="radiogroup" aria-label="Período del informe">
        ${periods
          .map(
            (period, index) => `
              <label class="choice-pill ai-report-modal__period">
                <input type="radio" name="ai-report-period" value="${period.value}"${index === 0 ? " checked" : ""} />
                <span class="ai-report-modal__period-text">
                  <strong>${escapeHtml(period.label)}</strong>
                  ${period.hint ? `<small>${escapeHtml(period.hint)}</small>` : ""}
                </span>
              </label>
            `
          )
          .join("")}
      </div>

      <div class="ai-report-modal__custom" data-ai-report-custom hidden>
        <label class="field field--compact">
          <span class="field__label">Desde</span>
          <input type="date" id="ai-report-from" class="field__input" />
        </label>
        <label class="field field--compact">
          <span class="field__label">Hasta</span>
          <input type="date" id="ai-report-to" class="field__input" />
        </label>
      </div>

      <p class="ai-report-modal__section-label">Lenguaje del informe</p>
      <div class="ai-report-modal__periods" role="radiogroup" aria-label="Lenguaje del informe">
        ${tones
          .map(
            (toneOption, index) => `
              <label class="choice-pill ai-report-modal__period">
                <input type="radio" name="ai-report-tone" value="${toneOption.value}"${index === 0 ? " checked" : ""} />
                <span class="ai-report-modal__period-text">
                  <strong>${escapeHtml(toneOption.label)}</strong>
                  ${toneOption.hint ? `<small>${escapeHtml(toneOption.hint)}</small>` : ""}
                </span>
              </label>
            `
          )
          .join("")}
      </div>

      <p class="text-bitacoras-modal__status" data-ai-report-status role="status"></p>

      <div class="text-bitacoras-modal__actions">
        <button type="button" class="btn btn--primary" data-ai-report-download>Descargar informe</button>
        <button type="button" class="btn btn--ghost" data-ai-report-cancel>Cancelar</button>
      </div>
    </section>
  `;
}

const REPERTOIRE_STATUSES = [
  { id: "quiere", label: "Quiere tocar", empty: "Sin canciones deseadas todavía." },
  { id: "proceso", label: "Está sacando", empty: "Sin canciones en proceso." },
  { id: "lograda", label: "Ya sacó", empty: "Sin canciones logradas todavía." },
];

const REPERTOIRE_PRIORITIES = [
  { id: "baja", label: "Baja" },
  { id: "media", label: "Media" },
  { id: "alta", label: "Alta" },
];

function getStudentRepertoire(student = {}) {
  return getStudentRepertoireItems(student).map((item) => item.nombre);
}

function getStudentRepertoireItems(student = {}) {
  const source =
    student.repertorioProceso ||
    student.repertoireProgress ||
    student.repertorioEscogido ||
    student.repertoire ||
    student.repertorio ||
    student.proyectoFinal ||
    [];

  const items = Array.isArray(source) ? source : [source];
  const byName = new Map();

  items.forEach((item) => {
    const normalizedItem = normalizeRepertoireItem(item);
    if (!normalizedItem?.nombre) return;
    const key = normalizeText(normalizedItem.nombre);
    if (!key || byName.has(key)) return;
    byName.set(key, normalizedItem);
  });

  return [...byName.values()];
}

function normalizeRepertoireItem(item) {
  const nombre = isPlainObject(item)
    ? toStringSafe(item.nombre || item.name || item.title || item.cancion)
    : toStringSafe(item);
  if (!nombre) return null;

  return {
    nombre,
    estado: normalizeRepertoireStatus(item?.estado || item?.status),
    prioridad: normalizeRepertoirePriority(item?.prioridad || item?.priority),
    notas: isPlainObject(item)
      ? toStringSafe(item.notas || item.notes || item.observacion || item.observaciones)
      : "",
    fechaInicio: normalizeLocalDateInput(
      isPlainObject(item) ? item.fechaInicio || item.startedAt || item.startDate : ""
    ),
    fechaLogro: normalizeLocalDateInput(
      isPlainObject(item) ? item.fechaLogro || item.completedAt || item.endDate : ""
    ),
  };
}

function normalizeRepertoireStatus(value) {
  const normalized = normalizeText(value);
  if (["quiere", "deseada", "deseado", "wishlist", "por trabajar"].includes(normalized)) {
    return "quiere";
  }
  if (["lograda", "logrado", "sacada", "sacado", "completada", "completado"].includes(normalized)) {
    return "lograda";
  }
  return "proceso";
}

function normalizeRepertoirePriority(value) {
  const normalized = normalizeText(value);
  if (["alta", "high"].includes(normalized)) return "alta";
  if (["baja", "low"].includes(normalized)) return "baja";
  return "media";
}

function renderStudentRepertoireCard(student = {}, access = {}) {
  const canEdit = Boolean(access.canEditBitacoras || access.canManageSettings);
  const items = getStudentRepertoireItems(student);
  const options = normalizeTags(cachedCatalogs?.componenteObras || []);

  return `
    <div class="profile-repertoire">
      <p class="field__hint">Obras que el estudiante quiere trabajar, está trabajando o ya logró.</p>
      <div class="profile-repertoire__board" data-repertoire-list>
        ${REPERTOIRE_STATUSES.map((status) =>
          renderRepertoireColumn(status, items, canEdit)
        ).join("")}
      </div>
      ${
        canEdit
          ? `
            <div class="profile-repertoire__entry">
              <input
                type="text"
                class="field__input"
                data-repertoire-input
                list="profile-repertoire-options"
                placeholder="Escribe o elige una canción..."
                autocomplete="off"
              />
              <select class="field__input" data-repertoire-status-new aria-label="Estado inicial de la canción">
                ${REPERTOIRE_STATUSES.map(
                  (status) => `<option value="${status.id}" ${status.id === "quiere" ? "selected" : ""}>${escapeHtml(status.label)}</option>`
                ).join("")}
              </select>
              <button type="button" class="btn btn--secondary btn--sm" data-repertoire-add>
                Agregar
              </button>
              ${renderRepertoireDatalist(options)}
            </div>
          `
          : ""
      }
    </div>
  `;
}

async function renderStudentWorkSuggestions(student) {
  const studentId = getStudentAcademicRecordId(student);
  if (!studentId) return "";
  const suggestions = await listStudentWorkSuggestions(studentId).catch(() => []);
  const pending = suggestions.filter((item) => item.estado === "pendiente");
  return `<article class="card profile-repertoire-card"><header class="panel-header"><div><p class="panel-header__eyebrow">Desde Estudiantes HUB</p><h2 class="panel-header__title">Obras sugeridas por el estudiante</h2></div></header><div class="profile-repertoire">${pending.length ? pending.map((item) => `<article class="profile-repertoire-item"><div class="profile-repertoire-item__main"><strong>${escapeHtml(toStringSafe(item.nombre))}</strong><span>${escapeHtml(toStringSafe(item.notas) || "Sin nota adicional")}</span></div><div class="profile-repertoire-item__actions"><button class="profile-repertoire-action" data-work-suggestion-accept="${escapeHtml(item.id)}" data-work-suggestion-name="${escapeHtml(toStringSafe(item.nombre))}">Aceptar en Obras</button><button class="profile-repertoire-chip__remove" data-work-suggestion-dismiss="${escapeHtml(item.id)}">Descartar</button></div></article>`).join("") : `<p class="field__hint">No hay sugerencias pendientes.</p>`}</div></article>`;
}

function renderRepertoireColumn(status, items = [], canEdit = false) {
  const statusItems = items.filter((item) => item.estado === status.id);
  return `
    <section class="profile-repertoire-column" data-repertoire-column-status="${status.id}">
      <header class="profile-repertoire-column__header">
        <h3>${escapeHtml(status.label)}</h3>
        <span>${statusItems.length}</span>
      </header>
      <div class="profile-repertoire-column__items">
        ${
          statusItems.length
            ? statusItems.map((item) => renderRepertoireItemCard(item, canEdit)).join("")
            : `<p class="field__hint">${escapeHtml(status.empty)}</p>`
        }
      </div>
    </section>
  `;
}

function renderRepertoireItemCard(item, canEdit = false) {
  const safeName = escapeHtml(item.nombre);
  const priorityLabel =
    REPERTOIRE_PRIORITIES.find((priority) => priority.id === item.prioridad)?.label || "Media";
  const dateLabel = item.fechaLogro
    ? `Lograda: ${formatDisplayDate(item.fechaLogro)}`
    : item.fechaInicio
      ? `Inicio: ${formatDisplayDate(item.fechaInicio)}`
      : "";

  return `
    <article class="profile-repertoire-item" data-repertoire-item="${safeName}">
      <div class="profile-repertoire-item__main">
        <strong>${safeName}</strong>
        <span>${renderRepertoireMeta(priorityLabel, dateLabel)}</span>
        ${item.notas ? `<p>${escapeHtml(item.notas)}</p>` : ""}
      </div>
      ${
        canEdit
          ? `
            <div class="profile-repertoire-item__actions">
              ${renderRepertoireQuickActions(item)}
              <details class="profile-repertoire-edit">
                <summary>Editar</summary>
                <div class="profile-repertoire-item__controls">
                  <select class="field__input" data-repertoire-status="${safeName}" aria-label="Estado de ${safeName}">
                    ${REPERTOIRE_STATUSES.map(
                      (status) => `<option value="${status.id}" ${status.id === item.estado ? "selected" : ""}>${escapeHtml(status.label)}</option>`
                    ).join("")}
                  </select>
                  <select class="field__input" data-repertoire-priority="${safeName}" aria-label="Prioridad de ${safeName}">
                    ${REPERTOIRE_PRIORITIES.map(
                      (priority) => `<option value="${priority.id}" ${priority.id === item.prioridad ? "selected" : ""}>${escapeHtml(priority.label)}</option>`
                    ).join("")}
                  </select>
                  <input
                    type="date"
                    class="field__input"
                    data-repertoire-start="${safeName}"
                    value="${escapeHtml(item.fechaInicio)}"
                    aria-label="Fecha de inicio de ${safeName}"
                  />
                  <input
                    type="date"
                    class="field__input"
                    data-repertoire-completed="${safeName}"
                    value="${escapeHtml(item.fechaLogro)}"
                    aria-label="Fecha de logro de ${safeName}"
                  />
                  <textarea
                    class="field__input"
                    data-repertoire-notes="${safeName}"
                    rows="2"
                    placeholder="Observación breve..."
                    aria-label="Observación de ${safeName}"
                  >${escapeHtml(item.notas)}</textarea>
                  <div class="profile-repertoire-edit__footer">
                    <button type="button" class="btn btn--ghost btn--sm" data-repertoire-save="${safeName}">
                      Guardar
                    </button>
                    <button type="button" class="profile-repertoire-chip__remove" data-repertoire-remove="${safeName}" aria-label="Quitar ${safeName}">x</button>
                  </div>
                </div>
              </details>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderRepertoireMeta(priorityLabel, dateLabel) {
  return [priorityLabel ? `Prioridad ${priorityLabel.toLowerCase()}` : "", dateLabel]
    .filter(Boolean)
    .map((item) => escapeHtml(item))
    .join(" · ");
}

function renderRepertoireQuickActions(item) {
  const actions = [];
  if (item.estado !== "proceso") {
    actions.push({ status: "proceso", label: "A proceso" });
  }
  if (item.estado !== "lograda") {
    actions.push({ status: "lograda", label: "Lograda" });
  }
  if (item.estado !== "quiere") {
    actions.push({ status: "quiere", label: "Deseada" });
  }

  return actions
    .slice(0, 2)
    .map(
      (action) => `
        <button
          type="button"
          class="profile-repertoire-action"
          data-repertoire-quick-status="${escapeHtml(item.nombre)}"
          data-repertoire-next-status="${action.status}"
        >
          ${escapeHtml(action.label)}
        </button>
      `
    )
    .join("");
}

function renderRepertoireDatalist(options = []) {
  if (!options.length) return "";
  return `
    <datalist id="profile-repertoire-options">
      ${options.map((option) => `<option value="${escapeHtml(option)}"></option>`).join("")}
    </datalist>
  `;
}

function formatRepertoireForAiReport(items = []) {
  return REPERTOIRE_STATUSES.map((status) => {
    const statusItems = items.filter((item) => item.estado === status.id);
    if (!statusItems.length) return "";

    return [
      `### ${status.label}`,
      statusItems
        .map((item) => {
          const details = [
            item.prioridad ? `prioridad ${item.prioridad}` : "",
            item.fechaInicio ? `inicio ${formatDisplayDate(item.fechaInicio)}` : "",
            item.fechaLogro ? `logro ${formatDisplayDate(item.fechaLogro)}` : "",
            item.notas ? `observación: ${item.notas}` : "",
          ].filter(Boolean);
          return `- ${item.nombre}${details.length ? ` (${details.join("; ")})` : ""}`;
        })
        .join("\n"),
    ].join("\n");
  })
    .filter(Boolean)
    .join("\n\n");
}

async function saveProfileRepertoire(student, values = []) {
  const studentId = getStudentAcademicRecordId(student);
  if (!studentId) return;

  clearAppError();

  try {
    const updated = await updateStudentRepertoire(studentId, values);
    const nextStudent = mergePedagogicalUpdate(student, updated);
    updateStudentProfile(nextStudent);
    setSelectedStudent(nextStudent);
    renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
    return true;
  } catch (error) {
    console.error("No se pudo guardar repertorio:", error);
    setAppError(
      `No se guardó la canción. ${
        error?.message || "Firebase no permitió actualizar el repertorio del estudiante."
      }`
    );
    return false;
  }
}

async function addProfileRepertoireItem(student) {
  const currentStudent =
    getStudentFromState(getState(), getStudentIdentity(student)) || student;
  const input = viewRoot?.querySelector("[data-repertoire-input]");
  const statusSelect = viewRoot?.querySelector("[data-repertoire-status-new]");
  const value = toStringSafe(input?.value);
  if (!value) return;

  const nextValues = [
    ...getStudentRepertoireItems(currentStudent),
    {
      nombre: value,
      estado: normalizeRepertoireStatus(statusSelect?.value || "quiere"),
      prioridad: "media",
      notas: "",
      fechaInicio: "",
      fechaLogro: "",
    },
  ];
  const added = await saveProfileRepertoire(currentStudent, nextValues);
  // No borrar lo escrito hasta que Firebase confirme la operación. Si hay un
  // error de permisos o conexión, el docente puede corregir o reintentar sin
  // volver a digitar el nombre de la canción.
  if (added && input) input.value = "";
}

async function removeProfileRepertoireItem(student, value) {
  const currentStudent =
    getStudentFromState(getState(), getStudentIdentity(student)) || student;
  const safeValue = toStringSafe(value);
  if (!safeValue) return;

  const nextValues = getStudentRepertoireItems(currentStudent).filter(
    (item) => normalizeText(item.nombre) !== normalizeText(safeValue)
  );
  await saveProfileRepertoire(currentStudent, nextValues);
}

async function updateProfileRepertoireItem(student, value, overrides = {}) {
  const currentStudent =
    getStudentFromState(getState(), getStudentIdentity(student)) || student;
  const safeValue = toStringSafe(value);
  if (!safeValue) return;

  const card = [...(viewRoot?.querySelectorAll("[data-repertoire-item]") || [])].find(
    (node) => normalizeText(node.getAttribute("data-repertoire-item")) === normalizeText(safeValue)
  );
  const nextValues = getStudentRepertoireItems(currentStudent).map((item) => {
    if (normalizeText(item.nombre) !== normalizeText(safeValue)) return item;

    return {
      ...item,
      estado: normalizeRepertoireStatus(
        overrides.estado || card?.querySelector("[data-repertoire-status]")?.value || item.estado
      ),
      prioridad: normalizeRepertoirePriority(
        overrides.prioridad ||
          card?.querySelector("[data-repertoire-priority]")?.value ||
          item.prioridad
      ),
      fechaInicio: normalizeLocalDateInput(
        overrides.fechaInicio ?? card?.querySelector("[data-repertoire-start]")?.value ?? item.fechaInicio
      ),
      fechaLogro: normalizeLocalDateInput(
        overrides.fechaLogro ?? card?.querySelector("[data-repertoire-completed]")?.value ?? item.fechaLogro
      ),
      notas: toStringSafe(
        overrides.notas ?? card?.querySelector("[data-repertoire-notes]")?.value ?? item.notas
      ),
    };
  });

  await saveProfileRepertoire(currentStudent, nextValues);
}

function renderAllBitacorasPanel(student, bitacoras = [], config, isAuthenticated = true) {
  if (!isAuthenticated || !Array.isArray(bitacoras) || !bitacoras.length) {
    return renderHistoryPreview(student, bitacoras, config, isAuthenticated);
  }

  const processOptions = normalizeStudentProcesses(student);
  const sortedItems = sortBitacorasByDate(bitacoras);
  const filteredItems = filterProfileBitacorasBySearch(
    sortedItems,
    currentProfileHistorySearchQuery
  );

  if (currentProfileHistorySearchQuery && !filteredItems.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin resultados</p>
        <p class="empty-state__text">
          No encontre bitacoras que coincidan con "${escapeHtml(currentProfileHistorySearchQuery)}".
        </p>
      </div>
    `;
  }

  const visibleItems = filteredItems.slice(0, currentProfileHistoryVisibleCount);
  const remainingItems = filteredItems.length - visibleItems.length;

  return `
    <div class="teaching-history-list">
      ${visibleItems
        .map((item) => renderTeachingHistoryCard(item, student, processOptions))
        .join("")}
      <div class="profile-panel-actions">
        ${
          remainingItems > 0
            ? `<button type="button" class="btn btn--ghost btn--sm" data-history-action="show-more-history">
                Ver ${Math.min(remainingItems, PROFILE_HISTORY_RENDER_LIMIT)} más (${remainingItems} pendientes)
              </button>`
            : ""
        }
        <button type="button" class="btn btn--primary btn--sm" data-history-action="open-editor">
          Nueva bitácora
        </button>
      </div>
    </div>
  `;
}

function renderProfileHistorySearchControl(value = "") {
  return `
    <label class="history-search field">
      <span class="field__label">Buscar en bitacoras</span>
      <input
        id="profile-history-search"
        type="search"
        class="field__input"
        value="${escapeHtml(value)}"
        placeholder="Busca tecnica, ritmo, obra, tarea, docente o fecha..."
        autocomplete="off"
      />
    </label>
  `;
}

function filterProfileBitacorasBySearch(items = [], query = "") {
  const needle = normalizeText(query);
  if (!needle) return items;

  return items.filter((item) =>
    getIndexedProfileBitacoraSearchText(item).includes(needle)
  );
}

function getIndexedProfileBitacoraSearchText(item = {}) {
  if (!item || typeof item !== "object") return "";
  const cached = profileBitacoraSearchIndex.get(item);
  if (cached !== undefined) return cached;

  const indexed = normalizeText(buildProfileBitacoraSearchText(item));
  profileBitacoraSearchIndex.set(item, indexed);
  return indexed;
}

function renderAllBitacorasOnly(student) {
  const allHistoryContainer = viewRoot?.querySelector("#profile-all-history-content");
  if (!allHistoryContainer) return;

  const state = getState();
  allHistoryContainer.innerHTML = renderAllBitacorasPanel(
    student,
    getBitacorasFromState(student),
    CONFIG,
    Boolean(state?.auth?.isAuthenticated)
  );
}

function buildProfileBitacoraSearchText(item = {}) {
  const structured = parseStructuredContent(item.contenido || item.content || "");
  const overrides = normalizeStudentOverrides(item.studentOverrides, item.studentIds || []);

  return [
    item.titulo,
    item.title,
    item.fechaClase,
    formatDisplayDate(item.fechaClase || item.createdAt),
    item.docente,
    item.author?.name,
    item.author?.displayName,
    item.author?.email,
    item.process?.processLabel,
    item.process?.area,
    item.process?.programa,
    item.process?.docente,
    item.processKey,
    item.contenido,
    item.content,
    structured.docente,
    structured.tareas,
    ...(item.etiquetas || []),
    ...(item.tags || []),
    ...(structured.componenteCorporal || []),
    ...(structured.componenteTecnico || []),
    ...(structured.componenteTeorico || []),
    ...(structured.componenteObras || []),
    ...(item.studentRefs || []).flatMap((student) => [student.name, student.id]),
    ...Object.values(overrides).flatMap((override) => [
      override.tareas,
      ...(override.etiquetas || []),
      ...(override.componenteCorporal || []),
      ...(override.componenteTecnico || []),
      ...(override.componenteTeorico || []),
      ...(override.componenteObras || []),
    ]),
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(Boolean)
    .join(" ");
}

function renderTeachingHistoryCard(item, student, processOptions = []) {
  const mode = normalizeMode(item.mode);
  const structuredContent = parseStructuredContent(item.contenido || "");
  const teacherName = firstNonEmpty(
    structuredContent.docente,
    getHistoryTeacherName(item)
  );
  const selectedProcessKey = toStringSafe(
    item?.process?.processKey || item?.processKey
  );
  const selectedProcess = processOptions.find(
    (process) => toStringSafe(process?.processKey) === selectedProcessKey
  );
  const processLabel = getProcessDisplayLabel(selectedProcess || item?.process);
  const currentOverride = getCurrentStudentOverride(item, student);
  const hasOverrideContent = hasStudentOverrideContent(currentOverride);
  const hasGeneralContent = hasStructuredHistoryContent(structuredContent);
  const title = toStringSafe(item.titulo || "Bitácora sin título");
  const tags = normalizeTags(item.etiquetas || []);
  const overrideTags = normalizeTags(currentOverride?.etiquetas || []);

  return `
    <article class="teaching-history-card" data-history-card>
      <header class="teaching-history-card__header">
        <div>
          <p class="teaching-history-card__date">
            ${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}
          </p>
          <h3 class="teaching-history-card__title">${escapeHtml(title)}</h3>
        </div>
        <div class="teaching-history-card__meta">
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-history-action="delete-bitacora"
            data-bitacora-id="${escapeHtml(item.id || "")}"
          >
            Eliminar
          </button>
          <span class="badge">${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}</span>
          ${
            teacherName
              ? `<span class="badge badge--soft">Docente: ${escapeHtml(teacherName)}</span>`
              : ""
          }
          ${
            processLabel
              ? `<span class="badge badge--soft">Proceso: ${escapeHtml(processLabel)}</span>`
              : ""
          }
        </div>
      </header>

      ${
        tags.length
          ? `<div class="teaching-history-card__chips">
              ${tags.map((tag) => `<span class="badge badge--soft">${escapeHtml(tag)}</span>`).join("")}
            </div>`
          : ""
      }

      ${
        hasOverrideContent
          ? `<section class="teaching-history-section teaching-history-section--highlight">
              <p class="teaching-history-section__label">Ajustes para este estudiante</p>
              <div class="teaching-history-card__sections">
                ${renderHistorySection("Tareas / observaciones", currentOverride.tareas)}
                ${renderHistoryListSection("Componente corporal", currentOverride.componenteCorporal)}
                ${renderHistoryListSection("Componente técnico", currentOverride.componenteTecnico)}
                ${renderHistoryListSection("Componente teórico", currentOverride.componenteTeorico)}
                ${renderHistoryListSection("Componente de obras", currentOverride.componenteObras)}
                ${renderHistoryListSection("Etiquetas individuales", overrideTags)}
              </div>
            </section>`
          : ""
      }

      ${
        hasOverrideContent && hasGeneralContent
          ? `<p class="teaching-history-card__subtitle">Trabajo general de la clase</p>`
          : ""
      }

      <div class="teaching-history-card__sections">
        ${renderHistorySection("Tareas / observaciones", structuredContent.tareas)}
        ${renderHistoryListSection("Componente corporal", structuredContent.componenteCorporal)}
        ${renderHistoryListSection("Componente técnico", structuredContent.componenteTecnico)}
        ${renderHistoryListSection("Componente teórico", structuredContent.componenteTeorico)}
        ${renderHistoryListSection("Componente de obras", structuredContent.componenteObras)}
        ${
          hasGeneralContent
            ? ""
            : renderHistorySection("Tareas / observaciones", item.contenido || "Sin contenido registrado.")
        }
      </div>

      ${renderProcessAssignmentControl(item, processOptions, selectedProcessKey)}
    </article>
  `;
}

function openProfilePanel(target = "") {
  const normalizedTarget = target === "route-editor" ? "route" : target;
  const panels = Array.from(viewRoot?.querySelectorAll("[data-profile-panel]") || []);
  if (!panels.length || !normalizedTarget) return;

  panels.forEach((panel) => {
    panel.hidden = panel.getAttribute("data-profile-panel") !== normalizedTarget;
  });

  const activePanel = panels.find(
    (panel) => panel.getAttribute("data-profile-panel") === normalizedTarget
  );
  if (activePanel) {
    activePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeProfilePanels() {
  Array.from(viewRoot?.querySelectorAll("[data-profile-panel]") || []).forEach(
    (panel) => {
      panel.hidden = true;
    }
  );
}

function renderSummary(student, bitacoras = []) {
  const lastBitacora = getLatestBitacora(bitacoras);
  const firstBitacora = getFirstBitacora(bitacoras);
  const uniqueClassDays = getUniqueBitacoraDates(bitacoras);
  const studentTimeLabel = firstBitacora
    ? formatStudentTimeSinceFirstBitacora(firstBitacora.fechaClase || firstBitacora.createdAt)
    : "Sin registros";
  const totalGroup = bitacoras.filter(
    (item) => normalizeMode(item.mode) === CONFIG.modes.group
  ).length;
  const totalIndividual = bitacoras.filter(
    (item) => normalizeMode(item.mode) === CONFIG.modes.individual
  ).length;

  return `
    <div class="summary-list">
      <article class="summary-item">
        <span class="summary-item__label">Total de bitácoras</span>
        <strong class="summary-item__value">${bitacoras.length}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Individuales</span>
        <strong class="summary-item__value">${totalIndividual}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Grupales</span>
        <strong class="summary-item__value">${totalGroup}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Tiempo en Musicala</span>
        <strong class="summary-item__value">${escapeHtml(studentTimeLabel)}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Días con bitácora</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            uniqueClassDays.length
              ? `${uniqueClassDays.length} día${uniqueClassDays.length === 1 ? "" : "s"} registrados`
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Primera bitácora</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            firstBitacora
              ? formatDisplayDate(firstBitacora.fechaClase || firstBitacora.createdAt)
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Última clase registrada</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            lastBitacora
              ? formatDisplayDate(lastBitacora.fechaClase || lastBitacora.createdAt)
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Último tipo de registro</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            lastBitacora
              ? normalizeMode(lastBitacora.mode) === CONFIG.modes.group
                ? "Grupal"
                : "Individual"
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Docente asignado</span>
        <strong class="summary-item__value">
          ${escapeHtml(getReadableValue(student.docente || student.teacher))}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Procesos</span>
        <strong class="summary-item__value">
          ${escapeHtml(getReadableValue(getStudentProcessesSummary(student), "Sin procesos"))}
        </strong>
      </article>
    </div>
  `;
}

function getFirstBitacora(items = []) {
  return [...items]
    .filter((item) => getTimestamp(item?.fechaClase || item?.createdAt))
    .sort(
      (a, b) =>
        getTimestamp(a.fechaClase || a.createdAt) -
        getTimestamp(b.fechaClase || b.createdAt)
    )[0] || null;
}

function getUniqueBitacoraDates(items = []) {
  return [
    ...new Set(
      items
        .map((item) => normalizeLocalDateInput(item?.fechaClase || item?.createdAt))
        .filter(Boolean)
    ),
  ].sort();
}

function formatStudentTimeSinceFirstBitacora(value = "") {
  const startDate = normalizeLocalDateInput(value);
  const today = normalizeLocalDateInput(getTodayDate());
  const days = getDaysBetweenLocalDates(startDate, today);

  if (!Number.isFinite(days) || days < 0) return "Sin registros";
  if (days === 0) return "Empezó hoy";

  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const remainingDays = days - years * 365 - months * 30;
  const parts = [];

  if (years) parts.push(`${years} año${years === 1 ? "" : "s"}`);
  if (months) parts.push(`${months} mes${months === 1 ? "" : "es"}`);
  if (!years && remainingDays) {
    parts.push(`${remainingDays} día${remainingDays === 1 ? "" : "s"}`);
  }

  return `${parts.join(", ")} (${days} día${days === 1 ? "" : "s"})`;
}

function getDaysBetweenLocalDates(startValue = "", endValue = "") {
  const startMatch = normalizeLocalDateInput(startValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const endMatch = normalizeLocalDateInput(endValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!startMatch || !endMatch) return NaN;

  const startUtc = Date.UTC(Number(startMatch[1]), Number(startMatch[2]) - 1, Number(startMatch[3]));
  const endUtc = Date.UTC(Number(endMatch[1]), Number(endMatch[2]) - 1, Number(endMatch[3]));
  return Math.floor((endUtc - startUtc) / 86400000);
}

async function ensureLearningRouteLoaded(student, options = {}) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;
  const forceReload = Boolean(options?.forceReload);

  const access = resolveUserAccess(getState()?.auth?.user);
  const currentRoute = getStudentRoute(studentId);
  const currentGoals = getStudentGoals(studentId);
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const activeProcessKey = toStringSafe(
    currentProfileProcessKey || activeProcess?.processKey
  );

  if (
    !forceReload &&
    currentRoute?.presetId &&
    Array.isArray(currentGoals) &&
    currentGoals.length &&
    toStringSafe(currentRoute?.processKey || "") === activeProcessKey
  ) {
    return;
  }

  setProfileLoading(true);

  try {
    const persistedRoute = await getStudentRouteRecord(studentId, {
      processKey: activeProcessKey,
      routeTemplateId: normalizeArtKey(student),
    });
    const currentMatchesActiveProcess =
      toStringSafe(currentRoute?.processKey || "") === activeProcessKey;
    const baseRoute =
      persistedRoute || (currentMatchesActiveProcess ? currentRoute : {});
    const nextRoute = buildDefaultRouteState(student, baseRoute);

    setStudentRoute(studentId, nextRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(nextRoute, student));

    if (!persistedRoute && access.canEditRouteStructure) {
      const savedRoute = await persistLearningRouteStructure(student, nextRoute);
      setStudentRoute(studentId, savedRoute);
      setStudentGoals(studentId, buildStudentGoalsFromRoute(savedRoute, student));
    }
  } catch (error) {
    console.error("Error cargando la ruta de aprendizaje:", error);

    const fallbackRoute = buildDefaultRouteState(student, currentRoute);
    setStudentRoute(studentId, fallbackRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(fallbackRoute, student));

    setAppError(
      error?.message || "No se pudo cargar la ruta de aprendizaje."
    );
  } finally {
    setProfileLoading(false);
  }
}

function getActiveProcessContext(student) {
  return (
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null
  );
}

function getRouteSaveOptions(student) {
  const activeProcess = getActiveProcessContext(student);
  const routeTemplateId = normalizeArtKey(student);
  return {
    student,
    processKey: currentProfileProcessKey || "",
    processLabel: activeProcess?.label || "",
    routeTemplateId,
    areaKey: routeTemplateId,
    instrumentKey: routeTemplateId,
  };
}

async function persistLearningRouteStructure(student, route) {
  const studentId = getStudentIdentity(student);
  if (!studentId) {
    throw new Error("No se pudo resolver el estudiante para guardar la ruta.");
  }

  const savedRoute = await saveStudentRouteRecord(
    studentId,
    route,
    getRouteSaveOptions(student)
  );
  return buildDefaultRouteState(student, savedRoute);
}

async function persistLearningRouteProgress(student, route) {
  const studentId = getStudentIdentity(student);
  if (!studentId) {
    throw new Error("No se pudo resolver el estudiante para guardar el avance.");
  }

  const savedRoute = await saveStudentRouteProgressRecord(
    studentId,
    route,
    getRouteSaveOptions(student)
  );
  return buildDefaultRouteState(student, savedRoute);
}

function normalizeArtKey(student) {
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const rawValue = firstNonEmpty(
    activeProcess?.detalle,
    activeProcess?.label,
    activeProcess?.programa,
    activeProcess?.instrumento,
    activeProcess?.arte,
    student?.area,
    student?.instrumento,
    student?.programa
  );

  const normalized = toStringSafe(rawValue)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return "general";
  if (normalized.includes("bateria") || normalized.includes("percusion")) return "bateria";
  if (normalized.includes("guitarra")) return "guitarra";
  if (normalized.includes("cello") || normalized.includes("violoncello")) return "cello";
  if (normalized.includes("canto")) return "canto";
  if (normalized.includes("danza")) return "danza";
  if (normalized.includes("teatro")) return "teatro";
  if (normalized.includes("plast")) return "artes-plasticas";
  return normalized;
}

function getTitleFromArtKey(artKey) {
  return artKey
    .split("-")
    .filter(Boolean)
    .map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1))
    .join(" ");
}

function buildGenericRoutePreset(artKey, artLabel) {
  const goals = [];

  ROUTE_EXPERIENCES.forEach((experience) => {
    goals.push(
      {
        id: `${artKey}-exp${experience}-corporal`,
        component: "corporal",
        experience,
        order: experience,
        title: `Presencia corporal (Experiencia ${experience})`,
        description: `Fortalece postura, respiracion y preparacion corporal en ${artLabel}.`,
      },
      {
        id: `${artKey}-exp${experience}-tecnico`,
        component: "tecnico",
        experience,
        order: experience,
        title: `Tecnica base (Experiencia ${experience})`,
        description: `Consolida recursos tecnicos de ${artLabel} con control y continuidad.`,
      },
      {
        id: `${artKey}-exp${experience}-teorico`,
        component: "teorico",
        experience,
        order: experience,
        title: `Comprension del lenguaje (Experiencia ${experience})`,
        description: `Relaciona conceptos teoricos aplicados al proceso de ${artLabel}.`,
      },
      {
        id: `${artKey}-exp${experience}-obras`,
        component: "obras",
        experience,
        order: experience,
        title: `Montaje y presentacion (Experiencia ${experience})`,
        description: `Integra tecnica y expresion en repertorio o montaje de ${artLabel}.`,
      }
    );
  });

  return {
    id: `${artKey}_base_v1`,
    routeName: `Ruta de aprendizaje - ${artLabel}`,
    goals,
  };
}

function resolveRoutePreset(student, baseRoute = {}) {
  const customGoals = normalizeManualRouteGoals(baseRoute?.customGoals);
  if (customGoals.length) {
    return {
      id: toStringSafe(baseRoute?.presetId) || "ruta_manual_v1",
      routeName: toStringSafe(baseRoute?.routeName) || "Ruta manual",
      goals: customGoals,
    };
  }

  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const activeProcessKey = toStringSafe(
    currentProfileProcessKey || activeProcess?.processKey
  );
  const baseRouteProcessKey = toStringSafe(baseRoute?.processKey || "");
  const activeProcessHint = toStringSafe(
    firstNonEmpty(activeProcess?.detalle, activeProcess?.label, activeProcess?.arte)
  )
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  let forcedPreset = null;
  if (activeProcessHint.includes("canto")) {
    forcedPreset = ROUTE_PRESETS.canto;
  }
  if (
    !forcedPreset &&
    (activeProcessHint.includes("cello") ||
      activeProcessHint.includes("violoncello"))
  ) {
    forcedPreset = ROUTE_PRESETS.cello;
  }
  if (!forcedPreset && activeProcessHint.includes("piano")) {
    forcedPreset = ROUTE_PRESETS.piano;
  }
  if (forcedPreset) return forcedPreset;

  const byId = toStringSafe(baseRoute?.presetId);
  const builtIn =
    byId &&
    (!activeProcessKey || baseRouteProcessKey === activeProcessKey)
      ? Object.values(ROUTE_PRESETS).find((preset) => preset.id === byId)
      : null;
  if (builtIn) return builtIn;

  const instrumentHints = [
    activeProcess?.detalle,
    activeProcess?.label,
    activeProcess?.arte,
    student?.instrumento,
    student?.programa,
    student?.area,
  ]
    .map((value) =>
      toStringSafe(value)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    )
    .join(" ");

  if (instrumentHints.includes("piano")) {
    return ROUTE_PRESETS.piano;
  }
  if (instrumentHints.includes("canto")) {
    return ROUTE_PRESETS.canto;
  }
  if (instrumentHints.includes("cello") || instrumentHints.includes("violoncello")) {
    return ROUTE_PRESETS.cello;
  }

  const artKey = normalizeArtKey(student);
  if (ROUTE_PRESETS[artKey]) return ROUTE_PRESETS[artKey];
  if (routePresetCache.has(artKey)) return routePresetCache.get(artKey);

  const genericPreset = buildGenericRoutePreset(artKey, getTitleFromArtKey(artKey) || "Proceso");
  routePresetCache.set(artKey, genericPreset);
  return genericPreset;
}

function buildDefaultRouteState(student, baseRoute = {}) {
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const preset = resolveRoutePreset(student, baseRoute);
  const routeTemplateId =
    toStringSafe(baseRoute?.routeTemplateId) || normalizeArtKey(student);
  const routeComponents = getRouteComponentsForPreset(preset);
  const presetGoalIds = new Set(preset.goals.map((goal) => goal.id));
  const orphanCompletedGoalIds = Array.isArray(baseRoute?.completedGoalIds)
    ? [
        ...new Set(
          baseRoute.completedGoalIds
            .map((item) => toStringSafe(item))
            .filter((goalId) => goalId && !presetGoalIds.has(goalId))
        ),
      ]
    : [];
  if (orphanCompletedGoalIds.length) {
    console.warn(
      "La ruta tiene objetivos completados que ya no existen en la plantilla activa.",
      {
        routeTemplateId,
        orphanCompletedGoalIds,
      }
    );
  }
  const completedGoalIds = Array.isArray(baseRoute?.completedGoalIds)
    ? [
        ...new Set(
          baseRoute.completedGoalIds
            .map((item) => toStringSafe(item))
            .filter((goalId) => goalId && presetGoalIds.has(goalId))
        ),
      ]
    : [];

  const history = Array.isArray(baseRoute?.history)
    ? baseRoute.history
        .map((entry) => ({
          goalId: toStringSafe(entry?.goalId),
          title: toStringSafe(entry?.title),
          component: toStringSafe(entry?.component),
          experience: Number(entry?.experience) || 1,
          completedAt: entry?.completedAt || null,
        }))
        .filter((entry) => entry.goalId)
        .filter((entry) => presetGoalIds.has(entry.goalId))
    : [];

  const experience = deriveCurrentExperience(completedGoalIds, preset);
  const progress = buildRouteProgress(completedGoalIds, preset);
  const nextByComponent = getNextGoalsByComponent(
    completedGoalIds,
    preset,
    routeComponents
  );

  return {
    ...(baseRoute && typeof baseRoute === "object" ? baseRoute : {}),
    routeTemplateId,
    areaKey: toStringSafe(baseRoute?.areaKey) || routeTemplateId,
    instrumentKey: toStringSafe(baseRoute?.instrumentKey) || routeTemplateId,
    presetId: preset.id,
    routeName: preset.routeName,
    customGoals: normalizeManualRouteGoals(baseRoute?.customGoals),
    experienceDescriptions: normalizeExperienceDescriptions(
      baseRoute?.experienceDescriptions
    ),
    processKey: toStringSafe(currentProfileProcessKey || activeProcess?.processKey),
    processLabel: firstNonEmpty(
      activeProcess?.label,
      activeProcess?.detalle,
      activeProcess?.arte
    ),
    focusArea:
      getReadableValue(
        activeProcess?.label ||
          activeProcess?.detalle ||
          activeProcess?.arte ||
          student.area ||
          student.instrumento ||
          student.programa,
        "Proceso general"
      ),
    completedGoalIds,
    history,
    currentExperience: experience,
    stage: `Experiencia ${experience}`,
    activeGoalIds: nextByComponent.map((goal) => goal.id),
    milestones: progress.milestones,
    recommendations: buildRouteRecommendations(nextByComponent, routeComponents),
    updatedAt: getTimestamp(new Date().toISOString()) ? new Date().toISOString() : null,
  };
}

function buildStudentGoalsFromRoute(route = {}, student = null) {
  const preset = resolveRoutePreset(student, route);
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const activeIds = new Set(Array.isArray(route.activeGoalIds) ? route.activeGoalIds : []);

  return preset.goals.map((goal) => ({
    id: goal.id,
    title: goal.title,
    component: goal.component,
    experience: goal.experience,
    description: goal.description,
    status: completedIds.has(goal.id)
      ? "completado"
      : activeIds.has(goal.id)
      ? "activo"
      : "bloqueado",
    progress: completedIds.has(goal.id) ? 100 : activeIds.has(goal.id) ? 50 : 0,
    updatedAt:
      route.history?.find((entry) => entry.goalId === goal.id)?.completedAt || null,
  }));
}

function normalizeManualRouteGoals(goals = []) {
  return (Array.isArray(goals) ? goals : [])
    .map((goal, index) => {
      const title = toStringSafe(goal?.title);
      if (!title) return null;

      const component = toLearningRouteComponentId(goal?.component || goal?.componentLabel);
      const componentLabel =
        toStringSafe(goal?.componentLabel) ||
        getTitleFromArtKey(component) ||
        toStringSafe(goal?.component) ||
        "General";

      return {
        id:
          toStringSafe(goal?.id) ||
          buildManualGoalId(component, title, index, {
            experience: Number(goal?.experience) || 1,
          }),
        component,
        componentLabel,
        section: toStringSafe(goal?.section || componentLabel),
        experience: Number(goal?.experience) || 1,
        order: Number(goal?.order) || index + 1,
        title,
        description: toStringSafe(goal?.description || `Ruta manual · ${componentLabel}`),
      };
    })
    .filter(Boolean);
}

function normalizeExperienceDescriptions(descriptions = {}) {
  if (!descriptions || typeof descriptions !== "object") return {};

  return Object.entries(descriptions).reduce((acc, [key, value]) => {
    const experience = Number(key);
    const description = toStringSafe(value);
    if (Number.isFinite(experience) && experience > 0 && description) {
      acc[String(experience)] = description;
    }
    return acc;
  }, {});
}

function serializeManualRouteGoals(goals = []) {
  return normalizeManualRouteGoals(goals)
    .map((goal) =>
      [
        goal.componentLabel || goal.component || "General",
        goal.title,
        goal.experience || 1,
        goal.description || "",
      ].join(" | ")
    )
    .join("\n");
}

function parseManualRouteGoals(rawText = "", existingGoals = [], routeTemplateId = "") {
  const existingByIndex = Array.isArray(existingGoals) ? existingGoals : [];
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line, index) => {
      const parts = line.split("|").map((part) => toStringSafe(part));
      const [
        componentRaw = "General",
        titleRaw = "",
        experienceRaw = "1",
        descriptionRaw = "",
      ] = parts;
      const title = titleRaw || componentRaw;
      if (!title) return null;

      const component = titleRaw ? toLearningRouteComponentId(componentRaw) : "general";
      const componentLabel = titleRaw ? componentRaw : "General";

      const experience = Number(experienceRaw) || 1;
      const existingGoal = existingByIndex[index] || null;

      return {
        id:
          toStringSafe(existingGoal?.id) ||
          buildManualGoalId(component, title, index, {
            routeTemplateId,
            experience,
          }),
        component,
        componentLabel,
        section: componentLabel,
        experience,
        order: index + 1,
        title,
        description:
          descriptionRaw ||
          toStringSafe(existingGoal?.description) ||
          `Ruta manual · ${componentLabel}`,
      };
    })
    .filter(Boolean);
}

function buildManualGoalId(component, title, index = 0, context = {}) {
  const safeComponent = toLearningRouteComponentId(component || "general");
  const safeTemplate = toStringSafe(context.routeTemplateId || "ruta")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safeExperience = Number(context.experience) || 1;
  const safeIndex = String(index + 1).padStart(3, "0");

  return `${safeTemplate || "ruta"}_exp${safeExperience}_${safeComponent}_${safeIndex}`;
}

function getCurrentRouteTemplateId() {
  const state = getState();
  const studentId = getSelectedStudentId();
  const student =
    state?.profile?.byStudentId?.[studentId] ||
    state?.students?.byId?.[studentId] ||
    {};
  return normalizeArtKey(student);
}

function buildRouteProgress(completedGoalIds = [], preset) {
  const safePreset = preset || { goals: GUITAR_ROUTE_PRESET };
  const completed = new Set(completedGoalIds);
  const totalGoals = safePreset.goals.length;
  const completedGoals = safePreset.goals.filter((goal) =>
    completed.has(goal.id)
  ).length;

  const milestones = ROUTE_EXPERIENCES.map((experience) => {
    const goals = safePreset.goals.filter(
      (goal) => goal.experience === experience
    );
    const completedGoalsInExperience = goals.filter((goal) =>
      completed.has(goal.id)
    ).length;

    return {
      experience,
      total: goals.length,
      completed: completedGoalsInExperience,
      unlocked: experience <= deriveCurrentExperience(completedGoalIds, safePreset),
      done: completedGoalsInExperience === goals.length,
    };
  });

  return {
    totalGoals,
    completedGoals,
    percent: totalGoals ? Math.round((completedGoals / totalGoals) * 100) : 0,
    milestones,
  };
}

function deriveCurrentExperience(completedGoalIds = [], preset) {
  const safePreset = preset || { goals: GUITAR_ROUTE_PRESET };
  const completed = new Set(completedGoalIds);
  let current = 1;

  ROUTE_EXPERIENCES.forEach((experience) => {
    const goals = safePreset.goals.filter(
      (goal) => goal.experience === experience
    );
    const isDone = goals.length > 0 && goals.every((goal) => completed.has(goal.id));
    if (isDone) {
      current = Math.min(experience + 1, ROUTE_EXPERIENCES.length);
    }
  });

  return current;
}

function getNextGoalsByComponent(
  completedGoalIds = [],
  preset,
  components = ROUTE_COMPONENTS
) {
  const safePreset = preset || { goals: GUITAR_ROUTE_PRESET };
  const completed = new Set(completedGoalIds);

  return components
    .flatMap(({ id }) => {
      const componentGoals = safePreset.goals
        .filter((goal) => goal.component === id)
        .sort(compareRouteGoals);
      const sections = groupGoalsBySection(componentGoals);

      return sections
        .map((section) => section.goals.find((goal) => !completed.has(goal.id)))
        .filter(Boolean);
    })
    .filter(Boolean);
}

function buildRouteRecommendations(nextGoals = [], components = ROUTE_COMPONENTS) {
  return nextGoals.slice(0, 3).map((goal) => {
    return `Siguiente foco en ${getComponentLabel(goal.component, components)}: ${goal.title}`;
  });
}

function getComponentLabel(componentId, components = ROUTE_COMPONENTS) {
  return (
    components.find((component) => component.id === componentId)?.label ||
    ROUTE_COMPONENTS.find((component) => component.id === componentId)?.label ||
    "Componente"
  );
}

function getRouteComponentsForPreset(preset = null) {
  const goals = Array.isArray(preset?.goals) ? preset.goals : [];
  if (!goals.length) return ROUTE_COMPONENTS;

  const components = [];
  const seen = new Set();

  goals.forEach((goal) => {
    const componentId = toStringSafe(goal?.component);
    if (!componentId || seen.has(componentId)) return;
    seen.add(componentId);
    components.push({
      id: componentId,
      label:
        toStringSafe(goal?.componentLabel) ||
        ROUTE_COMPONENTS.find((item) => item.id === componentId)?.label ||
        `Componente ${componentId}`,
    });
  });

  return components.length ? components : ROUTE_COMPONENTS;
}

function compareRouteGoals(a = {}, b = {}) {
  const expDiff = Number(a?.experience || 0) - Number(b?.experience || 0);
  if (expDiff !== 0) return expDiff;
  return Number(a?.order || 0) - Number(b?.order || 0);
}

function groupGoalsBySection(goals = []) {
  const sectionMap = new Map();

  [...goals].sort(compareRouteGoals).forEach((goal) => {
    const sectionLabel = toStringSafe(goal?.section) || "General";
    const sectionKey = normalizeText(sectionLabel) || "general";
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        key: sectionKey,
        label: sectionLabel,
        goals: [],
      });
    }
    sectionMap.get(sectionKey).goals.push(goal);
  });

  return [...sectionMap.values()];
}

function renderLearningRoute(student) {
  const access = resolveUserAccess(getState()?.auth?.user);
  const canEditRouteStructure = Boolean(access.canEditRouteStructure);
  const canUpdateRouteProgress = Boolean(access.canUpdateRouteProgress);
  const studentId = getStudentIdentity(student);
  const route = buildDefaultRouteState(student, getStudentRoute(studentId));
  const preset = resolveRoutePreset(student, route);
  const routeComponents = getRouteComponentsForPreset(preset);
  const progress = buildRouteProgress(route.completedGoalIds, preset);
  const history = Array.isArray(route.history) ? [...route.history].reverse() : [];
  const nextGoals = getNextGoalsByComponent(
    route.completedGoalIds,
    preset,
    routeComponents
  );
  const orderedGoals = [...(Array.isArray(preset?.goals) ? preset.goals : [])].sort(compareRouteGoals);
  const lastGoal = orderedGoals[orderedGoals.length - 1] || null;
  const totalSections = new Set(
    orderedGoals.map((goal) => toStringSafe(goal?.section)).filter(Boolean)
  ).size;
  const componentProgress = routeComponents.map((component) => {
    const goals = orderedGoals.filter((goal) => goal.component === component.id);
    const completed = goals.filter((goal) =>
      (route.completedGoalIds || []).includes(goal.id)
    ).length;
    const percent = goals.length ? Math.round((completed / goals.length) * 100) : 0;
    return {
      id: component.id,
      label: component.label,
      total: goals.length,
      completed,
      percent,
    };
  });
  const expanded = routeExpansionState.get(studentId) === true;
  const routeHistoryOpen = routeHistoryState.get(studentId) === true;
  const routeEditorOpen = routeEditorState.get(studentId) === true;

  return `
    <div class="route-overview">
      ${renderCurrentRouteGoals(route, preset, routeComponents, {
        canUpdateRouteProgress,
      })}

      <section class="route-overview__hero route-overview__hero--compact" ${expanded ? "" : "hidden"}>
        <div>
          <p class="route-overview__kicker">${escapeHtml(route.routeName || "Ruta de aprendizaje")}</p>
          <h3 class="route-overview__title">${escapeHtml(route.stage || "Experiencia 1")}</h3>
          <p class="route-overview__text">
            ${escapeHtml(`Resumen completo de la ruta y avance acumulado.`)}
          </p>
        </div>

        <div class="route-overview__stats">
          <article class="route-stat">
            <span class="route-stat__label">Progreso total</span>
            <strong class="route-stat__value">${escapeHtml(String(progress.percent))}%</strong>
          </article>
          <article class="route-stat">
            <span class="route-stat__label">Objetivos logrados</span>
            <strong class="route-stat__value">${escapeHtml(`${progress.completedGoals}/${progress.totalGoals}`)}</strong>
          </article>
        </div>
      </section>

      <section class="route-map" ${expanded ? "" : "hidden"}>
        ${progress.milestones
          .map(
            (milestone) => `
              <article class="route-map__step ${milestone.done ? "is-done" : milestone.unlocked ? "is-active" : ""}">
                <div class="route-map__dot"></div>
                <p class="route-map__label">Experiencia ${escapeHtml(String(milestone.experience))}</p>
                <p class="route-map__meta">${escapeHtml(`${milestone.completed}/${milestone.total} objetivos`)}</p>
              </article>
            `
          )
          .join("")}
      </section>

      <div class="route-secondary-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-route-action="toggle-route-history">
          ${routeHistoryOpen ? "Ocultar logros" : "Ver logros"}
        </button>
        ${
          canEditRouteStructure
            ? `<button type="button" class="btn btn--ghost btn--sm" data-route-action="toggle-route-editor">
                ${routeEditorOpen ? "Cerrar editor" : "Editar ruta"}
              </button>`
            : ""
        }
      </div>

      <section class="route-journey-map">
        <article class="route-history-card">
          <p class="route-history-card__title">Mapa de avance</p>
          <p class="route-overview__text">
            ${escapeHtml(
              progress.percent >= 50
                ? `¡Excelente! Ya vas en ${progress.percent}% de la ruta total.`
                : `Vas en ${progress.percent}% de la ruta. Cada logro te acerca a la meta final.`
            )}
          </p>

          <div class="route-journey-track" aria-label="Hitos de avance de la ruta">
            <div class="route-journey-track__line"></div>
            ${[
              { label: "Inicio", threshold: 0 },
              { label: "Mitad", threshold: 50 },
              { label: "Meta", threshold: 100 },
            ]
              .map(
                (step) => `
                  <article class="route-journey-node ${progress.percent >= step.threshold ? "is-reached" : ""}">
                    <span class="route-journey-node__dot" aria-hidden="true"></span>
                    <p class="route-journey-node__label">${escapeHtml(step.label)}</p>
                    <p class="route-journey-node__meta">${escapeHtml(`${step.threshold}%`)}</p>
                  </article>
                `
              )
              .join("")}
          </div>
        </article>

        <article class="route-history-card">
          <p class="route-history-card__title">Progreso por componente</p>
          <div class="route-progress-list">
            ${componentProgress
              .map(
                (item) => `
                  <div class="route-progress-item">
                    <div class="route-progress-item__head">
                      <span class="route-progress-item__label">${escapeHtml(item.label)}</span>
                      <span class="route-progress-item__value">${escapeHtml(`${item.completed}/${item.total} · ${item.percent}%`)}</span>
                    </div>
                    <div class="route-progress-item__bar">
                      <span class="route-progress-item__fill" style="width: ${item.percent}%;"></span>
                    </div>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      </section>

      <section class="route-history-grid">
        <article class="route-history-card">
          <p class="route-history-card__title">Alcance total de la ruta</p>
          <div class="route-focus-list">
            <div class="route-focus-item">
              <span class="route-focus-item__component">Tamaño de la ruta</span>
              <strong class="route-focus-item__title">${escapeHtml(`${progress.totalGoals} objetivos en ${totalSections || 1} bloques`)}</strong>
            </div>
            <div class="route-focus-item">
              <span class="route-focus-item__component">Último objetivo de referencia</span>
              <strong class="route-focus-item__title">${escapeHtml(lastGoal?.title || "No disponible")}</strong>
            </div>
          </div>
        </article>

        <article class="route-history-card">
          <p class="route-history-card__title">Siguientes focos</p>
          <div class="route-focus-list">
            ${
              nextGoals.length
                ? nextGoals
                    .map(
                      (goal) => `
                        <div class="route-focus-item">
                          <span class="route-focus-item__component">${escapeHtml(getComponentLabel(goal.component, routeComponents))}</span>
                          <strong class="route-focus-item__title">${escapeHtml(goal.title)}</strong>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="route-history-card__empty">La ruta de ejemplo ya esta completa. Podemos ampliar mas experiencias cuando quieras.</p>`
            }
          </div>
        </article>
      </section>

      <section class="route-history-grid" ${routeHistoryOpen ? "" : "hidden"}>
        <article class="route-history-card route-history-card--wide">
          <p class="route-history-card__title">Objetivos logrados</p>
          ${
            history.length
              ? `<div class="route-log-list">
                  ${history
                    .map(
                      (entry) => `
                        <article class="route-log-item">
                          <p class="route-log-item__title">${escapeHtml(entry.title || "Objetivo completado")}</p>
                          <p class="route-log-item__meta">${escapeHtml(`${getComponentLabel(entry.component, routeComponents)} · Experiencia ${entry.experience} · ${formatDisplayDate(entry.completedAt)}`)}</p>
                        </article>
                      `
                    )
                    .join("")}
                </div>`
              : `<p class="route-history-card__empty">Aun no hay logros marcados. Cuando empieces a completar objetivos, aqui quedara el historial del proceso.</p>`
          }
        </article>
      </section>

      ${canEditRouteStructure ? renderManualRouteEditor(route, preset, routeEditorOpen, access) : ""}
    </div>
  `;
}

function renderCurrentRouteGoals(route = {}, preset = {}, components = [], permissions = {}) {
  const canUpdateRouteProgress = Boolean(permissions.canUpdateRouteProgress);
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const currentByComponent = components
    .map((component) => {
      const goals = (preset?.goals || GUITAR_ROUTE_PRESET)
        .filter((goal) => goal.component === component.id)
        .sort(compareRouteGoals);
      const nextGoal = goals.find((goal) => !completedIds.has(goal.id)) || null;
      const completed = goals.filter((goal) => completedIds.has(goal.id)).length;
      return {
        component,
        nextGoal,
        completed,
        total: goals.length,
      };
    })
    .filter((item) => item.total);

  return `
    <section class="route-current">
      <header class="route-current__header">
        <div>
          <p class="route-overview__kicker">${escapeHtml(route.routeName || "Ruta de aprendizaje")}</p>
          <h3 class="route-current__title">Objetivos actuales por categoria</h3>
        </div>
        <span class="route-current__stage">${escapeHtml(route.stage || "Experiencia 1")} · ${escapeHtml(`${currentByComponent.filter((item) => item.nextGoal).length} activos`)}</span>
      </header>

      <div class="route-current__grid">
        ${
          currentByComponent.length
            ? currentByComponent
                .map(
                  ({ component, nextGoal, completed, total }) => `
                    <article class="route-current-card ${nextGoal ? "" : "is-complete"}">
                      <div class="route-current-card__head">
                        <span class="route-current-card__label">${escapeHtml(component.label)}</span>
                        <span class="route-current-card__count">${escapeHtml(`${completed}/${total}`)}</span>
                      </div>
                      ${
                        nextGoal
                          ? `
                            <label class="route-goal-check route-goal-check--compact">
                              <input
                                type="checkbox"
                                data-route-goal-check="${escapeHtml(nextGoal.id)}"
                                ${!canUpdateRouteProgress ? "disabled" : ""}
                              />
                              <span class="route-goal-check__body">
                                <span class="route-goal-check__title">${escapeHtml(nextGoal.title)}</span>
                                <span class="route-goal-check__text">${escapeHtml(nextGoal.description || "")}</span>
                                <span class="route-goal-check__meta">${escapeHtml(`Experiencia ${nextGoal.experience}`)}</span>
                              </span>
                            </label>
                          `
                          : `<p class="route-current-card__done">Categoria completada.</p>`
                      }
                    </article>
                  `
                )
                .join("")
            : `<p class="route-history-card__empty">No hay objetivos configurados para esta ruta.</p>`
        }
      </div>
    </section>
  `;
}

function renderRouteComponentCard(component, route = {}, preset, permissions = {}) {
  const canUpdateRouteProgress = Boolean(permissions.canUpdateRouteProgress);
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const goals = (preset?.goals || GUITAR_ROUTE_PRESET).filter(
    (goal) => goal.component === component.id
  );
  const sections = groupGoalsBySection(goals);
  const activeSections = sections
    .map((section) => ({
      ...section,
      nextGoal: section.goals.find((goal) => !completedIds.has(goal.id)) || null,
      completedGoals: section.goals.filter((goal) => completedIds.has(goal.id)),
    }))
    .filter((section) => section.goals.length);
  const completedGoals = goals.filter((goal) => completedIds.has(goal.id));
  const pendingSectionsCount = activeSections.filter((section) => section.nextGoal).length;

  return `
    <article class="route-component-card">
      <header class="route-component-card__header">
        <div>
          <p class="route-component-card__eyebrow">${escapeHtml(component.label)}</p>
          <h3 class="route-component-card__title">${escapeHtml(
            pendingSectionsCount
              ? `${pendingSectionsCount} categorias con avance disponible`
              : "Componente consolidado"
          )}</h3>
        </div>
        <span class="route-component-card__count">${escapeHtml(`${completedGoals.length}/${goals.length}`)}</span>
      </header>

      <div class="route-section-list">
        ${activeSections
          .map(
            (section) => `
              <details class="route-section-card" ${section.nextGoal ? "open" : ""}>
                <summary class="route-section-card__summary">
                  <span>${escapeHtml(section.label)}</span>
                  <span>${escapeHtml(`${section.completedGoals.length}/${section.goals.length}`)}</span>
                </summary>
                ${
                  section.nextGoal
                    ? `
                      <label class="route-goal-check">
                        <input
                          type="checkbox"
                          data-route-goal-check="${escapeHtml(section.nextGoal.id)}"
                          ${!canUpdateRouteProgress ? "disabled" : ""}
                        />
                        <span class="route-goal-check__body">
                          <span class="route-goal-check__title">${escapeHtml(section.nextGoal.title)}</span>
                          <span class="route-goal-check__text">${escapeHtml(section.nextGoal.description || "")}</span>
                          <span class="route-goal-check__meta">${escapeHtml(`Experiencia ${section.nextGoal.experience}`)}</span>
                        </span>
                      </label>
                    `
                    : `
                      <p class="route-component-card__done">
                        Todos los objetivos de esta categoria ya fueron logrados.
                      </p>
                    `
                }

                <div class="route-component-card__history">
                  <p class="route-component-card__history-title">Logrados en ${escapeHtml(section.label)}</p>
                  ${
                    section.completedGoals.length
                      ? section.completedGoals
                          .map(
                            (goal) => `
                              <span class="route-achievement-chip">
                                <span>${escapeHtml(goal.title)}</span>
                                ${
                                  canUpdateRouteProgress
                                    ? `
                                      <button
                                        type="button"
                                        class="route-achievement-chip__undo"
                                        data-route-goal-undo="${escapeHtml(goal.id)}"
                                        aria-label="Quitar objetivo logrado: ${escapeHtml(goal.title)}"
                                        title="Quitar logro"
                                      >
                                        ×
                                      </button>
                                    `
                                    : ""
                                }
                              </span>
                            `
                          )
                          .join("")
                      : `<span class="route-achievement-chip route-achievement-chip--muted">Aun sin logros marcados</span>`
                  }
                </div>
              </details>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderManualRouteEditor(route = {}, preset = {}, expanded = false, access = {}) {
  if (!access.canEditRouteStructure) return "";
  const goals = normalizeManualRouteGoals(route.customGoals).length
    ? normalizeManualRouteGoals(route.customGoals)
    : normalizeManualRouteGoals(preset.goals);
  const groupedGoals = groupGoalsByExperienceAndComponent(goals);
  const experienceDescriptions = normalizeExperienceDescriptions(
    route.experienceDescriptions
  );

  return `
    <section class="route-manual-editor" ${expanded ? "" : "hidden"}>
      <header class="route-manual-editor__header">
        <div>
          <p class="route-history-card__title">Editor general de ruta</p>
          <p class="route-overview__text">
            Los cambios se aplican a todos los estudiantes de esta area o instrumento.
          </p>
        </div>
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          data-route-action="save-manual-route"
        >
          Guardar ruta
        </button>
      </header>
      <div class="route-structure-builder" aria-label="Constructor visual de ruta">
        ${groupedGoals
          .map(
            (experienceGroup) => `
              <article class="route-structure-builder__experience">
                <h4 class="route-structure-builder__title">Experiencia ${escapeHtml(String(experienceGroup.experience))}</h4>
                <label class="route-structure-builder__goal">
                  <span>Descripcion general de la experiencia</span>
                  <textarea
                    data-route-experience-description
                    data-route-experience="${escapeHtml(String(experienceGroup.experience))}"
                    rows="2"
                  >${escapeHtml(experienceDescriptions[String(experienceGroup.experience)] || "")}</textarea>
                </label>
                <div class="route-structure-builder__components">
                  ${experienceGroup.components
                    .map(
                      (componentGroup) => `
                        <details class="route-structure-builder__component">
                          <summary class="route-structure-builder__component-toggle">
                            <span class="route-structure-builder__component-title">${escapeHtml(componentGroup.label)}</span>
                            <span class="route-structure-builder__component-count">${escapeHtml(`${componentGroup.goals.length} objetivos`)}</span>
                          </summary>
                          <div class="route-structure-builder__goal-list">
                            ${componentGroup.goals
                              .map(
                                (goal) => `
                                  <label class="route-structure-builder__goal">
                                    <span>Objetivo ${escapeHtml(String(goal.goalNumber || 1))}</span>
                                    <input
                                      type="text"
                                      data-route-visual-goal
                                      data-route-goal-id="${escapeHtml(goal.id)}"
                                      data-route-goal-component="${escapeHtml(goal.componentLabel || goal.component || "General")}"
                                      data-route-goal-experience="${escapeHtml(String(goal.experience || 1))}"
                                      value="${escapeHtml(goal.title)}"
                                    />
                                  </label>
                                  <label class="route-structure-builder__goal">
                                    <span>Descripcion del objetivo ${escapeHtml(String(goal.goalNumber || 1))}</span>
                                    <textarea
                                      data-route-visual-goal-description
                                      data-route-goal-id="${escapeHtml(goal.id)}"
                                      rows="2"
                                    >${escapeHtml(goal.description || "")}</textarea>
                                  </label>
                                `
                              )
                              .join("")}
                          </div>
                        </details>
                      `
                    )
                    .join("")}
                </div>
              </article>
            `
          )
          .join("")}
      </div>
      <textarea
        class="route-manual-editor__textarea"
        data-route-goals-editor
        data-route-goals-original="${escapeHtml(serializeManualRouteGoals(goals))}"
        rows="10"
        spellcheck="false"
      >${escapeHtml(serializeManualRouteGoals(goals))}</textarea>
    </section>
  `;
}

function groupGoalsByExperienceAndComponent(goals = []) {
  const orderedGoals = normalizeManualRouteGoals(goals).sort((a, b) => {
    const expDiff = Number(a.experience || 0) - Number(b.experience || 0);
    if (expDiff !== 0) return expDiff;
    const componentDiff = toStringSafe(a.componentLabel || a.component).localeCompare(
      toStringSafe(b.componentLabel || b.component)
    );
    if (componentDiff !== 0) return componentDiff;
    return Number(a.order || 0) - Number(b.order || 0);
  });
  const experienceMap = new Map();

  orderedGoals.forEach((goal, index) => {
    const experience = Number(goal.experience) || 1;
    if (!experienceMap.has(experience)) {
      experienceMap.set(experience, new Map());
    }
    const componentMap = experienceMap.get(experience);
    const componentKey = goal.component || "general";
    if (!componentMap.has(componentKey)) {
      componentMap.set(componentKey, {
        label: goal.componentLabel || getComponentLabel(componentKey),
        goals: [],
      });
    }
    componentMap.get(componentKey).goals.push({
      ...goal,
      goalNumber: index + 1,
    });
  });

  return [...experienceMap.entries()].map(([experience, componentMap]) => ({
    experience,
    components: [...componentMap.values()],
  }));
}

function getManualGoalsFromVisualEditor() {
  const inputs = Array.from(
    viewRoot?.querySelectorAll("[data-route-visual-goal]") || []
  );

  return inputs
    .map((input, index) => {
      const title = toStringSafe(input.value);
      if (!title) return null;

      const componentLabel =
        toStringSafe(input.getAttribute("data-route-goal-component")) || "General";
      const experience =
        Number(input.getAttribute("data-route-goal-experience")) || 1;
      const component = toLearningRouteComponentId(componentLabel);
      const goalId = toStringSafe(input.getAttribute("data-route-goal-id"));
      const descriptionInput = Array.from(
        viewRoot?.querySelectorAll("[data-route-visual-goal-description]") || []
      ).find(
        (item) => toStringSafe(item.getAttribute("data-route-goal-id")) === goalId
      );
      const description =
        toStringSafe(descriptionInput?.value) || `Ruta manual · ${componentLabel}`;

      return {
        id:
          goalId ||
          buildManualGoalId(component, title, index, {
            routeTemplateId: getCurrentRouteTemplateId(),
            experience,
          }),
        component,
        componentLabel,
        section: componentLabel,
        experience,
        order: index + 1,
        title,
        description,
      };
    })
    .filter(Boolean);
}

function getExperienceDescriptionsFromVisualEditor() {
  const inputs = Array.from(
    viewRoot?.querySelectorAll("[data-route-experience-description]") || []
  );

  return inputs.reduce((acc, input) => {
    const experience = Number(input.getAttribute("data-route-experience"));
    const description = toStringSafe(input.value);
    if (Number.isFinite(experience) && experience > 0 && description) {
      acc[String(experience)] = description;
    }
    return acc;
  }, {});
}

async function completeLearningGoal(student, goalId) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  if (!access.canUpdateRouteProgress) return;

  const routePreset = resolveRoutePreset(student, getStudentRoute(studentId));
  const goal = (routePreset?.goals || GUITAR_ROUTE_PRESET).find((item) => item.id === goalId);
  if (!goal) return;

  const currentRoute = buildDefaultRouteState(student, getStudentRoute(studentId));
  const completedGoalIds = new Set(currentRoute.completedGoalIds || []);
  if (completedGoalIds.has(goal.id)) return;

  completedGoalIds.add(goal.id);

  const history = Array.isArray(currentRoute.history) ? [...currentRoute.history] : [];
  history.push({
    goalId: goal.id,
    title: goal.title,
    component: goal.component,
    experience: goal.experience,
    completedAt: new Date().toISOString(),
  });

  const nextRoute = buildDefaultRouteState(student, {
    ...currentRoute,
    completedGoalIds: [...completedGoalIds],
    history,
  });

  const previousGoals = buildStudentGoalsFromRoute(currentRoute, student);
  const nextGoals = buildStudentGoalsFromRoute(nextRoute, student);

  clearAppError();
  setStudentRoute(studentId, nextRoute);
  setStudentGoals(studentId, nextGoals);

  try {
    const savedRoute = await persistLearningRouteProgress(student, nextRoute);
    setStudentRoute(studentId, savedRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(savedRoute, student));
  } catch (error) {
    console.error("Error guardando avance de la ruta:", error);
    setStudentRoute(studentId, currentRoute);
    setStudentGoals(studentId, previousGoals);
    setAppError(
      error?.message || "No se pudo guardar el avance de la ruta."
    );
  }
}

async function saveManualLearningRoute(student) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  if (!access.canEditRouteStructure) return;

  const currentRoute = buildDefaultRouteState(student, getStudentRoute(studentId));
  const routePreset = resolveRoutePreset(student, currentRoute);
  const visualGoals = getManualGoalsFromVisualEditor();
  const textarea = viewRoot?.querySelector("[data-route-goals-editor]");
  const rawManualText = textarea?.value || "";
  const originalManualText = textarea?.getAttribute("data-route-goals-original") || "";
  const manualGoals =
    rawManualText !== originalManualText
      ? parseManualRouteGoals(
          rawManualText,
          normalizeManualRouteGoals(currentRoute.customGoals).length
            ? normalizeManualRouteGoals(currentRoute.customGoals)
            : normalizeManualRouteGoals(routePreset?.goals || []),
          currentRoute.routeTemplateId
        )
      : visualGoals;
  const experienceDescriptions = getExperienceDescriptionsFromVisualEditor();

  if (!manualGoals.length) {
    setAppError("La ruta manual necesita al menos un objetivo.");
    return;
  }

  const validGoalIds = new Set(manualGoals.map((goal) => goal.id));
  const completedGoalIds = (currentRoute.completedGoalIds || []).filter((goalId) =>
    validGoalIds.has(goalId)
  );
  const history = (currentRoute.history || []).filter((entry) =>
    validGoalIds.has(toStringSafe(entry?.goalId))
  );
  const nextRoute = buildDefaultRouteState(student, {
    ...currentRoute,
    presetId: currentRoute.routeTemplateId || "ruta_manual_v1",
    routeName: currentRoute.routeName || `Ruta de aprendizaje - ${currentRoute.focusArea || "Proceso"}`,
    customGoals: manualGoals,
    experienceDescriptions,
    completedGoalIds,
    history,
  });

  const previousGoals = buildStudentGoalsFromRoute(currentRoute, student);

  clearAppError();
  setStudentRoute(studentId, nextRoute);
  setStudentGoals(studentId, buildStudentGoalsFromRoute(nextRoute, student));

  try {
    const savedRoute = await persistLearningRouteStructure(student, nextRoute);
    setStudentRoute(studentId, savedRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(savedRoute, student));
  } catch (error) {
    console.error("Error guardando ruta manual:", error);
    setStudentRoute(studentId, currentRoute);
    setStudentGoals(studentId, previousGoals);
    setAppError(error?.message || "No se pudo guardar la ruta manual.");
  }
}

async function undoLearningGoal(student, goalId) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  if (!access.canUpdateRouteProgress) return;

  const routePreset = resolveRoutePreset(student, getStudentRoute(studentId));
  const goal = (routePreset?.goals || GUITAR_ROUTE_PRESET).find((item) => item.id === goalId);
  if (!goal) return;

  const currentRoute = buildDefaultRouteState(student, getStudentRoute(studentId));
  const completedGoalIds = new Set(currentRoute.completedGoalIds || []);
  if (!completedGoalIds.has(goal.id)) return;

  completedGoalIds.delete(goal.id);

  const history = Array.isArray(currentRoute.history)
    ? currentRoute.history.filter((entry) => toStringSafe(entry?.goalId) !== goal.id)
    : [];

  const nextRoute = buildDefaultRouteState(student, {
    ...currentRoute,
    completedGoalIds: [...completedGoalIds],
    history,
  });

  const previousGoals = buildStudentGoalsFromRoute(currentRoute, student);
  const nextGoals = buildStudentGoalsFromRoute(nextRoute, student);

  clearAppError();
  setStudentRoute(studentId, nextRoute);
  setStudentGoals(studentId, nextGoals);

  try {
    const savedRoute = await persistLearningRouteProgress(student, nextRoute);
    setStudentRoute(studentId, savedRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(savedRoute, student));
  } catch (error) {
    console.error("Error quitando logro de la ruta:", error);
    setStudentRoute(studentId, currentRoute);
    setStudentGoals(studentId, previousGoals);
    setAppError(
      error?.message || "No se pudo quitar el objetivo logrado."
    );
  }
}

function toggleRouteExpanded(student, triggerButton) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const nextValue = !(routeExpansionState.get(studentId) === true);
  routeExpansionState.set(studentId, nextValue);
  if (nextValue) {
    historyExpansionState.set(studentId, false);
  }

  const routeContainer = viewRoot?.querySelector("#profile-route-content");
  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }

  applyProfileFocusLayout(student);

  if (triggerButton) {
    triggerButton.textContent = nextValue
      ? "Ocultar avance detallado"
      : "Ver avance detallado";
  }
}

function toggleRouteHistory(student) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  routeHistoryState.set(studentId, !(routeHistoryState.get(studentId) === true));
  rerenderRoutePanel(student);
}

function toggleRouteEditor(student) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  routeEditorState.set(studentId, !(routeEditorState.get(studentId) === true));
  rerenderRoutePanel(student);
}

function rerenderRoutePanel(student) {
  const routePreviewContainer = viewRoot?.querySelector("#profile-route-preview-content");
  if (routePreviewContainer) {
    routePreviewContainer.innerHTML = renderCurrentRoutePreview(student);
  }

  const routeContainer = viewRoot?.querySelector("#profile-route-content");
  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }
}

function toggleHistoryExpanded(student, triggerButton, forceOpen = false) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const nextValue = forceOpen
    ? true
    : !(historyExpansionState.get(studentId) === true);
  historyExpansionState.set(studentId, nextValue);
  if (nextValue) {
    routeExpansionState.set(studentId, false);
  }

  const historyContainer = viewRoot?.querySelector("#profile-history-content");
  if (historyContainer) {
    const state = getState();
    const bitacoras = getBitacorasFromState(student);
    historyContainer.innerHTML = renderLastBitacoraPreview(
      student,
      bitacoras,
      CONFIG,
      Boolean(state?.auth?.isAuthenticated)
    );
  }

  const allHistoryContainer = viewRoot?.querySelector("#profile-all-history-content");
  if (allHistoryContainer) {
    const state = getState();
    const bitacoras = getBitacorasFromState(student);
    allHistoryContainer.innerHTML = renderAllBitacorasPanel(
      student,
      bitacoras,
      CONFIG,
      Boolean(state?.auth?.isAuthenticated)
    );
  }

  openProfilePanel("bitacoras");

  if (triggerButton) {
    triggerButton.textContent = nextValue
      ? "Ocultar historial completo"
      : "Ver bitácoras completas";
  }
}

function applyProfileFocusLayout(student) {
  const studentId = getStudentIdentity(student);
  if (!studentId || !viewRoot) return;

  const isRouteFocus = routeExpansionState.get(studentId) === true;
  const isHistoryFocus = historyExpansionState.get(studentId) === true;

  const profileCard = viewRoot.querySelector(".profile-card");
  const profileLayout = viewRoot.querySelector(".profile-layout");
  const routePanel = viewRoot.querySelector(".route-panel");
  const profileSide = viewRoot.querySelector(".profile-side");
  const summaryCard = viewRoot.querySelector(".profile-summary");
  const historyCard = viewRoot.querySelector(".profile-history");
  const routeToggleButton = viewRoot.querySelector("[data-route-action='toggle-full']");

  if (
    !profileCard ||
    !profileLayout ||
    !routePanel ||
    !profileSide ||
    !summaryCard ||
    !historyCard
  ) {
    return;
  }

  if (isRouteFocus) {
    viewRoot.dataset.focusMode = "route";
    profileLayout.classList.add("profile-layout--route-focus");
    profileLayout.classList.remove("profile-layout--history-focus");
    profileCard.hidden = true;
    routePanel.hidden = false;
    profileSide.hidden = true;
    summaryCard.hidden = true;
    historyCard.hidden = true;
    if (routeToggleButton) routeToggleButton.textContent = "Ocultar avance detallado";
    return;
  }

  if (isHistoryFocus) {
    viewRoot.dataset.focusMode = "history";
    profileLayout.classList.remove("profile-layout--route-focus");
    profileLayout.classList.add("profile-layout--history-focus");
    profileCard.hidden = true;
    routePanel.hidden = true;
    profileSide.hidden = false;
    summaryCard.hidden = true;
    historyCard.hidden = false;
    if (routeToggleButton) routeToggleButton.textContent = "Ver avance detallado";
    return;
  }

  profileLayout.classList.remove("profile-layout--route-focus");
  profileLayout.classList.remove("profile-layout--history-focus");
  viewRoot.dataset.focusMode = "default";
  profileCard.hidden = false;
  routePanel.hidden = false;
  profileSide.hidden = false;
  summaryCard.hidden = false;
  historyCard.hidden = false;
  if (routeToggleButton) routeToggleButton.textContent = "Ver avance detallado";
}

async function reloadLearningRoute(student) {
  await ensureLearningRouteLoaded(student, { forceReload: true });

  const routePreviewContainer = viewRoot?.querySelector("#profile-route-preview-content");
  if (routePreviewContainer) {
    routePreviewContainer.innerHTML = renderCurrentRoutePreview(student);
  }

  const routeContainer = viewRoot?.querySelector("#profile-route-content");
  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }
}

function renderHistoryPreview(student, items = [], config, isAuthenticated = true) {
  if (!isAuthenticated) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Historial protegido</p>
        <p class="empty-state__text">
          Inicia sesión con Google para consultar las bitácoras de este estudiante.
        </p>
      </div>
    `;
  }

  if (!Array.isArray(items) || !items.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin bitácoras</p>
        <p class="empty-state__text">
          ${escapeHtml(
            config?.text?.emptyBitacoras ||
              "Este estudiante aún no tiene bitácoras registradas."
          )}
        </p>
        <div class="empty-state__actions">
          <button
            type="button"
            class="btn btn--primary btn--sm"
            data-history-action="open-editor"
          >
            Crear primera bitácora
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-history-action="open-full-history"
          >
            Ver bitácoras completas
          </button>
          ${
            CONFIG?.features?.allowGroupBitacoras
              ? `
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-history-action="open-group-editor"
                >
                  Crear grupal
                </button>
              `
              : ""
          }
        </div>
      </div>
    `;
  }

  const sortedItems = sortBitacorasByDate(items);
  const latestItem = sortedItems[0] || null;
  const studentId = getStudentIdentity(student);
  const expanded = studentId ? historyExpansionState.get(studentId) === true : false;
  const latestItems = expanded ? sortedItems.slice(0, 8) : latestItem ? [latestItem] : [];
  const processOptions = normalizeStudentProcesses(student);

  return `
    <div class="history-preview-list">
      ${latestItems
        .map((item) => renderHistoryCard(item, processOptions))
        .join("")}
      <div class="empty-state__actions">
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          data-history-action="toggle-full-history"
        >
          ${expanded ? "Ocultar historial completo" : "Ver bitácoras completas"}
        </button>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          data-history-action="open-editor"
        >
          Nueva bitácora
        </button>
      </div>
    </div>
  `;
}

function renderHistoryCard(item, processOptions = [], options = {}) {
  const compact = Boolean(options.compact);
  const mode = normalizeMode(item.mode);
  const overrides = normalizeStudentOverrides(
    item.studentOverrides,
    item.studentIds || []
  );
  const overridesCount = Object.keys(overrides).length;
  const teacherName = getHistoryTeacherName(item);
  const selectedProcessKey = toStringSafe(
    item?.process?.processKey || item?.processKey
  );

  return `
    <article class="history-preview-card" data-history-card>
      <header class="history-preview-card__header">
        <div>
          <h3 class="history-preview-card__title">
            ${escapeHtml(item.titulo || "Sin título")}
          </h3>
          <p class="history-preview-card__date">
            ${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}
          </p>
        </div>

        <div class="history-preview-card__meta">
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-history-action="delete-bitacora"
            data-bitacora-id="${escapeHtml(item.id || "")}"
          >
            Eliminar
          </button>
          <span class="badge">
            ${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}
          </span>
          ${
            Array.isArray(item.studentRefs) && item.studentRefs.length > 1
              ? `<span class="badge badge--soft">${escapeHtml(`${item.studentRefs.length} estudiantes`)}</span>`
              : ""
          }
          ${
            overridesCount
              ? `<span class="badge badge--soft">${escapeHtml(`${overridesCount} ajuste${overridesCount === 1 ? "" : "s"}`)}</span>`
              : ""
          }
          ${
            teacherName
              ? `<span class="badge badge--soft">${escapeHtml(`Docente: ${teacherName}`)}</span>`
              : ""
          }
        </div>
      </header>

      ${
        compact
          ? ""
          : `<div class="history-preview-card__group">
              <p class="history-preview-card__group-title">Proceso</p>
              <div class="empty-state__actions">
                <select class="field__input" data-history-process-select>
                  <option value="">Sin categorizar</option>
                  ${renderHistoryProcessOptions(processOptions, selectedProcessKey)}
                </select>
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-history-action="assign-process"
                  data-bitacora-id="${escapeHtml(item.id)}"
                >
                  Guardar proceso
                </button>
              </div>
            </div>`
      }

      ${
        Array.isArray(item.etiquetas) && item.etiquetas.length
          ? `
            <div class="history-preview-card__tags">
              ${item.etiquetas
                .map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`)
                .join("")}
            </div>
          `
          : ""
      }

      <p class="history-preview-card__text">
        ${escapeHtml(truncateText(item.contenido || "", 180))}
      </p>

      ${compact ? "" : renderHistoryOverrides(item, overrides)}

      ${
        Array.isArray(item.studentRefs) && item.studentRefs.length > 1
          ? `
            <div class="history-preview-card__group">
              <p class="history-preview-card__group-title">Incluye</p>
              <div class="history-preview-card__tags">
                ${item.studentRefs
                  .slice(0, 4)
                  .map(
                    (student) => `
                      <span class="badge badge--soft">
                        ${escapeHtml(student.name || student.id || "Estudiante")}
                      </span>
                    `
                  )
                  .join("")}
                ${
                  item.studentRefs.length > 4
                    ? `<span class="badge badge--soft">+${escapeHtml(item.studentRefs.length - 4)}</span>`
                    : ""
                }
              </div>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderHistoryProcessOptions(processes = [], selectedKey = "") {
  return (Array.isArray(processes) ? processes : [])
    .map((process) => {
      const processKey = toStringSafe(process?.processKey);
      if (!processKey) return "";

      const processLabel = toStringSafe(
        process?.label ||
          process?.detalle ||
          process?.arte ||
          process?.programa ||
          "Proceso"
      );
      const selectedAttr = processKey === selectedKey ? " selected" : "";
      return `<option value="${escapeHtml(processKey)}"${selectedAttr}>${escapeHtml(processLabel)}</option>`;
    })
    .join("");
}

function renderHistorySection(label, value, options = {}) {
  const text = toStringSafe(value);
  if (!text) return "";

  const highlightClass = options.highlight ? " teaching-history-section--highlight" : "";
  return `
    <section class="teaching-history-section${highlightClass}">
      <p class="teaching-history-section__label">${escapeHtml(label)}</p>
      <p class="teaching-history-section__value">${escapeHtml(text)}</p>
    </section>
  `;
}

function renderHistoryListSection(label, values = []) {
  const list = normalizeTags(values);
  if (!list.length) return "";

  return `
    <section class="teaching-history-section">
      <p class="teaching-history-section__label">${escapeHtml(label)}</p>
      <div class="teaching-history-card__chips">
        ${list.map((value) => `<span class="badge badge--soft">${escapeHtml(value)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderProcessAssignmentControl(item, processOptions = [], selectedProcessKey = "") {
  return `
    <details class="teaching-history-process">
      <summary>Cambiar proceso</summary>
      <div class="teaching-history-process__body">
        <select class="field__input" data-history-process-select>
          <option value="">Sin categorizar</option>
          ${renderHistoryProcessOptions(processOptions, selectedProcessKey)}
        </select>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          data-history-action="assign-process"
          data-bitacora-id="${escapeHtml(item.id)}"
        >
          Guardar proceso
        </button>
      </div>
    </details>
  `;
}

function getProcessDisplayLabel(process = {}) {
  return toStringSafe(
    process?.label ||
      process?.detalle ||
      process?.arte ||
      process?.programa ||
      process?.instrumento ||
      process?.processKey
  );
}

function getCurrentStudentOverride(item = {}, student = {}) {
  const studentIds = [
    getStudentIdentity(student),
    getStudentFallbackId(student),
    student?.id,
    student?.studentId,
    student?.studentKey,
  ]
    .map(toStringSafe)
    .filter(Boolean);
  const allowedIds = normalizeStudentIds([
    ...(item.studentIds || []),
    ...studentIds,
  ]);
  const overrides = normalizeStudentOverrides(
    item.studentOverrides || item.overrides,
    allowedIds
  );

  for (const studentId of studentIds) {
    if (overrides[studentId]) return overrides[studentId];
  }

  return null;
}

function hasStudentOverrideContent(override = null) {
  if (!override) return false;
  return Boolean(
    toStringSafe(override.tareas) ||
      normalizeTags(override.etiquetas || []).length ||
      normalizeTags(override.componenteCorporal || []).length ||
      normalizeTags(override.componenteTecnico || []).length ||
      normalizeTags(override.componenteTeorico || []).length ||
      normalizeTags(override.componenteObras || []).length
  );
}

function hasStructuredHistoryContent(structuredContent = {}) {
  return Boolean(
    toStringSafe(structuredContent.docente) ||
      toStringSafe(structuredContent.tareas) ||
      normalizeTags(structuredContent.componenteCorporal || []).length ||
      normalizeTags(structuredContent.componenteTecnico || []).length ||
      normalizeTags(structuredContent.componenteTeorico || []).length ||
      normalizeTags(structuredContent.componenteObras || []).length
  );
}

function getHistoryTeacherName(item = {}) {
  const docentes = normalizeTags(item?.docentes || item?.docente || item?.process?.docente);
  if (docentes.length) return docentes.join(", ");

  return firstNonEmpty(
    item?.process?.docente,
    item?.author?.name,
    item?.author?.displayName,
    item?.author?.email
  );
}

function renderHistoryOverrides(item, overrides = {}) {
  const entries = Object.entries(overrides || {});
  if (!entries.length) return "";

  const studentNameById = new Map(
    (Array.isArray(item?.studentRefs) ? item.studentRefs : []).map((student) => [
      toStringSafe(student?.id),
      toStringSafe(student?.name),
    ])
  );

  const rows = entries
    .map(([studentId, data]) => {
      const tarea = toStringSafe(data?.tareas);
      const componenteCorporal = Array.isArray(data?.componenteCorporal)
        ? data.componenteCorporal
        : [];
      const componenteTecnico = Array.isArray(data?.componenteTecnico)
        ? data.componenteTecnico
        : [];
      const componenteTeorico = Array.isArray(data?.componenteTeorico)
        ? data.componenteTeorico
        : [];
      const componenteObras = Array.isArray(data?.componenteObras)
        ? data.componenteObras
        : [];
      const etiquetas = Array.isArray(data?.etiquetas) ? data.etiquetas : [];
      const hasAnyComponent =
        componenteCorporal.length ||
        componenteTecnico.length ||
        componenteTeorico.length ||
        componenteObras.length ||
        etiquetas.length;
      if (!tarea && !hasAnyComponent) return "";

      const studentName =
        studentNameById.get(toStringSafe(studentId)) ||
        toStringSafe(studentId) ||
        "Estudiante";

      return `
        <div class="history-preview-card__group">
          <p class="history-preview-card__group-title">Ajustes de ${escapeHtml(studentName)}</p>
          ${
            tarea
              ? `
                <p class="history-preview-card__group-title">Tareas/observaciones</p>
                <p class="history-preview-card__text">${escapeHtml(truncateText(tarea, 240))}</p>
              `
              : ""
          }
          ${renderOverrideSection("Componente corporal", componenteCorporal)}
          ${renderOverrideSection("Componente técnico", componenteTecnico)}
          ${renderOverrideSection("Componente teórico", componenteTeorico)}
          ${renderOverrideSection("Componente de obras", componenteObras)}
          ${renderOverrideSection("Complementario", etiquetas)}
        </div>
      `;
    })
    .filter(Boolean)
    .join("");

  if (!rows) return "";

  return `
    <section class="history-preview-card__overrides">
      ${rows}
    </section>
  `;
}

function renderOverrideSection(label, values = []) {
  if (!Array.isArray(values) || !values.length) return "";

  return `
    <p class="history-preview-card__group-title">${escapeHtml(label)}</p>
    <div class="history-preview-card__tags">
      ${values
        .map((value) => `<span class="badge badge--soft">${escapeHtml(value)}</span>`)
        .join("")}
    </div>
  `;
}

function syncAcademicRecordFromHistory(student, items = []) {
  const academicRecordId =
    resolveStudentAcademicRecordIdFromBitacoras(student, items);
  if (
    !academicRecordId ||
    academicRecordId === getStudentAcademicRecordId(student)
  ) {
    return;
  }

  const nextStudent = {
    ...student,
    academicRecordId,
  };
  updateStudentProfile(nextStudent);
  setSelectedStudent(nextStudent);
}

async function ensureStudentBitacorasLoaded(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  const currentItems = getBitacorasFromState(student);
  if (currentItems.length > 0) return;

  setBitacorasLoading(true);

  try {
    // Traemos todo el historial del estudiante. El filtro por proceso se resuelve
    // en UI para no perder registros importados que aún no traen processKey.
    const linkedStudentIds = getStudentLinkedIds(student);
    const response = await getBitacorasByStudentIds(linkedStudentIds);
    const items = normalizeBitacorasResponse(response);

    linkedStudentIds.forEach((linkedStudentId) => {
      setBitacorasForStudent(linkedStudentId, items);
    });
    syncAcademicRecordFromHistory(student, items);
  } catch (error) {
    console.error("Error cargando bitácoras en profile:", error);
    setAppError(
      error?.message || "No se pudo cargar el historial del estudiante."
    );
  } finally {
    setBitacorasLoading(false);
  }
}

async function reloadHistory(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  setBitacorasLoading(true);

  try {
    clearAppError();

    // Mismo criterio que en la carga inicial: no filtrar por processKey en API.
    const linkedStudentIds = getStudentLinkedIds(student);
    const response = await getBitacorasByStudentIds(linkedStudentIds);
    const items = normalizeBitacorasResponse(response);

    linkedStudentIds.forEach((linkedStudentId) => {
      setBitacorasForStudent(linkedStudentId, items);
    });
    syncAcademicRecordFromHistory(student, items);
  } catch (error) {
    console.error("Error recargando historial en profile:", error);
    setAppError(error?.message || "No se pudo recargar el historial.");
  } finally {
    setBitacorasLoading(false);
  }
}

async function assignProcessToBitacora(student, bitacoraId, processKey = "") {
  const safeBitacoraId = toStringSafe(bitacoraId);
  if (!safeBitacoraId) return;

  try {
    clearAppError();

    const currentItem = await getBitacoraById(safeBitacoraId);
    if (!currentItem) {
      throw new Error("No se encontró la bitácora para actualizar su proceso.");
    }

    const safeProcessKey = toStringSafe(processKey);
    const processOptions = normalizeStudentProcesses(student);
    const selectedProcess = safeProcessKey
      ? resolveStudentProcess(student, safeProcessKey) ||
        processOptions.find(
          (process) => toStringSafe(process?.processKey) === safeProcessKey
        ) ||
        null
      : null;
    const currentProcess = currentItem?.process || {};

    const nextProcess = selectedProcess
      ? {
          processKey:
            toStringSafe(selectedProcess?.processKey) || safeProcessKey,
          processLabel: toStringSafe(
            selectedProcess?.label ||
              selectedProcess?.detalle ||
              selectedProcess?.arte
          ),
          area: toStringSafe(selectedProcess?.arte || selectedProcess?.area),
          modalidad: toStringSafe(selectedProcess?.modalidad),
          docente: toStringSafe(
            firstNonEmpty(
              currentProcess?.docente,
              currentItem?.author?.name,
              student?.docente,
              student?.teacher
            )
          ),
          sede: toStringSafe(selectedProcess?.sede),
          programa: toStringSafe(
            selectedProcess?.programa || selectedProcess?.instrumento
          ),
        }
      : {
          processKey: "",
          processLabel: "",
          area: "",
          modalidad: "",
          docente: toStringSafe(
            firstNonEmpty(
              currentProcess?.docente,
              currentItem?.author?.name,
              student?.docente,
              student?.teacher
            )
          ),
          sede: "",
          programa: "",
        };

    await updateBitacora(safeBitacoraId, {
      process: nextProcess,
      metadata: {
        ...(currentItem?.metadata || {}),
        manualProcessAssignment: true,
        manualProcessAssignedAt: new Date().toISOString(),
      },
    });

    await reloadHistory(student);
    renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
  } catch (error) {
    console.error("No se pudo actualizar el proceso de la bitácora:", error);
    setAppError(
      error?.message || "No se pudo guardar el proceso de la bitácora."
    );
  }
}

async function handleDeleteBitacoraFromProfile(student, bitacoraId) {
  const safeBitacoraId = toStringSafe(bitacoraId);
  if (!safeBitacoraId) return;

  const source = getBitacorasFromState(student).find(
    (item) => toStringSafe(item.id || item.bitacoraId) === safeBitacoraId
  );
  const title = source?.titulo || source?.title || "esta bitacora";
  const dateLabel = formatDisplayDate(source?.fechaClase || source?.createdAt);
  const confirmed = window.confirm(
    [
      "Estas seguro de eliminar esta bitacora?",
      "",
      title ? `Bitacora: ${title}` : "",
      dateLabel ? `Fecha: ${dateLabel}` : "",
      "",
      "Esta accion no se puede deshacer.",
    ]
      .filter((line) => line !== "")
      .join("\n")
  );

  if (!confirmed) return;

  setBitacorasLoading(true);

  try {
    const deleted = await deleteBitacora(safeBitacoraId);
    const relatedStudentIds = normalizeStudentIds(
      deleted?.studentIds || source?.studentIds || [getStudentIdentity(student)]
    );

    relatedStudentIds.forEach((id) => {
      removeBitacoraForStudent(id, safeBitacoraId);
    });

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId) {
      removeBitacoraForStudent(fallbackId, safeBitacoraId);
    }

    renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
  } catch (error) {
    console.error("Error eliminando bitacora:", error);
    setAppError(error?.message || "No se pudo eliminar la bitacora.");
  } finally {
    setBitacorasLoading(false);
  }
}

function isAdminUser(currentUser) {
  return resolveUserAccess(currentUser).role === CONFIG.roles.admin;
}

function openTextBitacorasImportModal(student) {
  if (!isAdminUser(getState()?.auth?.user)) {
    setAppError("Solo un administrador puede importar bitácoras desde texto.");
    return;
  }

  const existing = document.querySelector("[data-text-bitacoras-modal]");
  if (existing) existing.remove();

  const modalRoot = document.createElement("div");
  modalRoot.className = "text-bitacoras-modal-root";
  modalRoot.setAttribute("data-text-bitacoras-modal", "true");
  modalRoot.innerHTML = renderTextBitacorasImportModal();
  document.body.appendChild(modalRoot);

  const close = () => modalRoot.remove();
  const textarea = modalRoot.querySelector("#text-bitacoras-input");
  const fileInput = modalRoot.querySelector("#text-bitacoras-file");
  const processSelect = modalRoot.querySelector("#text-bitacoras-process");
  const preview = modalRoot.querySelector("#text-bitacoras-preview");
  const status = modalRoot.querySelector("#text-bitacoras-status");
  const progress = modalRoot.querySelector("[data-text-import-progress]");
  const progressBar = modalRoot.querySelector("[data-text-import-progress-bar]");
  const progressLabel = modalRoot.querySelector("[data-text-import-progress-label]");
  const saveBtn = modalRoot.querySelector("[data-text-import-save]");
  const analyzeBtn = modalRoot.querySelector("[data-text-import-analyze]");
  const clearBtn = modalRoot.querySelector("[data-text-import-clear]");
  const allowDuplicates = modalRoot.querySelector("#text-bitacoras-allow-duplicates");
  let parsedItems = [];

  const setStatus = (message = "", type = "info") => {
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
  };
  const setProgress = ({ current = 0, total = 0, created = 0, skipped = 0, visible = true } = {}) => {
    const percent = total ? Math.round((current / total) * 100) : 0;
    if (progress) progress.hidden = !visible;
    if (progressBar) {
      progressBar.style.width = `${percent}%`;
      progressBar.setAttribute("aria-valuenow", String(percent));
    }
    if (progressLabel) {
      progressLabel.textContent = total
        ? `${current} de ${total} procesadas · ${created} creadas · ${skipped} omitidas`
        : "";
    }
  };

  const analyze = () => {
    const context = getTextImportContext(student, processSelect?.value || "");
    parsedItems = parseBitacorasFromImportText(textarea?.value || "", context);
    preview.innerHTML = renderTextImportPreview(parsedItems);
    const ready = parsedItems.filter((item) => item.canSave).length;
    const blocked = parsedItems.length - ready;
    setStatus(
      parsedItems.length
        ? `${ready} listas para guardar. ${blocked} con advertencias o errores.`
        : "No se detectaron bitácoras. Pega bloques con Fecha: o filas de Sheets/CSV.",
      parsedItems.length && ready ? "success" : "warning"
    );
    saveBtn.disabled = !ready;
    setProgress({ visible: false });
  };

  analyzeBtn?.addEventListener("click", analyze);
  fileInput?.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    const text = await readTextImportFiles(files);
    if (text && textarea) {
      textarea.value = [textarea.value, text].filter(Boolean).join("\n\n");
      setStatus(`${files.length} archivo(s) cargado(s). Revisa y analiza el contenido.`, "info");
    }
    fileInput.value = "";
  });
  clearBtn?.addEventListener("click", () => {
    textarea.value = "";
    if (fileInput) fileInput.value = "";
    parsedItems = [];
    preview.innerHTML = "";
    saveBtn.disabled = true;
    setStatus("");
    setProgress({ visible: false });
  });
  modalRoot.querySelectorAll("[data-text-import-cancel]").forEach((button) => {
    button.addEventListener("click", close);
  });
  modalRoot.addEventListener("click", (event) => {
    if (event.target === modalRoot.querySelector(".text-bitacoras-modal-backdrop")) {
      close();
    }
  });
  saveBtn?.addEventListener("click", async () => {
    const result = await saveImportedBitacoras(student, parsedItems, {
      allowDuplicates: Boolean(allowDuplicates?.checked),
      setStatus,
      setProgress,
      setBusy: (isBusy) => {
        [saveBtn, analyzeBtn, clearBtn, allowDuplicates, textarea].forEach((node) => {
          if (node) node.disabled = Boolean(isBusy);
        });
      },
    });
    preview.innerHTML = renderTextImportPreview(parsedItems);
    setStatus(`${result.created} bitácoras creadas. ${result.skipped} omitidas por errores.`, "success");
    setProgress({
      current: result.created + result.skipped,
      total: result.created + result.skipped,
      created: result.created,
      skipped: result.skipped,
      visible: true,
    });
    saveBtn.disabled = true;
  });

  textarea?.focus();
}

function renderTextBitacorasImportModal() {
  return `
    <div class="text-bitacoras-modal-backdrop"></div>
    <section class="text-bitacoras-modal" role="dialog" aria-modal="true" aria-labelledby="text-bitacoras-title">
      <header class="text-bitacoras-modal__header">
        <div>
          <p class="panel-header__eyebrow">Importación administrativa</p>
          <h2 class="panel-header__title" id="text-bitacoras-title">Agregar bitácoras desde texto</h2>
          <p class="section-text">Pega texto de documento o filas copiadas/exportadas desde Sheets.</p>
        </div>
        <button type="button" class="btn btn--ghost btn--sm" data-text-import-cancel>Cancelar</button>
      </header>

      <label class="field text-bitacoras-modal__process">
        <span class="field__label">Proceso para asociar estas bitácoras</span>
        <select id="text-bitacoras-process" class="field__input">
          ${renderTextImportProcessOptions()}
        </select>
        <small class="field__hint">Todas las bitácoras importadas quedarán asociadas a este proceso.</small>
      </label>

      <label class="field">
        <span class="field__label">Texto de bitácoras antiguas o datos de Sheets</span>
        <textarea
          id="text-bitacoras-input"
          class="field__textarea text-bitacoras-modal__textarea"
          rows="14"
          placeholder="Documento: Fecha: ...&#10;&#10;Sheets: Fecha&#9;Docente&#9;Estudiante&#9;Tareas..."
        ></textarea>
      </label>

      <label class="field">
        <span class="field__label">Subir archivo de texto o Sheets</span>
        <input
          id="text-bitacoras-file"
          class="field__input"
          type="file"
          accept=".txt,.csv,.tsv,text/plain,text/csv,text/tab-separated-values"
          multiple
        />
        <small class="field__hint">Acepta .txt, .csv o .tsv. Para Google Docs o Word, copia el texto aquí o exporta como .txt.</small>
      </label>

      <label class="choice-pill text-bitacoras-modal__check">
        <input type="checkbox" id="text-bitacoras-allow-duplicates" />
        <span>Crear aunque existan posibles duplicados</span>
      </label>

      <div class="text-bitacoras-modal__actions">
        <button type="button" class="btn btn--ghost" data-text-import-analyze>Analizar texto</button>
        <button type="button" class="btn btn--primary" data-text-import-save disabled>Guardar bitácoras</button>
        <button type="button" class="btn btn--ghost" data-text-import-clear>Limpiar</button>
        <button type="button" class="btn btn--secondary" data-text-import-cancel>Cancelar</button>
      </div>

      <p class="text-bitacoras-modal__status" id="text-bitacoras-status" role="status"></p>
      <div class="text-bitacoras-progress" data-text-import-progress hidden>
        <div
          class="text-bitacoras-progress__bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
        >
          <span data-text-import-progress-bar></span>
        </div>
        <p class="text-bitacoras-progress__label" data-text-import-progress-label></p>
      </div>
      <div class="text-bitacoras-preview" id="text-bitacoras-preview"></div>
    </section>
  `;
}

function renderTextImportProcessOptions() {
  const student = getStudentFromState(getState(), currentProfileStudentKey);
  const processOptions = normalizeStudentProcesses(student);
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    processOptions[0] ||
    null;
  const activeKey = toStringSafe(activeProcess?.processKey);

  return [
    `<option value="">Selecciona un proceso</option>`,
    ...processOptions.map((process) => {
      const processKey = toStringSafe(process?.processKey);
      const processLabel = toStringSafe(
        process?.label || process?.detalle || process?.arte || "Proceso"
      );
      return `<option value="${escapeHtml(processKey)}"${processKey === activeKey ? " selected" : ""}>${escapeHtml(processLabel)}</option>`;
    }),
  ].join("");
}

function getTextImportContext(student, selectedProcessKey = "") {
  const safeProcessKey = toStringSafe(selectedProcessKey);
  const activeProcess = safeProcessKey
    ? resolveStudentProcess(student, safeProcessKey)
    : null;

  return {
    student,
    studentId: getStudentIdentity(student),
    allStudents: getAllStudents(),
    process: activeProcess,
    existingBitacoras: getBitacorasFromState(student),
  };
}

async function readTextImportFiles(files = []) {
  const readableFiles = (Array.isArray(files) ? files : []).filter(Boolean);
  const chunks = [];

  for (const file of readableFiles) {
    const name = toStringSafe(file?.name).toLowerCase();
    const type = toStringSafe(file?.type).toLowerCase();
    const canReadAsText =
      /\.(txt|csv|tsv)$/.test(name) ||
      type.includes("text/") ||
      type.includes("csv") ||
      type.includes("tab-separated");

    if (!canReadAsText) continue;
    chunks.push(await file.text());
  }

  return chunks.join("\n\n");
}

function parseBitacorasFromImportText(rawText, context = {}) {
  const text = String(rawText || "");
  const sheetItems = parseBitacorasFromSheetText(text, context);
  if (sheetItems.length) return sheetItems;
  return parseBitacorasFromPlainText(text, context);
}

function parseBitacorasFromSheetText(rawText, context = {}) {
  const text = String(rawText || "");
  const rows = splitDelimitedRows(text);
  if (!shouldParseAsSheetText(text, rows)) return [];

  const parsedRows = parseBitacoraSheetText(text).items.filter((row) =>
    Boolean(row.fechaClase || row.docente || row.content || row.tags?.length)
  );
  const seenImportFingerprints = new Set();

  return parsedRows.map((row, index) => {
    const parsed = mapSheetRowToTextImport(row);
    const matched = resolveSheetImportStudents(row, context);
    parsed.linkedStudents = matched.linkedStudents;
    parsed.unresolvedStudents = matched.unresolvedStudents;
    parsed.importedStudentNames = row.estudianteNombres || [];
    const payload = buildImportedBitacoraPayload(parsed, context, index);
    const validation = validateImportedBitacora(payload, context);
    const duplicate = findImportedDuplicate(payload, context.existingBitacoras || []);
    const repeatedInImport = markImportDuplicate(payload, seenImportFingerprints);
    const warnings = [...validation.warnings];

    if (matched.unresolvedStudents.length) {
      warnings.push(`No se encontraron: ${matched.unresolvedStudents.join(", ")}`);
    }
    if (matched.linkedStudents.length > 1) {
      warnings.push(`Se guardará como grupal (${matched.linkedStudents.length} estudiantes)`);
    } else if (row.estudianteNombres?.length) {
      const linkedName = getStudentName(matched.linkedStudents[0] || context.student);
      const mentionedName = row.estudianteNombres[0] || "";
      if (normalizeText(mentionedName) && normalizeText(mentionedName) !== normalizeText(linkedName)) {
        warnings.push(`La fila menciona: ${row.estudianteNombres.join(", ")}`);
      }
    }
    if (duplicate) warnings.push("Posible duplicado");
    if (repeatedInImport) warnings.push("Duplicado dentro del texto pegado");

    return {
      index,
      raw: JSON.stringify(row),
      payload,
      warnings,
      errors: validation.errors,
      duplicate: duplicate || repeatedInImport,
      canSave: !validation.errors.length && !repeatedInImport,
      saved: false,
    };
  });
}

function shouldParseAsSheetText(text = "", rows = []) {
  if (!Array.isArray(rows) || !rows.length) return false;
  if (String(text || "").includes("\t")) {
    return rows.length > 1 || (rows[0] || []).filter((cell) => toStringSafe(cell)).length >= 4;
  }

  const firstRow = rows[0] || [];
  if (firstRow.length < 2) return false;

  const normalizedHeaders = firstRow.map((cell) =>
    normalizeImportLabel(cell) || normalizeHeaderName(cell)
  );
  const knownHeaders = new Set([
    "fechaClase",
    "docente",
    "tareas",
    "comentariosyrecursos",
    "comentarios",
    "recursos",
    "etiquetas",
    "componenteCorporal",
    "componenteTecnico",
    "componenteTeorico",
    "componenteObras",
    "estudiante",
    "alumno",
    "student",
    "nombreestudiante",
    "content",
    "contenido",
    "apuntes",
  ]);

  return normalizedHeaders.filter((header) => knownHeaders.has(header)).length >= 2;
}

function mapSheetRowToTextImport(row = {}) {
  const attachments = [
    ...normalizeLinkList(row.imagenes).map((url, index) => ({
      name: `Imagen importada ${index + 1}`,
      url,
      type: "image/link",
    })),
    ...normalizeLinkList(row.videos).map((url, index) => ({
      name: `Video importado ${index + 1}`,
      url,
      type: "video/link",
    })),
  ];

  return {
    fechaClase: row.fechaClase || "",
    docente: row.docente || "",
    mode: CONFIG.modes.individual,
    etiquetas: normalizeTags([
      ...(Array.isArray(row.tags) ? row.tags : [row.tags]),
      ...(Array.isArray(row.componenteComplementario)
        ? row.componenteComplementario
        : [row.componenteComplementario]),
    ]),
    tareas: row.content || "",
    componenteCorporal: row.componenteCorporal || [],
    componenteTecnico: row.componenteTecnico || [],
    componenteTeorico: row.componenteTeorico || [],
    componenteObras: row.componenteObras || [],
    attachments,
  };
}

function resolveSheetImportStudents(row = {}, context = {}) {
  const currentStudent = context.student || {};
  const currentStudentId = context.studentId || getStudentIdentity(currentStudent);
  const currentFallback = currentStudentId ? [currentStudent] : [];
  const studentNames = normalizeTags(row.estudianteNombres || []);

  if (!studentNames.length) {
    return {
      linkedStudents: currentFallback,
      unresolvedStudents: [],
    };
  }

  const students = Array.isArray(context.allStudents) ? context.allStudents : [];
  const index = new Map();
  const searchableStudents = [];

  students.forEach((student) => {
    const id = getStudentIdentity(student);
    const name = getStudentName(student);
    const normalized = normalizeText(name);
    if (!id || !normalized) return;
    if (!index.has(normalized)) index.set(normalized, student);
    searchableStudents.push({ student, id, normalized });
  });

  const linkedStudents = [];
  const unresolvedStudents = [];
  const seenIds = new Set();

  studentNames.forEach((name) => {
    const normalized = normalizeText(name);
    if (!normalized) return;
    const matched = index.get(normalized) || findLooseStudentMatch(normalized, searchableStudents);
    if (!matched) {
      unresolvedStudents.push(name);
      return;
    }
    const id = getStudentIdentity(matched);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    linkedStudents.push(matched);
  });

  if (!linkedStudents.length && currentStudentId) {
    linkedStudents.push(currentStudent);
  }

  return {
    linkedStudents,
    unresolvedStudents: [...new Set(unresolvedStudents)],
  };
}

function findLooseStudentMatch(normalizedName = "", searchableStudents = []) {
  if (!normalizedName || normalizedName.length < 5) return null;
  const matches = searchableStudents.filter(({ normalized }) => {
    if (!normalized || normalized.length < 5) return false;
    return normalized === normalizedName || normalized.includes(normalizedName) || normalizedName.includes(normalized);
  });

  return matches.length === 1 ? matches[0].student : null;
}

function parseBitacorasFromPlainText(rawText, context = {}) {
  const blocks = splitTextBitacoraBlocks(rawText);
  const seenImportFingerprints = new Set();

  return blocks.map((block, index) => {
    const parsed = parseTextBitacoraBlock(block);
    const payload = buildImportedBitacoraPayload(parsed, context, index);
    const validation = validateImportedBitacora(payload, context);
    const duplicate = findImportedDuplicate(payload, context.existingBitacoras || []);
    const repeatedInImport = markImportDuplicate(payload, seenImportFingerprints);
    const warnings = [...validation.warnings];

    if (duplicate) warnings.push("Posible duplicado");
    if (repeatedInImport) warnings.push("Duplicado dentro del texto pegado");

    return {
      index,
      raw: block,
      payload,
      warnings,
      errors: validation.errors,
      duplicate: duplicate || repeatedInImport,
      canSave: !validation.errors.length && !repeatedInImport,
      saved: false,
    };
  });
}

function markImportDuplicate(payload = {}, seen = new Set()) {
  const fingerprint = buildImportFingerprint(payload);
  if (!fingerprint) return false;
  if (seen.has(fingerprint)) return true;
  seen.add(fingerprint);
  return false;
}

function buildImportFingerprint(payload = {}) {
  const studentIds = normalizeTags(payload.studentIds || [payload.studentId]);
  const structured = parseStructuredContent(payload.content || payload.contenido || "");
  const components = normalizeTags([
    ...(payload.tags || payload.etiquetas || []),
    ...structured.componenteCorporal,
    ...structured.componenteTecnico,
    ...structured.componenteTeorico,
    ...structured.componenteObras,
  ]).sort();

  return JSON.stringify({
    fechaClase: normalizeLocalDateInput(payload.fechaClase || payload.fecha || ""),
    studentIds: studentIds.sort(),
    processKey: toStringSafe(payload.processKey || payload.process?.processKey),
    docente: normalizeText(payload.docente || payload.process?.docente),
    tareas: normalizeText(structured.tareas || payload.content || payload.contenido),
    components,
  });
}

function splitTextBitacoraBlocks(rawText = "") {
  const blocks = [];
  let current = [];

  String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line) => {
      if (/^\s*Fecha\s*:/i.test(line) && current.some((item) => item.trim())) {
        blocks.push(current.join("\n"));
        current = [line];
        return;
      }
      current.push(line);
    });

  if (current.some((item) => item.trim())) blocks.push(current.join("\n"));
  return blocks.filter((block) => /^\s*Fecha\s*:/im.test(block));
}

function parseTextBitacoraBlock(block = "") {
  const result = {
    fechaClase: "",
    docente: "",
    mode: CONFIG.modes.individual,
    etiquetas: [],
    tareas: "",
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
  };
  let activeKey = "";

  String(block || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      const normalizedLabel = match ? normalizeImportLabel(match[1]) : "";

      if (normalizedLabel) {
        activeKey = normalizedLabel;
        appendImportedValue(result, activeKey, match[2] || "");
        return;
      }

      if (activeKey) appendImportedValue(result, activeKey, trimmed);
    });

  result.etiquetas = normalizeTags(result.etiquetas);
  result.componenteCorporal = splitCommaValues(result.componenteCorporal);
  result.componenteTecnico = splitCommaValues(result.componenteTecnico);
  result.componenteTeorico = splitCommaValues(result.componenteTeorico);
  result.componenteObras = splitCommaValues(result.componenteObras);
  result.fechaClase = normalizeDateToISO(result.fechaClase);

  return result;
}

function appendImportedValue(target, key, value) {
  const safeValue = toStringSafe(value);
  if (!safeValue) return;

  if (key === "fechaClase") {
    target.fechaClase = safeValue;
    return;
  }
  if (key === "mode") {
    target.mode = /grupal/i.test(safeValue) ? CONFIG.modes.group : CONFIG.modes.individual;
    return;
  }
  if (key === "docente") {
    target.docente = [target.docente, safeValue].filter(Boolean).join(" ");
    return;
  }
  if (key === "tareas") {
    target.tareas = [target.tareas, safeValue].filter(Boolean).join("\n");
    return;
  }

  target[key] = [...(Array.isArray(target[key]) ? target[key] : []), ...splitCommaValues(safeValue)];
}

function normalizeDateToISO(value = "") {
  const safeValue = toStringSafe(value);
  let match = safeValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return [match[1], match[2].padStart(2, "0"), match[3].padStart(2, "0")].join("-");
  }

  match = safeValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return "";

  return [match[3], match[2].padStart(2, "0"), match[1].padStart(2, "0")].join("-");
}

function normalizeImportLabel(label = "") {
  const normalized = normalizeText(label).replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");

  if (compact === "fecha") return "fechaClase";
  if (compact === "tipo") return "mode";
  if (compact === "docente") return "docente";
  if (["categorias", "categoria", "tags", "etiquetas"].includes(compact)) return "etiquetas";
  if (["tareasobservaciones", "tareas", "observaciones"].includes(compact)) return "tareas";
  if (compact === "componentecorporal") return "componenteCorporal";
  if (compact === "componentetecnico") return "componenteTecnico";
  if (compact === "componenteteorico") return "componenteTeorico";
  if (
    [
      "componentedeobra",
      "componentedeobras",
      "cancionesobras",
      "cancion",
      "canciones",
      "obra",
      "obras",
    ].includes(compact)
  ) {
    return "componenteObras";
  }

  return "";
}

function splitCommaValues(value = "") {
  const source = Array.isArray(value) ? value : [value];
  return normalizeTags(
    source.flatMap((item) =>
      String(item || "")
        .split(",")
        .map((part) => part.trim())
    )
  );
}

function buildImportedBitacoraPayload(parsed, context = {}, index = 0) {
  const student = context.student || {};
  const linkedStudents = normalizeImportedLinkedStudents(parsed.linkedStudents, student);
  const primaryStudent = linkedStudents[0] || student;
  const studentId = getStudentIdentity(primaryStudent) || context.studentId || getStudentIdentity(student);
  const process = context.process || null;
  const withCategories = applyAutomaticCategoriesFromWorks({
    ...parsed,
    content: buildImportedStructuredContent(parsed),
  });
  const docente = toStringSafe(parsed.docente || process?.docente || primaryStudent?.docente || primaryStudent?.teacher);
  const studentIds = normalizeStudentIds(linkedStudents.map((item) => getStudentIdentity(item))).filter(Boolean);
  const studentRefs = studentIds.map((id) => {
    const matchedStudent = linkedStudents.find((item) => getStudentIdentity(item) === id) || {};
    return {
      id,
      name: getStudentName(matchedStudent) || id,
    };
  });
  const isGroup = studentIds.length > 1;

  return {
    mode: isGroup || parsed.mode === CONFIG.modes.group ? CONFIG.modes.group : CONFIG.modes.individual,
    studentId,
    studentKey: primaryStudent.studentKey || studentId,
    studentIds: studentIds.length ? studentIds : [studentId].filter(Boolean),
    studentRefs: studentRefs.length ? studentRefs : [{ id: studentId, name: getStudentName(primaryStudent) }],
    primaryStudentId: studentId,
    title: `${isGroup ? "Bitácora grupal" : "Bitácora"} ${formatDisplayDate(parsed.fechaClase) || index + 1}`,
    content: buildImportedStructuredContent({
      ...parsed,
      docente,
    }),
    tags: withCategories.etiquetas || withCategories.tags || [],
    etiquetas: withCategories.etiquetas || withCategories.tags || [],
    fechaClase: parsed.fechaClase,
    docentes: docente ? [docente] : [],
    docente,
    archivos: parsed.attachments || [],
    attachments: parsed.attachments || [],
    studentOverrides: {},
    processKey: process?.processKey || "",
    process: {
      processKey: process?.processKey || "",
      processLabel: firstNonEmpty(process?.label, process?.detalle, process?.arte),
      area: firstNonEmpty(process?.arte, primaryStudent.area, primaryStudent.programa, primaryStudent.instrumento),
      modalidad: firstNonEmpty(primaryStudent.modalidad),
      docente,
      sede: firstNonEmpty(primaryStudent.sede),
      programa: firstNonEmpty(process?.detalle, process?.label, primaryStudent.programa, primaryStudent.area),
    },
    source: "plain-text-import",
    metadata: {
      importedFromPlainText: true,
      importedAsGroup: isGroup,
      importedStudentCount: studentIds.length,
      unresolvedStudents: parsed.unresolvedStudents || [],
      importedAt: new Date().toISOString(),
    },
  };
}

function normalizeImportedLinkedStudents(linkedStudents = [], fallbackStudent = {}) {
  const normalized = [];
  const seenIds = new Set();

  (Array.isArray(linkedStudents) ? linkedStudents : []).forEach((student) => {
    const id = getStudentIdentity(student);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    normalized.push(student);
  });

  if (!normalized.length && getStudentIdentity(fallbackStudent)) {
    normalized.push(fallbackStudent);
  }

  return normalized;
}

function buildImportedStructuredContent(fields = {}) {
  return [
    fields.docente ? `DOCENTE: ${toStringSafe(fields.docente)}` : "",
    fields.tareas ? `TAREAS / OBSERVACIONES: ${toStringSafe(fields.tareas)}` : "",
    splitCommaValues(fields.componenteCorporal).length
      ? `COMPONENTE CORPORAL: ${splitCommaValues(fields.componenteCorporal).join(", ")}`
      : "",
    splitCommaValues(fields.componenteTecnico).length
      ? `COMPONENTE TECNICO: ${splitCommaValues(fields.componenteTecnico).join(", ")}`
      : "",
    splitCommaValues(fields.componenteTeorico).length
      ? `COMPONENTE TEORICO: ${splitCommaValues(fields.componenteTeorico).join(", ")}`
      : "",
    splitCommaValues(fields.componenteObras).length
      ? `COMPONENTE DE OBRAS: ${splitCommaValues(fields.componenteObras).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validateImportedBitacora(bitacora, context = {}) {
  const errors = [];
  const warnings = [];

  if (!bitacora.fechaClase) errors.push("Falta fecha válida");
  if (!normalizeStudentIds(bitacora.studentIds || [bitacora.studentId]).length) {
    errors.push("Falta estudiante asociado");
  }
  if (!bitacora.processKey) errors.push("Selecciona un proceso para asociar estas bitácoras.");
  if (!hasImportedContent(bitacora)) errors.push("No tiene contenido pedagógico para guardar");
  const unresolvedStudents = normalizeTags(bitacora.metadata?.unresolvedStudents || []);
  if (unresolvedStudents.length) {
    errors.push(`Faltan estudiantes por asociar: ${unresolvedStudents.join(", ")}`);
  }

  return { errors, warnings };
}

function hasImportedContent(bitacora = {}) {
  const structured = parseStructuredContent(bitacora.content || bitacora.contenido || "");
  return Boolean(
    normalizeTags(bitacora.tags || bitacora.etiquetas).length ||
      toStringSafe(structured.tareas) ||
      normalizeTags(structured.componenteCorporal).length ||
      normalizeTags(structured.componenteTecnico).length ||
      normalizeTags(structured.componenteTeorico).length ||
      normalizeTags(structured.componenteObras).length
  );
}

function findImportedDuplicate(payload, existingItems = []) {
  const targetStudent = new Set(normalizeStudentIds(payload.studentIds || [payload.studentId]));
  const targetDate = normalizeLocalDateInput(payload.fechaClase);
  const targetProcess = toStringSafe(payload.processKey || payload.process?.processKey);
  const targetTeacher = normalizeText(payload.docente || payload.process?.docente);

  return (existingItems || []).find((item) => {
    const itemStudents = normalizeStudentIds(item.studentIds || [item.studentId]);
    if (!itemStudents.some((id) => targetStudent.has(id))) return false;
    if (normalizeLocalDateInput(item.fechaClase) !== targetDate) return false;
    if (toStringSafe(item.processKey || item.process?.processKey) !== targetProcess) return false;
    const itemTeacher = normalizeText(item.docente || item.process?.docente || item.teacher);
    return !targetTeacher || !itemTeacher || itemTeacher === targetTeacher;
  });
}

function renderTextImportPreview(items = []) {
  if (!items.length) return "";

  return items
    .map((item) => {
      const payload = item.payload || {};
      const structured = parseStructuredContent(payload.content || "");
      const status = item.errors.length
        ? "No se guardará por errores"
        : item.warnings.length
        ? "Tiene advertencias"
        : "Lista para guardar";

      return `
        <article class="text-bitacoras-preview-card">
          <header class="text-bitacoras-preview-card__header">
            <div>
              <p class="teaching-history-card__date">${escapeHtml(formatDisplayDate(payload.fechaClase))}</p>
              <h3 class="teaching-history-card__title">${escapeHtml(payload.title || "Bitácora importada")}</h3>
            </div>
            <span class="badge ${item.errors.length ? "badge--danger" : item.warnings.length ? "badge--soft" : ""}">
              ${escapeHtml(status)}
            </span>
          </header>
          ${payload.docente ? `<p class="text-bitacoras-preview-card__line"><strong>Docente:</strong> ${escapeHtml(payload.docente)}</p>` : ""}
          ${renderPreviewList("Estudiantes asociados", (payload.studentRefs || []).map((studentRef) => studentRef.name || studentRef.id))}
          ${renderPreviewList("Categorías detectadas", payload.etiquetas)}
          ${structured.tareas ? `<p class="text-bitacoras-preview-card__line"><strong>Tareas/Observaciones:</strong> ${escapeHtml(structured.tareas)}</p>` : ""}
          ${renderPreviewList("Componentes detectados", [
            ...structured.componenteCorporal,
            ...structured.componenteTecnico,
            ...structured.componenteTeorico,
          ])}
          ${renderPreviewList("Canciones/obras detectadas", structured.componenteObras)}
          ${renderPreviewList("Adjuntos detectados", (payload.attachments || []).map((attachment) => attachment.name || attachment.url))}
          ${item.warnings.length ? `<p class="text-bitacoras-preview-card__warning">${escapeHtml(item.warnings.join(". "))}</p>` : ""}
          ${item.errors.length ? `<p class="text-bitacoras-preview-card__error">${escapeHtml(item.errors.join(". "))}</p>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderPreviewList(label, values = []) {
  const normalized = normalizeTags(values);
  if (!normalized.length) return "";
  return `
    <div class="text-bitacoras-preview-card__chips">
      <strong>${escapeHtml(label)}:</strong>
      ${normalized.map((value) => `<span class="badge badge--soft">${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
}

async function saveImportedBitacoras(student, items = [], options = {}) {
  if (!isAdminUser(getState()?.auth?.user)) {
    setAppError("Solo un administrador puede importar bitácoras desde texto.");
    return { created: 0, skipped: items.length };
  }

  const allowDuplicates = Boolean(options.allowDuplicates);
  const total = items.length;
  let created = 0;
  let skipped = 0;
  let processed = 0;
  options.setBusy?.(true);
  options.setStatus?.("Guardando...", "info");
  options.setProgress?.({ current: 0, total, created, skipped, visible: true });
  setBitacorasLoading(true);

  try {
    for (const item of items) {
      if (!item.canSave || (item.duplicate && !allowDuplicates)) {
        skipped += 1;
        processed += 1;
        options.setProgress?.({ current: processed, total, created, skipped, visible: true });
        continue;
      }

      const saved = await createBitacora(item.payload);
      const normalized = normalizeBitacorasResponseShared([saved])[0] || saved;
      normalizeStudentIds(normalized.studentIds || item.payload.studentIds).forEach((studentId) => {
        addBitacoraForStudent(studentId, normalized);
      });
      const fallbackId = getStudentFallbackId(student);
      if (fallbackId) addBitacoraForStudent(fallbackId, normalized);
      item.saved = true;
      created += 1;
      processed += 1;
      options.setProgress?.({ current: processed, total, created, skipped, visible: true });
    }
  } finally {
    setBitacorasLoading(false);
    options.setBusy?.(false);
    await reloadHistory(student);
    renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
  }

  return { created, skipped };
}

function getBitacorasFromState(studentOrRef) {
  const selectedProcess =
    studentOrRef && typeof studentOrRef === "object"
      ? resolveStudentProcess(studentOrRef, currentProfileProcessKey)
      : null;
  const studentRef =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentIdentity(studentOrRef)
      : toStringSafe(studentOrRef);
  const fallbackId =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentFallbackId(studentOrRef)
      : "";

  const applyProcessFilter = (items = []) => {
    const safeProcessKey = toStringSafe(currentProfileProcessKey);
    const selectedDetail = normalizeText(
      selectedProcess?.detalle || selectedProcess?.label || ""
    );

    const filtered = items.filter((item) => {
      if (isGroupBitacoraForStudent(item, studentRef, fallbackId)) {
        return true;
      }

      const itemProcessKey = toStringSafe(
        item?.process?.processKey || item?.processKey
      );

      if (safeProcessKey && itemProcessKey) {
        return itemProcessKey === safeProcessKey;
      }

      if (!selectedDetail) return true;

      const itemDetails = [
        item?.process?.processLabel,
        item?.process?.label,
        item?.process?.programa,
        item?.process?.detalle,
        item?.process?.area,
      ]
        .flatMap((value) => String(value || "").split(/,|;|\n/g))
        .map((value) => normalizeText(value))
        .filter(Boolean);

      // Mantenemos visibles los registros sin proceso para permitir categorización manual.
      if (!itemProcessKey && !itemDetails.length) {
        return true;
      }

      return itemDetails.includes(selectedDetail);
    });

    return filtered;
  };

  const selectedItems = getSelectedStudentBitacoras();
  if (Array.isArray(selectedItems) && selectedItems.length) {
    return sortBitacorasByDate(
      applyProcessFilter(selectedItems.map(normalizeBitacora).filter(Boolean))
    );
  }

  const state = getState();
  const candidates = [
    state?.bitacoras?.byStudentId?.[studentRef],
    state?.bitacoras?.itemsByStudentId?.[studentRef],
    state?.bitacoras?.byStudent?.[studentRef],
    fallbackId ? state?.bitacoras?.byStudentId?.[fallbackId] : null,
    fallbackId ? state?.bitacoras?.itemsByStudentId?.[fallbackId] : null,
    fallbackId ? state?.bitacoras?.byStudent?.[fallbackId] : null,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return sortBitacorasByDate(
        applyProcessFilter(candidate.map(normalizeBitacora).filter(Boolean))
      );
    }
  }

  return [];
}

function isGroupBitacoraForStudent(item = {}, studentRef = "", fallbackId = "") {
  const studentIds = normalizeStudentIds(item.studentIds || [item.studentId]);
  const studentRefs = normalizeStudentRefs(item.studentRefs || []);
  const safeStudentRef = toStringSafe(studentRef);
  const safeFallbackId = toStringSafe(fallbackId);
  const belongsToStudent =
    (safeStudentRef && studentIds.includes(safeStudentRef)) ||
    (safeFallbackId && studentIds.includes(safeFallbackId));
  const isGroup =
    item.mode === CONFIG.modes.group ||
    studentIds.length > 1 ||
    studentRefs.length > 1;

  return Boolean(isGroup && belongsToStudent);
}

function normalizeBitacorasResponse(response) {
  return normalizeBitacorasResponseShared(response, normalizeBitacora);
}

function normalizeBitacora(item) {
  if (!item || typeof item !== "object") return null;

  const fallbackId =
    item.id ||
    item.bitacoraId ||
    item._id ||
    `${item.fechaClase || item.createdAt || "bitacora"}-${
      item.titulo || item.title || "sin-titulo"
    }`;

  return {
    ...item,
    id: String(fallbackId),
    mode: normalizeMode(item.mode || item.modo || CONFIG.modes.individual),
    titulo: repairVisibleText(item.titulo || item.title || "Bitácora sin título"),
    contenido: repairVisibleText(item.contenido || item.content || ""),
    etiquetas: normalizeTags(item.etiquetas || item.tags || []).map(repairVisibleText),
    docentes: normalizeTags(item.docentes || item.docente || item.process?.docente).map(repairVisibleText),
    docente: repairVisibleText(firstNonEmpty(item.docente, item.process?.docente)),
    fechaClase: normalizeLocalDateInput(item.fechaClase || item.fecha || item.classDate || ""),
    studentIds: normalizeStudentIds(item.studentIds || [item.studentId]),
    studentRefs: normalizeStudentRefs(item.studentRefs || []),
    studentOverrides: normalizeStudentOverrides(
      item.studentOverrides || item.overrides,
      normalizeStudentIds(item.studentIds || [item.studentId])
    ),
    process: item.process || {},
    processKey:
      toStringSafe(item?.process?.processKey) ||
      toStringSafe(item?.processKey),
    createdAt:
      item.createdAt || item.created_at || item.fechaRegistro || "",
  };
}

function normalizeStudentOverrides(overrides = {}, allowedStudentIds = []) {
  const next = {};
  const allowedIds = new Set(normalizeStudentIds(allowedStudentIds));

  Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(
    ([studentId, value]) => {
      const safeStudentId = toStringSafe(studentId);
      if (!safeStudentId || (allowedIds.size && !allowedIds.has(safeStudentId))) {
        return;
      }

      const source = value && typeof value === "object" ? value : {};
    const normalized = {
      enabled: Boolean(source.enabled),
      tareas: repairVisibleText(source.tareas),
      etiquetas: normalizeTags(source.etiquetas || []).map(repairVisibleText),
      componenteCorporal: normalizeTags(source.componenteCorporal || []).map(repairVisibleText),
      componenteTecnico: normalizeTags(source.componenteTecnico || []).map(repairVisibleText),
      componenteTeorico: normalizeTags(source.componenteTeorico || []).map(repairVisibleText),
      componenteObras: normalizeTags(source.componenteObras || []).map(repairVisibleText),
    };

      if (
        !normalized.enabled &&
        !normalized.tareas &&
        !normalized.etiquetas.length &&
        !normalized.componenteCorporal.length &&
        !normalized.componenteTecnico.length &&
        !normalized.componenteTeorico.length &&
        !normalized.componenteObras.length
      ) {
        return;
      }

      next[safeStudentId] = normalized;
    }
  );

  return next;
}

function repairVisibleText(value) {
  let text = toStringSafe(value);
  if (!text) return "";

  if (/[\u00c3\u00c2]/.test(text)) {
    try {
      text = decodeURIComponent(escape(text));
    } catch (error) {
      // Si el navegador no puede recodificarlo, caemos al mapa puntual.
    }
  }

  return text
    .replaceAll("Bit\ufffdcora", "Bitácora")
    .replaceAll("bit\ufffdcora", "bitácora")
    .replaceAll("M\ufffdSICA", "MÚSICA")
    .replaceAll("M\ufffdsica", "Música")
    .replaceAll("m\ufffdsica", "música")
    .replaceAll("Viol\ufffdn", "Violín")
    .replaceAll("viol\ufffdn", "violín")
    .replaceAll("T\ufffdcnico", "Técnico")
    .replaceAll("t\ufffdcnico", "técnico")
    .replaceAll("Te\ufffdrico", "Teórico")
    .replaceAll("te\ufffdrico", "teórico");
}

function parseStructuredContent(content = "") {
  const text = repairVisibleText(content);
  if (!text.trim()) {
    return {
      docente: "",
      tareas: "",
      componenteCorporal: [],
      componenteTecnico: [],
      componenteTeorico: [],
      componenteObras: [],
    };
  }

  const markers = [
    ["DOCENTE", "docente"],
    ["TAREAS / OBSERVACIONES", "tareas"],
    ["COMPONENTE CORPORAL", "componenteCorporal"],
    ["COMPONENTE TECNICO", "componenteTecnico"],
    ["COMPONENTE TEORICO", "componenteTeorico"],
    ["COMPONENTE DE OBRAS", "componenteObras"],
  ];

  const result = {
    docente: "",
    tareas: text.trim(),
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
  };
  const upperText = text.toUpperCase();
  const hasStructuredMarkers = markers.some(([label]) =>
    upperText.includes(`${label}:`)
  );

  if (!hasStructuredMarkers) return result;

  result.tareas = "";

  markers.forEach(([label, key]) => {
    const startToken = `${label}:`;
    const start = upperText.indexOf(startToken);
    if (start === -1) return;

    const contentStart = start + startToken.length;
    let end = text.length;

    markers.forEach(([nextLabel]) => {
      const nextToken = `${nextLabel}:`;
      const nextStart = upperText.indexOf(nextToken, contentStart);
      if (nextStart !== -1 && nextStart < end) {
        end = nextStart;
      }
    });

    const value = text.slice(contentStart, end).trim();
    if (key === "docente" || key === "tareas") {
      result[key] = value;
    } else {
      // Los items se separan por salto de linea (no por coma): sus nombres
      // pueden contener comas (p. ej. "... sistema 1, compas 01").
      result[key] = [
        ...new Set(
          value
            .split(/\n/g)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ];
    }
  });

  return result;
}

/**
 * Se deja local a propósito:
 * la versión string original NO deduplicaba, y no vale la pena meter
 * un cambio sutil de comportamiento en este archivo.
 */
function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Se deja local para respetar exactamente el criterio previo:
 * ordena por fechaClase o createdAt, sin meter updatedAt como fallback.
 */
function sortBitacorasByDate(items = []) {
  return [...items].sort((a, b) => {
    const dateA = getTimestamp(a.fechaClase || a.createdAt);
    const dateB = getTimestamp(b.fechaClase || b.createdAt);
    return dateB - dateA;
  });
}

function getLatestBitacora(items = []) {
  const sorted = sortBitacorasByDate(items);
  return sorted[0] || null;
}

function getStudentFromState(state, preferredStudentRef = null) {
  const selectedRef =
    preferredStudentRef ||
    state?.students?.selected?.studentKey ||
    state?.students?.selected?.id ||
    state?.search?.selectedStudentId ||
    getSelectedStudentId() ||
    null;

  if (!selectedRef) {
    return state?.students?.selected || null;
  }

  return (
    findStudentInCollections(state, selectedRef) ||
    state?.students?.selected ||
    null
  );
}

function renderProfileItem(label, value) {
  return `
    <div class="profile-grid__item">
      <dt class="profile-grid__label">${escapeHtml(label)}</dt>
      <dd class="profile-grid__value">${escapeHtml(String(value ?? ""))}</dd>
    </div>
  `;
}

function renderBadge(value) {
  if (!value) return "";
  return `<span class="badge">${escapeHtml(String(value))}</span>`;
}

function renderMissingStudent() {
  return `
    <section class="view-shell view-shell--profile-missing">
      <div class="card empty-state-card">
        <p class="view-eyebrow">Perfil</p>
        <h1 class="view-title">No hay estudiante seleccionado</h1>
        <p class="view-description">
          Vuelve a busqueda y selecciona un estudiante para abrir su perfil.
        </p>
        <div class="empty-state-card__actions">
          <button
            type="button"
            class="btn btn--primary"
            id="profile-missing-back-btn"
          >
            Ir a búsqueda
          </button>
        </div>
      </div>
    </section>
  `;
}

function goToSearch() {
  if (typeof currentNavigateTo !== "function") return;
  currentNavigateTo(CONFIG.routes.search);
}

function goToEditor(student, extraPayload = {}) {
  if (typeof currentNavigateTo !== "function" || !student) return;

  currentNavigateTo(CONFIG.routes.editor, {
    id: student.id,
    studentId: student.id,
    studentKey: student.studentKey || student.id,
    ...extraPayload,
  });
}

function truncateText(text, maxLength = 180) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
  currentProfileStudentKey = null;
  currentProfileProcessKey = "";
  historyExpansionState = new Map();
}

function renderProcessSelectOptions(processes = [], activeKey = "") {
  return (Array.isArray(processes) ? processes : [])
    .map((process) => {
      const processKey = toStringSafe(process?.processKey);
      const processLabel = toStringSafe(
        process?.label || process?.detalle || process?.arte || "Proceso"
      );
      const selectedAttr = processKey === activeKey ? " selected" : "";

      return `<option value="${escapeHtml(processKey)}"${selectedAttr}>${escapeHtml(processLabel)}</option>`;
    })
    .join("");
}

function getRequestedProcessFromPayload(payload) {
  return toStringSafe(payload?.processKey || payload?.processRef || payload?.process);
}
