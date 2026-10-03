import esbuild from "esbuild";
import { builtinModules } from "module";

const watch = process.argv[2] === "watch";

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  outfile: "main.js",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  process.exit(0);
}
