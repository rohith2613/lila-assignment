// ---------------------------------------------------------------------------
// Rollup configuration to bundle our TypeScript modules into a single JS file
// that Nakama's Goja JavaScript runtime can load.
//
// Why rollup (and not tsc directly)?
//   - Nakama loads ONE JS file per runtime; we want to keep our source split
//     into many small TS files for readability but ship a single artifact.
//   - Goja is ES5-only and doesn't understand ES module syntax, so we use
//     rollup's IIFE/CJS-like output without imports/exports.
//   - We also need to expose a top-level `InitModule` symbol globally so the
//     Nakama runtime can find it.
// ---------------------------------------------------------------------------
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/main.ts',
  output: {
    file: 'build/index.js',
    format: 'cjs',
    // Goja runtime will look for the InitModule export. Using CJS keeps the
    // output simple — Nakama will evaluate the file in a sandbox where
    // `module.exports.InitModule` becomes the entry point.
    exports: 'named',
    // Inline sourcemaps would bloat the runtime; not needed since Goja can't
    // consume them anyway.
    sourcemap: false,
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      // We want rollup to emit; tsc is only used as a type checker via the
      // build script. The plugin still uses tsconfig for module resolution.
      noEmitOnError: true,
    }),
  ],
};
