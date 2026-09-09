import { createBLGCollector } from './collector.js';

/** Wire these callbacks into the existing quiz, preserving its text, questions and save API. */
export function instrumentQuiz({ endpoint, pageVersion }) {
  const collector = createBLGCollector({ endpoint, tunnel: 'quiz', pageVersion });
  const answered = new Set();
  let coordinatesVisible = false, saved = false;
  void collector.emit('landing_arrival');
  return {
    collector,
    start() { answered.clear(); coordinatesVisible = false; saved = false; collector.newJourney(); void collector.emit('quiz_started'); },
    questionViewed(number) { if (!Number.isInteger(number) || number < 1 || number > 12) throw new Error('Invalid question'); void collector.emit('quiz_question_viewed', { question_number: number }); },
    questionAnswered(number) { if (!Number.isInteger(number) || number < 1 || number > 12) throw new Error('Invalid question'); answered.add(number); void collector.emit('quiz_question_answered', { question_number: number }); },
    showCoordinates(showExistingForm) {
      if (answered.size !== 12) throw new Error('Coordinates follow all twelve questions');
      coordinatesVisible = true;
      void collector.emit('quiz_completed', { answered_count: 12 });
      void collector.emit('lead_form_viewed', { answered_count: 12 });
      showExistingForm();
    },
    async submitCoordinates(saveExistingLead, formData, showExistingResult) {
      if (!coordinatesVisible || answered.size !== 12) throw new Error('Complete quiz before registration');
      void collector.emit('lead_form_submitted');
      // formData goes only to the existing business backend. Its successful save emits the signed lead.
      const result = await saveExistingLead(formData, collector.context());
      if (!result || result.saved !== true) throw new Error('Registration not saved');
      saved = true;
      showExistingResult(result);
      void collector.emit('result_viewed');
      return result;
    },
    canShowResult() { return saved; },
  };
}
