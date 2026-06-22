/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-elevated': 'var(--surface-elevated)',
        'background-subtle': 'var(--background-subtle)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        hover: 'var(--hover)',
      },
      fontFamily: {
        // 单一来源：CSS 变量在 src/index.css 的 :root 定义。
        // 字体改动只动那里，不再在 tailwind 配置里维护 fallback 链。
        mono: ['var(--font-mono)'],
        sans: ['var(--font-sans)'],
      },
      // 语义化 z-index —— 数值单一来源在 src/index.css 的 :root（--z-*）。
      // 业务里只用 z-drawer-panel / z-modal-panel 这类语义类，禁止裸 z-[数字]。
      // 新增浮层先在 index.css 选/加档位，再在这里补一个映射。
      zIndex: {
        'sidebar-backdrop': 'var(--z-sidebar-backdrop)',
        'sidebar-panel': 'var(--z-sidebar-panel)',
        'menu-backdrop': 'var(--z-menu-backdrop)',
        'menu-panel': 'var(--z-menu-panel)',
        'drawer-backdrop': 'var(--z-drawer-backdrop)',
        'drawer-panel': 'var(--z-drawer-panel)',
        'modal-backdrop': 'var(--z-modal-backdrop)',
        'modal-panel': 'var(--z-modal-panel)',
        'toast': 'var(--z-toast)',
        'popover': 'var(--z-popover)',
      },
      animation: {
        'spin-slow': 'spin 3s linear infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
