import test from 'node:test';
import assert from 'node:assert/strict';
import { notionPaymentOffer, normalizeNotionCommerce, notionCommerceConfig, notionCommerceProfile } from '../src/connectors/notion-commerce';
import type { CommercePayment } from '../src/lib/notion-commerce-report';

test('offer families use explicit product descriptions and source categories',()=>{
 assert.equal(notionPaymentOffer('Programmes BLG','BLG90 Exemple').offerCategory,'blg90');
 assert.equal(notionPaymentOffer('Programmes BLG','Défi 21 jours').offerCategory,'defi');
 assert.equal(notionPaymentOffer('BLG Club','BLG Club Ladies').offerCategory,'club');
 assert.equal(notionPaymentOffer('Boutique','Article').offerCategory,'other');
 assert.equal(notionPaymentOffer('BLG NUT','Nutrition').offerCategory,'other');
 assert.equal(notionPaymentOffer('Programmes BLG','BLG Homme').offerCategory,'unknown');
 assert.equal(notionPaymentOffer(null,'').offerCategory,'unknown');
});

test('ambiguous, conflicting and incidental labels never become a named offer',()=>{
 for(const [category,description] of [['BLG Club','BLG90 Exemple'],['Boutique','BLG90 Exemple'],['À classer','BLG90 Exemple'],['Programmes BLG','Facture relative à BLG90'],['Programmes BLG','BLG900'],['Programmes BLG','Définitif']])assert.equal(notionPaymentOffer(category,description).offerCategory,'unknown');
});

test('normalizer does not use payment amount, person title or defaulting product formula',()=>{
 const config=notionCommerceConfig(JSON.stringify({clients:{dataSourceId:'clients'},payments:{dataSourceId:'payments'},parcours:{dataSourceId:'parcours'}}))!;
 const raw={id:'payment',properties:{Transaction:{type:'title',title:[{plain_text:'BLG90 Example Person'}]},Montant:{type:'number',number:390},Produit:{type:'formula',formula:{type:'string',string:'BLG Homme'}}}};
 const payment=normalizeNotionCommerce(raw,'payments',config,'synthetic-secret-for-offer-tests-only') as CommercePayment;
 assert.equal(payment.offerCategory,'unknown');
 assert.equal(payment.amountMinor,39000);
});

test('source category fields are selected and change the collection profile',()=>{
 const config=notionCommerceConfig(JSON.stringify({clients:{dataSourceId:'clients'},payments:{dataSourceId:'payments'},parcours:{dataSourceId:'parcours'}}))!;
 assert.equal(config.payments.fields.category,'Catégorie');
 assert.equal(config.payments.fields.description,'Description');
 const legacy=structuredClone(config);delete (legacy.payments.fields as Partial<typeof config.payments.fields>).category;delete (legacy.payments.fields as Partial<typeof config.payments.fields>).description;
 assert.notEqual(notionCommerceProfile(config),notionCommerceProfile(legacy));
 const raw={id:'payment',properties:{Catégorie:{select:{name:'Programmes BLG'}},Description:{rich_text:[{plain_text:'BLG90 Exemple'}]}}};
 assert.equal((normalizeNotionCommerce(raw,'payments',config,'synthetic-secret-for-offer-tests-only') as CommercePayment).offerCategory,'blg90');
});
