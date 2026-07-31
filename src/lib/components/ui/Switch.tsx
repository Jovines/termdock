interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  /** sm = 紧凑行(快捷开关 / 侧栏),md = 设置页标准行 */
  size?: 'sm' | 'md';
  className?: string;
}

const TRACK_SIZE = {
  sm: 'h-4 w-7',
  md: 'h-6 w-10',
} as const;

const KNOB_SIZE = {
  sm: 'h-3 w-3',
  md: 'h-5 w-5',
} as const;

const KNOB_ON_SHIFT = {
  sm: 'translate-x-3',
  md: 'translate-x-4',
} as const;

/**
 * 全局唯一的开关样式:轨道关 = surface-elevated、开 = primary(实色,不用透明
 * 度),滑块恒为 background 色(画布色镂空,深/浅主题都成立)。纯展示组件,
 * 交互(点击 / aria-pressed)由外层 button 负责,避免 button 套 button。
 */
export function Switch({ checked, disabled = false, size = 'md', className = '' }: SwitchProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center rounded-full transition ${
        TRACK_SIZE[size]
      } ${checked ? 'bg-primary' : 'bg-surface-elevated'} ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      <span
        className={`mx-0.5 inline-block rounded-full bg-[var(--background)] shadow transition ${
          KNOB_SIZE[size]
        } ${checked ? KNOB_ON_SHIFT[size] : ''}`}
      />
    </span>
  );
}
