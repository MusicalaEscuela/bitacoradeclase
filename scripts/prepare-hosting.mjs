import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const outputDirectory = join(projectRoot, ".firebase-hosting");
const runtimeEntries = Object.freeze(["index.html", "assets", "css", "js"]);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const entry of runtimeEntries) {
  const source = join(projectRoot, entry);
  const destination = join(outputDirectory, entry);
  const sourceStat = await stat(source);

  await cp(source, destination, {
    recursive: sourceStat.isDirectory(),
    force: true,
  });
}

console.log(
  `Hosting preparado con allowlist: ${runtimeEntries.join(", ")}`
);
