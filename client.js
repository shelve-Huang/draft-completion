/**
 * Draft completion — Client half.
 *
 * Adds one compact control immediately left of the composer's model selector.
 * A click sends the current draft to this package's Host half, replaces the
 * draft with the rewritten prompt, and leaves a revert control that restores
 * the exact draft from before the rewrite.
 */
window.__ModuleLoader__.load({
  id: '@local/draft-completion',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Document-relative route this package's Host half registers. */
    const ROUTE = 'plugin/draft-completion/complete';
    /** Locale namespace owned by this plugin. */
    const NS = 'draftCompletion';
    /** Slot this control occupies: rendered immediately before the model seat. */
    const SLOT = 'conversation.input.right';
    /** Cell key inside that slot. */
    const CELL = 'draft-completion';

    const ENGLISH = {
      'button.label': 'Complete',
      'button.busy': 'Completing',
      'button.aria': 'Complete and improve the draft prompt',
      'button.title': 'Rewrite this draft into a more complete prompt',
      'button.busyTitle': 'Rewriting the draft',
      'button.emptyTitle': 'Type something to complete first',
      'button.lockedTitle': 'Wait for the current message to be sent',
      'revert.label': 'Revert',
      'revert.aria': 'Revert to the draft from before the completion',
      'revert.title': 'Restore the draft from before the completion. Editing the draft drops this revert.',
      'error.failed': 'Completion failed',
      'error.changed': 'The draft changed while completing',
      'error.offline': 'The completion service is unreachable',
    };

    const CHINESE = {
      'button.label': '补全',
      'button.busy': '补全中',
      'button.aria': '补全并完善草稿',
      'button.title': '调用大模型，把这句草稿补全并完善成完整的需求描述',
      'button.busyTitle': '正在完善草稿',
      'button.emptyTitle': '先在输入框写点内容再补全',
      'button.lockedTitle': '等当前消息发送完成',
      'revert.label': '撤销',
      'revert.aria': '回撤到补全前的输入',
      'revert.title': '恢复为补全前的输入；改动输入后本次补全将不可撤销',
      'error.failed': '补全失败',
      'error.changed': '补全期间草稿已被修改',
      'error.offline': '无法连接补全服务',
    };

    // Every built-in locale resolves to a dictionary; locales without their own
    // copy follow English so `t()` never falls back to a bare key.
    const DICTIONARIES = {
      en: ENGLISH,
      zh: CHINESE,
      ja: ENGLISH,
      es: ENGLISH,
      fr: ENGLISH,
      de: ENGLISH,
      ru: ENGLISH,
      pt: ENGLISH,
    };

    const CSS = [
      '.dsh-dc-root{display:inline-flex;align-items:center;gap:2px;min-width:0}',
      '.dsh-dc-button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 7px;',
      'border:none;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;',
      'line-height:20px;font-weight:400;white-space:nowrap;cursor:pointer}',
      '@media (hover:hover){.dsh-dc-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}',
      '.dsh-dc-button:focus-visible{outline:none;',
      'box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dsh-dc-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.dsh-dc-revert{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-dc-glyph{flex:0 0 auto;display:block}',
      '.dsh-dc-spin{animation:dsh-dc-spin 900ms linear infinite}',
      '@keyframes dsh-dc-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dsh-dc-spin{animation-duration:2400ms}}',
      '.dsh-dc-error{max-width:150px;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsw-alias-state-error-primary);',
      'font-size:12px;line-height:18px}',
    ].join('');

    /**
     * Read one thrown value as display text.
     * @param {unknown} error Thrown value.
     * @returns {string} Message text.
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return typeof error === 'string' ? error : String(error);
    }

    /**
     * Send one draft to the Host half.
     * @param {string} text Draft text.
     * @param {AbortSignal} signal Cancellation for this attempt.
     * @returns {Promise<{ text: string }>} Rewritten prompt.
     */
    async function requestCompletion(text, signal) {
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          credentials: 'same-origin',
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const offline = new Error('the completion route is unreachable');
        offline.code = 'unreachable';
        throw offline;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const failure = payload !== null && payload.error !== null && typeof payload.error === 'object'
          ? payload.error
          : {};
        const error = new Error(
          typeof failure.message === 'string' ? failure.message : `HTTP ${response.status}`,
        );
        error.code = typeof failure.code === 'string' ? failure.code : `http-${response.status}`;
        throw error;
      }
      return payload;
    }

    /**
     * Sparkle mark shown while idle.
     * @returns {React.ReactElement} Glyph.
     */
    function SparkleGlyph() {
      return h('svg', {
        className: 'dsh-dc-glyph',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      },
      h('path', {
        d: 'M7 2.2 8.15 5.35 11.3 6.5 8.15 7.65 7 10.8 5.85 7.65 2.7 6.5 5.85 5.35Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M12.2 8.6 12.75 10.05 14.2 10.6 12.75 11.15 12.2 12.6 11.65 11.15 10.2 10.6 11.65 10.05Z',
        fill: 'currentColor',
        opacity: 0.65,
      }));
    }

    /**
     * Progress mark shown while the model request is in flight.
     * @returns {React.ReactElement} Glyph.
     */
    function BusyGlyph() {
      return h('svg', {
        className: 'dsh-dc-glyph dsh-dc-spin',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      },
      h('circle', {
        cx: 8,
        cy: 8,
        r: 5.2,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeDasharray: '9 24',
      }));
    }

    /**
     * Undo mark shown beside the revert control: a left-pointing arrowhead whose
     * tail leaves to the right, turns down, and returns left. Stroked with the
     * same weight and round caps as the neighbouring composer glyphs, in
     * `currentColor`, so the chip's own colour drives it.
     * @returns {React.ReactElement} Glyph.
     */
    function RevertGlyph() {
      const common = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
      return h('svg', {
        className: 'dsh-dc-glyph',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      },
      h('path', { ...common, d: 'M3.3 6.4h6.2a3.2 3.2 0 0 1 0 6.4H6.6' }),
      h('path', { ...common, d: 'M6.5 3.2 3.3 6.4 6.5 9.6' }));
    }

    /**
     * Composer completion control.
     * @param {object} props Slot runtime props plus the locale seat.
     * @returns {React.ReactElement} Control row.
     */
    function DraftCompletion(props) {
      const t = props.t;
      const useInput = props.useInput;
      const actions = props.inputActions;

      const draft = useInput((state) => state.draft);
      const phase = useInput((state) => state.phase);

      // The one completion currently on screen: `{ original, text }` while the
      // draft still holds exactly `text`. Any later edit discards it for good.
      const [applied, setApplied] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const pending = React.useRef(null);
      const alive = React.useRef(true);
      const latest = React.useRef(draft);
      /** Whether the applied text has been observed in the draft at least once. */
      const placed = React.useRef(false);

      React.useEffect(() => {
        latest.current = draft;
      }, [draft]);

      React.useEffect(() => () => {
        alive.current = false;
        if (pending.current !== null) {
          pending.current.abort();
          pending.current = null;
        }
      }, []);

      React.useEffect(() => {
        if (failure === null) return undefined;
        const timer = setTimeout(() => { setFailure(null); }, 8000);
        return () => { clearTimeout(timer); };
      }, [failure]);

      // Every applied completion starts unproven: the editor publishes the new
      // draft through its own store, so the first render after a rewrite may
      // still carry the previous text.
      React.useEffect(() => {
        placed.current = false;
      }, [applied]);

      // Exactly one completion is revertable at a time, and only until the draft
      // moves away from the text it produced. That move is permanent: the next
      // completion starts from a fresh state instead of reviving this one.
      React.useEffect(() => {
        if (applied === null) return;
        if (draft === applied.text) {
          placed.current = true;
          return;
        }
        if (placed.current) setApplied(null);
      }, [draft, applied]);

      const empty = draft.trim() === '';
      const locked = phase !== 'plain';
      // Revert replaces Complete rather than joining it, so the two controls are
      // never on screen together.
      const revertable = applied !== null
        && applied.text !== applied.original
        && draft === applied.text;
      const canComplete = !revertable && !empty && !busy && !locked;
      const canRevert = revertable && !busy && !locked;

      const complete = () => {
        if (!canComplete) return;
        const baseline = draft;
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setFailure(null);
        void requestCompletion(baseline.trim(), controller.signal)
          .then((payload) => {
            if (!alive.current) return;
            if (latest.current !== baseline) {
              setFailure(t('error.changed'));
              return;
            }
            actions.setDraft(payload.text);
            setApplied({ original: baseline, text: payload.text });
          })
          .catch((error) => {
            if (!alive.current || controller.signal.aborted) return;
            setFailure(
              error !== null && typeof error === 'object' && error.code === 'unreachable'
                ? t('error.offline')
                : messageOf(error),
            );
          })
          .then(() => {
            if (!alive.current) return;
            setBusy(false);
            if (pending.current === controller) pending.current = null;
          });
      };

      const revert = () => {
        if (applied === null) return;
        actions.setDraft(applied.original);
        setApplied(null);
        placed.current = false;
        setFailure(null);
      };

      let title = t('button.title');
      if (busy) title = t('button.busyTitle');
      else if (empty) title = t('button.emptyTitle');
      else if (locked) title = t('button.lockedTitle');

      // One control, never two: a revertable completion shows Revert in the
      // Complete control's place, and the Complete control returns as soon as
      // that completion stops being revertable.
      const control = revertable
        ? h('button', {
          key: 'revert',
          type: 'button',
          className: 'dsh-dc-button dsh-dc-revert',
          title: t('revert.title'),
          'aria-label': t('revert.aria'),
          disabled: !canRevert,
          onClick: revert,
        },
        h(RevertGlyph),
        h('span', null, t('revert.label')))
        : h('button', {
          key: 'complete',
          type: 'button',
          className: 'dsh-dc-button',
          title,
          'aria-label': t('button.aria'),
          'aria-busy': busy ? 'true' : undefined,
          disabled: !canComplete,
          onClick: complete,
        },
        busy ? h(BusyGlyph) : h(SparkleGlyph),
        h('span', null, busy ? t('button.busy') : t('button.label')));

      return h('span', { className: 'dsh-dc-root' },
        h('style', { key: 'style' }, CSS),
        control,
        failure !== null
          ? h('span', { key: 'failure', className: 'dsh-dc-error', role: 'status', title: failure },
            t('error.failed'))
          : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, DICTIONARIES),
          'draft-completion: dictionaries',
        );
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: CELL,
          locale: NS,
        }, DraftCompletion));
      },
    };
  },
});
