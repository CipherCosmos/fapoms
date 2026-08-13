import { Injectable } from '@nestjs/common';
import { FeedbackCategory, FeedbackSeverity } from '@fapoms/shared';

/**
 * The intelligence layer for the feedback channel.
 *
 * Today this is a transparent, dependency-free heuristic: it reads the words in a
 * report and proposes a category and a severity so the team's queue arrives
 * pre-sorted instead of as an undifferentiated pile, and it scores similarity
 * between two reports so near-duplicates surface at triage.
 *
 * It is deliberately behind an interface + injection token. When an LLM is wired
 * into the platform, a `LlmFeedbackIntelligence` can implement the same two
 * methods (classify + similarity) and be swapped in the module providers with no
 * change to any caller — the controller, the service and the UI all speak only to
 * this contract. The `confidence` a classifier returns is what the UI uses to
 * decide whether to show its suggestion as a firm label or a tentative hint, so
 * the heuristic and an LLM stay interchangeable end to end.
 */

export interface FeedbackSignalInput {
  title: string;
  body: string;
  area?: string | null;
}

export interface FeedbackClassification {
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  /** Salient terms pulled from the text — feeds duplicate detection and search. */
  keywords: string[];
  /** 0..1 — how strongly the signals point at this classification. */
  confidence: number;
}

export const FEEDBACK_INTELLIGENCE = 'FEEDBACK_INTELLIGENCE';

export interface FeedbackIntelligence {
  classify(input: FeedbackSignalInput): FeedbackClassification;
  /** 0..1 similarity between two reports, for duplicate detection. */
  similarity(a: FeedbackSignalInput, b: FeedbackSignalInput): number;
}

/** Words that carry no signal and would only dilute keyword/similarity scoring. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'has', 'had', 'not', 'but', 'you', 'your',
  'are', 'was', 'were', 'when', 'what', 'which', 'while', 'they', 'them', 'their', 'there', 'here',
  'from', 'into', 'onto', 'about', 'would', 'could', 'should', 'will', 'been', 'being', 'does', 'did',
  'can', 'cant', 'get', 'got', 'its', 'it', 'is', 'in', 'on', 'at', 'to', 'of', 'a', 'an', 'i', 'we',
  'me', 'my', 'our', 'us', 'do', 'be', 'as', 'so', 'if', 'or', 'no', 'yes', 'page', 'app', 'system',
]);

/** Phrases that decide category. First bucket whose weight wins, ties broken by order below. */
const CATEGORY_SIGNALS: Array<{ category: FeedbackCategory; terms: string[]; weight: number }> = [
  {
    category: FeedbackCategory.BUG,
    weight: 3,
    terms: [
      'error', 'errors', 'crash', 'crashed', 'crashing', 'broken', 'broke', 'bug', 'not working',
      'doesnt work', 'does not work', 'wont', 'cannot', 'cant', 'fails', 'failed', 'failing', 'failure',
      'blank', 'stuck', 'freeze', 'frozen', 'hang', 'hangs', 'wrong', 'incorrect', 'exception', 'nan',
      'undefined', '404', '500', 'timeout', 'timed out', 'missing data', 'lost', 'disappears', 'glitch',
    ],
  },
  {
    category: FeedbackCategory.ENHANCEMENT,
    weight: 2,
    terms: [
      'please add', 'add a', 'add an', 'add the', 'would be nice', 'would be great', 'feature request',
      'feature', 'ability to', 'able to', 'support for', 'option to', 'allow', 'enhancement', 'improve',
      'improvement', 'nice to have', 'wish', 'request', 'suggestion', 'could you add', 'make it possible',
    ],
  },
  {
    category: FeedbackCategory.PROCESS,
    weight: 2,
    terms: [
      'workflow', 'process', 'flow', 'step', 'steps', 'approval', 'reorder', 'rearrange', 'instead of',
      'too many clicks', 'faster way', 'streamline', 'policy', 'procedure', 'handoff', 'hand off',
      // Not bare 'assign' — it matches inside 'reassign' and 'assayer', the app's most common words.
      'routing', 'escalation', 'sequence', 'should come before', 'should come after',
    ],
  },
  {
    category: FeedbackCategory.QUESTION,
    weight: 1,
    terms: ['how do i', 'how to', 'how can i', 'what is', 'what does', 'where is', 'where can', 'why does', 'is it possible', 'can i'],
  },
];

