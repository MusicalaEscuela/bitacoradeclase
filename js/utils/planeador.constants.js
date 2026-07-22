// js/utils/planeador.constants.js

/**
 * Constantes del Planeador Docente Musicala.
 *
 * Aquí vive TODA la estructura pedagógica (tipos de clase, componentes,
 * habilidades, momentos, plantillas, estados, columnas y colores del tablero).
 *
 * Importante: el componente artístico usa el MISMO lenguaje de las bitácoras
 * (categorías + componente corporal/técnico/teórico/de obras). Esas listas se
 * cargan desde `app_config/catalogos` resueltas por área. Ver
 * `planeador.api.js` → `buildAreaCatalog()`.
 *
 * - Sin lógica de negocio
 * - Sin DOM
 * - Sin fetch
 */

/* ==========================================================================
   ÁREA ARTÍSTICA
   - Mismo lenguaje que las bitácoras. El `area` mapea a la clave canónica del
     catálogo (`musica | danza | teatro | artesPlasticas`) para filtrar las
     mismas listas que usa el editor de bitácoras. "interdisciplinar" no filtra
     por área (muestra todas las listas).
   ========================================================================== */

export const ARTES = Object.freeze([
  { value: "musica", label: "Música", icon: "🎵", area: "musica" },
  { value: "danza", label: "Danza", icon: "🩰", area: "danza" },
  { value: "teatro", label: "Teatro", icon: "🎭", area: "teatro" },
  {
    value: "artesPlasticas",
    label: "Artes plásticas / visuales",
    icon: "🎨",
    area: "artesPlasticas",
  },
  { value: "interdisciplinar", label: "Interdisciplinar", icon: "✨", area: "" },
]);

/* ==========================================================================
   COMPONENTES DE BITÁCORA (mismo lenguaje del editor de clase)
   - Cada uno es una lista multivalor alimentada por el catálogo
     `app_config/catalogos` (componenteCorporal / componenteTecnico /
     componenteTeorico / componenteObras), resuelta por área artística.
   - Las claves coinciden EXACTAMENTE con las que guardan las bitácoras, para
     que todo hable el mismo idioma y se pueda enlazar a futuro.
   ========================================================================== */

export const COMPONENTES_BITACORA = Object.freeze([
  {
    key: "componenteCorporal",
    catalogField: "componenteCorporal",
    label: "Componente corporal",
    icon: "🤸",
    placeholder: "Agrega uno o varios ejercicios...",
  },
  {
    key: "componenteTecnico",
    catalogField: "componenteTecnico",
    label: "Componente técnico",
    icon: "🎯",
    placeholder: "Agrega uno o varios ejercicios...",
  },
  {
    key: "componenteTeorico",
    catalogField: "componenteTeorico",
    label: "Componente teórico",
    icon: "📖",
    placeholder: "Agrega uno o varios temas...",
  },
  {
    key: "componenteObras",
    catalogField: "componenteObras",
    label: "Componente de repertorio (obras)",
    icon: "🎼",
    placeholder: "Agrega una o varias obras...",
  },
]);

/* ==========================================================================
   TIPOS DE CLASE
   ========================================================================== */

export const TIPOS_CLASE = Object.freeze([
  { value: "regular", label: "Clase regular" },
  { value: "diagnostico", label: "Clase de diagnóstico" },
  { value: "exploracion", label: "Clase de exploración" },
  { value: "tecnica", label: "Clase técnica" },
  { value: "montaje", label: "Clase de montaje" },
  { value: "repaso", label: "Clase de repaso" },
  { value: "previaMuestra", label: "Clase previa a muestra" },
  { value: "cierre", label: "Clase de cierre" },
  { value: "reemplazo", label: "Clase de reemplazo" },
  { value: "interdisciplinar", label: "Clase interdisciplinar" },
  { value: "tallerEspecial", label: "Taller especial" },
]);

/* ==========================================================================
   HABILIDADES
   ========================================================================== */

export const HABILIDADES = Object.freeze([
  "Corporal",
  "Técnica",
  "Teórica",
  "Creativa",
  "Expresiva",
  "Socioemocional",
  "Interpretativa",
  "Rítmica",
  "Auditiva",
  "Visual",
  "Motriz",
  "Grupal",
  "Comunicativa",
  "Memoria",
  "Coordinación",
]);

/* ==========================================================================
   MOMENTOS DE CLASE
   ========================================================================== */

