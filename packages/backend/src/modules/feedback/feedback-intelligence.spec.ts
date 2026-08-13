import { HeuristicFeedbackIntelligence } from './feedback-intelligence';
import { FeedbackCategory, FeedbackSeverity } from '@fapoms/shared';

describe('HeuristicFeedbackIntelligence', () => {
  const ai = new HeuristicFeedbackIntelligence();

  describe('classify — category', () => {
    it('reads a crash report as a BUG', () => {
      const r = ai.classify({ title: 'Planning page crashes', body: 'The planning screen shows a blank error and does not work when I open it.' });
      expect(r.category).toBe(FeedbackCategory.BUG);
    });

    it('reads a request as an ENHANCEMENT', () => {
      const r = ai.classify({ title: 'Export button', body: 'Please add the ability to export the assignment list to Excel. Would be nice to have.' });
      expect(r.category).toBe(FeedbackCategory.ENHANCEMENT);
    });

    it('reads a workflow complaint as PROCESS', () => {
      const r = ai.classify({ title: 'Too many steps', body: 'The approval workflow has too many clicks — the process should be streamlined so assignment is faster.' });
      expect(r.category).toBe(FeedbackCategory.PROCESS);
    });

    it('reads a how-do-I as a QUESTION', () => {
      const r = ai.classify({ title: 'Reassign', body: 'How do I reassign a branch to another assayer? Is it possible from the map?' });
      expect(r.category).toBe(FeedbackCategory.QUESTION);
    });

    it('falls back to OTHER with low confidence when nothing matches', () => {
      const r = ai.classify({ title: 'Note', body: 'Just leaving a general remark for the team.' });
      expect(r.category).toBe(FeedbackCategory.OTHER);
      expect(r.confidence).toBeLessThan(0.4);
    });
  });

  describe('classify — severity', () => {
    it('escalates a login-blocking outage to CRITICAL', () => {
      const r = ai.classify({ title: 'Cannot login', body: 'Nobody can login this morning — everyone is locked out and it is urgent.' });
      expect(r.severity).toBe(FeedbackSeverity.CRITICAL);
    });

    it('rates a plain crash HIGH', () => {
      const r = ai.classify({ title: 'Error on save', body: 'I get an error every time I save a report and it fails.' });
      expect(r.severity).toBe(FeedbackSeverity.HIGH);
    });

    it('rates a cosmetic nit LOW', () => {
      const r = ai.classify({ title: 'Typo', body: 'Small spelling typo in the dashboard label, cosmetic only.' });
      expect(r.severity).toBe(FeedbackSeverity.LOW);
    });
  });

  describe('similarity', () => {
    it('scores two reports about the same problem highly', () => {
      const a = { title: 'Planning crash', body: 'planning page crashes with a blank error every time' };
      const b = { title: 'Planning broken', body: 'the planning screen crashes and shows a blank error' };
      expect(ai.similarity(a, b)).toBeGreaterThan(0.3);
    });

    it('scores unrelated reports near zero', () => {
      const a = { title: 'Export excel', body: 'please add excel export for assignments' };
      const b = { title: 'Login broken', body: 'cannot login this morning locked out' };
      expect(ai.similarity(a, b)).toBeLessThan(0.2);
    });

    it('is zero when either side has no salient keywords', () => {
      expect(ai.similarity({ title: 'a', body: 'the' }, { title: 'planning', body: 'crash error' })).toBe(0);
    });
  });

  it('always returns keywords bounded to 8', () => {
    const r = ai.classify({ title: 'many words here', body: 'assignment planning branch report validation assayer expense billing notification schedule holiday zone' });
    expect(r.keywords.length).toBeLessThanOrEqual(8);
  });
});
