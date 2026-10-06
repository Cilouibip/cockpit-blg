import { ConnectorError, object } from './http';

/** Notion can return either encoded or decoded property IDs. Keep one identity in
 * the schema, page reader, normalizer and inventory; never normalize data values. */
export function notionPropertyIdentity(id: string): string {
  try { return decodeURIComponent(id); } catch { throw new ConnectorError('SOURCE_PROPERTY_ID_INVALID'); }
}
export function readNotionProperty(properties: Record<string, unknown>, name: string | undefined): Record<string, unknown> | null {
  if (!name) return null;
  const matches = Object.values(properties).map(object).filter(property => typeof property.id === 'string' && notionPropertyIdentity(property.id) === notionPropertyIdentity(name));
  if (matches.length > 1) throw new ConnectorError('SOURCE_PROPERTY_AMBIGUOUS');
  if (matches.length) return matches[0];
  return properties[name] ? object(properties[name]) : null;
}
