/** @type {import('tailwindcss').Config} */
// ---------------------------------------------------------------------------
// Tailwind CSS configuration for the LILA Tic-Tac-Toe frontend.
//
// We extend the default theme with brand colors taken from the LILA assignment
// sample screens (a teal accent on a near-black background) and a custom
// font scale optimized for mobile. The "lila" namespace under colors keeps
// our palette names self-documenting in JSX (`bg-lila-bg`, `text-lila-accent`).
// ---------------------------------------------------------------------------
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        lila: {
          // Backgrounds
          bg: "#0e1116",        // dark surface (matchmaking screen)
          surface: "#161b22",   // raised cards / modals
          border: "#222831",    // subtle hairline borders
          // Accents — match the teal in the sample game board
          accent: "#2ec4a6",
          accentHover: "#26a78c",
          // Text
          text: "#f5f6f7",
          subtle: "#9aa4af",
          // Marks
          x: "#ef4444",         // red X
          o: "#fcd34d",         // yellow O
          win: "#34d399",       // green for winning highlight
        },
      },
      fontFamily: {
        // System font stack first — fast, no FOUT, looks native on every OS.
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        // Soft glow used on the primary CTA button
        glow: "0 0 24px 0 rgba(46, 196, 166, 0.35)",
      },
      animation: {
        // Pulse effect on the matchmaking spinner
        "slow-pulse": "pulse 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
