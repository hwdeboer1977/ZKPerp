/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'zkperp': {
          'dark':   '#05070d',
          'card':   '#0a0f1e',
          'border': '#1a2a3a',
          'green':  '#22c55e',
          'red':    '#ef4444',
          'accent': '#22d3ee',   // cyan-400 — matches the UI library
        }
      },
      backgroundImage: {
        'gradient-zk': 'linear-gradient(135deg, #22d3ee, #8b5cf6)',
      },
      boxShadow: {
        'cyan': '0 0 30px rgba(34,211,238,0.3)',
        'cyan-lg': '0 0 60px rgba(34,211,238,0.15)',
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
        '4xl': '32px',
      }
    },
  },
  plugins: [],
}
