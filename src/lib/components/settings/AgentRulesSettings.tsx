import {
  Plus as RiAddLine,
  Trash2 as RiDeleteBinLine,
  X as RiCloseLine,
  RotateCcw as RiResetLine,
} from 'lucide-react';
import type { AgentProgramConfig, AgentRule } from '../../terminal/api';
import { useI18n } from '../../i18n';

const INDICATOR_OPTIONS: Array<{ value: NonNullable<AgentRule['indicator']>; label: string }> = [
  { value: 'spinner', label: 'Spinner' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'dot', label: 'Dot' },
  { value: 'ring', label: 'Ring' },
  { value: 'question', label: 'Question' },
  { value: 'badge', label: 'Badge' },
  { value: 'terminal', label: 'Icon' },
];

interface AgentRulesSettingsProps {
  rules: AgentProgramConfig[];
  onChange: (rules: AgentProgramConfig[]) => void;
  onResetDefaults: () => void;
}

function getProgramList(config: AgentProgramConfig): string[] {
  if (Array.isArray(config.programs) && config.programs.length > 0) {
    return config.programs;
  }
  if (typeof config.program === 'string' && config.program.trim().length > 0) {
    return [config.program];
  }
  return [];
}

function normalizeProgramListInput(input: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const token of input.split(',')) {
    const next = token.trim().toLowerCase();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function AgentRulesSettings({ rules, onChange, onResetDefaults }: AgentRulesSettingsProps) {
  const { t } = useI18n();
  const presetColors = [
    { value: '#4ade80', label: t('agentRules.ruleColors.green') },
    { value: '#facc15', label: t('agentRules.ruleColors.yellow') },
    { value: '#f87171', label: t('agentRules.ruleColors.red') },
    { value: '#60a5fa', label: t('agentRules.ruleColors.blue') },
    { value: '#c084fc', label: t('agentRules.ruleColors.purple') },
    { value: '#fb923c', label: t('agentRules.ruleColors.orange') },
    { value: '#888888', label: t('agentRules.ruleColors.gray') },
  ] as const;
  const addProgram = () => {
    onChange([...rules, { programs: [], rules: [{ pattern: '', status: 'running', indicator: 'pulse', clearDelayMs: 700 }] }]);
  };

  const removeProgram = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const updateProgramList = (index: number, value: string) => {
    const programs = normalizeProgramListInput(value);
    onChange(rules.map((r, i) => (i === index ? { ...r, programs, program: undefined } : r)));
  };

  const addRule = (progIndex: number) => {
    onChange(rules.map((r, i) =>
      i === progIndex ? { ...r, rules: [...r.rules, { pattern: '', status: 'running', indicator: 'pulse', clearDelayMs: 700 }] } : r
    ));
  };

  const removeRule = (progIndex: number, ruleIndex: number) => {
    onChange(rules.map((r, i) =>
      i === progIndex ? { ...r, rules: r.rules.filter((_, ri) => ri !== ruleIndex) } : r
    ));
  };

  const updateRule = (progIndex: number, ruleIndex: number, field: keyof AgentRule, value: string | number) => {
    onChange(rules.map((r, i) =>
      i === progIndex
        ? { ...r, rules: r.rules.map((rule, ri) => (ri === ruleIndex ? { ...rule, [field]: value } : rule)) }
        : r
    ));
  };

  const validateRegex = (pattern: string): string | null => {
    if (!pattern) return null;
    try {
      new RegExp(pattern, 'i');
      return null;
    } catch {
      return t('settings.invalidRegex');
    }
  };

  return (
    <div className="space-y-4">
      {rules.map((prog, pi) => (
        <div key={pi} className="rounded-xl bg-surface-2 p-3 space-y-2.5">
          {/* Program header */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={getProgramList(prog).join(', ')}
              onChange={(e) => updateProgramList(pi, e.target.value)}
              placeholder={t('settings.programNamePlaceholder')}
              className="flex-1 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/30"
            />
            <button
              type="button"
              onClick={() => removeProgram(pi)}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-surface-elevated hover:text-red-400 transition"
              aria-label={t('settings.removeProgram')}
            >
              <RiDeleteBinLine size={14} />
            </button>
          </div>

          <p className="-mt-1 text-[10px] text-muted-foreground">
            {t('settings.programsHelp')}
          </p>

          {/* Rules list */}
          {prog.rules.map((rule, ri) => {
            const regexError = validateRegex(rule.pattern);
            return (
              <div key={ri} className="space-y-1.5 rounded-lg bg-surface/50 p-2 pl-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={rule.pattern}
                    onChange={(e) => updateRule(pi, ri, 'pattern', e.target.value)}
                    placeholder={t('settings.patternPlaceholder')}
                    className={`flex-1 rounded-lg bg-surface px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 ${
                      regexError ? 'ring-1 ring-red-400' : 'focus:ring-primary/30'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRule(pi, ri)}
                    className="shrink-0 rounded p-1 text-muted-foreground/60 hover:text-red-400 transition"
                    aria-label={t('settings.removeRule')}
                  >
                    <RiCloseLine size={12} />
                  </button>
                </div>
                {regexError && (
                  <p className="px-1 text-[10px] text-red-400">{regexError}</p>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="text"
                    value={rule.status}
                    onChange={(e) => updateRule(pi, ri, 'status', e.target.value)}
                    placeholder={t('settings.statusPlaceholder')}
                    className="w-20 shrink-0 rounded-lg bg-surface px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  {presetColors.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => updateRule(pi, ri, 'color', c.value)}
                      className={`h-5 w-5 rounded-full border transition ${
                        rule.color === c.value ? 'border-foreground ring-1 ring-foreground/30 scale-110' : 'border-transparent hover:scale-110'
                      }`}
                      style={{ backgroundColor: c.value }}
                      title={c.label}
                    />
                  ))}
                  <input
                    type="color"
                    value={rule.color || '#4ade80'}
                    onChange={(e) => updateRule(pi, ri, 'color', e.target.value)}
                    className="h-5 w-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
                    title={t('settings.customColor')}
                  />
                  <select
                    value={rule.indicator || 'pulse'}
                    onChange={(e) => updateRule(pi, ri, 'indicator', e.target.value)}
                    className="rounded-lg bg-surface px-2 py-1.5 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-primary/30"
                    title={t('settings.tabIndicator')}
                  >
                    {INDICATOR_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-1 rounded-lg bg-surface px-2 py-1.5 text-[11px] text-muted-foreground">
                    {t('settings.keepLabel')}
                    <input
                      type="number"
                      min={80}
                      max={10000}
                      step={100}
                      value={rule.clearDelayMs ?? 450}
                      onChange={(e) => updateRule(pi, ri, 'clearDelayMs', Number(e.target.value))}
                      className="w-14 bg-transparent text-foreground outline-none"
                    />
                    ms
                  </label>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => addRule(pi)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-surface-elevated hover:text-foreground transition"
          >
            <RiAddLine size={12} /> {t('settings.addPattern')}
          </button>
        </div>
      ))}

      {/* Bottom actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={addProgram}
          className="flex items-center gap-1.5 rounded-full bg-primary/15 px-4 py-2 text-xs font-medium text-primary hover:bg-primary/25 transition"
        >
          <RiAddLine size={14} /> {t('settings.addProgram')}
        </button>
        <button
          type="button"
          onClick={onResetDefaults}
          className="flex items-center gap-1.5 rounded-full bg-surface-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground transition"
        >
          <RiResetLine size={14} /> {t('settings.resetDefaults')}
        </button>
      </div>
    </div>
  );
}

export { AgentRulesSettings };
