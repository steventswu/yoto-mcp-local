export const USER_ICONS_PATH = '/media/displayIcons/user/me';
export const PUBLIC_ICONS_PATH = '/media/displayIcons/user/yoto';

const DEFAULT_BASE_URL = 'https://api.yotoplay.com';
const DEFAULT_FALLBACK_TERMS = ['music-note', 'baby'];

export type IconSource = 'user' | 'public';

export interface IconCatalogEntry {
  mediaId: string;
  source: IconSource;
  title?: string;
  tags: string[];
  keywords: string[];
}

export interface IconCatalog {
  user: IconCatalogEntry[];
  public: IconCatalogEntry[];
}

export interface IconResolverOptions {
  accessToken: string | (() => string | Promise<string>);
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  fallbackTerms?: string[];
}

type DisplayIconPayload = {
  displayIcons?: Array<Record<string, unknown>>;
};

type IconResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type IconFetch = (input: string | URL, init?: RequestInit) => Promise<IconResponse>;

/**
 * Resolves track icons to existing Yoto media IDs.
 *
 * This resolver deliberately has no image/file upload path. It only reads the
 * user's existing icons and Yoto's public icon catalog, then returns a media ID.
 */
export class IconResolver {
  private catalogPromise: Promise<IconCatalog> | undefined;
  private readonly fetchImpl: IconFetch;
  private readonly baseUrl: string;
  private readonly fallbackTerms: string[];

  constructor(private readonly options: IconResolverOptions) {
    this.fetchImpl = (options.fetchImpl ?? fetch) as IconFetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fallbackTerms = options.fallbackTerms?.length
      ? options.fallbackTerms
      : DEFAULT_FALLBACK_TERMS;
  }

  /** Loads both catalogs once per resolver instance and shares concurrent loads. */
  async loadCatalog(): Promise<IconCatalog> {
    this.catalogPromise ??= this.fetchCatalog().catch((error: unknown) => {
      this.catalogPromise = undefined;
      throw error;
    });
    return this.catalogPromise;
  }

  /** Returns only the mediaId to place in a Yoto `yoto:#...` reference. */
  async resolveMediaId(title: string): Promise<string> {
    const catalog = await this.loadCatalog();
    const normalizedTitle = normalize(title);

    const userMatch = bestMatch(catalog.user, normalizedTitle);
    if (userMatch) return userMatch.mediaId;

    const publicMatch = bestMatch(catalog.public, normalizedTitle);
    if (publicMatch) return publicMatch.mediaId;

    const fallback = findFallback(catalog.user, catalog.public, this.fallbackTerms);
    if (fallback) return fallback.mediaId;

    throw new Error('No matching Yoto icon or music-note/baby fallback was found.');
  }

  private async fetchCatalog(): Promise<IconCatalog> {
    const accessToken = await resolveAccessToken(this.options.accessToken);
    if (!accessToken) throw new Error('Yoto access token is required to load icon catalogs.');

    const [user, publicIcons] = await Promise.all([
      this.fetchEndpoint(USER_ICONS_PATH, accessToken, 'user'),
      this.fetchEndpoint(PUBLIC_ICONS_PATH, accessToken, 'public'),
    ]);
    return { user, public: publicIcons };
  }

  private async fetchEndpoint(path: string, accessToken: string, source: IconSource): Promise<IconCatalogEntry[]> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Yoto ${source} icon catalog failed (${response.status}).`);

    const payload = await response.json() as DisplayIconPayload;
    if (!Array.isArray(payload.displayIcons)) {
      throw new Error(`Yoto ${source} icon catalog returned no displayIcons array.`);
    }

    return payload.displayIcons
      .map((icon) => normalizeEntry(icon, source))
      .filter((icon): icon is IconCatalogEntry => icon !== undefined);
  }
}

async function resolveAccessToken(
  accessToken: string | (() => string | Promise<string>),
): Promise<string> {
  return typeof accessToken === 'function' ? await accessToken() : accessToken;
}

function normalizeEntry(raw: Record<string, unknown>, source: IconSource): IconCatalogEntry | undefined {
  const mediaId = typeof raw.mediaId === 'string' ? raw.mediaId.trim() : '';
  if (!mediaId) return undefined;

  const title = stringValue(raw.title) ?? stringValue(raw.name);
  const tags = stringArray(raw.publicTags).concat(stringArray(raw.tags));
  const keywords = stringArray(raw.keywords).concat(stringArray(raw.searchKeywords));
  return { mediaId, source, ...(title ? { title } : {}), tags, keywords };
}

function bestMatch(entries: IconCatalogEntry[], title: string): IconCatalogEntry | undefined {
  if (!title) return undefined;
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, title) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0)?.entry;
}

function scoreEntry(entry: IconCatalogEntry, title: string): number {
  const titleTokens = tokenize(title);
  const entryTitle = normalize(entry.title ?? '');
  const entryTitleTokens = tokenize(entryTitle);
  const tagTokens = tokenize(entry.tags.join(' '));
  const keywordTokens = tokenize(entry.keywords.join(' '));
  const allTokens = new Set([...entryTitleTokens, ...tagTokens, ...keywordTokens]);
  const overlap = titleTokens.filter((token) => allTokens.has(token)).length;
  if (overlap === 0) return 0;

  let score = overlap * 10;
  if (entryTitle && (entryTitle === title || entryTitle.includes(title) || title.includes(entryTitle))) score += 100;
  score += titleTokens.filter((token) => entryTitleTokens.includes(token)).length * 5;
  score += titleTokens.filter((token) => tagTokens.includes(token)).length * 3;
  score += titleTokens.filter((token) => keywordTokens.includes(token)).length * 2;
  return score;
}

function findFallback(
  user: IconCatalogEntry[],
  publicIcons: IconCatalogEntry[],
  fallbackTerms: string[],
): IconCatalogEntry | undefined {
  const terms = fallbackTerms.map(normalize).filter(Boolean);
  for (const term of terms) {
    const userMatch = fallbackMatch(user, term);
    if (userMatch) return userMatch;
    const publicMatch = fallbackMatch(publicIcons, term);
    if (publicMatch) return publicMatch;
  }
  return undefined;
}

function fallbackMatch(entries: IconCatalogEntry[], term: string): IconCatalogEntry | undefined {
  return entries.find((entry) => {
    const searchable = [entry.title ?? '', ...entry.tags, ...entry.keywords].map(normalize);
    return searchable.some((value) => value === term || value.includes(term) || term.includes(value));
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  return normalize(value).split(' ').filter(Boolean);
}
