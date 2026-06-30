import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#101828",
        muted: "#667085",
        line: "#d9e2ec",
        panel: "#ffffff",
        canvas: "#f6f8fb",
        accent: "#378add",
        success: "#27500a",
        warning: "#8a5207",
        danger: "#791f1f"
      },
      boxShadow: {
        soft: "0 1px 2px rgba(16, 24, 40, 0.05)"
      }
    }
  },
  plugins: []
};

export default config;
