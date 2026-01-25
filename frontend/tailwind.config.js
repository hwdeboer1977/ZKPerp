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
          'dark': '#0a0e17',
          'card': '#111827',
          'border': '#1f2937',
          'green': '#22c55e',
          'red': '#ef4444',
          'accent': '#6366f1',
        }
      }
    },
  },
  plugins: [],
}
