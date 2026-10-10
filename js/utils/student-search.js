import { normalizeText } from "./shared.js";

// La lista operativa y la consulta histórica deben buscar las mismas palabras
// en los mismos campos, aunque se omita un nombre o apellido intermedio.
export function buildStudentSearchText(student = {}) {
  const processValues = Array.isArray(student.processes)
    ? student.processes.flatMap((process) => [process?.arte, process?.detalle, process?.label])
    : [];
  return normalizeText([
    student.id, student.studentId, student.studentKey,
    student.nombre, student.name, student.estudiante,
    student.documento, student.numeroDocumento, student.identificacion, student.cc,
    student.docente, student.teacher, student.acudiente, student.responsable,
    student.modalidad, student.area, student.programa, student.instrumento,
    student.sede, student.correo, student.email, student.correoElectronico,
    student.telefono, student.estado, student.interesesMusicales,
    ...processValues,
  ].filter(Boolean).join(" "));
}

export function matchesStudentSearchText(searchableText, query = "") {
  const tokens = normalizeText(query).split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => searchableText.includes(token));
}
