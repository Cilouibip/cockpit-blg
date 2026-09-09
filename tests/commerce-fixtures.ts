import {notionCommerceConfig} from '../src/connectors/notion-commerce';
import type {CommerceClient,CommercePayment,CommerceParcours,CommerceSnapshot} from '../src/lib/notion-commerce-report';
export const commerceConfig=notionCommerceConfig(JSON.stringify({clients:{dataSourceId:'synthetic-clients'},payments:{dataSourceId:'synthetic-payments'},parcours:{dataSourceId:'synthetic-parcours'}}))!;
export const commerceEnv={NOTION_COMMERCE_CONFIG:JSON.stringify(commerceConfig)};
export const client=(id='client-a',extra:Partial<CommerceClient>={}):CommerceClient=>({id,emailKey:'identity-'+id,emailBisKey:null,startedDay:null,prospectIds:[],binomeIds:[],...extra});
export const payment=(id='payment-a',extra:Partial<CommercePayment>={}):CommercePayment=>({id,clientIds:['client-a'],emailKey:'identity-client-a',providerId:null,day:'2024-02-03',rawDate:'2024-02-03',amountMinor:10000,status:'succeeded',...extra});
export const parcours=(id='parcours-a',extra:Partial<CommerceParcours>={}):CommerceParcours=>({id,clientIds:['client-a'],order:1,format:'Solo',startDay:'2024-02-03',closingDay:'2024-02-02',rawStart:'2024-02-03',rawClosing:'2024-02-02',status:'Actif',...extra});
export const snapshot=(extra:Partial<CommerceSnapshot>={}):CommerceSnapshot=>({clients:[client()],payments:[payment()],parcours:[parcours()],startedAt:'2024-03-01T11:00:00Z',observedAt:'2024-03-01T12:00:00Z',paginationComplete:true,sourceCounts:{clients:1,payments:1,parcours:1},...extra});
export const filters:import('../src/lib/ui-contract').DashboardFilters={from:'2024-02-01',to:'2024-02-29',compare:false,source:'all' as const,tunnel:'all' as const,campaign:'all'};
