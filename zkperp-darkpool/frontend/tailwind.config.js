/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:      '#080c10',
        panel:   '#0d1219',
        border:  '#1a2535',
        accent:  '#00d4aa',
        accent2: '#3b82f6',
        muted:   '#6b7f94',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
