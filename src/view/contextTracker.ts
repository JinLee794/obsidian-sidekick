import type {SidekickView} from '../sidekickView';

export function installContextTracker(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.getPromptTokenLimit = function(): number {
		const model = this.getSelectedModelInfo();
		const limits = model?.capabilities?.limits;
		return limits?.max_prompt_tokens ?? limits?.max_context_window_tokens ?? 128_000;
	};

	proto.checkContextUsage = function(): void {
		if (!this.turnUsage || this.contextHintShown) return;
		// Use the last usage event's input tokens (the final main-model call),
		// not the accumulated total which includes subagent calls.
		this.sessionInputTokens = this.lastUsageInputTokens;

		const limit = this.getPromptTokenLimit();
		const ratio = this.sessionInputTokens / limit;
		if (ratio < 0.85) return;

		this.contextHintShown = true;
		const pct = Math.round(ratio * 100);
		this.addInfoMessage(
			`Context is ${pct}% full. Use **/new** to start a fresh conversation or **/clear** to reset context.`,
		);
	};
}
