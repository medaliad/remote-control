/** @type {import('tailwindcss').Config} */
//
// VE Admin design system. Token *names* (bg / surface / text / accent ...) are
// the same as before so existing JSX class strings keep working, but every
// value now maps to the Virtual Eye light palette: white panels on a pale
// canvas, brand blue #045692 for primary, #008BF9 for the bright accent,
// neutral text900/text500 etc. Font is Barlow.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
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
        bg:             "#F6F8FB",
        surface:        "#FFFFFF",
        "surface-2":    "#FFFFFF",
        "surface-3":    "#F6F8FB",
        canvas:         "#F6F8FB",
        border:         "#E5E7EB",
        "border-hi":    "#D1D5DB",
        line:           "#E5E7EB",
        text:           "#1F2937",
        muted:          "#6B7280",
        subtle:         "#9CA3AF",
        text900:        "#1F2937",
        text700:        "#4B5563",
        text500:        "#6B7280",
        text400:        "#9CA3AF",
        primary:        "#045692",
        "primary-dark": "#013059",
        "primary-soft": "#E8EFF5",
        accent:         "#045692",
        "accent-hi":    "#008BF9",
        "accent-lo":    "#013059",
        success:        "#10B981",
        warning:        "#F59E0B",
        danger:         "#EF4444",
      },
      fontFamily: {
        sans: ["Barlow", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      backgroundImage: {
        "grid-pattern": "linear-gradient(to right, rgba(4,86,146,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(4,86,146,0.06) 1px, transparent 1px)",
        "radial-accent": "radial-gradient(ellipse at top, rgba(0,139,249,0.12), transparent 60%)",
      },
      boxShadow: {
        glow:      "0 4px 18px -4px rgba(4, 86, 146, 0.18)",
        "glow-lg": "0 10px 30px -8px rgba(4, 86, 146, 0.22)",
        "soft-xl": "0 10px 30px -10px rgba(11, 31, 58, 0.10), 0 0 0 1px rgba(11, 31, 58, 0.04)",
        card:      "0 1px 2px rgba(11, 31, 58, 0.04), 0 4px 12px rgba(11, 31, 58, 0.06)",
      },
      animation: {
        "pulse-dot":      "pulse-dot 1.6s ease-in-out infinite",
        "pulse-fast":     "pulse-dot 1s ease-in-out infinite",
        "fade-in":        "fade-in 0.3s ease-out",
        "slide-up":       "slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in":       "scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer:          "shimmer 2.5s linear infinite",
        "gradient-shift": "gradient-shift 6s ease-in-out infinite",
        "blob-float":     "blob-float 14s ease-in-out infinite",
      },
      keyframes: {
        "pulse-dot": { "0%, 100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: "0.45", transform: "scale(1.4)" } },
        "fade-in":   { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up":  { from: { opacity: "0", transform: "translateY(12px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "scale-in":  { from: { opacity: "0", transform: "scale(0.96)" }, to: { opacity: "1", transform: "scale(1)" } },
        shimmer:     { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        "gradient-shift": { "0%, 100%": { backgroundPosition: "0% 50%" }, "50%": { backgroundPosition: "100% 50%" } },
        "blob-float": { "0%, 100%": { transform: "translate(0, 0) scale(1)" }, "33%": { transform: "translate(30px, -40px) scale(1.1)" }, "66%": { transform: "translate(-20px, 20px) scale(0.95)" } },
      },
    },
  },
  plugins: [],
};
