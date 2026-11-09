import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

// Keep the native thumbnail icons in step with the Lucide glyphs in DeviceDock.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src-tauri", "icons", "taskbar");
const icons = [
  ["mic-on", "mic", "#f5f4f2"],
  ["mic-off", "mic-off", "#df746b"],
  ["headphones-on", "headphones", "#f5f4f2"],
  ["headphones-off", "headphone-off", "#df746b"],
  ["leave", "phone-off", "#df746b"],
];

function svgElement([element, attributes]) {
  const values = Object.entries(attributes)
    .filter(([name]) => name !== "key")
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return `<${element} ${values}/>`;
}

function ico(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

async function writeIfChanged(file, bytes) {
  const next = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const previous = await readFile(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!previous?.equals(next)) await writeFile(file, next);
}

await mkdir(target, { recursive: true });
for (const [name, lucideName, color] of icons) {
  const file = path.join(root, "node_modules", "lucide-react", "dist", "esm", "icons", `${lucideName}.js`);
  const { __iconNode: iconNode } = await import(pathToFileURL(file).href);
  if (!iconNode) throw new Error(`Cannot read Lucide glyph ${lucideName}`);
  const paths = iconNode.map(svgElement).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none">
  <g stroke="#141518" stroke-opacity=".72" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
  <g stroke="${color}" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
</svg>\n`;
  const png = new Resvg(svg).render().asPng();
  await writeIfChanged(path.join(target, `${name}.svg`), svg);
  await writeIfChanged(path.join(target, `${name}.ico`), ico(png));
}

// The macOS menu bar badges. Menu bar icons are templates (macOS reads only their alpha),
// so a badge is a solid disc with the glyph cut out of it. The glyph is drawn heavier than
// the taskbar's, since it has to read at a few points across. tray.rs sets the disc into
// the menu bar mark.
const MENU_BAR_BADGE_PX = 22;
const menuBarBadges = [
  ["mic-off", "mic-off"],
  ["headphones-off", "headphone-off"],
];
const trayTarget = path.join(root, "src-tauri", "icons", "tray");
await mkdir(trayTarget, { recursive: true });
for (const [name, lucideName] of menuBarBadges) {
  const file = path.join(root, "node_modules", "lucide-react", "dist", "esm", "icons", `${lucideName}.js`);
  const { __iconNode: iconNode } = await import(pathToFileURL(file).href);
  if (!iconNode) throw new Error(`Cannot read Lucide glyph ${lucideName}`);
  const paths = iconNode.map(svgElement).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MENU_BAR_BADGE_PX}" height="${MENU_BAR_BADGE_PX}" viewBox="0 0 24 24">
  <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
    <rect width="24" height="24" fill="#fff"/>
    <g transform="translate(4.8 4.8) scale(0.6)" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
  </mask>
  <circle cx="12" cy="12" r="12" fill="#000" mask="url(#cut)"/>
</svg>\n`;
  await writeIfChanged(path.join(trayTarget, `macos-badge-${name}.png`), new Resvg(svg).render().asPng());
}
