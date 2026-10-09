import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computerLoginKey, type ComputerProfile } from '../shared/computerPreferences.js';

type RecordValue = { iv: string; tag: string; ciphertext: string };
/** Credentials are independent of ordinary settings, encrypted and owner-readable. */
export class ComputerCredentialStore {
  readonly file: string;
  readonly keyFile: string;
  constructor(private directory = join(homedir(), '.termdock')) {
    this.file = join(directory, 'computer-credentials.json');
    this.keyFile = join(directory, 'computer-credentials.key');
  }
  private id(profile: ComputerProfile) { return createHash('sha256').update(computerLoginKey(profile)).digest('hex'); }
  private records(): Record<string, RecordValue> {
    if (!existsSync(this.file)) return {};
    const bytes = readFileSync(this.file);
    if (bytes.length > 1024 * 1024) throw new Error('COMPUTER_CREDENTIALS_READ_FAILED');
    const data: unknown = JSON.parse(bytes.toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('COMPUTER_CREDENTIALS_READ_FAILED');
    return data as Record<string, RecordValue>;
  }
  private key(): Buffer {
    if (!existsSync(this.keyFile)) {
      if (existsSync(this.file)) throw new Error('COMPUTER_CREDENTIALS_KEY_MISSING');
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      try { writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const key = readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error('COMPUTER_CREDENTIALS_KEY_INVALID');
    chmodSync(this.keyFile, 0o600);
    return key;
  }
  private write(records: Record<string, RecordValue>) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(records), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  has(profile: ComputerProfile): boolean { return Boolean(this.records()[this.id(profile)]); }
  get(profile: ComputerProfile): string | null {
    const id = this.id(profile), record = this.records()[id];
    if (!record) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString();
  }
  save(profile: ComputerProfile, password: string) {
    if (!password || password.length > 1024 || password.includes('\0')) throw new Error('INVALID_COMPUTER_CREDENTIALS');
    const records = this.records(), id = this.id(profile), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv); cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    if (!records[id] && Object.keys(records).length >= 64) delete records[Object.keys(records)[0]];
    records[id] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    this.write(records);
  }
  forget(profile: ComputerProfile) {
    const records = this.records(), id = this.id(profile);
    if (!records[id]) return;
    delete records[id]; this.write(records);
  }
}
