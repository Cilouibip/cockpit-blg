import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRevision,linkMutationSchema,linkInputSchema } from '../src/lib/links';
const input={placement:'instagram_bio' as const,destination:'quiz' as const,campaign:'Septembre',label:'La bio Instagram'};
test('révision opaque distincte et attribution exacte de la bio, sans identité',()=>{const a=makeRevision(input);const b=makeRevision({...input,label:'Nouvelle bio'},a.link_id,2);assert.notEqual(a.id,b.id);assert.equal(new URL(a.generated_url).hostname,'quizz.blg-studio.fr');assert.equal(new URL(a.generated_url).searchParams.get('utm_term'),'instagram_bio');assert.equal(new URL(a.generated_url).searchParams.get('blg_link_id'),a.id);assert.notEqual(a.generated_url,b.generated_url);});
test('paramètres Meta dynamiques conservés; aucune URL arbitraire ni propriété privée',()=>{const r=makeRevision({...input,placement:'meta_ad'});assert.match(r.generated_url,/meta_ad_id=\{\{ad.id\}\}/);assert.throws(()=>linkInputSchema.parse({...input,destination_url:'https://evil.example'}));assert.throws(()=>linkInputSchema.parse({...input,email:'private@example.com'}));});
test('révision exige la version lue pour éviter les écrasements concurrents',()=>{assert.throws(()=>linkMutationSchema.parse({action:'revise',id:crypto.randomUUID(),input}));});
