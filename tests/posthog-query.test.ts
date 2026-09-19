import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readPostHogQuery, PostHogQueryPending, type PostHogQueryContinuation } from '../src/connectors/posthog-query';

const config = () => ({ endpoint: new URL('https://eu.posthog.com'), projectId: '123', headers: { Authorization: 'Bearer synthetic-secret' }, query: 'SELECT 1', name: 'synthetic', deadline: Date.now() + 55_000, signal: new AbortController().signal, sleep: async () => {} });
test('une requête acceptée est relue jusqu’au résultat complet imbriqué', async () => {
  const calls: string[] = [];
  const result = { columns: ['alive'], results: [[1]], hasMore: false };
  const output = await readPostHogQuery({ ...config(), fetcher: async (url, init) => {
    calls.push(String(url));
    if (init?.method === 'POST') {
      assert.equal(JSON.parse(String(init.body)).refresh, 'force_async');
      return Response.json({ query_status: { id: 'query-1', team_id: 123, complete: false } }, { status: 202 });
    }
    return Response.json({ query_status: { id: 'query-1', team_id: 123, complete: calls.length > 2, ...(calls.length > 2 ? { results: result } : {}) } });
  } });
  assert.deepEqual(output, result);
  assert.deepEqual(calls, ['https://eu.posthog.com/api/projects/123/query/', 'https://eu.posthog.com/api/projects/123/query/query-1/', 'https://eu.posthog.com/api/projects/123/query/query-1/']);
});
test('un résultat immédiat reste compatible avec les mêmes contrôles en aval', async () => {
  const result = { columns: ['alive'], results: [[1]] };
  assert.deepEqual(await readPostHogQuery({ ...config(), fetcher: async () => Response.json(result) }), result);
  const complete = { ...result, query_status: { complete: true } };
  assert.deepEqual(await readPostHogQuery({ ...config(), fetcher: async () => Response.json(complete) }), complete);
});
test('les identifiants inattendus et erreurs amont ne deviennent jamais des résultats partiels', async () => {
  for (const [status, code] of [
    [{ id: '../../other', complete: false }, 'INVALID_POSTHOG_QUERY_ID'],
    [{ id: 'ok', team_id: 456, complete: false }, 'PROJECT_IDENTITY_MISMATCH'],
    [{ id: 'ok', error: true, error_message: 'sensitive response body', complete: true }, 'POSTHOG_QUERY_FAILED'],
    [{ id: 'ok', complete: true, results: { error: 'sensitive', results: [] } }, 'INVALID_POSTHOG_RESPONSE'],
  ] as const) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), fetcher: async () => { calls++; return Response.json({ query_status: status }); } }), { message: code });
    assert.equal(calls, 1);
  }
});
test('une requête qui reste en attente respecte son budget au lieu de publier des données vides', async () => {
  let now = 0, calls = 0;
  await assert.rejects(readPostHogQuery({ ...config(), deadline: 3_000, clock: () => now, sleep: async ms => { now += ms; }, fetcher: async () => {
    calls++; return Response.json({ query_status: { id: 'pending', complete: false } }, { status: 202 });
  } }), { message: 'POSTHOG_TIME_BUDGET' });
  assert.equal(calls, 2);
});
test('l’annulation d’une autre lecture interrompt la récupération en cours', async () => {
  const controller = new AbortController();
  const pending = readPostHogQuery({ ...config(), signal: controller.signal, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  controller.abort();
  await assert.rejects(pending, { message: 'POSTHOG_CANCELLED' });
});

test('un accusé perdu retrouve la requête initiale et une lecture 503 est reprise une seule fois', async () => {
  let posts = 0, gets = 0, id = '';
  const result = { columns: ['alive'], results: [[1]] };
  const output = await readPostHogQuery({ ...config(), fetcher: async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; id = JSON.parse(String(init.body)).client_query_id;
      assert.match(id, /^[a-f0-9-]{36}$/);
      throw new TypeError('fetch failed');
    }
    assert.equal(String(_url), `https://eu.posthog.com/api/projects/123/query/${id}/`);
    if (++gets === 1) return Response.json({}, { status: 503 });
    return Response.json({ query_status: { id, complete: true, results: result } });
  } });
  assert.deepEqual(output, result);
  assert.deepEqual({ posts, gets }, { posts: 1, gets: 2 });
});

test('un refus d’accès ne réessaie pas et une panne réseau persistante reste bornée', async () => {
  for (const status of [403, 503]) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), fetcher: async () => { calls++; return Response.json({}, { status }); } }));
    assert.equal(calls, status === 403 ? 1 : 3); // POST once, then GET at most twice.
  }
});


