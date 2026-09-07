import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, authenticate, verifySession, cookieHeader, requireOrigin, requireUser } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
import { readBody } from '../src/lib/http';
const hash=passwordHash('a-strong-test-password');
const config=getConfig({APP_ORIGIN:'https://cockpit.example.com',COCKPIT_SESSION_SECRET:'test-session-secret-with-more-than-32-characters',COCKPIT_PASSWORD_HASH:hash});
test('accès privé; mauvais mot de passe et session falsifiée refusés',()=>{
  assert.throws(()=>authenticate('wrong',config));
  const token=authenticate('a-strong-test-password',config);assert.equal(verifySession(token,config),'private');assert.equal(verifySession(token+'x',config),null);assert.equal(verifySession(token,config,Date.now()+9*3600000),null);
  assert.match(cookieHeader(token,config),/HttpOnly; SameSite=Strict/);assert.match(cookieHeader(token,config),/Secure/);
});
test('rotation du mot de passe révoque les sessions et suppression compte aussi',()=>{
  const token=authenticate('a-strong-test-password',config);
  assert.equal(verifySession(token,{...config,passwordHash:passwordHash('changed-test-password')}),null);
  assert.equal(verifySession(token,{...config,passwordHash:''}),null);
});
test('aucune route privée sans cookie et écriture externe bloquée',()=>{
  assert.throws(()=>requireUser(new Request('https://cockpit.example.com/api/prospects'),config));
  assert.throws(()=>requireOrigin(new Request('https://cockpit.example.com/api/links',{method:'POST',headers:{origin:'https://evil.example'}}),config));
  assert.throws(()=>requireOrigin(new Request('https://cockpit.example.com/api/links',{method:'POST'}),config));
  requireOrigin(new Request('https://cockpit.example.com/api/links',{method:'POST',headers:{origin:config.origin}}),config);
});
test('démo interdite sur Vercel ou base distante, configuration sans secrets fermée',()=>{
  assert.throws(()=>getConfig({COCKPIT_MODE:'demo',VERCEL:'1'}));assert.throws(()=>getConfig({COCKPIT_MODE:'demo',DATABASE_URL:'postgres://example.com/cockpit_demo'}));assert.equal(getConfig({}).passwordHash,'');
});
test('taille réelle du corps bornée même sans content-length; JSON seulement',async()=>{
  await assert.rejects(()=>readBody(new Request('https://example.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(200)})}),100));
  await assert.rejects(()=>readBody(new Request('https://example.com',{method:'POST',body:'hello'})));
});
