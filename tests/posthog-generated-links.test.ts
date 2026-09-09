import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeRevision} from '../src/lib/links';
import {postHogAggregateQueries,postHogAttributionExpressions,postHogScopeProfile,POSTHOG_ANALYTICS_VERSION} from '../src/connectors/posthog-analytics';

const from='2026-06-30T22:00:00Z',to='2026-07-31T22:00:00Z';
const schema={sessionIdAvailable:true,questionNumberProperty:'numero' as const};
test('Generated organic placements belong to the explicit organic query category',()=>{
 const expression=postHogAttributionExpressions().sourceClass;
 const organic=expression.match(/IN \(([^)]+)\),'organic'/)![1];
 for(const placement of ['instagram_bio','youtube_description','email'] as const){
  const link=makeRevision({placement,destination:'quiz',campaign:'Summer discovery',label:'One link'});
  const medium=new URL(link.generated_url).searchParams.get('utm_medium');
  assert.ok(medium);assert.ok(organic.split(',').includes(`'${medium}'`),`${placement}: ${medium}`);
 }
});
test('Every campaign query reads generated Meta IDs before the named UTM campaign',()=>{
 const link=makeRevision({placement:'meta_ad',destination:'quiz',campaign:'Summer discovery',label:'One ad'});
 const params=new URL(link.generated_url.replace('{{campaign.id}}','12345').replace('{{adset.id}}','67890').replace('{{ad.id}}','99999')).searchParams;
 assert.equal(params.get('meta_campaign_id'),'12345');assert.equal(params.get('utm_campaign'),'summer-discovery');
 const expressions=postHogAttributionExpressions();
 assert.ok(expressions.campaignId.indexOf('properties.meta_campaign_id')<expressions.campaignId.indexOf('properties.campaign_id'));
  assert.ok(expressions.campaignId.indexOf('properties.campaign_id')<expressions.campaignId.indexOf('properties.utm_campaign'));
 assert.ok(expressions.campaignId.includes("extractURLParameter(coalesce(toString(properties.$current_url), ''), 'meta_campaign_id')"));
 assert.ok(expressions.sourceClass.includes("extractURLParameter(coalesce(toString(properties.$current_url), ''), 'utm_medium')"));
 assert.match(expressions.campaignId,/'\^\[0-9\]\{1,30\}\$'/);
 for(const sql of Object.values(postHogAggregateQueries(from,to,schema,{source:'paid',campaignId:params.get('meta_campaign_id')}))){
  assert.ok(sql?.includes(`${expressions.campaignId} = '12345'`));assert.ok(sql?.includes(`${expressions.sourceClass} = 'paid'`));
 }
});
test('New attribution semantics produce new exact report and cache identities',()=>{
 assert.equal(POSTHOG_ANALYTICS_VERSION,'posthog-production-aggregates-v2');
 for(const scope of [{source:'all' as const,campaignId:null},{source:'organic' as const,campaignId:null},{source:'paid' as const,campaignId:'12345'}]){
  const profile=postHogScopeProfile(scope);assert.ok(profile.startsWith(POSTHOG_ANALYTICS_VERSION));assert.ok(!profile.includes('aggregates-v1'));
 }
 assert.notEqual(postHogScopeProfile({source:'paid',campaignId:'12345'}),postHogScopeProfile({source:'paid',campaignId:'67890'}));
});
