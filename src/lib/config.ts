import { z } from 'zod';
import { AppError } from './errors';
const passwordSchema = z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
export function getConfig(env: Record<string,string|undefined> = process.env) {
  const demo = env.COCKPIT_MODE === 'demo';
  if (demo && env.VERCEL) throw new AppError('Le mode test local ne peut pas être déployé.',503,'invalid_mode');
  const vercelHost = env.VERCEL_ENV === 'production'
    ? env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL
    : env.VERCEL_URL;
  const origin = env.APP_ORIGIN || (env.VERCEL && vercelHost ? `https://${vercelHost}` : 'http://127.0.0.1:3100');
  if (env.VERCEL && !env.APP_ORIGIN && !vercelHost) {
    throw new AppError('Active les variables système Vercel ou renseigne APP_ORIGIN.',503,'invalid_origin');
  }
  const parsedOrigin = new URL(origin);
  const local = ['127.0.0.1','localhost','[::1]'].includes(parsedOrigin.hostname);
  if (!local && parsedOrigin.protocol !== 'https:') throw new AppError('Une adresse HTTPS est requise.',503,'invalid_origin');
  if (demo && !local) throw new AppError('Les données de test restent sur cet ordinateur.',503,'invalid_mode');
  const password = passwordSchema.safeParse(env.COCKPIT_PASSWORD_HASH);
  const config = {
    mode:demo?'demo' as const:'live' as const, local, origin:parsedOrigin.origin, passwordHash:password.success?password.data:'',
    sessionSecret:env.COCKPIT_SESSION_SECRET || '', identitySecret:env.IDENTITY_HMAC_SECRET||'',
    ingestSecret:env.INGEST_HMAC_SECRET||'', cronSecret:env.CRON_SECRET||'',
    allowedOrigins:(env.INGEST_ALLOWED_ORIGINS||'https://quizz.blg-studio.fr,https://www.blg-studio.fr').split(',').map(x=>x.trim()),
    supabaseUrl:env.SUPABASE_URL||'', supabaseSecret:env.SUPABASE_SECRET_KEY||'',
    databaseUrl:demo?env.DATABASE_URL||'':'',
  };
  if (demo) {
    let db:URL; try { db=new URL(config.databaseUrl); } catch { throw new AppError('Base de test locale absente.',503,'demo_database_missing'); }
    if (!['localhost','127.0.0.1','[::1]'].includes(db.hostname) || !db.pathname.endsWith('_demo')) throw new AppError('Le mode test exige une base locale suffixée _demo.',503,'invalid_demo_database');
  }
  return config;
}
export type Config = ReturnType<typeof getConfig>;
