import { Bot, Briefcase, Code2, FileText, Lightbulb, MessageCircle, Rocket, Sparkles } from 'lucide-react';
import { validSessionIcon } from '../../server/shared/sessionAppearance';
const icons = { message: MessageCircle, sparkles: Sparkles, bot: Bot, code: Code2, file: FileText, briefcase: Briefcase, lightbulb: Lightbulb, rocket: Rocket };
export const sessionIconLabels = { message: '对话', sparkles: '灵感', bot: '智能体', code: '代码', file: '文档', briefcase: '工作', lightbulb: '想法', rocket: '项目' };
export function SessionIcon({ icon, size = 20 }: { icon?: string; size?: number }) {
  const Icon = icons[icon as keyof typeof icons];
  return Icon ? <Icon size={size} aria-hidden="true" /> : icon && validSessionIcon(icon) ? <span aria-hidden="true" className="leading-none" style={{ fontSize: size }}>{icon}</span> : <MessageCircle size={size} aria-hidden="true" />;
}
