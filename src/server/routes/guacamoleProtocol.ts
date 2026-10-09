export function guacamoleInstruction(...values: string[]): string {
  return values.map(value => `${Array.from(value).length}.${value}`).join(',') + ';';
}

/** Incremental UTF-8-decoded Guacamole parser. Lengths count Unicode code points. */
export class GuacamoleParser {
  private digits = '';
  private remaining = 0;
  private value = '';
  private values: string[] = [];
  private phase: 'length' | 'value' | 'separator' = 'length';
  private size = 0;
  constructor(private instruction: (values: string[]) => void) {}
  receive(chunk: string): void {
    for (const char of chunk) {
      if (++this.size > 2 * 1024 * 1024) throw new Error('GUAC_INSTRUCTION_LIMIT');
      if (this.phase === 'length') {
        if (/^[0-9]$/.test(char) && this.digits.length < 7) this.digits += char;
        else if (char === '.' && this.digits) {
          this.remaining = Number(this.digits); this.digits = '';
          if (this.remaining > 1024 * 1024) throw new Error('GUAC_ELEMENT_LIMIT');
          this.phase = this.remaining ? 'value' : 'separator';
        } else throw new Error('GUAC_INVALID_LENGTH');
      } else if (this.phase === 'value') {
        this.value += char;
        if (--this.remaining === 0) this.phase = 'separator';
      } else {
        if (char !== ',' && char !== ';') throw new Error('GUAC_INVALID_SEPARATOR');
        this.values.push(this.value); this.value = ''; this.phase = 'length';
        if (this.values.length > 256) throw new Error('GUAC_ARGUMENT_LIMIT');
        if (char === ';') {
          const values = this.values; this.values = []; this.size = 0;
          this.instruction(values);
        }
      }
    }
  }
}
