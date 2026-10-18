export function validImportDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function resolveImportDate(row = {}, fallbackYear = '') {
  const raw = String(row.dateText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  const numeric = raw.match(/\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}))?\b/);
  const spanish = raw.match(/\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b(?:\s+(?:de[l]?\s+)?(\d{4})\b)?/);
  const months = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};
  const day = Number(row.day) || Number(iso?.[3] || numeric?.[1] || spanish?.[1]);
  const month = Number(row.month) || Number(iso?.[2] || numeric?.[2] || months[spanish?.[2]]);
  const explicitYear = Number(row.year) || Number(iso?.[1] || numeric?.[3] || spanish?.[3]);
  if (!day || !month) return validImportDate(row.fechaClase) ? row.fechaClase : '';
  const year = explicitYear || Number(fallbackYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return '';
  const value = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return validImportDate(value) ? value : '';
}
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function matchImportStudents(names, students, currentStudent, getId, getName) {
  if (!names.length) return { linkedStudents: [currentStudent], unresolvedStudents: [] };
  const linkedStudents = [], unresolvedStudents = [], seen = new Set();
  for (const name of names) {
    const query = normalize(name);
    const exact = students.filter(s => normalize(getName(s)) === query);
    const matches = exact.length ? exact : students.filter(s => {
      const tokens = normalize(getName(s)).split(' '), wanted = query.split(' ');
      return wanted.length >= 2 && wanted.every(token => tokens.includes(token));
    });
    // Nunca elegir el primer homónimo o unir familiares por un correo compartido.
    const unique = new Map(matches.map(s => [getId(s), s]).filter(([id]) => id));
    if (unique.size !== 1) { unresolvedStudents.push(name); continue; }
    const [id, student] = [...unique][0];
    if (!seen.has(id)) { linkedStudents.push(student); seen.add(id); }
  }
  return { linkedStudents, unresolvedStudents };
}
export async function readAiImportFiles(files) {
  let text = '', bytes = 0;
  const binaries = [];
  if (files.length > 4) throw Error('Selecciona hasta 4 archivos por análisis.');
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (/\.(txt|csv|tsv|md|json)$/.test(name)) {
      if (file.size > 500000) throw Error('El texto es demasiado grande. Divide el archivo.');
      text += `\n\nArchivo: ${file.name}\n${await file.text()}`;
      continue;
    }
    const mimeType = /\.pdf$/.test(name) ? 'application/pdf' : /\.png$/.test(name) ? 'image/png'
      : /\.jpe?g$/.test(name) ? 'image/jpeg' : /\.webp$/.test(name) ? 'image/webp' : '';
    if (!mimeType) throw Error(`${file.name}: usa PDF, imagen o texto. Para Word, copia el contenido o exporta como PDF.`);
    bytes += file.size;
    if (bytes > 5 * 1024 * 1024) throw Error('Los documentos superan 5 MB. Divídelos en partes.');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(Error(`No se pudo leer ${file.name}.`));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    binaries.push({ name: file.name, mimeType, data });
  }
  return { text: text.trim(), files: binaries };
}
export async function importDocumentId(payload) {
  const data = JSON.stringify({ date: payload.fechaClase, time: payload.horaClase || '',
    students: [...payload.studentIds].sort(), process: payload.processKey,
    teacher: normalize(payload.docente), content: String(payload.content || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase() });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return 'import_' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