/** Words that push severity up regardless of category. */
const SEVERITY_SIGNALS: Array<{ severity: FeedbackSeverity; terms: string[] }> = [
  {
    severity: FeedbackSeverity.CRITICAL,
    terms: [
      'data loss', 'lost data', 'cant login', 'cannot login', 'cannot log in', 'cant log in', 'locked out',
      'system down', 'everything down', 'production down', 'all users', 'everyone', 'nobody can', 'no one can',
      'urgent', 'critical', 'emergency', 'blocked', 'blocker', 'wrong amount', 'wrong payment', 'double charged',
      'money', 'payment failed', 'security', 'breach', 'leak', 'corrupted',
    ],
  },
  {
    severity: FeedbackSeverity.HIGH,
    terms: [
      'crash', 'crashed', 'error', 'blank', 'stuck', 'freeze', 'frozen', 'not working', 'doesnt work',
      'does not work', 'broken', 'fails', 'failed', 'cannot', 'cant', 'important', 'asap', 'every time',
    ],
  },
  {
    severity: FeedbackSeverity.LOW,
    terms: [
      'typo', 'spelling', 'cosmetic', 'color', 'colour', 'spacing', 'alignment', 'minor', 'nice to have',
      'small', 'tiny', 'label', 'wording', 'suggestion', 'someday', 'eventually',
    ],
  },
];

const normalize = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const countMatches = (haystack: string, terms: string[]): number =>
  terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);

@Injectable()
export class HeuristicFeedbackIntelligence implements FeedbackIntelligence {
  classify(input: FeedbackSignalInput): FeedbackClassification {
    const text = `${normalize(input.title)} ${normalize(input.body)}`;

    // Category: highest weighted match count wins; CATEGORY_SIGNALS order breaks ties.
    let bestCategory = FeedbackCategory.OTHER;
    let bestScore = 0;
    let matchedSignalWords = 0;
    for (const sig of CATEGORY_SIGNALS) {
      const hits = countMatches(text, sig.terms);
      matchedSignalWords += hits;
      const score = hits * sig.weight;
      if (score > bestScore) {
        bestScore = score;
        bestCategory = sig.category;
      }
    }

    // Severity: start from a per-category floor, then let signal words raise (or lower) it.
    const rank: Record<FeedbackSeverity, number> = {
      [FeedbackSeverity.LOW]: 0,
      [FeedbackSeverity.MEDIUM]: 1,
      [FeedbackSeverity.HIGH]: 2,
      [FeedbackSeverity.CRITICAL]: 3,
    };
    const byRank: FeedbackSeverity[] = [
      FeedbackSeverity.LOW,
      FeedbackSeverity.MEDIUM,
      FeedbackSeverity.HIGH,
      FeedbackSeverity.CRITICAL,
    ];
    let severityRank =
      bestCategory === FeedbackCategory.BUG ? rank[FeedbackSeverity.MEDIUM] :
      bestCategory === FeedbackCategory.ENHANCEMENT || bestCategory === FeedbackCategory.QUESTION ? rank[FeedbackSeverity.LOW] :
      rank[FeedbackSeverity.MEDIUM];

    let sawCritical = false;
    let sawLowOnly = false;
    for (const sig of SEVERITY_SIGNALS) {
      if (countMatches(text, sig.terms) > 0) {
        if (sig.severity === FeedbackSeverity.CRITICAL) sawCritical = true;
        if (sig.severity === FeedbackSeverity.LOW) sawLowOnly = true;
        severityRank = Math.max(severityRank, rank[sig.severity]);
      }
    }
    // A "typo" style low-signal item with no escalating words should read LOW, not MEDIUM.
    if (sawLowOnly && !sawCritical && severityRank === rank[FeedbackSeverity.MEDIUM]) {
      severityRank = rank[FeedbackSeverity.LOW];
    }

    // Confidence grows with how many signal words fired; capped so the heuristic never
    // claims certainty. An LLM implementation would return a real probability here.
    const confidence = bestScore === 0 ? 0.2 : Math.min(0.85, 0.4 + matchedSignalWords * 0.12);

    return {
      category: bestCategory,
      severity: byRank[severityRank],
      keywords: this.keywords(input),
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  similarity(a: FeedbackSignalInput, b: FeedbackSignalInput): number {
    const ka = new Set(this.keywords(a));
    const kb = new Set(this.keywords(b));
    if (ka.size === 0 || kb.size === 0) return 0;
    let inter = 0;
    for (const k of ka) if (kb.has(k)) inter++;
    const union = ka.size + kb.size - inter;
    return union === 0 ? 0 : Math.round((inter / union) * 100) / 100;
  }

  private keywords(input: FeedbackSignalInput): string[] {
    const text = `${normalize(input.title)} ${normalize(input.body)}`;
    const freq = new Map<string, number>();
    for (const token of text.split(' ')) {
      if (token.length < 4 || STOP_WORDS.has(token)) continue;
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    return [...freq.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, 8)
      .map(([word]) => word);
  }
}
