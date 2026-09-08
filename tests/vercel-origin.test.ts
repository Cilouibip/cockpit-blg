import test from 'node:test';
import assert from 'node:assert/strict';
import {getConfig} from '../src/lib/config';
import {cookieHeader, requireOrigin} from '../src/lib/auth';

test('first Vercel production deployment uses its stable domain without APP_ORIGIN',()=>{
  const config=getConfig({VERCEL:'1',VERCEL_ENV:'production',VERCEL_PROJECT_PRODUCTION_URL:'cockpit.example.com',VERCEL_URL:'cockpit-build.vercel.app'});
  assert.equal(config.origin,'https://cockpit.example.com');
  assert.equal(config.local,false);
  assert.match(cookieHeader('test',config),/; Secure$/);
  assert.doesNotThrow(()=>requireOrigin(new Request(config.origin,{headers:{origin:config.origin}}),config));
  assert.throws(()=>requireOrigin(new Request(config.origin,{headers:{origin:'https://external.example.com'}}),config));
});

test('preview uses its deployment domain, never the production domain',()=>{
  const config=getConfig({VERCEL:'1',VERCEL_ENV:'preview',VERCEL_PROJECT_PRODUCTION_URL:'cockpit.example.com',VERCEL_URL:'cockpit-preview.vercel.app'});
  assert.equal(config.origin,'https://cockpit-preview.vercel.app');
});

test('explicit origin remains available and hosted deployments never silently use localhost',()=>{
  assert.equal(getConfig({VERCEL:'1',APP_ORIGIN:'https://custom.example.com'}).origin,'https://custom.example.com');
  assert.equal(getConfig({VERCEL:'1',VERCEL_ENV:'production',VERCEL_URL:'first.vercel.app'}).origin,'https://first.vercel.app');
  assert.throws(()=>getConfig({VERCEL:'1'}));
  assert.equal(getConfig({}).origin,'http://127.0.0.1:3100');
});
