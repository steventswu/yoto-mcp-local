import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { TokenStore, type Tokens } from './token-store.js';
import type { Config } from './config.js';

interface PendingAuth {
  state: string;
  verifier: string;
  redirectUri: string;
  server: Server;
  code: Promise<string>;
  resolveCode: (code: string) => void;
  rejectCode: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class AuthManager {
  private pending?: PendingAuth;

  constructor(private readonly config: Config, private readonly store: TokenStore) {}

  async start(): Promise<{ url: string; redirectUri: string }> {
    if (this.pending) throw new Error('An authentication flow is already pending. Complete it first.');

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    const redirectUri = `http://127.0.0.1:${this.config.redirectPort}/callback`;

    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid state');
        return;
      }
      const authorizationCode = url.searchParams.get('code');
      if (!authorizationCode) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Missing authorization code');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Yoto login complete. You may close this tab.');
      resolveCode(authorizationCode);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.redirectPort, '127.0.0.1', () => resolve());
    });

    const timeout = setTimeout(() => {
      rejectCode(new Error('Authentication timed out'));
      if (this.pending?.server === server) this.pending = undefined;
      server.close();
    }, 5 * 60_000);
    this.pending = { state, verifier, redirectUri, server, code, resolveCode, rejectCode, timeout };
    const authUrl = new URL(`https://${this.config.authDomain}/authorize`);
    authUrl.search = new URLSearchParams({
      audience: this.config.audience,
      scope: this.config.enableWrites
        ? 'user:content:manage family:devices:view offline_access profile'
        : 'user:content:view family:devices:view offline_access profile',
      response_type: 'code',
      client_id: this.config.clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      state,
    }).toString();
    return { url: authUrl.toString(), redirectUri };
  }

  async complete(): Promise<{ email?: string; name?: string }> {
    const pending = this.pending;
    if (!pending) throw new Error('No authentication flow is pending. Call yoto_auth_start first.');

    try {
      const code = await pending.code;
      const response = await fetch(`https://${this.config.authDomain}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          code,
          code_verifier: pending.verifier,
          redirect_uri: pending.redirectUri,
        }),
      });
      if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
      const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!body.access_token || !body.refresh_token || !body.expires_in) throw new Error('Yoto did not return complete tokens');

      const profile = await this.fetchProfile(body.access_token);
      await this.store.save({
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + body.expires_in * 1000,
        email: profile.email,
        name: profile.name,
      });
      return profile;
    } finally {
      clearTimeout(pending.timeout);
      await new Promise<void>((resolve) => pending.server.close(() => resolve()));
      this.pending = undefined;
    }
  }

  async accessToken(): Promise<string> {
    const current = await this.store.load();
    if (!current?.refreshToken) throw new Error('Not authenticated. Call yoto_auth_start first.');
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken;

    const response = await fetch(`https://${this.config.authDomain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: current.refreshToken,
      }),
    });
    if (!response.ok) throw new Error(`Token refresh failed (${response.status})`);
    const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in) throw new Error('Yoto refresh response was incomplete');
    await this.store.save({
      ...current,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
    });
    return body.access_token;
  }

  async status(): Promise<{ authenticated: boolean; email?: string; name?: string }> {
    const current = await this.store.load();
    return { authenticated: Boolean(current?.refreshToken), email: current?.email, name: current?.name };
  }

  async logout(): Promise<void> {
    await this.store.clear();
  }

  private async fetchProfile(accessToken: string): Promise<{ email?: string; name?: string }> {
    const response = await fetch(`https://${this.config.authDomain}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Profile request failed (${response.status})`);
    const profile = await response.json() as { email?: string; name?: string };
    return { email: profile.email, name: profile.name };
  }
}
