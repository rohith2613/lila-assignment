// PostCSS pipeline. Tailwind first (turns @tailwind directives into CSS),
// then autoprefixer to add vendor prefixes for older browsers.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
