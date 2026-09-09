import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata={title:'BLG · Cockpit',description:'Lecture privée du parcours et de l’activité BLG',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="fr"><body><div id="atelier-a" data-light="bright" data-motion="off" data-tab-style="cool">{children}</div></body></html>;}
