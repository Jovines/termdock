export const SESSION_ICONS = ['message', 'sparkles', 'bot', 'code', 'file', 'briefcase', 'lightbulb', 'rocket'] as const;
export interface SessionAppearance { name?: string; icon?: string }
export type SessionAppearances = Record<string, SessionAppearance>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validSessionIcon(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && ((SESSION_ICONS as readonly string[]).includes(value)
    || /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*)$/u.test(value));
}
export function validSessionAppearances(value: unknown, scope: unknown): value is SessionAppearances {
  if (!record(scope) || scope.kind !== 'sessions' || !Array.isArray(scope.sessionIds)) return false;
  const ids = scope.sessionIds;
  return record(value) && Object.keys(value).length <= 256 && Object.entries(value).every(([id, appearance]) =>
    ids.includes(id) && record(appearance) && Object.keys(appearance).length > 0 && Object.keys(appearance).every(key => ['name', 'icon'].includes(key))
    && (appearance.name === undefined || typeof appearance.name === 'string' && appearance.name.trim().length > 0 && appearance.name.length <= 80 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(appearance.name))
    && (appearance.icon === undefined || validSessionIcon(appearance.icon)));
}
export function restrictSessionAppearances(value: SessionAppearances | undefined, ids: string[]): SessionAppearances | undefined {
  return value && Object.fromEntries(Object.entries(value).filter(([id]) => ids.includes(id)));
}
