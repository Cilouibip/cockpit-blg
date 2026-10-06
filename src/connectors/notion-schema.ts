import { createHash } from 'node:crypto';
import { BLG_NOTION_PROPERTY_IDS, BLG_NOTION_PROPERTY_TYPES, notionPropertyIdentity, type CommercialField, type NotionConfig } from './notion';
import { ConnectorError, object, readJson } from './http';

// Reviewed formula: only this page's status property affects attendance.
// An unreviewed formula disables deltas and keeps the existing complete-inventory fallback.
const attendanceFormula = 'if(prop("Etat")=="Noshow",style("Noshow","b","red"),if(prop("Etat")=="Ancien client" OR prop("Etat")=="RDV Terminé" OR prop("Etat")=="Closé" OR prop("Etat")=="Perdu" OR prop("Etat")=="À relancer" OR prop("Etat")=="Plus de réponses" OR prop("Etat")=="Plus tard",style("Show up","b","green"),""))';
type Property = { name: string; shape: Record<string, unknown>; id: string };

/** Whitespace outside strings is cosmetic; whitespace inside a source value is not.
 * Resolve prop(label) to its unique ID before comparison, so renames preserve meaning. */
function formulaIdentity(expression: string, properties: Property[]): string | null {
  const tokens = expression.match(/"(?:\\.|[^"\\])*"|OR(?=prop\s*\()|[A-Za-z_][A-Za-z_0-9]*|==|!=|>=|<=|[^\s]/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'prop') continue;
    if (tokens[i + 1] !== '(' || tokens[i + 3] !== ')') return null;
    let name: unknown;
    try { name = JSON.parse(tokens[i + 2]); } catch { return null; }
    const matches = properties.filter(property => property.name === name);
    if (matches.length !== 1) return null;
    tokens[i + 2] = JSON.stringify({ propertyId: matches[0].id });
    i += 3;
  }
  return JSON.stringify(tokens);
}

export interface NotionSchemaProof { digest: string; deltaSafe: boolean }
/** Metadata only. Stable reviewed IDs bind both schema validation and query projections. */
export async function readNotionBusinessSchema(config: Pick<NotionConfig, 'token' | 'dataSourceId' | 'fetcher'>): Promise<{ proof: NotionSchemaProof; fields: NotionConfig['fields'] }> {
  if (!config.dataSourceId || !/^[a-fA-F0-9-]{32,36}$/.test(config.dataSourceId)) throw new ConnectorError('INVALID_CONFIGURATION');
  const schema = object(await readJson(new URL(`https://api.notion.com/v1/data_sources/${config.dataSourceId}`), { headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03' } }, { fetcher: config.fetcher, attempts: 1, timeoutMs: 15000 }));
  if (String(schema.id).replace(/-/g, '') !== config.dataSourceId.replace(/-/g, '')) throw new ConnectorError('SOURCE_IDENTITY_MISMATCH');
  const properties: Property[] = Object.entries(object(schema.properties)).map(([label, value]) => {
    const shape = object(value);
    if (typeof shape.id !== 'string' || !shape.id) throw new ConnectorError('SOURCE_PROPERTY_ID_INVALID');
    if (shape.name !== undefined && shape.name !== label) throw new ConnectorError('SOURCE_PROPERTY_AMBIGUOUS');
    return { name: label, shape, id: notionPropertyIdentity(shape.id) };
  });
  const fields: NotionConfig['fields'] = {}, shapes: unknown[] = [];
  let deltaSafe = false;
  for (const [key, reviewedId] of Object.entries(BLG_NOTION_PROPERTY_IDS) as [CommercialField, string][]) {
    const matches = properties.filter(property => property.id === notionPropertyIdentity(reviewedId));
    if (!matches.length) throw new ConnectorError('SOURCE_PROPERTY_MISSING');
    if (matches.length !== 1) throw new ConnectorError('SOURCE_PROPERTY_AMBIGUOUS');
    const { shape: prop, id } = matches[0];
    if (typeof prop.type !== 'string' || !BLG_NOTION_PROPERTY_TYPES[key].includes(prop.type)) throw new ConnectorError('SOURCE_PROPERTY_TYPE_CHANGED');
    fields[key] = prop.id as string;
    let formula: unknown = null;
    if (key === 'attendanceGroup') {
      const expression = object(prop.formula).expression;
      if (typeof expression !== 'string' || !expression.trim()) throw new ConnectorError('SOURCE_FORMULA_INVALID');
      const identity = formulaIdentity(expression, properties);
      const reviewed = formulaIdentity(attendanceFormula, [{ name: 'Etat', id: notionPropertyIdentity(BLG_NOTION_PROPERTY_IDS.status), shape: {} }]);
      deltaSafe = identity !== null && identity === reviewed;
      // Preserve unknown expression changes in the digest, forcing a complete read.
      formula = identity ?? { unreviewedExpression: expression };
    }
    shapes.push([key, id, prop.type, formula, prop.relation ?? null]);
  }
  return { proof: { digest: createHash('sha256').update(JSON.stringify(shapes)).digest('hex'), deltaSafe }, fields };
}