export const MOMENTOS = Object.freeze([
  {
    key: "bienvenida",
    label: "Bienvenida / encuadre",
    icon: "👋",
    help: "Saludo, presentación del objetivo, acuerdo de clase, activación inicial y contexto.",
    placeholder:
      "¿Cómo inicias? Saludo, objetivo del día, acuerdo de clase, activación inicial...",
  },
  {
    key: "calentamiento",
    label: "Calentamiento / preparación",
    icon: "🔥",
    help: "Preparación según el componente: respiración, movilidad, voz, exploración de materiales...",
    placeholder:
      "Música: respiración, escucha, pulso. Danza: movilidad. Teatro: cuerpo y voz. Artes: materiales...",
  },
  {
    key: "desarrolloTecnico",
    label: "Desarrollo técnico",
    icon: "🎯",
    help: "La habilidad central de la clase: patrón rítmico, paso, técnica vocal, mezcla de color...",
    placeholder:
      "Habilidad central: patrón rítmico, paso coreográfico, técnica vocal, construcción de personaje...",
  },
  {
    key: "practicaCreacion",
    label: "Práctica / creación",
    icon: "🛠️",
    help: "El estudiante aplica lo aprendido: individual, parejas, grupos, creación colectiva, montaje.",
    placeholder:
      "Ejercicio individual, parejas, grupos, creación colectiva, improvisación, producto artístico...",
  },
  {
    key: "cierre",
    label: "Cierre",
    icon: "🎬",
    help: "Socialización, reflexión, muestra breve, retroalimentación, registro y tarea.",
    placeholder:
      "Socialización, reflexión, muestra breve, retroalimentación, registro del avance, tarea...",
  },
]);

/* ==========================================================================
   NIVEL DEL GRUPO (adaptaciones)
   ========================================================================== */

export const NIVELES_GRUPO = Object.freeze([
  { value: "inicial", label: "Inicial" },
  { value: "basico", label: "Básico" },
  { value: "intermedio", label: "Intermedio" },
  { value: "avanzado", label: "Avanzado" },
  { value: "mixto", label: "Mixto" },
]);

/* ==========================================================================
   EVIDENCIA ESPERADA
   ========================================================================== */

export const TIPOS_EVIDENCIA = Object.freeze([
  { value: "foto", label: "Foto" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "producto", label: "Producto artístico" },
  { value: "registroEscrito", label: "Registro escrito" },
  { value: "observacion", label: "Observación docente" },
  { value: "listaAvances", label: "Lista de avances" },
  { value: "muestraCorta", label: "Muestra corta" },
  { value: "noAplica", label: "No aplica" },
]);

/* ==========================================================================
   MATERIALES SUGERIDOS (para checkboxes rápidos)
   ========================================================================== */

export const MATERIALES_SUGERIDOS = Object.freeze([
  "Parlante",
  "Instrumentos",
  "Hojas",
  "Pinturas",
  "Cinta",
  "Colchonetas",
  "Vestuario",
  "Escenografía",
  "Celular para evidencia",
  "Computador para evidencia",
  "Canción o pista",
  "Marcadores",
  "Elementos reciclados",
]);

/* ==========================================================================
   ESTADOS DE PLANEACIÓN
   ========================================================================== */

export const ESTADOS_PLANEACION = Object.freeze([
  { value: "borrador", label: "Borrador", color: "#94a3b8" },
  { value: "listaEnviar", label: "Lista para enviar", color: "#6366f1" },
  { value: "compartida", label: "Compartida con coordinación", color: "#8b5cf6" },
  { value: "revisada", label: "Revisada", color: "#0ea5e9" },
  { value: "aprobada", label: "Aprobada", color: "#22c55e" },
  { value: "requiereAjuste", label: "Requiere ajuste", color: "#f59e0b" },
  { value: "realizada", label: "Realizada", color: "#10b981" },
  { value: "archivada", label: "Archivada", color: "#cbd5e1" },
]);

export const ESTADO_LABELS = Object.freeze(
  ESTADOS_PLANEACION.reduce((acc, item) => {
    acc[item.value] = item.label;
    return acc;
  }, {})
);

export const ESTADO_COLORS = Object.freeze(
  ESTADOS_PLANEACION.reduce((acc, item) => {
    acc[item.value] = item.color;
    return acc;
  }, {})
);

/* ==========================================================================
   TABLERO DE POST-ITS
   ========================================================================== */

export const POSTIT_COLUMNAS = Object.freeze([
  { value: "ideas", label: "Ideas sueltas", icon: "💡" },
  { value: "objetivos", label: "Objetivos posibles", icon: "🎯" },
  { value: "actividades", label: "Actividades", icon: "🎲" },
  { value: "materiales", label: "Materiales", icon: "📦" },
  { value: "pendientes", label: "Pendientes", icon: "📌" },
  { value: "coordinacion", label: "Para revisar con coordinación", icon: "👀" },
  { value: "repertorio", label: "Repertorio / referentes", icon: "📚" },
  { value: "evidencias", label: "Evidencias", icon: "📸" },
  { value: "proximos", label: "Próximos pasos", icon: "➡️" },
]);

