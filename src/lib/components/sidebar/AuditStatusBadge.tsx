import type { ReactNode } from 'react';
import { Sparkles, TriangleAlert } from 'lucide-react';
import type { ChangeAuditRecord } from '../../terminal/api';

export interface AuditStatus {
  explained: number;
  stale: number;
}

function auditPathMatches(pathValue: string, filePath: string): boolean {
  return pathValue === filePath
    || filePath.endsWith(`/${pathValue}`)
    || pathValue.endsWith(`/${filePath}`);
}

function buildAuditLookupKey(repoRoot: string | null | undefined, filePath: string): string {
  return `${repoRoot ?? ''}\u0000${filePath}`;
}

export function getFileAuditStatus(
  records: ChangeAuditRecord[] | undefined,
  repoRoot: string | null | undefined,
  filePath: string,
): AuditStatus {
  if (!records || records.length === 0 || !filePath) return { explained: 0, stale: 0 };
  const lookupKey = buildAuditLookupKey(repoRoot, filePath);
  let explained = 0;
  let stale = 0;
  for (const record of records) {
    const paths = [record.filePath, record.newPath, record.oldPath]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const pathMatches = paths.some((pathValue) => buildAuditLookupKey(record.repoRoot, pathValue) === lookupKey)
      || paths.some((pathValue) => auditPathMatches(pathValue, filePath));
    if (!pathMatches) continue;
    explained += 1;
  }
  return { explained, stale };
}

export function AuditStatusBadge({ status }: { status?: AuditStatus | null }) {
  if (!status) return null;
  const stale = status.stale > 0 && status.explained === 0;
  const hasAudit = status.explained > 0 || status.stale > 0;
  if (!hasAudit) return null;
  const title = stale
    ? 'AI audit explanation is stale'
    : 'AI audit explanation available';
  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
        stale
          ? 'bg-[color:var(--warning)]/15 text-[color:var(--warning)]'
          : 'bg-accent/10 text-accent'
      }`}
      title={title}
      aria-label={title}
    >
      {stale ? <TriangleAlert size={10} /> : <Sparkles size={10} />}
    </span>
  );
}

export function ChangeStatusWithAuditBadge({
  changeStatus,
  auditStatus,
  renderChangeBadge,
}: {
  changeStatus: string;
  auditStatus?: AuditStatus | null;
  renderChangeBadge: (status: string) => ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {renderChangeBadge(changeStatus)}
      <AuditStatusBadge status={auditStatus} />
    </span>
  );
}
