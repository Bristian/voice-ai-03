/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0c10",
        surface: "#0f1318",
        surface2: "#161b22",
        border: "#21262d",
        accent: "#e8562a",
        "accent-2": "#f0a500",
        "accent-3": "#3fb950",
        "accent-4": "#58a6ff",
        "text-primary": "#e6edf3",
        "text-muted": "#7d8590",
        "text-dim": "#484f58",
      },
    },
  },
  plugins: [],
};
