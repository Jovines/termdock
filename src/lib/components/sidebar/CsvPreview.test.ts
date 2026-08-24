import { describe, expect, it } from 'vitest';
import { formatCsvAnnotation, parseCsv } from './CsvPreview';

describe('CSV preview', () => {
  it('parses quoted commas, escaped quotes, and newlines', () => {
    expect(parseCsv('名称,说明\nA,"逗号,内容"\nB,"双""引号"')).toEqual([
      ['名称', '说明'],
      ['A', '逗号,内容'],
      ['B', '双"引号'],
    ]);
  });

  it('formats a cell annotation with the complete record', () => {
    expect(formatCsvAnnotation('/work/bom.csv', ['功能', '状态'], ['主控', '候选'], 1, 1))
      .toBe('"表格标注: /work/bom.csv / 数据行: 2 / 列: 状态 / 值: 候选 / 记录: 功能=主控；状态=候选"');
  });
});