export const POSTIT_COLORES = Object.freeze([
  { value: "lila", label: "Lila", hex: "#ede9fe" },
  { value: "violeta", label: "Violeta", hex: "#ddd6fe" },
  { value: "azul", label: "Azul", hex: "#dbeafe" },
  { value: "fucsia", label: "Fucsia", hex: "#fce7f3" },
  { value: "menta", label: "Menta", hex: "#d1fae5" },
  { value: "durazno", label: "Durazno", hex: "#ffedd5" },
  { value: "amarillo", label: "Amarillo", hex: "#fef9c3" },
]);

export const POSTIT_ESTADOS = Object.freeze([
  { value: "idea", label: "Idea" },
  { value: "enProceso", label: "En proceso" },
  { value: "usado", label: "Usado" },
  { value: "archivado", label: "Archivado" },
]);

/* ==========================================================================
   PLANTILLAS RÁPIDAS
   - `apply` define qué campos rellena la plantilla sobre una planeación nueva.
   ========================================================================== */

export const PLANTILLAS = Object.freeze([
  {
    id: "diagnostico",
    nombre: "Clase de diagnóstico",
    icon: "🔍",
    descripcion: "Identificar el nivel inicial del grupo.",
    apply: {
      tipoClase: "diagnostico",
      objetivo:
        "Al finalizar la clase, podré identificar el nivel inicial del grupo mediante actividades de exploración y observación.",
      habilidades: ["Técnica", "Expresiva", "Grupal"],
      momentosClase: {
        bienvenida: "Saludo y juego inicial para romper el hielo y observar disposición del grupo.",
        calentamiento: "Activación corporal/vocal sencilla para ver coordinación y energía.",
        desarrolloTecnico: "Exploración técnica básica del componente para detectar nivel real.",
        practicaCreacion: "Actividad grupal donde se evidencien habilidades y dificultades.",
        cierre: "Observación, registro de notas y cierre motivador.",
      },
      evidenciaEsperada: {
        tipo: "observacion",
        descripcion: "Notas del docente sobre el nivel del grupo y foto/video si aplica.",
      },
    },
  },
  {
    id: "tecnica",
    nombre: "Clase técnica",
    icon: "🎯",
    descripcion: "Fortalecer una habilidad específica.",
    apply: {
      tipoClase: "tecnica",
      objetivo:
        "Al finalizar la clase, los estudiantes podrán fortalecer ________ mediante práctica guiada y autónoma.",
      habilidades: ["Técnica", "Memoria", "Coordinación"],
      momentosClase: {
        bienvenida: "Saludo y presentación de la habilidad técnica a trabajar.",
        calentamiento: "Calentamiento específico para la técnica de la clase.",
        desarrolloTecnico: "Explicación y demostración de la técnica, paso a paso.",
        practicaCreacion: "Práctica guiada y luego práctica autónoma del estudiante.",
        cierre: "Retroalimentación y registro del avance.",
      },
      evidenciaEsperada: {
        tipo: "video",
        descripcion: "Video corto o registro de avance de la habilidad trabajada.",
      },
    },
  },
  {
    id: "montaje",
    nombre: "Clase de montaje",
    icon: "🎼",
    descripcion: "Avanzar en una obra, coreografía, escena o muestra.",
    apply: {
      tipoClase: "montaje",
      objetivo:
        "Al finalizar la clase, los estudiantes podrán avanzar en ________ mediante repaso e integración de un nuevo fragmento.",
      habilidades: ["Interpretativa", "Memoria", "Grupal"],
      momentosClase: {
        bienvenida: "Saludo y repaso del objetivo del montaje.",
        calentamiento: "Calentamiento específico para el montaje.",
        desarrolloTecnico: "Repaso de lo trabajado y montaje de un nuevo fragmento.",
        practicaCreacion: "Integración del fragmento nuevo con lo anterior.",
        cierre: "Muestra breve del avance y registro en video.",
      },
      evidenciaEsperada: {
        tipo: "video",
        descripcion: "Video del avance del montaje.",
      },
    },
  },
  {
    id: "reemplazo",
    nombre: "Clase de reemplazo",
    icon: "🔁",
    descripcion: "Dar continuidad al proceso sin romper la línea del docente titular.",
    apply: {
      tipoClase: "reemplazo",
      esReemplazo: true,
      objetivo:
        "Al finalizar la clase, daré continuidad al proceso del grupo sin romper la línea del docente titular.",
      habilidades: ["Grupal", "Comunicativa"],
      momentosClase: {
        bienvenida: "Revisar indicaciones del docente titular y saludar al grupo.",
        calentamiento: "Activar el grupo con una rutina conocida por ellos.",
        desarrolloTecnico: "Desarrollar la actividad clara dejada por el titular.",
        practicaCreacion: "Aplicación y práctica de lo indicado.",
        cierre: "Registrar evidencia y dejar observaciones para coordinación.",
      },
      evidenciaEsperada: {
        tipo: "registroEscrito",
        descripcion: "Resumen para coordinación con lo realizado y el estado del grupo.",
      },
    },
  },
  {
    id: "interdisciplinar",
    nombre: "Clase interdisciplinar",
    icon: "✨",
    descripcion: "Conectar dos o más lenguajes artísticos.",
    apply: {
      tipoClase: "interdisciplinar",
      arte: "interdisciplinar",
      objetivo:
        "Al finalizar la clase, los estudiantes podrán conectar ________ y ________ mediante una creación colectiva.",
      habilidades: ["Creativa", "Expresiva", "Grupal"],
      momentosClase: {
        bienvenida: "Activación y presentación de los lenguajes a conectar.",
        calentamiento: "Exploración de ambos lenguajes artísticos.",
        desarrolloTecnico: "Conexión técnica entre los lenguajes.",
        practicaCreacion: "Creación colectiva integrando los lenguajes.",
        cierre: "Socialización del producto y registro audiovisual.",
      },
      evidenciaEsperada: {
        tipo: "producto",
        descripcion: "Producto colectivo o registro audiovisual de la creación.",
      },
    },
  },
]);

