import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationFor, listLinks, makeRevision } from '../src/lib/links';
import type { Database, Row, TableName } from '../src/lib/db';

const masterclass={placement:'meta_ad' as const,destination:'masterclass' as const,campaign:'Lancement septembre',label:'Vidéo Meta'};
const fixed={linkId:'11111111-1111-4111-8111-111111111111',revisionId:'22222222-2222-4222-8222-222222222222',now:'2026-09-09T12:00:00.000Z'};

test('Masterclass conserve exactement la destination historique sans configuration et lit la nouvelle pour une révision créée',()=>{
  const historic=makeRevision(masterclass,fixed.linkId,1,fixed.revisionId,fixed.now,{});
  const current=makeRevision(masterclass,fixed.linkId,2,'33333333-3333-4333-8333-333333333333',fixed.now,{BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/nouvelle-masterclass'});
  assert.equal(historic.destination_url,'https://www.blg-studio.fr/blg-rugby-mc');
  assert.equal(current.destination_url,'https://www.blg-studio.fr/nouvelle-masterclass');
  assert.equal(new URL(current.generated_url).pathname,'/nouvelle-masterclass');
  assert.equal(new URL(current.generated_url).searchParams.get('utm_campaign'),'lancement-septembre');
  assert.match(current.generated_url,/meta_campaign_id=\{\{campaign.id\}\}/);
  assert.match(current.generated_url,/meta_adset_id=\{\{adset.id\}\}/);
  assert.match(current.generated_url,/meta_ad_id=\{\{ad.id\}\}/);
  assert.equal(new URL(current.generated_url).searchParams.get('blg_link_id'),current.id);
});

test('Une configuration Masterclass invalide est refusée sans empêcher une révision Quiz',()=>{
  for(const value of ['http://www.blg-studio.fr/nouvelle-masterclass','https://evil.example/path','https://www.blg-studio.fr/path?x=1','https://user@www.blg-studio.fr/path','https://www.blg-studio.fr/path#section'])assert.throws(()=>destinationFor('masterclass',{BLG_MASTERCLASS_URL:value}));
  const quiz=makeRevision({placement:'email',destination:'quiz',campaign:'Septembre',label:'Newsletter'},fixed.linkId,1,fixed.revisionId,fixed.now,{BLG_MASTERCLASS_URL:'https://evil.example/path'});
  assert.equal(quiz.destination_url,'https://quizz.blg-studio.fr/');
});

test('La lecture conserve les URLs persistées des révisions anciennes',async()=>{
  const historic=makeRevision(masterclass,fixed.linkId,1,fixed.revisionId,fixed.now,{});
  const db:Database={
    select:async(table:TableName):Promise<Row[]>=>table==='tracked_links'?[{id:fixed.linkId,archived_at:null}]:table==='link_revisions'?[historic]:[],
    upsert:async()=>{},rpc:async<T>()=>undefined as T,probe:async()=>{}
  };
  const links=await listLinks(db,'live');
  assert.equal(links.links[0].current.url,historic.generated_url);
  assert.equal(links.links[0].current.url.includes('/blg-rugby-mc'),true);
});