test('429 respects Retry-After, retries once, and refuses a retry beyond deadline',async()=>{
 let now=0,calls=0;const delays:number[]=[];
 const opts={...config(),clock:()=>now,deadline:10000,sleep:async(ms:number)=>{delays.push(ms);now+=ms;},fetcher:async()=>++calls===1?Response.json({}, {status:429,headers:{'Retry-After':'2'}}):Response.json({results:[]})};
 await readPostHogQuery(opts);assert.equal(calls,2);assert.deepEqual(delays,[2000]);
 calls=0;now=0;delays.length=0;
 await assert.rejects(readPostHogQuery({...opts,deadline:2000}));assert.equal(calls,1);assert.deepEqual(delays,[]);
});
test('network classification never exposes request secrets or raw upstream messages',async()=>{
 await assert.rejects(readPostHogQuery({...config(),fetcher:async()=>{throw Object.assign(new Error('private token URL'),{cause:{code:'ENOTFOUND'}});}}),{message:'POSTHOG_DNS_ERROR'});
});

test('un refus DNS avant envoi peut réessayer le POST, avec le même identifiant', async () => {
  const ids: string[] = [];
  const result = { results: [[1]] };
  assert.deepEqual(await readPostHogQuery({ ...config(), fetcher: async (_url, init) => {
    assert.equal(init?.method, 'POST'); ids.push(JSON.parse(String(init.body)).client_query_id);
    if (ids.length === 1) throw Object.assign(new Error('private'), { cause: { code: 'EAI_AGAIN' } });
    return Response.json(result);
  } }), result);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test('une inscription serveur retardée est récupérée sans réémettre le POST', async () => {
  let id = '', posts = 0, gets = 0;
  const result = { results: [[1]] };
  const output = await readPostHogQuery({ ...config(), fetcher: async (_url, init) => {
    if (init?.method === 'POST') { posts++; id = JSON.parse(String(init.body)).client_query_id; throw new TypeError('private'); }
    if (++gets < 3) return Response.json({}, { status: 404 });
    return Response.json({ query_status: { id, complete: true, results: result } });
  } });
  assert.deepEqual(output, result); assert.deepEqual({ posts, gets }, { posts: 1, gets: 3 });
});

test('une requête jamais acceptée reste un échec après trois recherches bornées', async () => {
  let posts = 0, gets = 0;
  await assert.rejects(readPostHogQuery({ ...config(), fetcher: async (_url, init) => {
    if (init?.method === 'POST') { posts++; throw new TypeError('private'); }
    gets++; return Response.json({}, { status: 404 });
  } }), { message: 'POSTHOG_TRANSPORT_ERROR' });
  assert.deepEqual({ posts, gets }, { posts: 1, gets: 3 });
});

const checkpoint = (): PostHogQueryContinuation => ({
  version: 1, id: 'initial-query', origin: 'https://eu.posthog.com', projectId: '123',
  queryHash: createHash('sha256').update('SELECT 1').digest('hex'), startedAt: 0,
});

test('une requête de 63 secondes aboutit par reprises courtes avec un seul POST', async () => {
  let now = 0, posts = 0, gets = 0, id = '';
  let resume: PostHogQueryContinuation | undefined;
  const result = { results: [[275]] };
  const checkpoints: PostHogQueryContinuation[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; id = JSON.parse(String(init.body)).client_query_id; }
    else { gets++; assert.equal(String(_url), `https://eu.posthog.com/api/projects/123/query/${id}/`); }
    return Response.json({ query_status: { id, complete: now >= 63_000, ...(now >= 63_000 ? { results: result } : {}) } });
  };
  let output: unknown;
  for (let invocation = 0; invocation < 5; invocation++) {
    const start = now;
    try {
      output = await readPostHogQuery({ ...config(), resumable: true, resume,
        onContinuation: c => { checkpoints.push(c); }, clock: () => now, deadline: start + 20_000,
        sleep: async ms => { now += ms; }, fetcher });
      break;
    } catch (error) {
      assert.ok(error instanceof PostHogQueryPending);
      assert.equal(error.code, 'POSTHOG_QUERY_PENDING');
      resume = error.continuation;
      assert.equal(resume.id, id); assert.equal(resume.startedAt, 0);
      assert.ok(now - start < 20_000);
      now += 5_000; // Next API invocation; no server request is left running locally.
    }
  }
  assert.deepEqual(output, result); assert.equal(posts, 1); assert.ok(gets > 1);
  assert.ok(checkpoints.length >= 1);
  assert.equal(JSON.stringify(resume).includes('SELECT'), false);
});

test('le POST sans accusé à la fin du budget donne un identifiant reprenable', async () => {
  let now = 0, posts = 0, id = '';
  const controller = new AbortController();
  let continuation: PostHogQueryContinuation | undefined;
  await assert.rejects(readPostHogQuery({ ...config(), signal: controller.signal, resumable: true,
    clock: () => now, deadline: 20_000, onContinuation: c => { continuation = c; },
    fetcher: async (_url, init) => {
      posts++; id = JSON.parse(String(init?.body)).client_query_id;
      now = 20_000; controller.abort(); throw new TypeError('private');
    },
  }), error => error instanceof PostHogQueryPending && error.continuation.id === id);
  assert.equal(posts, 1); assert.equal(continuation?.id, id);
  const result = { results: [[1]] };
  assert.deepEqual(await readPostHogQuery({ ...config(), resume: continuation, resumable: true,
    clock: () => now, deadline: now + 20_000, fetcher: async (_url, init) => {
      assert.equal(init?.method, 'GET'); return Response.json({ query_status: { id, complete: true, results: result } });
    },
  }), result);
});

test('la reprise refuse projet, hôte, SQL, âge et identifiant incorrects avant tout appel', async () => {
  for (const resume of [
    { ...checkpoint(), projectId: '456' }, { ...checkpoint(), origin: 'https://us.posthog.com' },
    { ...checkpoint(), queryHash: createHash('sha256').update('SELECT 2').digest('hex') },
    { ...checkpoint(), startedAt: -601_000 }, { ...checkpoint(), startedAt: 2 },
    { ...checkpoint(), id: '../../other' }, { ...checkpoint(), version: 2 },
  ]) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), clock: () => 1, resume: resume as PostHogQueryContinuation,
      fetcher: async () => { calls++; return Response.json({}); },
    }), { message: 'INVALID_POSTHOG_CONTINUATION' });
    assert.equal(calls, 0);
  }
});

