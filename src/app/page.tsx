import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Cockpit from '@/components/Cockpit';
import { COOKIE_NAME, verifySession } from '@/lib/auth';
import { getConfig } from '@/lib/config';
export const dynamic='force-dynamic';
export default async function Page(){const config=getConfig();const user=verifySession((await cookies()).get(COOKIE_NAME)?.value,config);if(!user)redirect('/login');return <Cockpit mode={config.mode} user="Accès privé"/>;}
