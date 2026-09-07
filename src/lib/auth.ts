import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import { AppError } from './errors';
export const COOKIE_NAME = 'blg_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const equal = (a:string,b:string) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
export function passwordHash(password:string,salt=randomBytes(16).toString('hex')) {
  if (password.length<14 || password.length>256) throw new AppError('Utilise un mot de passe entre 14 et 256 caractères.');
  return `scrypt:${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function verifyPassword(password:string,hash:string) {
  const [,salt,digest]=hash.split(':');
  if (password.length>256 || !salt || !digest) return false;
  return equal(scryptSync(password,salt,64).toString('hex'),digest);
}
export function authReady(config:Config) { return config.sessionSecret.length>=32 && !!config.passwordHash; }
function sign(data:string,config:Config) { return createHmac('sha256',config.sessionSecret).update(data).digest('base64url'); }
export function issueSession(config:Config,now=Date.now()) {
  if (!authReady(config)) throw new AppError('Accès privé à configurer.',503,'access_setup');
  const data=Buffer.from(JSON.stringify({sub:'private',iat:now,exp:now+SESSION_MS,nonce:randomBytes(16).toString('hex'),credentialVersion:createHmac('sha256',config.sessionSecret).update(config.passwordHash).digest('hex')})).toString('base64url');
  return `${data}.${sign(data,config)}`;
}
export function verifySession(token:string|undefined,config:Config,now=Date.now()):string|null {
  if (!authReady(config) || !token || token.length>2048) return null;
  const parts=token.split('.'); if(parts.length!==2 || !equal(sign(parts[0],config),parts[1])) return null;
  try {
    const p=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    if (p.sub!=='private' || typeof p.exp!=='number' || typeof p.iat!=='number' || p.iat>now+30000 || p.exp<=now || p.exp-p.iat!==SESSION_MS) return null;
    if(!equal(p.credentialVersion,createHmac('sha256',config.sessionSecret).update(config.passwordHash).digest('hex'))) return null;
    return p.sub;
  } catch { return null; }
}
export function authenticate(password:string,config:Config) {
  if (!authReady(config)) throw new AppError('Le mot de passe privé doit être configuré.',503,'access_setup');
  if (!verifyPassword(password,config.passwordHash)) throw new AppError('Mot de passe incorrect.',401,'invalid_credentials');
  return issueSession(config);
}
export function cookieHeader(token:string,config:Config,clear=false) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:SESSION_MS/1000}${config.local?'':'; Secure'}`;
}
export function cookieToken(request:Request) { return request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+'='))?.slice(COOKIE_NAME.length+1); }
export function requireUser(request:Request,config:Config) { const user=verifySession(cookieToken(request),config); if(!user) throw new AppError('Connecte-toi pour ouvrir le cockpit.',401,'unauthorized'); return user; }
export function requireOrigin(request:Request,config:Config) {
  if(request.headers.get('origin')!==config.origin) throw new AppError('Origine de requête refusée.',403,'origin_rejected');
  const site=request.headers.get('sec-fetch-site'); if(site && !['same-origin','none'].includes(site)) throw new AppError('Requête externe refusée.',403,'origin_rejected');
}
export function opaqueLimitKey(scope:string,identity:string,secret:string) { return createHmac('sha256',secret).update(`${scope}:${identity}`).digest('hex'); }