test('une reprise absente ou renvoyant un autre ID ne lance aucun POST et ne publie rien', async () => {
  for (const kind of ['missing', 'wrong-id', 'bare-result']) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), resume: checkpoint(), clock: () => 1, deadline: 20_000,
      fetcher: async (_url, init) => {
        calls++; assert.equal(init?.method, 'GET');
        if (kind === 'missing') return Response.json({}, { status: 404 });
        if (kind === 'bare-result') return Response.json({ results: [[1]] });
        return Response.json({ query_status: { id: 'wrong', complete: true }, results: [[1]] });
      },
    }), { message: kind === 'missing' ? 'UPSTREAM_HTTP_ERROR' : kind === 'wrong-id' ? 'INVALID_POSTHOG_QUERY_ID' : 'INVALID_POSTHOG_RESPONSE' });
    assert.equal(calls, kind === 'missing' ? 3 : 1);
  }
});


test('persistence completes before POST and a failed checkpoint submits nothing',async()=>{
 for(const fails of [false,true]){let saved=false,posts=0;
  const operation=readPostHogQuery({...config(),onContinuation:async()=>{await new Promise(r=>setImmediate(r));if(fails)throw Error('synthetic checkpoint failure');saved=true;},fetcher:async()=>{posts++;assert.equal(saved,true);return Response.json({results:[]});}});
  if(fails)await assert.rejects(operation,/synthetic checkpoint failure/);else await operation;
  assert.equal(posts,fails?0:1);
 }
});
test('a deduplicated server ID is persisted before GET and replaces only the query identifier',async()=>{
 const saved:PostHogQueryContinuation[]=[];
 await readPostHogQuery({...config(),onContinuation:async c=>{await new Promise(r=>setImmediate(r));saved.push(c);},fetcher:async(url,init)=>{
  if(init?.method==='POST')return Response.json({query_status:{id:'deduplicated-server-id',complete:false}});
  assert.equal(saved.at(-1)?.id,'deduplicated-server-id');assert.match(String(url),/deduplicated-server-id/);
  return Response.json({query_status:{id:'deduplicated-server-id',complete:true,results:{results:[]}}});
 }});
 assert.equal(saved.length,2);assert.notEqual(saved[0].id,saved[1].id);
 assert.deepEqual({...saved[0],id:saved[1].id,registered:true},saved[1]);
});


test('three recovery slots survive two budget expirations and no fourth lookup can run',async()=>{
 let time=0,gets=0;let resume:PostHogQueryContinuation|undefined={...checkpoint(),startedAt:0};
 for(let invocation=0;invocation<3;invocation++){
  const start=time;
  const read=readPostHogQuery({...config(),resumable:true,resume,clock:()=>time,deadline:start+2500,sleep:async ms=>{time+=ms;},onContinuation:async c=>{resume=c;},fetcher:async(_url,init)=>{assert.equal(init?.method,'GET');gets++;return Response.json({}, {status:404});}});
  if(invocation<2)await assert.rejects(read,e=>e instanceof PostHogQueryPending);else await assert.rejects(read,{status:404});
 }
 assert.equal(gets,3);assert.equal(resume?.lookupAttempts,3);
 await assert.rejects(readPostHogQuery({...config(),resume,clock:()=>time,deadline:time+5000,sleep:async ms=>{time+=ms;},fetcher:async()=>assert.fail('fourth GET')}),{code:'POSTHOG_QUERY_MISSING'});
});
