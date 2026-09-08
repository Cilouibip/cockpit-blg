/** Public UI payloads. All commercial endpoints require a private session. */
export type DataMode = 'demo' | 'live';
export type SourceFilter = 'all' | 'paid' | 'organic' | 'unknown';
export type TunnelFilter = 'all' | 'quiz' | 'masterclass';
/** from and to are inclusive local dates in Europe/Paris. */
export type DashboardFilters = { from: string; to: string; source: SourceFilter; tunnel: TunnelFilter; campaign: string; compare: boolean };
export type SourceAttempt = {status:string;startedAt:string|null;finishedAt:string|null};
export type Metric = {
  id: string; label: string; value: number | null; unit: 'eur' | 'count' | 'percent' | 'ratio' | 'seconds';
  previous?: number | null; source: string; definition: string; coverage: string; updatedAt: string | null;
  numerator?: number | null; denominator?: number | null; unavailableReason?: string;
  /** A partial value is a known subtotal, never the exhaustive selected total. */
  completeness?: 'complete' | 'partial';
  missingDays?: string[]; provisionalDays?: string[]; latestAttempt?: SourceAttempt | null;
};
export type DetailRow = { id: string; label: string; source: string; leads: number | null; appointments: number | null; clients: number | null; spend: number | null; coverage: string };
export type Pagination = { page: number; pageSize: number; total: number };
export type DetailsResponse = { details: DetailRow[]; pagination: Pagination };
export type ProspectsQuery = { search: string; stage: string; page: number };
export type JourneyStep = { id: string; label: string; value: number | null; denominator?: number | null; source: string; coverage: string };
export type DashboardResponse = {
  mode: DataMode; generatedAt: string; period: { from: string; to: string; timezone: string }; comparisonLabel?: string;
  metrics: Metric[]; series: { date: string; revenue: number | null; spend: number | null }[];
  pillars: { id: string; title: string; description: string; metrics: Metric[] }[];
  journeys: { id: string; title: string; description: string; steps: JourneyStep[] }[];
  details: DetailRow[]; detailsPagination?: Pagination; campaigns: { id: string; label: string }[]; notices: string[];
};
export type LinkPlacement = 'instagram_bio' | 'youtube_description' | 'meta_ad' | 'email' | 'other';
export type LinkInput = { placement: LinkPlacement; destination: 'quiz' | 'masterclass'; campaign: string; label: string };
export type LinkRevision = { id: string; version: number; url: string; createdAt: string; placement: LinkPlacement; destination: 'quiz' | 'masterclass'; campaign: string; label: string };
export type TrackedLink = { id: string; archived: boolean; current: LinkRevision; revisions: LinkRevision[] };
export type LinksResponse = { mode: DataMode; links: TrackedLink[]; persistent: boolean; notice?: string };
/** POST /api/links = LinkInput; PATCH /api/links = one of these commands. Response = LinksResponse. */
export type LinkMutation = { action: 'revise'; id: string; expectedVersion: number; input: LinkInput } | { action: 'archive' | 'restore'; id: string; expectedVersion: number };
export type Prospect = {
  id: string; name: string; owner: string | null; stage: string; source: string | null; tunnel: string | null;
  appointmentAt: string | null; appointmentStatus: 'planned' | 'attended' | 'no_show' | 'cancelled' | 'rescheduled' | 'unknown';
  followUpAt: string | null; outcome: string | null; updatedAt: string | null;
};
export type ProspectsResponse = { mode: DataMode; prospects: Prospect[]; updatedAt: string | null; coverage: string; notice?: string; pagination?: Pagination; stages?: string[] };
export type Connection = {
  id: string; name: string; status: 'connected' | 'partial' | 'missing' | 'error' | 'demo';
  summary: string; lastSyncAt: string | null; coverage: string; limits: string[]; canSync: boolean;
};
export type ConnectionsResponse = { mode: DataMode; connections: Connection[] };
export type ApiError = { error: string; code: string };
