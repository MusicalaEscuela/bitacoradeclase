// js/views/profile.view.js

import { CONFIG } from "../config.js";
import { canViewStudent, resolveUserAccess } from "../authz.js";
import {
  getState,
  getSelectedStudentId,
  getSelectedStudentBitacoras,
  getStudentGoals,
  getStudentRoute,
  setAppError,
  clearAppError,
  setBitacorasForStudent,
  setBitacorasLoading,
  setProfileLoading,
  setSelectedStudent,
  setStudentGoals,
  setStudentProfile,
  setStudentRoute,
} from "../state.js";
import { getBitacorasByStudent } from "../api/bitacoras.api.js";
import { getStudentProfile } from "../api/students.api.js";
import {
  getStudentRouteRecord,
  saveStudentRouteRecord,
} from "../api/student-routes.api.js";
import {
  escapeHtml,
  firstNonEmpty,
  formatDisplayDate,
  getReadableValue,
  getStudentDocument,
  getStudentFallbackId,
  getStudentIdentity,
  getStudentName,
  getStudentProcessesSummary,
  normalizeStudentProcesses,
  resolveStudentProcess,
  getTimestamp,
  normalizeBitacorasResponse as normalizeBitacorasResponseShared,
  normalizeMode,
  normalizeText,
  normalizeStudentIds,
  normalizeStudentRefs,
  resolveStudentRefFromPayload,
  findStudentInCollections,
  toStringSafe,
} from "../utils/shared.js";

let viewRoot = null;
let unsubscribeView = null;
let currentNavigateTo = null;
let currentSubscribe = null;
let currentProfileStudentKey = null;
let currentProfileProcessKey = "";
let historyExpansionState = new Map();

const ROUTE_COMPONENTS = Object.freeze([
  { id: "corporal", label: "Componente corporal" },
  { id: "tecnico", label: "Componente tecnico" },
  { id: "teorico", label: "Componente teorico" },
  { id: "obras", label: "Componente de obras" },
  { id: "repertorio", label: "Componente repertorio" },
]);

