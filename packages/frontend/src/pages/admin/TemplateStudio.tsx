import React from 'react';
import { COMMON_MESSAGE_TOKENS, COMMON_MESSAGE_TOKEN_HELP, type CommonMessageToken } from '@fapoms/shared';
import { SkeletonList } from '../../components/ui/Loading';

/**
 * The shape a "studio" screen is made of: pick one template from a list, then work on that one.
 *
 * The email templates screen invented this shape — a titled header with the actions that apply to
 * whatever is selected, a grid of cards to choose from, and a bar naming the chosen one. Text
 * messages needed the same shape, and the owner asked for the two to feel like one product rather
 * than two screens written months apart. So the shape lives here once and both screens use it;
 * copying it would have let them drift the way every settings page in this app drifted before
 * `components/ui/settings` existed.
 *
 * What is NOT here: anything about email or about SMS. These know about a name, a description, a
 * short state and a slot for buttons. The rules — DLT registration, publish gates, version history
 * — stay in the screen that owns them.
 *
 * Styling follows the house convention: inline style objects over CSS custom properties.
 */

/** The title, the sentence under it, and the buttons that act on whatever is selected. */
export const TemplateStudioHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  /** Buttons, right-aligned. They act on the selected template, so they live beside the title. */
  actions?: React.ReactNode;
  /** Usually the picker, so the choosing and the heading read as one card. */
  children?: React.ReactNode;
}> = ({ icon, title, description, actions, children }) => (
  <div className="glass-card" style={{ padding: '20px 22px' }}>
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '16px', flexWrap: 'wrap', marginBottom: '16px',
      }}
    >
      <div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: 'var(--flame-500, #ED6714)', display: 'flex' }} aria-hidden>{icon}</span>
          {title}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5, maxWidth: '84ch' }}>
          {description}
        </div>
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
    {children}
  </div>
);

/** The state line at the foot of a card: a coloured dot and a couple of words. */
export interface TemplatePickerStatus {
  tone: 'success' | 'accent' | 'warning';
  label: string;
}

/** One card in the picker. Everything on it is already decided by the screen that owns the list. */
export interface TemplatePickerItem {
  key: string;
  name: string;
  description: React.ReactNode;
  /** Small word in the top right — email shows the category, SMS shows how many parts it costs. */
  badge?: React.ReactNode;
  status?: TemplatePickerStatus;
  /** Bottom right: a flag worth noticing at a glance, e.g. "Draft" or "Edited". */
  flag?: React.ReactNode;
}

const DOT_COLOUR: Record<TemplatePickerStatus['tone'], string> = {
  success: 'var(--success)',
  accent: 'var(--accent)',
  warning: 'var(--warning)',
};

/**
 * The grid of templates to choose from.
 *
 * A card, not a row in a dropdown: the description and the state are the whole point — somebody
 * who has not opened this screen for six months needs to see which text is which, and which one
 * is not going out, without clicking each in turn.
 */
export const TemplatePicker: React.FC<{
  items: TemplatePickerItem[];
  selectedKey: string;
  onSelect: (key: string) => void;
  loading?: boolean;
  /** Read out in place of the grid itself, e.g. "Text messages to choose from". */
  label: string;
}> = ({ items, selectedKey, onSelect, loading, label }) => (
  <div
    role="group"
    aria-label={label}
    style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px' }}
  >
    {loading ? (
      <SkeletonList rows={3} height={50} />
    ) : (
      items.map((item) => {
        const isSelected = item.key === selectedKey;
        return (
          <div
            key={item.key}
            role="button"
            tabIndex={0}
            // Announced as pressed, so the chosen card is not signalled by colour alone.
            aria-pressed={isSelected}
            onClick={() => onSelect(item.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(item.key); }}
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              cursor: 'pointer',
              background: isSelected ? 'rgba(237,103,20,0.08)' : 'var(--bg-secondary)',
              border: isSelected ? '1.5px solid var(--flame-500, #ED6714)' : '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '8px',
              transition: 'all 0.15s ease',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: isSelected ? 'var(--flame-700, #B8460D)' : 'var(--text-primary)' }}>
                  {item.name}
                </span>
                {item.badge && (
                  <span style={{ fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '2px 5px', borderRadius: '4px', background: 'var(--bg-primary)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {item.badge}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                {item.description}
              </div>
            </div>

            {(item.status || item.flag) && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
                  fontSize: 'var(--text-3xs)', paddingTop: '6px',
                  borderTop: '1px solid var(--border-hair, rgba(0,0,0,0.05))',
                }}
              >
                {item.status ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: DOT_COLOUR[item.status.tone], flexShrink: 0 }} aria-hidden />
                    <span style={{ color: 'var(--text-secondary)' }}>{item.status.label}</span>
                  </span>
                ) : <span />}
                {item.flag}
              </div>
            )}
          </div>
        );
      })
    )}
  </div>
);

/**
 * The bar under the picker: which template is open, what state it is in, what can be done to it.
 *
 * Separate from the header because the header's title never changes and this line always does —
 * it is the answer to "am I editing the right one?", which is the question somebody asks right
 * before they save over the wrong thing.
 */
export const TemplateDetailBar: React.FC<{
  icon: React.ReactNode;
  name: string;
  /** The key, small and monospace: what support asks for and what the API calls it. */
  itemKey: string;
  /** Short state words beside the name. */
  pills?: React.ReactNode;
  /** One line under the name — the default subject, or what this text is for. */
  footnote?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ icon, name, itemKey, pills, footnote, actions }) => (
  <div
    className="glass-card"
    style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
      <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(237,103,20,0.1)', color: 'var(--flame-500, #ED6714)', display: 'flex' }} aria-hidden>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>{name}</span>
          <span style={{ fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>({itemKey})</span>
          {pills}
        </div>
        {footnote && (
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.5 }}>{footnote}</div>
        )}
      </div>
    </div>
    {actions && <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>{actions}</div>}
  </div>
);

/**
 * The placeholders every message carries, offered the same way on both screens.
 *
 * An administrator used to have to learn a different vocabulary per message — the person was
 * `fullName` in one email, `displayName` in the next, and a text had no way to name the number it
 * was going to. These seven are filled by the platform for every email and every text, so they can
 * be used in any wording; what they mean lives in `@fapoms/shared` so the two screens cannot end up
 * describing them differently.
 *
 * `onInsert` is what the screen does with one — put it where the cursor is, or copy it.
 */
export const CommonTokenChips: React.FC<{
  onInsert: (token: CommonMessageToken) => void;
  /** Placeholders this template fills itself, which therefore win over the shared value. */
  overriddenBy?: readonly string[];
  label?: string;
}> = ({ onInsert, overriddenBy = [], label = 'Works in every message' }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
    <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>
      {label}
    </span>
    {COMMON_MESSAGE_TOKENS.map((token) => {
      const overridden = overriddenBy.includes(token);
      return (
        <button
          key={token}
          type="button"
          onClick={() => onInsert(token)}
          title={
            overridden
              ? `{{${token}}} — this message fills it with its own value: ${COMMON_MESSAGE_TOKEN_HELP[token]}`
              : `{{${token}}} — ${COMMON_MESSAGE_TOKEN_HELP[token]}`
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            borderRadius: '5px',
            fontSize: 'var(--text-2xs)',
            fontFamily: 'var(--font-mono)',
            cursor: 'pointer',
            background: 'rgba(59,130,246,0.10)',
            border: '1px solid rgba(59,130,246,0.32)',
            color: 'var(--text-secondary)',
          }}
        >
          {`{{${token}}}`}
        </button>
      );
    })}
  </div>
);