/* ==========================================================================
   AYUDA DE OBJETIVO
   ========================================================================== */

export const OBJETIVO_PLANTILLA =
  "Al finalizar la clase, los estudiantes podrán ________ mediante ________.";

export const OBJETIVO_EJEMPLOS = Object.freeze([
  "Al finalizar la clase, los estudiantes podrán reconocer el pulso estable mediante ejercicios de percusión corporal.",
  "Al finalizar la clase, los estudiantes podrán ejecutar una secuencia de 8 tiempos mediante repetición guiada y trabajo grupal.",
  "Al finalizar la clase, los estudiantes podrán crear una composición visual usando textura, color y materiales reciclados.",
]);

/* ==========================================================================
   FACTORÍAS DE DOCUMENTOS
   ========================================================================== */

export function createEmptyPlaneacion(overrides = {}) {
  const base = {
    // Dueño del documento (para que cada docente vea solo lo suyo y admin todo).
    ownerEmail: "",
    ownerUid: "",
    fechaClase: "",
    horaInicio: "",
    horaFin: "",
    docenteId: "",
    docenteNombre: "",
    programa: "",
    sede: "",
    grupoId: "",
    grupoNombre: "",
    cantidadEstudiantes: 0,
    participantes: [],
    modoObservaciones: "todos",
    observacionesGrupo: "",
    ciclo: "",
    edad: "",
    duracion: "",
    arte: "",
    // Componentes con el MISMO lenguaje de las bitácoras (listas multivalor).
    categorias: [],
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
    tipoClase: "regular",
    objetivo: "",
    habilidades: [],
    momentosClase: {
      bienvenida: "",
      calentamiento: "",
      desarrolloTecnico: "",
      practicaCreacion: "",
      cierre: "",
    },
    adaptaciones: {
      nivelGrupo: "",
      descripcion: "",
      estudiantesNuevos: false,
      grupoMixto: false,
      requierenApoyo: "",
      variacionesEdad: "",
      pocosEstudiantes: "",
      grupoDisperso: "",
      recomendaciones: "",
    },
    materiales: [],
    evidenciaEsperada: {
      tipo: "",
      descripcion: "",
    },
    observacionesCoordinacion: "",
    esReemplazo: false,
    reemplazo: {
      docenteTitular: "",
      docenteReemplazante: "",
      continuidad: "",
      noCambiar: "",
      indicacionesGrupo: "",
      materialPrevio: "",
      nivelReal: "",
      alertas: "",
      evidenciaSolicitada: "",
    },
    estado: "borrador",
    compartida: false,
    fechaCompartida: "",
    comentariosCoordinacion: [],
    archived: false,
  };

  return deepMergePlain(base, overrides || {});
}

export function createEmptyPostit(overrides = {}) {
  const base = {
    ownerEmail: "",
    ownerUid: "",
    docenteId: "",
    docenteNombre: "",
    titulo: "",
    descripcion: "",
    columna: "ideas",
    arte: "",
    grupoId: "",
    grupoNombre: "",
    color: "lila",
    estado: "idea",
    fecha: "",
    archived: false,
  };

  return { ...base, ...(overrides || {}) };
}

// Merge superficial-profundo solo para objetos planos (los anidados conocidos
// de la planeación). Suficiente para aplicar plantillas y overrides.
function deepMergePlain(target, source) {
  const output = { ...target };
  Object.keys(source).forEach((key) => {
    const sv = source[key];
    const tv = output[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      output[key] = deepMergePlain(tv, sv);
    } else {
      output[key] = sv;
    }
  });
  return output;
}
