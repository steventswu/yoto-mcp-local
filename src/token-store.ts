import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  name?: string;
}

export class TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Tokens | undefined> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as Tokens;
      await chmod(this.filePath, 0o600);
      return this.validate(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Token file is unreadable or invalid. Delete it and authenticate again.');
    }
  }

  async save(tokens: Tokens): Promise<void> {
    this.validate(tokens);
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  private validate(data: Tokens): Tokens {
    if (!data || typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string' ||
        typeof data.expiresAt !== 'number') {
      throw new Error('invalid token record');
    }
    return data;
  }
}
