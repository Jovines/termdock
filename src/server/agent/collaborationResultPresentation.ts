/** Display explicit author summaries or labelled paragraphs; never invent conclusions. */
export function collaborationResultPresentation(content: string, summary?: string) {
  const paragraphs = content.trim().split(/\n\s*\n/);
  const labelled = (label: RegExp) => {
    const index = paragraphs.findIndex(p => label.test(p.trim()));
    if (index < 0) return '';
    const body = paragraphs[index].trim().replace(label, '').trim();
    return body || paragraphs[index + 1]?.trim() || '';
  };
  const conclusion = summary?.trim() || labelled(/^(?:#{1,6}\s*)?(?:结论|Summary|Conclusion|结果摘要)(?:[：:]\s*|\s*$)/i);
  const limitations = labelled(/^(?:#{1,6}\s*)?(?:限制与变更|限制|Limitations)(?:[：:]\s*|\s*$)/i);
  return { summary: conclusion || content.trim(), limitations: conclusion ? limitations : '', condensed: !!conclusion && conclusion !== content.trim(), explicit: !!summary?.trim() };
}