const ROUTE_EXPERIENCES = Object.freeze([1, 2, 3]);

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
            { nombre: "Gimnasia dactilar individuales", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
            { nombre: "Gimnasia dactilar dobles", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
            { nombre: "Gimnasia dactilar intermedios", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
            { nombre: "Gimnasia dactilar alternados", tipo: "progressive", niveles: Array.from({ length: 20 }, (_, i) => i + 1) },
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

export async function beforeEnter({ payload, navigateTo } = {}) {
  clearAppError();

  let state = getState();
  const access = resolveUserAccess(state?.auth?.user);
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const requestedProcessRef = getRequestedProcessFromPayload(payload);
  const fallbackSelectedId = getSelectedStudentId();
  const selectedStudentRef =
    access.role === CONFIG.roles.student
      ? access.linkedStudentId || fallbackSelectedId || null
      : requestedStudentRef || fallbackSelectedId || null;

  let student = getStudentFromState(state, selectedStudentRef);

  if (!student && access.role === CONFIG.roles.student && selectedStudentRef) {
    student = await ensureStudentLoadedForProfile(selectedStudentRef);
    state = getState();
  }

  if (!student || !canViewStudent(state?.auth?.user, getStudentIdentity(student))) {
    setAppError("No hay estudiante seleccionado.");
    if (access.role !== CONFIG.roles.student && typeof navigateTo === "function") {
      navigateTo(CONFIG.routes.search);
    }
    return;
  }

  currentProfileStudentKey = getStudentIdentity(student);
  currentProfileProcessKey =
    resolveStudentProcess(student, requestedProcessRef)?.processKey || "";
  if (access.role !== CONFIG.roles.student) {
    await ensureStudentBitacorasLoaded(student);
  }
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
  const access = resolveUserAccess(safeState?.auth?.user);
  const requestedStudentRef =
    access.role === CONFIG.roles.student
      ? access.linkedStudentId
      : resolveStudentRefFromPayload(payload);
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

  root.innerHTML = buildProfileMarkup(student, safeState, safeConfig);

  bindProfileEvents(student);
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

function buildProfileMarkup(student, state, config) {
  const bitacoras = getBitacorasFromState(student);
  const isAuthenticated = Boolean(state?.auth?.isAuthenticated);
  const access = resolveUserAccess(state?.auth?.user);
  const isStudentView = access.role === CONFIG.roles.student;
  const studentId = getStudentIdentity(student);
  const routeExpanded = studentId ? routeExpansionState.get(studentId) === true : false;
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
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Perfil del estudiante</h1>
          <p class="view-description">
            Revisa la informacion principal del estudiante, su ruta de
            aprendizaje y las ultimas bitacoras desde una sola vista.
          </p>
        </div>

        <div class="view-header__actions">
          <label class="field field--compact">
            <span class="field__label">Proceso activo</span>
            <select id="profile-process-select" class="field__input">
              ${renderProcessSelectOptions(processOptions, activeProcessKey)}
            </select>
          </label>
          <button
            type="button"
            class="btn btn--ghost"
            id="profile-back-btn"
          >
            Volver a búsqueda
          </button>
          <button
            type="button"
            class="btn btn--primary"
            id="profile-open-editor-btn"
          >
            Abrir editor
          </button>
        </div>
      </header>

      <section class="profile-layout">
        <div class="profile-main">
          <article class="card profile-card">
            <header class="profile-card__header">
              <div class="profile-card__identity">
                <p class="profile-card__eyebrow">Estudiante seleccionado</p>
                <h2 class="profile-card__name">${escapeHtml(getStudentName(student))}</h2>
                <p class="profile-card__doc">${escapeHtml(getStudentDocument(student) || "Sin documento")}</p>
              </div>

              <div class="profile-card__badges" id="profile-badges">
                ${renderStudentBadges(student)}
              </div>
            </header>

            <dl class="profile-grid" id="profile-grid">
              ${renderProfileGrid(student)}
            </dl>
          </article>

          <section class="card route-panel">
            <header class="panel-header route-panel__header">
              <div class="panel-header__content">
                <p class="panel-header__eyebrow">Ruta</p>
                <h2 class="panel-header__title">Ruta de aprendizaje</h2>
                <p class="panel__description">
                  Proceso actual: <strong>${escapeHtml(activeProcessLabel)}</strong>. Resumen del estado actual y objetivos en curso.
                </p>
              </div>
              <div class="panel-header__actions">
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-route-action="toggle-full"
                >
                  ${routeExpanded ? "Ocultar ruta completa" : "Ver ruta completa"}
                </button>
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-route-action="refresh-route"
                >
                  Recargar ruta
                </button>
              </div>
            </header>

            <div id="profile-route-content">
              ${renderLearningRoute(student)}
            </div>
          </section>
        </div>

        <aside class="profile-side">
          <section class="card profile-summary">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Resumen</p>
                <h2 class="panel-header__title">Vista rápida</h2>
              </div>
            </header>

            <div id="profile-summary-content">
              ${renderSummary(student, bitacoras)}
            </div>
          </section>

          <section class="card profile-history">
            <header class="panel-header profile-history__header">
              <div>
                <p class="panel-header__eyebrow">Historial</p>
                <h2 class="panel-header__title">Última bitácora (${escapeHtml(activeProcessLabel)})</h2>
              </div>

              <button
                type="button"
                class="btn btn--ghost btn--sm"
                id="profile-refresh-history-btn"
              >
                Recargar
              </button>
            </header>

            <div id="profile-history-content">
              ${renderHistoryPreview(student, bitacoras, config, isAuthenticated)}
            </div>
          </section>
        </aside>
      </section>
    </section>
  `;
}

function bindProfileEvents(student) {
  if (!viewRoot) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  const isStudentView = access.role === CONFIG.roles.student;

  const backBtn = viewRoot.querySelector("#profile-back-btn");
  const openEditorBtn = viewRoot.querySelector("#profile-open-editor-btn");
  const refreshBtn = viewRoot.querySelector("#profile-refresh-history-btn");
  const historyContainer = viewRoot.querySelector("#profile-history-content");
  const routeContainer = viewRoot.querySelector("#profile-route-content");
  const processSelect = viewRoot.querySelector("#profile-process-select");

  if (isStudentView) {
    backBtn?.remove();
    openEditorBtn?.remove();
    refreshBtn?.remove();

    if (historyContainer) {
      historyContainer.innerHTML = renderStudentHistoryLocked();
    }
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

  if (processSelect) {
    processSelect.addEventListener("change", async () => {
      currentProfileProcessKey = toStringSafe(processSelect.value);
      await Promise.all([reloadHistory(student), reloadLearningRoute(student)]);
      renderReactiveBlocks(getState(), CONFIG, currentProfileStudentKey);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await reloadHistory(student);
    });
  }

  if (historyContainer) {
    historyContainer.addEventListener("click", (event) => {
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

      if (action === "open-group-editor") {
        goToEditor(student, { mode: CONFIG.modes.group });
        return;
      }

      if (action === "toggle-full-history") {
        toggleHistoryExpanded(student, actionButton);
      }
    });
  }

  viewRoot.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-route-action]");
    if (!actionButton) return;

    const action = actionButton.getAttribute("data-route-action");
    if (action === "toggle-full") {
      toggleRouteExpanded(student, actionButton);
      return;
    }

    if (action === "refresh-route") {
      await reloadLearningRoute(student);
    }
  });

  if (routeContainer) {
    routeContainer.addEventListener("change", async (event) => {
      const checkbox = event.target.closest("[data-route-goal-check]");
      if (!checkbox) return;

      const goalId = checkbox.getAttribute("data-route-goal-check");
      if (!goalId || !checkbox.checked) return;

      await completeLearningGoal(student, goalId);
    });
  }
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
  const routeContainer = viewRoot.querySelector("#profile-route-content");
  const titleNode = viewRoot.querySelector(".profile-card__name");
  const docNode = viewRoot.querySelector(".profile-card__doc");
  const gridNode = viewRoot.querySelector("#profile-grid");
  const badgesNode = viewRoot.querySelector("#profile-badges");

  const bitacoras = getBitacorasFromState(student);

  if (titleNode) {
    titleNode.textContent = getStudentName(student);
  }

  if (docNode) {
    docNode.textContent = getStudentDocument(student) || "Sin documento";
  }

  if (badgesNode) {
    badgesNode.innerHTML = renderStudentBadges(student);
  }

  if (gridNode) {
    gridNode.innerHTML = renderProfileGrid(student);
  }

  if (summaryContainer) {
    summaryContainer.innerHTML = renderSummary(student, bitacoras);
  }

  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }

  if (historyContainer) {
    const access = resolveUserAccess(state?.auth?.user);
    historyContainer.innerHTML =
      access.role === CONFIG.roles.student
        ? renderStudentHistoryLocked()
        : renderHistoryPreview(
            student,
            bitacoras,
            config,
            Boolean(state?.auth?.isAuthenticated)
          );
  }

  applyProfileFocusLayout(student);
}

function renderStudentHistoryLocked() {
  return `
    <div class="empty-state">
      <p class="empty-state__title">Historial no disponible</p>
      <p class="empty-state__text">
        Por ahora este perfil de estudiante muestra solo la informacion general.
      </p>
    </div>
  `;
}

function renderStudentBadges(student) {
  return `
    ${renderBadge(student.estado)}
    ${renderBadge(student.modalidad)}
    ${renderBadge(student.area || student.instrumento || student.programa)}
    ${renderBadge(student.sede)}
  `;
}

function renderProfileGrid(student) {
  return `
    ${renderProfileItem("Estado", getReadableValue(student.estado))}
    ${renderProfileItem("Edad", getReadableValue(student.edad || student.age))}
    ${renderProfileItem("Fecha de nacimiento", getReadableValue(student.fechaNacimiento || student.birthDate))}
    ${renderProfileItem("Procesos", getReadableValue(getStudentProcessesSummary(student), "Sin procesos registrados"))}
    ${renderProfileItem("Área / instrumento", getReadableValue(student.area || student.instrumento || student.programa))}
    ${renderProfileItem("Modalidad", getReadableValue(student.modalidad))}
    ${renderProfileItem("Docente", getReadableValue(student.docente || student.teacher))}
    ${renderProfileItem("Sede", getReadableValue(student.sede))}
    ${renderProfileItem("Acudiente", getReadableValue(student.acudiente || student.responsable))}
    ${renderProfileItem("Teléfono", getReadableValue(student.telefono || student.phone))}
    ${renderProfileItem("Correo", getReadableValue(student.correo || student.email))}
    ${renderProfileItem("Dirección", getReadableValue(student.direccion || student.address))}
    ${renderProfileItem("Intereses", getReadableValue(student.interesesMusicales || student.intereses))}
    ${renderProfileItem("Observaciones", getReadableValue(student.observaciones || student.notes, "Sin observaciones"))}
  `;
}

function renderSummary(student, bitacoras = []) {
  const lastBitacora = getLatestBitacora(bitacoras);
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
    });
    const currentMatchesActiveProcess =
      toStringSafe(currentRoute?.processKey || "") === activeProcessKey;
    const baseRoute =
      persistedRoute || (currentMatchesActiveProcess ? currentRoute : {});
    const nextRoute = buildDefaultRouteState(student, baseRoute);

    setStudentRoute(studentId, nextRoute);
    setStudentGoals(studentId, buildStudentGoalsFromRoute(nextRoute, student));

    if (!persistedRoute && access.canEditRoutes) {
      const savedRoute = await persistLearningRoute(student, nextRoute);
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

async function persistLearningRoute(student, route) {
  const studentId = getStudentIdentity(student);
  if (!studentId) {
    throw new Error("No se pudo resolver el estudiante para guardar la ruta.");
  }

  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const savedRoute = await saveStudentRouteRecord(studentId, route, {
    student,
    processKey: currentProfileProcessKey || "",
    processLabel: activeProcess?.label || "",
  });
  return buildDefaultRouteState(student, savedRoute);
}

function normalizeArtKey(student) {
  const activeProcess =
    resolveStudentProcess(student, currentProfileProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const rawValue = firstNonEmpty(
    activeProcess?.arte,
    activeProcess?.detalle,
    activeProcess?.label,
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
  const routeComponents = getRouteComponentsForPreset(preset);
  const presetGoalIds = new Set(preset.goals.map((goal) => goal.id));
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
    presetId: preset.id,
    routeName: preset.routeName,
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

  return components.map(({ id }) =>
    safePreset.goals.find(
      (goal) => goal.component === id && !completed.has(goal.id)
    )
  ).filter(Boolean);
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

function renderLearningRoute(student) {
  const access = resolveUserAccess(getState()?.auth?.user);
  const canEditRoute = access.canEditRoutes;
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
  const orderedGoals = [...(Array.isArray(preset?.goals) ? preset.goals : [])].sort(
    (a, b) => {
      const expDiff = Number(a?.experience || 0) - Number(b?.experience || 0);
      if (expDiff !== 0) return expDiff;
      return Number(a?.order || 0) - Number(b?.order || 0);
    }
  );
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
  const currentGoals = nextGoals.slice(0, 2);
  const expanded = routeExpansionState.get(studentId) === true;

  return `
    <div class="route-overview">
      <section class="route-overview__hero route-overview__hero--compact">
        <div>
          <p class="route-overview__kicker">${escapeHtml(route.routeName || "Ruta de aprendizaje")}</p>
          <h3 class="route-overview__title">${escapeHtml(route.stage || "Experiencia 1")}</h3>
          <p class="route-overview__text">
            ${escapeHtml(
              `Experiencia actual: ${route.stage || "Experiencia 1"} · Objetivos actuales: ${currentGoals.length ? currentGoals.map((goal) => goal.title).join(" / ") : "Ruta base completada"}`
            )}
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

      <section class="route-components" ${expanded ? "" : "hidden"}>
        ${routeComponents.map((component) =>
          renderRouteComponentCard(component, route, preset, canEditRoute)
        ).join("")}
      </section>

      <section class="route-journey-map" ${expanded ? "" : "hidden"}>
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

      <section class="route-history-grid" ${expanded ? "" : "hidden"}>
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
          <p class="route-history-card__title">Logros recientes</p>
          ${
            history.length
              ? `<div class="route-log-list">
                  ${history
                    .slice(0, 8)
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
    </div>
  `;
}

function renderRouteComponentCard(component, route = {}, preset, canEditRoute = false) {
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const goals = (preset?.goals || GUITAR_ROUTE_PRESET).filter(
    (goal) => goal.component === component.id
  );
  const nextGoal = goals.find((goal) => !completedIds.has(goal.id)) || null;
  const completedGoals = goals.filter((goal) => completedIds.has(goal.id));

  return `
    <article class="route-component-card">
      <header class="route-component-card__header">
        <div>
          <p class="route-component-card__eyebrow">${escapeHtml(component.label)}</p>
          <h3 class="route-component-card__title">${escapeHtml(
            nextGoal ? `Objetivo activo: ${nextGoal.title}` : "Componente consolidado"
          )}</h3>
        </div>
        <span class="route-component-card__count">${escapeHtml(`${completedGoals.length}/${goals.length}`)}</span>
      </header>

      ${
        nextGoal
          ? `
            <label class="route-goal-check">
              <input
                type="checkbox"
                data-route-goal-check="${escapeHtml(nextGoal.id)}"
                ${!canEditRoute ? "disabled" : ""}
              />
              <span class="route-goal-check__body">
                <span class="route-goal-check__title">${escapeHtml(nextGoal.title)}</span>
                <span class="route-goal-check__text">${escapeHtml(nextGoal.description || "")}</span>
                <span class="route-goal-check__meta">${escapeHtml(`Experiencia ${nextGoal.experience}`)}</span>
              </span>
            </label>
          `
          : `
            <p class="route-component-card__done">
              Todos los objetivos base de este componente ya fueron logrados.
            </p>
          `
      }

      <div class="route-component-card__history">
        <p class="route-component-card__history-title">Logrados</p>
        ${
          completedGoals.length
            ? completedGoals
                .map(
                  (goal) => `
                    <span class="route-achievement-chip">
                      ${escapeHtml(goal.title)}
                    </span>
                  `
                )
                .join("")
            : `<span class="route-achievement-chip route-achievement-chip--muted">Aun sin logros marcados</span>`
        }
      </div>
    </article>
  `;
}

async function completeLearningGoal(student, goalId) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  if (!access.canEditRoutes) return;

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
    const savedRoute = await persistLearningRoute(student, nextRoute);
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
      ? "Volver al perfil"
      : "Ver ruta completa";
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
    historyContainer.innerHTML = renderHistoryPreview(
      student,
      bitacoras,
      CONFIG,
      Boolean(state?.auth?.isAuthenticated)
    );
  }

  applyProfileFocusLayout(student);

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
    if (routeToggleButton) routeToggleButton.textContent = "Volver al perfil";
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
    if (routeToggleButton) routeToggleButton.textContent = "Ver ruta completa";
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
  if (routeToggleButton) routeToggleButton.textContent = "Ver ruta completa";
}

async function reloadLearningRoute(student) {
  await ensureLearningRouteLoaded(student, { forceReload: true });

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

  return `
    <div class="history-preview-list">
      ${latestItems.map(renderHistoryCard).join("")}
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

function renderHistoryCard(item) {
  const mode = normalizeMode(item.mode);
  const overridesCount = Object.keys(
    normalizeStudentOverrides(item.studentOverrides, item.studentIds || [])
  ).length;

  return `
    <article class="history-preview-card">
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
        </div>
      </header>

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

async function ensureStudentBitacorasLoaded(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  const currentItems = getBitacorasFromState(student);
  if (currentItems.length > 0) return;

  setBitacorasLoading(true);

  try {
    const response = await getBitacorasByStudent(studentRef, {
      processKey: currentProfileProcessKey || "",
    });
    const items = normalizeBitacorasResponse(response);

    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
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

    const response = await getBitacorasByStudent(studentRef, {
      processKey: currentProfileProcessKey || "",
    });
    const items = normalizeBitacorasResponse(response);

    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
  } catch (error) {
    console.error("Error recargando historial en profile:", error);
    setAppError(error?.message || "No se pudo recargar el historial.");
  } finally {
    setBitacorasLoading(false);
  }
}

function getBitacorasFromState(studentOrRef) {
  const selectedProcess =
    studentOrRef && typeof studentOrRef === "object"
      ? resolveStudentProcess(studentOrRef, currentProfileProcessKey)
      : null;

  const applyProcessFilter = (items = []) => {
    const safeProcessKey = toStringSafe(currentProfileProcessKey);
    const selectedDetail = normalizeText(
      selectedProcess?.detalle || selectedProcess?.label || ""
    );

    return items.filter((item) => {
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

      return itemDetails.includes(selectedDetail);
    });
  };
  const studentRef =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentIdentity(studentOrRef)
      : toStringSafe(studentOrRef);

  const fallbackId =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentFallbackId(studentOrRef)
      : "";

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
    titulo: item.titulo || item.title || "Bitácora sin título",
    contenido: item.contenido || item.content || "",
    etiquetas: normalizeTags(item.etiquetas || item.tags || []),
    fechaClase: item.fechaClase || item.fecha || item.classDate || "",
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
        tareas: toStringSafe(source.tareas),
        etiquetas: normalizeTags(source.etiquetas || []),
        componenteCorporal: normalizeTags(source.componenteCorporal || []),
        componenteTecnico: normalizeTags(source.componenteTecnico || []),
        componenteTeorico: normalizeTags(source.componenteTeorico || []),
        componenteObras: normalizeTags(source.componenteObras || []),
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

