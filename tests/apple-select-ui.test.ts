import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function tsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return tsxFiles(path);
      return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("shared Apple-style select", () => {
  it("replaces visible native selects across feature pages", async () => {
    const files = await tsxFiles("features");
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));

    expect(sources.join("\n")).not.toContain("<select");
  });

  it("supports listbox semantics, keyboard navigation, outside close and portal positioning", async () => {
    const component = await readFile("features/ui/apple-select.tsx", "utf8");

    expect(component).toContain('aria-haspopup="listbox"');
    expect(component).toContain('role="listbox"');
    expect(component).toContain('role="option"');
    expect(component).toContain('event.key === "ArrowDown"');
    expect(component).toContain('event.key === "Escape"');
    expect(component).toContain('document.addEventListener("pointerdown"');
    expect(component).toContain("createPortal(");
    expect(component).toContain('window.addEventListener("scroll", updatePosition, true)');
  });
});
