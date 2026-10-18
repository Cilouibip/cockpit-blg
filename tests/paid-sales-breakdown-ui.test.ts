import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import PaidSalesDetails from '../src/components/PaidSalesDetails';
import {buildNotionCommerceReport} from '../src/lib/notion-commerce-report';
import {snapshot,payment,client,schedule} from './commerce-fixtures';

test('details show all offer families and the total for confirmed sales only',()=>{
 const report=buildNotionCommerceReport(snapshot({clients:[client('a'),client('b')],payments:[payment('a',{clientIds:['a'],emailKey:'identity-a',offerCategory:'blg90'}),payment('b',{clientIds:['b'],emailKey:'identity-b',offerCategory:'club'})],schedules:[schedule('a',{clientIds:['a'],paymentIds:['a']})]})).paidSales;
 const html=renderToStaticMarkup(createElement(PaidSalesDetails,{report}));
 assert.match(html,/<caption>Nouvelles ventes par offre<\/caption>/);
 assert.match(html,/<th scope="row">BLG 90<\/th><td>1<\/td>/);
 assert.match(html,/<th scope="row">Club<\/th><td>0<\/td>/);
 assert.match(html,/<th scope="row">Total toutes offres<\/th><td>1<\/td>/);
 for(const label of ['Défi','Autres offres','Offre à préciser','Cas à rattacher'])assert.ok(html.includes(label));
});

test('source offer labels are escaped in the payment detail',()=>{
 const report=buildNotionCommerceReport(snapshot({payments:[payment('payment-a',{offerCategory:'other',offerRaw:'<script>unsafe</script>'})]})).paidSales;
 const html=renderToStaticMarkup(createElement(PaidSalesDetails,{report}));
 assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
 assert.ok(!html.includes('<script>unsafe</script>'));
});
