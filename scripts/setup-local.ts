import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { passwordHash } from '../src/lib/auth';
// Creates only a private ignored local setup. Never prints passwords or reads external credentials.
const root=process.cwd(); const local=path.join(root,'.local');fs.mkdirSync(local,{recursive:true,mode:0o700});
const envFile=path.join(root,'.env.local');if(fs.existsSync(envFile)){console.log('Configuration locale déjà présente, conservée.');process.exit(0);}
const password=randomBytes(18).toString('base64url');
const lines=[`COCKPIT_MODE=demo`,`APP_ORIGIN=http://127.0.0.1:3100`,`DATABASE_URL=postgresql://localhost:55440/cockpit_blg_demo`,`COCKPIT_PASSWORD_HASH=${passwordHash(password)}`,...['COCKPIT_SESSION_SECRET','IDENTITY_HMAC_SECRET','INGEST_HMAC_SECRET','CRON_SECRET'].map(k=>`${k}=${randomBytes(32).toString('hex')}`)];
fs.writeFileSync(envFile,lines.join('\n')+'\n',{mode:0o600});
fs.writeFileSync(path.join(local,'access.txt'),`Accès au cockpit de test sur http://127.0.0.1:3100\n\nMot de passe : ${password}\n\nDonnées exclusivement synthétiques. Ne pas publier ce fichier.\n`,{mode:0o600});console.log('Configuration créée. Accès conservés dans .local/access.txt (privé).');
