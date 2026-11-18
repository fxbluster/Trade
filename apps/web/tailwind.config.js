/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        obsidian: {
          DEFAULT: '#020305',
          panel: '#080c14',
          subpanel: '#0d131f',
          border: '#151d2c',
          hover: '#1a2436',
        },
        trade: {
          long: '#0ecb81',
          'long-hover': '#0bb573',
          'long-dim': 'rgba(14, 203, 129, 0.15)',
          short: '#f6465d',
          'short-hover': '#e0394f',
          'short-dim': 'rgba(246, 70, 93, 0.15)',
        },
        accent: {
          yellow: '#f0b90b',
          blue: '#2962ff',
          amber: '#f59e0b',
          purple: '#8b5cf6',
        },
        text: {
          primary: '#e6edf3',
          secondary: '#7d8590',
          muted: '#484f58',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
