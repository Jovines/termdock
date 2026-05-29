import {
  Plus as RiAddLine,
  Trash2 as RiDeleteBinLine,
  X as RiCloseLine,
  RotateCcw as RiResetLine,
} from 'lucide-react';
import type { AgentProgramConfig, AgentRule } from '../../terminal/api';

const PRESET_COLORS = [
  { value: '#4ade80', label: 'Green' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#f87171', label: 'Red' },
  { value: '#60a5fa', label: 'Blue' },
  { value: '#c084fc', label: 'Purple' },
  { value: '#fb923c', label: 'Orange' },
  { value: '#888888', label: 'Gray' },
];

interface AgentRulesSettingsProps {
  rules: AgentProgramConfig[];
  onChange: (rules: AgentProgramConfig[]) => void;
  onResetDefaults: () => void;
}

function AgentRulesSettings({ rules, onChange, onResetDefaults }: AgentRulesSettingsProps) {
  const addProgram = () => {
    onChange([...rules, { program: '', rules: [{ pattern: '', status: 'running' }] }]);
  };

  const removeProgram = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const updateProgram = (index: number, field: 'program', value: string) => {
    onChange(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const addRule = (progIndex: number) => {
    onChange(rules.map((r, i) =>
      i === progIndex ? { ...r, rules: [...r.rules, { pattern: '', status: 'running' }] } : r
    ));
  };

  const removeRule = (progIndex: number, ruleIndex: number) => {
    onChange(rules.map((r, i) =>
      i === progIndex ? { ...r, rules: r.rules.filter((_, ri) => ri !== ruleIndex) } : r
    ));
  };

  const updateRule = (progIndex: number, ruleIndex: number, field: keyof AgentRule, value: string) => {
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
      return 'Invalid regex';
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
              value={prog.program}
              onChange={(e) => updateProgram(pi, 'program', e.target.value)}
              placeholder="Program name (e.g. claude)"
              className="flex-1 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/30"
            />
            <button
              type="button"
              onClick={() => removeProgram(pi)}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-surface-elevated hover:text-red-400 transition"
              aria-label="Remove program"
            >
              <RiDeleteBinLine size={14} />
            </button>
          </div>

          {/* Rules list */}
          {prog.rules.map((rule, ri) => {
            const regexError = validateRegex(rule.pattern);
            return (
              <div key={ri} className="flex items-start gap-2 pl-2">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={rule.pattern}
                      onChange={(e) => updateRule(pi, ri, 'pattern', e.target.value)}
                      placeholder="Regex pattern (e.g. Thinking|Generating)"
                      className={`flex-1 rounded-lg bg-surface px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 ${
                        regexError ? 'ring-1 ring-red-400' : 'focus:ring-primary/30'
                      }`}
                    />
                    <input
                      type="text"
                      value={rule.status}
                      onChange={(e) => updateRule(pi, ri, 'status', e.target.value)}
                      placeholder="Status"
                      className="w-20 shrink-0 rounded-lg bg-surface px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/30"
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() => updateRule(pi, ri, 'color', c.value)}
                          className={`h-4 w-4 rounded-full border transition ${
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
                        className="h-4 w-4 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
                        title="Custom color"
                      />
                    </div>
                  </div>
                  {regexError && (
                    <p className="px-1 text-[10px] text-red-400">{regexError}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeRule(pi, ri)}
                  className="mt-1 shrink-0 rounded p-1 text-muted-foreground/60 hover:text-red-400 transition"
                  aria-label="Remove rule"
                >
                  <RiCloseLine size={12} />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => addRule(pi)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-surface-elevated hover:text-foreground transition"
          >
            <RiAddLine size={12} /> Add pattern
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
          <RiAddLine size={14} /> Add program
        </button>
        <button
          type="button"
          onClick={onResetDefaults}
          className="flex items-center gap-1.5 rounded-full bg-surface-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground transition"
        >
          <RiResetLine size={14} /> Reset defaults
        </button>
      </div>
    </div>
  );
}

export { AgentRulesSettings };
