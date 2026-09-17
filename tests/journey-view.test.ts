import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JourneyReportView, VideoPositions, videoTime } from '../src/components/JourneyPage';
import { journeyFixture } from './fixtures/journey';

test('journey shows paired conversion, measured zero and missing counts distinctly', () => {
  const html = renderToStaticMarkup(createElement(JourneyReportView, { report: journeyFixture() }));
  assert.match(html, /33,3/); // Paired 4/12, not independent 5/12.
  assert.match(html, /4 sur 12 visites/);
  assert.match(html, /Rendez-vous confirmé/);
  assert.match(html, /<strong class="">0<\/strong>/);
  assert.match(html, /Non disponible/);
  assert.match(html, /Signal absent sur cette version/);
});
test('video chart has an accessible table and explains ongoing sessions and seek semantics', () => {
  const html = renderToStaticMarkup(createElement(JourneyReportView, { report: journeyFixture() }));
  assert.match(html, /Dernière position observée/);
  assert.match(html, /lectures encore en cours/);
  assert.match(html, /déplacement dans le lecteur ne prouve pas/);
  assert.match(html, /Voir les valeurs de la courbe/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /1:00 à 2:00 : 2 visites/);
  const unavailable = renderToStaticMarkup(createElement(VideoPositions, { position: { availability: { available: false, reason: 'Durées incompatibles.' }, label: 'Dernière position observée', buckets: [] } }));
  assert.doesNotMatch(unavailable, /<svg/);
  assert.match(unavailable, /Durées incompatibles/);
});
test('quiz without viewed-question measurement does not display invented abandonment', () => {
  const report = journeyFixture(); report.scope.tunnel = 'quiz';
  const html = renderToStaticMarkup(createElement(JourneyReportView, { report }));
  assert.match(html, /Question 1/);
  assert.match(html, /Sans réponse observée/);
  assert.match(html, /<td><span title="Signal absent sur cette version\.">Non disponible/);
  assert.doesNotMatch(html, /Jusqu’où les visiteurs regardent/);
});
test('video time uses minutes and seconds while unknown is explicit', () => {
  assert.equal(videoTime(125), '2:05'); assert.equal(videoTime(null), 'Non disponible'); assert.equal(videoTime(Number.NaN), 'Non disponible'); assert.equal(videoTime(0), '0:00');
});
