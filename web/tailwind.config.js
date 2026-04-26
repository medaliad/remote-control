/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    // Add an `xs` breakpoint at 480px for finer-grained phone responsiveness.
    // Tailwind's default breakpoints start at `sm: 640px`, which leaves a big
    // gap for phones in landscape (~480–640) and large phones in portrait.
    screens: {
      xs: "480px",
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      colors: {
        bg: "#07070d",
        surface: "#11111c",
        "surface-2": "#171725",
        "surface-3": "#1f1f30",
        border: "#272739",
        "border-hi": "#3a3a54",
        text: "#e9e9f1",
        muted: "#9b9bb0",
        subtle: "#6a6a80",
        accent: "#7c6aff",
        "accent-hi": "#9384ff",
        "accent-lo": "#5a48e0",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      backgroundImage: {
        "grid-pattern":
          "linear-gradient(to right, rgba(124, 106, 255, 0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(124, 106, 255, 0.06) 1px, transparent 1px)",
        "radial-accent":
          "radial-gradient(ellipse at top, rgba(124, 106, 255, 0.18), transparent 60%)",
      },
      boxShadow: {
        glow: "0 0 40px -8px rgba(124, 106, 255, 0.45)",
        "glow-lg": "0 0 80px -10px rgba(124, 106, 255, 0.55)",
        "soft-xl":
          "0 24px 60px -12px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.03)",
      },
      animation: {
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        "pulse-fast": "pulse-dot 1s ease-in-out infinite",
        "fade-in": "fade-in 0.3s ease-out",
        "slide-up": "slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in": "scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 2.5s linear infinite",
        "gradient-shift": "gradient-shift 6s ease-in-out infinite",
        "blob-float": "blob-float 14s ease-in-out infinite",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(1.4)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "gradient-shift": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        "blob-float": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "33%": { transform: "translate(30px, -40px) scale(1.1)" },
          "66%": { transform: "translate(-20px, 20px) scale(0.95)" },
        },
      },
    },
  },
  plugins: [],
};
