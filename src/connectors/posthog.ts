import { ConnectorError, object, readJson, safeConnectorError } from './http';

export interface PostHogConfig { host?: string; projectId?: string; personalApiKey?: string; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> }
export async function probePostHog(config: PostHogConfig) {
  if (!config.host || !config.projectId || !config.personalApiKey) return { status: 'not_configured' as const, automaticFeed: false, detail: 'Connexion non configurée' };
  try {
    const host = new URL(config.host);
    // Private keys must not be sent to capture domains, arbitrary redirect hosts or local services.
    if (!['https://eu.posthog.com', 'https://us.posthog.com', 'https://app.posthog.com'].includes(host.origin) || host.username || host.password || !/^\d+$/.test(config.projectId)) throw new ConnectorError('INVALID_CONFIGURATION');
    const url = new URL(`/api/projects/${config.projectId}/`, host.origin);
    const result = object(await readJson(url, { method: 'GET', headers: { Authorization: `Bearer ${config.personalApiKey}` } }, config));
    if (String(result.id) !== config.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    return { status: 'connected' as const, automaticFeed: false, detail: 'Lecture du projet vérifiée ; raccord des événements non installé' };
  } catch (error) { return { status: 'failed' as const, automaticFeed: false, detail: safeConnectorError(error) }; }
}
