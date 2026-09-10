import test from 'node:test';
import assert from 'node:assert/strict';
import { notionEvidenceUrl } from '../src/components/PaidSalesDetails';

test('les liens de preuves acceptent le domaine réellement fourni par Notion',()=>{
 const url='https://app.notion.com/p/Client-1234567890abcdef1234567890abcdef';
 assert.equal(notionEvidenceUrl(url),url);
 assert.equal(notionEvidenceUrl('https://www.notion.so/1234567890abcdef1234567890abcdef'),'https://www.notion.so/1234567890abcdef1234567890abcdef');
});
test('les liens de preuves refusent les domaines voisins et les protocoles non sûrs',()=>{
 for(const url of ['https://app.notion.com.attacker.example/p/x','https://attacker.example/app.notion.com','http://app.notion.com/p/x','javascript:alert(1)',null])assert.equal(notionEvidenceUrl(url),null);
});
